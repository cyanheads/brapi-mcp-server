/**
 * @fileoverview `brapi_find_genotype_calls` — pull allele calls across a
 * germplasm × variant set. Uses BrAPI's async-search pattern
 * (`POST /search/calls` → `GET /search/calls/{id}` with 202-retry) under
 * the hood. The upstream pull is bounded by `BRAPI_GENOTYPE_CALLS_MAX_PULL`
 * (operator policy, default 100k, max 500k) so a single query can't trigger
 * unbounded sequential paginated GETs against the upstream BrAPI server.
 * `loadLimit` bounds the rows returned inline; when the pull exceeds
 * loadLimit, the full collected set is materialized as a dataframe
 * for SQL-based follow-up.
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
  renderDataframeHandle,
  renderDistributions,
  renderFindHeader,
  requireRegisteredConnection,
  toDataframeHandle,
} from '../shared/find-helpers.js';
import { buildCallsSearchBody, collectCalls } from '../shared/genotype-calls.js';

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
  alias: z.string().describe('Alias of the registered BrAPI connection the call used.'),
  results: z.array(CallRowSchema).describe('Call rows returned in-context (up to loadLimit).'),
  hasMore: z
    .boolean()
    .describe('True when the collection was truncated (equivalent to `truncated`).'),
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
    'Dataframe handle when the full collected calls exceed loadLimit and were materialized as a dataframe. Query it with brapi_dataframe_query (SQL).',
  ),
  truncated: z
    .boolean()
    .describe(
      'True when the deployment-wide pull limit was reached and more calls exist upstream. Narrow the filters and re-pull, or query the spilled dataframe.',
    ),
});

type Output = z.infer<typeof OutputSchema>;

export const brapiFindGenotypeCalls = tool('brapi_find_genotype_calls', {
  description:
    'Pull genotype calls for a germplasm × variant set. Filter to bound cost — at minimum, set `variantSetDbId` or `germplasmDbIds`. The upstream pull is capped by deployment policy; when the pull is truncated, narrow the filters or query the spilled dataframe. `loadLimit` bounds the rows returned inline; the full collected set is materialized as a dataframe — query it with brapi_dataframe_query (SQL) instead of paging row-by-row.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'unknown_alias',
      code: JsonRpcErrorCode.NotFound,
      when: 'No connection has been registered under the requested alias',
      recovery:
        'Run brapi_connect with this alias (or omit `alias` to use the default connection) before calling brapi_find_genotype_calls.',
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
    variantSetDbId: z
      .string()
      .min(1)
      .optional()
      .describe('Scope calls to a single variant set. Strongly recommended.'),
    variantSetDbIds: z
      .array(z.string())
      .optional()
      .describe('Alternative: multiple variant sets at once.'),
    germplasmDbIds: z
      .array(z.string())
      .optional()
      .describe('Restrict to these germplasm (call sets).'),
    callSetDbIds: z.array(z.string()).optional().describe('Restrict to these call sets directly.'),
    variantDbIds: z.array(z.string()).optional().describe('Restrict to specific variants.'),
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
        'Cap on rows returned inline. Omit for the deployment default. When the collected set exceeds this, the full result lands in a dataframe and only the first `loadLimit` rows return inline — query the dataframe with brapi_dataframe_query (SQL) for the rest. Upstream pageSize is fixed for genotype calls, so this knob only affects the inline preview here (no spillover capacity tradeoff).',
      ),
  }),
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
        'Total calls collected across all pages (may be capped by the deployment-wide pull limit; check `truncated`).',
      ),
    returnedCount: z
      .number()
      .int()
      .nonnegative()
      .describe('Length of results[] — rows returned in-context (up to loadLimit).'),
    appliedFilters: z
      .record(z.string(), z.unknown())
      .describe(
        'The body sent to POST /search/calls (variant/germplasm/call-set scope plus pageSize).',
      ),
    notice: z
      .string()
      .optional()
      .describe('Guidance when no calls were returned — how to broaden filters or verify IDs.'),
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
          ([k, v]) => `- **${k}:** ${Array.isArray(v) ? v.join(', ') : String(v)}`,
        );
        return `**Search body:**\n${lines.join('\n')}`;
      },
    },
    warnings: {
      render: (ws) => (ws.length > 0 ? ws.map((w) => `- ${w}`).join('\n') : '_none_'),
      label: 'Warnings',
    },
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
        { dialectId: dialect.id, ...ctx.recoveryFor('search_endpoint_disabled') },
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
        { filters: searchBody, ...ctx.recoveryFor('no_filters') },
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

    const inContext = collected.rows.slice(0, loadLimit);
    const distributions = {
      callSetName: computeDistribution(collected.rows, (r) => asString(r.callSetName)),
      variantName: computeDistribution(collected.rows, (r) => asString(r.variantName)),
      variantSetDbId: computeDistribution(collected.rows, (r) => asString(r.variantSetDbId)),
    };

    const shouldSpill = collected.rows.length > loadLimit;
    let dataframeHandle: z.infer<typeof DataframeHandleSchema> | undefined;
    if (shouldSpill) {
      dataframeHandle = await spillCalls({
        bridge,
        ctx,
        connection,
        body: searchBody,
        rows: collected.rows,
        truncated: collected.truncated,
        maxRows: maxCalls,
      });
    }

    ctx.enrich({
      totalCount: collected.rows.length,
      returnedCount: inContext.length,
      appliedFilters: searchBody,
      warnings,
    });
    if (collected.rows.length === 0)
      ctx.enrich.notice(
        'No calls matched the requested filters. The variant set or filter combination may not match any data on this server — broaden the scope (variantSetDbId, germplasmDbIds) or verify the IDs.',
      );

    const result: Output = {
      alias: connection.alias,
      results: inContext,
      hasMore: collected.truncated,
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
    lines.push(`- unknownString: ${f.unknownString ?? '—'}`);
    lines.push(`- sepPhased: ${f.sepPhased ?? '—'}`);
    lines.push(`- sepUnphased: ${f.sepUnphased ?? '—'}`);
    lines.push('');
    lines.push('## Distributions');
    lines.push(renderDistributions(result.distributions) || '_No values to summarize._');
    lines.push('');
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
        parts.push(`**${call.callSetName ?? call.callSetDbId ?? '?'}**`);
        if (call.callSetDbId) parts.push(`callSetDbId=${call.callSetDbId}`);
        parts.push(`variant=${call.variantName ?? call.variantDbId ?? '?'}`);
        if (call.variantDbId) parts.push(`variantDbId=${call.variantDbId}`);
        if (call.variantSetDbId) parts.push(`set=${call.variantSetDbId}`);
        if (call.genotype) parts.push(`genotype=${JSON.stringify(call.genotype)}`);
        if (call.genotypeValue) parts.push(`genotypeValue=${call.genotypeValue}`);
        if (call.phaseSet) parts.push(`phaseSet=${call.phaseSet}`);
        parts.push(...collectPassthroughParts(call as Record<string, unknown>, RENDERED));
        lines.push(`- ${parts.join(' · ')}`);
      }
    }
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
  rows: z.infer<typeof CallRowSchema>[];
  truncated: boolean;
}

async function spillCalls(input: SpillCallsInput): Promise<z.infer<typeof DataframeHandleSchema>> {
  const registerInput: RegisterDataframeInput = {
    source: 'find_genotype_calls',
    baseUrl: input.connection.baseUrl,
    query: input.body,
    rows: input.rows as Record<string, unknown>[],
  };
  if (input.truncated) {
    registerInput.truncated = true;
    registerInput.maxRows = input.maxRows;
  }
  const result = await input.bridge.registerDataframe(input.ctx, registerInput);
  return toDataframeHandle(result);
}
