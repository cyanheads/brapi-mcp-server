/**
 * @fileoverview Lightweight fakes for `DataCanvas` and `CanvasInstance`.
 * Drives bridge tests without pulling in DuckDB. Mirrors the framework
 * surface enough for the bridge's call paths — register/drop/describe/query
 * are covered; export and SQL evaluation are stubbed (the bridge doesn't
 * exercise SQL here, only the orchestration around it).
 *
 * @module tests/services/_fake-canvas
 */

import type {
  CanvasInstance,
  ExportResult,
  ExportTarget,
  QueryResult,
  RegisterRows,
  RegisterTableResult,
  TableInfo,
} from '@cyanheads/mcp-ts-core/canvas';
import { conflict, notFound } from '@cyanheads/mcp-ts-core/errors';

interface FakeTable {
  columns: string[];
  rows: Record<string, unknown>[];
}

/** Internal state for a single fake canvas. */
interface FakeCanvasState {
  canvasId: string;
  expiresAt: string;
  tables: Map<string, FakeTable>;
  tenantId: string;
}

/**
 * Structural fake for `DataCanvas`. Tracks canvases by canvasId, returns
 * NotFound for unknown ids, supports registerTable/drop/describe/clear.
 * `query` is a minimal pass-through — registerAs lands a derived table so
 * follow-up describe() finds it.
 *
 * Pass `fake as unknown as DataCanvas` when constructing a `CanvasBridge` —
 * the framework class has private fields we don't replicate.
 */
export class FakeDataCanvas {
  readonly canvases = new Map<string, FakeCanvasState>();
  private idCounter = 0;

  async acquire(maybeId: string | undefined, ctx: { tenantId?: string }): Promise<CanvasInstance> {
    const tenantId = ctx.tenantId ?? 'default';
    if (maybeId !== undefined) {
      const existing = this.canvases.get(maybeId);
      if (!existing || existing.tenantId !== tenantId) {
        throw notFound(`Canvas ${maybeId} not found.`, { reason: 'canvas_not_found' });
      }
      existing.expiresAt = futureIso(24);
      return makeInstance(existing, /* isNew */ false);
    }
    this.idCounter += 1;
    const canvasId = `fake_${this.idCounter.toString(36).padStart(6, '0')}`;
    const state: FakeCanvasState = {
      canvasId,
      tenantId,
      expiresAt: futureIso(24),
      tables: new Map(),
    };
    this.canvases.set(canvasId, state);
    return makeInstance(state, /* isNew */ true);
  }

  async drop(canvasId: string): Promise<boolean> {
    return this.canvases.delete(canvasId);
  }

  countForTenant(ctx: { tenantId?: string }): number {
    const tenantId = ctx.tenantId ?? 'default';
    let count = 0;
    for (const state of this.canvases.values()) if (state.tenantId === tenantId) count++;
    return count;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async shutdown(): Promise<void> {
    this.canvases.clear();
  }
}

function makeInstance(state: FakeCanvasState, isNew: boolean): CanvasInstance {
  return {
    canvasId: state.canvasId,
    tenantId: state.tenantId,
    expiresAt: state.expiresAt,
    isNew,

    async registerTable(name: string, rows: RegisterRows): Promise<RegisterTableResult> {
      const materialized = await materialize(rows);
      if (state.tables.has(name)) {
        throw conflict(`Table ${name} already exists.`, { reason: 'table_conflict' });
      }
      const columns = materialized.length > 0 ? Object.keys(materialized[0] ?? {}) : [];
      state.tables.set(name, { columns, rows: materialized });
      return { tableName: name, rowCount: materialized.length, columns };
    },

    async query(
      _sql: string,
      opts?: { registerAs?: string; preview?: number },
    ): Promise<QueryResult> {
      // Minimal stub — return empty rows by default; if registerAs is set,
      // create an empty derived table so describe() has something to find.
      const rows: Record<string, unknown>[] = [];
      if (opts?.registerAs && !state.tables.has(opts.registerAs)) {
        state.tables.set(opts.registerAs, { columns: [], rows: [] });
      }
      const result: QueryResult = { rows, rowCount: 0, columns: [] };
      if (opts?.registerAs) result.tableName = opts.registerAs;
      return result;
    },

    async export(_tableName: string, target: ExportTarget): Promise<ExportResult> {
      return { format: target.format, rowCount: 0, sizeBytes: 0 };
    },

    async describe(opts?: { tableName?: string }): Promise<TableInfo[]> {
      const out: TableInfo[] = [];
      for (const [name, table] of state.tables) {
        if (opts?.tableName && opts.tableName !== name) continue;
        out.push({
          name,
          rowCount: table.rows.length,
          columns: table.columns.map((c) => ({ name: c, type: 'VARCHAR' })),
        });
      }
      return out;
    },

    async drop(name: string): Promise<boolean> {
      return state.tables.delete(name);
    },

    async clear(): Promise<number> {
      const count = state.tables.size;
      state.tables.clear();
      return count;
    },
  } as unknown as CanvasInstance;
}

async function materialize(rows: RegisterRows): Promise<Record<string, unknown>[]> {
  if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  const out: Record<string, unknown>[] = [];
  for await (const row of rows as AsyncIterable<Record<string, unknown>>) out.push(row);
  return out;
}

function futureIso(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}
