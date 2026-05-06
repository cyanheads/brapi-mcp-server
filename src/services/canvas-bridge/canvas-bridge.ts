/**
 * @fileoverview CanvasBridge — server-side adapter over the framework's
 * `DataCanvas` primitive. Owns three concerns the framework leaves to the
 * consumer: (1) per-tenant default canvas resolution (the agent never passes
 * `canvas_id`; the bridge caches and reuses it via `ctx.state`), (2) generating
 * SQL-safe `df_<uuid>` table names for spilled find_* results, and (3) tracking
 * originating-source provenance so `brapi_dataframe_describe` can surface it.
 *
 * Canvas is mandatory — `core.canvas` must be configured (DuckDB) for the
 * server to start. There is no on/off toggle; spillover always lands on the
 * canvas.
 *
 * @module services/canvas-bridge/canvas-bridge
 */

import { unlink } from 'node:fs/promises';
import type { Context } from '@cyanheads/mcp-ts-core';
import type {
  CanvasInstance,
  ColumnSchema,
  ColumnType,
  DataCanvas,
  ExportResult,
  ExportTarget,
  QueryResult,
  RegisterTableResult,
  TableInfo,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import type { RequestContext } from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
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

/**
 * Prefix for export-path tracking entries — keyed by canvas table name. The
 * value is a list of absolute paths written by `brapi_dataframe_export` for
 * that dataframe, persisted with the same TTL as the dataframe's provenance.
 * Used by `drop()` to remove paired files when an explicit drop happens; if
 * the dataframe expires via TTL the state entry simply disappears and the
 * file is reaped opportunistically by the export tool's mtime sweep.
 */
const EXPORT_PATHS_PREFIX = 'brapi/canvas/exports/';

/** Auto-registered dataframe-table prefix. Anything else is user-derived (registerAs). */
const DATAFRAME_TABLE_PREFIX = 'df_';

/** Input to {@link CanvasBridge.registerDataframe}. */
export interface RegisterDataframeInput {
  /** Originating BrAPI baseUrl. */
  baseUrl: string;
  /** Cap that fired before the upstream was exhausted. Omit when no cap fired. */
  maxRows?: number;
  /** Original filter map / query — provenance for reproducibility. */
  query: unknown;
  /** Row payload to materialize. */
  rows: Record<string, unknown>[];
  /** Originating tool (e.g. `find_observations`). */
  source: string;
  /** True when the producer hit a row/page cap before exhausting upstream. */
  truncated?: boolean;
}

/** Result of {@link CanvasBridge.registerDataframe} — the dataframe handle. */
export interface RegisterDataframeResult {
  columns: string[];
  createdAt: string;
  expiresAt: string;
  maxRows?: number;
  rowCount: number;
  tableName: string;
  truncated?: boolean;
}

/** Bridge for `core.canvas` that adds per-tenant default-canvas semantics. */
export class CanvasBridge {
  constructor(
    private readonly canvas: DataCanvas,
    private readonly serverConfig: ServerConfig,
  ) {}

  /**
   * Acquire the per-tenant default canvas. The canvasId is cached in
   * `ctx.state` so subsequent calls reuse the same canvas (sliding TTL on the
   * canvas itself keeps it warm). On stale-id errors (NotFound), clears the
   * cache and acquires a fresh canvas — matches the spirit of the framework's
   * "omit on retry" recovery hint without surfacing the token to the agent.
   */
  async getInstance(ctx: Context): Promise<CanvasInstance> {
    const cached = await ctx.state.get<string>(DEFAULT_CANVAS_KEY);
    try {
      const instance = await this.canvas.acquire(cached ?? undefined, asRequestContext(ctx));
      if (!cached || instance.isNew) {
        await ctx.state.set(DEFAULT_CANVAS_KEY, instance.canvasId);
      }
      return instance;
    } catch (err) {
      if (cached && isCanvasNotFound(err)) {
        await ctx.state.delete(DEFAULT_CANVAS_KEY);
        const fresh = await this.canvas.acquire(undefined, asRequestContext(ctx));
        await ctx.state.set(DEFAULT_CANVAS_KEY, fresh.canvasId);
        return fresh;
      }
      throw err;
    }
  }

  /**
   * Materialize a spilled `find_*` result as a canvas dataframe. Generates a
   * `df_<uuid>` table name, registers the rows with an all-nullable schema,
   * persists provenance metadata in `ctx.state`, and returns the full
   * dataframe handle.
   */
  async registerDataframe(
    ctx: Context,
    input: RegisterDataframeInput,
  ): Promise<RegisterDataframeResult> {
    const tableName = generateDataframeName();
    const ttl = this.serverConfig.datasetTtlSeconds;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl * 1000);
    const createdAt = now.toISOString();
    const expiresAtIso = expiresAt.toISOString();

    const instance = await this.getInstance(ctx);
    // Pre-compute an explicit all-nullable schema. The framework's default
    // path sniffs the first N rows and infers `nullable: false` for any
    // column that happened to be non-null in the sample — DuckDB then
    // creates the table with NOT NULL constraints, and the appender rolls
    // back the entire batch the first time a later row carries a null for
    // that column. Sniffed schemas can never prove non-nullability from a
    // sample, so we walk every row, classify types ourselves, and emit
    // `nullable: true` for every column.
    const schema = deriveAllNullableSchema(input.rows);
    const registered = await instance.registerTable(tableName, input.rows, { schema });

    const tableMeta: CanvasTableMeta = {
      source: input.source,
      baseUrl: input.baseUrl,
      query: input.query,
      createdAt,
      expiresAt: expiresAtIso,
    };
    await ctx.state.set(tableMetaKey(tableName), tableMeta, { ttl });
    ctx.log.debug('Canvas dataframe registered', {
      tableName,
      rowCount: registered.rowCount,
      source: input.source,
    });

    const result: RegisterDataframeResult = {
      tableName,
      rowCount: registered.rowCount,
      columns: registered.columns,
      createdAt,
      expiresAt: expiresAtIso,
    };
    if (input.truncated) result.truncated = true;
    if (typeof input.maxRows === 'number') result.maxRows = input.maxRows;
    return result;
  }

  /**
   * Run a SQL query against the per-tenant default canvas. Caps `rowLimit` to
   * `BRAPI_CANVAS_MAX_ROWS` so a missing/excessive caller value can't bypass
   * the response-size budget. Cancellation flows through `ctx.signal`; the
   * timeout wraps the AbortSignal with a wall-clock cap.
   *
   * Pre-gate: rejects SQL that reaches into DuckDB's system catalogs
   * (`information_schema`, `pg_catalog`, `sqlite_master`, `duckdb_*` metadata
   * functions). Under shared-tenant deployments the canvas hosts every
   * caller's dataframes; without this gate, `SELECT * FROM information_schema.tables`
   * leaks the full df_<uuid> namespace and bypasses brapi_dataframe_describe's
   * possession-required policy.
   */
  async query(
    ctx: Context,
    sql: string,
    options: { preview?: number; registerAs?: string; rowLimit?: number } = {},
  ): Promise<QueryResult> {
    assertNoSystemCatalogAccess(sql);
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
   * to push rows directly without going through the spillover path).
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
    if (dropped) {
      await ctx.state.delete(tableMetaKey(name));
      await this.unlinkTrackedExports(ctx, name);
    }
    return dropped;
  }

  /**
   * Export a canvas table to a path target. The framework resolves the
   * relative path against `CANVAS_EXPORT_PATH` and rejects absolute /
   * traversal inputs — the bridge only forwards.
   *
   * Tracking the resulting path under the *source* dataframe name (so a
   * subsequent `drop(sourceName)` can unlink it) is the caller's job. The
   * bridge can't infer "source name" when the export reads from a transient
   * derived table (e.g. a projection materialized for one export call) —
   * auto-tracking under whatever `tableName` was passed would unlink the
   * file the moment the derived table is dropped. See
   * `pairExportToSourceDataframe` in `brapi-dataframe-export.tool.ts`.
   */
  async export(
    ctx: Context,
    tableName: string,
    target: ExportTarget,
    options: { signal?: AbortSignal } = {},
  ): Promise<ExportResult> {
    const instance = await this.getInstance(ctx);
    const exportOpts: { signal?: AbortSignal } = {};
    if (options.signal !== undefined) exportOpts.signal = options.signal;
    return await instance.export(tableName, target, exportOpts);
  }

  /**
   * Track an exported file path under a source dataframe name so that a
   * later `drop(sourceName)` unlinks it. Persisted in `ctx.state` with the
   * remaining TTL of the source dataframe; if the dataframe expires via
   * TTL, the entry disappears and the file is reaped opportunistically by
   * the export tool's mtime sweep.
   */
  async trackExport(ctx: Context, sourceName: string, path: string): Promise<void> {
    const key = exportPathsKey(sourceName);
    const meta = await ctx.state.get<CanvasTableMeta>(tableMetaKey(sourceName));
    const remainingTtlSeconds = meta
      ? Math.max(1, Math.floor((Date.parse(meta.expiresAt) - Date.now()) / 1000))
      : this.serverConfig.datasetTtlSeconds;
    const existing = (await ctx.state.get<string[]>(key)) ?? [];
    if (existing.includes(path)) return;
    existing.push(path);
    await ctx.state.set(key, existing, { ttl: remainingTtlSeconds });
  }

  private async unlinkTrackedExports(ctx: Context, tableName: string): Promise<void> {
    const key = exportPathsKey(tableName);
    const paths = await ctx.state.get<string[]>(key);
    if (!paths || paths.length === 0) return;
    await Promise.allSettled(
      paths.map(async (path) => {
        try {
          await unlink(path);
        } catch (err) {
          ctx.log.debug('Paired export unlink failed (likely already removed)', {
            tableName,
            path,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
    await ctx.state.delete(key);
  }

  /**
   * Describe one or all canvas tables, augmenting the framework's `TableInfo`
   * with originating-source provenance for auto-registered tables.
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
    if (table.name.startsWith(DATAFRAME_TABLE_PREFIX)) {
      const meta = await ctx.state.get<CanvasTableMeta>(tableMetaKey(table.name));
      if (meta) out.provenance = meta;
    }
    return out;
  }
}

/**
 * Generate a fresh canvas-safe dataframe name. Hyphens in `crypto.randomUUID()`
 * fail the canvas identifier gate, so we replace them with underscores and
 * prefix with `df_` to mark the namespace as auto-registered.
 */
function generateDataframeName(): string {
  return `${DATAFRAME_TABLE_PREFIX}${crypto.randomUUID().replace(/-/g, '_')}`;
}

/**
 * Reason string set on `validationError.data.reason` when a query is rejected
 * for reaching into DuckDB's system catalogs. Exported so the dataframe-query
 * tool can recognize it alongside the framework's `SQL_GATE_REASONS` and route
 * it through the typed `sql_rejected` contract.
 */
export const SYSTEM_CATALOG_ACCESS_REASON = 'system_catalog_access' as const;

/**
 * DuckDB metadata views and functions that enumerate the canvas. Catalog
 * schemas are matched as qualified references (`schema.thing`) so legitimate
 * column names like `information_schema_id` don't false-positive. DuckDB's
 * `duckdb_*` introspection functions are matched at the call site (`name(`)
 * so columns or projected literals carrying the same prefix don't trigger.
 */
const SYSTEM_CATALOG_PATTERNS: ReadonlyArray<{ regex: RegExp; label: string }> = [
  { regex: /\binformation_schema\s*\.\s*\w+/i, label: 'information_schema' },
  { regex: /\bpg_catalog\s*\.\s*\w+/i, label: 'pg_catalog' },
  { regex: /\bsqlite_master\b/i, label: 'sqlite_master' },
  { regex: /\bsqlite_temp_master\b/i, label: 'sqlite_temp_master' },
  {
    regex:
      /\bduckdb_(?:tables|columns|views|databases|schemas|functions|types|secrets|extensions|settings|temporary_files|memory|approx_database_size|optimizers|prepared_statements|sequences|indexes|constraints|keywords|dependencies|log_contexts|logs|temp_files|temp_relations|sql_keywords|lib_versions)\s*\(/i,
    label: 'duckdb_*',
  },
];

/** Strip SQL block and line comments — mirror of the framework gate's helper. */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, '');
}

/**
 * Strip standard SQL string literals so values that happen to mention catalog
 * names (e.g. `WHERE col = 'information_schema.tables'`) don't trigger the
 * deny. Matches single-quoted strings with `''` escape; mirror of the
 * framework gate's helper.
 */
function stripSqlStringLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

/**
 * Reject SQL that reaches into DuckDB's system catalogs (information_schema,
 * pg_catalog, sqlite_master, duckdb_* introspection functions). Possession of
 * a `df_<uuid>` name is the capability gate for direct queries; system catalogs
 * would let any caller list every name on the shared canvas, bypassing that
 * gate. Throws `validationError` with `data.reason = 'system_catalog_access'`
 * so the dataframe-query tool's contract translator routes it through
 * `sql_rejected`.
 */
function assertNoSystemCatalogAccess(sql: string): void {
  const stripped = stripSqlStringLiterals(stripSqlComments(sql));
  for (const { regex, label } of SYSTEM_CATALOG_PATTERNS) {
    if (regex.test(stripped)) {
      throw validationError(
        `Canvas query references a system catalog (${label}). System tables and metadata views are not accessible — use brapi_dataframe_describe with a specific dataframe name to inspect schema.`,
        { reason: SYSTEM_CATALOG_ACCESS_REASON, catalog: label },
      );
    }
  }
}

function tableMetaKey(tableName: string): string {
  return `${TABLE_META_PREFIX}${tableName}`;
}

function exportPathsKey(tableName: string): string {
  return `${EXPORT_PATHS_PREFIX}${tableName}`;
}

function isCanvasNotFound(err: unknown): boolean {
  return err instanceof McpError && err.code === JsonRpcErrorCode.NotFound;
}

/**
 * Walk every row, union the JS-side types per column, and emit a
 * `ColumnSchema[]` with `nullable: true` on every column. Mirrors the
 * framework's sniffer type classification (string/integer/double/bigint/
 * boolean/object) so the inferred DuckDB types stay identical, but never
 * emits NOT NULL constraints — sample-based sniffing cannot prove the
 * absence of nulls, and a wrong NOT NULL inference rolls back the entire
 * appender batch when the first violating row appears later.
 *
 * Walks the full row set rather than a sample so that columns appearing
 * only in late rows still show up in the schema. We already hold every
 * row in memory at this point (the spillover persisted them), so the
 * extra pass is cheap.
 */
function deriveAllNullableSchema(rows: ReadonlyArray<Record<string, unknown>>): ColumnSchema[] {
  const observedByCol = new Map<string, Set<JsTypeTag>>();
  const columnOrder: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      let bag = observedByCol.get(key);
      if (!bag) {
        bag = new Set();
        observedByCol.set(key, bag);
        columnOrder.push(key);
      }
      bag.add(classifyValue(row[key]));
    }
  }
  return columnOrder.map((name) => ({
    name,
    type: unionToColumnType(observedByCol.get(name) ?? new Set(['null'])),
    nullable: true,
  }));
}

type JsTypeTag = 'null' | 'string' | 'boolean' | 'integer' | 'double' | 'bigint' | 'object';

function classifyValue(value: unknown): JsTypeTag {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'bigint') return 'bigint';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'double';
  return 'object';
}

function unionToColumnType(observed: Set<JsTypeTag>): ColumnType {
  const nonNull = new Set(observed);
  nonNull.delete('null');
  if (nonNull.size === 0) return 'VARCHAR';
  if (nonNull.size === 1) {
    const [only] = nonNull;
    switch (only) {
      case 'string':
        return 'VARCHAR';
      case 'integer':
      case 'bigint':
        return 'BIGINT';
      case 'double':
        return 'DOUBLE';
      case 'boolean':
        return 'BOOLEAN';
      case 'object':
        return 'JSON';
      default:
        return 'VARCHAR';
    }
  }
  const allNumeric = [...nonNull].every((t) => t === 'integer' || t === 'double' || t === 'bigint');
  if (allNumeric) return nonNull.has('double') ? 'DOUBLE' : 'BIGINT';
  if (!nonNull.has('string') && nonNull.has('object')) return 'JSON';
  return 'VARCHAR';
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
    controller.abort(new Error(`Dataframe query timed out after ${timeoutMs}ms`));
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
 * Initialize the singleton bridge. The framework canvas is mandatory — the
 * caller is responsible for ensuring `core.canvas` is defined before this
 * runs (`createApp` setup hook should fail closed when it isn't).
 */
export function initCanvasBridge(canvas: DataCanvas, serverConfig: ServerConfig): CanvasBridge {
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
