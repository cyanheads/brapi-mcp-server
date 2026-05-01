/**
 * @fileoverview `brapi_find_studies` — locate studies matching crop / trial
 * type / season / location / program filters. Pulls an initial page and, if
 * the server reports more rows than loadLimit, spills the union into
 * DatasetStore and returns a handle. Companion response: per-field
 * distributions computed from the full row set plus a refinement hint.
 *
 * @module mcp-server/tools/definitions/brapi-find-studies.tool
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
  asStringArray,
  buildRefinementHint,
  checkFilterMatchRates,
  computeDistribution,
  DatasetHandleSchema,
  ExtraFiltersInput,
  LoadLimitInput,
  loadInitialPage,
  maybeSpill,
  mergeFilters,
  renderAppliedFilters,
  renderDatasetHandle,
  renderDistributions,
  renderFindHeader,
} from '../shared/find-helpers.js';

const StudyRowSchema = z
  .object({
    studyDbId: z.string().describe('Server-side identifier for the study.'),
    studyName: z.string().nullish().describe('Display name.'),
    studyType: z.string().nullish().describe('E.g. "Yield Trial", "Phenotyping".'),
    studyDescription: z.string().nullish().describe('Free-form description.'),
    programDbId: z.string().nullish().describe('FK to program; resolve via `brapi_get_study`.'),
    programName: z.string().nullish().describe('Display name of the owning program.'),
    trialDbId: z.string().nullish().describe('FK to trial; resolve via `brapi_get_study`.'),
    trialName: z.string().nullish().describe('Display name of the owning trial.'),
    locationDbId: z.string().nullish().describe('FK to location; resolve via `brapi_get_study`.'),
    locationName: z.string().nullish().describe('Display name of the study site.'),
    commonCropName: z.string().nullish().describe('Common crop name (e.g. "Maize", "Wheat").'),
    seasons: z
      .array(z.string().describe('Season identifier — typically a year like "2022".'))
      .nullish()
      .describe('Season identifiers this study spans.'),
    active: z.boolean().nullish().describe('True while the study is open for data capture.'),
    startDate: z.string().nullish().describe('ISO 8601 start date.'),
    endDate: z.string().nullish().describe('ISO 8601 end date.'),
    studyCode: z.string().nullish().describe('Short code or alias for the study.'),
    studyPUI: z.string().nullish().describe('Persistent unique identifier (URI).'),
  })
  .passthrough()
  .describe('One BrAPI study record.');

const OutputSchema = z.object({
  alias: z.string().describe('Alias of the registered BrAPI connection the call used.'),
  results: z.array(StudyRowSchema).describe('Rows returned in-context (up to loadLimit).'),
  returnedCount: z.number().int().nonnegative().describe('Length of results[].'),
  totalCount: z.number().int().nonnegative().describe('Total rows reported by the server.'),
  hasMore: z.boolean().describe('True when more rows exist beyond the returned set.'),
  distributions: z
    .object({
      programName: z
        .record(z.string(), z.number())
        .describe('Program name → count of rows with that program.'),
      studyType: z
        .record(z.string(), z.number())
        .describe('Study type → count of rows with that type.'),
      seasons: z
        .record(z.string(), z.number())
        .describe('Season identifier → count of rows in that season.'),
      locationName: z
        .record(z.string(), z.number())
        .describe('Location name → count of rows at that site.'),
      commonCropName: z
        .record(z.string(), z.number())
        .describe('Common crop name → count of rows for that crop.'),
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
    .describe('Advisory messages (filter overrides, partial data, etc.).'),
  appliedFilters: z
    .record(z.string(), z.unknown())
    .describe('The final filter map sent to the server (named + extraFilters).'),
});

type Output = z.infer<typeof OutputSchema>;

/** Server-side filter key → user-facing tool param name. Used in format() to
 * render `Applied filters` so the user can correlate what they typed with
 * what got sent upstream. Both plural (BrAPI v2.1 spec) and singular forms
 * are listed because dialect adapters may downcast to singular before the
 * call; the rendered map should still trace back to the user's param. */
const SERVER_TO_USER: Record<string, string> = {
  // Plurals — BrAPI v2.1 spec, used by the `spec` dialect.
  commonCropNames: 'crop',
  studyTypes: 'trialTypes',
  seasonDbIds: 'seasons',
  locationDbIds: 'locations',
  programDbIds: 'programs',
  trialDbIds: 'trials',
  studyNames: 'studyNames',
  // Singulars — emitted by SGN-family dialects (cassavabase, etc.).
  commonCropName: 'crop',
  studyType: 'trialTypes',
  seasonDbId: 'seasons',
  locationDbId: 'locations',
  programDbId: 'programs',
  trialDbId: 'trials',
  studyName: 'studyNames',
  // Scalars — same on the wire either way.
  active: 'active',
};

