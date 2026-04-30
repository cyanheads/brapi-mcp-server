/**
 * @fileoverview `brapi_find_variants` — find variant records by variant set,
 * reference, or genomic region. Standard find_* pattern — distributions +
 * dataset spillover. Note: the BrAPI filter catalog uses `start` / `end` as
 * single scalars (1-based inclusive / exclusive) per the spec.
 *
 * @module mcp-server/tools/definitions/brapi-find-variants.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';
import { getBrapiClient } from '@/services/brapi-client/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import { getDatasetStore } from '@/services/dataset-store/index.js';
import { DEFAULT_ALIAS, getServerRegistry } from '@/services/server-registry/index.js';
import {
  AliasInput,
  asString,
  buildRefinementHint,
  computeDistribution,
  DatasetHandleSchema,
  ExtraFiltersInput,
  LoadLimitInput,
  loadInitialPage,
  maybeSpill,
  mergeFilters,
  renderDatasetHandle,
  renderDistributions,
} from '../shared/find-helpers.js';

const VariantRowSchema = z
  .object({
    variantDbId: z.string().describe('Server-side identifier for the variant.'),
    variantNames: z
      .array(z.string().describe('Variant name or alias.'))
      .optional()
      .describe('Known names / aliases for this variant.'),
    variantSetDbId: z
      .union([
        z.string().describe('Single variant-set FK (older BrAPI servers).'),
        z
          .array(z.string().describe('One variant-set FK.'))
          .describe('Variant-set FK array — a variant may belong to multiple sets.'),
      ])
      .optional()
      .describe(
        'FK to the variant set(s) this variant belongs to. May be a string or string[] depending on server.',
      ),
    variantSetDbIds: z
      .array(z.string().describe('Variant-set FK.'))
      .optional()
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
  returnedCount: z.number().int().nonnegative().describe('Length of `results[]`.'),
  totalCount: z.number().int().nonnegative().describe('Total rows reported by the server.'),
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
  refinementHint: z
    .string()
    .optional()
    .describe('Suggested next-step query refinement when the result set is large.'),
  dataset: DatasetHandleSchema.optional().describe(
    'Dataset handle when the full result set was persisted to DatasetStore.',
  ),
  warnings: z
    .array(z.string())
    .describe('Advisory messages (filter overrides, partial data, capability gaps, etc.).'),
  appliedFilters: z
    .record(z.string(), z.unknown())
    .describe('The final filter map sent to the server (named + extraFilters).'),
});

type Output = z.infer<typeof OutputSchema>;

export const brapiFindVariants = tool('brapi_find_variants', {
  description:
    'Find variant records by variant set, reference sequence, or genomic region (start/end, 1-based inclusive / exclusive). Returns a dataset handle when the upstream total exceeds loadLimit.',
  annotations: { readOnlyHint: true, openWorldHint: true },
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

  async handler(input, ctx) {
    const registry = getServerRegistry();
    const capabilities = getCapabilityRegistry();
    const client = getBrapiClient();
    const datasetStore = getDatasetStore();
    const config = getServerConfig();

    const connection = await registry.get(ctx, input.alias ?? DEFAULT_ALIAS);

    const capabilityLookup: { auth?: typeof connection.resolvedAuth } = {};
    if (connection.resolvedAuth) capabilityLookup.auth = connection.resolvedAuth;
    await capabilities.ensure(
      connection.baseUrl,
      { service: 'variants', method: 'GET' },
      ctx,
      capabilityLookup,
    );

    const warnings: string[] = [];
    if (input.start !== undefined && input.end !== undefined && input.start >= input.end) {
      warnings.push('start >= end; upstream will likely return an empty result set.');
    }
    const filters = mergeFilters(
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

    const loadLimit = input.loadLimit ?? config.loadLimit;
    const firstPage = await loadInitialPage<Record<string, unknown>>(
      client,
      connection,
      '/variants',
      filters,
      loadLimit,
      ctx,
    );

    const { fullRows, dataset: datasetMeta } = await maybeSpill({
      firstPage,
      client,
      connection,
      path: '/variants',
      filters,
      source: 'find_variants',
      loadLimit,
      ctx,
      store: datasetStore,
    });

    const distributions = {
      variantType: computeDistribution(fullRows, (r) => asString(r.variantType)),
      referenceName: computeDistribution(fullRows, (r) => asString(r.referenceName)),
      variantSetDbId: computeDistribution(fullRows, (r) => collectVariantSetIds(r)),
    };

    const totalCount = firstPage.totalCount ?? firstPage.rows.length;
    const refinementHint = buildRefinementHint(totalCount, loadLimit, distributions);

    const result: Output = {
      alias: connection.alias,
      results: firstPage.rows as z.infer<typeof VariantRowSchema>[],
      returnedCount: firstPage.rows.length,
      totalCount,
      hasMore: firstPage.hasMore,
      distributions,
      warnings,
      appliedFilters: filters,
    };
    if (refinementHint) result.refinementHint = refinementHint;
    if (datasetMeta) result.dataset = datasetMeta;
    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`# ${result.returnedCount} of ${result.totalCount} variants — \`${result.alias}\``);
    lines.push('');
    if (result.hasMore) {
      lines.push(
        `⚠ More rows exist beyond the returned set. ${result.dataset ? `Full set persisted as dataset \`${result.dataset.datasetId}\`.` : 'Narrow filters or raise loadLimit.'}`,
      );
      lines.push('');
    }
    if (result.refinementHint) {
      lines.push(`**Refinement hint:** ${result.refinementHint}`);
      lines.push('');
    }
    lines.push(`Applied filters: \`${JSON.stringify(result.appliedFilters)}\``);
    lines.push('');
    lines.push('## Distributions');
    lines.push(renderDistributions(result.distributions) || '_No values to summarize._');
    lines.push('');
    lines.push('## Variants');
    if (result.results.length === 0) {
      lines.push('_No rows returned._');
    } else {
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
        lines.push(`- ${parts.join(' · ')}`);
      }
    }
    if (result.dataset) {
      lines.push('');
      lines.push('## Dataset handle');
      lines.push(...renderDatasetHandle(result.dataset));
    }
    if (result.warnings.length > 0) {
      lines.push('');
      lines.push('## Warnings');
      for (const w of result.warnings) lines.push(`- ${w}`);
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
