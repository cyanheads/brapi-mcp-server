/**
 * @fileoverview Handler tests for `brapi_dataframe_export`. Covers happy
 * paths (direct export, projection via columns, projection via sql), the
 * three typed errors (export_dir_unset, dataframe_not_found,
 * invalid_filename, mutually_exclusive_projection), and the paired-drop
 * cleanup contract through the bridge.
 *
 * @module tests/tools/brapi-dataframe-export.tool.test
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { resetServerConfig } from '@/config/server-config.js';
import { brapiDataframeExport } from '@/mcp-server/tools/definitions/brapi-dataframe-export.tool.js';
import { initCanvasBridge, resetCanvasBridge } from '@/services/canvas-bridge/index.js';
import { FakeDataCanvas } from '../services/_fake-canvas.js';
import { TEST_CONFIG } from './_tool-test-helpers.js';

describe('brapi_dataframe_export', () => {
  let exportDir: string;
  let fake: FakeDataCanvas;
  let testConfig: ServerConfig;

  beforeEach(async () => {
    exportDir = await mkdtemp(join(tmpdir(), 'brapi-export-test-'));
    fake = new FakeDataCanvas({ exportRoot: exportDir });
    testConfig = { ...TEST_CONFIG, exportDir };
    initCanvasBridge(fake as unknown as DataCanvas, testConfig);
    vi.stubEnv('BRAPI_EXPORT_DIR', exportDir);
    resetServerConfig();
  });

  afterEach(async () => {
    resetCanvasBridge();
    resetServerConfig();
    vi.unstubAllEnvs();
    await rm(exportDir, { recursive: true, force: true });
  });

  it('exports a dataframe to CSV at the configured directory and returns the absolute path', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeExport.errors });
    const bridge = (await import('@/services/canvas-bridge/index.js')).getCanvasBridge();
    await bridge.registerDataframe(ctx, {
      baseUrl: 'https://example.org/brapi/v2',
      query: { study: 's-1' },
      rows: [
        { germplasmName: 'IITA-TMS-1', value: 12 },
        { germplasmName: 'IITA-TMS-2', value: 17 },
      ],
      source: 'find_observations',
    });
    const tables = await bridge.describe(ctx);
    const tableName = tables[0]?.name ?? '';
    expect(tableName.startsWith('df_')).toBe(true);

    const result = await brapiDataframeExport.handler(
      brapiDataframeExport.input.parse({ dataframe: tableName, format: 'csv' }),
      ctx,
    );

    expect(result.dataframe).toBe(tableName);
    expect(result.format).toBe('csv');
    expect(result.path.startsWith(exportDir)).toBe(true);
    expect(result.filename).toMatch(/\.csv$/);
    expect(result.rowCount).toBe(2);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(existsSync(result.path)).toBe(true);
  });

  it('default filename includes the dataframe name and a unix-seconds suffix', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeExport.errors });
    const bridge = (await import('@/services/canvas-bridge/index.js')).getCanvasBridge();
    const handle = await bridge.registerDataframe(ctx, {
      baseUrl: 'https://example.org/brapi/v2',
      query: {},
      rows: [{ a: 1 }],
      source: 'find_studies',
    });
    const result = await brapiDataframeExport.handler(
      brapiDataframeExport.input.parse({ dataframe: handle.tableName, format: 'json' }),
      ctx,
    );
    const expected = new RegExp(`^${handle.tableName}-\\d{10}\\.json$`);
    expect(result.filename).toMatch(expected);
  });

  it('honors an explicit filename and overwrites on collision', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeExport.errors });
    const bridge = (await import('@/services/canvas-bridge/index.js')).getCanvasBridge();
    const handle = await bridge.registerDataframe(ctx, {
      baseUrl: 'https://example.org/brapi/v2',
      query: {},
      rows: [{ a: 1 }],
      source: 'find_studies',
    });
    const first = await brapiDataframeExport.handler(
      brapiDataframeExport.input.parse({
        dataframe: handle.tableName,
        format: 'json',
        filename: 'pinned.json',
      }),
      ctx,
    );
    const second = await brapiDataframeExport.handler(
      brapiDataframeExport.input.parse({
        dataframe: handle.tableName,
        format: 'json',
        filename: 'pinned.json',
      }),
      ctx,
    );
    expect(first.path).toBe(second.path);
    expect(second.filename).toBe('pinned.json');
  });

  it('rejects filenames containing path separators or traversal', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeExport.errors });
    const bridge = (await import('@/services/canvas-bridge/index.js')).getCanvasBridge();
    const handle = await bridge.registerDataframe(ctx, {
      baseUrl: 'https://example.org/brapi/v2',
      query: {},
      rows: [{ a: 1 }],
      source: 'find_studies',
    });
    await expect(
      brapiDataframeExport.handler(
        brapiDataframeExport.input.parse({
          dataframe: handle.tableName,
          format: 'csv',
          filename: '../escape.csv',
        }),
        ctx,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: expect.objectContaining({ reason: 'invalid_filename' }),
    });

    await expect(
      brapiDataframeExport.handler(
        brapiDataframeExport.input.parse({
          dataframe: handle.tableName,
          format: 'csv',
          filename: 'sub/file.csv',
        }),
        ctx,
      ),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ reason: 'invalid_filename' }),
    });
  });

  it('throws dataframe_not_found when the source dataframe is unknown', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeExport.errors });
    await expect(
      brapiDataframeExport.handler(
        brapiDataframeExport.input.parse({ dataframe: 'df_nonexistent', format: 'csv' }),
        ctx,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: expect.objectContaining({ reason: 'dataframe_not_found' }),
    });
  });

  it('throws export_dir_unset when BRAPI_EXPORT_DIR is missing (defensive)', async () => {
    // Re-init the bridge with a config where exportDir is unset.
    resetCanvasBridge();
    resetServerConfig();
    vi.unstubAllEnvs();
    const cfgNoDir: ServerConfig = { ...TEST_CONFIG };
    delete (cfgNoDir as { exportDir?: string }).exportDir;
    initCanvasBridge(new FakeDataCanvas() as unknown as DataCanvas, cfgNoDir);

    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeExport.errors });
    await expect(
      brapiDataframeExport.handler(
        brapiDataframeExport.input.parse({ dataframe: 'df_x', format: 'csv' }),
        ctx,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      data: expect.objectContaining({ reason: 'export_dir_unset' }),
    });
  });

  it('throws mutually_exclusive_projection when both columns and sql are supplied', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeExport.errors });
    const bridge = (await import('@/services/canvas-bridge/index.js')).getCanvasBridge();
    const handle = await bridge.registerDataframe(ctx, {
      baseUrl: 'https://example.org/brapi/v2',
      query: {},
      rows: [{ a: 1, b: 2 }],
      source: 'find_studies',
    });
    await expect(
      brapiDataframeExport.handler(
        brapiDataframeExport.input.parse({
          dataframe: handle.tableName,
          format: 'csv',
          columns: ['a'],
          sql: 'SELECT a FROM df_x',
        }),
        ctx,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: expect.objectContaining({ reason: 'mutually_exclusive_projection' }),
    });
  });

  it('drops the derived projection table after export when columns is supplied', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeExport.errors });
    const bridge = (await import('@/services/canvas-bridge/index.js')).getCanvasBridge();
    const dropSpy = vi.spyOn(bridge, 'drop');
    const handle = await bridge.registerDataframe(ctx, {
      baseUrl: 'https://example.org/brapi/v2',
      query: {},
      rows: [{ a: 1, b: 2 }],
      source: 'find_studies',
    });
    await brapiDataframeExport.handler(
      brapiDataframeExport.input.parse({
        dataframe: handle.tableName,
        format: 'csv',
        columns: ['a'],
      }),
      ctx,
    );
    const droppedNames = dropSpy.mock.calls.map(([, name]) => name);
    expect(droppedNames.some((n) => n.startsWith('_brapi_export_'))).toBe(true);
  });

  it('paired-drop unlinks the export file when the source dataframe is dropped', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeExport.errors });
    const bridge = (await import('@/services/canvas-bridge/index.js')).getCanvasBridge();
    const handle = await bridge.registerDataframe(ctx, {
      baseUrl: 'https://example.org/brapi/v2',
      query: {},
      rows: [{ a: 1 }],
      source: 'find_studies',
    });
    const result = await brapiDataframeExport.handler(
      brapiDataframeExport.input.parse({ dataframe: handle.tableName, format: 'json' }),
      ctx,
    );
    expect(existsSync(result.path)).toBe(true);

    const dropped = await bridge.drop(ctx, handle.tableName);
    expect(dropped).toBe(true);
    expect(existsSync(result.path)).toBe(false);
  });

  it('mtime sweep removes stale files past the configured TTL', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeExport.errors });
    const stalePath = join(exportDir, 'stale.csv');
    await writeFile(stalePath, 'a,b\n1,2\n', 'utf8');
    const veryOld = new Date(Date.now() - testConfig.datasetTtlSeconds * 1000 - 60_000);
    await utimes(stalePath, veryOld, veryOld);

    const bridge = (await import('@/services/canvas-bridge/index.js')).getCanvasBridge();
    const handle = await bridge.registerDataframe(ctx, {
      baseUrl: 'https://example.org/brapi/v2',
      query: {},
      rows: [{ a: 1 }],
      source: 'find_studies',
    });
    await brapiDataframeExport.handler(
      brapiDataframeExport.input.parse({ dataframe: handle.tableName, format: 'csv' }),
      ctx,
    );

    expect(existsSync(stalePath)).toBe(false);
  });

  it('mtime sweep leaves recent files alone', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeExport.errors });
    const recentPath = join(exportDir, 'recent.csv');
    await writeFile(recentPath, 'a,b\n1,2\n', 'utf8');

    const bridge = (await import('@/services/canvas-bridge/index.js')).getCanvasBridge();
    const handle = await bridge.registerDataframe(ctx, {
      baseUrl: 'https://example.org/brapi/v2',
      query: {},
      rows: [{ a: 1 }],
      source: 'find_studies',
    });
    await brapiDataframeExport.handler(
      brapiDataframeExport.input.parse({ dataframe: handle.tableName, format: 'csv' }),
      ctx,
    );

    expect(existsSync(recentPath)).toBe(true);
    const after = await readdir(exportDir);
    // Recent + the export we just wrote (and its temp backup if any) are still here.
    expect(after.length).toBeGreaterThanOrEqual(2);
  });

  it('exports an absolute path under the configured exportDir, never above it', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeExport.errors });
    const bridge = (await import('@/services/canvas-bridge/index.js')).getCanvasBridge();
    const handle = await bridge.registerDataframe(ctx, {
      baseUrl: 'https://example.org/brapi/v2',
      query: {},
      rows: [{ a: 1 }],
      source: 'find_studies',
    });
    const result = await brapiDataframeExport.handler(
      brapiDataframeExport.input.parse({ dataframe: handle.tableName, format: 'csv' }),
      ctx,
    );
    const info = await stat(result.path);
    expect(info.isFile()).toBe(true);
    expect(result.path.startsWith(exportDir)).toBe(true);
  });
});

describe('brapi_dataframe_export format', () => {
  it('renders dataframe, path, format, rows, bytes, columns, expiresAt', () => {
    const formatted = brapiDataframeExport.format?.({
      dataframe: 'df_abc',
      format: 'csv',
      path: '/tmp/brapi-mcp/exports/df_abc-1730000000.csv',
      filename: 'df_abc-1730000000.csv',
      sizeBytes: 1234,
      rowCount: 5,
      columns: [
        { name: 'a', type: 'VARCHAR' },
        { name: 'b', type: 'BIGINT' },
      ],
      expiresAt: '2026-05-06T00:00:00.000Z',
    });
    const text =
      (formatted ?? [])[0]?.type === 'text' ? (formatted![0] as { text: string }).text : '';
    expect(text).toContain('# Exported `df_abc`');
    expect(text).toContain('format: csv');
    expect(text).toContain('rows: 5');
    expect(text).toContain('bytes: 1234');
    expect(text).toContain('a (VARCHAR)');
    expect(text).toContain('expiresAt: 2026-05-06');
  });
});
