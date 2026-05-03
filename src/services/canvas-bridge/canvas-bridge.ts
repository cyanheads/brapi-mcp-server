/**
 * @fileoverview CanvasBridge — server-side adapter over the framework's
 * `DataCanvas` primitive. Owns three concerns the framework leaves to the
 * consumer: (1) per-tenant default canvas resolution (the agent never passes
 * `canvas_id`; the bridge caches and reuses it via `ctx.state`), (2) deriving
 * SQL-safe table names from UUID-shaped dataset IDs, and (3) tracking
 * originating-dataset provenance so `brapi_dataframe_describe` can surface it.
 *
 * No-ops cleanly when the framework canvas service is undefined or when
 * `BRAPI_CANVAS_ENABLED=false` — `isEnabled()` is the single gate every caller
 * checks before hitting any canvas op.
 *
 * @module services/canvas-bridge/canvas-bridge
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type {
  CanvasInstance,
  DataCanvas,
  QueryResult,
  RegisterTableResult,
  TableInfo,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { RequestContext } from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
import type { DatasetMetadata } from '@/services/dataset-store/index.js';
import type { CanvasTableMeta, DescribedTable } from './types.js';

/**
 * Construct a `RequestContext` slice from the handler `Context`. The
 * framework's `RequestContext` carries an `[key: string]: unknown` index
 * signature which the strict `Context` interface lacks, so direct
 * assignment fails despite the 0.8.12 optional-field widening.
 */
function asRequestContext(ctx: Context): RequestContext {
  const rc: RequestContext = {
    requestId: ctx.requestId,
    timestamp: ctx.timestamp,
  };
  if (ctx.tenantId !== undefined) rc.tenantId = ctx.tenantId;
  if (ctx.traceId !== undefined) rc.traceId = ctx.traceId;
  if (ctx.spanId !== undefined) rc.spanId = ctx.spanId;
  return rc;
}

/** State key holding the per-tenant default canvasId (opaque 10-char token). */
const DEFAULT_CANVAS_KEY = 'brapi/canvas/default';

/** Prefix for per-table provenance entries — keyed by canvas table name. */
const TABLE_META_PREFIX = 'brapi/canvas/tablemeta/';

/** Auto-registered dataset-table prefix. Anything else is user-derived (registerAs). */
const DATASET_TABLE_PREFIX = 'ds_';

/** Bridge for `core.canvas` that adds per-tenant default-canvas semantics. */
export class CanvasBridge {
  constructor(
    private readonly canvas: DataCanvas | undefined,
    private readonly serverConfig: ServerConfig,
  ) {}

  /**
   * True when both the framework canvas service and the server-side gate are
   * on. Every caller must check this before any canvas op.
   */
  isEnabled(): boolean {
    return this.canvas !== undefined && this.serverConfig.canvasEnabled;
  }

  /**
   * Acquire the per-tenant default canvas. The canvasId is cached in
   * `ctx.state` so subsequent calls reuse the same canvas (sliding TTL on the
   * canvas itself keeps it warm). On stale-id errors (NotFound), clears the
   * cache and acquires a fresh canvas — matches the spirit of the framework's
   * "omit on retry" recovery hint without surfacing the token to the agent.
   */
  async getInstance(ctx: Context): Promise<CanvasInstance> {
    const canvas = this.requireCanvas();
    const cached = await ctx.state.get<string>(DEFAULT_CANVAS_KEY);
    try {
      const instance = await canvas.acquire(cached ?? undefined, asRequestContext(ctx));
      if (!cached || instance.isNew) {
        await ctx.state.set(DEFAULT_CANVAS_KEY, instance.canvasId);
      }
      return instance;
    } catch (err) {
      if (cached && isCanvasNotFound(err)) {
        await ctx.state.delete(DEFAULT_CANVAS_KEY);
        const fresh = await canvas.acquire(undefined, asRequestContext(ctx));
        await ctx.state.set(DEFAULT_CANVAS_KEY, fresh.canvasId);
        return fresh;
      }
      throw err;
    }
  }

