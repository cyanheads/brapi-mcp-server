/**
 * @fileoverview Shared building blocks for `find_*` tools — Zod fragments for
 * common inputs (alias, loadLimit, extraFilters), utilities to merge named
 * filters with the passthrough map, a generic distribution aggregator, and
 * the dataset-spillover handler that turns a "too many rows" result into a
 * DatasetStore handle.
 *
 * @module mcp-server/tools/shared/find-helpers
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
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
import type { CapabilityProfile } from '@/services/capability-registry/types.js';
import type {
  CreateDatasetInput,
  DatasetMetadata,
  DatasetStore,
} from '@/services/dataset-store/index.js';
import type { RegisteredServer } from '@/services/server-registry/index.js';

/** True when the thrown value is an upstream 404 surfaced by the BrAPI client. */
export function isUpstreamNotFound(err: unknown): boolean {
  return err instanceof McpError && err.code === JsonRpcErrorCode.NotFound;
}

/** Upper cap on how many rows we'll pull for DatasetStore spillover per call. */
export const MAX_SPILLOVER_ROWS = 50_000;

/** Hard cap on how many BrAPI pages we'll traverse when building a dataset. */
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
    'Override the in-context row cap (BRAPI_LOAD_LIMIT). Rows beyond the cap return as a dataset handle.',
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
 * Apply the dialect's GET-filter adapter and append any warnings to the
 * caller's collector. Returns the wire-shape filter map. Mirrors the
 * `(input, …, warnings) → Record` shape of `mergeFilters` so find_* call
 * sites stay readable.
 */
export function applyDialectFilters(
  dialect: BrapiDialect,
  endpoint: string,
  filters: Readonly<Record<string, unknown>>,
  warnings: string[],
): Record<string, unknown> {
  const adapted = dialect.adaptGetFilters(endpoint, filters);
  warnings.push(...adapted.warnings);
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
): BrapiRequestOptions {
  const opts: BrapiRequestOptions = {};
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
 * Render the standardized header line for `find_*` tools. When a dataset
 * spillover is present, surfaces the dataset row count alongside the
 * in-context count and the upstream total — `{returned} of {total}` alone
 * hides the middle number and confuses readers when filters miss server-
 * side and the dataset row count diverges from both.
 */
export function renderFindHeader(opts: {
  noun: string;
  alias: string;
  returnedCount: number;
  totalCount: number;
  dataset?: { rowCount: number; expiresAt?: string } | undefined;
}): string {
  if (opts.dataset) {
    const expiry = opts.dataset.expiresAt ? ` (${formatExpiresIn(opts.dataset.expiresAt)})` : '';
    return `# ${opts.returnedCount} returned · ${opts.dataset.rowCount} in dataset${expiry} · ${opts.totalCount} total ${opts.noun} — \`${opts.alias}\``;
  }
  return `# ${opts.returnedCount} of ${opts.totalCount} ${opts.noun} — \`${opts.alias}\``;
}

/**
 * Render the applied-filters block, optionally translating server-side
 * keys to the user-facing parameter names declared by the tool. Server
 * keys without a user-facing alias (e.g. anything from `extraFilters`) are
 * rendered as-is.
 */
export function renderAppliedFilters(
  filters: Record<string, unknown>,
  serverToUser: Record<string, string> = {},
): string {
  const entries = Object.entries(filters);
  if (entries.length === 0) return 'Applied filters: `{}`';
  const lines: string[] = ['Applied filters:'];
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
 * spill via `spillToDataset`.
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
      buildRequestOptions(connection, params),
    );
  }

  const body = { ...route.searchBody, pageSize, page };
  const response = await client.postSearch<BrapiListResult<T> | T[]>(
    connection.baseUrl,
    route.noun,
    body,
    ctx,
    buildRequestOptions(connection),
  );
  if (response.kind === 'sync') return response.envelope;
  return await client.getSearchResults<BrapiListResult<T> | T[]>(
    connection.baseUrl,
    route.noun,
    response.searchResultsDbId,
    ctx,
    buildRequestOptions(connection, { pageSize, page }),
  );
}

export interface SpillInput<T> {
  client: BrapiClient;
  connection: RegisteredServer;
  ctx: Context;
  filters: Record<string, unknown>;
  /** First-page rows already loaded. Avoids a re-fetch. */
  firstPage: T[];
  loadLimit: number;
  path: string;
  /** Optional route selected by resolveFindRoute; defaults to GET path + filters. */
  route?: FindRoute;
  /**
   * Optional client-side predicate applied to every row (first-page + spilled)
   * before persistence. When present, only rows that pass are persisted to
   * DatasetStore and returned in `fullRows`. The unfiltered upstream total is
   * preserved separately on the LoadedRows envelope so distributions and
   * headers can still report the true upstream size.
   */
  rowFilter?: (row: T) => boolean;
  source: string;
  store: DatasetStore;
  /** Total reported by the server on the first page. */
  totalCount: number;
}

export interface SpillResult<T> {
  dataset: DatasetMetadata;
  /** Rows that were persisted (post-filter when `rowFilter` was supplied). */
  fullRows: T[];
  pagesFetched: number;
}

/**
 * Shape of the dataset handle returned inline by `find_*` tools. Drops the
 * provenance fields (source/baseUrl/query) since those are internal and
 * available via `brapi_manage_dataset summary`.
 */
