/**
 * @fileoverview `brapi_germplasm_performance` — aggregate a single germplasm's
 * observations across the studies it appears in, returning per-variable summary
 * statistics (n, mean, median, sd, min, max) plus the contributing studies and
 * seasons. Answers the breeder's primary question — "how does line X perform
 * across the pool's history?" — in one call.
 *
 * SGN/Breedbase uses the advertised germplasm-scoped unit route with embedded
 * observations, avoiding ignored study discovery filters and retaining zeros.
 * Other servers discover studies with a filter-honor cross-check before using
 * the shared per-study pull. Explicit studies always bypass discovery.
 *
 * Returned rows are filtered to the iterated study and the target germplasm, so
 * the aggregate stays correct even on servers that ignore the studyDbId filter
 * on `/observations` (the BrAPI Community Test Server does) or over-return from
 * the germplasm-anchored fallback.
 *
 * @module mcp-server/tools/definitions/brapi-germplasm-performance.tool
 */

import type { Context, HandlerContext } from '@cyanheads/mcp-ts-core';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { type BrapiClient, getBrapiClient } from '@/services/brapi-client/index.js';
import {
  type BrapiDialect,
  prefersEmbeddedObservations,
  resolveDialect,
} from '@/services/brapi-dialect/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import type { RegisteredServer } from '@/services/server-registry/index.js';
import {
  AliasInput,
  asString,
  type BrapiListResult,
  buildRequestOptions,
  extractRows,
  isUpstreamNotFound,
  NonBlankString,
  requireRegisteredConnection,
} from '../shared/find-helpers.js';
import { code, literal, prose } from '../shared/markdown-literals.js';
import {
  collectEmbeddedObservations,
  describeError,
  type NormObs,
  normalizeObsRow,
  ObservationCoverageSchema,
  pullObservationsForStudies,
  renderObservationCoverage,
  type StudyObservationOutcome,
  studyCoverage,
} from '../shared/observations.js';

/** Upper bound on studies discovered per germplasm (guards the filter-ignored case). */
const STUDY_DISCOVERY_CAP = 200;
const STUDY_DISCOVERY_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

const PerVariableSchema = z
  .object({
    observationVariableDbId: z.string().describe('Observation variable identifier.'),
    observationVariableName: z.string().optional().describe('Display name of the variable.'),
    n: z
      .number()
      .int()
      .nonnegative()
      .describe('Number of observations of this variable for the germplasm.'),
    mean: z
      .number()
      .optional()
      .describe('Arithmetic mean of numeric values (omitted for non-numeric traits).'),
    median: z
      .number()
      .optional()
      .describe('Median of numeric values (omitted for non-numeric traits).'),
    sd: z
      .number()
      .optional()
      .describe(
        'Sample standard deviation (n−1) of numeric values; omitted when n < 2 or non-numeric.',
      ),
    min: z
      .string()
      .optional()
      .describe('Minimum value — numeric min when numeric, else lexical min.'),
    max: z
      .string()
      .optional()
      .describe('Maximum value — numeric max when numeric, else lexical max.'),
    studyCount: z
      .number()
      .int()
      .nonnegative()
      .describe('Number of distinct studies contributing observations of this variable.'),
    studyDbIds: z
      .array(z.string())
      .describe('Distinct studyDbIds contributing observations of this variable.'),
    seasons: z
      .array(z.string())
      .describe(
        'Distinct season labels across the observations (empty when the server carries no season).',
      ),
  })
  .describe(
    'Aggregated statistics for one observation variable across the studies the germplasm appears in.',
  );

const OutputSchema = z.object({
  alias: z.string().describe('Connection alias the call used.'),
  germplasmDbId: z.string().describe('The germplasm that was analyzed.'),
  germplasmName: z
    .string()
    .optional()
    .describe('Display name of the germplasm, when the server provides one.'),
  studyCount: z
    .number()
    .int()
    .nonnegative()
    .describe('Number of distinct studies that contributed any observation.'),
  studyDbIds: z.array(z.string()).describe('Distinct studyDbIds that contributed observations.'),
  coverage: ObservationCoverageSchema,
  perVariable: z
    .array(PerVariableSchema)
    .describe('Per-variable aggregates, sorted by observationVariableDbId.'),
  warnings: z
    .array(z.string())
    .describe(
      'Advisory messages (study-discovery limits, dropped filters, fallback paths, per-study failures, partial study scans).',
    ),
});

