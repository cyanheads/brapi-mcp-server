/**
 * @fileoverview Shared building blocks for `find_*` tools — Zod fragments for
 * common inputs (alias, loadLimit, extraFilters), utilities to merge named
 * filters with the passthrough map, a generic distribution aggregator, and
 * the spillover handler that turns a "too many rows" result into a canvas
 * dataframe handle.
 *
 * @module mcp-server/tools/shared/find-helpers
 */

import { type Context, type HandlerContext, z } from '@cyanheads/mcp-ts-core';
import { config as frameworkConfig } from '@cyanheads/mcp-ts-core/config';
import {
  JsonRpcErrorCode,
  McpError,
  requestCancelled,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { DEFAULT_OUTLINE_BUDGET_BYTES } from '@cyanheads/mcp-ts-core/utils';
import { configuredBaseUrl, resolveConnectInput } from '@/config/alias-credentials.js';
import type { ServerConfig } from '@/config/server-config.js';
import { getServerConfig, isDataframeExportRegistered } from '@/config/server-config.js';
import {
  type BrapiClient,
  type BrapiEnvelope,
  type BrapiPagination,
  type BrapiRequestOptions,
  CALL_DEADLINE_MS,
  CALL_DEADLINE_REASON,
  callDeadlineAt,
  type ResolvedAuth,
} from '@/services/brapi-client/index.js';
import type { BrapiDialect, DialectAdaptation } from '@/services/brapi-dialect/index.js';
import type {
  CanvasBridge,
  RegisterDataframeInput,
  RegisterDataframeResult,
} from '@/services/canvas-bridge/index.js';
import {
  type CapabilityLookupOptions,
  getCapabilityRegistry,
} from '@/services/capability-registry/index.js';
import type { CapabilityProfile } from '@/services/capability-registry/types.js';
import type { RegisteredServer } from '@/services/server-registry/index.js';
import { DEFAULT_ALIAS, getServerRegistry } from '@/services/server-registry/index.js';

/** True when the thrown value is an upstream 404 surfaced by the BrAPI client. */
export function isUpstreamNotFound(err: unknown): boolean {
  return err instanceof McpError && err.code === JsonRpcErrorCode.NotFound;
}

/**
 * Resolve the BrAPI connection for an alias in the caller's scope. An alias
 * with no registration there but a server URL configured for it — a
 * `BRAPI_<ALIAS>_BASE_URL` (`BRAPI_DEFAULT_BASE_URL` for `default`) or an
 * enabled builtin — is registered on first use, as an argument-free
 * `brapi_connect` would register it. Any other alias throws the calling
 * tool's `'unknown_alias'` contract so the framework fills
 * `data.recovery.hint` from its `errors[]` entry.
 *
 * Every caller MUST declare an `errors[]` entry whose `reason` is
 * `'unknown_alias'`; the type signature enforces this at compile time. A
 * first-use registration can also fail `alias_base_url_invalid`,
 * `private_address_blocked`, `auth_token_exchange_failed`,
 * `auth_no_access_token`, `capability_discovery_unavailable`,
 * `upstream_unauthorized`, or `upstream_forbidden` (the last three also on a
 * later call whose cached capability profile expired), which each caller
 * declares too. A token exchange that stalls fails as a `Timeout`.
 */
export async function requireRegisteredConnection(
  ctx: HandlerContext<'unknown_alias'>,
  alias: string | undefined,
): Promise<RegisteredServer> {
  const resolved = alias ?? DEFAULT_ALIAS;
  const registry = getServerRegistry();
  const connection = await registry.getOptional(ctx, resolved);
  if (connection) return connection;
  // Not `resolveConnectInput`: it sends an alias with no URL of its own to the
  // default server, so a mistyped alias would silently query it.
  if (configuredBaseUrl(resolved) === undefined) {
    throw ctx.fail(
      'unknown_alias',
      `No BrAPI connection is registered under alias '${resolved}', and the server has no base URL configured for it. Call brapi_connect with this alias and a baseUrl first.`,
      { alias: resolved },
    );
  }
  return await registry.registerOnce(ctx, resolved, () => registerConfiguredAlias(ctx, resolved));
}

/**
 * Register a server-configured alias the way an argument-free `brapi_connect`
 * does — token exchange, capability profile, then save, so a failure persists
 * nothing — except that a cached profile is reused. A registration that
 * landed under the alias meanwhile (an explicit `brapi_connect`) is kept.
 */
async function registerConfiguredAlias(ctx: Context, alias: string): Promise<RegisteredServer> {
  const registry = getServerRegistry();
  const resolved = resolveConnectInput(alias, {});
  const connection = await registry.resolve(ctx, {
    alias,
    baseUrl: resolved.baseUrl,
    auth: resolved.auth,
  });
  const lookup: CapabilityLookupOptions = {};
  if (connection.resolvedAuth) lookup.auth = connection.resolvedAuth;
  await getCapabilityRegistry().profile(connection.baseUrl, ctx, lookup);
  const registered = await registry.getOptional(ctx, alias);
  if (registered) return registered;
  await registry.save(ctx, connection);
  logConnectionRegistered(ctx, connection, { authSource: 'env', firstUse: true });
  return connection;
}

/**
 * True when the server is running over HTTP without per-client auth, in which
 * case `ctx.state` collapses every caller into the shared `default` tenant —
 * including the bearer token resolved by SGN/OAuth at connection time.
 */
export function isSharedTenantHttp(): boolean {
  return frameworkConfig.mcpTransportType === 'http' && frameworkConfig.mcpAuthMode === 'none';
}

/**
 * Log a saved connection, plus a notice when the upstream credentials it
 * carries persist in the tenant namespace every HTTP client shares.
 */
export function logConnectionRegistered(
  ctx: Context,
  connection: RegisteredServer,
  details: { authSource: 'agent' | 'env'; firstUse?: boolean },
): void {
  ctx.log.info(
    details.firstUse ? 'BrAPI connection registered on first use' : 'BrAPI connection registered',
    {
      alias: connection.alias,
      baseUrl: connection.baseUrl,
      authMode: connection.authMode,
      authSource: details.authSource,
    },
  );
  if (isSharedTenantHttp() && connection.authMode !== 'none') {
    ctx.log.notice(
      'Connection credentials persisted under shared `default` tenant — set MCP_AUTH_MODE=jwt|oauth for per-client isolation.',
      {
        alias: connection.alias,
        baseUrl: connection.baseUrl,
        authMode: connection.authMode,
        mcpTransport: frameworkConfig.mcpTransportType,
        mcpAuthMode: frameworkConfig.mcpAuthMode,
      },
    );
  }
}

/** Upper cap on how many rows we'll pull for canvas dataframe spillover per call. */
export const MAX_SPILLOVER_ROWS = 50_000;

/** Hard cap on how many BrAPI pages we'll traverse when building a dataframe. */
export const MAX_SPILLOVER_PAGES = 50;

/**
 * Most upstream rows one spill walk can examine: the row cap, or the page cap
 * at the configured spill page size, whichever is lower. A client-side row
 * filter sees every upstream row only when the upstream total fits under it.
 */
export function spillWalkCeiling(): number {
  return Math.min(MAX_SPILLOVER_ROWS, getServerConfig().pageSize * MAX_SPILLOVER_PAGES);
}

/**
 * Wall-clock budget for one spill walk — every page, retry, and backoff after
 * the first page — inside the call deadline every upstream request shares
 * (`CALL_DEADLINE_MS`); the walk stops at whichever ends first. Leaves the
 * dataframe registration room under the MCP SDK client's 60 s default request
 * timeout; rows the budget cuts off leave the dataframe marked truncated.
 */
export const SPILL_WALK_DEADLINE_MS = 40_000;

/**
 * Byte budget for a find_* tool's inline `results[]`: the UTF-8 length of the
 * array's JSON — the structuredContent copy, the larger of the two surfaces.
 */
export const INLINE_RESULTS_BUDGET_BYTES = DEFAULT_OUTLINE_BUDGET_BYTES;

/** The bound that cut `results[]` short of the rows in memory. */
export type InlineBound = 'budget' | 'loadLimit';

export interface InlineSelection<T> {
  /** Absent when every row fit both bounds. */
  bound?: InlineBound;
  rows: T[];
}

/**
 * The leading rows that fit both `loadLimit` and {@link INLINE_RESULTS_BUDGET_BYTES},
 * whichever binds first. Keeps the first row even when it alone overruns the
 * budget, so a non-empty match never renders an empty `results[]`.
 */
export function selectInlineRows<T>(rows: readonly T[], loadLimit: number): InlineSelection<T> {
  const limit = Math.min(rows.length, loadLimit);
  let bytes = 2; // the array's brackets
  let count = 0;
  for (; count < limit; count++) {
    const rowBytes = Buffer.byteLength(JSON.stringify(rows[count]), 'utf8') + (count > 0 ? 1 : 0); // + comma
    if (count > 0 && bytes + rowBytes > INLINE_RESULTS_BUDGET_BYTES) break;
    bytes += rowBytes;
  }
  const selection: InlineSelection<T> = { rows: rows.slice(0, count) };
  if (count < rows.length) selection.bound = count < limit ? 'budget' : 'loadLimit';
  return selection;
}

/**
 * Disclose a `results[]` that {@link maybeSpill} cut short: `truncated`,
 * `shown` (`results.length`), `cap` (the effective loadLimit, whichever bound
 * fired), and one notice naming the bound and the staged dataframe with the
 * tools that read it. A finder stages a dataframe exactly when a bound fires,
 * so this is the whole staging disclosure. Writes nothing when no bound fired.
 * The notice shares its key with `ctx.enrich.notice` — last write wins.
 */
export function discloseInlineTrim(
  ctx: Context,
  spill: { dataframe?: DataframeHandle | undefined; inlineBound?: InlineBound; results: unknown[] },
  loadLimit: number,
): void {
  if (!spill.inlineBound) return;
  const shown = spill.results.length;
  ctx.enrich.truncated({
    shown,
    cap: loadLimit,
    guidance: inlineTrimNotice(spill.inlineBound, shown, loadLimit, spill.dataframe),
  });
}

/**
 * The notice for a `results[]` cut short by `bound`: which bound fired, then
 * the {@link stagedDataframeNotice} pointer to the dataframe holding the rest.
 * Shared by {@link discloseInlineTrim} and the one finder whose output already
 * owns the `truncated` key.
 */
export function inlineTrimNotice(
  bound: InlineBound,
  shown: number,
  loadLimit: number,
  dataframe: DataframeHandle | undefined,
): string {
  const fired =
    bound === 'budget'
      ? `the ${INLINE_RESULTS_BUDGET_BYTES.toLocaleString('en-US')}-byte inline budget bound before loadLimit (${loadLimit})`
      : `loadLimit (${loadLimit}) bound`;
  const staged = dataframe ? ` ${stagedDataframeNotice([dataframe])}` : '';
  return `results[] holds the first ${shown} matched row(s): ${fired}.${staged}`;
}

/**
 * The pointer every response that staged dataframes carries in its `notice`:
 * each table with its row count (and whether it is truncated), then
 * `brapi_dataframe_describe` and `brapi_dataframe_query` — plus
 * `brapi_dataframe_export` only where that tool is registered. `join` names how
 * two staged tables relate.
 */
export function stagedDataframeNotice(
  tables: readonly DataframeHandle[],
  options: { join?: string } = {},
): string {
  const named = tables.map(
    (t) =>
      `\`${t.tableName}\` (${t.rowCount} row${t.rowCount === 1 ? '' : 's'}${t.truncated ? ', truncated — warnings says why' : ''})`,
  );
  const one = named.length === 1;
  const list = one ? named[0] : `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`;
  const [it, its] = one ? ['it', 'its'] : ['them', 'their'];
  const exportClause = isDataframeExportRegistered()
    ? `, or write ${it} to a file with brapi_dataframe_export`
    : '';
  const join = options.join ? ` — ${options.join}` : '';
  return `Staged dataframe${one ? '' : 's'} ${list}: list ${its} columns with brapi_dataframe_describe, then query ${it} with brapi_dataframe_query (SQL)${exportClause}${join}.`;
}

/**
 * Trailer render for a `warnings` enrichment field: the bullets under their own
 * `**Warnings:**` heading, so they never run on from the Applied Filters list
 * above them, and nothing at all when there are none.
 */
export function renderWarningsTrailer(warnings: readonly string[] | undefined): string {
  if (!warnings || warnings.length === 0) return '';
  return `**Warnings:**\n${warnings.map((w) => `- ${w}`).join('\n')}`;
}

/**
 * Trailer render for a finder's `appliedFilters` enrichment field: one bullet
 * per filter, with server-side keys shown under the user-facing parameter
 * names in `serverToUser`.
 */
export function renderAppliedFiltersTrailer(
  serverToUser: Readonly<Record<string, string>>,
  emptyText = 'none',
): (filters: Record<string, unknown>) => string {
  return (filters) => {
    const entries = Object.entries(filters);
    if (entries.length === 0) return `**Applied Filters:** ${emptyText}`;
    const lines = entries.map(([k, v]) => {
      const display = serverToUser[k] ?? k;
      return `- **${display}:** ${Array.isArray(v) ? v.join(', ') : String(v)}`;
    });
    return `**Applied Filters:**\n${lines.join('\n')}`;
  };
}

/**
 * The enrichment fields a finder fills through {@link discloseInlineTrim} when
 * `results[]` holds fewer rows than matched.
 */
export const InlineTrimEnrichment = {
  notice: z
    .string()
    .optional()
    .describe(
      'Why results[] is empty, or which bound cut it short and the dataframe holding the matched rows.',
    ),
  truncated: z
    .boolean()
    .optional()
    .describe(
      'True when results[] holds fewer rows than matched because loadLimit or the inline byte budget bound.',
    ),
  shown: z.number().int().positive().optional().describe('Length of results[] when truncated.'),
  cap: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'The effective loadLimit when truncated; shown is below it when the 24,000-byte inline budget bound first (notice says which).',
    ),
};