  /**
   * Auto-register a spilled dataset on the canvas. Called from `DatasetStore`
   * after a successful create. Logs a warning and swallows on failure —
   * canvas registration is a best-effort enrichment of the spillover, not a
   * blocking step.
   */
  async registerDataset(
    ctx: Context,
    metadata: DatasetMetadata,
    rows: Record<string, unknown>[],
  ): Promise<{ registered: boolean; tableName?: string }> {
    if (!this.isEnabled()) return { registered: false };
    const tableName = datasetTableName(metadata.datasetId);
    try {
      const instance = await this.getInstance(ctx);
      await instance.registerTable(tableName, rows);
      const tableMeta: CanvasTableMeta = {
        datasetId: metadata.datasetId,
        source: metadata.source,
        baseUrl: metadata.baseUrl,
        query: metadata.query,
        createdAt: metadata.createdAt,
        expiresAt: metadata.expiresAt,
      };
      await ctx.state.set(tableMetaKey(tableName), tableMeta, {
        ttl: this.serverConfig.datasetTtlSeconds,
      });
      ctx.log.debug('Canvas auto-register succeeded', {
        datasetId: metadata.datasetId,
        tableName,
        rowCount: metadata.rowCount,
      });
      return { registered: true, tableName };
    } catch (err) {
      ctx.log.warning(
        'Canvas auto-register failed; dataset still available via brapi_manage_dataset',
        {
          datasetId: metadata.datasetId,
          tableName,
          error: err instanceof Error ? err.message : String(err),
        },
      );
      return { registered: false };
    }
  }

  /**
   * Drop the canvas table corresponding to a deleted dataset. Mirrors
   * `registerDataset` — best-effort, never throws.
   */
  async dropDataset(ctx: Context, datasetId: string): Promise<{ dropped: boolean }> {
    if (!this.isEnabled()) return { dropped: false };
    const tableName = datasetTableName(datasetId);
    try {
      const instance = await this.getInstance(ctx);
      const dropped = await instance.drop(tableName);
      await ctx.state.delete(tableMetaKey(tableName));
      return { dropped };
    } catch (err) {
      ctx.log.warning('Canvas auto-drop failed', {
        datasetId,
        tableName,
        error: err instanceof Error ? err.message : String(err),
      });
      return { dropped: false };
    }
  }

  /**
   * Run a SQL query against the per-tenant default canvas. Caps `rowLimit` to
   * `BRAPI_CANVAS_MAX_ROWS` so a missing/excessive caller value can't bypass
   * the response-size budget. Cancellation flows through `ctx.signal`; the
   * timeout wraps the AbortSignal with a wall-clock cap.
   */
  async query(
    ctx: Context,
    sql: string,
    options: { preview?: number; registerAs?: string; rowLimit?: number } = {},
  ): Promise<QueryResult> {
    const instance = await this.getInstance(ctx);
    const cap = this.serverConfig.canvasMaxRows;
    const rowLimit = Math.min(options.rowLimit ?? cap, cap);
    const queryOpts: {
      preview?: number;
      registerAs?: string;
      rowLimit: number;
      signal: AbortSignal;
    } = {
      rowLimit,
      signal: composeSignal(ctx.signal, this.serverConfig.canvasQueryTimeoutMs),
    };
    if (options.preview !== undefined) queryOpts.preview = options.preview;
    if (options.registerAs !== undefined) queryOpts.registerAs = options.registerAs;
    return await instance.query(sql, queryOpts);
  }

  /**
   * Register an explicitly-named table (used by the rare consumer that wants
   * to push rows directly without going through DatasetStore spillover).
   */
  async registerTable(
    ctx: Context,
    name: string,
    rows: Record<string, unknown>[],
  ): Promise<RegisterTableResult> {
    const instance = await this.getInstance(ctx);
    return await instance.registerTable(name, rows);
  }

  /** Drop a single canvas table by name. Returns true when found and removed. */
  async drop(ctx: Context, name: string): Promise<boolean> {
    const instance = await this.getInstance(ctx);
    const dropped = await instance.drop(name);
    if (dropped) await ctx.state.delete(tableMetaKey(name));
    return dropped;
  }