export const brapiFindStudies = tool('brapi_find_studies', {
  description:
    'Locate studies matching crop, trial type, season, location, or program. Results are enriched with program/trial/location context in one call. Returns a dataset handle when the upstream total exceeds loadLimit.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    alias: AliasInput,
    crop: z.string().optional().describe('Filter by common crop name (single value).'),
    trialTypes: z.array(z.string()).optional().describe('Filter by study types.'),
    seasons: z.array(z.string()).optional().describe('Filter by seasons (e.g. "2022").'),
    locations: z
      .array(z.string())
      .optional()
      .describe('Filter by locationDbIds (server-side identifiers, not display names).'),
    programs: z.array(z.string()).optional().describe('Filter by programDbIds.'),
    trials: z.array(z.string()).optional().describe('Filter by trialDbIds.'),
    studyNames: z.array(z.string()).optional().describe('Filter by study display name.'),
    active: z.boolean().optional().describe('Restrict to active / inactive studies.'),
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
      { service: 'studies', method: 'GET' },
      ctx,
      capabilityLookup,
    );

    const dialect = await resolveDialect(connection, ctx, capabilityLookup);

    const warnings: string[] = [];
    const merged = mergeFilters(
      {
        commonCropNames: input.crop !== undefined ? [input.crop] : undefined,
        studyTypes: input.trialTypes,
        seasonDbIds: input.seasons,
        locationDbIds: input.locations,
        programDbIds: input.programs,
        trialDbIds: input.trials,
        studyNames: input.studyNames,
        active: input.active,
      },
      input.extraFilters,
      warnings,
    );

    const filters = applyDialectFilters(dialect, 'studies', merged, warnings);

    const loadLimit = input.loadLimit ?? config.loadLimit;
    const firstPage = await loadInitialPage<Record<string, unknown>>(
      client,
      connection,
      '/studies',
      filters,
      loadLimit,
      ctx,
    );

    const { fullRows, dataset: datasetMeta } = await maybeSpill({
      firstPage,
      client,
      connection,
      path: '/studies',
      filters,
      source: 'find_studies',
      loadLimit,
      ctx,
      store: datasetStore,
    });

    const distributions = {
      programName: computeDistribution(fullRows, (r) => asString(r.programName)),
      studyType: computeDistribution(fullRows, (r) => asString(r.studyType)),
      seasons: computeDistribution(fullRows, (r) => asStringArray(r.seasons)),
      locationName: computeDistribution(fullRows, (r) => asString(r.locationName)),
      commonCropName: computeDistribution(fullRows, (r) => asString(r.commonCropName)),
    };

    checkFilterMatchRates(warnings, fullRows.length, [
      { paramName: 'seasons', requestedValues: input.seasons, distribution: distributions.seasons },
      {
        paramName: 'trialTypes',
        requestedValues: input.trialTypes,
        distribution: distributions.studyType,
        caseInsensitive: true,
      },
      {
        paramName: 'crop',
        requestedValues: input.crop !== undefined ? [input.crop] : undefined,
        distribution: distributions.commonCropName,
        caseInsensitive: true,
      },
    ]);

    const totalCount = firstPage.totalCount ?? firstPage.rows.length;
    const refinementHint = buildRefinementHint(totalCount, loadLimit, distributions, {
      availableFilters: [
        'crop',
        'trialTypes',
        'seasons',
        'locations',
        'programs',
        'trials',
        'studyNames',
        'active',
      ],
    });

    ctx.log.info('find_studies completed', {
      baseUrl: connection.baseUrl,
      totalCount,
      returnedCount: firstPage.rows.length,
      spilled: datasetMeta !== undefined,
    });

    const result: Output = {
      alias: connection.alias,
      results: firstPage.rows as z.infer<typeof StudyRowSchema>[],
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
        noun: 'studies',
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
    const rendered = renderDistributions(result.distributions);
    lines.push(rendered || '_No values to summarize._');
    lines.push('');
    lines.push('## Studies');
    if (result.results.length === 0) {
      lines.push('_No rows returned._');
    } else {
      for (const study of result.results) {
        const parts: string[] = [`**${study.studyName ?? study.studyDbId}**`];
        parts.push(`id=\`${study.studyDbId}\``);
        if (study.studyType) parts.push(`type=${study.studyType}`);
        if (study.programName) parts.push(`program=${study.programName}`);
        if (study.programDbId) parts.push(`programDbId=${study.programDbId}`);
        if (study.trialName) parts.push(`trial=${study.trialName}`);
        if (study.trialDbId) parts.push(`trialDbId=${study.trialDbId}`);
        if (study.locationName) parts.push(`location=${study.locationName}`);
        if (study.locationDbId) parts.push(`locationDbId=${study.locationDbId}`);
        if (study.seasons?.length) parts.push(`seasons=${study.seasons.join(',')}`);
        if (study.commonCropName) parts.push(`crop=${study.commonCropName}`);
        if (study.active != null) parts.push(`active=${study.active}`);
        if (study.startDate) parts.push(`start=${study.startDate}`);
        if (study.endDate) parts.push(`end=${study.endDate}`);
        if (study.studyCode) parts.push(`code=${study.studyCode}`);
        if (study.studyPUI) parts.push(`pui=${study.studyPUI}`);
        if (study.studyDescription) parts.push(`desc=${study.studyDescription}`);
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