/**
 * The `format()` line a finder prints when rows exist beyond `results[]`:
 * where they are — a complete dataframe, a truncated one, or upstream rows the
 * scan never reached. The tools that read the dataframe are named once, in the
 * notice; `undefined` when `results[]` holds everything.
 */
export function renderMoreRowsLine(result: {
  dataframe?: DataframeHandle | undefined;
  hasMore: boolean;
}): string | undefined {
  if (!result.hasMore) return;
  const df = result.dataframe;
  if (!df) {
    return '⚠ More rows may exist upstream: the scan stopped before the upstream total (see warnings). Narrow the filters to cover the whole set.';
  }
  return df.truncated
    ? `⚠ More rows exist beyond results[]: dataframe \`${df.tableName}\` holds the ${df.rowCount} matched row(s) fetched and is truncated — the walk stopped before the upstream total (see warnings).`
    : `⚠ More rows exist beyond results[]: all ${df.rowCount} matched rows are in dataframe \`${df.tableName}\`.`;
}

export const AliasInput = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+$/)
  .optional()
  .describe(
    'Connection alias. Omit to use alias `default`. An alias registered via brapi_connect works, and so does one the server has a URL configured for (a built-in alias, an operator-configured alias, or `default` on a deployment with a default server), which connects on first use. Calls that used a non-default alias must pass that same alias here.',
  );

/**
 * An ID or filter value. An empty or whitespace-only string is rejected at the
 * schema: sent upstream it widens a filter (an ignored blank value) or
 * malforms a path (`/germplasm/%20/pedigree`).
 */
export const NonBlankString = z.string().regex(/\S/, 'Must contain a non-whitespace character.');

/**
 * A free-text match. Whitespace-only text is rejected like {@link NonBlankString};
 * an empty string stays the no-op it always was (no text filter).
 */
export const FreeTextInput = z.string().regex(/^$|\S/, 'Must not be whitespace-only.');

export const LoadLimitInput = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(
    'Cap on rows returned inline in results[]. Omit for the deployment default. results[] also stops at a 24,000-byte budget, whichever bound comes first, and keeps at least one row when any matched. When results[] holds fewer rows than matched, the matched rows are staged in a dataframe (marked truncated if the upstream walk stopped short); query it with brapi_dataframe_query (SQL) instead of paging row-by-row.',
  );

export const ExtraFiltersInput = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    'Extra BrAPI filters forwarded verbatim. Valid keys vary by endpoint; brapi_describe_filters enumerates them. Named params on this tool take precedence on conflict.',
  );

/**
 * Merge named params with the user-supplied extraFilters map. Named params
 * win on conflict; conflicts are surfaced as warnings.
 */
export function mergeFilters(
  named: Record<string, unknown>,
  extra: Record<string, unknown> | undefined,
  warnings: string[],
): Record<string, unknown> {
  if (!extra) return pruneUndefined(named);
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue;
    merged[key] = value;
  }
  for (const [key, value] of Object.entries(named)) {
    if (value === undefined) continue;
    if (key in merged && !deepEqual(merged[key], value)) {
      warnings.push(
        `extraFilters.${key} was overridden by the named param (named params take precedence).`,
      );
    }
    merged[key] = value;
  }
  return merged;
}

/**
 * Apply the dialect's GET-filter adapter, append warnings, and fail with a
 * typed `all_filters_dropped` error when the dialect dropped every supplied
 * filter — the call would otherwise silently widen to the unfiltered baseline.
 * Tools that call this MUST declare `'all_filters_dropped'` in their `errors[]`
 * contract; the framework fills that entry's recovery hint on the wire, so the
 * shape stays consistent across the find_* surface. The bare-baseline call (no
 * filters supplied) is exempt:
 * `dropped` is empty so the all-dropped predicate is false.
 *
 * Returns the full {@link DialectAdaptation} so callers can read
 * `requiresEscalation` and prefer POST /search when GET would lose multi-value
 * semantics (#15). Most call sites destructure `.filters` for the route
 * resolver and forward `.requiresEscalation` verbatim.
 */
export function applyDialectFiltersOrFail(
  ctx: HandlerContext<'all_filters_dropped'>,
  dialect: BrapiDialect,
  endpoint: string,
  filters: Readonly<Record<string, unknown>>,
  warnings: string[],
): DialectAdaptation {
  const adapted = dialect.adaptGetFilters(endpoint, filters);
  warnings.push(...adapted.warnings);
  if (adapted.dropped.length > 0 && Object.keys(adapted.filters).length === 0) {
    throw ctx.fail(
      'all_filters_dropped',
      `Every filter you supplied was dropped by the ${dialect.id} dialect (${adapted.dropped.join(', ')}); the call would silently widen to the unfiltered baseline.`,
      { dropped: adapted.dropped, dialect: dialect.id },
    );
  }
  return adapted;
}

export type FindRoute =
  | {
      filters: Record<string, unknown>;
      kind: 'get';
      path: string;
      service: string;
    }
  | {
      kind: 'search';
      noun: string;
      searchBody: Record<string, unknown>;
      service: string;
    };

export interface ResolveFindRouteInput {
  dialect: BrapiDialect;
  endpoint: string;
  filters: Record<string, unknown>;
  profile: CapabilityProfile;
  /**
   * Set by the dialect adapter when at least one multi-value array filter
   * was downcast to a single scalar on the GET wire. When true and a working
   * POST `/search/{noun}` is advertised, the route resolver escalates to
   * search to preserve the original multi-value semantics — without this
   * the agent would silently see a result set narrowed to the first value
   * only. See {@link DialectAdaptation.requiresEscalation}.
   */
  requiresEscalation?: boolean;
  searchBody: Record<string, unknown>;
  searchNoun?: string;
  service?: string;
  warnings: string[];
}

/**
 * Select the transport for a curated find tool from the advertised capability
 * profile. GET stays the default because it has the widest real-world support
 * and can run through dialect-specific query-string adapters. When a server
 * exposes only POST `/search/{noun}`, the same semantic filters are sent as a
 * search body instead.
 *
 * Escalation: when the dialect signals `requiresEscalation` (one or more
 * multi-value filters got downcast on the GET path) AND POST /search is
 * available and not disabled, the resolver picks search — the search body
 * preserves the multi-value semantics the GET wire shape would have lost.
 */