  /**
   * Describe one or all canvas tables, augmenting the framework's `TableInfo`
   * with originating-dataset provenance for auto-registered tables.
   */
  async describe(ctx: Context, options: { tableName?: string } = {}): Promise<DescribedTable[]> {
    const instance = await this.getInstance(ctx);
    const describeOpts: { tableName?: string } = {};
    if (options.tableName !== undefined) describeOpts.tableName = options.tableName;
    const tables = await instance.describe(describeOpts);
    return Promise.all(tables.map((t) => this.augmentTableInfo(ctx, t)));
  }

  private async augmentTableInfo(ctx: Context, table: TableInfo): Promise<DescribedTable> {
    const out: DescribedTable = {
      name: table.name,
      rowCount: table.rowCount,
      columns: table.columns.map((c) => ({
        name: c.name,
        type: c.type,
        ...(c.nullable !== undefined ? { nullable: c.nullable } : {}),
      })),
    };
    if (table.approxSizeBytes !== undefined) out.approxSizeBytes = table.approxSizeBytes;
    if (table.name.startsWith(DATASET_TABLE_PREFIX)) {
      const meta = await ctx.state.get<CanvasTableMeta>(tableMetaKey(table.name));
      if (meta) out.provenance = meta;
    }
    return out;
  }

  private requireCanvas(): DataCanvas {
    if (!this.canvas) {
      throw new Error(
        'CanvasBridge.getInstance() called while canvas is disabled. Call isEnabled() first.',
      );
    }
    return this.canvas;
  }
}

/**
 * Derive a SQL-safe table name from a DatasetStore dataset ID. UUIDs from
 * `crypto.randomUUID()` carry hyphens which fail the canvas identifier gate;
 * we replace them with underscores and prefix with `ds_` so the namespace is
 * unambiguous. Reversible — `tableNameToDatasetId(datasetTableName(id)) === id`.
 */
export function datasetTableName(datasetId: string): string {
  return `${DATASET_TABLE_PREFIX}${datasetId.replace(/-/g, '_')}`;
}

/** Inverse of {@link datasetTableName}. Returns `undefined` for non-`ds_` names. */
export function tableNameToDatasetId(tableName: string): string | undefined {
  if (!tableName.startsWith(DATASET_TABLE_PREFIX)) return;
  return tableName.slice(DATASET_TABLE_PREFIX.length).replace(/_/g, '-');
}

function tableMetaKey(tableName: string): string {
  return `${TABLE_META_PREFIX}${tableName}`;
}

function isCanvasNotFound(err: unknown): boolean {
  return err instanceof McpError && err.code === JsonRpcErrorCode.NotFound;
}

/**
 * Compose the caller's AbortSignal with a wall-clock timeout. Returns the
 * caller's signal directly when no timeout is configured or the parent is
 * already aborted (no point wrapping a dead signal — and doing so would leak
 * the timer until it fires, since the cleanup listener can't fire on an
 * already-aborted signal). Mirrors the manual-AbortController pattern from
 * the framework's `fetchWithTimeout` — `AbortSignal.timeout()` is avoided
 * because it can fail in Bun stdio due to realm mismatch.
 */
function composeSignal(parent: AbortSignal, timeoutMs: number): AbortSignal {
  if (timeoutMs <= 0 || parent.aborted) return parent;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Canvas query timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  // Forward parent abort; `signal: controller.signal` auto-removes this
  // listener if the controller aborts first (timer fire), so it can't fire
  // a second time when the parent later aborts.
  parent.addEventListener('abort', () => controller.abort(parent.reason), {
    once: true,
    signal: controller.signal,
  });
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return controller.signal;
}

let _bridge: CanvasBridge | undefined;

/**
 * Initialize the singleton bridge. Pass the framework canvas (which is
 * `undefined` when `CANVAS_PROVIDER_TYPE !== 'duckdb'` or on Workers).
 */
export function initCanvasBridge(
  canvas: DataCanvas | undefined,
  serverConfig: ServerConfig,
): CanvasBridge {
  _bridge = new CanvasBridge(canvas, serverConfig);
  return _bridge;
}

export function getCanvasBridge(): CanvasBridge {
  if (!_bridge) {
    throw new Error('CanvasBridge not initialized — call initCanvasBridge() in setup()');
  }
  return _bridge;
}

/** Test-only — clear the singleton between suites. */
export function resetCanvasBridge(): void {
  _bridge = undefined;
}
