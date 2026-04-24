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
import type { ServerConfig } from '@/config/server-config.js';
import type {
  BrapiClient,
  BrapiEnvelope,
  BrapiPagination,
  BrapiRequestOptions,
  ResolvedAuth,
} from '@/services/brapi-client/index.js';
import type { DatasetMetadata, DatasetStore } from '@/services/dataset-store/index.js';
import type { RegisteredServer } from '@/services/server-registry/index.js';

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
    'Override the in-context row cap (BRAPI_LOAD_LIMIT). Rows beyond the cap spill to a dataset handle.',
  );

export const ExtraFiltersInput = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    'Extra BrAPI filters forwarded verbatim. Use brapi_describe_filters to discover valid keys for the endpoint. Named params on this tool take precedence on conflict.',
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
  const params: BrapiRequestOptions['params'] = {
    ...(filters as Record<
      string,
      string | number | boolean | readonly (string | number)[] | undefined
    >),
  };
  params.pageSize = loadLimit;
  const envelope = await client.get<BrapiListResult<T>>(
    connection.baseUrl,
    path,
    ctx,
    buildRequestOptions(connection, params),
  );
  const rows = extractRows<T>(envelope.result);
  const pagination = envelope.metadata?.pagination;
  const totalCount = pagination?.totalCount;
  const hasMore = typeof totalCount === 'number' && totalCount > rows.length && totalCount > 0;
  const result: LoadedRows<T> = { rows, hasMore, pagesFetched: 1 };
  if (totalCount !== undefined) result.totalCount = totalCount;
  return result;
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
  source: string;
  store: DatasetStore;
  /** Total reported by the server on the first page. */
  totalCount: number;
}

export interface SpillResult<T> {
  dataset: DatasetMetadata;
  /** All rows that were persisted — used for distributions. */
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
  rowCount: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  columns: z.array(z.string()),
  createdAt: z.string(),
  expiresAt: z.string(),
});

export type DatasetHandle = z.infer<typeof DatasetHandleSchema>;

/** Project a `DatasetMetadata` to the in-context handle shape. */
export function toDatasetHandle(metadata: DatasetMetadata): DatasetHandle {
  return {
    datasetId: metadata.datasetId,
    rowCount: metadata.rowCount,
    sizeBytes: metadata.sizeBytes,
    columns: metadata.columns,
    createdAt: metadata.createdAt,
    expiresAt: metadata.expiresAt,
  };
}

export interface MaybeSpillInput<T> {
  client: BrapiClient;
  connection: RegisteredServer;
  ctx: Context;
  filters: Record<string, unknown>;
  firstPage: LoadedRows<T>;
  loadLimit: number;
  path: string;
  source: string;
  store: DatasetStore;
}

export interface MaybeSpillResult<T> {
  dataset?: DatasetHandle;
  /** Full row set if a spillover happened, otherwise the first-page rows. */
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
  const { firstPage } = input;
  if (
    !firstPage.hasMore ||
    firstPage.totalCount === undefined ||
    firstPage.totalCount <= input.loadLimit
  ) {
    return { fullRows: firstPage.rows };
  }
  const spill = await spillToDataset({
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
  });
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
    const params: BrapiRequestOptions['params'] = {
      ...(input.filters as Record<
        string,
        string | number | boolean | readonly (string | number)[] | undefined
      >),
    };
    params.pageSize = pageSize;
    params.page = page;
    const envelope = await input.client.get<BrapiListResult<T>>(
      input.connection.baseUrl,
      input.path,
      input.ctx,
      buildRequestOptions(input.connection, params),
    );
    const pageRows = extractRows<T>(envelope.result);
    rows.push(...pageRows);
    pagesFetched += 1;
    if (pageRows.length < pageSize) break;
  }

  const dataset = await input.store.create(input.ctx, {
    source: input.source,
    baseUrl: input.connection.baseUrl,
    query: input.filters,
    rows,
  });

  return { dataset, fullRows: rows, pagesFetched };
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
 * Compose a refinement hint for a too-large result set. Picks the highest-
 * cardinality non-empty distribution to suggest as a narrower. Returns
 * undefined when the result set fits under `loadLimit`.
 */
export function buildRefinementHint(
  totalCount: number,
  loadLimit: number,
  distributions: Record<string, Record<string, number>>,
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
  if (!best) {
    return `${totalCount} rows exceed loadLimit=${loadLimit}. Add more specific filters or raise loadLimit.`;
  }
  return `${totalCount} rows exceed loadLimit=${loadLimit}. The ${best.field} distribution spans ${best.cardinality} values — narrowing to \`${best.topValue}\` would cut to ~${best.count} rows.`;
}

export type { BrapiEnvelope, BrapiPagination, ResolvedAuth, ServerConfig };