export function resolveFindRoute(input: ResolveFindRouteInput): FindRoute {
  const service = input.service ?? input.endpoint;
  const path = `/${input.endpoint}`;
  const searchNoun = input.searchNoun ?? input.endpoint;
  const searchService = `search/${searchNoun}`;
  const { getSupported, searchSupported, searchDisabled } = findRouteSupport(
    input.profile,
    input.dialect,
    service,
    searchNoun,
  );
  const escalate = input.requiresEscalation === true && searchSupported && !searchDisabled;

  if (getSupported && !escalate) {
    return { kind: 'get', service, path, filters: input.filters };
  }

  if (searchSupported && !searchDisabled) {
    if (escalate) {
      input.warnings.push(
        `Route escalated to POST /search/${searchNoun} because GET ${path} would have downcast multi-value filters under the active '${input.dialect.id}' dialect; POST /search preserves the original multi-value semantics.`,
      );
    } else {
      input.warnings.push(
        `Route selected: POST /search/${searchNoun} because GET ${path} was not advertised by this server.`,
      );
    }
    return {
      kind: 'search',
      service: searchService,
      noun: searchNoun,
      searchBody: pruneUndefined(input.searchBody),
    };
  }

  if (searchSupported && searchDisabled) {
    throw validationError(
      `BrAPI server advertises POST /search/${searchNoun}, but the active '${input.dialect.id}' dialect marks that route as known-dead.`,
      {
        service,
        searchService,
        dialectId: input.dialect.id,
        reason: 'search_endpoint_disabled',
      },
    );
  }

  throw validationError(
    `BrAPI server does not advertise a usable route for '${service}'. Expected GET ${path} or POST /search/${searchNoun}. Check brapi_server_info for the full capability list.`,
    {
      service,
      searchService,
      supportedCount: Object.keys(input.profile.supported).length,
      reason: 'missing_find_route',
    },
  );
}

/**
 * True when {@link resolveFindRoute} picks a route for `noun` on this server
 * instead of throwing: GET `/{noun}` is advertised, or POST `/search/{noun}`
 * is advertised and the active dialect does not mark it known-dead.
 */
export function hasFindRoute(
  profile: CapabilityProfile,
  dialect: Pick<BrapiDialect, 'disabledSearchEndpoints'>,
  noun: string,
): boolean {
  const { getSupported, searchSupported, searchDisabled } = findRouteSupport(
    profile,
    dialect,
    noun,
    noun,
  );
  return getSupported || (searchSupported && !searchDisabled);
}

function findRouteSupport(
  profile: CapabilityProfile,
  dialect: Pick<BrapiDialect, 'disabledSearchEndpoints'>,
  service: string,
  searchNoun: string,
): { getSupported: boolean; searchDisabled: boolean; searchSupported: boolean } {
  return {
    getSupported: supportsMethod(profile.supported[service], 'GET'),
    searchSupported: supportsMethod(profile.supported[`search/${searchNoun}`], 'POST'),
    searchDisabled: Boolean(dialect.disabledSearchEndpoints?.has(searchNoun)),
  };
}

function supportsMethod(
  descriptor: { methods?: readonly string[] } | undefined,
  method: string,
): boolean {
  if (!descriptor) return false;
  return (
    !descriptor.methods || descriptor.methods.length === 0 || descriptor.methods.includes(method)
  );
}

function pruneUndefined(record: Record<string, unknown>): Record<string, unknown> {
  const pruned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) pruned[key] = value;
  }
  return pruned;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Build request options with optional auth. */
export function buildRequestOptions(
  connection: RegisteredServer,
  params?: BrapiRequestOptions['params'],
  overrides: BrapiRequestOptions = {},
): BrapiRequestOptions {
  const opts: BrapiRequestOptions = { ...overrides };
  if (connection.resolvedAuth && !opts.auth) opts.auth = connection.resolvedAuth;
  if (params) opts.params = params;
  return opts;
}

/**
 * Build request options for a companion enrichment call (FK lookup, count
 * probe, preflight). Companions are non-critical — they decorate the response
 * but never gate it — so they get a tighter wall-clock budget and zero
 * retries: a slow upstream surfaces as a single warning instead of stretching
 * the response by 4× the per-attempt timeout.
 *
 * The dialect is threaded through so the BrapiClient translates plural ID
 * filters (`studyDbIds`, `trialDbIds`, …) at the wire edge — the v0.4.7 fix
 * for the foundational dialect-bypass class of bug. Warnings (dialect drops,
 * downcasts) flow into the same array the tool surfaces in its envelope.
 */
export function companionRequestOptions(
  connection: RegisteredServer,
  dialect: BrapiDialect,
  config: ServerConfig,
  warnings: string[],
  params?: BrapiRequestOptions['params'],
): BrapiRequestOptions {
  const opts: BrapiRequestOptions = {
    timeoutMs: config.companionTimeoutMs,
    retryMaxAttempts: 0,
    dialect,
    warnings,
  };
  if (connection.resolvedAuth) opts.auth = connection.resolvedAuth;
  if (params) opts.params = params;
  return opts;
}

/**
 * Read `metadata.pagination.totalCount` from a BrAPI list endpoint with a
 * `pageSize: 1` probe. Returns `undefined` when the server omits the count.
 * Shared by the companion-count probes on the `get_*` tools.
 */
export async function fetchTotalCount(
  client: BrapiClient,
  baseUrl: string,
  path: string,
  ctx: Context,
  options: BrapiRequestOptions,
): Promise<number | undefined> {
  const env = await client.get<unknown>(baseUrl, path, ctx, options);
  const total = env.metadata?.pagination?.totalCount;
  return typeof total === 'number' ? total : undefined;
}

/** Input to {@link fetchValidatedScopedCount}. */
export interface ValidatedScopedCountInput {
  client: BrapiClient;
  connection: RegisteredServer;
  ctx: Context;
  dialect: BrapiDialect;
  /** Output-field name used in the omission warning (e.g. `observationCount`). */
  label: string;
  /** Endpoint path to count against (e.g. `/observations`). */
  path: string;
  /** Human label for the scope in warnings (e.g. `study filter`). */
  scopeDescription: string;
  /** The scoping filter to apply (e.g. `{ studyDbIds: [studyDbId] }`). */
  scopeFilter: Record<string, unknown>;
  /** Dialect resource segment for filter adaptation (e.g. `observations`). */
  service: string;
  warnings: string[];
}

/**
 * Fetch a study/germplasm-scoped total count, omitting it when the upstream
 * can't actually scope the query — so a per-entity count is never silently
 * reported as the server-wide total. Two guards, in order:
 *
 *   1. **Dropped filter** — if the dialect drops the scope filter entirely
 *      (the server doesn't honor it), the count would be the global total;
 *      skip the probe and warn.
 *   2. **Ignored filter** — run the scoped probe and an unfiltered baseline in
 *      parallel; if the totals match, the upstream silently ignored the filter
 *      (accepted it on the wire but returned the unfiltered set), so the
 *      "scoped" count is really the global total. Drop it and warn.
 *
 * Returns the trustworthy scoped total, or `undefined` (with a warning pushed
 * onto `warnings`) when neither guard can vouch for it. Both probes run at
 * `pageSize: 1` under the companion budget (tight timeout, no retries) — these
 * counts decorate a response, never gate it, so a slow or non-conforming
 * upstream surfaces as one missing count rather than a wrong one or a stall.
 *
 * The scope filter is adapted through the dialect here (so per-server key
 * translation / drops take effect) and sent with `buildRequestOptions` — never
 * re-threaded through the client, which would double-apply the dialect.
 */
export async function fetchValidatedScopedCount(
  input: ValidatedScopedCountInput,
): Promise<number | undefined> {
  const {
    client,
    connection,
    ctx,
    dialect,
    label,
    path,
    scopeDescription,
    scopeFilter,
    service,
    warnings,
  } = input;
  const config = getServerConfig();
  const companion = (params: BrapiRequestOptions['params']): BrapiRequestOptions =>
    buildRequestOptions(connection, params, {
      timeoutMs: config.companionTimeoutMs,
      retryMaxAttempts: 0,
    });

  const adapted = dialect.adaptGetFilters(service, scopeFilter);
  warnings.push(...adapted.warnings);

  // Guard 1: the dialect dropped the scope filter — the server doesn't honor
  // it, so any count we got back would be the global total.
  if (Object.keys(adapted.filters).length === 0) {
    warnings.push(
      `${label} omitted: the '${dialect.id}' dialect drops the ${scopeDescription} for ${path}, so a scoped count can't be computed (the server does not honor it).`,
    );
    return;
  }

  const filteredParams = {
    ...(adapted.filters as Record<
      string,
      string | number | boolean | readonly (string | number)[] | undefined
    >),
    pageSize: 1,
  };

  const [filtered, baseline] = await Promise.all([
    fetchTotalCount(client, connection.baseUrl, path, ctx, companion(filteredParams)),
    fetchTotalCount(client, connection.baseUrl, path, ctx, companion({ pageSize: 1 })).catch(
      () => undefined,
    ),
  ]);

  if (typeof filtered !== 'number') return;

  // Guard 2: the scoped probe and the unfiltered baseline returned the same
  // total — the upstream silently ignored the filter, so this is the global
  // count wearing a per-entity label.
  if (typeof baseline === 'number' && baseline > 0 && filtered === baseline) {
    warnings.push(
      `${label} omitted: ${path} returned the same total (${baseline}) for both the scoped probe and an unfiltered baseline — the upstream silently ignored the ${scopeDescription}, so a scoped count can't be trusted.`,
    );
    return;
  }

  return filtered;
}

/**
 * Compute a frequency distribution for one field across a result set.
 * Accepts a field accessor that may return a scalar or array; arrays are
 * exploded. Returns `{value -> count}` sorted by count desc.
 */
export function computeDistribution<T>(
  rows: readonly T[],
  accessor: (row: T) => string | readonly string[] | undefined | null,
): Record<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = accessor(row);
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (typeof v !== 'string' || v.length === 0) continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
  }
  return Object.fromEntries([...counts.entries()].sort(([, a], [, b]) => b - a));
}

/**
 * Render the standardized header line for `find_*` tools. When a dataframe
 * spillover is present, surfaces the dataframe row count alongside the
 * in-context count and the upstream total — `{returned} of {total}` alone
 * hides the middle number and confuses readers when filters miss server-
 * side and the dataframe row count diverges from both.
 */
export function renderFindHeader(opts: {
  noun: string;
  alias: string;
  returnedCount: number;
  totalCount?: number;
  dataframe?: { rowCount: number; expiresAt?: string } | undefined;
}): string {
  if (opts.dataframe) {
    const expiry = opts.dataframe.expiresAt
      ? ` (${formatExpiresIn(opts.dataframe.expiresAt)})`
      : '';
    const totalPart =
      opts.totalCount !== undefined ? ` · ${opts.totalCount} total ${opts.noun}` : '';
    return `# ${opts.returnedCount} returned · ${opts.dataframe.rowCount} in dataframe${expiry}${totalPart} — \`${opts.alias}\``;
  }
  if (opts.totalCount !== undefined) {
    return `# ${opts.returnedCount} of ${opts.totalCount} ${opts.noun} — \`${opts.alias}\``;
  }
  return `# ${opts.returnedCount} ${opts.noun} — \`${opts.alias}\``;
}

