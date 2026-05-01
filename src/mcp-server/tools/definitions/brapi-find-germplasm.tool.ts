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
import { resolveDialect } from '@/services/brapi-dialect/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import { getDatasetStore } from '@/services/dataset-store/index.js';
import { DEFAULT_ALIAS, getServerRegistry } from '@/services/server-registry/index.js';
import {
  AliasInput,
  applyDialectFilters,
  asString,
  buildRefinementHint,
  checkFilterMatchRates,
  collectPassthroughParts,
  computeDistribution,
  DatasetHandleSchema,
  ExtraFiltersInput,
  LoadLimitInput,
  loadInitialPage,
  type MaybeSpillInput,
  maybeSpill,
  mergeFilters,
  renderAppliedFilters,
  renderDatasetHandle,
  renderDistributions,
  renderFindHeader,
} from '../shared/find-helpers.js';

const GermplasmRowSchema = z
  .object({
    germplasmDbId: z.string().describe('Server-side identifier for the germplasm.'),
    germplasmName: z.string().nullish().describe('Display name.'),
    germplasmPUI: z.string().nullish().describe('Persistent unique identifier (URI).'),
    commonCropName: z.string().nullish().describe('Common crop name (e.g. "Maize", "Wheat").'),
    accessionNumber: z.string().nullish().describe('Gene-bank catalog number.'),
    genus: z.string().nullish().describe('Botanical genus.'),
    species: z.string().nullish().describe('Botanical species.'),
    subtaxa: z.string().nullish().describe('Botanical subtaxa (subspecies, variety, etc.).'),
    defaultDisplayName: z.string().nullish().describe('Preferred display label.'),
    pedigree: z.string().nullish().describe('Pedigree as a free-text string (e.g. "A/B//C").'),
    biologicalStatusOfAccessionDescription: z
      .string()
      .nullish()
      .describe('MCPD biological-status label (wild / landrace / breeding / cultivar, etc.).'),
    germplasmOrigin: z
      .array(
        z
          .object({})
          .passthrough()
          .describe('One origin record (collection coordinates and uncertainty per BrAPI v2).'),
      )
      .nullish()
      .describe('Origin records — array of collection-site objects per BrAPI v2.'),
    countryOfOriginCode: z.string().nullish().describe('ISO 3166-1 alpha-3 country code.'),
    collection: z.string().nullish().describe('Collection name this accession belongs to.'),
    instituteCode: z
      .string()
      .nullish()
      .describe('FAO WIEWS institute code of the holding institute.'),
    instituteName: z.string().nullish().describe('Display name of the holding institute.'),
    synonyms: z
      .array(
        z
          .object({
            synonym: z.string().nullish().describe('Synonym value.'),
            type: z.string().nullish().describe('Synonym type (e.g. "COMMON", "SYNONYM").'),
          })
          .passthrough()
          .describe('Registered synonym for this germplasm.'),
      )
      .nullish()
      .describe('All registered synonyms (alternative names).'),
  })
  .passthrough()
  .describe('One BrAPI germplasm record.');

