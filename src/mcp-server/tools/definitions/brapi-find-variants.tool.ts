/**
 * @fileoverview `brapi_find_variants` — find variant records by variant set,
 * reference, or genomic region. Standard find_* pattern — distributions +
 * dataframe spillover. Note: the BrAPI filter catalog uses `start` / `end` as
 * single scalars (0-based, inclusive start / exclusive end) per the spec.
 *
 * @module mcp-server/tools/definitions/brapi-find-variants.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getBrapiClient } from '@/services/brapi-client/index.js';
import { resolveDialect } from '@/services/brapi-dialect/index.js';
import { getCanvasBridge } from '@/services/canvas-bridge/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import {
  AliasInput,
  applyDialectFiltersOrFail,
  asString,
  buildExtraFilterChecks,
  buildRefinementHint,
  checkFilterMatchRates,
  collectPassthroughParts,
  computeDistribution,
  DataframeHandleSchema,
  dialectRowMapper,
  discloseInlineTrim,
  ExtraFiltersInput,
  InlineTrimEnrichment,
  LoadLimitInput,
  loadInitialFindPage,
  maybeSpill,
  mergeFilters,
  NonBlankString,
  renderAdvisoryTrailer,
  renderAppliedFiltersTrailer,
  renderDataframeHandle,
  renderDistributions,
  renderFindHeader,
  renderMoreRowsLine,
  renderWarningsTrailer,
  requireRegisteredConnection,
  resolveFindRoute,
} from '../shared/find-helpers.js';
import { literal } from '../shared/markdown-literals.js';

const VariantRowSchema = z
  .object({
    variantDbId: z.string().describe('Server-side identifier for the variant.'),
    variantNames: z
      .array(z.string().describe('Variant name or alias.'))
      .nullish()
      .describe('Known names / aliases for this variant.'),
    variantSetDbId: z
      .union([
        z.string().describe('Single variant-set FK (older BrAPI servers).'),
        z
          .array(z.string().describe('One variant-set FK.'))
          .describe('Variant-set FK array — a variant may belong to multiple sets.'),
        z.null().describe('Field present but null on the upstream.'),
      ])
      .optional()
      .describe(
        'FK to the variant set(s) this variant belongs to. May be a string or string[] depending on server.',
      ),
    variantSetDbIds: z
      .array(z.string().describe('Variant-set FK.'))
      .nullish()
      .describe('Plural-form FK array per BrAPI v2.1 spec, when the server uses it.'),
    variantType: z.string().nullish().describe('Variant type (e.g. "SNP", "INDEL", "DUP").'),
    referenceBases: z
      .string()
      .nullish()
      .describe('Reference allele sequence at the variant position.'),
    alternateBases: z
      .array(z.string().describe('Alternate allele sequence.'))
      .nullish()
      .describe('Alternate alleles observed at this position.'),
    referenceName: z.string().nullish().describe('Reference sequence name (e.g. "chr01").'),
    start: z.number().nullish().describe('Start position, 0-based inclusive per BrAPI.'),
    end: z.number().nullish().describe('End position, 0-based exclusive per BrAPI.'),
    filtersPassed: z.boolean().nullish().describe('True when the variant passed all QC filters.'),
    filtersApplied: z
      .boolean()
      .nullish()
      .describe('True when QC filters were evaluated on this variant.'),
    filtersFailed: z
      .array(z.string().describe('Filter ID that failed.'))
      .nullish()
      .describe('IDs of QC filters this variant failed, when any.'),
  })
  .passthrough()
  .describe('One BrAPI variant record.');

const OutputSchema = z.object({
  alias: z.string().describe('Connection alias the call used.'),
  results: z
    .array(VariantRowSchema)
    .describe(
      'Leading matched variant rows, up to loadLimit and a 24,000-byte budget, whichever binds first.',
    ),
  hasMore: z.boolean().describe('True when more rows exist beyond the returned set.'),
  distributions: z
    .object({
      variantType: z
        .record(z.string(), z.number())
        .describe('Variant type → count of variants of that type.'),
      referenceName: z
        .record(z.string(), z.number())
        .describe('Reference sequence name → count of variants on that reference.'),
      variantSetDbId: z
        .record(z.string(), z.number())
        .describe('Variant set ID → count of variants in that set.'),
    })
    .describe('Value frequency per field across every matched row fetched.'),
  dataframe: DataframeHandleSchema.optional().describe(
    'The matched rows, staged as a dataframe when results[] holds fewer.',
  ),
});

type Output = z.infer<typeof OutputSchema>;

const SERVER_TO_USER: Record<string, string> = {
  // Plurals — BrAPI v2.1 spec.
  variantSetDbIds: 'variantSets',
  variantDbIds: 'variants',
  referenceDbIds: 'references',
  // Singulars — SGN-family dialects.
  variantSetDbId: 'variantSets',
  variantDbId: 'variants',
  referenceDbId: 'references',
  // Scalars — same on the wire either way.
  referenceName: 'referenceName',
  start: 'start',
  end: 'end',
};

export const brapiFindVariants = tool('brapi_find_variants', {
  description:
    'Find variant records by variant set, reference sequence, or genomic region (start/end, 0-based inclusive / exclusive per the BrAPI spec; servers may differ). results[] holds the leading matches up to loadLimit and a 24,000-byte budget; when it holds fewer rows than matched, the matched set is materialized as a dataframe — read it with brapi_dataframe_describe and brapi_dataframe_query (SQL).',
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'upstream_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'An uncaught BrAPI data request answered HTTP 404',
      recovery:
        'Check brapi_server_info for supported endpoints and verify the requested identifiers before retrying brapi_find_variants.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'An uncaught BrAPI data request exhausted retries after HTTP 429',
      recovery:
        'Wait before retrying brapi_find_variants; reduce concurrent requests to this BrAPI server.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'missing_find_route',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither the GET list nor a usable POST search route is advertised',
      recovery: 'Check brapi_server_info and choose a connection advertising this finder endpoint.',
      thrownBy: 'service',
    },
    {
      reason: 'search_endpoint_disabled',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Only a POST search route marked unusable by the active dialect is advertised',
      recovery: 'Choose a connection with a supported GET route or a usable POST search endpoint.',
      thrownBy: 'service',
    },
    {
      reason: 'unknown_alias',
      code: JsonRpcErrorCode.NotFound,
      when: 'No connection is registered under the requested alias, and the server has no base URL configured for it to connect on first use',
      recovery:
        'Run brapi_connect with this alias and a `baseUrl`, or pass an alias the brapi_connect description lists as built-in or operator-configured, before calling brapi_find_variants.',
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
        'The BrAPI server is slow or unreachable right now. Retry brapi_find_variants in a minute; if it keeps failing, the server may be down.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unauthorized',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'The BrAPI server answered HTTP 401: it requires credentials, or rejected the ones sent',
      recovery:
        'Run brapi_connect with credentials in `auth`, or ask the operator to set server-side credentials for this alias, then retry brapi_find_variants.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The BrAPI server answered HTTP 403: the credentials sent, or their absence, lack access',
      recovery:
        'Run brapi_connect with credentials that have access, or ask the operator to set server-side credentials for this alias that do, then retry brapi_find_variants.',
      thrownBy: 'service',
    },
    {
      reason: 'alias_base_url_invalid',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'The base URL configured on the server for this alias is not an absolute http(s) URL, or carries credentials',
      recovery:
        'Ask the operator to set the base URL configured for this alias to an absolute http(s) URL, then retry brapi_find_variants.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'private_address_blocked',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The base URL configured for this alias, or its token URL, is on a private or reserved address this server may not reach',
      recovery:
        'Ask the operator to point this alias at a publicly routable host, or to allow private addresses on this server, then retry brapi_find_variants.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'all_filters_dropped',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The active dialect dropped every filter the agent supplied — the upstream server does not honor any of the requested scope filters on this endpoint, so the call would silently widen to the unfiltered baseline.',
      recovery:
        'Drop the unsupported filters and rescope by variants, variantSets, references, or referenceName + start/end — these filter paths are honored on the active dialect.',
      thrownBy: 'service',
    },
  ] as const,
  input: z.object({
    alias: AliasInput,
    variantSets: z.array(NonBlankString).optional().describe('Filter by variantSetDbIds.'),
    variants: z.array(NonBlankString).optional().describe('Filter by variantDbIds.'),
    references: z.array(NonBlankString).optional().describe('Filter by referenceDbIds.'),
    referenceName: NonBlankString.optional().describe(
      'Reference display name (e.g. "chr01", "chr1").',
    ),
    start: z.number().int().nonnegative().optional().describe('Window start, 0-based inclusive.'),
    end: z.number().int().positive().optional().describe('Window end, 0-based exclusive.'),
    loadLimit: LoadLimitInput,
    extraFilters: ExtraFiltersInput,
  }),
  inputAliases: {
    variantSetDbId: 'variantSets',
    variantSetDbIds: 'variantSets',
    variantDbId: 'variants',
    variantDbIds: 'variants',
    referenceDbId: 'references',
    referenceDbIds: 'references',
  },
  output: OutputSchema,

  // Agent-facing success-path context: pagination totals, the exact filter map
  // sent to the server, guidance when the result set is large, and empty-result
  // notices. Populated via ctx.enrich() so it reaches both structuredContent
  // and the content[] trailer without living in the domain return.
  enrichment: {
    totalCount: z
      .number()
      .int()
      .nonnegative()
      .describe('Total rows reported by the server, else the rows scanned.'),
    returnedCount: z.number().int().nonnegative().describe('Length of results[].'),
    appliedFilters: z
      .record(z.string(), z.unknown())
      .describe('Filter map sent upstream (named filters plus extraFilters).'),
    refinementHint: z
      .string()
      .optional()
      .describe('Suggested refinement when the result set is large.'),
    ...InlineTrimEnrichment,
    warnings: z
      .array(z.string())
      .describe('Advisory messages (filter overrides, partial data, capability gaps).'),
  },

  enrichmentTrailer: {
    refinementHint: { render: renderAdvisoryTrailer },
    appliedFilters: { render: renderAppliedFiltersTrailer(SERVER_TO_USER) },
    warnings: { render: renderWarningsTrailer },
  },

  async handler(input, ctx) {
    const capabilities = getCapabilityRegistry();
    const client = getBrapiClient();
    const bridge = getCanvasBridge();
    const config = getServerConfig();

    const connection = await requireRegisteredConnection(ctx, input.alias);

    const capabilityLookup: { auth?: typeof connection.resolvedAuth } = {};
    if (connection.resolvedAuth) capabilityLookup.auth = connection.resolvedAuth;
    const profile = await capabilities.profile(connection.baseUrl, ctx, capabilityLookup);

    const dialect = await resolveDialect(connection, ctx, capabilityLookup);

    const warnings: string[] = [];
    if (input.start !== undefined && input.end !== undefined && input.start >= input.end) {
      warnings.push('start >= end; upstream will likely return an empty result set.');
    }
    const merged = mergeFilters(
      {
        variantSetDbIds: input.variantSets,
        variantDbIds: input.variants,
        referenceDbIds: input.references,
        referenceName: input.referenceName,
        start: input.start,
        end: input.end,
      },
      input.extraFilters,
      warnings,
    );

    const adapted = applyDialectFiltersOrFail(ctx, dialect, 'variants', merged, warnings);
    const filters = adapted.filters;
    const route = resolveFindRoute({
      profile,
      dialect,
      endpoint: 'variants',
      filters,
      searchBody: merged,
      warnings,
      ...(adapted.requiresEscalation ? { requiresEscalation: true } : {}),
    });

    const loadLimit = input.loadLimit ?? config.loadLimit;
    const normalizeRow = dialectRowMapper<Record<string, unknown>>(dialect, 'variants');
    const firstPage = await loadInitialFindPage<Record<string, unknown>>(
      client,
      connection,
      route,
      loadLimit,
      ctx,
      normalizeRow ? { normalizeRow } : {},
    );

    const spill = await maybeSpill({
      firstPage,
      client,
      connection,
      path: '/variants',
      filters,
      route,
      source: 'find_variants',
      renderInline: (rows, dataframe) =>
        renderVariantsRows({ results: rows as Output['results'], dataframe }),
      loadLimit,
      ctx,
      bridge,
      warnings,
      ...(normalizeRow ? { normalizeRow } : {}),
    });
    const { fullRows, dataframe, results, hasMore, rowsScanned } = spill;

    const distributions = {
      variantType: computeDistribution(fullRows, (r) => asString(r.variantType)),
      referenceName: computeDistribution(fullRows, (r) => asString(r.referenceName)),
      variantSetDbId: computeDistribution(fullRows, (r) => collectVariantSetIds(r)),
    };

    checkFilterMatchRates(warnings, fullRows.length, [
      ...buildExtraFilterChecks(input.extraFilters, fullRows, warnings),
    ]);

    const totalCount = firstPage.totalCount ?? rowsScanned;
    const refinementHint = buildRefinementHint(spill, distributions, {
      availableFilters: ['variantSets', 'variants', 'references', 'referenceName', 'start', 'end'],
    });

    const appliedFilters = route.kind === 'search' ? route.searchBody : filters;
    ctx.enrich({
      totalCount,
      returnedCount: results.length,
      appliedFilters,
      warnings,
      ...(refinementHint ? { refinementHint } : {}),
    });
    if (results.length === 0)
      ctx.enrich.notice(
        warnings.length > 0
          ? 'No rows returned. Check the warnings above for filter issues, or broaden your filters.'
          : 'No variants matched the applied filters. Try broadening variantSets, references, or referenceName + start/end range.',
      );
    discloseInlineTrim(ctx, spill, loadLimit);

    const result: Output = {
      alias: connection.alias,
      results: results as z.infer<typeof VariantRowSchema>[],
      hasMore,
      distributions,
    };
    if (dataframe) result.dataframe = dataframe;
    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(
      renderFindHeader({
        noun: 'variants',
        alias: result.alias,
        returnedCount: result.results.length,
        dataframe: result.dataframe,
      }),
    );
    lines.push('');
    const moreRows = renderMoreRowsLine(result);
    if (moreRows) lines.push(moreRows, '');
    lines.push('## Distributions');
    lines.push(
      renderDistributions(result.distributions, result.dataframe) || '_No values to summarize._',
    );
    lines.push('');
    lines.push(renderVariantsRows(result));
    if (result.dataframe) {
      lines.push('');
      lines.push('## Dataframe handle');
      lines.push(...renderDataframeHandle(result.dataframe));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

function collectVariantSetIds(row: Record<string, unknown>): string[] | undefined {
  const ids = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === 'string' && value.length > 0) ids.add(value);
    else if (Array.isArray(value)) {
      for (const v of value) if (typeof v === 'string' && v.length > 0) ids.add(v);
    }
  };
  collect(row.variantSetDbId);
  collect(row.variantSetDbIds);
  return ids.size > 0 ? Array.from(ids) : undefined;
}

/** Render the exact row section used by both formatting and preview sizing. */
function renderVariantsRows(result: Pick<Output, 'results' | 'dataframe'>): string {
  const lines: string[] = [];
  lines.push('## Variants');
  if (result.results.length === 0) {
    lines.push('_No rows returned._');
  } else {
    const RENDERED = new Set([
      'variantNames',
      'variantDbId',
      'variantType',
      'variantSetDbId',
      'variantSetDbIds',
      'referenceName',
      'start',
      'end',
      'referenceBases',
      'alternateBases',
      'filtersApplied',
      'filtersPassed',
      'filtersFailed',
    ]);
    for (const v of result.results) {
      const label = v.variantNames?.[0] ?? v.variantDbId;
      const parts: string[] = [literal`**${label}**`];
      parts.push(literal`id=\`${v.variantDbId}\``);
      if (v.variantType) parts.push(literal`type=${v.variantType}`);
      const setIds = collectVariantSetIds(v);
      if (setIds && setIds.length > 0) parts.push(literal`set=${setIds.join(',')}`);
      if (v.referenceName) parts.push(literal`ref=${v.referenceName}`);
      if (v.start != null) parts.push(`start=${v.start}`);
      if (v.end != null) parts.push(`end=${v.end}`);
      if (v.referenceBases) parts.push(literal`refBases=${v.referenceBases}`);
      if (v.alternateBases?.length) parts.push(literal`altBases=${v.alternateBases.join(',')}`);
      if (v.filtersApplied != null) parts.push(`filtersApplied=${v.filtersApplied}`);
      if (v.filtersPassed != null) parts.push(`filtersPassed=${v.filtersPassed}`);
      if (v.filtersFailed?.length) parts.push(literal`filtersFailed=${v.filtersFailed.join(',')}`);
      if (v.variantNames?.length) parts.push(literal`names=${v.variantNames.join(',')}`);
      parts.push(
        ...collectPassthroughParts(v as Record<string, unknown>, RENDERED, result.dataframe),
      );
      lines.push(`- ${parts.join(' · ')}`);
    }
  }
  return lines.join('\n');
}