/**
 * Character budget for one rendered comma-joined list line before it caps.
 *
 * Sized by rendered width rather than a fixed entry count so a line adapts to
 * its data: the common case (a distribution over a 26-study server, a `find_*`
 * dataframe's ~18 columns) renders complete, while a pathological one (a
 * spilled set whose `fullRows` reach {@link MAX_SPILLOVER_ROWS}; a genotype
 * matrix's 500,000 variant columns) caps instead of emitting megabytes into
 * `content[]`. Mirrors {@link MAX_INLINE_JSON}'s size-aware philosophy; a
 * hardcoded top-N did neither job well.
 *
 * Applied only to lines whose omitted entries stay retrievable elsewhere —
 * never to a line that is the sole carrier of a mapping (see
 * `renderDataframeHandle`'s `renamedColumns`).
 *
 * Exported so `brapi_dataframe_describe` can bound its own per-column listing
 * with the same width-aware budget rather than reimplementing an equivalent.
 */
export const MAX_LIST_LINE = 400;

/**
 * Join `parts` with `, ` until `budget` characters are consumed. Always emits
 * at least one part — a line naming no value carries less than one that
 * overruns the budget slightly. Returns the rendered prefix plus how many parts
 * were left out, so callers can append their own recovery hint.
 */
export function joinWithinBudget(
  parts: readonly string[],
  budget: number,
): { omitted: number; text: string } {
  const shown: string[] = [];
  let remaining = budget;
  for (const part of parts) {
    if (shown.length > 0 && part.length + 2 > remaining) break;
    shown.push(part);
    remaining -= part.length + 2;
  }
  return { text: shown.join(', '), omitted: parts.length - shown.length };
}

/**
 * Name where a capped distribution's remaining entries can actually be read.
 * When the result spilled, the dataframe holds every row the distribution was
 * computed from, so aggregating there reconstructs it in full — a path a
 * content-only client can take. Without a dataframe there is nothing to point
 * at but `structuredContent`, which those clients cannot read; that residual
 * is only reachable when a small result set carries a very high-cardinality
 * field.
 *
 * Deliberately does not emit a `GROUP BY` snippet: distribution accessors may
 * explode array-valued fields (`find_studies.seasons`), so a per-field
 * `GROUP BY` would return per-array-literal counts rather than the exploded
 * distribution it claims to reconstruct.
 */
function distributionRecoveryHint(dataframe: DataframeHandle | undefined): string {
  return dataframe
    ? ` — aggregate dataframe \`${dataframe.tableName}\` with brapi_dataframe_query for the full distribution`
    : ' (see structuredContent.distributions)';
}

/**
 * Render a distributions block in markdown. Pass the `find_*` result's
 * dataframe handle (when it spilled): a truncation caveat is prepended when the
 * dataframe hit a row cap, and capped lines point at the dataframe as the
 * content-visible path to the remaining entries.
 */
export function renderDistributions(
  distributions: Record<string, Record<string, number>>,
  dataframe?: DataframeHandle,
): string {
  const lines: string[] = [];
  if (dataframe?.truncated) {
    const upstream =
      dataframe.totalCount === undefined ? '' : ` (the upstream reports ${dataframe.totalCount})`;
    lines.push(
      `_Computed over the ${dataframe.rowCount} row(s) in the truncated dataframe${upstream} — narrow the filters for a representative sample._`,
    );
  }
  for (const [field, counts] of Object.entries(distributions)) {
    const entries = Object.entries(counts);
    if (entries.length === 0) continue;
    const { text, omitted } = joinWithinBudget(
      entries.map(([value, count]) => `${value} (${count})`),
      MAX_LIST_LINE,
    );
    const suffix = omitted > 0 ? `, …+${omitted} more${distributionRecoveryHint(dataframe)}` : '';
    lines.push(`- **${field}:** ${text}${suffix}`);
  }
  return lines.join('\n');
}

export interface LoadedRows<T> {
  /**
   * True when the server has rows past this page: its totalCount exceeds them,
   * or, with no totalCount, the page came back full ({@link isFullPage}).
   */
  hasMore: boolean;
  /** Pages actually consumed — useful for telemetry. */
  pagesFetched: number;
  rows: T[];
  /** Total rows advertised by the server (may be larger than `rows.length`). */
  totalCount?: number;
}

/**
 * Build a row mapper that runs `dialect.normalizeRow` per row, when the
 * dialect declares one. Returns `undefined` on dialects with no normalizer
 * — caller can pass the result straight to a `MaybeSpillInput.rowMapper`
 * field with no extra branching.
 */
export function dialectRowMapper<T extends Record<string, unknown>>(
  dialect: BrapiDialect,
  endpoint: string,
): ((row: T) => T) | undefined {
  const normalize = dialect.normalizeRow;
  if (!normalize) return;
  return (row) => normalize(endpoint, row) as T;
}

/**
 * Pull the first page for either a GET list endpoint or POST /search route.
 * Optionally applies a per-row normalizer (typically built via
 * `dialectRowMapper`) to each row before returning so the caller sees the
 * canonical shape that matches what the dataframe materialization will hold.
 */
export async function loadInitialFindPage<T>(
  client: BrapiClient,
  connection: RegisteredServer,
  route: FindRoute,
  loadLimit: number,
  ctx: Context,
  options: { normalizeRow?: (row: T) => T } = {},
): Promise<LoadedRows<T>> {
  const envelope = await fetchFindRoutePage<T>(client, connection, route, loadLimit, 0, ctx);
  let rows = extractRows<T>(envelope.result);
  if (options.normalizeRow) {
    const normalize = options.normalizeRow;
    rows = rows.map(normalize);
  }
  const pagination = envelope.metadata?.pagination;
  const totalCount = pagination?.totalCount;
  const hasMore =
    typeof totalCount === 'number'
      ? totalCount > rows.length && totalCount > 0
      : isFullPage(rows.length, loadLimit, pagination);
  const result: LoadedRows<T> = { rows, hasMore, pagesFetched: 1 };
  if (totalCount !== undefined) result.totalCount = totalCount;
  return result;
}

/**
 * Whether a page may have rows after it when the upstream reports no total: it
 * filled the pageSize requested, or the smaller pageSize the upstream reports
 * serving. Anything shorter is the last page.
 */
function isFullPage(rowCount: number, requested: number, pagination?: BrapiPagination): boolean {
  if (rowCount === 0) return false;
  const served = pagination?.pageSize;
  return rowCount >= requested || (typeof served === 'number' && served > 0 && rowCount >= served);
}

async function fetchFindRoutePage<T>(
  client: BrapiClient,
  connection: RegisteredServer,
  route: FindRoute,
  pageSize: number,
  page: number,
  ctx: Context,
  requestOptions: BrapiRequestOptions = {},
): Promise<BrapiEnvelope<BrapiListResult<T> | T[]>> {
  if (route.kind === 'get') {
    const params: BrapiRequestOptions['params'] = {
      ...(route.filters as Record<
        string,
        string | number | boolean | readonly (string | number)[] | undefined
      >),
    };
    params.pageSize = pageSize;
    if (page > 0) params.page = page;
    return await client.get<BrapiListResult<T> | T[]>(
      connection.baseUrl,
      route.path,
      ctx,
      buildRequestOptions(connection, params, requestOptions),
    );
  }

  const deadlineAt =
    requestOptions.deadlineMs === undefined ? undefined : Date.now() + requestOptions.deadlineMs;
  const body = { ...route.searchBody, pageSize, page };
  const response = await client.postSearch<BrapiListResult<T> | T[]>(
    connection.baseUrl,
    route.noun,
    body,
    ctx,
    buildRequestOptions(connection, undefined, requestOptions),
  );
  if (response.kind === 'sync') return response.envelope;
  // The poll gets what the POST left of the page's deadline, not a fresh one.
  const pollOptions =
    deadlineAt === undefined
      ? requestOptions
      : { ...requestOptions, deadlineMs: Math.max(0, deadlineAt - Date.now()) };
  return await client.getSearchResults<BrapiListResult<T> | T[]>(
    connection.baseUrl,
    route.noun,
    response.searchResultsDbId,
    ctx,
    buildRequestOptions(connection, { pageSize, page }, pollOptions),
  );
}

export interface SpillInput<T> {
  bridge: CanvasBridge;
  client: BrapiClient;
  connection: RegisteredServer;
  ctx: Context;
  filters: Record<string, unknown>;
  /** First-page rows already loaded. Avoids a re-fetch. */
  firstPage: T[];
  loadLimit: number;
  /**
   * Optional dialect-level per-row normalizer applied to each spilled page's
   * rows immediately after `extractRows` — used to coerce server-specific
   * "missing" encodings (e.g. SGN's `null` → `undefined`) into the canonical
   * shape the schemas expect. First-page rows are normalized by the loader
   * before they reach `spillToCanvas`; this is the parallel hook for the
   * page walk.
   */
  normalizeRow?: (row: T) => T;
  /**
   * Optional request overrides for spillover page pulls. The walk clips their
   * timeout to what remains of {@link SPILL_WALK_DEADLINE_MS} or the call
   * deadline, whichever ends first.
   */
  pageRequestOptions?: BrapiRequestOptions;
  path: string;
  /** Optional route selected by resolveFindRoute; defaults to GET path + filters. */
  route?: FindRoute;
  /**
   * Optional client-side predicate applied to every row (first-page + spilled)
   * before persistence. When present, only rows that pass are registered on
   * the canvas and returned in `fullRows`. The unfiltered upstream total is
   * preserved separately on the LoadedRows envelope so distributions and
   * headers can still report the true upstream size.
   */
  rowFilter?: (row: T) => boolean;
  /**
   * Optional client-side transform applied to every row (first-page + spilled)
   * before any predicate filter runs. Used to normalize sparse / duplicated
   * upstream payloads (e.g. dedup'ing CassavaBase's 11×-repeated synonym
   * arrays) so the in-context view and the canvas dataframe see the same
   * cleaned shape. Runs before `rowFilter`.
   */
  rowMapper?: (row: T) => T;
  source: string;
  /**
   * Total reported by the server on the first page; `undefined` when it
   * reported none, in which case the walk runs to an empty or short page.
   * When `firstPage` already holds the total, it is staged as-is with no page
   * request.
   */
  totalCount: number | undefined;
}