const OutputSchema = z.object({
  alias: z.string().describe('Alias of the registered BrAPI connection the call used.'),
  results: z
    .array(GermplasmRowSchema)
    .describe('Germplasm rows returned in-context (up to loadLimit).'),
  returnedCount: z.number().int().nonnegative().describe('Length of `results[]`.'),
  totalCount: z.number().int().nonnegative().describe('Total rows reported by the server.'),
  hasMore: z.boolean().describe('True when more rows exist beyond the returned set.'),
  distributions: z
    .object({
      commonCropName: z
        .record(z.string(), z.number())
        .describe('Common crop name → count of rows for that crop.'),
      genus: z.record(z.string(), z.number()).describe('Genus → count of rows with that genus.'),
      species: z
        .record(z.string(), z.number())
        .describe('Species → count of rows with that species.'),
      collection: z
        .record(z.string(), z.number())
        .describe('Collection name → count of rows in that collection.'),
      countryOfOriginCode: z
        .record(z.string(), z.number())
        .describe('ISO country code → count of rows from that country.'),
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

const SERVER_TO_USER: Record<string, string> = {
  // Plurals — BrAPI v2.1 spec, used by the `spec` dialect.
  germplasmNames: 'names',
  germplasmDbIds: 'germplasmDbIds',
  germplasmPUIs: 'germplasmPUIs',
  accessionNumbers: 'accessionNumbers',
  commonCropNames: 'crops',
  synonyms: 'synonyms',
  collections: 'collections',
  // Singulars — emitted by SGN-family dialects (cassavabase, etc.).
  germplasmName: 'names',
  germplasmDbId: 'germplasmDbIds',
  germplasmPUI: 'germplasmPUIs',
  accessionNumber: 'accessionNumbers',
  commonCropName: 'crops',
  synonym: 'synonyms',
  collection: 'collections',
  // Scalars — same on the wire either way.
  genus: 'genus',
  species: 'species',
};

export const brapiFindGermplasm = tool('brapi_find_germplasm', {
  description:
    'Find germplasm by name, synonym, accession number, PUI, crop, or free-text query. Matches across registered synonyms. Returns a dataset handle when the upstream total exceeds loadLimit.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    alias: AliasInput,
    names: z.array(z.string()).optional().describe('Filter by germplasm display names.'),
    germplasmDbIds: z.array(z.string()).optional().describe('Filter by DbIds.'),
    germplasmPUIs: z.array(z.string()).optional().describe('Persistent unique identifiers.'),
    accessionNumbers: z
      .array(z.string())
      .optional()
      .describe('Filter by accession numbers (gene-bank catalog codes).'),
    crops: z.array(z.string()).optional().describe('Filter by common crop names.'),
    synonyms: z.array(z.string()).optional().describe('Match registered synonyms.'),
    collections: z.array(z.string()).optional().describe('Filter by germplasm collection names.'),
    genus: z.string().optional().describe('Botanical genus.'),
    species: z.string().optional().describe('Botanical species.'),
    text: z
      .string()
      .optional()
      .describe(
        'Free-text query. Applied client-side as a substring match on returned rows (germplasmName, accessionNumber, defaultDisplayName, registered synonyms) — no BrAPI server reliably supports a server-side free-text filter, so combine with `crops` / `genus` / etc. to narrow the upstream pull first.',
      ),
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

    const dialect = await resolveDialect(connection, ctx, capabilityLookup);

    const warnings: string[] = [];
    const merged = mergeFilters(
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
      },
      input.extraFilters,
      warnings,
    );

    const filters = applyDialectFilters(dialect, 'germplasm', merged, warnings);

    const loadLimit = input.loadLimit ?? config.loadLimit;
    const firstPage = await loadInitialPage<Record<string, unknown>>(
      client,
      connection,
      '/germplasm',
      filters,
      loadLimit,
      ctx,
    );

    // Free-text matching is client-side. No BrAPI server reliably honors a
    // free-text query parameter on /germplasm — earlier versions of this tool
    // sent `searchText`, which CassavaBase and the Test Server both silently
    // ignore. Decide upfront whether to spill: when text is set and matches
    // 0 rows on the first page, pulling more pages is unlikely to surface
    // hits and we'd just bury the agent in 50k unrelated rows.
    const text = input.text;
    const wouldSpill =
      firstPage.hasMore && firstPage.totalCount !== undefined && firstPage.totalCount > loadLimit;
    const firstPageMatched = text
      ? firstPage.rows.filter((row) => rowMatchesText(row, text))
      : firstPage.rows;
    const skipSpillForTextMiss = Boolean(
      text && wouldSpill && firstPage.rows.length > 0 && firstPageMatched.length === 0,
    );

    const spillInput: MaybeSpillInput<Record<string, unknown>> = {
      firstPage: skipSpillForTextMiss
        ? // Treat the first page as the whole result — no further pages pulled.
          { rows: firstPage.rows, hasMore: false, pagesFetched: 1 }
        : firstPage,
      client,
      connection,
      path: '/germplasm',
      filters,
      source: 'find_germplasm',
      loadLimit,
      ctx,
      store: datasetStore,
    };
    if (text) spillInput.rowFilter = (row) => rowMatchesText(row, text);

    const { fullRows, dataset: datasetMeta } = await maybeSpill(spillInput);

    const distributions = {
      commonCropName: computeDistribution(fullRows, (r) => asString(r.commonCropName)),
      genus: computeDistribution(fullRows, (r) => asString(r.genus)),
      species: computeDistribution(fullRows, (r) => asString(r.species)),
      collection: computeDistribution(fullRows, (r) => asString(r.collection)),
      countryOfOriginCode: computeDistribution(fullRows, (r) => asString(r.countryOfOriginCode)),
    };

    checkFilterMatchRates(warnings, fullRows.length, [
      {
        paramName: 'crops',
        requestedValues: input.crops,
        distribution: distributions.commonCropName,
        caseInsensitive: true,
      },
      {
        paramName: 'genus',
        requestedValues: input.genus !== undefined ? [input.genus] : undefined,
        distribution: distributions.genus,
        caseInsensitive: true,
      },
      {
        paramName: 'species',
        requestedValues: input.species !== undefined ? [input.species] : undefined,
        distribution: distributions.species,
        caseInsensitive: true,
      },
      {
        paramName: 'collections',
        requestedValues: input.collections,
        distribution: distributions.collection,
        caseInsensitive: true,
      },
    ]);

    const totalCount = firstPage.totalCount ?? firstPage.rows.length;
    const refinementHint = buildRefinementHint(totalCount, loadLimit, distributions, {
      availableFilters: [
        'names',
        'germplasmDbIds',
        'germplasmPUIs',
        'accessionNumbers',
        'crops',
        'synonyms',
        'collections',
        'genus',
        'species',
        'text',
      ],
    });

    if (text) {
      if (skipSpillForTextMiss) {
        warnings.push(
          `Free-text '${text}' matched 0 of ${firstPage.rows.length} first-page rows out of ${totalCount} upstream. Spillover skipped — pulling more pages is unlikely to surface hits. Use exact filters: \`names: ['${text}']\`, \`accessionNumbers: ['${text}']\`, or \`germplasmDbIds: ['${text}']\` for direct lookup.`,
        );
      } else if (fullRows.length === 0 && firstPage.rows.length > 0) {
        warnings.push(
          `Free-text '${text}' matched 0 of ${firstPage.rows.length} returned rows. Use exact filters (\`names\`, \`accessionNumbers\`, \`germplasmDbIds\`) for direct lookup, or check spelling.`,
        );
      } else if (datasetMeta) {
        warnings.push(
          `Free-text '${text}' filtered the dataset to ${datasetMeta.rowCount} matched row(s) across the upstream union.`,
        );
      } else if (fullRows.length < firstPage.rows.length) {
        warnings.push(
          `Free-text '${text}' narrowed in-context view to ${fullRows.length} of ${firstPage.rows.length} returned rows.`,
        );
      }
    }

    const inContextRows = fullRows.slice(0, loadLimit);

    const result: Output = {
      alias: connection.alias,
      results: inContextRows as z.infer<typeof GermplasmRowSchema>[],
      returnedCount: inContextRows.length,
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
    lines.push(
      renderFindHeader({
        noun: 'germplasm',
        alias: result.alias,
        returnedCount: result.returnedCount,
        totalCount: result.totalCount,
        dataset: result.dataset,
      }),
    );
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
    lines.push(renderAppliedFilters(result.appliedFilters, SERVER_TO_USER));
    lines.push('');
    lines.push('## Distributions');
    lines.push(renderDistributions(result.distributions) || '_No values to summarize._');
    lines.push('');
    lines.push('## Germplasm');
    if (result.results.length === 0) {
      lines.push('_No rows returned._');
    } else {
      const RENDERED = new Set([
        'germplasmName',
        'defaultDisplayName',
        'germplasmDbId',
        'germplasmPUI',
        'accessionNumber',
        'commonCropName',
        'genus',
        'species',
        'subtaxa',
        'countryOfOriginCode',
        'collection',
        'instituteCode',
        'instituteName',
        'germplasmOrigin',
        'biologicalStatusOfAccessionDescription',
        'pedigree',
        'synonyms',
      ]);
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
        if (g.germplasmOrigin?.length)
          parts.push(`germplasmOrigin=${JSON.stringify(g.germplasmOrigin)}`);
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
        parts.push(...collectPassthroughParts(g as Record<string, unknown>, RENDERED));
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

function rowMatchesText(row: Record<string, unknown>, text: string): boolean {
  const needle = text.toLowerCase();
  const containsNeedle = (value: unknown): boolean =>
    typeof value === 'string' && value.toLowerCase().includes(needle);
  if (
    containsNeedle(row.germplasmName) ||
    containsNeedle(row.germplasmPUI) ||
    containsNeedle(row.accessionNumber) ||
    containsNeedle(row.defaultDisplayName)
  ) {
    return true;
  }
  if (Array.isArray(row.synonyms)) {
    for (const entry of row.synonyms) {
      if (
        entry &&
        typeof entry === 'object' &&
        containsNeedle((entry as Record<string, unknown>).synonym)
      ) {
        return true;
      }
    }
  }
  return false;
}
