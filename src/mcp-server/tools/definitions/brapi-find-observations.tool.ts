/**
 * @fileoverview `brapi_find_observations` — pull observation records filtered
 * by study, germplasm, variable, season, or observation unit. Matches the
 * find_* pattern: paged single pull capped at loadLimit, distributions across
 * variable/study/germplasm/level, dataset spillover when the upstream total
 * exceeds loadLimit.
 *
 * @module mcp-server/tools/definitions/brapi-find-observations.tool
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
  renderDistributions,
} from '../shared/find-helpers.js';

const ObservationRowSchema = z
  .object({
    observationDbId: z.string().optional().describe('Server-side identifier for the observation.'),
    observationUnitDbId: z
      .string()
      .optional()
      .describe('FK to the observation unit (plot / plant / sample) that carries the measurement.'),
    observationUnitName: z.string().optional().describe('Display name of the observation unit.'),
    observationVariableDbId: z
      .string()
      .optional()
      .describe('FK to the observation variable (trait) measured.'),
    observationVariableName: z
      .string()
      .optional()
      .describe('Display name of the observation variable.'),
    studyDbId: z.string().optional().describe('FK to the study the observation belongs to.'),
    studyName: z.string().optional().describe('Display name of the study.'),
    germplasmDbId: z
      .string()
      .optional()
      .describe('FK to the germplasm the observation was taken on.'),
    germplasmName: z.string().optional().describe('Display name of the germplasm.'),
    observationLevel: z.string().optional().describe('Unit level — e.g. "plot", "plant", "field".'),
    season: z.string().optional().describe('Season identifier (e.g. "2022").'),
    value: z
      .string()
      .optional()
      .describe('Recorded measurement value (stringified per BrAPI spec).'),
    observationTimeStamp: z.string().optional().describe('ISO 8601 timestamp of the observation.'),
    collector: z.string().optional().describe('Name or ID of the person who collected the value.'),
    uploadedBy: z.string().optional().describe('Name or ID of the user who uploaded the record.'),
  })
  .passthrough()
  .describe('One BrAPI observation record.');

const OutputSchema = z.object({
  alias: z.string().describe('Alias of the registered BrAPI connection the call used.'),
  results: z
    .array(ObservationRowSchema)
    .describe('Observation rows returned in-context (up to loadLimit).'),
  returnedCount: z.number().int().nonnegative().describe('Length of `results[]`.'),
  totalCount: z.number().int().nonnegative().describe('Total rows reported by the server.'),
  hasMore: z.boolean().describe('True when more rows exist beyond the returned set.'),
  distributions: z
    .object({
      observationVariableName: z
        .record(z.string(), z.number())
        .describe('Variable name → count of observations for that trait.'),
      studyName: z
        .record(z.string(), z.number())
        .describe('Study name → count of observations in that study.'),
      germplasmName: z
        .record(z.string(), z.number())
        .describe('Germplasm name → count of observations on that germplasm.'),
      observationLevel: z
        .record(z.string(), z.number())
        .describe('Unit level (plot / plant / field) → count of observations at that level.'),
      season: z
        .record(z.string(), z.number())
        .describe('Season identifier → count of observations in that season.'),
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

export const brapiFindObservations = tool('brapi_find_observations', {
  description:
    'Pull observation records filtered by study, germplasm, variable, season, or observation unit. Returns a dataset handle when the upstream total exceeds loadLimit — inspect via brapi_manage_dataset. Use brapi_describe_filters for extraFilters keys.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    alias: AliasInput,
    studies: z.array(z.string()).optional().describe('Filter by studyDbIds.'),
    germplasm: z.array(z.string()).optional().describe('Filter by germplasmDbIds.'),
    variables: z.array(z.string()).optional().describe('Filter by observationVariableDbIds.'),
    observationUnits: z.array(z.string()).optional().describe('Filter by observationUnitDbIds.'),
    observations: z.array(z.string()).optional().describe('Filter by observationDbIds.'),
    seasons: z.array(z.string()).optional().describe('Filter by seasonDbIds (e.g. "2022").'),
    programs: z.array(z.string()).optional().describe('Filter by programDbIds.'),
    trials: z.array(z.string()).optional().describe('Filter by trialDbIds.'),
    observationLevels: z
      .array(z.string())
      .optional()
      .describe('Observation unit level (plot, plant, field, etc.).'),
    timestampFrom: z.string().optional().describe('ISO 8601 start of the observation-time window.'),
    timestampTo: z.string().optional().describe('ISO 8601 end of the observation-time window.'),
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
      { service: 'observations', method: 'GET' },
      ctx,
      capabilityLookup,
    );

    const warnings: string[] = [];
    const filters = mergeFilters(
      {
        studyDbIds: input.studies,
        germplasmDbIds: input.germplasm,
        observationVariableDbIds: input.variables,
        observationUnitDbIds: input.observationUnits,
        observationDbIds: input.observations,
        seasonDbIds: input.seasons,
        programDbIds: input.programs,
        trialDbIds: input.trials,
        observationLevels: input.observationLevels,
        observationTimeStampRangeStart: input.timestampFrom,
        observationTimeStampRangeEnd: input.timestampTo,
      },
      input.extraFilters,
      warnings,
    );

    const loadLimit = input.loadLimit ?? config.loadLimit;
    const firstPage = await loadInitialPage<Record<string, unknown>>(
      client,
      connection,
      '/observations',
      filters,
      loadLimit,
      ctx,
    );

    const { fullRows, dataset: datasetMeta } = await maybeSpill({
      firstPage,
      client,
      connection,
      path: '/observations',
      filters,
      source: 'find_observations',
      loadLimit,
      ctx,
      store: datasetStore,
    });

    const distributions = {
      observationVariableName: computeDistribution(fullRows, (r) =>
        asString(r.observationVariableName),
      ),
      studyName: computeDistribution(fullRows, (r) => asString(r.studyName)),
      germplasmName: computeDistribution(fullRows, (r) => asString(r.germplasmName)),
      observationLevel: computeDistribution(fullRows, (r) => asString(r.observationLevel)),
      season: computeDistribution(fullRows, (r) => asString(r.season)),
    };

    const totalCount = firstPage.totalCount ?? firstPage.rows.length;
    const refinementHint = buildRefinementHint(totalCount, loadLimit, distributions);

    const result: Output = {
      alias: connection.alias,
      results: firstPage.rows as z.infer<typeof ObservationRowSchema>[],
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
    lines.push(
      `# ${result.returnedCount} of ${result.totalCount} observations — \`${result.alias}\``,
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
    lines.push(`Applied filters: \`${JSON.stringify(result.appliedFilters)}\``);
    lines.push('');
    lines.push('## Distributions');
    lines.push(renderDistributions(result.distributions) || '_No values to summarize._');
    lines.push('');
    lines.push('## Observations');
    if (result.results.length === 0) {
      lines.push('_No rows returned._');
    } else {
      for (const o of result.results) {
        const parts: string[] = [];
        const label = o.observationVariableName ?? o.observationVariableDbId ?? '?';
        parts.push(`**${label}**`);
        if (o.observationVariableDbId) parts.push(`varDbId=${o.observationVariableDbId}`);
        if (o.value !== undefined) parts.push(`= ${o.value}`);
        if (o.observationDbId) parts.push(`id=\`${o.observationDbId}\``);
        if (o.observationUnitName) parts.push(`unit=${o.observationUnitName}`);
        if (o.observationUnitDbId) parts.push(`unitDbId=${o.observationUnitDbId}`);
        if (o.germplasmName) parts.push(`germplasm=${o.germplasmName}`);
        if (o.germplasmDbId) parts.push(`germplasmDbId=${o.germplasmDbId}`);
        if (o.studyName) parts.push(`study=${o.studyName}`);
        if (o.studyDbId) parts.push(`studyDbId=${o.studyDbId}`);
        if (o.observationLevel) parts.push(`level=${o.observationLevel}`);
        if (o.season) parts.push(`season=${o.season}`);
        if (o.observationTimeStamp) parts.push(`time=${o.observationTimeStamp}`);
        if (o.collector) parts.push(`collector=${o.collector}`);
        if (o.uploadedBy) parts.push(`uploadedBy=${o.uploadedBy}`);
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
