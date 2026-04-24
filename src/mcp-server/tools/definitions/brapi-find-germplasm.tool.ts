/**
 * @fileoverview `brapi_find_germplasm` — search germplasm by name, synonym,
 * accession, attribute, or free text. Matches BrAPI's registered-synonym
 * semantics. Returns distributions for crop / genus / species / collection
 * and spills to DatasetStore when the upstream total exceeds loadLimit.
 *
 * @module mcp-server/tools/definitions/brapi-find-germplasm.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';
import { getBrapiClient } from '@/services/brapi-client/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import { getDatasetStore } from '@/services/dataset-store/index.js';
import { DEFAULT_ALIAS, getServerRegistry } from '@/services/server-registry/index.js';
import {
  AliasInput,
  computeDistribution,
  ExtraFiltersInput,
  LoadLimitInput,
  loadInitialPage,
  mergeFilters,
  renderDistributions,
  spillToDataset,
} from '../shared/find-helpers.js';

const GermplasmRowSchema = z
  .object({
    germplasmDbId: z.string(),
    germplasmName: z.string().optional(),
    germplasmPUI: z.string().optional(),
    commonCropName: z.string().optional(),
    accessionNumber: z.string().optional(),
    genus: z.string().optional(),
    species: z.string().optional(),
    subtaxa: z.string().optional(),
    defaultDisplayName: z.string().optional(),
    pedigree: z.string().optional(),
    biologicalStatusOfAccessionDescription: z.string().optional(),
    germplasmOrigin: z.string().optional(),
    countryOfOriginCode: z.string().optional(),
    collection: z.string().optional(),
    instituteCode: z.string().optional(),
    instituteName: z.string().optional(),
    synonyms: z
      .array(
        z.object({ synonym: z.string().optional(), type: z.string().optional() }).passthrough(),
      )
      .optional(),
  })
  .passthrough();

const DatasetHandleSchema = z.object({
  datasetId: z.string(),
  rowCount: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  columns: z.array(z.string()),
  createdAt: z.string(),
  expiresAt: z.string(),
});

const OutputSchema = z.object({
  alias: z.string(),
  results: z.array(GermplasmRowSchema),
  returnedCount: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  distributions: z.object({
    commonCropName: z.record(z.string(), z.number()),
    genus: z.record(z.string(), z.number()),
    species: z.record(z.string(), z.number()),
    collection: z.record(z.string(), z.number()),
    countryOfOriginCode: z.record(z.string(), z.number()),
  }),
  refinementHint: z.string().optional(),
  dataset: DatasetHandleSchema.optional(),
  warnings: z.array(z.string()),
  appliedFilters: z.record(z.string(), z.unknown()),
});

type Output = z.infer<typeof OutputSchema>;

export const brapiFindGermplasm = tool('brapi_find_germplasm', {
  description:
    'Find germplasm by name, synonym, accession number, PUI, crop, or free-text query. Matches across registered synonyms. Returns a dataset handle when the upstream total exceeds loadLimit. Use brapi_describe_filters to discover extraFilters keys.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    alias: AliasInput,
    names: z.array(z.string()).optional().describe('Filter by germplasm display names.'),
    germplasmDbIds: z.array(z.string()).optional().describe('Filter by DbIds.'),
    germplasmPUIs: z.array(z.string()).optional().describe('Persistent unique identifiers.'),
    accessionNumbers: z.array(z.string()).optional(),
    crops: z.array(z.string()).optional().describe('Filter by common crop names.'),
    synonyms: z.array(z.string()).optional().describe('Match registered synonyms.'),
    collections: z.array(z.string()).optional(),
    genus: z.string().optional().describe('Botanical genus.'),
    species: z.string().optional().describe('Botanical species.'),
    text: z.string().optional().describe('Free-text query. Server-supported subset.'),
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
      { service: 'germplasm', method: 'GET' },
      ctx,
      capabilityLookup,
    );

    const warnings: string[] = [];
    const filters = mergeFilters(
      {
        germplasmNames: input.names,
        germplasmDbIds: input.germplasmDbIds,
        germplasmPUIs: input.germplasmPUIs,
        accessionNumbers: input.accessionNumbers,
        commonCropNames: input.crops,
        synonyms: input.synonyms,
        collections: input.collections,
        genus: input.genus,
        species: input.species,
        searchText: input.text,
      },
      input.extraFilters,
      warnings,
    );

    const loadLimit = input.loadLimit ?? config.loadLimit;
    const firstPage = await loadInitialPage<Record<string, unknown>>(
      client,
      connection,
      '/germplasm',
      filters,
      loadLimit,
      ctx,
    );

    let fullRows: Record<string, unknown>[] = firstPage.rows;
    let datasetMeta: z.infer<typeof DatasetHandleSchema> | undefined;

    if (
      firstPage.hasMore &&
      firstPage.totalCount !== undefined &&
      firstPage.totalCount > loadLimit
    ) {
      const spill = await spillToDataset({
        store: datasetStore,
        client,
        connection,
        path: '/germplasm',
        filters,
        source: 'find_germplasm',
        loadLimit,
        ctx,
        firstPage: firstPage.rows,
        totalCount: firstPage.totalCount,
      });
      fullRows = spill.fullRows;
      datasetMeta = {
        datasetId: spill.dataset.datasetId,
        rowCount: spill.dataset.rowCount,
        sizeBytes: spill.dataset.sizeBytes,
        columns: spill.dataset.columns,
        createdAt: spill.dataset.createdAt,
        expiresAt: spill.dataset.expiresAt,
      };
    }

    const distributions = {
      commonCropName: computeDistribution(fullRows, (r) => asString(r.commonCropName)),
      genus: computeDistribution(fullRows, (r) => asString(r.genus)),
      species: computeDistribution(fullRows, (r) => asString(r.species)),
      collection: computeDistribution(fullRows, (r) => asString(r.collection)),
      countryOfOriginCode: computeDistribution(fullRows, (r) => asString(r.countryOfOriginCode)),
    };

    const totalCount = firstPage.totalCount ?? firstPage.rows.length;
    const refinementHint = buildRefinementHint(totalCount, loadLimit, distributions);

    const result: Output = {
      alias: connection.alias,
      results: firstPage.rows as z.infer<typeof GermplasmRowSchema>[],
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
    lines.push(`# ${result.returnedCount} of ${result.totalCount} germplasm — \`${result.alias}\``);
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
    lines.push('## Germplasm');
    if (result.results.length === 0) {
      lines.push('_No rows returned._');
    } else {
      for (const g of result.results) {
        const parts: string[] = [
          `**${g.germplasmName ?? g.defaultDisplayName ?? g.germplasmDbId}**`,
        ];
        parts.push(`id=\`${g.germplasmDbId}\``);
        if (g.germplasmPUI) parts.push(`pui=${g.germplasmPUI}`);
        if (g.accessionNumber) parts.push(`accession=${g.accessionNumber}`);
        if (g.commonCropName) parts.push(`crop=${g.commonCropName}`);
        if (g.genus) parts.push(`genus=${g.genus}`);
        if (g.species) parts.push(`species=${g.species}`);
        if (g.subtaxa) parts.push(`subtaxa=${g.subtaxa}`);
        if (g.countryOfOriginCode) parts.push(`country=${g.countryOfOriginCode}`);
        if (g.collection) parts.push(`collection=${g.collection}`);
        if (g.instituteCode) parts.push(`institute=${g.instituteCode}`);
        if (g.instituteName) parts.push(`instituteName=${g.instituteName}`);
        if (g.germplasmOrigin) parts.push(`origin=${g.germplasmOrigin}`);
        if (g.biologicalStatusOfAccessionDescription)
          parts.push(`status=${g.biologicalStatusOfAccessionDescription}`);
        if (g.pedigree) parts.push(`pedigree=${g.pedigree}`);
        if (g.defaultDisplayName) parts.push(`displayName=${g.defaultDisplayName}`);
        if (g.synonyms?.length) {
          const synStr = g.synonyms
            .map((s) => `${s.synonym ?? '?'}${s.type ? ` (${s.type})` : ''}`)
            .join(',');
          parts.push(`synonyms=${synStr}`);
        }
        lines.push(`- ${parts.join(' · ')}`);
      }
    }
    if (result.dataset) {
      lines.push('');
      lines.push('## Dataset handle');
      lines.push(`- datasetId: \`${result.dataset.datasetId}\``);
      lines.push(`- rowCount: ${result.dataset.rowCount}`);
      lines.push(`- sizeBytes: ${result.dataset.sizeBytes}`);
      lines.push(`- columns: ${result.dataset.columns.join(', ')}`);
      lines.push(`- createdAt: ${result.dataset.createdAt}`);
      lines.push(`- expiresAt: ${result.dataset.expiresAt}`);
    }
    if (result.warnings.length > 0) {
      lines.push('');
      lines.push('## Warnings');
      for (const w of result.warnings) lines.push(`- ${w}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function buildRefinementHint(
  totalCount: number,
  loadLimit: number,
  distributions: Record<string, Record<string, number>>,
): string | undefined {
  if (totalCount <= loadLimit) return;
  let best: { field: string; topValue: string; count: number; cardinality: number } | undefined;
  for (const [field, counts] of Object.entries(distributions)) {
    const entries = Object.entries(counts);
    if (entries.length < 2) continue;
    const top = entries[0];
    if (!top) continue;
    const [topValue, count] = top;
    if (!best || entries.length > best.cardinality) {
      best = { field, topValue, count, cardinality: entries.length };
    }
  }
  if (!best) {
    return `${totalCount} rows exceed loadLimit=${loadLimit}. Add more specific filters or raise loadLimit.`;
  }
  return `${totalCount} rows exceed loadLimit=${loadLimit}. The ${best.field} distribution spans ${best.cardinality} values — narrowing to \`${best.topValue}\` would cut to ~${best.count} rows.`;
}