type Output = z.infer<typeof OutputSchema>;
type PerVariable = z.infer<typeof PerVariableSchema>;

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const brapiGermplasmPerformance = tool('brapi_germplasm_performance', {
  description:
    "Aggregate a single germplasm's observations across studies, returning per-variable statistics (n, mean, median, sd, min, max), contributing studies, seasons, and collection coverage. SGN/Breedbase uses advertised germplasm-scoped observation units with embedded measurements, including zeros. Other servers discover up to 200 studies before pulling per study. Pass studyDbIds to skip discovery and restrict collection to known studies. Per-study observation limits, page limits, failures, and incomplete scans appear in coverage and warnings. For the underlying matrix, use brapi_build_phenotype_matrix.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'upstream_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'An uncaught BrAPI data request answered HTTP 404',
      recovery:
        'Check brapi_server_info for supported endpoints and verify the requested identifiers before retrying brapi_germplasm_performance.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'An uncaught BrAPI data request exhausted retries after HTTP 429',
      recovery:
        'Wait before retrying brapi_germplasm_performance; reduce concurrent requests to this BrAPI server.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'unknown_alias',
      code: JsonRpcErrorCode.NotFound,
      when: 'No connection is registered under the requested alias, and the server has no base URL configured for it to connect on first use',
      recovery:
        'Run brapi_connect with this alias and a `baseUrl`, or pass an alias the brapi_connect description lists as built-in or operator-configured, before calling brapi_germplasm_performance.',
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
        'The BrAPI server is slow or unreachable right now. Retry brapi_germplasm_performance in a minute; if it keeps failing, the server may be down.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unauthorized',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'The BrAPI server answered HTTP 401: it requires credentials, or rejected the ones sent',
      recovery:
        'Run brapi_connect with credentials in `auth`, or ask the operator to set server-side credentials for this alias, then retry brapi_germplasm_performance.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The BrAPI server answered HTTP 403: the credentials sent, or their absence, lack access',
      recovery:
        'Run brapi_connect with credentials that have access, or ask the operator to set server-side credentials for this alias that do, then retry brapi_germplasm_performance.',
      thrownBy: 'service',
    },
    {
      reason: 'alias_base_url_invalid',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'The base URL configured on the server for this alias is not an absolute http(s) URL, or carries credentials',
      recovery:
        'Ask the operator to set the base URL configured for this alias to an absolute http(s) URL, then retry brapi_germplasm_performance.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'private_address_blocked',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The base URL configured for this alias, or its token URL, is on a private or reserved address this server may not reach',
      recovery:
        'Ask the operator to point this alias at a publicly routable host, or to allow private addresses on this server, then retry brapi_germplasm_performance.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'germplasm_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Upstream returned no germplasm record for the requested germplasmDbId',
      recovery:
        'Verify the germplasmDbId on the target server, or run brapi_find_germplasm to discover valid IDs.',
    },
  ] as const,
  input: z.object({
    alias: AliasInput,
    germplasmDbId: NonBlankString.describe('The germplasmDbId to summarize performance for.'),
    studyDbIds: z
      .array(NonBlankString)
      .optional()
      .describe(
        'Optional studyDbIds to restrict collection to known studies and skip automatic discovery. Omit to walk germplasm-scoped embedded units on SGN/Breedbase, or discover up to 200 studies on other servers. Find known study IDs with brapi_find_studies; some servers ignore its germplasm filter.',
      ),
    variables: z
      .array(NonBlankString)
      .optional()
      .describe(
        'Optional subset of observationVariableDbIds to aggregate. Omit to include every variable observed for the germplasm.',
      ),
  }),
  inputAliases: {
    studyDbId: 'studyDbIds',
    observationVariableDbId: 'variables',
    observationVariableDbIds: 'variables',
  },
  output: OutputSchema,

  async handler(input, ctx) {
    const client = getBrapiClient();
    const config = getServerConfig();
    const capabilities = getCapabilityRegistry();

    const connection = await requireRegisteredConnection(ctx, input.alias);
    const capabilityLookup: { auth?: typeof connection.resolvedAuth } = {};
    if (connection.resolvedAuth) capabilityLookup.auth = connection.resolvedAuth;
    await capabilities.ensure(
      connection.baseUrl,
      { service: 'germplasm', method: 'GET' },
      ctx,
      capabilityLookup,
    );

    // 1. Confirm the germplasm exists and capture its display name.
    const germplasmName = await fetchGermplasmName(client, connection, input.germplasmDbId, ctx);

    const profile = await capabilities.profile(connection.baseUrl, ctx, capabilityLookup);
    const dialect = await resolveDialect(connection, ctx, capabilityLookup);
    const loadLimit = config.loadLimit;
    const warnings: string[] = [];

    /** Explicit studies bypass discovery; SGN auto mode walks scoped units. */
    let studyDbIds: string[];
    let embeddedCoverage: z.infer<typeof ObservationCoverageSchema> | undefined;
    let discoveryLimited = false;
    const embeddedCollected: NormObs[] = [];
    if (input.studyDbIds && input.studyDbIds.length > 0) {
      studyDbIds = [...new Set(input.studyDbIds)];
    } else if (prefersEmbeddedObservations(dialect, profile.supported)) {
      const pulled = await collectEmbeddedObservations({
        client,
        connection,
        ctx,
        config,
        dialect,
        filters: { germplasmDbIds: [input.germplasmDbId] },
        warnings,
        loadLimit: Number.MAX_SAFE_INTEGER,
        perStudyLimit: loadLimit,
        keep: (row) => {
          const norm = normalizeObsRow(row);
          return (
            norm !== null &&
            norm.germplasmDbId === input.germplasmDbId &&
            (!input.variables?.length || input.variables.includes(norm.observationVariableDbId))
          );
        },
      });
      embeddedCollected.push(
        ...pulled.rawRows.map(normalizeObsRow).filter((row): row is NormObs => row !== null),
      );
      studyDbIds = pulled.studyDbIds;
      const counts = new Map<string, number>();
      for (const row of embeddedCollected)
        counts.set(row.studyDbId, (counts.get(row.studyDbId) ?? 0) + 1);
      embeddedCoverage = {
        partial: pulled.truncation !== undefined || pulled.cappedStudyDbIds.length > 0,
        studies: studyDbIds.map((studyDbId) => ({
          studyDbId,
          observationCount: counts.get(studyDbId) ?? 0,
          status:
            pulled.truncation || pulled.cappedStudyDbIds.includes(studyDbId)
              ? 'partial'
              : counts.has(studyDbId)
                ? 'contributed'
                : 'empty',
          ...(pulled.cappedStudyDbIds.includes(studyDbId)
            ? { reason: `reached per-study loadLimit (${loadLimit})` }
            : pulled.truncation
              ? { reason: pulled.truncation.reason }
              : {}),
        })),
        scan: {
          complete: pulled.truncation === undefined,
          scannedUnits: pulled.scanned,
          pagesFetched: pulled.pagesFetched,
          ...(pulled.totalCount !== undefined && { totalUnits: pulled.totalCount }),
          ...(pulled.truncation && { reason: pulled.truncation.reason }),
        },
      };
      if (pulled.cappedStudyDbIds.length)
        warnings.push(
          `${pulled.cappedStudyDbIds.length} studies reached the per-study observation limit (${loadLimit}); narrow variables or select explicit studies for further collection.`,
        );
    } else {
      const discovery = await discoverStudiesForGermplasm({
        client,
        connection,
        dialect,
        germplasmDbId: input.germplasmDbId,
        ctx,
        warnings,
      });
      studyDbIds = discovery.studyDbIds;
      if (studyDbIds.length === 0) {
        warnings.push(
          `No studies discovered for germplasm '${input.germplasmDbId}'. It may not be associated with any study on this server, or /studies does not support a germplasm filter — use brapi_build_phenotype_matrix with explicit studies instead.`,
        );
      } else if (studyDbIds.length >= STUDY_DISCOVERY_CAP) {
        discoveryLimited = true;
        warnings.push(
          `Study discovery capped at ${STUDY_DISCOVERY_CAP} studies — aggregates may be incomplete. Use brapi_find_studies with extraFilters.germplasmDbIds set to ['${input.germplasmDbId}'] only when this server honors that filter; inspect its warnings before trusting the study set. Pass known studyDbIds in smaller sets, or use brapi_build_phenotype_matrix on specific studies.`,
        );
      }
    }

    // 3. Pull observations per study, scoped to the germplasm, with bounded
    //    concurrency. The pull keeps only the iterated study's rows for the
    //    target germplasm (and variables), so the aggregate stays correct on
    //    servers that ignore the studyDbId filter or over-return. Per-study
    //    failures and partial scans warn and continue.
    const collected: NormObs[] = [...embeddedCollected];
    const outcomes: StudyObservationOutcome[] = embeddedCoverage
      ? []
      : await pullObservationsForStudies({
          studyDbIds,
          input: input.variables
            ? { germplasm: [input.germplasmDbId], variables: input.variables }
            : { germplasm: [input.germplasmDbId] },
          client,
          connection,
          profile: profile.supported,
          dialect,
          config,
          loadLimit,
          failFast: false,
          ctx,
        });
    const coverage = embeddedCoverage ?? studyCoverage(studyDbIds, outcomes);
    if (discoveryLimited) {
      coverage.partial = true;
      coverage.discoveryLimited = true;
    }
    const unprocessed = new Set(
      coverage.studies
        .filter((study) => study.status === 'unprocessed')
        .map((study) => study.studyDbId),
    );
    for (const outcome of outcomes) {
      if (unprocessed.has(outcome.studyDbId)) continue;
      warnings.push(...outcome.warnings);
      if (outcome.error !== undefined) {
        warnings.push(
          `Study '${outcome.studyDbId}': observation pull failed (${describeError(outcome.error)}).`,
        );
        continue;
      }
      if (outcome.observations === null) {
        warnings.push(
          `Study '${outcome.studyDbId}': no observation path (server exposes neither /observations nor /observationunits).`,
        );
        continue;
      }
      collected.push(...outcome.observations);
    }
    if (unprocessed.size > 0)
      warnings.push(
        `${unprocessed.size} studies were not processed before the call deadline; retry with an explicit smaller studyDbIds set.`,
      );

    // 4. Aggregate per variable.
    const perVariable = aggregatePerVariable(collected);
    const allStudyDbIds = [...new Set(collected.map((o) => o.studyDbId))].sort();

    const result: Output = {
      alias: connection.alias,
      germplasmDbId: input.germplasmDbId,
      studyCount: allStudyDbIds.length,
      studyDbIds: allStudyDbIds,
      coverage,
      perVariable,
      warnings,
    };
    if (germplasmName) result.germplasmName = germplasmName;
    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(
      literal`# Germplasm performance — ${result.germplasmName ?? result.germplasmDbId} — \`${result.alias}\``,
    );
    lines.push('');
    lines.push(
      literal`germplasmDbId: \`${result.germplasmDbId}\` · studies: ${result.studyCount} · variables: ${result.perVariable.length}`,
    );
    lines.push(literal`studyDbIds: ${result.studyDbIds.join(', ') || '—'}`);
    lines.push(...renderObservationCoverage(result.coverage));
    lines.push('');

    if (result.perVariable.length === 0) {
      lines.push('_No observations found for this germplasm across the discovered studies._');
    } else {
      lines.push('## Per-variable aggregates');
      for (const v of result.perVariable) {
        const stats: string[] = [`n=${v.n}`];
        if (v.mean !== undefined) stats.push(`mean=${fmtNum(v.mean)}`);
        if (v.median !== undefined) stats.push(`median=${fmtNum(v.median)}`);
        if (v.sd !== undefined) stats.push(`sd=${fmtNum(v.sd)}`);
        if (v.min !== undefined) stats.push(literal`min=${v.min}`);
        if (v.max !== undefined) stats.push(literal`max=${v.max}`);
        stats.push(`studies=${v.studyCount}`);
        if (v.studyDbIds.length > 0) stats.push(literal`studyDbIds=${v.studyDbIds.join(',')}`);
        if (v.seasons.length > 0) stats.push(literal`seasons=${v.seasons.join('/')}`);
        lines.push(
          `- **${prose(v.observationVariableName ?? v.observationVariableDbId)}** (${code(v.observationVariableDbId)}): ${stats.join(' · ')}`,
        );
      }
    }

    if (result.warnings.length > 0) {
      lines.push('');
      lines.push('## Warnings');
      for (const w of result.warnings) lines.push(literal`- ${w}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});

// ---------------------------------------------------------------------------
// Germplasm existence
// ---------------------------------------------------------------------------

async function fetchGermplasmName(
  client: BrapiClient,
  connection: RegisteredServer,
  germplasmDbId: string,
  ctx: HandlerContext<'germplasm_not_found'>,
): Promise<string | undefined> {
  const id = encodeURIComponent(germplasmDbId);
  let env: Awaited<ReturnType<typeof client.get<Record<string, unknown>>>>;
  try {
    env = await client.get<Record<string, unknown>>(
      connection.baseUrl,
      `/germplasm/${id}`,
      ctx,
      buildRequestOptions(connection, undefined, { singleton: true }),
    );
  } catch (err) {
    if (isUpstreamNotFound(err)) throw germplasmNotFound(ctx, connection, germplasmDbId);
    throw err;
  }
  const rec = env.result;
  if (!rec || typeof rec !== 'object' || !(rec as Record<string, unknown>).germplasmDbId) {
    throw germplasmNotFound(ctx, connection, germplasmDbId);
  }
  return asString((rec as Record<string, unknown>).germplasmName);
}

function germplasmNotFound(
  ctx: HandlerContext<'germplasm_not_found'>,
  connection: RegisteredServer,
  germplasmDbId: string,
): Error {
  return ctx.fail(
    'germplasm_not_found',
    `Germplasm '${germplasmDbId}' not found on ${connection.baseUrl}.`,
    { germplasmDbId, baseUrl: connection.baseUrl },
  );
}

// ---------------------------------------------------------------------------
// Study discovery
// ---------------------------------------------------------------------------

interface DiscoverStudiesArgs {
  client: BrapiClient;
  connection: RegisteredServer;
  ctx: Context;
  dialect: BrapiDialect;
  germplasmDbId: string;
  warnings: string[];
}

/**
 * Discover the studies a germplasm appears in via `/studies?germplasmDbIds=…`,
 * paging up to `STUDY_DISCOVERY_CAP`. Cross-checks the filtered total against an
 * unfiltered baseline: when equal (and > 0) the server ignored the germplasm
 * filter — the anchor set is over-broad, so it warns but still proceeds (each
 * study's observations are filtered to the germplasm). When the dialect drops
 * the filter outright, returns an empty set with a warning.
 */
async function discoverStudiesForGermplasm(
  args: DiscoverStudiesArgs,
): Promise<{ studyDbIds: string[] }> {
  const { client, connection, dialect, germplasmDbId, ctx, warnings } = args;
  const adapted = dialect.adaptGetFilters('studies', { germplasmDbIds: [germplasmDbId] });
  warnings.push(...adapted.warnings);
  if (Object.keys(adapted.filters).length === 0) {
    warnings.push(
      'Study discovery skipped: the active dialect dropped the germplasm filter for /studies (server does not honor it).',
    );
    return { studyDbIds: [] };
  }

  const studyDbIds: string[] = [];
  const seen = new Set<string>();
  let page = 0;
  let totalPages = 1;
  let filteredTotal: number | undefined;
  while (page < totalPages && studyDbIds.length < STUDY_DISCOVERY_CAP && !ctx.signal.aborted) {
    const env = await client.get<
      BrapiListResult<Record<string, unknown>> | Record<string, unknown>[]
    >(
      connection.baseUrl,
      '/studies',
      ctx,
      buildRequestOptions(connection, {
        ...(adapted.filters as Record<
          string,
          string | number | boolean | readonly (string | number)[] | undefined
        >),
        pageSize: STUDY_DISCOVERY_PAGE_SIZE,
        page,
      }),
    );
    const rows = extractRows<Record<string, unknown>>(env.result);
    for (const r of rows) {
      const sid = asString(r.studyDbId);
      if (sid && !seen.has(sid)) {
        seen.add(sid);
        studyDbIds.push(sid);
      }
      if (studyDbIds.length >= STUDY_DISCOVERY_CAP) break;
    }
    if (page === 0) {
      const tc = env.metadata?.pagination?.totalCount;
      if (typeof tc === 'number') filteredTotal = tc;
    }
    totalPages = env.metadata?.pagination?.totalPages ?? page + 1;
    page++;
    if (rows.length < STUDY_DISCOVERY_PAGE_SIZE) break;
  }

  // Dialect-honor cross-check against an unfiltered baseline.
  if (typeof filteredTotal === 'number') {
    const baseline = await fetchStudyTotal(client, connection, ctx).catch(() => undefined);
    if (typeof baseline === 'number' && baseline > 0 && filteredTotal === baseline) {
      warnings.push(
        `/studies returned the same total (${baseline}) for the germplasm-filtered probe and an unfiltered baseline — the server appears to ignore the germplasm filter on /studies. Proceeding with the ${studyDbIds.length} discovered studies (each study's observations are filtered to this germplasm), but coverage may be over-broad.`,
      );
    }
  }

  return { studyDbIds };
}

