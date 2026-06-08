/**
 * @fileoverview `brapi_find_observations` — pull observation records filtered
 * by study, germplasm, variable, season, or observation unit. Matches the
 * find_* pattern: paged single pull capped at loadLimit, distributions across
 * variable/study/germplasm/level, dataframe spillover when the upstream
 * total exceeds loadLimit.
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
import { type BrapiDialect, resolveDialect } from '@/services/brapi-dialect/index.js';
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
  ExtraFiltersInput,
  extractRows,
  type FindRoute,
  fkMatchCheck,
  type LoadedRows,
  LoadLimitInput,
  loadInitialFindPage,
  maybeSpill,
  mergeFilters,
  renderDataframeHandle,
  renderDistributions,
  renderFindHeader,
  requireRegisteredConnection,
  resolveFindRoute,
  truncationMeta,
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
          .object({})
          .passthrough()
          .describe(
            'Structured season block per BrAPI v2.1 — may carry seasonDbId, year, season, or seasonName. Fields vary by server; all pass through and are collapsed into a single label by format().',
          ),
        z.null().describe('Field present but null on the upstream.'),
      ])
      .optional()
      .describe(
        'Season — either a flat string or a structured object depending on the server. format() normalizes both into a single label.',
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
  dataframe: DataframeHandleSchema.optional().describe(
    'Dataframe handle when the full result set was materialized as a dataframe. Query it with brapi_dataframe_query (SQL).',
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
    'Pull observation records filtered by study, germplasm, variable, season, or observation unit. When the upstream total exceeds loadLimit, the full result set is materialized as a dataframe — query it with brapi_dataframe_query (SQL).',
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'unknown_alias',
      code: JsonRpcErrorCode.NotFound,
      when: 'No connection has been registered under the requested alias',
      recovery:
        'Run brapi_connect with this alias (or omit `alias` to use the default connection) before calling brapi_find_observations.',
    },
    {
      reason: 'all_filters_dropped',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The active dialect dropped every filter the agent supplied — the upstream server does not honor any of the requested scope filters on this endpoint, so the call would silently widen to the unfiltered baseline.',
      recovery:
        'Drop the unsupported filters and rescope by germplasm, variables, observationUnits, observations, seasons, programs, or trials — these filter paths are honored on the active dialect.',
    },
  ] as const,
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

    const adapted = applyDialectFiltersOrFail(ctx, dialect, 'observations', merged, warnings);
    const filters = adapted.filters;
    const route = resolveFindRoute({
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
     *   2. probe returns a count above the threshold → warn, return the
     *      1-row preflight as the only in-context observation
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
          `Preflight detected ${probe.totalCount} observations matching this query (no study / trial / observationUnit / observation anchor). Bulk pull skipped to avoid an upstream timeout. ${OBSERVATION_PREFLIGHT_RECOVERY} Returning the 1-row preflight as the only in-context observation.`,
        );
        firstPage = probe;
        bulkPullSkipped = true;
      }
    }
    firstPage ??= await loadObservations(loadLimit);

    const { fullRows, dataframe } = bulkPullSkipped
      ? { fullRows: firstPage.rows, dataframe: undefined }
      : await maybeSpill({
          firstPage,
          client,
          connection,
          path: '/observations',
          filters,
          route,
          source: 'find_observations',
          loadLimit,
          ctx,
          bridge,
          warnings,
          ...(normalizeRow ? { normalizeRow } : {}),
          spillRequestOptions: {
            timeoutMs: config.companionTimeoutMs,
            retryMaxAttempts: 0,
          },
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
          : 'No observations matched the applied filters. Try narrowing with studies, germplasm, variables, or observationUnits.',
      );

    const result: Output = {
      alias: connection.alias,
      results: firstPage.rows as z.infer<typeof ObservationRowSchema>[],
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
        noun: 'observations',
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
    lines.push(
      renderDistributions(result.distributions, truncationMeta(result.dataframe)) ||
        '_No values to summarize._',
    );
    lines.push('');
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
        parts.push(...collectPassthroughParts(o as Record<string, unknown>, RENDERED));
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