/** What a spill walk fetched, before any registration. */
interface SpillWalk<T> {
  /** Rows kept after `rowMapper` and `rowFilter`. */
  fullRows: T[];
  pagesFetched: number;
  /** The row cap ended the walk — the bound a truncated dataframe reports as `maxRows`. */
  reachedRowCap: boolean;
  /** Upstream rows the walk examined, before `rowFilter`. */
  rowsScanned: number;
  /** The walk examined every upstream row: it reached the total, or an empty or short page. */
  scanComplete: boolean;
  /**
   * Why the walk ended before the upstream total — a failed page, the time
   * budget, a page repeating the previous one, the row or page cap, or an
   * empty page short of the reported total.
   */
  stopReason?: string;
}

export interface SpillResult<T> extends SpillWalk<T> {
  /**
   * Absent when no row survived `rowFilter` (or the walk returned none) —
   * nothing to register. Marked truncated when the scan was incomplete.
   */
  dataframe?: RegisterDataframeResult;
}

/**
 * Shape of the dataframe handle returned inline by `find_*` tools. The
 * dataframe is the canvas table holding the matched rows `results[]` leaves out; query
 * it with `brapi_dataframe_query` for SQL access or describe it with
 * `brapi_dataframe_describe` for schema + provenance.
 */
export const DataframeHandleSchema = z.object({
  tableName: z
    .string()
    .describe('Table name for brapi_dataframe_describe and brapi_dataframe_query.'),
  rowCount: z.number().int().nonnegative().describe('Rows in the dataframe.'),
  columns: z.array(z.string().describe('Column name.')).describe('Every column name.'),
  columnLegend: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Sanitized column name → original upstream key, present only when a column was renamed to be SQL-safe (e.g. `end` → `end_`). SQL uses the sanitized names.',
    ),
  createdAt: z.string().describe('ISO 8601 creation time.'),
  expiresAt: z
    .string()
    .describe(
      'ISO 8601 time the dataframe metadata is purged; copy rows out before, or re-run the producing tool.',
    ),
  truncated: z
    .boolean()
    .optional()
    .describe(
      'True when the dataframe holds less than the upstream reports: a cap, failed page, deadline, or short upstream ended the pull, or it was skipped. warnings says which. Absent otherwise.',
    ),
  maxRows: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Row cap that ended the pull, present only when that cap fired.'),
  totalCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Upstream-reported row total, when known; can exceed rowCount.'),
});

export type DataframeHandle = z.infer<typeof DataframeHandleSchema>;

/**
 * Render a DataframeHandle as bullet lines, matching the existing find_* tool
 * format. Centralized so the truncated/maxRows fields surface consistently.
 * `expiresAt` is paired with a human-readable `expires in Xh / Xd` so the
 * agent doesn't have to subtract dates to know when the handle goes stale.
 *
 * This is a *summary* surface — it is not the authoritative carrier of the
 * schema, so `columns` is budgeted: it costs megabytes on a wide pivot (a
 * genotype matrix reaches 500,000 variant columns). The omission notice points
 * at `brapi_dataframe_query` (`SELECT * FROM <table> LIMIT 0` renders the full
 * column list, uncapped, in `content[]`) rather than at
 * `brapi_dataframe_describe`, whose own per-column listing is now budgeted the
 * same way — pointing a capped line at another capped line is circular.
 * `renamedColumns` is deliberately NOT budgeted — it is the only
 * mapping from a sanitized column back to its upstream key, with no describe
 * or re-call path behind it, and capping the sole decoder is the same defect as
 * capping the tool-level variant legend. It stays bounded in practice anyway:
 * real upstream rows carry at most a key or two needing a rename, and the two
 * matrix pivots pre-sanitize their keys before registration, so the field never
 * populates for them at all.
 */
export function renderDataframeHandle(handle: DataframeHandle): string[] {
  const { text: columns, omitted } = joinWithinBudget(handle.columns, MAX_LIST_LINE);
  const columnsSuffix =
    omitted > 0
      ? `, …+${omitted} more — list all columns via brapi_dataframe_query: \`SELECT * FROM ${handle.tableName} LIMIT 0\``
      : '';
  const lines = [
    `- tableName: \`${handle.tableName}\` (columns via brapi_dataframe_describe, rows via brapi_dataframe_query)`,
    `- rowCount: ${handle.rowCount}`,
    `- columns: ${columns}${columnsSuffix}`,
    `- createdAt: ${handle.createdAt}`,
    `- expiresAt: ${handle.expiresAt} (${formatExpiresIn(handle.expiresAt)})`,
  ];
  if (handle.columnLegend && Object.keys(handle.columnLegend).length > 0) {
    const pairs = Object.entries(handle.columnLegend)
      .map(([safe, original]) => `${safe} → ${original}`)
      .join(', ');
    lines.push(`- renamedColumns: ${pairs} (query using the left-hand names)`);
  }
  if (handle.truncated) lines.push(`- truncated: true`);
  if (typeof handle.maxRows === 'number') lines.push(`- maxRows: ${handle.maxRows}`);
  if (typeof handle.totalCount === 'number') lines.push(`- totalCount: ${handle.totalCount}`);
  return lines;
}

/**
 * Render an absolute `expiresAt` timestamp as a relative human label
 * (`expires in 24h`, `expires in 30m`, `expired 5m ago`). Coarsens to the
 * most useful unit so the value reads at a glance.
 */
export function formatExpiresIn(expiresAt: string, now: Date = new Date()): string {
  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(expiry)) return 'expiry unknown';
  const deltaMs = expiry - now.getTime();
  const absMs = Math.abs(deltaMs);
  const minutes = Math.round(absMs / 60_000);
  const hours = Math.round(absMs / 3_600_000);
  const days = Math.round(absMs / 86_400_000);
  let label: string;
  if (absMs < 60_000) label = '<1m';
  else if (minutes < 60) label = `${minutes}m`;
  else if (hours < 48) label = `${hours}h`;
  else label = `${days}d`;
  return deltaMs >= 0 ? `expires in ${label}` : `expired ${label} ago`;
}

/** Project a `RegisterDataframeResult` to the inline handle shape. */
export function toDataframeHandle(
  result: RegisterDataframeResult,
  totalCount?: number,
): DataframeHandle {
  const handle: DataframeHandle = {
    tableName: result.tableName,
    rowCount: result.rowCount,
    columns: result.columns,
    createdAt: result.createdAt,
    expiresAt: result.expiresAt,
  };
  if (result.columnLegend) handle.columnLegend = result.columnLegend;
  if (result.truncated) handle.truncated = true;
  if (typeof result.maxRows === 'number') handle.maxRows = result.maxRows;
  if (typeof totalCount === 'number') handle.totalCount = totalCount;
  return handle;
}

export interface MaybeSpillInput<T> {
  bridge: CanvasBridge;
  client: BrapiClient;
  connection: RegisteredServer;
  ctx: Context;
  filters: Record<string, unknown>;
  firstPage: LoadedRows<T>;
  /**
   * Optional reorder and projection of the matched rows before `results` is
   * cut from them — e.g. rank free-text matches first, strip empty containers.
   * Must return one row per input row. The inline bounds measure the rows it
   * returns, so a projection that shrinks rows stages nothing when the
   * projected set fits. The dataframe always holds the unprojected rows.
   */
  inlineView?: (rows: T[]) => T[];
  loadLimit: number;
  /**
   * Optional dialect-level per-row normalizer applied to each spilled page's
   * rows. Mirrors `SpillInput.normalizeRow` — forwarded verbatim. First-page
   * rows must already be normalized by the loader; this only catches the
   * page walk.
   */
  normalizeRow?: (row: T) => T;
  path: string;
  route?: FindRoute;
  /**
   * Optional client-side predicate applied to every row before persistence.
   * Forwarded to `spillToCanvas`. When present and no spillover happens, the
   * first-page rows are also filtered before being returned.
   */
  rowFilter?: (row: T) => boolean;
  /**
   * Optional client-side transform applied to every row (first-page + spilled)
   * before persistence and before any `rowFilter`. See {@link SpillInput.rowMapper}.
   */
  rowMapper?: (row: T) => T;
  source: string;
  /**
   * Optional request overrides for spillover page pulls. Useful when a tool
   * wants dataframe materialization to run under a tighter latency budget
   * than the first page. The walk clips their timeout to what remains of
   * {@link SPILL_WALK_DEADLINE_MS}.
   */
  spillRequestOptions?: BrapiRequestOptions;
  /** Receives the warning when the spill walk stops before the upstream total. */
  warnings?: string[];
}

export interface MaybeSpillResult<T> {
  /** Present whenever `results` is shorter than `fullRows`. */
  dataframe?: DataframeHandle;
  /** Row set after `rowFilter` (when supplied), spilled or first-page only. */
  fullRows: T[];
  /**
   * True when rows exist beyond `results`: matched rows the inline bounds cut,
   * or upstream rows the scan never examined.
   */
  hasMore: boolean;
  /** The bound that cut `results` short of `fullRows`; absent when every row fit. */
  inlineBound?: InlineBound;
  /**
   * Leading rows of `fullRows` — through `inlineView` when supplied — within
   * loadLimit and the inline byte budget.
   */
  results: T[];
  /**
   * Upstream rows examined before `rowFilter` — the spill walk's rows, or the
   * first page when no walk ran. Short of the upstream total (`scanComplete`
   * false), the scan was bounded and unexamined rows may still match.
   */
  rowsScanned: number;
  /**
   * Every upstream row was examined: the walk reached the reported total or,
   * with none reported, an empty or short page. A first page the caller kept
   * from walking is complete only when it holds the reported total.
   */
  scanComplete: boolean;
}

/**
 * Resolve a find_* call's full row set, its inline `results`, and its
 * dataframe. Walks the remaining pages when the first page shows more exist
 * (`firstPage.hasMore`); otherwise works from the first page alone. Stages a
 * dataframe only when the inline bounds cut `results` short of the kept rows,
 * so every kept row is inline or staged, never both in full. A walk that
 * stopped short of the upstream total adds a warning naming why; a dataframe
 * holding fewer rows than the upstream total is marked truncated.
 */
