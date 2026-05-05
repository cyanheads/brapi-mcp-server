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
import { JsonRpcErrorCode, McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import type { ServerConfig } from '@/config/server-config.js';
import type {
  BrapiClient,
  BrapiEnvelope,
  BrapiPagination,
  BrapiRequestOptions,
  ResolvedAuth,
} from '@/services/brapi-client/index.js';
import type { BrapiDialect } from '@/services/brapi-dialect/index.js';
import type {
  CanvasBridge,
  RegisterDataframeInput,
  RegisterDataframeResult,
} from '@/services/canvas-bridge/index.js';
import type { CapabilityProfile } from '@/services/capability-registry/types.js';
import type { RegisteredServer } from '@/services/server-registry/index.js';

/** True when the thrown value is an upstream 404 surfaced by the BrAPI client. */
export function isUpstreamNotFound(err: unknown): boolean {
  return err instanceof McpError && err.code === JsonRpcErrorCode.NotFound;
}

/** Upper cap on how many rows we'll pull for canvas dataframe spillover per call. */
export const MAX_SPILLOVER_ROWS = 50_000;

/** Hard cap on how many BrAPI pages we'll traverse when building a dataframe. */
export const MAX_SPILLOVER_PAGES = 50;

export const AliasInput = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+$/)
  .optional()
  .describe('Connection alias registered via brapi_connect. Omit to use the default connection.');

