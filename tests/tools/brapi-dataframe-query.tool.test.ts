/**
 * @fileoverview Handler tests for `brapi_dataframe_query`. Covers the happy
 * path through a fake bridge, the SQL-gate rejection mapping, and the typed
 * column shape on the response.
 *
 * @module tests/tools/brapi-dataframe-query.tool.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { brapiDataframeQuery } from '@/mcp-server/tools/definitions/brapi-dataframe-query.tool.js';
import { initCanvasBridge, resetCanvasBridge } from '@/services/canvas-bridge/index.js';
import { FakeDataCanvas } from '../services/_fake-canvas.js';
import { TEST_CONFIG } from './_tool-test-helpers.js';

describe('brapi_dataframe_query', () => {
  afterEach(() => {
    resetCanvasBridge();
  });

  it('runs through to the workspace and surfaces the dataframe name from registerAs', async () => {
    const fake = new FakeDataCanvas();
    initCanvasBridge(fake as unknown as DataCanvas, TEST_CONFIG);
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeQuery.errors });
    const input = brapiDataframeQuery.input.parse({
      sql: 'SELECT * FROM df_foo',
      registerAs: 'derived_t',
    });
    const result = await brapiDataframeQuery.handler(input, ctx);
    expect(result.dataframe).toBe('derived_t');
    expect(result.rowCount).toBe(0);
    expect(result.rows).toEqual([]);
    // Empty result + registerAs path: describe was called against the
    // materialized table, but the fake reports zero columns. The handler
    // surfaces an empty typed-columns array rather than fabricating types.
    expect(Array.isArray(result.columns)).toBe(true);
  });

  it('falls back to row inference when describe returns no columns for the probe table', async () => {
    // Mocking bridge.query short-circuits the FakeDataCanvas registerAs path,
    // so describe() finds nothing for the probe name and the handler infers
    // types from the returned rows.
    const fake = new FakeDataCanvas();
    const bridge = initCanvasBridge(fake as unknown as DataCanvas, TEST_CONFIG);
    vi.spyOn(bridge, 'query').mockResolvedValue({
      rows: [{ name: 'Cassava', count: 12 }],
      columns: ['name', 'count'],
      rowCount: 1,
    });
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeQuery.errors });
    const input = brapiDataframeQuery.input.parse({ sql: 'SELECT name, count FROM df_foo' });
    const result = await brapiDataframeQuery.handler(input, ctx);
    expect(result.columns).toEqual([
      { name: 'name', type: 'VARCHAR' },
      { name: 'count', type: 'BIGINT' },
    ]);
    // No `dataframe` is surfaced — the user didn't request registerAs, so the
    // probe table is internal-only.
    expect(result.dataframe).toBeUndefined();
  });

  it('always passes registerAs to bridge.query and drops the probe table when none was requested', async () => {
    const fake = new FakeDataCanvas();
    const bridge = initCanvasBridge(fake as unknown as DataCanvas, TEST_CONFIG);
    const querySpy = vi.spyOn(bridge, 'query');
    const dropSpy = vi.spyOn(bridge, 'drop');
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeQuery.errors });
    const input = brapiDataframeQuery.input.parse({ sql: 'SELECT 1' });
    await brapiDataframeQuery.handler(input, ctx);
    const probeName = querySpy.mock.calls[0]?.[2]?.registerAs;
    expect(probeName).toMatch(/^_brapi_probe_/);
    expect(dropSpy).toHaveBeenCalledWith(expect.anything(), probeName);
  });

  it('does not drop the table when the caller supplied registerAs', async () => {
    const fake = new FakeDataCanvas();
    const bridge = initCanvasBridge(fake as unknown as DataCanvas, TEST_CONFIG);
    const dropSpy = vi.spyOn(bridge, 'drop');
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeQuery.errors });
    const input = brapiDataframeQuery.input.parse({
      sql: 'SELECT 1',
      registerAs: 'keep_me',
    });
    await brapiDataframeQuery.handler(input, ctx);
    expect(dropSpy).not.toHaveBeenCalled();
  });

  it('uses describe-sourced types over row inference when describe returns columns', async () => {
    const fake = new FakeDataCanvas();
    const bridge = initCanvasBridge(fake as unknown as DataCanvas, TEST_CONFIG);
    vi.spyOn(bridge, 'query').mockResolvedValue({
      // Row payload mimics what DuckDB's getRowObjectsJson returns for a
      // BIGINT column — the value is a string. Row inference would say
      // VARCHAR; describe (mocked here as the framework would surface it)
      // says BIGINT, and the handler should prefer describe.
      rows: [{ count: '42' }],
      columns: ['count'],
      rowCount: 1,
    });
    vi.spyOn(bridge, 'describe').mockResolvedValue([
      {
        name: '_brapi_probe_xxx',
        rowCount: 1,
        columns: [{ name: 'count', type: 'BIGINT' }],
      },
    ]);
    vi.spyOn(bridge, 'drop').mockResolvedValue(true);
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeQuery.errors });
    const input = brapiDataframeQuery.input.parse({ sql: 'SELECT COUNT(*) AS count FROM df_x' });
    const result = await brapiDataframeQuery.handler(input, ctx);
    expect(result.columns).toEqual([{ name: 'count', type: 'BIGINT' }]);
  });

  it('returns columns with type UNKNOWN when result is empty and no table was registered', async () => {
    const fake = new FakeDataCanvas();
    const bridge = initCanvasBridge(fake as unknown as DataCanvas, TEST_CONFIG);
    vi.spyOn(bridge, 'query').mockResolvedValue({
      rows: [],
      columns: ['name'],
      rowCount: 0,
    });
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeQuery.errors });
    const input = brapiDataframeQuery.input.parse({ sql: 'SELECT name FROM df_empty' });
    const result = await brapiDataframeQuery.handler(input, ctx);
    expect(result.columns).toEqual([{ name: 'name', type: 'UNKNOWN' }]);
  });

  it('translates framework SQL-gate rejections into ctx.fail("sql_rejected")', async () => {
    const fake = new FakeDataCanvas();
    const bridge = initCanvasBridge(fake as unknown as DataCanvas, TEST_CONFIG);
    vi.spyOn(bridge, 'query').mockRejectedValue(
      validationError('Query must contain exactly one SQL statement.', {
        reason: 'multi_statement',
      }),
    );
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeQuery.errors });
    const input = brapiDataframeQuery.input.parse({ sql: 'SELECT 1; SELECT 2' });
    await expect(brapiDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: expect.objectContaining({
        reason: 'sql_rejected',
        gateReason: 'multi_statement',
      }),
    });
  });

  it('forwards the framework gate context fields alongside gateReason', async () => {
    const fake = new FakeDataCanvas();
    const bridge = initCanvasBridge(fake as unknown as DataCanvas, TEST_CONFIG);
    vi.spyOn(bridge, 'query').mockRejectedValue(
      validationError('Canvas query contains disallowed operators: INSERT.', {
        reason: 'plan_operator_not_allowed',
        operators: ['INSERT'],
      }),
    );
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeQuery.errors });
    const input = brapiDataframeQuery.input.parse({ sql: 'INSERT INTO df_x VALUES (1)' });
    await expect(brapiDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: expect.objectContaining({
        reason: 'sql_rejected',
        gateReason: 'plan_operator_not_allowed',
        operators: ['INSERT'],
      }),
    });
  });

  it('rejects information_schema references as system_catalog_access and propagates the catalog label', async () => {
    const fake = new FakeDataCanvas();
    initCanvasBridge(fake as unknown as DataCanvas, TEST_CONFIG);
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeQuery.errors });
    const input = brapiDataframeQuery.input.parse({
      sql: 'SELECT * FROM information_schema.tables',
    });
    await expect(brapiDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: expect.objectContaining({
        reason: 'sql_rejected',
        gateReason: 'system_catalog_access',
        catalog: 'information_schema',
      }),
    });
  });

  it('rejects pg_catalog references as system_catalog_access', async () => {
    const fake = new FakeDataCanvas();
    initCanvasBridge(fake as unknown as DataCanvas, TEST_CONFIG);
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeQuery.errors });
    const input = brapiDataframeQuery.input.parse({
      sql: 'SELECT * FROM pg_catalog.pg_class',
    });
    await expect(brapiDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      data: expect.objectContaining({
        reason: 'sql_rejected',
        gateReason: 'system_catalog_access',
      }),
    });
  });

  it('rejects sqlite_master references as system_catalog_access', async () => {
    const fake = new FakeDataCanvas();
    initCanvasBridge(fake as unknown as DataCanvas, TEST_CONFIG);
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeQuery.errors });
    const input = brapiDataframeQuery.input.parse({
      sql: 'SELECT * FROM sqlite_master',
    });
    await expect(brapiDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      data: expect.objectContaining({
        reason: 'sql_rejected',
        gateReason: 'system_catalog_access',
      }),
    });
  });

  it('rejects duckdb_tables() metadata-function calls as system_catalog_access', async () => {
    const fake = new FakeDataCanvas();
    initCanvasBridge(fake as unknown as DataCanvas, TEST_CONFIG);
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeQuery.errors });
    const input = brapiDataframeQuery.input.parse({
      sql: 'SELECT * FROM duckdb_tables()',
    });
    await expect(brapiDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      data: expect.objectContaining({
        reason: 'sql_rejected',
        gateReason: 'system_catalog_access',
      }),
    });
  });

  it('does not false-positive on a column name shaped like a catalog (no qualifier)', async () => {
    const fake = new FakeDataCanvas();
    initCanvasBridge(fake as unknown as DataCanvas, TEST_CONFIG);
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeQuery.errors });
    const input = brapiDataframeQuery.input.parse({
      sql: 'SELECT information_schema_id FROM df_foo',
    });
    const result = await brapiDataframeQuery.handler(input, ctx);
    expect(result.rowCount).toBe(0);
  });

  it('does not false-positive on a string literal that mentions a catalog', async () => {
    const fake = new FakeDataCanvas();
    initCanvasBridge(fake as unknown as DataCanvas, TEST_CONFIG);
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeQuery.errors });
    const input = brapiDataframeQuery.input.parse({
      sql: "SELECT * FROM df_foo WHERE name = 'information_schema.tables'",
    });
    const result = await brapiDataframeQuery.handler(input, ctx);
    expect(result.rowCount).toBe(0);
  });

  it('passes non-gate errors through unchanged', async () => {
    const fake = new FakeDataCanvas();
    const bridge = initCanvasBridge(fake as unknown as DataCanvas, TEST_CONFIG);
    const upstream = new Error('connection refused');
    vi.spyOn(bridge, 'query').mockRejectedValue(upstream);
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeQuery.errors });
    const input = brapiDataframeQuery.input.parse({ sql: 'SELECT 1' });
    await expect(brapiDataframeQuery.handler(input, ctx)).rejects.toBe(upstream);
  });

  it('rejects sql shorter than 1 char at the schema boundary', () => {
    expect(() => brapiDataframeQuery.input.parse({ sql: '' })).toThrow();
  });

  it('rejects registerAs with invalid identifier shape at the schema boundary', () => {
    expect(() =>
      brapiDataframeQuery.input.parse({ sql: 'SELECT 1', registerAs: 'with-hyphen' }),
    ).toThrow();
  });
});

describe('brapi_dataframe_query format', () => {
  it('renders count, typed columns, returned, and a row block per result', () => {
    const formatted = brapiDataframeQuery.format?.({
      rowCount: 2,
      columns: [
        { name: 'name', type: 'VARCHAR' },
        { name: 'count', type: 'BIGINT' },
      ],
      rows: [
        { name: 'Cassava', count: 12 },
        { name: 'Wheat', count: 8 },
      ],
    });
    expect(formatted).toBeDefined();
    const text =
      (formatted ?? [])[0]?.type === 'text' ? (formatted![0] as { text: string }).text : '';
    expect(text).toContain('# 2 row(s)');
    expect(text).toContain('- columns: name (VARCHAR), count (BIGINT)');
    expect(text).toContain('Cassava');
    expect(text).toContain('Wheat');
  });

  it('renders the empty marker when rows is []', () => {
    const formatted = brapiDataframeQuery.format?.({
      rowCount: 0,
      columns: [{ name: 'x', type: 'VARCHAR' }],
      rows: [],
    });
    const text =
      (formatted ?? [])[0]?.type === 'text' ? (formatted![0] as { text: string }).text : '';
    expect(text).toContain('No rows');
  });
});
