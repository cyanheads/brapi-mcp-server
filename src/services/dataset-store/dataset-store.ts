/**
 * @fileoverview Tenant-scoped dataset lifecycle. Stores metadata and row
 * payloads in `ctx.state` with TTL from `BRAPI_DATASET_TTL_SECONDS`. Datasets
 * back the `brapi_manage_dataset` tool (list/summary/load/delete) and act as
 * the spillover target for `find_*` tools when result sets exceed
 * `BRAPI_LOAD_LIMIT`. Provenance (source, baseUrl, query) is mandatory on
 * create — research workflows require reproducibility.
 *
 * @module services/dataset-store/dataset-store
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
import type { ServerConfig } from '@/config/server-config.js';
import type {
  CreateDatasetInput,
  DatasetListOptions,
  DatasetListPage,
  DatasetLoadOptions,
  DatasetMetadata,
  DatasetPage,
} from './types.js';

const META_PREFIX = 'brapi/ds/meta/';
const ROWS_PREFIX = 'brapi/ds/rows/';

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1_000;

export class DatasetStore {
  constructor(private readonly serverConfig: ServerConfig) {}

  /**
   * Persist a new dataset and return its metadata. Rows and metadata are
   * written under separate keys so `summary` / `list` can avoid paying the
   * row-payload read cost.
   */
  async create(ctx: Context, input: CreateDatasetInput): Promise<DatasetMetadata> {
    if (!input.source) throw validationError('Dataset source is required.');
    if (!input.baseUrl) throw validationError('Dataset baseUrl is required.');

    const datasetId = crypto.randomUUID();
    const columns = input.columns?.length ? [...input.columns] : inferColumns(input.rows);
    const payloadJson = JSON.stringify(input.rows);
    const sizeBytes = byteLength(payloadJson);
    const ttl = this.serverConfig.datasetTtlSeconds;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl * 1000);

    const metadata: DatasetMetadata = {
      datasetId,
      source: input.source,
      baseUrl: input.baseUrl,
      query: input.query,
      rowCount: input.rows.length,
      columns,
      sizeBytes,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    await Promise.all([
      ctx.state.set(metaKey(datasetId), metadata, { ttl }),
      ctx.state.set(rowsKey(datasetId), input.rows, { ttl }),
    ]);

    return metadata;
  }

  /** Return just the metadata for a dataset. Throws `NotFound` when missing. */
  async summary(ctx: Context, datasetId: string): Promise<DatasetMetadata> {
    const meta = await ctx.state.get<DatasetMetadata>(metaKey(datasetId));
    if (!meta) {
      throw notFound(`Dataset ${datasetId} not found or expired.`, { datasetId });
    }
    return meta;
  }

  /** Return a paginated slice of rows, optionally projected to a subset of columns. */
  async load(
    ctx: Context,
    datasetId: string,
    options: DatasetLoadOptions = {},
  ): Promise<DatasetPage> {
    const meta = await this.summary(ctx, datasetId);
    const rows = await ctx.state.get<Record<string, unknown>[]>(rowsKey(datasetId));
    if (!rows) {
      throw notFound(
        `Dataset ${datasetId} metadata exists but rows are missing (storage inconsistency or partial expiry).`,
        { datasetId },
      );
    }

    const pageSize = clampPageSize(options.pageSize);
    const page = Math.max(1, options.page ?? 1);
    const totalRows = rows.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));

    if (page > totalPages && totalRows > 0) {
      throw validationError(
        `Dataset ${datasetId} has ${totalPages} page(s) at pageSize=${pageSize}; requested page ${page} is out of range.`,
        { datasetId, requestedPage: page, totalPages },
      );
    }

    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const slice = rows.slice(start, end);

    if (options.columns?.length) {
      validateColumns(options.columns, meta.columns);
    }

    return {
      datasetId,
      rows: options.columns?.length ? projectColumns(slice, options.columns) : slice,
      page,
      pageSize,
      totalRows,
      totalPages,
    };
  }

  /** Enumerate datasets for this tenant, paginated via opaque cursor. */
  async list(ctx: Context, options: DatasetListOptions = {}): Promise<DatasetListPage> {
    const listOpts: { cursor?: string; limit: number } = {
      limit: options.limit ?? 50,
    };
    if (options.cursor !== undefined) listOpts.cursor = options.cursor;

    const page = await ctx.state.list(META_PREFIX, listOpts);
    const datasets: DatasetMetadata[] = [];
    for (const item of page.items) {
      if (isDatasetMetadata(item.value)) datasets.push(item.value);
    }
    const result: DatasetListPage = { datasets };
    if (page.cursor !== undefined) result.cursor = page.cursor;
    return result;
  }

  /** Delete a dataset's metadata and row payload. Idempotent. */
  async delete(ctx: Context, datasetId: string): Promise<void> {
    await ctx.state.deleteMany([metaKey(datasetId), rowsKey(datasetId)]);
  }
}

function metaKey(id: string): string {
  return `${META_PREFIX}${id}`;
}

function rowsKey(id: string): string {
  return `${ROWS_PREFIX}${id}`;
}

function inferColumns(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) seen.add(key);
    if (seen.size > 256) break;
  }
  return Array.from(seen);
}

function projectColumns(
  rows: Record<string, unknown>[],
  columns: string[],
): Record<string, unknown>[] {
  return rows.map((row) => {
    const projected: Record<string, unknown> = {};
    for (const col of columns) {
      if (col in row) projected[col] = row[col];
    }
    return projected;
  });
}

function validateColumns(requested: string[], available: string[]): void {
  const availableSet = new Set(available);
  const unknown = requested.filter((c) => !availableSet.has(c));
  if (unknown.length > 0) {
    throw validationError(
      `Unknown column(s): ${unknown.join(', ')}. Available columns: ${available.join(', ')}.`,
      { unknownColumns: unknown, availableColumns: available },
    );
  }
}

function clampPageSize(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.floor(value), MAX_PAGE_SIZE);
}

function byteLength(value: string): number {
  if (typeof Buffer !== 'undefined') return Buffer.byteLength(value, 'utf8');
  return new TextEncoder().encode(value).byteLength;
}

function isDatasetMetadata(value: unknown): value is DatasetMetadata {
  return (
    typeof value === 'object' &&
    value !== null &&
    'datasetId' in value &&
    typeof (value as { datasetId: unknown }).datasetId === 'string'
  );
}

let _store: DatasetStore | undefined;

export function initDatasetStore(serverConfig: ServerConfig): void {
  _store = new DatasetStore(serverConfig);
}

export function getDatasetStore(): DatasetStore {
  if (!_store) {
    throw new Error('DatasetStore not initialized — call initDatasetStore() in setup()');
  }
  return _store;
}

export function resetDatasetStore(): void {
  _store = undefined;
}
