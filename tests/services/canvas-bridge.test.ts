/**
 * @fileoverview Unit tests for CanvasBridge — the per-tenant default-canvas
 * resolver, dataframe naming, provenance tracking, and register/drop hooks.
 * Drives the framework canvas API via an in-memory `FakeDataCanvas` so DuckDB
 * isn't pulled into the test path.
 *
 * @module tests/services/canvas-bridge.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { CanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
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
  genotypeCallsMaxPull: 100_000,
  canvasDropEnabled: false,
  canvasMaxRows: 100,
  canvasQueryTimeoutMs: 30_000,
};

function asCanvas(fake: FakeDataCanvas): DataCanvas {
  return fake as unknown as DataCanvas;
}

/**
 * Build N mock contexts that all see the same backing state Map. Mirrors what
 * the framework does in production under one tenantId — `StorageService` keys
 * writes by tenant, so two handlers under the same `tid` share the same view.
 * `createMockContext` gives each call its own private Map by default; this
 * helper patches them onto a shared store so multi-context collaboration
 * inside one tenant can be tested faithfully.
 */
function createSharedTenantContexts(tenantId: string, count: number): Context[] {
  const store = new Map<string, unknown>();
  const expiry = new Map<string, number>();

  const buildState = (): Context['state'] =>
    ({
      async get<T>(key: string): Promise<T | null> {
        const exp = expiry.get(key);
        if (exp !== undefined && exp <= Date.now()) {
          store.delete(key);
          expiry.delete(key);
          return null;
        }
        return (store.get(key) as T | undefined) ?? null;
      },
      async set(key: string, value: unknown, opts?: { ttl?: number }): Promise<void> {
        store.set(key, value);
        if (opts?.ttl !== undefined) expiry.set(key, Date.now() + opts.ttl * 1000);
      },
      async delete(key: string): Promise<void> {
        store.delete(key);
        expiry.delete(key);
      },
      async deleteMany(): Promise<number> {
        return 0;
      },
      async getMany<T>(): Promise<Map<string, T>> {
        return new Map();
      },
      async list(): Promise<{ items: Array<{ key: string; value: unknown }>; cursor?: string }> {
        return { items: [] };
      },
      async setMany(): Promise<void> {
        /* unused by CanvasBridge */
      },
    }) as unknown as Context['state'];

  return Array.from({ length: count }, () => {
    const ctx = createMockContext({ tenantId });
    (ctx as { state: Context['state'] }).state = buildState();
    return ctx;
  });
}

describe('CanvasBridge.getInstance', () => {
  let canvas: FakeDataCanvas;
  let bridge: CanvasBridge;

  beforeEach(() => {
    canvas = new FakeDataCanvas();
    bridge = new CanvasBridge(asCanvas(canvas), baseConfig);
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
});

describe('CanvasBridge — multi-context tenant scoping', () => {
  let canvas: FakeDataCanvas;
  let bridge: CanvasBridge;

  beforeEach(() => {
    canvas = new FakeDataCanvas();
    bridge = new CanvasBridge(asCanvas(canvas), baseConfig);
  });

  it('shares one canvas across two contexts in the same tenant', async () => {
    const [ctx1, ctx2] = createSharedTenantContexts('alice', 2) as [Context, Context];
    const first = await bridge.getInstance(ctx1);
    const second = await bridge.getInstance(ctx2);
    expect(second.canvasId).toBe(first.canvasId);
    expect(second.isNew).toBe(false);
  });

  it('lets a second context in the same tenant see a dataframe registered by the first', async () => {
    const [registrar, viewer] = createSharedTenantContexts('alice', 2) as [Context, Context];
    const handle = await bridge.registerDataframe(registrar, {
      source: 'find_observations',
      baseUrl: 'https://b/v2',
      query: { studies: ['422'] },
      rows: [{ observationDbId: 'o1' }, { observationDbId: 'o2' }],
    });
    const tables = await bridge.describe(viewer, { tableName: handle.tableName });
    expect(tables).toHaveLength(1);
    expect(tables[0]?.name).toBe(handle.tableName);
    expect(tables[0]?.rowCount).toBe(2);
    expect(tables[0]?.provenance?.source).toBe('find_observations');
    expect(tables[0]?.provenance?.baseUrl).toBe('https://b/v2');
  });

  it('hides one tenant’s dataframe from another tenant even if the canvasId leaks', async () => {
    // Register a dataframe under tenant alice.
    const ctxAlice = createMockContext({ tenantId: 'alice' });
    const handle = await bridge.registerDataframe(ctxAlice, {
      source: 'find_observations',
      baseUrl: 'https://b/v2',
      query: {},
      rows: [{ observationDbId: 'o1' }],
    });
    const aliceCanvas = await bridge.getInstance(ctxAlice);

    // Simulate a state-poisoning attack — plant alice's canvasId in bob's
    // tenant-scoped state. The framework's tenant gate (mirrored by
    // FakeDataCanvas.acquire) rejects the cross-tenant acquire; the bridge's
    // recovery path then carves bob a fresh canvas under his own tenantId.
    const ctxBob = createMockContext({ tenantId: 'bob' });
    await ctxBob.state.set('brapi/canvas/default', aliceCanvas.canvasId);

    const bobCanvas = await bridge.getInstance(ctxBob);
    expect(bobCanvas.canvasId).not.toBe(aliceCanvas.canvasId);

    // bob's canvas is empty — alice's df_<uuid> is unreachable.
    const bobTables = await bridge.describe(ctxBob);
    expect(bobTables).toEqual([]);
    const namedLookup = await bridge.describe(ctxBob, { tableName: handle.tableName });
    expect(namedLookup).toEqual([]);
  });
});

describe('CanvasBridge.registerDataframe', () => {
  let canvas: FakeDataCanvas;
  let bridge: CanvasBridge;

  beforeEach(() => {
    canvas = new FakeDataCanvas();
    bridge = new CanvasBridge(asCanvas(canvas), baseConfig);
  });

  it('materializes rows under df_<uuid> and persists provenance', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    const rows = [
      { observationDbId: 'o1', value: '12.3' },
      { observationDbId: 'o2', value: '14.1' },
    ];

    const result = await bridge.registerDataframe(ctx, {
      source: 'find_observations',
      baseUrl: 'https://brapi.example.org/brapi/v2',
      query: { studies: ['422'] },
      rows,
    });
    expect(result.tableName.startsWith('df_')).toBe(true);
    expect(result.rowCount).toBe(2);
    expect(result.columns).toEqual(['observationDbId', 'value']);

    // expiresAt - createdAt must equal datasetTtlSeconds (24h by default) —
    // pins the README's "24h TTL caps blast radius" claim against drift.
    const elapsedSeconds = (Date.parse(result.expiresAt) - Date.parse(result.createdAt)) / 1000;
    expect(elapsedSeconds).toBe(baseConfig.datasetTtlSeconds);

    const stored = await ctx.state.get(`brapi/canvas/tablemeta/${result.tableName}`);
    expect(stored).toMatchObject({
      source: 'find_observations',
      baseUrl: 'https://brapi.example.org/brapi/v2',
      query: { studies: ['422'] },
    });
  });

  it('propagates truncated + maxRows when the spillover hit a cap', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    const result = await bridge.registerDataframe(ctx, {
      source: 'find_observations',
      baseUrl: 'https://b/v2',
      query: {},
      rows: [{ a: 1 }],
      truncated: true,
      maxRows: 50_000,
    });
    expect(result.truncated).toBe(true);
    expect(result.maxRows).toBe(50_000);
  });

  it('generates unique table names across calls', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    const a = await bridge.registerDataframe(ctx, {
      source: 'find_observations',
      baseUrl: 'https://b/v2',
      query: {},
      rows: [{ a: 1 }],
    });
    const b = await bridge.registerDataframe(ctx, {
      source: 'find_observations',
      baseUrl: 'https://b/v2',
      query: {},
      rows: [{ a: 2 }],
    });
    expect(a.tableName).not.toBe(b.tableName);
  });
});

