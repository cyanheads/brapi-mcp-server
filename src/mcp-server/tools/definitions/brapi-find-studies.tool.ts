/**
 * @fileoverview `brapi_find_studies` — locate studies matching crop / trial
 * type / season / location / program filters. Pulls an initial page and, when
 * results[] holds fewer rows than matched (more upstream pages, loadLimit, or
 * the inline byte budget), materializes the match as a dataframe and returns a
 * handle. Companion response: per-field
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
  discloseInlineTrim,
  ExtraFiltersInput,
  fkMatchCheck,
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
  alias: z.string().describe('Connection alias the call used.'),
  results: z
    .array(StudyRowSchema)
    .describe(
      'Leading matched rows, up to loadLimit and a 24,000-byte budget, whichever binds first.',
    ),
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
    .describe('Value frequency per field across every matched row fetched.'),
  dataframe: DataframeHandleSchema.optional().describe(
    'The matched rows, staged as a dataframe when results[] holds fewer.',
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
    'Locate studies matching crop, trial type, season, location, or program. Enriches results with program/trial/location context in one call. results[] holds the leading matches up to loadLimit and a 24,000-byte budget; when it holds fewer rows than matched, the matched set is materialized as a dataframe — read it with brapi_dataframe_describe and brapi_dataframe_query (SQL).',
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'upstream_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'An uncaught BrAPI data request answered HTTP 404',
      recovery:
        'Check brapi_server_info for supported endpoints and verify the requested identifiers before retrying brapi_find_studies.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'An uncaught BrAPI data request exhausted retries after HTTP 429',
      recovery:
        'Wait before retrying brapi_find_studies; reduce concurrent requests to this BrAPI server.',
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
        'Run brapi_connect with this alias and a `baseUrl`, or pass an alias the brapi_connect description lists as built-in or operator-configured, before calling brapi_find_studies.',
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
        'The BrAPI server is slow or unreachable right now. Retry brapi_find_studies in a minute; if it keeps failing, the server may be down.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unauthorized',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'The BrAPI server answered HTTP 401: it requires credentials, or rejected the ones sent',
      recovery:
        'Run brapi_connect with credentials in `auth`, or ask the operator to set server-side credentials for this alias, then retry brapi_find_studies.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The BrAPI server answered HTTP 403: the credentials sent, or their absence, lack access',
      recovery:
        'Run brapi_connect with credentials that have access, or ask the operator to set server-side credentials for this alias that do, then retry brapi_find_studies.',
      thrownBy: 'service',
    },
    {
      reason: 'alias_base_url_invalid',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'The base URL configured on the server for this alias is not an absolute http(s) URL, or carries credentials',
      recovery:
        'Ask the operator to set the base URL configured for this alias to an absolute http(s) URL, then retry brapi_find_studies.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'private_address_blocked',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The base URL configured for this alias, or its token URL, is on a private or reserved address this server may not reach',
      recovery:
        'Ask the operator to point this alias at a publicly routable host, or to allow private addresses on this server, then retry brapi_find_studies.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'all_filters_dropped',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The active dialect dropped every filter the agent supplied — the upstream server does not honor any of the requested scope filters on this endpoint, so the call would silently widen to the unfiltered baseline.',
      recovery:
        'Drop the unsupported filters and rescope by crop, trialTypes, seasons, locations, programs, trials, studyNames, or active — these filter paths are honored on the active dialect.',
      thrownBy: 'service',
    },
  ] as const,
  input: z.object({
    alias: AliasInput,
    crop: NonBlankString.optional().describe('Filter by common crop name (single value).'),
    trialTypes: z.array(NonBlankString).optional().describe('Filter by study types.'),
    seasons: z.array(NonBlankString).optional().describe('Filter by seasons (e.g. "2022").'),
    locations: z
      .array(NonBlankString)
      .optional()
      .describe(
        'Filter by locationDbIds (server-side identifiers, not display names). On servers that ignore this filter on /studies, it is applied client-side over the scanned studies, and a study with no locationDbId never matches.',
      ),
    programs: z.array(NonBlankString).optional().describe('Filter by programDbIds.'),
    trials: z.array(NonBlankString).optional().describe('Filter by trialDbIds.'),
    studyNames: z.array(NonBlankString).optional().describe('Filter by study display name.'),
    active: z.boolean().optional().describe('Restrict to active / inactive studies.'),
    loadLimit: LoadLimitInput,
    extraFilters: ExtraFiltersInput,
  }),
  inputAliases: {
    seasonDbId: 'seasons',
    seasonDbIds: 'seasons',
    locationDbId: 'locations',
    locationDbIds: 'locations',
    programDbId: 'programs',
    programDbIds: 'programs',
    trialDbId: 'trials',
    trialDbIds: 'trials',
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
      .describe(
        'Total rows reported by the server, else the rows scanned; with `locations` applied client-side, the matched rows fetched.',
      ),
    returnedCount: z.number().int().nonnegative().describe('Length of results[].'),
    appliedFilters: z
      .record(z.string(), z.unknown())
      .describe('Filter map sent upstream (named filters plus extraFilters).'),
    clientSideFilters: z
      .record(z.string(), z.array(z.string()))
      .optional()
      .describe(
        'Filters this server ignores on /studies, applied to the scanned rows instead of sent upstream, keyed by input name.',
      ),
    refinementHint: z
      .string()
      .optional()
      .describe('Suggested refinement when the result set is large.'),
    ...InlineTrimEnrichment,
    warnings: z.array(z.string()).describe('Advisory messages (filter overrides, partial data).'),
  },

  enrichmentTrailer: {
    refinementHint: { render: renderAdvisoryTrailer },
    appliedFilters: { render: renderAppliedFiltersTrailer(SERVER_TO_USER, 'none sent upstream') },
    // Enriched right after appliedFilters, so these bullets continue its list.
    clientSideFilters: {
      render: (filters) =>
        Object.entries(filters ?? {})
          .map(
            ([k, v]) =>
              literal`- **${k}:** ${v.join(', ')} _(applied client-side: this server ignores it, so it was not sent upstream)_`,
          )
          .join('\n'),
    },
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

    // A dialect whose server ignores `locationDbIds` on /studies would drop
    // it and widen the call to every location. Keep it off the wire and
    // match `row.locationDbId` client-side over the spill walk instead.
    const dialectDropsLocations =
      input.locations !== undefined &&
      input.locations.length > 0 &&
      dialect
        .adaptGetFilters('studies', { locationDbIds: input.locations })
        .dropped.includes('locationDbIds');
    const clientLocations = dialectDropsLocations ? new Set(input.locations) : undefined;
    const { locationDbIds: _clientSide, ...mergedWithoutLocations } = merged;
    const wireFilters = clientLocations ? mergedWithoutLocations : merged;

    const adapted = applyDialectFiltersOrFail(ctx, dialect, 'studies', wireFilters, warnings);
    const filters = adapted.filters;
    const route = resolveFindRoute({
      profile,
      dialect,
      endpoint: 'studies',
      filters,
      searchBody: wireFilters,
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

    const spill = await maybeSpill({
      firstPage,
      client,
      connection,
      path: '/studies',
      filters,
      route,
      source: 'find_studies',
      renderInline: (rows, dataframe) =>
        renderStudiesRows({ results: rows as Output['results'], dataframe }),
      loadLimit,
      ctx,
      bridge,
      warnings,
      ...(normalizeRow ? { normalizeRow } : {}),
      ...(clientLocations
        ? {
            rowFilter: (row: Record<string, unknown>) => {
              const id = asString(row.locationDbId);
              return id !== undefined && clientLocations.has(id);
            },
          }
        : {}),
    });
    const { fullRows, dataframe, rowsScanned, scanComplete, results, hasMore } = spill;

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
      fkMatchCheck(
        'locations',
        clientLocations ? undefined : input.locations,
        fullRows,
        'locationDbId',
      ),
      fkMatchCheck('programs', input.programs, fullRows, 'programDbId'),
      fkMatchCheck('trials', input.trials, fullRows, 'trialDbId'),
      ...buildExtraFilterChecks(input.extraFilters, fullRows, warnings),
    ]);

    const upstreamTotal = firstPage.totalCount ?? rowsScanned;
    // With the location filter applied here, counts describe the matched set
    // (as bbox does on brapi_find_locations); the upstream total goes in the warning.
    let totalCount = upstreamTotal;
    if (clientLocations) {
      totalCount = fullRows.length;
      const scannedOf = firstPage.totalCount === undefined ? '' : ` of ${firstPage.totalCount}`;
      warnings.push(
        scanComplete
          ? `Filter 'locations' applied client-side — this server ignores locationDbIds on /studies. ${fullRows.length} of ${rowsScanned} upstream studies matched; a study with no locationDbId never matches.`
          : `Filter 'locations' applied client-side — this server ignores locationDbIds on /studies. ${fullRows.length} matched among the first ${rowsScanned}${scannedOf} upstream studies; the rest were not checked. Narrow with crop, seasons, programs, or trials to bring the set into one scan.`,
      );
    }
    const refinementHint = buildRefinementHint(spill, distributions, {
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
      returnedCount: results.length,
      spilled: dataframe !== undefined,
    });

    const appliedFilters = route.kind === 'search' ? route.searchBody : filters;
    ctx.enrich({
      totalCount,
      returnedCount: results.length,
      appliedFilters,
      ...(clientLocations ? { clientSideFilters: { locations: [...clientLocations] } } : {}),
      warnings,
      ...(refinementHint ? { refinementHint } : {}),
    });
    if (results.length === 0)
      ctx.enrich.notice(
        warnings.length > 0
          ? 'No rows returned. Check the warnings above for filter issues, or broaden your filters.'
          : 'No rows matched the applied filters. Try broadening crop, seasons, programs, trials, studyNames, or active.',
      );
    discloseInlineTrim(ctx, spill, loadLimit);

    const result: Output = {
      alias: connection.alias,
      results: results as z.infer<typeof StudyRowSchema>[],
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
        noun: 'studies',
        alias: result.alias,
        returnedCount: result.results.length,
        dataframe: result.dataframe,
      }),
    );
    lines.push('');
    const moreRows = renderMoreRowsLine(result);
    if (moreRows) lines.push(moreRows, '');
    lines.push('## Distributions');
    const rendered = renderDistributions(result.distributions, result.dataframe);
    lines.push(rendered || '_No values to summarize._');
    lines.push('');
    lines.push(renderStudiesRows(result));
    if (result.dataframe) {
      lines.push('');
      lines.push('## Dataframe handle');
      lines.push(...renderDataframeHandle(result.dataframe));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/** Render the exact row section used by both formatting and preview sizing. */
