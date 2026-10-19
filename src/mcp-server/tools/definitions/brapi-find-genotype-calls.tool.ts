/**
 * @fileoverview `brapi_find_genotype_calls` — pull allele calls across a
 * germplasm × variant set. Uses BrAPI's async-search pattern
 * (`POST /search/calls` → `GET /search/calls/{id}` with 202-retry) under
 * the hood. The upstream pull is bounded by `BRAPI_GENOTYPE_CALLS_MAX_PULL`
 * (operator policy, default 100k, max 500k) so a single query can't trigger
 * unbounded sequential paginated GETs against the upstream BrAPI server.
 * `loadLimit` and a 24,000-byte budget bound the rows returned inline; when
 * they cut results[] short, the full collected set is materialized as a
 * dataframe for SQL-based follow-up.
 *
 * @module mcp-server/tools/definitions/brapi-find-genotype-calls.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getBrapiClient } from '@/services/brapi-client/index.js';
import { resolveDialect } from '@/services/brapi-dialect/index.js';
import {
  type CanvasBridge,
  getCanvasBridge,
  type RegisterDataframeInput,
} from '@/services/canvas-bridge/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import type { RegisteredServer } from '@/services/server-registry/types.js';
import {
  AliasInput,
  asString,
  collectPassthroughParts,
  computeDistribution,
  DataframeHandleSchema,
  inlineTrimNotice,
  NonBlankString,
  renderDataframeHandle,
  renderDistributions,
  renderFindHeader,
  renderWarningsTrailer,
  requireRegisteredConnection,
  selectInlineRows,
  toDataframeHandle,
} from '../shared/find-helpers.js';
import { buildCallsSearchBody, collectCalls } from '../shared/genotype-calls.js';
import { literal } from '../shared/markdown-literals.js';

const CallRowSchema = z
  .object({
    callSetDbId: z
      .string()
      .nullish()
      .describe('FK to the call set (one germplasm × one variant set = one call set).'),
    callSetName: z.string().nullish().describe('Display name of the call set.'),
    variantDbId: z.string().nullish().describe('FK to the variant being called.'),
    variantName: z.string().nullish().describe('Display name / alias of the variant.'),
    variantSetDbId: z.string().nullish().describe('FK to the variant set the call belongs to.'),
    genotype: z
      .object({
        values: z
          .array(z.string().describe('Per-allele value string.'))
          .nullish()
          .describe('Encoded allele values — interpret using top-level `callFormatting`.'),
      })
      .passthrough()
      .nullish()
      .describe(
        'Structured genotype payload (array of allele values plus server-specific fields).',
      ),
    genotypeValue: z
      .string()
      .nullish()
      .describe(
        'Legacy flat string form of the call (provided by some servers instead of `genotype`).',
      ),
    phaseSet: z
      .string()
      .nullish()
      .describe('Phase-set identifier linking calls that share a haplotype phase.'),
  })
  .passthrough()
  .describe('One genotype call row.');

const OutputSchema = z.object({
  alias: z.string().describe('Connection alias the call used.'),
  results: z
    .array(CallRowSchema)
    .describe(
      'Leading collected call rows, up to loadLimit and a 24,000-byte budget, whichever binds first.',
    ),
  hasMore: z
    .boolean()
    .describe(
      'True when the pull stopped early: the deployment pull limit fired (`truncated`), or time for upstream requests ran out before the last page (`warnings` says so). Unlike the filter finders, it ignores the inline cut — shown and cap report that.',
    ),
  callFormatting: z
    .object({
      expandHomozygotes: z
        .boolean()
        .nullish()
        .describe('When true, homozygous calls are expanded to both alleles.'),
      unknownString: z
        .string()
        .nullish()
        .describe('String used for unknown / missing calls (often "." or "N").'),
      sepPhased: z
        .string()
        .nullish()
        .describe('Separator between phased allele values (typically "|").'),
      sepUnphased: z
        .string()
        .nullish()
        .describe('Separator between unphased allele values (typically "/").'),
    })
    .describe('Genotype-encoding hints echoed by the server.'),
  distributions: z
    .object({
      callSetName: z
        .record(z.string(), z.number())
        .describe('Call set name → count of calls from that set.'),
      variantName: z
        .record(z.string(), z.number())
        .describe('Variant name → count of calls for that variant.'),
      variantSetDbId: z
        .record(z.string(), z.number())
        .describe('Variant set ID → count of calls from that set.'),
    })
    .describe('Value frequency per field across the full collected call set.'),
  dataframe: DataframeHandleSchema.optional().describe(
    'Every collected call, staged when results[] holds fewer rows than were collected.',
  ),
  truncated: z
    .boolean()
    .describe(
      'True when the deployment-wide pull limit was reached and more calls exist upstream. Narrow the filters and re-pull.',
    ),
});

type Output = z.infer<typeof OutputSchema>;

export const brapiFindGenotypeCalls = tool('brapi_find_genotype_calls', {
  description:
    'Pull genotype calls for a germplasm × variant set. Filter to bound cost — at minimum, set `variantSetDbId` or `germplasmDbIds`. The upstream pull is capped by deployment policy; when the pull is truncated, narrow the filters. results[] holds the leading calls up to `loadLimit` and a 24,000-byte budget; when it holds fewer than were collected, every collected call is materialized as a dataframe — read it with brapi_dataframe_describe and brapi_dataframe_query (SQL) instead of paging row-by-row.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'upstream_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'An uncaught BrAPI data request answered HTTP 404',
      recovery:
        'Check brapi_server_info for supported endpoints and verify the requested identifiers before retrying brapi_find_genotype_calls.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'An uncaught BrAPI data request exhausted retries after HTTP 429',
      recovery:
        'Wait before retrying brapi_find_genotype_calls; reduce concurrent requests to this BrAPI server.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'unknown_alias',
      code: JsonRpcErrorCode.NotFound,
      when: 'No connection is registered under the requested alias, and the server has no base URL configured for it to connect on first use',
      recovery:
        'Run brapi_connect with this alias and a `baseUrl`, or pass an alias the brapi_connect description lists as built-in or operator-configured, before calling brapi_find_genotype_calls.',
      thrownBy: 'service',
    },
    {
      reason: 'auth_token_exchange_failed',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Connecting the alias on first use, the SGN or OAuth token exchange against the BrAPI /token endpoint failed',
      recovery:
        'Ask the operator to check the credentials configured for this alias and that the server exposes /token, or run brapi_connect with credentials in `auth`.',
      thrownBy: 'service',
    },
    {
      reason: 'auth_no_access_token',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Connecting the alias on first use, the token endpoint answered without returning an access token',
      recovery:
        'Ask the operator to check that the credentials configured for this alias are valid and that the upstream IdP issues access tokens for this grant.',
      thrownBy: 'service',
    },
    {
      reason: 'capability_discovery_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Neither /serverinfo nor /calls listed any call, and at least one of them timed out, was unreachable, or answered 429 or a 5xx other than 501, so nothing was cached',
      recovery:
        'The BrAPI server is slow or unreachable right now. Retry brapi_find_genotype_calls in a minute; if it keeps failing, the server may be down.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unauthorized',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'The BrAPI server answered HTTP 401: it requires credentials, or rejected the ones sent',
      recovery:
        'Run brapi_connect with credentials in `auth`, or ask the operator to set server-side credentials for this alias, then retry brapi_find_genotype_calls.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The BrAPI server answered HTTP 403: the credentials sent, or their absence, lack access',
      recovery:
        'Run brapi_connect with credentials that have access, or ask the operator to set server-side credentials for this alias that do, then retry brapi_find_genotype_calls.',
      thrownBy: 'service',
    },
    {
      reason: 'alias_base_url_invalid',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'The base URL configured on the server for this alias is not an absolute http(s) URL, or carries credentials',
      recovery:
        'Ask the operator to set the base URL configured for this alias to an absolute http(s) URL, then retry brapi_find_genotype_calls.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'private_address_blocked',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The base URL configured for this alias, or its token URL, is on a private or reserved address this server may not reach',
      recovery:
        'Ask the operator to point this alias at a publicly routable host, or to allow private addresses on this server, then retry brapi_find_genotype_calls.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'no_filters',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No variant set, germplasm, call set, or variant filter was provided',
      recovery:
        'Provide variantSetDbId or germplasmDbIds before retrying — unfiltered pulls are too expensive.',
    },
    {
      reason: 'search_endpoint_disabled',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The active dialect declares POST /search/calls as known-dead on this server',
      recovery:
        'Connect to a different BrAPI server that exposes a working /search/calls route — genotype-call workflows are not viable here.',
    },
  ] as const,
  input: z.object({
    alias: AliasInput,
    variantSetDbId: NonBlankString.optional().describe(
      'Scope calls to a single variant set. Strongly recommended. List variant sets with brapi_raw_get({ path: "/variantsets" }) — add params.studyDbId to narrow to one study or genotyping project — and read variantSetDbId from the rows.',
    ),
    variantSetDbIds: z
      .array(NonBlankString)
      .optional()
      .describe('Alternative: multiple variant sets at once, found the same way.'),
    germplasmDbIds: z
      .array(NonBlankString)
      .optional()
      .describe('Restrict to these germplasm (call sets).'),
    callSetDbIds: z
      .array(NonBlankString)
      .optional()
      .describe('Restrict to these call sets directly.'),
    variantDbIds: z.array(NonBlankString).optional().describe('Restrict to specific variants.'),
    callFormat: z
      .enum(['VCF', 'FLAPJACK', 'DARTSEQ', 'JSON'])
      .optional()
      .describe('Requested call-encoding format, when the server honors it.'),
    loadLimit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Cap on rows returned inline. Omit for the deployment default. results[] also stops at a 24,000-byte budget, whichever bound comes first, and keeps at least one row when any call was collected. When results[] holds fewer rows than were collected, every collected call lands in a dataframe — query it with brapi_dataframe_query (SQL) for the rest. Upstream pageSize is fixed for genotype calls, so this knob only affects the inline preview here (no spillover capacity tradeoff).',
      ),
  }),
  inputAliases: {
    germplasmDbId: 'germplasmDbIds',
    callSetDbId: 'callSetDbIds',
    variantDbId: 'variantDbIds',
  },
  output: OutputSchema,

  // Agent-facing success-path context: total collected count, in-context count,
  // the exact body sent to /search/calls, empty-result guidance, and advisory
  // warnings. Populated via ctx.enrich() so it reaches both structuredContent
  // and the content[] trailer without living in the domain return.
  enrichment: {
    totalCount: z
      .number()
      .int()
      .nonnegative()
      .describe(
        'Total calls collected across all pages (below the upstream total when `hasMore` is true: the deployment-wide pull limit fired, or the upstream deadline ended the pull).',
      ),
    returnedCount: z.number().int().nonnegative().describe('Length of results[].'),
    appliedFilters: z
      .record(z.string(), z.unknown())
      .describe(
        'The body sent to POST /search/calls (variant/germplasm/call-set scope plus pageSize).',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Why no calls were returned, or which bound cut results[] short and the dataframe holding every collected call.',
      ),
    shown: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Length of results[] when loadLimit or the inline byte budget cut it short of the collected calls.',
      ),
    cap: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'The effective loadLimit when results[] was cut short; shown is below it when the 24,000-byte inline budget bound first (notice says which).',
      ),
    warnings: z
      .array(z.string())
      .describe('Advisory messages (truncation, capability gaps, partial pulls).'),
  },

  enrichmentTrailer: {
    appliedFilters: {
      render: (filters) => {
        const entries = Object.entries(filters);
        if (entries.length === 0) return '**Search body:** none';
        const lines = entries.map(
          ([k, v]) => literal`- **${k}:** ${Array.isArray(v) ? v.join(', ') : String(v)}`,
        );
        return `**Search body:**\n${lines.join('\n')}`;
      },
    },
    warnings: { render: renderWarningsTrailer },
  },

  async handler(input, ctx) {
    const capabilities = getCapabilityRegistry();
    const client = getBrapiClient();
    const bridge = getCanvasBridge();

    const connection = await requireRegisteredConnection(ctx, input.alias);

    const capabilityLookup: { auth?: typeof connection.resolvedAuth } = {};
    if (connection.resolvedAuth) capabilityLookup.auth = connection.resolvedAuth;
    await capabilities.ensure(
      connection.baseUrl,
      { service: 'search/calls', method: 'POST' },
      ctx,
      capabilityLookup,
    );

    const dialect = await resolveDialect(connection, ctx, capabilityLookup);
    if (dialect.disabledSearchEndpoints?.has('calls')) {
      throw ctx.fail(
        'search_endpoint_disabled',
        `Dialect '${dialect.id}' marks POST /search/calls as known-dead on this server. Genotype-call workflows are not viable here without bypassing the dialect.`,
        { dialectId: dialect.id },
      );
    }

    const config = getServerConfig();
    const maxCalls = config.genotypeCallsMaxPull;
    const loadLimit = input.loadLimit ?? config.loadLimit;

    const searchBody = buildSearchBody(input);
    if (
      !searchBody.variantSetDbIds &&
      !searchBody.germplasmDbIds &&
      !searchBody.callSetDbIds &&
      !searchBody.variantDbIds
    ) {
      throw ctx.fail(
        'no_filters',
        'Provide at least one filter (variantSetDbId, variantSetDbIds, germplasmDbIds, callSetDbIds, or variantDbIds) — unfiltered genotype-call pulls are prohibitively expensive.',
        { filters: searchBody },
      );
    }

    const warnings: string[] = [];
    const collected = await collectCalls({
      client: client,
      connection,
      ctx,
      body: searchBody,
      maxCalls,
      warnings,
    });

    let inline = selectInlineRows(collected.rows, loadLimit, (rows) =>
      renderCallRows({ results: rows as Output['results'] }),
    );
    const distributions = {
      callSetName: computeDistribution(collected.rows, (r) => asString(r.callSetName)),
      variantName: computeDistribution(collected.rows, (r) => asString(r.variantName)),
      variantSetDbId: computeDistribution(collected.rows, (r) => asString(r.variantSetDbId)),
    };

    const stoppedEarly = collected.stopReason !== undefined;
    let dataframeHandle: z.infer<typeof DataframeHandleSchema> | undefined;
    if (inline.bound) {
      dataframeHandle = await spillCalls({
        bridge,
        ctx,
        connection,
        body: searchBody,
        rows: collected.rows,
        pullCapped: collected.truncated,
        stoppedEarly,
        maxRows: maxCalls,
      });
      inline = selectInlineRows(collected.rows, loadLimit, (rows) =>
        renderCallRows({ results: rows as Output['results'], dataframe: dataframeHandle }),
      );
    }

    ctx.enrich({
      totalCount: collected.rows.length,
      returnedCount: inline.rows.length,
      appliedFilters: searchBody,
      warnings,
    });
    if (collected.rows.length === 0)
      ctx.enrich.notice(
        'No calls matched the requested filters. The variant set or filter combination may not match any data on this server — broaden the scope (variantSetDbId, germplasmDbIds) or verify the IDs.',
      );
    /**
     * The output's own `truncated` means the pull cap fired, so the inline cut is
     * disclosed through shown / cap and the notice, not ctx.enrich.truncated.
     */
    if (inline.bound) {
      ctx.enrich({ shown: inline.rows.length, cap: loadLimit });
      ctx.enrich.notice(
        inlineTrimNotice(inline.bound, inline.rows.length, loadLimit, dataframeHandle),
      );
    }

    const result: Output = {
      alias: connection.alias,
      results: inline.rows,
      hasMore: collected.truncated || stoppedEarly,
      callFormatting: collected.callFormatting,
      distributions,
      truncated: collected.truncated,
    };
    if (dataframeHandle) result.dataframe = dataframeHandle;
    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    const headerBase = renderFindHeader({
      noun: 'calls',
      alias: result.alias,
      returnedCount: result.results.length,
      dataframe: result.dataframe,
    });
    lines.push(
      result.truncated ? `${headerBase} (truncated at deployment pull limit)` : headerBase,
    );
    lines.push('');
    lines.push('## Call formatting');
    const f = result.callFormatting;
    lines.push(`- expandHomozygotes: ${f.expandHomozygotes ?? '—'}`);
    lines.push(literal`- unknownString: ${f.unknownString ?? '—'}`);
    lines.push(literal`- sepPhased: ${f.sepPhased ?? '—'}`);
    lines.push(literal`- sepUnphased: ${f.sepUnphased ?? '—'}`);
    lines.push('');
    lines.push('## Distributions');
    lines.push(
      renderDistributions(result.distributions, result.dataframe) || '_No values to summarize._',
    );
    lines.push('');
    lines.push(renderCallRows(result));
    if (result.dataframe) {
      lines.push('');
      lines.push('## Dataframe handle');
      lines.push(...renderDataframeHandle(result.dataframe));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

function buildSearchBody(
  input: Parameters<typeof brapiFindGenotypeCalls.handler>[0],
): Record<string, unknown> {
  const opts: Parameters<typeof buildCallsSearchBody>[0] = {};
  if (input.variantSetDbId !== undefined) opts.variantSetDbId = input.variantSetDbId;
  if (input.variantSetDbIds !== undefined) opts.variantSetDbIds = input.variantSetDbIds;
  if (input.germplasmDbIds !== undefined) opts.germplasmDbIds = input.germplasmDbIds;
  if (input.callSetDbIds !== undefined) opts.callSetDbIds = input.callSetDbIds;
  if (input.variantDbIds !== undefined) opts.variantDbIds = input.variantDbIds;
  if (input.callFormat !== undefined) opts.callFormat = input.callFormat;
  return buildCallsSearchBody(opts);
}

interface SpillCallsInput {
  body: Record<string, unknown>;
  bridge: CanvasBridge;
  connection: RegisteredServer;
  ctx: Context;
  maxRows: number;
  /** The deployment pull limit cut the pull short — reported as `maxRows`. */
  pullCapped: boolean;
  rows: z.infer<typeof CallRowSchema>[];
  /** The call's upstream deadline ended the page walk before the last page. */
  stoppedEarly: boolean;
}

async function spillCalls(input: SpillCallsInput): Promise<z.infer<typeof DataframeHandleSchema>> {
  const registerInput: RegisterDataframeInput = {
    source: 'find_genotype_calls',
    baseUrl: input.connection.baseUrl,
    query: input.body,
    rows: input.rows as Record<string, unknown>[],
  };
  if (input.pullCapped || input.stoppedEarly) registerInput.truncated = true;
  if (input.pullCapped) registerInput.maxRows = input.maxRows;
  const result = await input.bridge.registerDataframe(input.ctx, registerInput);
  return toDataframeHandle(result);
}

/** Render the exact row section used by both formatting and preview sizing. */
function renderCallRows(result: Pick<Output, 'results' | 'dataframe'>): string {
  const lines: string[] = [];
  lines.push('## Calls');
  if (result.results.length === 0) {
    lines.push('_No calls returned._');
  } else {
    const RENDERED = new Set([
      'callSetName',
      'callSetDbId',
      'variantName',
      'variantDbId',
      'variantSetDbId',
      'genotype',
      'genotypeValue',
      'phaseSet',
    ]);
    for (const call of result.results) {
      const parts: string[] = [];
      parts.push(literal`**${call.callSetName ?? call.callSetDbId ?? '?'}**`);
      if (call.callSetDbId) parts.push(literal`callSetDbId=${call.callSetDbId}`);
      parts.push(literal`variant=${call.variantName ?? call.variantDbId ?? '?'}`);
      if (call.variantDbId) parts.push(literal`variantDbId=${call.variantDbId}`);
      if (call.variantSetDbId) parts.push(literal`set=${call.variantSetDbId}`);
      if (call.genotype) parts.push(literal`genotype=${JSON.stringify(call.genotype)}`);
      if (call.genotypeValue) parts.push(literal`genotypeValue=${call.genotypeValue}`);
      if (call.phaseSet) parts.push(literal`phaseSet=${call.phaseSet}`);
      parts.push(
        ...collectPassthroughParts(call as Record<string, unknown>, RENDERED, result.dataframe),
      );
      lines.push(`- ${parts.join(' · ')}`);
    }
  }
  return lines.join('\n');
}