export async function maybeSpill<T extends Record<string, unknown>>(
  input: MaybeSpillInput<T>,
): Promise<MaybeSpillResult<T>> {
  const { firstPage, rowMapper, rowFilter } = input;
  const selectInline = (rows: T[]) =>
    selectInlineRows(input.inlineView ? input.inlineView(rows) : rows, input.loadLimit);
  const spillInput: SpillInput<T> = {
    bridge: input.bridge,
    client: input.client,
    connection: input.connection,
    path: input.path,
    filters: input.filters,
    source: input.source,
    loadLimit: input.loadLimit,
    ctx: input.ctx,
    firstPage: firstPage.rows,
    totalCount: firstPage.totalCount,
  };
  if (rowMapper) spillInput.rowMapper = rowMapper;
  if (rowFilter) spillInput.rowFilter = rowFilter;
  if (input.normalizeRow) spillInput.normalizeRow = input.normalizeRow;
  if (input.route) spillInput.route = input.route;
  if (input.spillRequestOptions) spillInput.pageRequestOptions = input.spillRequestOptions;

  const walk: SpillWalk<T> = firstPage.hasMore
    ? await walkSpillPages(spillInput)
    : {
        fullRows: applyRowTransforms(firstPage.rows, rowMapper, rowFilter),
        pagesFetched: 1,
        reachedRowCap: false,
        rowsScanned: firstPage.rows.length,
        scanComplete:
          firstPage.totalCount === undefined || firstPage.rows.length >= firstPage.totalCount,
      };

  const inline = selectInline(walk.fullRows);
  const dataframe = inline.bound ? await registerSpillRows(spillInput, walk) : undefined;
  const warning = noteSpillStop(
    input.ctx,
    input.source,
    { ...walk, ...(dataframe ? { dataframe } : {}) },
    firstPage.totalCount,
  );
  if (warning) input.warnings?.push(warning);

  const result: MaybeSpillResult<T> = {
    fullRows: walk.fullRows,
    results: inline.rows,
    hasMore: inline.rows.length < walk.fullRows.length || !walk.scanComplete,
    rowsScanned: walk.rowsScanned,
    scanComplete: walk.scanComplete,
  };
  if (inline.bound) result.inlineBound = inline.bound;
  if (dataframe) result.dataframe = toDataframeHandle(dataframe, firstPage.totalCount);
  return result;
}

/**
 * Log a spill walk that ended before the upstream total and return the
 * caller-facing warning for it; `undefined` when the walk ran to the end.
 */
export function noteSpillStop(
  ctx: Context,
  source: string,
  spill: Pick<SpillResult<unknown>, 'dataframe' | 'fullRows' | 'rowsScanned' | 'stopReason'>,
  upstreamTotal: number | undefined,
): string | undefined {
  if (!spill.stopReason) return;
  ctx.log.warning('Spill walk stopped before the upstream total', {
    source,
    rowsScanned: spill.rowsScanned,
    totalCount: upstreamTotal,
    stopReason: spill.stopReason,
  });
  const scanned =
    upstreamTotal === undefined
      ? `${spill.rowsScanned} upstream row(s) (the upstream reported no total)`
      : `${spill.rowsScanned} of ${upstreamTotal} upstream row(s)`;
  const staged = spill.dataframe
    ? 'The dataframe holds the rows fetched so far and is marked truncated'
    : spill.fullRows.length > 0
      ? 'results[] holds every row fetched'
      : 'No dataframe was staged: no fetched row matched';
  return `Dataframe walk stopped after ${scanned}: ${spill.stopReason}. ${staged}; narrow the filters or retry the call.`;
}

/**
 * Apply mapper before filter on a row set. Centralizes the order constraint
 * across the three spillover sites — early-exit, error fallback, and persist
 * — so they can't drift apart and accidentally filter raw rows the spilled
 * dataframe has already normalized.
 */
function applyRowTransforms<T>(
  rows: T[],
  mapper: ((row: T) => T) | undefined,
  filter: ((row: T) => boolean) | undefined,
): T[] {
  const mapped = mapper ? rows.map(mapper) : rows;
  return filter ? mapped.filter(filter) : mapped;
}

/**
 * Pull every remaining page up to the MAX_SPILLOVER_* caps and
 * {@link SPILL_WALK_DEADLINE_MS} (or the call deadline, when it ends first),
 * then materialize the union as a canvas dataframe. Returns the dataframe
 * metadata plus the full row set (so callers can compute honest distributions
 * from the whole result) and the pre-filter scanned count. Registers nothing
 * when no row survives. See {@link walkSpillPages} for when the walk stops.
 */
export async function spillToCanvas<T extends Record<string, unknown>>(
  input: SpillInput<T>,
): Promise<SpillResult<T>> {
  const walk = await walkSpillPages(input);
  const dataframe = await registerSpillRows(input, walk);
  return dataframe ? { ...walk, dataframe } : walk;
}

/**
 * Register a walk's kept rows as a dataframe, marked truncated when the scan
 * stopped short of the upstream total (`maxRows` only when the row cap did).
 * Returns `undefined` for an empty row set: it has no columns, and the canvas
 * cannot create a zero-column table.
 */
async function registerSpillRows<T extends Record<string, unknown>>(
  input: SpillInput<T>,
  walk: SpillWalk<T>,
): Promise<RegisterDataframeResult | undefined> {
  if (walk.fullRows.length === 0) return;
  const registerInput: RegisterDataframeInput = {
    source: input.source,
    baseUrl: input.connection.baseUrl,
    query: input.filters,
    rows: walk.fullRows,
  };
  if (!walk.scanComplete) {
    registerInput.truncated = true;
    // The page cap stops a small-pageSize walk well below the row cap, so
    // `maxRows` is set only when the row cap is the bound that fired.
    if (walk.reachedRowCap) registerInput.maxRows = MAX_SPILLOVER_ROWS;
  }
  return await input.bridge.registerDataframe(input.ctx, registerInput);
}

/**
 * Walk the pages after the first. With a reported total, the walk keeps
 * requesting pages while they return rows and the total is unreached, so an
 * upstream that caps pageSize below the requested one is walked to the end;
 * with none reported, it stops at the first empty or short page
 * ({@link isFullPage}). A failed page, the time budget, a page repeating the
 * previous one, the row or page cap, or an empty page short of the reported
 * total ends it early: the rows fetched so far are kept and `stopReason` says
 * why. Caller cancellation rejects instead.
 */
async function walkSpillPages<T extends Record<string, unknown>>(
  input: SpillInput<T>,
): Promise<SpillWalk<T>> {
  const config = getServerConfig();
  const total = input.totalCount;
  const target = Math.min(total ?? Number.POSITIVE_INFINITY, MAX_SPILLOVER_ROWS);
  const pageSize = config.pageSize;
  const holdsAll = total !== undefined && input.firstPage.length >= total;

  // When pageSize differs from the first-page fetch size (loadLimit), the
  // BrAPI page=1 offset jumps to pageSize rows in — skipping rows loadLimit..pageSize-1.
  // Re-fetch from page 0 at pageSize to keep offsets consistent. Reuse
  // firstPage when it already holds every row, or when loadLimit === pageSize
  // (offsets already aligned).
  const reuseFirstPage = holdsAll || input.loadLimit === pageSize;
  let rows: T[] = reuseFirstPage ? [...input.firstPage] : [];
  let pagesFetched = reuseFirstPage ? 1 : 0;
  let stopReason: string | undefined;
  const route = input.route ?? getRouteForPath(input.path, input.filters);
  const walkDeadlineAt = Date.now() + SPILL_WALK_DEADLINE_MS;
  const callAt = callDeadlineAt(input.ctx);
  const deadlineAt = Math.min(walkDeadlineAt, callAt);
  const baseTimeoutMs = input.pageRequestOptions?.timeoutMs ?? config.requestTimeoutMs;
  const budgetLabel =
    callAt < walkDeadlineAt
      ? `this call's ${CALL_DEADLINE_MS / 1000} s deadline for upstream requests`
      : `the ${SPILL_WALK_DEADLINE_MS / 1000} s dataframe walk time budget`;
  let previousFirstRow = reuseFirstPage ? firstRowKey(input.firstPage) : undefined;
  /** An empty page, or with no reported total a short one: the upstream has no rows past it. */
  let reachedEnd = holdsAll;
  let page = pagesFetched;

  for (; !holdsAll && rows.length < target; page++) {
    if (page >= MAX_SPILLOVER_PAGES) break;
    if (input.ctx.signal.aborted) {
      throw requestCancelled('Dataframe walk cancelled by the caller.', { source: input.source });
    }
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      stopReason = `${budgetLabel} ran out before page ${page}`;
      break;
    }
    const clippedByBudget = remainingMs < baseTimeoutMs;
    let envelope: BrapiEnvelope<BrapiListResult<T> | T[]>;
    try {
      envelope = await fetchFindRoutePage<T>(
        input.client,
        input.connection,
        route,
        pageSize,
        page,
        input.ctx,
        {
          ...input.pageRequestOptions,
          timeoutMs: Math.min(baseTimeoutMs, remainingMs),
          deadlineMs: remainingMs,
          retryOnTimeout: false,
        },
      );
    } catch (err) {
      if (input.ctx.signal.aborted) throw err;
      stopReason = isBudgetTimeout(err, clippedByBudget)
        ? `${budgetLabel} ran out during page ${page}`
        : `page ${page} failed (${formatSpillError(err)})`;
      break;
    }
    let pageRows = extractRows<T>(envelope.result);
    if (pageRows.length === 0) {
      reachedEnd = true;
      break;
    }
    if (input.normalizeRow) pageRows = pageRows.map(input.normalizeRow);
    const firstRow = firstRowKey(pageRows);
    if (firstRow === previousFirstRow) {
      stopReason = `page ${page} repeated the previous page, so the upstream server is not paging this route`;
      break;
    }
    previousFirstRow = firstRow;
    rows.push(...pageRows);
    pagesFetched += 1;
    if (
      total === undefined &&
      !isFullPage(pageRows.length, pageSize, envelope.metadata?.pagination)
    ) {
      reachedEnd = true;
      break;
    }
  }

  // A walk that stopped before passing the in-memory first page stages that page:
  // both are prefixes of the same upstream order.
  if (rows.length < input.firstPage.length) rows = [...input.firstPage];

  const scanComplete = total === undefined ? reachedEnd : rows.length >= total;
  const reachedRowCap = !scanComplete && rows.length >= MAX_SPILLOVER_ROWS;
  if (!scanComplete && !stopReason) {
    if (reachedRowCap) {
      stopReason = `the ${MAX_SPILLOVER_ROWS.toLocaleString('en-US')}-row dataframe cap was reached`;
    } else if (reachedEnd) {
      stopReason = `page ${page} came back empty, short of the reported totalCount`;
    } else {
      stopReason = `the ${MAX_SPILLOVER_PAGES}-page walk cap was reached`;
    }
  }

  const walk: SpillWalk<T> = {
    fullRows: applyRowTransforms(rows, input.rowMapper, input.rowFilter),
    pagesFetched,
    reachedRowCap,
    rowsScanned: rows.length,
    scanComplete,
  };
  if (stopReason) walk.stopReason = stopReason;
  return walk;
}

