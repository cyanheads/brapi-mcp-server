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
  computeDistribution,
  DatasetHandleSchema,
  ExtraFiltersInput,
  fkMatchCheck,
  LoadLimitInput,
  loadInitialPage,
  maybeSpill,
  mergeFilters,
  renderAppliedFilters,
  renderDatasetHandle,
  renderDistributions,
  renderFindHeader,
} from '../shared/find-helpers.js';

const ObservationRowSchema = z
  .object({
    observationDbId: z.string().nullish().describe('Server-side identifier for the observation.'),
    observationUnitDbId: z
      .string()
      .nullish()
      .describe('FK to the observation unit (plot / plant / sample) that carries the measurement.'),
    observationUnitName: z.string().nullish().describe('Display name of the observation unit.'),
    observationVariableDbId: z
      .string()
      .nullish()
      .describe('FK to the observation variable (trait) measured.'),
    observationVariableName: z
      .string()
      .nullish()
      .describe('Display name of the observation variable.'),
    studyDbId: z.string().nullish().describe('FK to the study the observation belongs to.'),
    studyName: z.string().nullish().describe('Display name of the study.'),
    germplasmDbId: z
      .string()
      .nullish()
      .describe('FK to the germplasm the observation was taken on.'),
    germplasmName: z.string().nullish().describe('Display name of the germplasm.'),
    observationLevel: z.string().nullish().describe('Unit level — e.g. "plot", "plant", "field".'),
    season: z
      .union([
        z.string().describe('Season identifier as a flat string (older BrAPI servers).'),
        z
          .object({
            seasonDbId: z.string().nullish().describe('Server-side season identifier.'),
            year: z
              .union([
                z.string().describe('Calendar year as a string (e.g. "2024").'),
                z.number().describe('Calendar year as an integer (e.g. 2024).'),
              ])
              .nullish()
              .describe('Calendar year — accepts string or numeric form depending on server.'),
            season: z.string().nullish().describe('Season label (e.g. "wet", "dry", "Q1").'),
            seasonName: z
              .string()
              .nullish()
              .describe('Season display name (BrAPI v2.1 alternate field).'),
          })
          .passthrough()
          .describe('Structured season block per BrAPI v2.1.'),
      ])
      .nullish()
      .describe(
        'Season — either a flat string or a structured `{seasonDbId, year, season}` object depending on the server.',
      ),
    value: z
      .string()
      .nullish()
      .describe('Recorded measurement value (stringified per BrAPI spec).'),
    observationTimeStamp: z.string().nullish().describe('ISO 8601 timestamp of the observation.'),
    collector: z.string().nullish().describe('Name or ID of the person who collected the value.'),
    uploadedBy: z.string().nullish().describe('Name or ID of the user who uploaded the record.'),
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

const SERVER_TO_USER: Record<string, string> = {
  // Plurals — BrAPI v2.1 spec, used by the `spec` dialect.
  studyDbIds: 'studies',
  germplasmDbIds: 'germplasm',
  observationVariableDbIds: 'variables',
  observationUnitDbIds: 'observationUnits',
  observationDbIds: 'observations',
  seasonDbIds: 'seasons',
  programDbIds: 'programs',
  trialDbIds: 'trials',
  observationLevels: 'observationLevels',
  // Singulars — emitted by SGN-family dialects (cassavabase, etc.).
  studyDbId: 'studies',
  germplasmDbId: 'germplasm',
  observationVariableDbId: 'variables',
  observationUnitDbId: 'observationUnits',
  observationDbId: 'observations',
  seasonDbId: 'seasons',
  programDbId: 'programs',
  trialDbId: 'trials',
  observationLevel: 'observationLevels',
  // Range scalars — same on the wire either way.
  observationTimeStampRangeStart: 'timestampFrom',
  observationTimeStampRangeEnd: 'timestampTo',
};

export const brapiFindObservations = tool('brapi_find_observations', {
  description:
    'Pull observation records filtered by study, germplasm, variable, season, or observation unit. Returns a dataset handle when the upstream total exceeds loadLimit.',
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

    const dialect = await resolveDialect(connection, ctx, capabilityLookup);

    const warnings: string[] = [];
    const merged = mergeFilters(
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

    const filters = applyDialectFilters(dialect, 'observations', merged, warnings);

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
      season: computeDistribution(fullRows, (r) => normalizeSeason(r.season)),
    };

    checkFilterMatchRates(warnings, fullRows.length, [
      { paramName: 'seasons', requestedValues: input.seasons, distribution: distributions.season },
      {
        paramName: 'observationLevels',
        requestedValues: input.observationLevels,
        distribution: distributions.observationLevel,
        caseInsensitive: true,
      },
      fkMatchCheck('studies', input.studies, fullRows, 'studyDbId'),
      fkMatchCheck('germplasm', input.germplasm, fullRows, 'germplasmDbId'),
      fkMatchCheck('variables', input.variables, fullRows, 'observationVariableDbId'),
      fkMatchCheck('observationUnits', input.observationUnits, fullRows, 'observationUnitDbId'),
    ]);

    const totalCount = firstPage.totalCount ?? firstPage.rows.length;
    const refinementHint = buildRefinementHint(totalCount, loadLimit, distributions, {
      availableFilters: [
        'studies',
        'germplasm',
        'variables',
        'observationUnits',
        'observations',
        'seasons',
        'programs',
        'trials',
        'observationLevels',
        'timestampFrom',
        'timestampTo',
      ],
    });

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
      renderFindHeader({
        noun: 'observations',
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
        const seasonLabel = normalizeSeason(o.season);
        if (seasonLabel) parts.push(`season=${seasonLabel}`);
        if (o.observationTimeStamp) parts.push(`time=${o.observationTimeStamp}`);
        if (o.collector) parts.push(`collector=${o.collector}`);
        if (o.uploadedBy) parts.push(`uploadedBy=${o.uploadedBy}`);
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

function normalizeSeason(value: unknown): string | undefined {
  const nonEmpty = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;

  if (typeof value === 'string') return nonEmpty(value);
  if (!value || typeof value !== 'object') return;

  const record = value as {
    seasonDbId?: unknown;
    season?: unknown;
    seasonName?: unknown;
    year?: unknown;
  };

  const id = nonEmpty(record.seasonDbId);
  if (id) return id;

  const label = nonEmpty(record.season) ?? nonEmpty(record.seasonName);
  const year =
    nonEmpty(record.year) ?? (typeof record.year === 'number' ? String(record.year) : undefined);

  if (label) return year ? `${label} ${year}` : label;
  return year;
}
