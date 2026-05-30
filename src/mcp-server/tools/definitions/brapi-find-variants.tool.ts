/**
 * @fileoverview `brapi_find_variants` — find variant records by variant set,
 * reference, or genomic region. Standard find_* pattern — distributions +
 * dataframe spillover. Note: the BrAPI filter catalog uses `start` / `end` as
 * single scalars (1-based inclusive / exclusive) per the spec.
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
  ExtraFiltersInput,
  LoadLimitInput,
  loadInitialFindPage,
  maybeSpill,
  mergeFilters,
  renderDataframeHandle,
  renderDistributions,
  renderFindHeader,
  requireRegisteredConnection,
  resolveFindRoute,
} from '../shared/find-helpers.js';

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
    start: z.number().nullish().describe('1-based inclusive start position.'),
    end: z.number().nullish().describe('1-based exclusive end position.'),
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
  alias: z.string().describe('Alias of the registered BrAPI connection the call used.'),
  results: z
    .array(VariantRowSchema)
    .describe('Variant rows returned in-context (up to loadLimit).'),
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
    .describe('Value frequency per field across the full result set.'),
  dataframe: DataframeHandleSchema.optional().describe(
    'Dataframe handle when the full result set was materialized as a dataframe. Query it with brapi_dataframe_query (SQL).',
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
    'Find variant records by variant set, reference sequence, or genomic region (start/end, 1-based inclusive / exclusive). When the upstream total exceeds loadLimit, the full result set is materialized as a dataframe — query it with brapi_dataframe_query (SQL).',
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'unknown_alias',
      code: JsonRpcErrorCode.NotFound,
      when: 'No connection has been registered under the requested alias',
      recovery:
        'Run brapi_connect with this alias (or omit `alias` to use the default connection) before calling brapi_find_variants.',
    },
    {
      reason: 'all_filters_dropped',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The active dialect dropped every filter the agent supplied — the upstream server does not honor any of the requested scope filters on this endpoint, so the call would silently widen to the unfiltered baseline.',
      recovery:
        'Drop the unsupported filters and rescope by variants, variantSets, references, or referenceName + start/end — these filter paths are honored on the active dialect.',
    },
  ] as const,
  input: z.object({
    alias: AliasInput,
    variantSets: z.array(z.string()).optional().describe('Filter by variantSetDbIds.'),
    variants: z.array(z.string()).optional().describe('Filter by variantDbIds.'),
    references: z.array(z.string()).optional().describe('Filter by referenceDbIds.'),
    referenceName: z.string().optional().describe('Reference display name (e.g. "chr01", "chr1").'),
    start: z.number().int().nonnegative().optional().describe('Inclusive 1-based start.'),
    end: z.number().int().positive().optional().describe('Exclusive 1-based end.'),
    loadLimit: LoadLimitInput,
    extraFilters: ExtraFiltersInput,
  }),
  output: OutputSchema,

  // Agent-facing success-path context: pagination totals, the exact filter map
  // sent to the server, guidance when the result set is large, and empty-result
  // notices. Populated via ctx.enrich() so it reaches both structuredContent
  // and the content[] trailer without living in the domain return.
  enrichment: {
    totalCount: z.number().int().nonnegative().describe('Total rows reported by the server.'),
    returnedCount: z.number().int().nonnegative().describe('Length of results[].'),
    appliedFilters: z
      .record(z.string(), z.unknown())
      .describe('The final filter map sent to the server (named + extraFilters).'),
    refinementHint: z
      .string()
      .optional()
      .describe('Suggested next-step query refinement when the result set is large.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when no rows were returned — how to broaden filters or retry.'),
    warnings: z
      .array(z.string())
      .describe('Advisory messages (filter overrides, partial data, capability gaps).'),
  },

  enrichmentTrailer: {
    appliedFilters: {
      render: (filters) => {
        const entries = Object.entries(filters);
        if (entries.length === 0) return '**Applied Filters:** none';
        const lines = entries.map(([k, v]) => {
          const display = SERVER_TO_USER[k] ?? k;
          return `- **${display}:** ${Array.isArray(v) ? v.join(', ') : String(v)}`;
        });
        return `**Applied Filters:**\n${lines.join('\n')}`;
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

    const { fullRows, dataframe } = await maybeSpill({
      firstPage,
      client,
      connection,
      path: '/variants',
      filters,
      route,
      source: 'find_variants',
      loadLimit,
      ctx,
      bridge,
      ...(normalizeRow ? { normalizeRow } : {}),
    });

    const distributions = {
      variantType: computeDistribution(fullRows, (r) => asString(r.variantType)),
      referenceName: computeDistribution(fullRows, (r) => asString(r.referenceName)),
      variantSetDbId: computeDistribution(fullRows, (r) => collectVariantSetIds(r)),
    };

    checkFilterMatchRates(warnings, fullRows.length, [
      ...buildExtraFilterChecks(input.extraFilters, fullRows, warnings),
    ]);

    const totalCount = firstPage.totalCount ?? firstPage.rows.length;
    const refinementHint = buildRefinementHint(totalCount, loadLimit, distributions, {
      availableFilters: ['variantSets', 'variants', 'references', 'referenceName', 'start', 'end'],
    });

    const appliedFilters = route.kind === 'search' ? route.searchBody : filters;
    ctx.enrich({
      totalCount,
      returnedCount: firstPage.rows.length,
      appliedFilters,
      warnings,
      ...(refinementHint ? { refinementHint } : {}),
    });
    if (firstPage.rows.length === 0)
      ctx.enrich.notice(
        warnings.length > 0
          ? 'No rows returned. Check the warnings above for filter issues, or broaden your filters.'
          : 'No variants matched the applied filters. Try broadening variantSets, references, or referenceName + start/end range.',
      );

    const result: Output = {
      alias: connection.alias,
      results: firstPage.rows as z.infer<typeof VariantRowSchema>[],
      hasMore: firstPage.hasMore,
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
    if (result.hasMore) {
      lines.push(
        `⚠ More rows exist beyond the returned set. ${result.dataframe ? `Full set materialized as dataframe \`${result.dataframe.tableName}\` — query with brapi_dataframe_query.` : 'Narrow filters or raise loadLimit.'}`,
      );
      lines.push('');
    }
    lines.push('## Distributions');
    lines.push(renderDistributions(result.distributions) || '_No values to summarize._');
    lines.push('');
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
        const parts: string[] = [`**${label}**`];
        parts.push(`id=\`${v.variantDbId}\``);
        if (v.variantType) parts.push(`type=${v.variantType}`);
        const setIds = collectVariantSetIds(v);
        if (setIds && setIds.length > 0) parts.push(`set=${setIds.join(',')}`);
        if (v.referenceName) parts.push(`ref=${v.referenceName}`);
        if (v.start != null) parts.push(`start=${v.start}`);
        if (v.end != null) parts.push(`end=${v.end}`);
        if (v.referenceBases) parts.push(`refBases=${v.referenceBases}`);
        if (v.alternateBases?.length) parts.push(`altBases=${v.alternateBases.join(',')}`);
        if (v.filtersApplied != null) parts.push(`filtersApplied=${v.filtersApplied}`);
        if (v.filtersPassed != null) parts.push(`filtersPassed=${v.filtersPassed}`);
        if (v.filtersFailed?.length) parts.push(`filtersFailed=${v.filtersFailed.join(',')}`);
        if (v.variantNames?.length) parts.push(`names=${v.variantNames.join(',')}`);
        parts.push(...collectPassthroughParts(v as Record<string, unknown>, RENDERED));
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
