/**
 * @fileoverview `brapi_germplasm_performance` — aggregate a single germplasm's
 * observations across the studies it appears in, returning per-variable summary
 * statistics (n, mean, median, sd, min, max) plus the contributing studies and
 * seasons. Answers the breeder's primary question — "how does line X perform
 * across the pool's history?" — in one call.
 *
 * Study-anchored by design: a naked `/observations?germplasmDbId=…` pull stalls
 * on SGN/Breedbase deployments (the count-probe bailout). Instead the tool
 * discovers the germplasm's studies via `/studies?germplasmDbIds=…` (with a
 * dialect-honor cross-check, since some servers silently drop that filter and
 * return the global list), then pulls observations per study through the shared
 * `pullStudyObservations` machinery — the same `/observations` →
 * `/observationunits` fallback chain `brapi_build_phenotype_matrix` uses.
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
import { type BrapiDialect, resolveDialect } from '@/services/brapi-dialect/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import type { RegisteredServer } from '@/services/server-registry/index.js';
import {
  AliasInput,
  asString,
  type BrapiListResult,
  buildRequestOptions,
  extractRows,
  isUpstreamNotFound,
  requireRegisteredConnection,
} from '../shared/find-helpers.js';
import { type NormObs, pullStudyObservations } from '../shared/observations.js';

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
  alias: z.string().describe('Alias of the registered BrAPI connection used.'),
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
  perVariable: z
    .array(PerVariableSchema)
    .describe('Per-variable aggregates, sorted by observationVariableDbId.'),
  warnings: z
    .array(z.string())
    .describe(
      'Advisory messages (study-discovery limits, dropped filters, fallback paths, per-study failures).',
    ),
});

type Output = z.infer<typeof OutputSchema>;
type PerVariable = z.infer<typeof PerVariableSchema>;

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const brapiGermplasmPerformance = tool('brapi_germplasm_performance', {
  description:
    "Aggregate a single germplasm's observations across every study it appears in, returning per-variable summary statistics (n, mean, median, sd, min, max), the contributing studies, and seasons. Study-anchored: discovers the germplasm's studies first (with a dialect-honor cross-check), then pulls observations per study — avoids the unanchored germplasm-only pull that stalls on SGN/Breedbase. For the underlying observation matrix, use brapi_build_phenotype_matrix.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'unknown_alias',
      code: JsonRpcErrorCode.NotFound,
      when: 'No connection has been registered under the requested alias',
      recovery:
        'Run brapi_connect with this alias (or omit `alias` to use the default connection) before calling brapi_germplasm_performance.',
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
    germplasmDbId: z.string().min(1).describe('The germplasmDbId to summarize performance for.'),
    variables: z
      .array(z.string())
      .optional()
      .describe(
        'Optional subset of observationVariableDbIds to aggregate. Omit to include every variable observed for the germplasm.',
      ),
  }),
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

    // 2. Discover the germplasm's studies (study-anchoring requirement).
    const discovery = await discoverStudiesForGermplasm({
      client,
      connection,
      dialect,
      germplasmDbId: input.germplasmDbId,
      ctx,
      warnings,
    });
    if (discovery.studyDbIds.length === 0) {
      warnings.push(
        `No studies discovered for germplasm '${input.germplasmDbId}'. It may not be associated with any study on this server, or /studies does not support a germplasm filter — use brapi_build_phenotype_matrix with explicit studies instead.`,
      );
    } else if (discovery.studyDbIds.length >= STUDY_DISCOVERY_CAP) {
      warnings.push(
        `Study discovery capped at ${STUDY_DISCOVERY_CAP} studies — aggregates may be incomplete. Narrow with brapi_build_phenotype_matrix on specific studies if needed.`,
      );
    }

    // 3. Pull observations per study, scoped to the germplasm. Filter returned
    //    rows to the iterated study + target germplasm so the aggregate stays
    //    correct on servers that ignore the studyDbId filter or over-return.
    const collected: NormObs[] = [];
    const wantVariables = input.variables?.length ? new Set(input.variables) : undefined;
    for (const studyDbId of discovery.studyDbIds) {
      let studyObs: NormObs[] | null;
      try {
        studyObs = await pullStudyObservations({
          studyDbId,
          input: input.variables
            ? { germplasm: [input.germplasmDbId], variables: input.variables }
            : { germplasm: [input.germplasmDbId] },
          client,
          connection,
          profile: profile.supported,
          dialect,
          config,
          loadLimit,
          warnings,
          ctx,
        });
      } catch (err) {
        warnings.push(
          `Study '${studyDbId}': observation pull failed (${err instanceof Error ? err.message : String(err)}).`,
        );
        continue;
      }
      if (studyObs === null) {
        warnings.push(
          `Study '${studyDbId}': no observation path (server exposes neither /observations nor /observationunits).`,
        );
        continue;
      }
      for (const o of studyObs) {
        if (o.studyDbId !== studyDbId) continue;
        if (o.germplasmDbId !== input.germplasmDbId) continue;
        if (wantVariables && !wantVariables.has(o.observationVariableDbId)) continue;
        collected.push(o);
      }
    }

    // 4. Aggregate per variable.
    const perVariable = aggregatePerVariable(collected);
    const allStudyDbIds = [...new Set(collected.map((o) => o.studyDbId))].sort();

    const result: Output = {
      alias: connection.alias,
      germplasmDbId: input.germplasmDbId,
      studyCount: allStudyDbIds.length,
      studyDbIds: allStudyDbIds,
      perVariable,
      warnings,
    };
    if (germplasmName) result.germplasmName = germplasmName;
    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(
      `# Germplasm performance — ${result.germplasmName ?? result.germplasmDbId} — \`${result.alias}\``,
    );
    lines.push('');
    lines.push(
      `germplasmDbId: \`${result.germplasmDbId}\` · studies: ${result.studyCount} · variables: ${result.perVariable.length}`,
    );
    lines.push(`studyDbIds: ${result.studyDbIds.join(', ') || '—'}`);
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
        if (v.min !== undefined) stats.push(`min=${v.min}`);
        if (v.max !== undefined) stats.push(`max=${v.max}`);
        stats.push(`studies=${v.studyCount}`);
        if (v.studyDbIds.length > 0) stats.push(`studyDbIds=${v.studyDbIds.join(',')}`);
        if (v.seasons.length > 0) stats.push(`seasons=${v.seasons.join('/')}`);
        lines.push(
          `- **${v.observationVariableName ?? v.observationVariableDbId}** (\`${v.observationVariableDbId}\`): ${stats.join(' · ')}`,
        );
      }
    }

    if (result.warnings.length > 0) {
      lines.push('');
      lines.push('## Warnings');
      for (const w of result.warnings) lines.push(`- ${w}`);
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
    {
      germplasmDbId,
      baseUrl: connection.baseUrl,
      ...ctx.recoveryFor('germplasm_not_found'),
    },
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
 * filter — the anchor set is over-broad, so it warns but still proceeds (the
 * per-study observation pull remains germplasm-scoped). When the dialect drops
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
        `/studies returned the same total (${baseline}) for the germplasm-filtered probe and an unfiltered baseline — the server appears to ignore the germplasm filter on /studies. Proceeding with the ${studyDbIds.length} discovered studies (per-study observation pulls remain germplasm-scoped), but coverage may be over-broad.`,
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
