/**
 * @fileoverview `brapi_find_studies` — locate studies matching crop / trial
 * type / season / location / program filters. Pulls an initial page and, if
 * the server reports more rows than loadLimit, materializes the union as a
 * dataframe and returns a handle. Companion response: per-field
 * distributions computed from the full row set plus a refinement hint.
 *
 * @module mcp-server/tools/definitions/brapi-find-studies.tool
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
  asStringArray,
  buildExtraFilterChecks,
  buildRefinementHint,
  checkFilterMatchRates,
  collectPassthroughParts,
  computeDistribution,
  DataframeHandleSchema,
  dialectRowMapper,
  ExtraFiltersInput,
  fkMatchCheck,
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
      .array(
        z
          .string()
          .nullable()
          .describe(
            'Season identifier — typically a year like "2022". Nullable: some Breedbase deployments emit a null entry when the study is missing a season.',
          ),
      )
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
  dataframe: DataframeHandleSchema.optional().describe(
    'Dataframe handle when the full result set was materialized as a dataframe. Query it with brapi_dataframe_query (SQL).',
  ),
});

type Output = z.infer<typeof OutputSchema>;

/** Server-side filter key → user-facing tool param name. Used in format() to
 * render the `Filters sent to server` block so the user can correlate what
 * they typed with what got sent upstream. Both plural (BrAPI v2.1 spec) and
 * singular forms are listed because dialect adapters may downcast to
 * singular before the call; the rendered map should still trace back to the
 * user's param. */
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
    'Locate studies matching crop, trial type, season, location, or program. Enriches results with program/trial/location context in one call. When the upstream total exceeds loadLimit, the full result set is materialized as a dataframe — query it with brapi_dataframe_query (SQL).',
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'unknown_alias',
      code: JsonRpcErrorCode.NotFound,
      when: 'No connection has been registered under the requested alias',
      recovery:
        'Run brapi_connect with this alias (or omit `alias` to use the default connection) before calling brapi_find_studies.',
    },
    {
      reason: 'all_filters_dropped',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The active dialect dropped every filter the agent supplied — the upstream server does not honor any of the requested scope filters on this endpoint, so the call would silently widen to the unfiltered baseline.',
      recovery:
        'Drop the unsupported filters and rescope by crop, trialTypes, seasons, programs, trials, studyNames, or active — these filter paths are honored on the active dialect.',
    },
  ] as const,
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
    warnings: z.array(z.string()).describe('Advisory messages (filter overrides, partial data).'),
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

    const adapted = applyDialectFiltersOrFail(ctx, dialect, 'studies', merged, warnings);
    const filters = adapted.filters;
    const route = resolveFindRoute({
      profile,
      dialect,
      endpoint: 'studies',
      filters,
      searchBody: merged,
      warnings,
      ...(adapted.requiresEscalation ? { requiresEscalation: true } : {}),
    });

    const loadLimit = input.loadLimit ?? config.loadLimit;
    const normalizeRow = dialectRowMapper<Record<string, unknown>>(dialect, 'studies');
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
      path: '/studies',
      filters,
      route,
      source: 'find_studies',
      loadLimit,
      ctx,
      bridge,
      ...(normalizeRow ? { normalizeRow } : {}),
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
      fkMatchCheck('locations', input.locations, fullRows, 'locationDbId'),
      fkMatchCheck('programs', input.programs, fullRows, 'programDbId'),
      fkMatchCheck('trials', input.trials, fullRows, 'trialDbId'),
      ...buildExtraFilterChecks(input.extraFilters, fullRows, warnings),
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
      spilled: dataframe !== undefined,
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
          : 'No rows matched the applied filters. Try broadening crop, seasons, programs, trials, studyNames, or active.',
      );

    const result: Output = {
      alias: connection.alias,
      results: firstPage.rows as z.infer<typeof StudyRowSchema>[],
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
        noun: 'studies',
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
    const rendered = renderDistributions(result.distributions);
    lines.push(rendered || '_No values to summarize._');
    lines.push('');
    lines.push('## Studies');
    if (result.results.length === 0) {
      lines.push('_No rows returned._');
    } else {
      const RENDERED = new Set([
        'studyName',
        'studyDbId',
        'studyType',
        'programName',
        'programDbId',
        'trialName',
        'trialDbId',
        'locationName',
        'locationDbId',
        'seasons',
        'commonCropName',
        'active',
        'startDate',
        'endDate',
        'studyCode',
        'studyPUI',
        'studyDescription',
      ]);
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
        const cleanSeasons = asStringArray(study.seasons);
        if (cleanSeasons?.length) parts.push(`seasons=${cleanSeasons.join(',')}`);
        if (study.commonCropName) parts.push(`crop=${study.commonCropName}`);
        if (study.active != null) parts.push(`active=${study.active}`);
        if (study.startDate) parts.push(`start=${study.startDate}`);
        if (study.endDate) parts.push(`end=${study.endDate}`);
        if (study.studyCode) parts.push(`code=${study.studyCode}`);
        if (study.studyPUI) parts.push(`pui=${study.studyPUI}`);
        if (study.studyDescription) parts.push(`desc=${study.studyDescription}`);
        parts.push(...collectPassthroughParts(study as Record<string, unknown>, RENDERED));
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
