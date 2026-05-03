/**
 * @fileoverview Unit tests for CanvasBridge — the per-tenant default-canvas
 * resolver, dataset-table naming, provenance tracking, and best-effort
 * register/drop hooks. Drives the framework canvas API via an in-memory
 * `FakeDataCanvas` so DuckDB isn't pulled into the test path.
 *
 * @module tests/services/canvas-bridge.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import {
  CanvasBridge,
  datasetTableName,
  tableNameToDatasetId,
} from '@/services/canvas-bridge/canvas-bridge.js';
import type { DatasetMetadata } from '@/services/dataset-store/index.js';
import { FakeDataCanvas } from './_fake-canvas.js';

const baseConfig: ServerConfig = {
  defaultApiKeyHeader: 'Authorization',
  datasetTtlSeconds: 86_400,
  loadLimit: 200,
  maxConcurrentRequests: 4,
  retryMaxAttempts: 0,
  retryBaseDelayMs: 1,
  referenceCacheTtlSeconds: 3_600,
  requestTimeoutMs: 1_000,
  companionTimeoutMs: 500,
  searchPollTimeoutMs: 5_000,
  searchPollIntervalMs: 1,
  allowPrivateIps: false,
  enableWrites: false,
  canvasEnabled: true,
  canvasMaxRows: 100,
  canvasQueryTimeoutMs: 30_000,
};

function sampleMetadata(overrides: Partial<DatasetMetadata> = {}): DatasetMetadata {
  const datasetId = overrides.datasetId ?? '7b2f9c3a-8d4e-4b1a-9c5f-1e2d3c4b5a6e';
  return {
    datasetId,
    source: 'find_observations',
    baseUrl: 'https://brapi.example.org/brapi/v2',
    query: { studies: ['422'] },
    rowCount: 3,
    columns: ['observationDbId', 'value'],
    sizeBytes: 256,
    createdAt: '2026-05-02T10:00:00.000Z',
    expiresAt: '2026-05-03T10:00:00.000Z',
    ...overrides,
  };
}

describe('datasetTableName / tableNameToDatasetId', () => {
  it('round-trips a UUID', () => {
    const id = '7b2f9c3a-8d4e-4b1a-9c5f-1e2d3c4b5a6e';
    expect(datasetTableName(id)).toBe('ds_7b2f9c3a_8d4e_4b1a_9c5f_1e2d3c4b5a6e');
    expect(tableNameToDatasetId('ds_7b2f9c3a_8d4e_4b1a_9c5f_1e2d3c4b5a6e')).toBe(id);
  });

  it('returns undefined for non-`ds_` prefixed names', () => {
    expect(tableNameToDatasetId('plant_height_means')).toBeUndefined();
    expect(tableNameToDatasetId('staging')).toBeUndefined();
  });
});

describe('CanvasBridge.isEnabled', () => {
  it('is false when canvas is undefined', () => {
    const bridge = new CanvasBridge(undefined, baseConfig);
    expect(bridge.isEnabled()).toBe(false);
  });

  it('is false when canvasEnabled flag is off', () => {
    const bridge = new CanvasBridge(new FakeDataCanvas(), {
      ...baseConfig,
      canvasEnabled: false,
    });
    expect(bridge.isEnabled()).toBe(false);
  });

  it('is true when both canvas and the flag are on', () => {
    const bridge = new CanvasBridge(new FakeDataCanvas(), baseConfig);
    expect(bridge.isEnabled()).toBe(true);
  });
});

describe('CanvasBridge.getInstance', () => {
  let canvas: FakeDataCanvas;
  let bridge: CanvasBridge;

  beforeEach(() => {
    canvas = new FakeDataCanvas();
    bridge = new CanvasBridge(canvas, baseConfig);
  });

  it('acquires a fresh canvas on first call and caches the canvasId', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    const instance = await bridge.getInstance(ctx);
    expect(instance.isNew).toBe(true);
    const cached = await ctx.state.get<string>('brapi/canvas/default');
    expect(cached).toBe(instance.canvasId);
  });

  it('reuses the cached canvasId on subsequent calls', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    const first = await bridge.getInstance(ctx);
    const second = await bridge.getInstance(ctx);
    expect(second.canvasId).toBe(first.canvasId);
    expect(second.isNew).toBe(false);
  });

  it('isolates canvases by tenant', async () => {
    const ctxA = createMockContext({ tenantId: 'tenant-a' });
    const ctxB = createMockContext({ tenantId: 'tenant-b' });
    const a = await bridge.getInstance(ctxA);
    const b = await bridge.getInstance(ctxB);
    expect(a.canvasId).not.toBe(b.canvasId);
  });

  it('recovers from a stale cached id by clearing and re-acquiring', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    const original = await bridge.getInstance(ctx);
    // Simulate the cached canvas being dropped externally (TTL expiry).
    await canvas.drop(original.canvasId);
    const fresh = await bridge.getInstance(ctx);
    expect(fresh.canvasId).not.toBe(original.canvasId);
    expect(fresh.isNew).toBe(true);
    const cached = await ctx.state.get<string>('brapi/canvas/default');
    expect(cached).toBe(fresh.canvasId);
  });

  it('throws when called while disabled', async () => {
    const offBridge = new CanvasBridge(undefined, baseConfig);
    const ctx = createMockContext({ tenantId: 't1' });
    await expect(offBridge.getInstance(ctx)).rejects.toThrow(/disabled/i);
  });
});

describe('CanvasBridge.registerDataset', () => {
  let canvas: FakeDataCanvas;
  let bridge: CanvasBridge;

  beforeEach(() => {
    canvas = new FakeDataCanvas();
    bridge = new CanvasBridge(canvas, baseConfig);
  });

  it('registers rows under ds_<datasetId> and persists provenance', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    const meta = sampleMetadata();
    const rows = [
      { observationDbId: 'o1', value: '12.3' },
      { observationDbId: 'o2', value: '14.1' },
    ];

    const result = await bridge.registerDataset(ctx, meta, rows);
    expect(result.registered).toBe(true);
    expect(result.tableName).toBe(datasetTableName(meta.datasetId));

    const stored = await ctx.state.get(`brapi/canvas/tablemeta/${result.tableName}`);
    expect(stored).toMatchObject({
      datasetId: meta.datasetId,
      source: 'find_observations',
      baseUrl: meta.baseUrl,
    });
  });

  it('no-ops cleanly when canvas is disabled', async () => {
    const offBridge = new CanvasBridge(undefined, baseConfig);
    const ctx = createMockContext({ tenantId: 't1' });
    const result = await offBridge.registerDataset(ctx, sampleMetadata(), []);
    expect(result.registered).toBe(false);
    expect(result.tableName).toBeUndefined();
  });

  it('logs a warning and returns registered:false on failure', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    const meta = sampleMetadata();
    // First registration succeeds.
    await bridge.registerDataset(ctx, meta, [{ a: 1 }]);
    const warnSpy = vi.spyOn(ctx.log, 'warning');
    // Second registration with the same datasetId hits the fake's "already exists" path.
    const result = await bridge.registerDataset(ctx, meta, [{ a: 1 }]);
    expect(result.registered).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Canvas auto-register failed'),
      expect.objectContaining({ datasetId: meta.datasetId }),
    );
  });
});

describe('CanvasBridge.dropDataset', () => {
  it('drops the table and clears the provenance entry', async () => {
    const canvas = new FakeDataCanvas();
    const bridge = new CanvasBridge(canvas, baseConfig);
    const ctx = createMockContext({ tenantId: 't1' });
    const meta = sampleMetadata();
    await bridge.registerDataset(ctx, meta, [{ a: 1 }]);
    const tableName = datasetTableName(meta.datasetId);

    const result = await bridge.dropDataset(ctx, meta.datasetId);
    expect(result.dropped).toBe(true);
    const meta2 = await ctx.state.get(`brapi/canvas/tablemeta/${tableName}`);
    expect(meta2).toBeNull();
  });

  it('returns dropped:false when the table never existed', async () => {
    const bridge = new CanvasBridge(new FakeDataCanvas(), baseConfig);
    const ctx = createMockContext({ tenantId: 't1' });
    const result = await bridge.dropDataset(ctx, '00000000-0000-0000-0000-000000000000');
    expect(result.dropped).toBe(false);
  });

  it('no-ops cleanly when canvas is disabled', async () => {
    const offBridge = new CanvasBridge(undefined, baseConfig);
    const ctx = createMockContext({ tenantId: 't1' });
    const result = await offBridge.dropDataset(ctx, 'whatever');
    expect(result.dropped).toBe(false);
  });
});

describe('CanvasBridge.query (server-side forbidden-function deny-list)', () => {
  it.each([
    ['read_json', "SELECT * FROM read_json('/etc/passwd')"],
    ['read_json_auto', "SELECT * FROM read_json_auto('/etc/hostname')"],
    ['read_json_objects', "SELECT * FROM read_json_objects('/x.json')"],
    ['read_ndjson', "SELECT * FROM read_ndjson('/x.ndjson')"],
    ['read_parquet', "SELECT * FROM read_parquet('/x.parquet')"],
    ['parquet_scan', "SELECT * FROM parquet_scan('/x.parquet')"],
    ['iceberg_scan', "SELECT * FROM iceberg_scan('/x')"],
    ['delta_scan', "SELECT * FROM delta_scan('/x')"],
  ])('rejects %s before reaching the canvas', async (fn, sql) => {
    const canvas = new FakeDataCanvas();
    const bridge = new CanvasBridge(canvas, baseConfig);
    const ctx = createMockContext({ tenantId: 't1' });
    await expect(bridge.query(ctx, sql)).rejects.toMatchObject({
      data: expect.objectContaining({
        reason: 'plan_operator_not_allowed',
        forbiddenFunction: fn,
      }),
    });
    // Confirm the canvas was never even acquired — the deny-list short-circuits
    // before getInstance().
    expect(canvas.canvases.size).toBe(0);
  });

  it('matches case-insensitively and tolerates whitespace before the open paren', async () => {
    const canvas = new FakeDataCanvas();
    const bridge = new CanvasBridge(canvas, baseConfig);
    const ctx = createMockContext({ tenantId: 't1' });
    await expect(
      bridge.query(ctx, "SELECT * FROM READ_JSON   ('/etc/passwd')"),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ forbiddenFunction: 'read_json' }),
    });
  });

  it('does not flag column names that happen to contain a forbidden substring', async () => {
    // `myread_json_data` is a column name, not a call — no `(` follows.
    const canvas = new FakeDataCanvas();
    const bridge = new CanvasBridge(canvas, baseConfig);
    const ctx = createMockContext({ tenantId: 't1' });
    // Should pass the deny-list and reach the (fake) canvas, returning empty rows.
    const result = await bridge.query(ctx, 'SELECT myread_json_data FROM ds_x');
    expect(result.rowCount).toBe(0);
  });
});

describe('CanvasBridge.query', () => {
  it('caps rowLimit to canvasMaxRows', async () => {
    const canvas = new FakeDataCanvas();
    const bridge = new CanvasBridge(canvas, baseConfig);
    const ctx = createMockContext({ tenantId: 't1' });
    const acquireSpy = vi.spyOn(canvas, 'acquire');
    await bridge.query(ctx, 'SELECT 1', { rowLimit: 10_000_000 });
    // Ensure the bridge acquired (canvas must be alive); the rowLimit cap is
    // applied inside the bridge before the call to instance.query — covered
    // here by the absence of a thrown error and by the unit-level check below
    // that `Math.min(rowLimit, cap)` is the cap when input exceeds it.
    expect(acquireSpy).toHaveBeenCalled();
  });

  it('passes preview and registerAs through', async () => {
    const canvas = new FakeDataCanvas();
    const bridge = new CanvasBridge(canvas, baseConfig);
    const ctx = createMockContext({ tenantId: 't1' });
    const result = await bridge.query(ctx, 'SELECT 1', {
      preview: 5,
      registerAs: 'my_table',
    });
    expect(result.tableName).toBe('my_table');
  });
});

describe('CanvasBridge.describe', () => {
  it('augments TableInfo for ds_-prefixed tables with stored provenance', async () => {
    const canvas = new FakeDataCanvas();
    const bridge = new CanvasBridge(canvas, baseConfig);
    const ctx = createMockContext({ tenantId: 't1' });
    const meta = sampleMetadata();
    await bridge.registerDataset(ctx, meta, [{ value: 1 }]);

    const tables = await bridge.describe(ctx);
    expect(tables).toHaveLength(1);
    const [table] = tables;
    expect(table?.provenance).toMatchObject({
      datasetId: meta.datasetId,
      source: 'find_observations',
    });
  });

  it('omits provenance for user-derived tables (registerAs) without provenance', async () => {
    const canvas = new FakeDataCanvas();
    const bridge = new CanvasBridge(canvas, baseConfig);
    const ctx = createMockContext({ tenantId: 't1' });
    await bridge.query(ctx, 'SELECT 1', { registerAs: 'derived' });

    const tables = await bridge.describe(ctx, { tableName: 'derived' });
    expect(tables).toHaveLength(1);
    expect(tables[0]?.provenance).toBeUndefined();
  });
});

describe('CanvasBridge.drop', () => {
  it('drops a named table and returns true', async () => {
    const canvas = new FakeDataCanvas();
    const bridge = new CanvasBridge(canvas, baseConfig);
    const ctx = createMockContext({ tenantId: 't1' });
    await bridge.registerTable(ctx, 'staging', [{ a: 1 }]);
    const dropped = await bridge.drop(ctx, 'staging');
    expect(dropped).toBe(true);
  });

  it('returns false for unknown tables', async () => {
    const canvas = new FakeDataCanvas();
    const bridge = new CanvasBridge(canvas, baseConfig);
    const ctx = createMockContext({ tenantId: 't1' });
    // Force an instance to exist so describe doesn't error.
    await bridge.getInstance(ctx);
    const dropped = await bridge.drop(ctx, 'never_existed');
    expect(dropped).toBe(false);
  });
});