export const DatasetHandleSchema = z.object({
  datasetId: z.string().describe('Use with brapi_manage_dataset to page or export.'),
  rowCount: z.number().int().nonnegative().describe('Number of rows persisted in the dataset.'),
  sizeBytes: z.number().int().nonnegative().describe('Serialized size of the dataset in bytes.'),
  columns: z
    .array(z.string().describe('Column name from the persisted rows.'))
    .describe('Full column list of the persisted rows.'),
  createdAt: z.string().describe('ISO 8601 timestamp the dataset was created.'),
  expiresAt: z.string().describe('ISO 8601 timestamp after which the dataset will be purged.'),
  truncated: z
    .boolean()
    .optional()
    .describe('True when the dataset hit a row cap before exhausting upstream.'),
  maxRows: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Cap that was applied at create time, when truncation occurred.'),
});

export type DatasetHandle = z.infer<typeof DatasetHandleSchema>;

/**
 * Render a DatasetHandle as bullet lines, matching the existing find_* tool
 * format. Centralized so the truncated/maxRows fields surface consistently.
 * `expiresAt` is paired with a human-readable `expires in Xh / Xd` so the
 * agent doesn't have to subtract dates to know when the handle goes stale.
 */
export function renderDatasetHandle(handle: DatasetHandle): string[] {
  const lines = [
    `- datasetId: \`${handle.datasetId}\``,
    `- rowCount: ${handle.rowCount}`,
    `- sizeBytes: ${handle.sizeBytes}`,
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

/** Project a `DatasetMetadata` to the in-context handle shape. */
export function toDatasetHandle(metadata: DatasetMetadata): DatasetHandle {
  const handle: DatasetHandle = {
    datasetId: metadata.datasetId,
    rowCount: metadata.rowCount,
    sizeBytes: metadata.sizeBytes,
    columns: metadata.columns,
    createdAt: metadata.createdAt,
    expiresAt: metadata.expiresAt,
  };
  if (metadata.truncated) handle.truncated = true;
  if (typeof metadata.maxRows === 'number') handle.maxRows = metadata.maxRows;
  return handle;
}

export interface MaybeSpillInput<T> {
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
   * Forwarded to `spillToDataset`. When present and no spillover happens, the
   * first-page rows are also filtered before being returned.
   */
  rowFilter?: (row: T) => boolean;
  source: string;
  store: DatasetStore;
}

export interface MaybeSpillResult<T> {
  dataset?: DatasetHandle;
  /** Row set after `rowFilter` (when supplied), spilled or first-page only. */
  fullRows: T[];
}

/**
 * Wrap `spillToDataset` with the "only spill when hasMore and totalCount >
 * loadLimit" guard that every `find_*` tool replicates. When no spillover is
 * needed, returns the first-page rows untouched. When it is, persists the
 * union to DatasetStore and returns both the full set and the handle.
 */
export async function maybeSpill<T extends Record<string, unknown>>(
  input: MaybeSpillInput<T>,
): Promise<MaybeSpillResult<T>> {
  const { firstPage, rowFilter } = input;
  if (
    !firstPage.hasMore ||
    firstPage.totalCount === undefined ||
    firstPage.totalCount <= input.loadLimit
  ) {
    const rows = rowFilter ? firstPage.rows.filter(rowFilter) : firstPage.rows;
    return { fullRows: rows };
  }
  const spillInput: SpillInput<T> = {
    store: input.store,
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
  if (rowFilter) spillInput.rowFilter = rowFilter;
  if (input.route) spillInput.route = input.route;
  const spill = await spillToDataset(spillInput);
  return {
    fullRows: spill.fullRows,
    dataset: toDatasetHandle(spill.dataset),
  };
}

/**
 * Pull every remaining page up to MAX_SPILLOVER_* caps, then persist the
 * union to DatasetStore. Returns the dataset metadata plus the full row set
 * (so callers can compute honest distributions from the whole result).
 */
export async function spillToDataset<T extends Record<string, unknown>>(
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
    const envelope = await fetchFindRoutePage<T>(
      input.client,
      input.connection,
      route,
      pageSize,
      page,
      input.ctx,
    );
    const pageRows = extractRows<T>(envelope.result);
    rows.push(...pageRows);
    pagesFetched += 1;
    if (pageRows.length < pageSize) break;
  }

  const reachedRowCap = rows.length >= remainingTarget && input.totalCount > rows.length;
  const reachedPageCap = pagesFetched >= MAX_SPILLOVER_PAGES && input.totalCount > rows.length;
  const truncated = reachedRowCap || reachedPageCap;

  const persistedRows = input.rowFilter ? rows.filter(input.rowFilter) : rows;

  const createInput: CreateDatasetInput = {
    source: input.source,
    baseUrl: input.connection.baseUrl,
    query: input.filters,
    rows: persistedRows,
  };
  if (truncated) {
    createInput.truncated = true;
    createInput.maxRows = MAX_SPILLOVER_ROWS;
  }
  const dataset = await input.store.create(input.ctx, createInput);

  return { dataset, fullRows: persistedRows, pagesFetched };
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

/** Return the input as a non-empty string, or undefined. Used in distribution accessors. */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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
    const matched = check.requestedValues.some((v) => haystack.has(norm(String(v))));
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
): FilterMatchCheck {
  return {
    paramName,
    requestedValues,
    distribution: computeDistribution(rows, (r) => asString(r[fieldName])),
  };
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