function renderStudiesRows(result: Pick<Output, 'results' | 'dataframe'>): string {
  const lines: string[] = [];
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
      const parts: string[] = [literal`**${study.studyName ?? study.studyDbId}**`];
      parts.push(literal`id=\`${study.studyDbId}\``);
      if (study.studyType) parts.push(literal`type=${study.studyType}`);
      if (study.programName) parts.push(literal`program=${study.programName}`);
      if (study.programDbId) parts.push(literal`programDbId=${study.programDbId}`);
      if (study.trialName) parts.push(literal`trial=${study.trialName}`);
      if (study.trialDbId) parts.push(literal`trialDbId=${study.trialDbId}`);
      if (study.locationName) parts.push(literal`location=${study.locationName}`);
      if (study.locationDbId) parts.push(literal`locationDbId=${study.locationDbId}`);
      const cleanSeasons = asStringArray(study.seasons);
      if (cleanSeasons?.length) parts.push(literal`seasons=${cleanSeasons.join(',')}`);
      if (study.commonCropName) parts.push(literal`crop=${study.commonCropName}`);
      if (study.active != null) parts.push(`active=${study.active}`);
      if (study.startDate) parts.push(literal`start=${study.startDate}`);
      if (study.endDate) parts.push(literal`end=${study.endDate}`);
      if (study.studyCode) parts.push(literal`code=${study.studyCode}`);
      if (study.studyPUI) parts.push(literal`pui=${study.studyPUI}`);
      if (study.studyDescription) parts.push(literal`desc=${study.studyDescription}`);
      parts.push(
        ...collectPassthroughParts(study as Record<string, unknown>, RENDERED, result.dataframe),
      );
      lines.push(`- ${parts.join(' · ')}`);
    }
  }
  return lines.join('\n');
}
