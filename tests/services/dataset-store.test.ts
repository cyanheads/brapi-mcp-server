/**
 * @fileoverview Unit tests for DatasetStore. Covers create/summary/load/list/
 * delete, column inference + projection, pagination edges, and validation
 * errors for unknown columns and out-of-range pages.
 *
 * @module tests/services/dataset-store.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { DatasetStore } from '@/services/dataset-store/dataset-store.js';

const baseConfig: ServerConfig = {
  defaultApiKeyHeader: 'Authorization',
  datasetTtlSeconds: 86_400,
  loadLimit: 200,
  maxConcurrentRequests: 4,
  retryMaxAttempts: 0,
  retryBaseDelayMs: 1,
  referenceCacheTtlSeconds: 3_600,
  requestTimeoutMs: 1_000,
  searchPollTimeoutMs: 5_000,
  searchPollIntervalMs: 1,
  allowPrivateIps: false,
};

function sampleRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    studyDbId: `s${i + 1}`,
    studyName: `Study ${i + 1}`,
    seasons: ['2022'],
  }));
}

describe('DatasetStore', () => {
  let store: DatasetStore;

  beforeEach(() => {
    store = new DatasetStore(baseConfig);
  });

  describe('create', () => {
    it('persists metadata and rows and returns the metadata', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const rows = sampleRows(3);

      const meta = await store.create(ctx, {
        source: 'find_studies',
        baseUrl: 'https://brapi.example.org/brapi/v2',
        query: { crop: 'Cassava' },
        rows,
      });

      expect(meta.datasetId).toMatch(/^[0-9a-f-]{36}$/);
      expect(meta.rowCount).toBe(3);
      expect(meta.sizeBytes).toBeGreaterThan(0);
      expect(meta.columns.sort()).toEqual(['seasons', 'studyDbId', 'studyName']);
      expect(new Date(meta.expiresAt).getTime()).toBeGreaterThan(
        new Date(meta.createdAt).getTime(),
      );
    });

    it('uses explicit columns when provided and falls back to inference otherwise', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const withExplicit = await store.create(ctx, {
        source: 'find_studies',
        baseUrl: 'https://b/v2',
        query: {},
        rows: [{ studyDbId: 's1', extra: 'ignored' }],
        columns: ['studyDbId'],
      });
      expect(withExplicit.columns).toEqual(['studyDbId']);

      const inferred = await store.create(ctx, {
        source: 'find_studies',
        baseUrl: 'https://b/v2',
        query: {},
        rows: [
          { a: 1, b: 2 },
          { b: 3, c: 4 },
        ],
      });
      expect(inferred.columns.sort()).toEqual(['a', 'b', 'c']);
    });

    it('rejects creation without source or baseUrl', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      await expect(
        store.create(ctx, {
          source: '',
          baseUrl: 'https://b/v2',
          query: {},
          rows: [],
        }),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      await expect(
        store.create(ctx, {
          source: 'find_studies',
          baseUrl: '',
          query: {},
          rows: [],
        }),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
    });
  });

  describe('summary', () => {
    it('returns metadata without touching the row payload', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const created = await store.create(ctx, {
        source: 'find_studies',
        baseUrl: 'https://b/v2',
        query: {},
        rows: sampleRows(5),
      });
      const summary = await store.summary(ctx, created.datasetId);
      expect(summary).toEqual(created);
    });

    it('throws NotFound for unknown datasets', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      await expect(store.summary(ctx, 'missing-id')).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
      });
    });
  });

  describe('load', () => {
    it('returns the first page by default with pageSize 100', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const created = await store.create(ctx, {
        source: 'find_studies',
        baseUrl: 'https://b/v2',
        query: {},
        rows: sampleRows(150),
      });
      const page = await store.load(ctx, created.datasetId);
      expect(page.page).toBe(1);
      expect(page.pageSize).toBe(100);
      expect(page.totalRows).toBe(150);
      expect(page.totalPages).toBe(2);
      expect(page.rows).toHaveLength(100);
      expect(page.rows[0]).toMatchObject({ studyDbId: 's1' });
    });

    it('slices by page and pageSize', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const created = await store.create(ctx, {
        source: 'find_studies',
        baseUrl: 'https://b/v2',
        query: {},
        rows: sampleRows(25),
      });
      const p2 = await store.load(ctx, created.datasetId, { page: 2, pageSize: 10 });
      expect(p2.rows).toHaveLength(10);
      expect(p2.rows[0]).toMatchObject({ studyDbId: 's11' });
      const p3 = await store.load(ctx, created.datasetId, { page: 3, pageSize: 10 });
      expect(p3.rows).toHaveLength(5);
      expect(p3.totalPages).toBe(3);
    });

    it('clamps pageSize to max 1000 and falls back to default on invalid values', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const created = await store.create(ctx, {
        source: 'find_studies',
        baseUrl: 'https://b/v2',
        query: {},
        rows: sampleRows(5),
      });
      const clamped = await store.load(ctx, created.datasetId, { pageSize: 9999 });
      expect(clamped.pageSize).toBe(1_000);
      const defaulted = await store.load(ctx, created.datasetId, { pageSize: -1 });
      expect(defaulted.pageSize).toBe(100);
    });

    it('projects columns when requested', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const created = await store.create(ctx, {
        source: 'find_studies',
        baseUrl: 'https://b/v2',
        query: {},
        rows: sampleRows(3),
      });
      const page = await store.load(ctx, created.datasetId, {
        columns: ['studyDbId'],
      });
      expect(page.rows[0]).toEqual({ studyDbId: 's1' });
      expect(page.rows[0]).not.toHaveProperty('studyName');
    });

    it('rejects unknown columns with ValidationError', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const created = await store.create(ctx, {
        source: 'find_studies',
        baseUrl: 'https://b/v2',
        query: {},
        rows: sampleRows(1),
      });
      await expect(
        store.load(ctx, created.datasetId, { columns: ['studyDbId', 'bogus'] }),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
    });

    it('rejects out-of-range page with ValidationError', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const created = await store.create(ctx, {
        source: 'find_studies',
        baseUrl: 'https://b/v2',
        query: {},
        rows: sampleRows(5),
      });
      await expect(store.load(ctx, created.datasetId, { page: 99 })).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
      });
    });

    it('handles empty datasets without surprises', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const created = await store.create(ctx, {
        source: 'find_studies',
        baseUrl: 'https://b/v2',
        query: {},
        rows: [],
      });
      const page = await store.load(ctx, created.datasetId);
      expect(page.rows).toEqual([]);
      expect(page.totalRows).toBe(0);
      expect(page.totalPages).toBe(1);
    });
  });

  describe('list', () => {
    it('returns metadata for all datasets owned by the tenant', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const a = await store.create(ctx, {
        source: 'find_studies',
        baseUrl: 'https://b/v2',
        query: { crop: 'Cassava' },
        rows: sampleRows(2),
      });
      const b = await store.create(ctx, {
        source: 'find_observations',
        baseUrl: 'https://b/v2',
        query: {},
        rows: sampleRows(3),
      });

      const listed = await store.list(ctx);
      const ids = listed.datasets.map((d) => d.datasetId).sort();
      expect(ids).toEqual([a.datasetId, b.datasetId].sort());
    });

    it('isolates datasets by tenant', async () => {
      const ctxA = createMockContext({ tenantId: 'tenant-a' });
      const ctxB = createMockContext({ tenantId: 'tenant-b' });
      await store.create(ctxA, {
        source: 'find_studies',
        baseUrl: 'https://b/v2',
        query: {},
        rows: sampleRows(1),
      });
      const listedB = await store.list(ctxB);
      expect(listedB.datasets).toHaveLength(0);
    });
  });

  describe('delete', () => {
    it('removes both metadata and row payload', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const created = await store.create(ctx, {
        source: 'find_studies',
        baseUrl: 'https://b/v2',
        query: {},
        rows: sampleRows(2),
      });
      await store.delete(ctx, created.datasetId);
      await expect(store.summary(ctx, created.datasetId)).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
      });
    });

    it('is idempotent when the dataset is already gone', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      await expect(store.delete(ctx, 'never-existed')).resolves.toBeUndefined();
    });
  });
});
