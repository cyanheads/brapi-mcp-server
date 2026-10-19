/**
 * @fileoverview `brapi_find_observations` — pull observation records filtered
 * by study, germplasm, variable, season, or observation unit. Matches the
 * find_* pattern: paged single pull capped at loadLimit, distributions across
 * variable/study/germplasm/level, dataframe spillover when loadLimit or the
 * inline byte budget cuts results[] short of the matched rows.
 *
 * @module mcp-server/tools/definitions/brapi-find-observations.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';
import {
  type BrapiClient,
  getBrapiClient,
  isDialectAllDropped,
} from '@/services/brapi-client/index.js';
import {
  type BrapiDialect,
  prefersEmbeddedObservations,
  resolveDialect,
} from '@/services/brapi-dialect/index.js';
import { getCanvasBridge } from '@/services/canvas-bridge/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import type { RegisteredServer } from '@/services/server-registry/index.js';
import {
  AliasInput,
  applyDialectFiltersOrFail,
  asString,
  type BrapiListResult,
  buildExtraFilterChecks,
  buildRefinementHint,
  checkFilterMatchRates,
  collectPassthroughParts,
  companionRequestOptions,
  computeDistribution,
  DataframeHandleSchema,
  dialectRowMapper,
  discloseInlineTrim,
  ExtraFiltersInput,
  extractRows,
  type FindRoute,
  fkMatchCheck,
  InlineTrimEnrichment,
  type LoadedRows,
  LoadLimitInput,
  loadInitialFindPage,
  MAX_SPILLOVER_PAGES,
  MAX_SPILLOVER_ROWS,
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
import { collectEmbeddedObservations, type RawObservationRow } from '../shared/observations.js';

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
          .object({})
          .passthrough()
          .describe(
            'BrAPI v2.1 season object — seasonDbId, year, season, or seasonName; fields vary by server.',
          ),
        z.null().describe('Field present but null on the upstream.'),
      ])
      .optional()
      .describe('Season as a flat string or a structured object, depending on the server.'),
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
  alias: z.string().describe('Connection alias the call used.'),
  results: z
    .array(ObservationRowSchema)
    .describe(
      'Leading matched observation rows, up to loadLimit and a 24,000-byte budget, whichever binds first.',
    ),
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
    .describe('Value frequency per field across every matched row fetched.'),
  dataframe: DataframeHandleSchema.optional().describe(
    'The matched rows, staged as a dataframe when results[] holds fewer.',
  ),
});

type Output = z.infer<typeof OutputSchema>;

/**
 * Upstream observation totals above this threshold trigger the preflight
 * bail-out: the bulk pull is skipped and the user is told to narrow the
 * query. Empirically, CassavaBase unanchored observation queries above
 * ~5k rows stall past the default request timeout.
 */
const PREFLIGHT_BULK_THRESHOLD = 5_000;