async function fetchStudyTotal(
  client: BrapiClient,
  connection: RegisteredServer,
  ctx: Context,
): Promise<number | undefined> {
  const env = await client.get<unknown>(
    connection.baseUrl,
    '/studies',
    ctx,
    buildRequestOptions(connection, { pageSize: 1 }),
  );
  const total = env.metadata?.pagination?.totalCount;
  return typeof total === 'number' ? total : undefined;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function aggregatePerVariable(obs: NormObs[]): PerVariable[] {
  const byVar = new Map<string, NormObs[]>();
  for (const o of obs) {
    const arr = byVar.get(o.observationVariableDbId);
    if (arr) arr.push(o);
    else byVar.set(o.observationVariableDbId, [o]);
  }

  const out: PerVariable[] = [];
  for (const [varId, rows] of byVar) {
    const values = rows.map((r) => r.value);
    const nums = values.map(Number).filter((n) => !Number.isNaN(n));
    const studyDbIds = [...new Set(rows.map((r) => r.studyDbId))].sort();
    const seasons = [
      ...new Set(rows.map((r) => r.season).filter((s): s is string => typeof s === 'string')),
    ].sort();

    const pv: PerVariable = {
      observationVariableDbId: varId,
      observationVariableName: rows[0]?.observationVariableName ?? varId,
      n: rows.length,
      studyCount: studyDbIds.length,
      studyDbIds,
      seasons,
    };

    if (nums.length > 0) {
      pv.mean = mean(nums);
      pv.median = median(nums);
      pv.min = String(Math.min(...nums));
      pv.max = String(Math.max(...nums));
      if (nums.length >= 2) pv.sd = sampleStdDev(nums);
    } else {
      const sorted = [...values].sort();
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      if (first !== undefined) pv.min = first;
      if (last !== undefined) pv.max = last;
    }

    out.push(pv);
  }

  out.sort((a, b) => a.observationVariableDbId.localeCompare(b.observationVariableDbId));
  return out;
}

function mean(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const hi = s[mid];
  if (hi === undefined) throw new Error('median of empty array');
  if (s.length % 2 !== 0) return hi;
  const lo = s[mid - 1];
  return lo === undefined ? hi : (lo + hi) / 2;
}

function sampleStdDev(nums: number[]): number {
  const m = mean(nums);
  const variance = nums.reduce((a, b) => a + (b - m) ** 2, 0) / (nums.length - 1);
  return Math.sqrt(variance);
}

/** Render a number compactly — integers bare, else rounded to 3 decimals. */
function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}