/** Identity of a page by its first row — equal keys on consecutive pages mean `page` was ignored. */
export function firstRowKey(rows: readonly unknown[]): string | undefined {
  return rows.length > 0 ? JSON.stringify(rows[0]) : undefined;
}

/**
 * A page timeout the walk's own budget caused: its timeout was clipped to the
 * budget, or a deadline (the walk's, as `retry_deadline_exceeded`, or the
 * call's) expired across its retries or async-search polls.
 */
function isBudgetTimeout(err: unknown, clippedByBudget: boolean): boolean {
  if (!(err instanceof McpError) || err.code !== JsonRpcErrorCode.Timeout) return false;
  const reason = err.data?.reason;
  return clippedByBudget || reason === 'retry_deadline_exceeded' || reason === CALL_DEADLINE_REASON;
}

function formatSpillError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err.length > 0) return err;
  return 'upstream page fetch failed';
}

function getRouteForPath(path: string, filters: Record<string, unknown>): FindRoute {
  return {
    kind: 'get',
    path,
    service: path.replace(/^\/+/, ''),
    filters,
  };
}

/** BrAPI list endpoints return `{data: T[], ...}`. Some omit the wrapper. */
export interface BrapiListResult<T> {
  data?: T[];
  [key: string]: unknown;
}

export function extractRows<T>(result: BrapiListResult<T> | T[]): T[] {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.data)) return result.data;
  return [];
}

/**
 * Extract a homogeneous record-row set from a raw BrAPI envelope `result`.
 * Returns the array when `result` is itself a list of objects, or when
 * `result.data` is — covering both bare-array and BrAPI-list-envelope shapes.
 * Returns `null` for non-list shapes (single object, scalar, primitive
 * arrays) so callers — notably `raw_get` / `raw_search` — can skip spillover
 * and pass the upstream payload through unchanged. Empty arrays are list-
 * shaped but carry no rows; the caller uses `length === 0` to decide whether
 * to register a dataframe.
 */
export function extractListRows<T extends Record<string, unknown>>(result: unknown): T[] | null {
  const candidate: unknown[] | null = Array.isArray(result)
    ? result
    : result && typeof result === 'object' && Array.isArray((result as { data?: unknown }).data)
      ? (result as { data: unknown[] }).data
      : null;
  if (candidate === null) return null;
  if (candidate.length === 0) return [];
  const allObjects = candidate.every(
    (row) => typeof row === 'object' && row !== null && !Array.isArray(row),
  );
  return allObjects ? (candidate as T[]) : null;
}

/** Return the input as a non-empty string, or undefined. Used in distribution accessors. */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Drop entries from a `synonyms` array that are structurally identical to an
 * entry already kept. Some Breedbase deployments (notably CassavaBase) return
 * each registered synonym repeated 11× per germplasm record — the bloat is
 * purely upstream and carries no information beyond the unique set.
 *
 * Identity is taken via a stable serialization (keys sorted recursively) so
 * that two entries with the same fields but different property insertion
 * order are recognized as duplicates — observed live: CassavaBase emits two
 * key orderings on the same record. Two entries that genuinely differ on
 * any field (e.g. same `synonym` text but different `type`) still hash to
 * distinct keys and are both kept. When no duplicates are present the
 * input row is returned by reference — the helper is allocation-free on
 * the common case.
 */