const OBSERVATION_PREFLIGHT_RECOVERY =
  "Narrow with `studies: ['…']`, `trials: ['…']`, or scope to specific `observationUnits` / `observations`. On SGN/Breedbase servers, a practical path is: first find studies containing the germplasm, then call this tool again with both `studies: ['<studyDbId>']` and `germplasm: ['<germplasmDbId>']`.";

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
    'Pull observation records filtered by study, germplasm, variable, season, or observation unit. Without a studies, trials, observationUnits, or observations anchor, a GET query first runs a one-row count probe and skips the bulk pull (warnings says so) when the probe fails or reports more than 5,000 matches. results[] holds the leading matches up to loadLimit and a 24,000-byte budget; when those bounds cut it short, the matched set is materialized as a dataframe — read it with brapi_dataframe_describe and brapi_dataframe_query (SQL).',
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'upstream_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'An uncaught BrAPI data request answered HTTP 404',
      recovery:
        'Check brapi_server_info for supported endpoints and verify the requested identifiers before retrying brapi_find_observations.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'An uncaught BrAPI data request exhausted retries after HTTP 429',
      recovery:
        'Wait before retrying brapi_find_observations; reduce concurrent requests to this BrAPI server.',
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
        'Run brapi_connect with this alias and a `baseUrl`, or pass an alias the brapi_connect description lists as built-in or operator-configured, before calling brapi_find_observations.',
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
        'The BrAPI server is slow or unreachable right now. Retry brapi_find_observations in a minute; if it keeps failing, the server may be down.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unauthorized',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'The BrAPI server answered HTTP 401: it requires credentials, or rejected the ones sent',
      recovery:
        'Run brapi_connect with credentials in `auth`, or ask the operator to set server-side credentials for this alias, then retry brapi_find_observations.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The BrAPI server answered HTTP 403: the credentials sent, or their absence, lack access',
      recovery:
        'Run brapi_connect with credentials that have access, or ask the operator to set server-side credentials for this alias that do, then retry brapi_find_observations.',
      thrownBy: 'service',
    },
    {
      reason: 'alias_base_url_invalid',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'The base URL configured on the server for this alias is not an absolute http(s) URL, or carries credentials',
      recovery:
        'Ask the operator to set the base URL configured for this alias to an absolute http(s) URL, then retry brapi_find_observations.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'private_address_blocked',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The base URL configured for this alias, or its token URL, is on a private or reserved address this server may not reach',
      recovery:
        'Ask the operator to point this alias at a publicly routable host, or to allow private addresses on this server, then retry brapi_find_observations.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'all_filters_dropped',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The active dialect dropped every filter the agent supplied — the upstream server does not honor any of the requested scope filters on this endpoint, so the call would silently widen to the unfiltered baseline.',
      recovery:
        'Drop the unsupported filters and rescope by germplasm, variables, observationUnits, observations, seasons, programs, or trials — these filter paths are honored on the active dialect.',
      thrownBy: 'service',
    },
  ] as const,
  input: z.object({
    alias: AliasInput,
    studies: z.array(NonBlankString).optional().describe('Filter by studyDbIds.'),
    germplasm: z.array(NonBlankString).optional().describe('Filter by germplasmDbIds.'),
    variables: z.array(NonBlankString).optional().describe('Filter by observationVariableDbIds.'),
    observationUnits: z
      .array(NonBlankString)
      .optional()
      .describe('Filter by observationUnitDbIds.'),
    observations: z.array(NonBlankString).optional().describe('Filter by observationDbIds.'),
    seasons: z.array(NonBlankString).optional().describe('Filter by seasonDbIds (e.g. "2022").'),
    programs: z.array(NonBlankString).optional().describe('Filter by programDbIds.'),
    trials: z.array(NonBlankString).optional().describe('Filter by trialDbIds.'),
    observationLevels: z
      .array(NonBlankString)
      .optional()
      .describe('Observation unit level (plot, plant, field, etc.).'),
    timestampFrom: NonBlankString.optional().describe(
      'ISO 8601 start of the observation-time window.',
    ),
    timestampTo: NonBlankString.optional().describe('ISO 8601 end of the observation-time window.'),
    loadLimit: LoadLimitInput,
    extraFilters: ExtraFiltersInput,
  }),
  inputAliases: {
    studyDbId: 'studies',
    studyDbIds: 'studies',
    germplasmDbId: 'germplasm',
    germplasmDbIds: 'germplasm',
    observationVariableDbId: 'variables',
    observationVariableDbIds: 'variables',
    observationUnitDbId: 'observationUnits',
    observationUnitDbIds: 'observationUnits',
    observationDbId: 'observations',
    observationDbIds: 'observations',
    seasonDbId: 'seasons',
    seasonDbIds: 'seasons',
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
        'Upstream observation total, or the matched observations collected on the embedded-unit route; warnings disclose incomplete scans.',
      ),
    returnedCount: z.number().int().nonnegative().describe('Length of results[].'),
    appliedFilters: z
      .record(z.string(), z.unknown())
      .describe(
        'Upstream filter map, or separate upstreamRequests and clientSide criteria for embedded-unit collection.',
      ),
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

    const embeddedRoute =
      prefersEmbeddedObservations(dialect, profile.supported) && (input.studies?.length ?? 0) > 0;
    const adapted = embeddedRoute
      ? { filters: merged, requiresEscalation: false }
      : applyDialectFiltersOrFail(ctx, dialect, 'observations', merged, warnings);
    const filters = adapted.filters;
    const route: FindRoute = embeddedRoute
      ? { kind: 'get', path: '/observationunits', service: 'observationunits', filters }
      : resolveFindRoute({
          profile,
          dialect,
          endpoint: 'observations',
          filters,
          searchBody: merged,
          warnings,
          ...(adapted.requiresEscalation ? { requiresEscalation: true } : {}),
        });

    const loadLimit = input.loadLimit ?? config.loadLimit;
    const normalizeRow = dialectRowMapper<Record<string, unknown>>(dialect, 'observations');
    const loadObservations = (pageSize: number) =>
      loadInitialFindPage<Record<string, unknown>>(
        client,
        connection,
        route,
        pageSize,
        ctx,
        normalizeRow ? { normalizeRow } : {},
      );

    /**
     * Danger pattern: querying `/observations` without one of the four
     * anchors (study, trial, observation-unit, observation). On large
     * servers (CassavaBase, T3) any unanchored variant —
     * `?germplasmDbId=X`, `?observationVariableDbId=X`, `?seasonDbId=X`,
     * or a bare `/observations` — joins across the full observations
     * table and stalls past the request timeout. Probe with `pageSize=1`
     * using companion-call options (short timeout, zero retries) so a
     * stalled count operation surfaces as a single warning instead of
     * pinning the response. Outcomes:
     *   1. probe stalls/fails → warn and skip the bulk pull entirely
     *   2. probe returns a count above the threshold → warn, return only
     *      the preflight page's rows (one, unless the upstream ignored pageSize)
     *   3. probe returns a count under the threshold → fall through to
     *      the normal bulk pull
     *
     * Empirically verified on cassavabase.org/brapi/v2:
     *   - `?germplasmDbId=X`              alone: timeout (>60 s)
     *   - `?observationVariableDbId=X`    alone: timeout (>60 s)
     *   - bare `/observations`                  : timeout (>30 s)
     *   - `?studyDbId=X` (anchored)             : ~15 s OK
     */
    const hasAnchor =
      (input.studies?.length ?? 0) > 0 ||
      (input.trials?.length ?? 0) > 0 ||
      (input.observationUnits?.length ?? 0) > 0 ||
      (input.observations?.length ?? 0) > 0;

    let firstPage: Awaited<ReturnType<typeof loadObservations>> | undefined;
    let bulkPullSkipped = false;
    let embeddedPartial = false;
    const embeddedRequests: Record<string, unknown>[] = [];
    if (embeddedRoute) {
      const rows: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      const effectiveStudies = merged.studyDbIds ?? merged.studyDbId ?? [];
      const studies = Array.isArray(effectiveStudies) ? effectiveStudies : [effectiveStudies];
      let pagesFetched = 0;
      for (const [index, study] of studies.entries()) {
        const pulled = await collectEmbeddedObservations({
          client,
          connection,
          config,
          ctx,
          dialect,
          filters: { ...merged, studyDbIds: [study] },
          loadLimit: MAX_SPILLOVER_ROWS - rows.length,
          pageLimit: MAX_SPILLOVER_PAGES - pagesFetched,
          warnings,
          keep: (row) => matchesEmbeddedObservation(row, merged),
        });
        embeddedRequests.push(pulled.appliedFilters);
        pagesFetched += pulled.pagesFetched;
        embeddedPartial ||= pulled.truncation !== undefined;
        for (const row of pulled.rawRows) {
          const id = row.observationDbId;
          if (typeof id === 'string' && id.length > 0) {
            if (seen.has(id)) continue;
            seen.add(id);
          }
          rows.push(normalizeRow ? normalizeRow(row) : row);
        }
        if (
          index < studies.length - 1 &&
          (rows.length >= MAX_SPILLOVER_ROWS || pagesFetched >= MAX_SPILLOVER_PAGES)
        ) {
          embeddedPartial = true;
          warnings.push(
            `Embedded observation collection reached its ${MAX_SPILLOVER_ROWS}-row or ${MAX_SPILLOVER_PAGES}-page budget; ${studies.length - index - 1} remaining studies were not processed.`,
          );
          break;
        }
      }
      firstPage = { rows, hasMore: false, pagesFetched: 1, totalCount: rows.length };
    }
    if (!hasAnchor && route.kind === 'get') {
      const probe = await probeObservationCount({
        client,
        connection,
        route,
        dialect,
        config,
        warnings,
        ctx,
      });
      if (probe === null) {
        warnings.push(
          `Observations preflight count probe stalled — the upstream count operation appears unbounded for this query shape, indicating a likely full-table scan. Bulk pull skipped to avoid a long hang. ${OBSERVATION_PREFLIGHT_RECOVERY}`,
        );
        firstPage = { rows: [], hasMore: false, pagesFetched: 0, totalCount: 0 };
        bulkPullSkipped = true;
      } else if (
        typeof probe.totalCount === 'number' &&
        probe.totalCount > PREFLIGHT_BULK_THRESHOLD
      ) {
        warnings.push(
          `Preflight detected ${probe.totalCount} observations matching this query (no study / trial / observationUnit / observation anchor). Bulk pull skipped to avoid an upstream timeout. ${OBSERVATION_PREFLIGHT_RECOVERY} Returning only the ${probe.rows.length} row(s) the preflight request returned.`,
        );
        firstPage = probe;
        bulkPullSkipped = true;
      }
    }
    firstPage ??= await loadObservations(loadLimit);

    const spill = await maybeSpill({
      /** A skipped bulk pull works from the preflight page alone — no walk; the upstream total keeps hasMore honest. */
      firstPage: bulkPullSkipped ? { ...firstPage, hasMore: false } : firstPage,
      client,
      connection,
      path: '/observations',
      filters,
      route,
      source: 'find_observations',
      renderInline: (rows, dataframe) =>
        renderObservationsRows({ results: rows as Output['results'], dataframe }),
      loadLimit,
      ctx,
      bridge,
      warnings,
      ...(embeddedPartial
        ? { preloadedStopReason: 'embedded observation scan stopped early (see warnings)' }
        : {}),
      ...(normalizeRow ? { normalizeRow } : {}),
      spillRequestOptions: {
        timeoutMs: config.companionTimeoutMs,
        retryMaxAttempts: 0,
      },
    });
    const { fullRows, dataframe, results, rowsScanned } = spill;
    const hasMore = spill.hasMore || embeddedPartial;

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
        requireEveryRowMatch: true,
      },
      fkMatchCheck('studies', input.studies, fullRows, 'studyDbId', {
        requireEveryRowMatch: true,
      }),
      fkMatchCheck('germplasm', input.germplasm, fullRows, 'germplasmDbId', {
        requireEveryRowMatch: true,
      }),
      fkMatchCheck('variables', input.variables, fullRows, 'observationVariableDbId', {
        requireEveryRowMatch: true,
      }),
      fkMatchCheck('observationUnits', input.observationUnits, fullRows, 'observationUnitDbId', {
        requireEveryRowMatch: true,
      }),
      ...buildExtraFilterChecks(input.extraFilters, fullRows, warnings),
    ]);

    const totalCount = firstPage.totalCount ?? rowsScanned;
    const refinementHint = buildRefinementHint(spill, distributions, {
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

    const appliedFilters = embeddedRoute
      ? { upstreamRequests: embeddedRequests, clientSide: merged }
      : route.kind === 'search'
        ? route.searchBody
        : filters;
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
          : 'No observations matched the applied filters. Try narrowing with studies, germplasm, variables, or observationUnits.',
      );
    discloseInlineTrim(ctx, spill, loadLimit);
    if (embeddedPartial)
      ctx.enrich.notice(
        'Embedded observation coverage is partial; inspect warnings and retry with fewer studies.',
      );

    const result: Output = {
      alias: connection.alias,
      results: results as z.infer<typeof ObservationRowSchema>[],
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
        noun: 'observations',
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
    lines.push(renderObservationsRows(result));
    if (result.dataframe) {
      lines.push('');
      lines.push('## Dataframe handle');
      lines.push(...renderDataframeHandle(result.dataframe));
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

/** Apply observation-level criteria after flattening units, including filters units cannot honor. */
function matchesEmbeddedObservation(
  row: RawObservationRow,
  filters: Record<string, unknown>,
): boolean {
  const fields: Record<string, string> = {
    studyDbIds: 'studyDbId',
    germplasmDbIds: 'germplasmDbId',
    observationVariableDbIds: 'observationVariableDbId',
    observationUnitDbIds: 'observationUnitDbId',
    observationDbIds: 'observationDbId',
    seasonDbIds: 'seasonDbId',
    programDbIds: 'programDbId',
    trialDbIds: 'trialDbId',
    observationLevels: 'observationLevel',
  };
  for (const [key, field] of Object.entries(fields)) {
    const requested = filters[key] ?? filters[field];
    if (requested === undefined || (Array.isArray(requested) && requested.length === 0)) continue;
    const values = Array.isArray(requested) ? requested : [requested];
    const actual =
      field === 'seasonDbId' ? (row.seasonDbId ?? normalizeSeason(row.season)) : row[field];
    if (
      !values.some((value) =>
        field === 'observationLevel'
          ? String(value).toLowerCase() === String(actual).toLowerCase()
          : String(value) === String(actual),
      )
    )
      return false;
  }
  const timestamp = row.observationTimeStamp;
  if (
    filters.observationTimeStampRangeStart !== undefined &&
    (typeof timestamp !== 'string' ||
      Date.parse(timestamp) < Date.parse(String(filters.observationTimeStampRangeStart)))
  )
    return false;
  if (
    filters.observationTimeStampRangeEnd !== undefined &&
    (typeof timestamp !== 'string' ||
      Date.parse(timestamp) > Date.parse(String(filters.observationTimeStampRangeEnd)))
  )
    return false;
  return true;
}

/**
 * Probe the upstream observation count without burning the global retry
 * budget. Uses companion-call options (short timeout, zero retries) so a
 * stalled count operation surfaces as a single warning instead of pinning
 * the response. Returns:
 *   - `LoadedRows` on success (1-row sample + totalCount when reported)
 *   - `null` when the probe fails (timeout, 5xx) — caller treats as
 *     "scope too large" and bails with a warning.
 *
 * Re-throws `dialect_all_filters_dropped` so the typed error contract
 * still surfaces; that's a programming/dialect mismatch, not a probe
 * failure.
 */
async function probeObservationCount(args: {
  client: BrapiClient;
  connection: RegisteredServer;
  route: Extract<FindRoute, { kind: 'get' }>;
  dialect: BrapiDialect;
  config: ServerConfig;
  warnings: string[];
  ctx: Context;
}): Promise<LoadedRows<Record<string, unknown>> | null> {
  const { client, connection, route, dialect, config, warnings, ctx } = args;
  try {
    const envelope = await client.get<
      BrapiListResult<Record<string, unknown>> | Record<string, unknown>[]
    >(
      connection.baseUrl,
      route.path,
      ctx,
      companionRequestOptions(connection, dialect, config, warnings, {
        ...(route.filters as Record<
          string,
          string | number | boolean | readonly (string | number)[] | undefined
        >),
        pageSize: 1,
      }),
    );
    const rows = extractRows<Record<string, unknown>>(envelope.result);
    const totalCount = envelope.metadata?.pagination?.totalCount;
    const hasMore = typeof totalCount === 'number' && totalCount > rows.length && totalCount > 0;
    const result: LoadedRows<Record<string, unknown>> = { rows, hasMore, pagesFetched: 1 };
    if (totalCount !== undefined) result.totalCount = totalCount;
    return result;
  } catch (err) {
    if (isDialectAllDropped(err)) throw err;
    return null;
  }
}

/** Render the exact row section used by both formatting and preview sizing. */
function renderObservationsRows(result: Pick<Output, 'results' | 'dataframe'>): string {
  const lines: string[] = [];
  lines.push('## Observations');
  if (result.results.length === 0) {
    lines.push('_No rows returned._');
  } else {
    const RENDERED = new Set([
      'observationVariableName',
      'observationVariableDbId',
      'value',
      'observationDbId',
      'observationUnitName',
      'observationUnitDbId',
      'germplasmName',
      'germplasmDbId',
      'studyName',
      'studyDbId',
      'observationLevel',
      'season',
      'observationTimeStamp',
      'collector',
      'uploadedBy',
    ]);
    for (const o of result.results) {
      const parts: string[] = [];
      const label = o.observationVariableName ?? o.observationVariableDbId ?? '?';
      parts.push(literal`**${label}**`);
      if (o.observationVariableDbId) parts.push(literal`varDbId=${o.observationVariableDbId}`);
      if (o.value !== undefined) parts.push(literal`= ${o.value}`);
      if (o.observationDbId) parts.push(literal`id=\`${o.observationDbId}\``);
      if (o.observationUnitName) parts.push(literal`unit=${o.observationUnitName}`);
      if (o.observationUnitDbId) parts.push(literal`unitDbId=${o.observationUnitDbId}`);
      if (o.germplasmName) parts.push(literal`germplasm=${o.germplasmName}`);
      if (o.germplasmDbId) parts.push(literal`germplasmDbId=${o.germplasmDbId}`);
      if (o.studyName) parts.push(literal`study=${o.studyName}`);
      if (o.studyDbId) parts.push(literal`studyDbId=${o.studyDbId}`);
      if (o.observationLevel) parts.push(literal`level=${o.observationLevel}`);
      const seasonLabel = normalizeSeason(o.season);
      if (seasonLabel) parts.push(literal`season=${seasonLabel}`);
      if (o.observationTimeStamp) parts.push(literal`time=${o.observationTimeStamp}`);
      if (o.collector) parts.push(literal`collector=${o.collector}`);
      if (o.uploadedBy) parts.push(literal`uploadedBy=${o.uploadedBy}`);
      parts.push(
        ...collectPassthroughParts(o as Record<string, unknown>, RENDERED, result.dataframe),
      );
      lines.push(`- ${parts.join(' · ')}`);
    }
  }
  return lines.join('\n');
}