export const LoadLimitInput = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(
    'Cap on rows returned inline. Omit for the deployment default — sized so spillover reaches its full row-count ceiling. Rows beyond the cap land in a dataframe; query with brapi_dataframe_query (SQL) instead of paging row-by-row. Heads-up: this same value drives the upstream pageSize during spillover walks, so lowering it to "preview a smaller sample" also shrinks the dataframe ceiling proportionally — prefer SQL `LIMIT` on the dataframe for sampling instead.',
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
 * contract; the helper looks up the recovery hint via `ctx.recoveryFor` and
 * spreads it into `data` so the wire-level shape stays consistent across the
 * find_* surface. The bare-baseline call (no filters supplied) is exempt:
 * `dropped` is empty so the all-dropped predicate is false.
 */
export function applyDialectFiltersOrFail(
  ctx: HandlerContext<'all_filters_dropped'>,
  dialect: BrapiDialect,
  endpoint: string,
  filters: Readonly<Record<string, unknown>>,
  warnings: string[],
): Record<string, unknown> {
  const adapted = dialect.adaptGetFilters(endpoint, filters);
  warnings.push(...adapted.warnings);
  if (adapted.dropped.length > 0 && Object.keys(adapted.filters).length === 0) {
    throw ctx.fail(
      'all_filters_dropped',
      `Every filter you supplied was dropped by the ${dialect.id} dialect (${adapted.dropped.join(', ')}); the call would silently widen to the unfiltered baseline.`,
      {
        ...ctx.recoveryFor('all_filters_dropped'),
        dropped: adapted.dropped,
        dialect: dialect.id,
      },
    );
  }
  return adapted.filters;
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
 */
export function resolveFindRoute(input: ResolveFindRouteInput): FindRoute {
  const service = input.service ?? input.endpoint;
  const path = `/${input.endpoint}`;
  const searchNoun = input.searchNoun ?? input.endpoint;
  const searchService = `search/${searchNoun}`;
  const getDescriptor = input.profile.supported[service];
  const searchDescriptor = input.profile.supported[searchService];
  const getSupported = supportsMethod(getDescriptor, 'GET');
  const searchSupported = supportsMethod(searchDescriptor, 'POST');
  const searchDisabled = Boolean(input.dialect.disabledSearchEndpoints?.has(searchNoun));

  if (getSupported) {
    return { kind: 'get', service, path, filters: input.filters };
  }

  if (searchSupported && !searchDisabled) {
    input.warnings.push(
      `Route selected: POST /search/${searchNoun} because GET ${path} was not advertised by this server.`,
    );
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
  totalCount: number;
  dataframe?: { rowCount: number; expiresAt?: string } | undefined;
}): string {
  if (opts.dataframe) {
    const expiry = opts.dataframe.expiresAt
      ? ` (${formatExpiresIn(opts.dataframe.expiresAt)})`
      : '';
    return `# ${opts.returnedCount} returned · ${opts.dataframe.rowCount} in dataframe${expiry} · ${opts.totalCount} total ${opts.noun} — \`${opts.alias}\``;
  }
  return `# ${opts.returnedCount} of ${opts.totalCount} ${opts.noun} — \`${opts.alias}\``;
}

/**
 * Render the filters-sent-to-server block, optionally translating
 * server-side keys to the user-facing parameter names declared by the
 * tool. Server keys without a user-facing alias (e.g. anything from
 * `extraFilters`) are rendered as-is. The label deliberately says "sent
 * to server" rather than "applied" — this is the wire-shape payload, not
 * a verified honor list. Drift between requested and honored values
 * surfaces in the warnings produced by `checkFilterMatchRates`.
 */
export function renderAppliedFilters(
  filters: Record<string, unknown>,
  serverToUser: Record<string, string> = {},
): string {
  const entries = Object.entries(filters);
  if (entries.length === 0) return 'Filters sent to server: `{}`';
  const lines: string[] = ['Filters sent to server:'];
  for (const [serverKey, value] of entries) {
    const userKey = serverToUser[serverKey];
    const label = userKey ? `${userKey} → ${serverKey}` : serverKey;
    lines.push(`- \`${label}\`: ${JSON.stringify(value)}`);
  }
  return lines.join('\n');
}

/** Cheap sanity-render for a distributions block in markdown. */
export function renderDistributions(distributions: Record<string, Record<string, number>>): string {
  const lines: string[] = [];
  for (const [field, counts] of Object.entries(distributions)) {
    const entries = Object.entries(counts);
    if (entries.length === 0) continue;
    const summary = entries
      .slice(0, 5)
      .map(([value, count]) => `${value} (${count})`)
      .join(', ');
    const suffix = entries.length > 5 ? `, …+${entries.length - 5} more` : '';
    lines.push(`- **${field}:** ${summary}${suffix}`);
  }
  return lines.join('\n');
}

export interface LoadedRows<T> {
  /** True when we pulled a single page and the server has more. */
  hasMore: boolean;
  /** Pages actually consumed — useful for telemetry. */
  pagesFetched: number;
  rows: T[];
  /** Total rows advertised by the server (may be larger than `rows.length`). */
  totalCount?: number;
}

/**
 * Pull rows up to `loadLimit` on a single page. If the server reports more
 * rows than the limit, leave the rest behind — callers decide whether to
 * spill via `spillToCanvas`.
 */
export async function loadInitialPage<T>(
  client: BrapiClient,
  connection: RegisteredServer,
  path: string,
  filters: Record<string, unknown>,
  loadLimit: number,
  ctx: Context,
): Promise<LoadedRows<T>> {
  return await loadInitialFindPage<T>(
    client,
    connection,
    getRouteForPath(path, filters),
    loadLimit,
    ctx,
  );
}

/** Pull the first page for either a GET list endpoint or POST /search route. */
export async function loadInitialFindPage<T>(
  client: BrapiClient,
  connection: RegisteredServer,
  route: FindRoute,
  loadLimit: number,
  ctx: Context,
): Promise<LoadedRows<T>> {
  const envelope = await fetchFindRoutePage<T>(client, connection, route, loadLimit, 0, ctx);
  const rows = extractRows<T>(envelope.result);
  const pagination = envelope.metadata?.pagination;
  const totalCount = pagination?.totalCount;
  const hasMore = typeof totalCount === 'number' && totalCount > rows.length && totalCount > 0;
  const result: LoadedRows<T> = { rows, hasMore, pagesFetched: 1 };
  if (totalCount !== undefined) result.totalCount = totalCount;
  return result;
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

  const body = { ...route.searchBody, pageSize, page };
  const response = await client.postSearch<BrapiListResult<T> | T[]>(
    connection.baseUrl,
    route.noun,
    body,
    ctx,
    buildRequestOptions(connection, undefined, requestOptions),
  );
  if (response.kind === 'sync') return response.envelope;
  return await client.getSearchResults<BrapiListResult<T> | T[]>(
    connection.baseUrl,
    route.noun,
    response.searchResultsDbId,
    ctx,
    buildRequestOptions(connection, { pageSize, page }, requestOptions),
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
  /** Optional request overrides for spillover page pulls. */
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
  /** Total reported by the server on the first page. */
  totalCount: number;
}

export interface SpillResult<T> {
  dataframe: RegisterDataframeResult;
  /** Rows that were registered (post-filter when `rowFilter` was supplied). */
  fullRows: T[];
  pagesFetched: number;
}

/**
 * Shape of the dataframe handle returned inline by `find_*` tools. The
 * dataframe is the canvas table holding every row beyond `loadLimit`; query
 * it with `brapi_dataframe_query` for SQL access or describe it with
 * `brapi_dataframe_describe` for schema + provenance.
 */
export const DataframeHandleSchema = z.object({
  tableName: z
    .string()
    .describe(
      'Dataframe name. Use with brapi_dataframe_describe (schema + provenance) and brapi_dataframe_query (SQL).',
    ),
  rowCount: z
    .number()
    .int()
    .nonnegative()
    .describe('Number of rows materialized in the dataframe.'),
  columns: z
    .array(z.string().describe('Column name from the materialized rows.'))
    .describe('Full column list of the dataframe.'),
  createdAt: z.string().describe('ISO 8601 timestamp the dataframe was created.'),
  expiresAt: z
    .string()
    .describe(
      'ISO 8601 timestamp after which the dataframe metadata will be purged. Re-run the find_* tool to refresh, or copy results out before expiry.',
    ),
  truncated: z
    .boolean()
    .optional()
    .describe('True when the dataframe hit a row cap before exhausting upstream.'),
  maxRows: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Cap that was applied at create time, when truncation occurred.'),
});

export type DataframeHandle = z.infer<typeof DataframeHandleSchema>;

/**
 * Render a DataframeHandle as bullet lines, matching the existing find_* tool
 * format. Centralized so the truncated/maxRows fields surface consistently.
 * `expiresAt` is paired with a human-readable `expires in Xh / Xd` so the
 * agent doesn't have to subtract dates to know when the handle goes stale.
 */
export function renderDataframeHandle(handle: DataframeHandle): string[] {
  const lines = [
    `- tableName: \`${handle.tableName}\` (query via brapi_dataframe_query)`,
    `- rowCount: ${handle.rowCount}`,
    `- columns: ${handle.columns.join(', ')}`,
    `- createdAt: ${handle.createdAt}`,
    `- expiresAt: ${handle.expiresAt} (${formatExpiresIn(handle.expiresAt)})`,
  ];
  if (handle.truncated) lines.push(`- truncated: true`);
  if (typeof handle.maxRows === 'number') lines.push(`- maxRows: ${handle.maxRows}`);
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
export function toDataframeHandle(result: RegisterDataframeResult): DataframeHandle {
  const handle: DataframeHandle = {
    tableName: result.tableName,
    rowCount: result.rowCount,
    columns: result.columns,
    createdAt: result.createdAt,
    expiresAt: result.expiresAt,
  };
  if (result.truncated) handle.truncated = true;
  if (typeof result.maxRows === 'number') handle.maxRows = result.maxRows;
  return handle;
}

export interface MaybeSpillInput<T> {
  bridge: CanvasBridge;
  client: BrapiClient;
  connection: RegisteredServer;
  ctx: Context;
  filters: Record<string, unknown>;
  firstPage: LoadedRows<T>;
  loadLimit: number;
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
   * than the first page.
   */
  spillRequestOptions?: BrapiRequestOptions;
  /** Optional warning sink. When supplied, spillover failures degrade to rows-only output. */
  warnings?: string[];
}

export interface MaybeSpillResult<T> {
  dataframe?: DataframeHandle;
  /** Row set after `rowFilter` (when supplied), spilled or first-page only. */
  fullRows: T[];
}

/**
 * Wrap `spillToCanvas` with the "only spill when hasMore and totalCount >
 * loadLimit" guard that every `find_*` tool replicates. When no spillover is
 * needed, returns the first-page rows untouched. When it is, materializes
 * the union as a canvas dataframe and returns both the full set and the
 * handle.
 */
export async function maybeSpill<T extends Record<string, unknown>>(
  input: MaybeSpillInput<T>,
): Promise<MaybeSpillResult<T>> {
  const { firstPage, rowMapper, rowFilter } = input;
  if (
    !firstPage.hasMore ||
    firstPage.totalCount === undefined ||
    firstPage.totalCount <= input.loadLimit
  ) {
    return { fullRows: applyRowTransforms(firstPage.rows, rowMapper, rowFilter) };
  }
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
  if (input.route) spillInput.route = input.route;
  if (input.spillRequestOptions) spillInput.pageRequestOptions = input.spillRequestOptions;
  try {
    const spill = await spillToCanvas(spillInput);
    return {
      fullRows: spill.fullRows,
      dataframe: toDataframeHandle(spill.dataframe),
    };
  } catch (err) {
    if (!input.warnings || !(err instanceof SpillPageFetchError)) throw err;
    input.warnings.push(
      `Dataframe spillover skipped after returning the first ${firstPage.rows.length} row(s): ${formatSpillError(err)}. Narrow filters, raise loadLimit enough to fit the result in one page, or retry when the upstream server is responsive.`,
    );
    return { fullRows: applyRowTransforms(firstPage.rows, rowMapper, rowFilter) };
  }
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
 * Pull every remaining page up to MAX_SPILLOVER_* caps, then materialize the
 * union as a canvas dataframe. Returns the dataframe metadata plus the full
 * row set (so callers can compute honest distributions from the whole result).
 */
export async function spillToCanvas<T extends Record<string, unknown>>(
  input: SpillInput<T>,
): Promise<SpillResult<T>> {
  const remainingTarget = Math.min(input.totalCount, MAX_SPILLOVER_ROWS);
  const pageSize = input.loadLimit;
  const totalPages = Math.min(Math.ceil(remainingTarget / pageSize), MAX_SPILLOVER_PAGES);

  const rows: T[] = [...input.firstPage];
  let pagesFetched = 1;

  // Page 0 is already fetched by caller; continue from page 1.
  for (let page = 1; page < totalPages; page++) {
    if (rows.length >= remainingTarget) break;
    if (input.ctx.signal.aborted) break;
    const route = input.route ?? getRouteForPath(input.path, input.filters);
    let envelope: BrapiEnvelope<BrapiListResult<T> | T[]>;
    try {
      envelope = await fetchFindRoutePage<T>(
        input.client,
        input.connection,
        route,
        pageSize,
        page,
        input.ctx,
        input.pageRequestOptions,
      );
    } catch (err) {
      throw new SpillPageFetchError(formatSpillError(err), { cause: err });
    }
    const pageRows = extractRows<T>(envelope.result);
    rows.push(...pageRows);
    pagesFetched += 1;
    if (pageRows.length < pageSize) break;
  }

  const reachedRowCap = rows.length >= remainingTarget && input.totalCount > rows.length;
  const reachedPageCap = pagesFetched >= MAX_SPILLOVER_PAGES && input.totalCount > rows.length;
  const truncated = reachedRowCap || reachedPageCap;

  const persistedRows = applyRowTransforms(rows, input.rowMapper, input.rowFilter);

  const registerInput: RegisterDataframeInput = {
    source: input.source,
    baseUrl: input.connection.baseUrl,
    query: input.filters,
    rows: persistedRows,
  };
  if (truncated) {
    registerInput.truncated = true;
    // `maxRows` only carries meaning when the row cap fired — it's the upper
    // bound the spillover honored. When the page cap fired first (small
    // `loadLimit` × `MAX_SPILLOVER_PAGES` < upstream total), reporting
    // `maxRows = MAX_SPILLOVER_ROWS` is misleading: the dataframe stopped at
    // `loadLimit × MAX_SPILLOVER_PAGES`, well below the row cap. Log the
    // page-cap event for operators; the agent sees only `truncated: true`
    // without the false 50k bound and can raise `loadLimit` to push past it.
    if (reachedRowCap) {
      registerInput.maxRows = MAX_SPILLOVER_ROWS;
    } else if (reachedPageCap) {
      input.ctx.log.warning('Spillover hit page cap before exhausting upstream', {
        source: input.source,
        pagesFetched,
        maxPages: MAX_SPILLOVER_PAGES,
        rowsFetched: rows.length,
        totalCount: input.totalCount,
      });
    }
  }
  const dataframe = await input.bridge.registerDataframe(input.ctx, registerInput);

  return { dataframe, fullRows: persistedRows, pagesFetched };
}

class SpillPageFetchError extends Error {
  override readonly name = 'SpillPageFetchError';
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
 * Compose a refinement hint for a too-large result set. Picks the highest-
 * cardinality non-empty distribution to suggest as a narrower. Returns
 * undefined when the result set fits under `loadLimit`. When distributions
 * are too sparse to surface a specific value, falls back to suggesting
 * the tool's available filter parameters by name.
 */
export function buildRefinementHint(
  totalCount: number,
  loadLimit: number,
  distributions: Record<string, Record<string, number>>,
  options: RefinementHintOptions = {},
): string | undefined {
  if (totalCount <= loadLimit) return;
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
  if (best) {
    return `${totalCount} rows exceed loadLimit=${loadLimit}. The ${best.field} distribution spans ${best.cardinality} values — narrowing to \`${best.topValue}\` would cut to ~${best.count} rows.`;
  }
  if (options.availableFilters && options.availableFilters.length > 0) {
    const suggestions = options.availableFilters.map((f) => `\`${f}\``).join(', ');
    return `${totalCount} rows exceed loadLimit=${loadLimit}. Distributions are too sparse to surface a specific narrower — try filtering on ${suggestions}, or raise loadLimit.`;
  }
  return `${totalCount} rows exceed loadLimit=${loadLimit}. Add more specific filters or raise loadLimit.`;
}

/**
 * Collect `key=value` strings for every top-level key in a passthrough row
 * that was not explicitly rendered by the caller. Ensures format() /
 * structuredContent parity — server fields beyond the declared schema are
 * still emitted to text-only clients (Claude Desktop sees content[] only).
 */
export function collectPassthroughParts(
  row: Record<string, unknown>,
  renderedKeys: ReadonlySet<string>,
): string[] {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(row)) {
    if (renderedKeys.has(key) || value === undefined || value === null) continue;
    const rendered = typeof value === 'object' ? JSON.stringify(value) : String(value);
    parts.push(`${key}=${rendered}`);
  }
  return parts;
}

/**
 * Append `- **key:** value` lines for every top-level key in a passthrough
 * record that was not explicitly rendered. Companion to
 * `collectPassthroughParts` for detail-view (get_*) tools that use a
 * line-per-field layout instead of bullet-part lists.
 */
export function appendPassthroughLines(
  lines: string[],
  record: Record<string, unknown>,
  renderedKeys: ReadonlySet<string>,
): void {
  for (const [key, value] of Object.entries(record)) {
    if (renderedKeys.has(key) || value === undefined || value === null) continue;
    const rendered = typeof value === 'object' ? JSON.stringify(value) : String(value);
    lines.push(`- **${key}:** ${rendered}`);
  }
}

export type { BrapiEnvelope, BrapiPagination, ResolvedAuth, ServerConfig };