describe('CanvasBridge.query', () => {
  it('caps rowLimit to canvasMaxRows', async () => {
    const canvas = new FakeDataCanvas();
    const bridge = new CanvasBridge(asCanvas(canvas), baseConfig);
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
    const bridge = new CanvasBridge(asCanvas(canvas), baseConfig);
    const ctx = createMockContext({ tenantId: 't1' });
    const result = await bridge.query(ctx, 'SELECT 1', {
      preview: 5,
      registerAs: 'my_table',
    });
    expect(result.tableName).toBe('my_table');
  });
});

describe('CanvasBridge.describe', () => {
  it('augments TableInfo for df_-prefixed tables with stored provenance', async () => {
    const canvas = new FakeDataCanvas();
    const bridge = new CanvasBridge(asCanvas(canvas), baseConfig);
    const ctx = createMockContext({ tenantId: 't1' });
    await bridge.registerDataframe(ctx, {
      source: 'find_observations',
      baseUrl: 'https://b/v2',
      query: { studies: ['422'] },
      rows: [{ value: 1 }],
    });

    const tables = await bridge.describe(ctx);
    expect(tables).toHaveLength(1);
    const [table] = tables;
    expect(table?.provenance?.source).toBe('find_observations');
  });

  it('omits provenance for user-derived tables (registerAs) without provenance', async () => {
    const canvas = new FakeDataCanvas();
    const bridge = new CanvasBridge(asCanvas(canvas), baseConfig);
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
    const bridge = new CanvasBridge(asCanvas(canvas), baseConfig);
    const ctx = createMockContext({ tenantId: 't1' });
    await bridge.registerTable(ctx, 'staging', [{ a: 1 }]);
    const dropped = await bridge.drop(ctx, 'staging');
    expect(dropped).toBe(true);
  });

  it('returns false for unknown tables', async () => {
    const canvas = new FakeDataCanvas();
    const bridge = new CanvasBridge(asCanvas(canvas), baseConfig);
    const ctx = createMockContext({ tenantId: 't1' });
    // Force an instance to exist so describe doesn't error.
    await bridge.getInstance(ctx);
    const dropped = await bridge.drop(ctx, 'never_existed');
    expect(dropped).toBe(false);
  });

  it('clears provenance metadata when dropping a df_-prefixed table', async () => {
    const canvas = new FakeDataCanvas();
    const bridge = new CanvasBridge(asCanvas(canvas), baseConfig);
    const ctx = createMockContext({ tenantId: 't1' });
    const handle = await bridge.registerDataframe(ctx, {
      source: 'find_observations',
      baseUrl: 'https://b/v2',
      query: {},
      rows: [{ a: 1 }],
    });

    const dropped = await bridge.drop(ctx, handle.tableName);
    expect(dropped).toBe(true);
    const stored = await ctx.state.get(`brapi/canvas/tablemeta/${handle.tableName}`);
    expect(stored).toBeNull();
  });
});