export function dedupSynonymsByIdentity<T extends Record<string, unknown>>(row: T): T {
  if (!Array.isArray(row.synonyms)) return row;
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const entry of row.synonyms) {
    const key = stableStringify(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  if (out.length === row.synonyms.length) return row;
  return { ...row, synonyms: out };
}

/**
 * Order-invariant `JSON.stringify` for structural identity hashing. Sorts
 * object keys recursively so insertion order doesn't affect the output.
 * Arrays preserve element order — order is semantically meaningful there.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Return the input as a non-empty string array, or undefined. */
export function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return;
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/**
 * Axis interpretation for GeoJSON Point coordinates:
 *   - `spec` — RFC 7946 standard `[lon, lat, alt?]` (default)
 *   - `swapped` — non-conformant `[lat, lon, alt?]` deployments (e.g. the
 *     BrAPI Community Test Server). `find_locations` falls back to this
 *     reading when a bbox filter under spec ordering returns zero matches.
 */
export type CoordinateAxisOrder = 'spec' | 'swapped';

/**
 * Extract WGS84 coordinates from a BrAPI v2 record. Modern servers carry
 * coordinates as a GeoJSON Feature (`coordinates.geometry.coordinates =
 * [lon, lat, alt?]`); some legacy and mixed-mode servers also expose
 * top-level `latitude`/`longitude`/`altitude`. Returns `undefined` only
 * when both shapes are missing or malformed. Accepts `unknown` so callers
 * can pass Zod-passthrough rows without an explicit cast.
 *
 * `axisOrder` controls how a GeoJSON `Point.coordinates` array is read.
 * Legacy top-level `latitude`/`longitude` fields are unambiguous by name
 * and are not affected.
 */
export function extractCoordinates(
  record: unknown,
  axisOrder: CoordinateAxisOrder = 'spec',
): { latitude: number; longitude: number; altitude?: number } | undefined {
  if (typeof record !== 'object' || record === null) return;
  const r = record as Record<string, unknown>;
  const geometry = (r.coordinates as { geometry?: unknown } | null | undefined)?.geometry;
  const geoCoords = (geometry as { coordinates?: unknown } | null | undefined)?.coordinates;
  if (Array.isArray(geoCoords) && geoCoords.length >= 2) {
    const [a, b, alt] = geoCoords;
    if (typeof a === 'number' && typeof b === 'number') {
      const [lon, lat] = axisOrder === 'spec' ? [a, b] : [b, a];
      const result: { latitude: number; longitude: number; altitude?: number } = {
        latitude: lat,
        longitude: lon,
      };
      if (typeof alt === 'number') result.altitude = alt;
      return result;
    }
  }
  const lat = r.latitude;
  const lon = r.longitude;
  if (typeof lat === 'number' && typeof lon === 'number') {
    const result: { latitude: number; longitude: number; altitude?: number } = {
      latitude: lat,
      longitude: lon,
    };
    const alt = r.altitude;
    if (typeof alt === 'number') result.altitude = alt;
    return result;
  }
  return;
}

/**
 * True when a BrAPI record carries a GeoJSON `Point` geometry with a
 * 2- or 3-element numeric coordinate array. Used by the bbox swap-on-zero
 * heuristic to decide whether retrying with axes swapped is worth doing —
 * Polygon-only or geometry-less rows can't be reinterpreted.
 */
export function hasPointGeometry(record: unknown): boolean {
  if (typeof record !== 'object' || record === null) return false;
  const r = record as Record<string, unknown>;
  const geometry = (r.coordinates as { geometry?: unknown } | null | undefined)?.geometry;
  if (!geometry || typeof geometry !== 'object') return false;
  const g = geometry as { type?: unknown; coordinates?: unknown };
  if (g.type !== 'Point') return false;
  return (
    Array.isArray(g.coordinates) &&
    g.coordinates.length >= 2 &&
    typeof g.coordinates[0] === 'number' &&
    typeof g.coordinates[1] === 'number'
  );
}

/**
 * One filter → distribution mapping for `checkFilterMatchRates`. Used to
 * detect upstream servers that silently ignore a filter and return the
 * unfiltered set instead of the requested subset.
 */
export interface FilterMatchCheck {
  /** Compare case-insensitively (default: false). */
  caseInsensitive?: boolean;
  /** Distribution computed from the returned rows for the corresponding field. */
  distribution: Record<string, number>;
  /** User-facing filter name (e.g. "seasons"). Surfaces in the warning. */
  paramName: string;
  /** Requested values from the agent. Undefined or empty means skip this check. */
  requestedValues: readonly (string | number | boolean)[] | undefined;
  /**
   * Warn when any returned row carries a value outside the requested set.
   * Equality filters should usually set this because one matching row is not
   * enough evidence that the upstream honored the filter.
   */
  requireEveryRowMatch?: boolean;
}

/**
 * Verify that requested filter values appear in the returned distributions.
 * When the upstream silently drops a filter, all requested values miss the
 * distribution — the warning lets the agent (and the user) know the result
 * set may not actually match the query. Skips checks where the distribution
 * is empty (no signal) or where no values were requested.
 */
export function checkFilterMatchRates(
  warnings: string[],
  fullRowCount: number,
  checks: readonly FilterMatchCheck[],
): void {
  if (fullRowCount === 0) return;
  for (const check of checks) {
    if (!check.requestedValues || check.requestedValues.length === 0) continue;
    const distKeys = Object.keys(check.distribution);
    if (distKeys.length === 0) continue;

    const norm = (v: string) => (check.caseInsensitive ? v.toLowerCase() : v);
    const haystack = new Set(distKeys.map(norm));
    const requested = new Set(check.requestedValues.map((v) => norm(String(v))));
    const matched = [...requested].some((v) => haystack.has(v));
    if (matched && check.requireEveryRowMatch) {
      const unexpectedCount = Object.entries(check.distribution).reduce(
        (sum, [value, count]) => (requested.has(norm(value)) ? sum : sum + count),
        0,
      );
      if (unexpectedCount > 0) {
        const sample = distKeys
          .filter((v) => !requested.has(norm(v)))
          .slice(0, 5)
          .join(', ');
        const overflow = distKeys.filter((v) => !requested.has(norm(v))).length > 5 ? ', …' : '';
        warnings.push(
          `Filter '${check.paramName}' requested ${JSON.stringify(check.requestedValues)} but ${unexpectedCount} returned row(s) carried other values (${sample}${overflow}) — the server may not honor this filter.`,
        );
      }
      continue;
    }
    if (matched) continue;

    const sample = distKeys.slice(0, 5).join(', ');
    const overflow = distKeys.length > 5 ? `, …+${distKeys.length - 5} more` : '';
    warnings.push(
      `Filter '${check.paramName}' requested ${JSON.stringify(check.requestedValues)} but no returned row matches — the server may not honor this filter. Observed values: ${sample}${overflow}.`,
    );
  }
}

/**
 * Build a `FilterMatchCheck` for an FK identifier filter — the user's input
 * values are compared against a fresh distribution computed over `fieldName`
 * on the returned rows. Surfaces silently-ignored FK filters as warnings
 * without polluting the public `result.distributions` shape with raw DbId
 * frequencies (which carry no semantic meaning to the agent).
 */
export function fkMatchCheck(
  paramName: string,
  requestedValues: readonly (string | number | boolean)[] | undefined,
  rows: readonly Record<string, unknown>[],
  fieldName: string,
  options: { requireEveryRowMatch?: boolean } = {},
): FilterMatchCheck {
  return {
    paramName,
    requestedValues,
    distribution: computeDistribution(rows, (r) => asString(r[fieldName])),
    ...options,
  };
}

/**
 * Generate `FilterMatchCheck` entries for every key in `extraFilters` that
 * can be cross-referenced against a top-level column on the returned rows.
 * Catches the wrong-results class of bug where the agent passes a filter the
 * upstream silently ignores (e.g. `locationName` on `/studies` — not a valid
 * filter key, server returns the unfiltered baseline). The named-param
 * verification path treats requested values as authoritative; this helper
 * extends that same check across `extraFilters` so the post-hoc validator
 * runs uniformly regardless of how the filter entered the call.
 *
 * Column inference is intentionally narrow — exact match, then a trailing-`s`
 * strip (`locationDbIds → locationDbId`, `locationNames → locationName`).
 * Keys that don't resolve to a column produce a single grouped warning
 * ("could not verify these extraFilters keys: …") so the agent knows the
 * trace can't speak to whether they were honored.
 */
export function buildExtraFilterChecks(
  extraFilters: Record<string, unknown> | undefined,
  rows: readonly Record<string, unknown>[],
  warnings: string[],
): FilterMatchCheck[] {
  if (!extraFilters) return [];
  const checks: FilterMatchCheck[] = [];
  const unverified: string[] = [];
  const sample = rows[0];
  for (const [key, value] of Object.entries(extraFilters)) {
    if (value == null) continue;
    const requested = toRequestedValues(value);
    if (!requested) continue;
    const field = sample ? inferRowField(key, sample) : undefined;
    if (!field) {
      unverified.push(key);
      continue;
    }
    checks.push({
      paramName: `extraFilters.${key}`,
      requestedValues: requested,
      distribution: computeDistribution(rows, (r) => asString(r[field])),
      caseInsensitive: true,
      requireEveryRowMatch: true,
    });
  }
  if (unverified.length > 0) {
    warnings.push(
      `Could not verify these extraFilters keys against returned rows: ${unverified.map((k) => `'${k}'`).join(', ')}. The server may have silently ignored them — check brapi_describe_filters for the valid filter keys on this endpoint.`,
    );
  }
  return checks;
}

function toRequestedValues(value: unknown): readonly (string | number | boolean)[] | undefined {
  const candidates = Array.isArray(value) ? value : [value];
  const scalars = candidates.filter(
    (v): v is string | number | boolean =>
      typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
  );
  return scalars.length > 0 ? scalars : undefined;
}

function inferRowField(filterKey: string, sample: Record<string, unknown>): string | undefined {
  if (filterKey in sample) return filterKey;
  if (filterKey.endsWith('s')) {
    const candidate = filterKey.slice(0, -1);
    if (candidate in sample) return candidate;
  }
  return;
}

export interface RefinementHintOptions {
  /**
   * Filter parameter names available on the calling tool. Used to suggest
   * concrete narrowers when no distribution has enough cardinality to
   * pick a specific value. Skipped when omitted.
   */
  availableFilters?: readonly string[];
}

/**
 * Compose a refinement hint from where a `find_*` call's matched rows ended up.
 * With every matched row in a complete dataframe, the hint points there: SQL
 * narrows the set without a re-pull. With a truncated dataframe, or a scan that
 * stopped short of the upstream total, it suggests narrowing the filters — the
 * highest-cardinality distribution's top value, else the tool's filter names.
 * Returns undefined when `results[]` holds every matched row of a complete
 * scan, a zero-match scan included. Never suggests raising `loadLimit`: it
 * bounds `results[]`, not how much of the upstream set is scanned or staged.
 */
export function buildRefinementHint(
  spill: Pick<MaybeSpillResult<unknown>, 'dataframe' | 'fullRows' | 'scanComplete'>,
  distributions: Record<string, Record<string, number>>,
  options: RefinementHintOptions = {},
): string | undefined {
  const { dataframe } = spill;
  if (!dataframe && spill.scanComplete) return;
  let best: { field: string; topValue: string; count: number; cardinality: number } | undefined;
  for (const [field, counts] of Object.entries(distributions)) {
    const entries = Object.entries(counts);
    if (entries.length < 2) continue;
    const top = entries[0];
    if (!top) continue;
    const [topValue, count] = top;
    if (!best || entries.length > best.cardinality) {
      best = { field, topValue, count, cardinality: entries.length };
    }
  }
  if (dataframe && !dataframe.truncated) {
    const example = best
      ? ` — the ${best.field} distribution spans ${best.cardinality} values, and \`${best.topValue}\` covers ${best.count} row(s)`
      : '';
    return `All ${spill.fullRows.length} matched rows are in dataframe \`${dataframe.tableName}\`: narrow them there with brapi_dataframe_query rather than re-pulling${example}.`;
  }
  const where = dataframe
    ? `Dataframe \`${dataframe.tableName}\` is partial`
    : 'Unscanned upstream rows may still match';
  const lead = `${where}: the scan stopped before the upstream total (see warnings). Narrow the filters`;
  if (best) {
    return `${lead} — the ${best.field} distribution spans ${best.cardinality} values, and narrowing to \`${best.topValue}\` would cut to ~${best.count} row(s).`;
  }
  if (options.availableFilters && options.availableFilters.length > 0) {
    return `${lead} — try ${options.availableFilters.map((f) => `\`${f}\``).join(', ')}.`;
  }
  return `${lead}.`;
}

/**
 * Inline JSON over this many characters renders as a `<N keys, Xkb — …>`
 * placeholder instead of the raw stringified value. Picked to keep a single
 * bulleted row under one display line while still showing small objects
 * (`{traitDbId: "...", traitName: "..."}`) inline. Rendering every oversized
 * value in full is not an option at the row scale these helpers run at — a
 * `loadLimit`-sized page of GeoJSON-heavy rows reaches megabytes, and
 * `content[]` carries it a second time on top of `structuredContent`.
 */
const MAX_INLINE_JSON = 240;

/**
 * Render a value for the row/line passthrough surface. Scalars are stringified
 * via `String(value)`; objects/arrays are JSON-encoded and replaced with a
 * size-aware placeholder when they exceed {@link MAX_INLINE_JSON}.
 *
 * When the caller's result spilled, the placeholder names the dataframe rather
 * than `structuredContent`. That matters for correctness, not just wording:
 * the dataframe stores the value untruncated (object-shaped columns register
 * as DuckDB `JSON` and round-trip through `JSON.stringify`), and
 * `brapi_dataframe_query` reaches it from a content-only client — which
 * `structuredContent` never does. Callers whose rows are not in a dataframe
 * (the `get_*` detail tools, `get_germplasm`'s parent/attribute companions)
 * must pass nothing: pointing those at a dataframe would name a table that
 * does not contain the record.
 */
function renderPassthroughValue(value: unknown, dataframe?: DataframeHandle): string {
  if (typeof value !== 'object') return String(value);
  const json = JSON.stringify(value);
  if (json.length <= MAX_INLINE_JSON) return json;
  const kb = (json.length / 1024).toFixed(1);
  const size = Array.isArray(value)
    ? `${value.length} entries`
    : `${Object.keys(value as Record<string, unknown>).length} keys`;
  const where = dataframe
    ? `query \`${dataframe.tableName}\` via brapi_dataframe_query`
    : 'see structuredContent';
  return `<${size}, ${kb}KB — ${where}>`;
}

/**
 * Collect `key=value` strings for every top-level key in a passthrough row
 * that was not explicitly rendered by the caller. Ensures format() /
 * structuredContent parity — server fields beyond the declared schema are
 * still emitted to text-only clients (Claude Desktop sees content[] only).
 * Large nested objects (over `MAX_INLINE_JSON` chars when stringified) collapse
 * to a size-aware placeholder.
 *
 * `dataframe` is the calling `find_*` result's handle, when it spilled — the
 * rows rendered inline are a prefix of the rows it holds, so the placeholder
 * can name it as the retrieval path. Omit it for records the dataframe does
 * not contain.
 */
export function collectPassthroughParts(
  row: Record<string, unknown>,
  renderedKeys: ReadonlySet<string>,
  dataframe?: DataframeHandle,
): string[] {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(row)) {
    if (renderedKeys.has(key) || value === undefined || value === null) continue;
    parts.push(`${key}=${renderPassthroughValue(value, dataframe)}`);
  }
  return parts;
}

/**
 * Append `- **key:** value` lines for every top-level key in a passthrough
 * record that was not explicitly rendered. Companion to
 * `collectPassthroughParts` for detail-view (get_*) tools that use a
 * line-per-field layout instead of bullet-part lists. Honors the same inline
 * JSON cap.
 *
 * Takes no dataframe: its three callers (`get_study`, `get_germplasm`,
 * `get_image`) fetch a single record by ID and never register one, so an
 * oversized field on those tools still resolves only to `structuredContent`.
 * Re-calling the sibling `get_*` tool is not a recovery path for a `find_*`
 * row either — that lands back on this helper and re-renders the same
 * placeholder. Closing that gap needs a mechanism these helpers do not have
 * (see the `outline-on-overflow` technique, which suits the single-document
 * shape of the `get_*` tools).
 */
export function appendPassthroughLines(
  lines: string[],
  record: Record<string, unknown>,
  renderedKeys: ReadonlySet<string>,
): void {
  for (const [key, value] of Object.entries(record)) {
    if (renderedKeys.has(key) || value === undefined || value === null) continue;
    lines.push(`- **${key}:** ${renderPassthroughValue(value)}`);
  }
}

export type { BrapiEnvelope, BrapiPagination, ResolvedAuth, ServerConfig };
