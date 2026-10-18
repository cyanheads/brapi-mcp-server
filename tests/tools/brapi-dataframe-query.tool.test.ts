/**
 * @fileoverview Handler tests for `brapi_dataframe_query`. Covers the happy
 * path through a fake bridge, the SQL-gate rejection mapping, and the typed
 * column shape on the response.
 *
 * @module tests/tools/brapi-dataframe-query.tool.test
 */

import { tmpdir } from 'node:os';
import type { RequestContext } from '@cyanheads/mcp-ts-core';
import {
  CanvasRegistry,
  DataCanvas,
  DuckdbProvider,
  SQL_GATE_REASONS,
} from '@cyanheads/mcp-ts-core/canvas';
import { databaseError, JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { brapiDataframeQuery } from '@/mcp-server/tools/definitions/brapi-dataframe-query.tool.js';
import { initCanvasBridge, resetCanvasBridge } from '@/services/canvas-bridge/index.js';
import { FakeDataCanvas } from '../services/_fake-canvas.js';
import { TEST_CONFIG } from './_tool-test-helpers.js';

/** Error envelope fields `runToolContract` surfaces on a failed call. */
interface ErrorEnvelope {
  error?: {
    code?: number;
    data?: { gateReason?: string; reason?: string; recovery?: { hint?: string } };
    message?: string;
  };
}

function errorOf(res: { structuredContent?: unknown }): NonNullable<ErrorEnvelope['error']> {
  const error = (res.structuredContent as ErrorEnvelope | undefined)?.error;
  if (!error) throw new Error('expected an error envelope');
  return error;
}

function recoveryFor(reason: string): string {
  const entry = brapiDataframeQuery.errors.find((e) => e.reason === reason);
  if (!entry) throw new Error(`no contract entry for ${reason}`);
  return entry.recovery;
}

/**
 * A real DuckDB-backed `DataCanvas`, so the gate, the engine's own error
 * classification, and the `registerAs` CTAS the tool's type probe runs all
 * execute as they do in production. `defaultRowLimit` is the framework's
 * provider ceiling the bridge's row clamp has to stay under.
 */
function createDuckdbCanvas(defaultRowLimit = 10_000): DataCanvas {
  const provider = new DuckdbProvider({
    defaultRowLimit,
    exportRootPath: tmpdir(),
    memoryLimitMb: 256,
    schemaSniffRows: 100,
    tempRootPath: tmpdir(),
  });
  const registry = new CanvasRegistry(provider, {
    absoluteCapMs: 600_000,
    maxCanvasesPerTenant: 10,
    sweeperIntervalMs: 0,
    ttlMs: 600_000,
  });
  return new DataCanvas(provider, registry);
}

/** A canvas bridge over the in-memory fake, for tests that stub its query results. */
function fakeBridge() {
  return initCanvasBridge(new FakeDataCanvas() as unknown as DataCanvas, TEST_CONFIG);
}

/** Call the handler directly, with the tool's contract wired onto the context. */
function runQuery(input: Record<string, unknown>) {
  const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeQuery.errors });
  return brapiDataframeQuery.handler(brapiDataframeQuery.input.parse(input), ctx);
}

describe('brapi_dataframe_query', () => {
  afterEach(() => {
    resetCanvasBridge();
  });

  it('runs through to the workspace and surfaces the dataframe name from registerAs', async () => {
    fakeBridge();
    const result = await runQuery({ sql: 'SELECT * FROM df_foo', registerAs: 'derived_t' });
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
    vi.spyOn(fakeBridge(), 'query').mockResolvedValue({
      rows: [{ name: 'Cassava', count: 12 }],
      columns: ['name', 'count'],
      rowCount: 1,
    });
    const result = await runQuery({ sql: 'SELECT name, count FROM df_foo' });
    expect(result.columns).toEqual([
      { name: 'name', type: 'VARCHAR' },
      { name: 'count', type: 'BIGINT' },
    ]);
    // No `dataframe` is surfaced — the user didn't request registerAs, so the
    // probe table is internal-only.
    expect(result.dataframe).toBeUndefined();
  });

  it('always passes registerAs to bridge.query and drops the probe table when none was requested', async () => {
    const bridge = fakeBridge();
    const querySpy = vi.spyOn(bridge, 'query');
    const dropSpy = vi.spyOn(bridge, 'drop');
    await runQuery({ sql: 'SELECT 1' });
    const probeName = querySpy.mock.calls[0]?.[2]?.registerAs;
    expect(probeName).toMatch(/^_brapi_probe_/);
    expect(dropSpy).toHaveBeenCalledWith(expect.anything(), probeName);
  });

  it('does not drop the table when the caller supplied registerAs', async () => {
    const dropSpy = vi.spyOn(fakeBridge(), 'drop');
    await runQuery({ sql: 'SELECT 1', registerAs: 'keep_me' });
    expect(dropSpy).not.toHaveBeenCalled();
  });

  it('uses describe-sourced types over row inference when describe returns columns', async () => {
    const bridge = fakeBridge();
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
    const result = await runQuery({ sql: 'SELECT COUNT(*) AS count FROM df_x' });
    expect(result.columns).toEqual([{ name: 'count', type: 'BIGINT' }]);
  });

  it('returns columns with type UNKNOWN when result is empty and no table was registered', async () => {
    vi.spyOn(fakeBridge(), 'query').mockResolvedValue({
      rows: [],
      columns: ['name'],
      rowCount: 0,
    });
    const result = await runQuery({ sql: 'SELECT name FROM df_empty' });
    expect(result.columns).toEqual([{ name: 'name', type: 'UNKNOWN' }]);
  });

  it('forwards the framework gate context fields alongside gateReason', async () => {
    vi.spyOn(fakeBridge(), 'query').mockRejectedValue(
      validationError('Canvas query contains disallowed operators: INSERT.', {
        reason: 'plan_operator_not_allowed',
        operators: ['INSERT'],
      }),
    );
    await expect(runQuery({ sql: 'INSERT INTO df_x VALUES (1)' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: expect.objectContaining({
        reason: 'sql_rejected',
        gateReason: 'plan_operator_not_allowed',
        operators: ['INSERT'],
      }),
    });
  });

  it.each([
    ['SELECT * FROM information_schema.tables', { catalog: 'information_schema' }],
    ['SELECT * FROM pg_catalog.pg_class', {}],
    ['SELECT * FROM sqlite_master', {}],
    ['SELECT * FROM duckdb_tables()', {}],
  ])('rejects `%s` as system_catalog_access', async (sql, context) => {
    fakeBridge();
    await expect(runQuery({ sql })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: expect.objectContaining({
        reason: 'sql_rejected',
        gateReason: 'system_catalog_access',
        ...context,
      }),
    });
  });

  it.each([
    ['a column name shaped like a catalog', 'SELECT information_schema_id FROM df_foo'],
    [
      'a string literal that mentions a catalog',
      "SELECT * FROM df_foo WHERE name = 'information_schema.tables'",
    ],
  ])('does not false-positive on %s', async (_label, sql) => {
    fakeBridge();
    const result = await runQuery({ sql });
    expect(result.rowCount).toBe(0);
  });

  it('scrubs the wrapping statement from an unmapped engine error and keeps its code and data', async () => {
    vi.spyOn(fakeBridge(), 'query').mockImplementation(async (_ctx, sql, opts) => {
      const wrapped = `CREATE TABLE "${opts?.registerAs}" AS ${sql}`;
      throw databaseError(
        `Out of Memory Error: could not allocate\n\nLINE 1: ${wrapped}\n${' '.repeat(8 + wrapped.indexOf('big'))}^`,
        { detail: 'kept' },
      );
    });
    await expect(runQuery({ sql: 'SELECT big FROM df_x' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.DatabaseError,
      data: { detail: 'kept' },
      message: `Out of Memory Error: could not allocate\n\nLINE 1: SELECT big FROM df_x\n${' '.repeat(15)}^`,
    });
  });

  it('drops the excerpt when the failing token sits inside the wrapping statement', async () => {
    vi.spyOn(fakeBridge(), 'query').mockImplementation(async (_ctx, sql, opts) => {
      throw databaseError(
        `Catalog Error: boom\n\nLINE 1: CREATE TABLE "${opts?.registerAs}" AS ${sql}\n             ^`,
      );
    });
    await expect(runQuery({ sql: 'SELECT 1' })).rejects.toMatchObject({
      message: 'Catalog Error: boom',
    });
  });

  it('passes non-gate errors through unchanged', async () => {
    const upstream = new Error('connection refused');
    vi.spyOn(fakeBridge(), 'query').mockRejectedValue(upstream);
    await expect(runQuery({ sql: 'SELECT 1' })).rejects.toBe(upstream);
  });

  it('bounds sql, registerAs, and preview at the schema, accepting a preview above 1,000', () => {
    expect(brapiDataframeQuery.input.parse({ sql: 'SELECT 1', preview: 2000 }).preview).toBe(2000);
    for (const input of [
      { sql: '' },
      { sql: 'SELECT 1', registerAs: 'with-hyphen' },
      { sql: 'SELECT 1', preview: 0 },
      { sql: 'SELECT 1', preview: 1.5 },
    ]) {
      expect(() => brapiDataframeQuery.input.parse(input)).toThrow();
    }
  });
});

describe('brapi_dataframe_query error contract against a real DuckDB canvas', () => {
  let canvas: DataCanvas;

  beforeEach(() => {
    canvas = createDuckdbCanvas();
    initCanvasBridge(canvas, TEST_CONFIG);
  });

  afterEach(async () => {
    resetCanvasBridge();
    await canvas.shutdown({ requestId: 'test-shutdown', timestamp: '' } as RequestContext);
  });

  async function callTool(input: Record<string, unknown>) {
    return await runToolContract(brapiDataframeQuery, brapiDataframeQuery.input.parse(input));
  }

  it.each([
    ['a bare relative file name', "SELECT * FROM 'data.csv'"],
    ['a URL', "SELECT * FROM 'https://example.com/a.parquet'"],
    ['a file joined to a table function', "SELECT * FROM 'data.csv' t JOIN range(3) r ON true"],
  ])(
    'routes a file reference (%s) through sql_rejected with gateReason sql_read_only',
    async (_label, sql) => {
      const res = await callTool({ sql });
      expect(res.isError).toBe(true);
      const error = errorOf(res);
      expect(error.data?.reason).toBe('sql_rejected');
      expect(error.data?.gateReason).toBe('sql_read_only');
      expect(error.data?.recovery?.hint).toBe(recoveryFor('sql_rejected'));
    },
  );

  it.each([
    ['denied_function', "SELECT * FROM read_csv('data.csv')"],
    ['system_catalog_access', 'SELECT * FROM information_schema.tables'],
    ['non_select_statement', 'DROP TABLE anything'],
    ['multi_statement', 'SELECT 1; SELECT 2'],
  ])('keeps the existing %s mapping onto sql_rejected', async (gateReason, sql) => {
    const res = await callTool({ sql });
    const error = errorOf(res);
    expect(error.data?.reason).toBe('sql_rejected');
    expect(error.data?.gateReason).toBe(gateReason);
    expect(error.data?.recovery?.hint).toBe(recoveryFor('sql_rejected'));
  });

  it('keeps an execution error on its own declared reason and hint, quoting only the caller SQL', async () => {
    const sql = "SELECT CAST('abc' AS INTEGER) AS x";
    const res = await callTool({ sql });
    const error = errorOf(res);
    expect(error.data?.reason).toBe('sql_execution_error');
    expect(error.data?.gateReason).toBeUndefined();
    expect(error.data?.recovery?.hint).toBe(recoveryFor('sql_execution_error'));
    expect(error.message).toMatch(/Could not convert string 'abc'/);
    expect(error.message).not.toMatch(/_brapi_probe_|CREATE TABLE/);
    // The excerpt DuckDB renders is the caller's statement, and the caret
    // still points at the failing expression inside it.
    const lines = (error.message ?? '').split('\n');
    const excerptIndex = lines.findIndex((l) => l.startsWith('LINE 1: '));
    expect(excerptIndex).toBeGreaterThan(-1);
    expect(lines[excerptIndex]).toBe(`LINE 1: ${sql}`);
    const caret = lines[excerptIndex + 1] ?? '';
    expect(caret.trimStart()).toBe('^');
    expect(lines[excerptIndex]?.slice(caret.length - 1)).toMatch(/^CAST\('abc'/);
    expect(JSON.stringify(res.content)).not.toMatch(/_brapi_probe_/);
  });

  it('scrubs the wrapper when the caller named the result with registerAs too', async () => {
    const res = await callTool({ sql: "SELECT CAST('abc' AS INTEGER) AS x", registerAs: 'mine' });
    const error = errorOf(res);
    expect(error.data?.reason).toBe('sql_execution_error');
    expect(error.message).not.toMatch(/CREATE TABLE/);
  });

  it('keeps a caret excerpt that starts mid-statement pointing at the failing expression', async () => {
    const padding = Array.from({ length: 12 }, (_, i) => `${i} AS c${i}`).join(', ');
    const sql = `SELECT ${padding}, CAST('abc' AS INTEGER) AS bad`;
    const res = await callTool({ sql });
    const error = errorOf(res);
    expect(error.message).not.toMatch(/_brapi_probe_|CREATE TABLE/);
    const lines = (error.message ?? '').split('\n');
    const excerptIndex = lines.findIndex((l) => l.startsWith('LINE 1: '));
    const caret = lines[excerptIndex + 1] ?? '';
    expect(lines[excerptIndex]?.slice(caret.length - 1)).toMatch(/^CAST\('abc'/);
  });

  it('keeps a missing table on its own declared reason and hint', async () => {
    const res = await callTool({ sql: 'SELECT * FROM df_nothere_xxxxx' });
    const error = errorOf(res);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data?.reason).toBe('missing_table');
    expect(error.data?.recovery?.hint).toBe(recoveryFor('missing_table'));
  });

  it('keeps a registerAs name clash on its own declared reason and hint', async () => {
    // Each runToolContract call gets fresh state, so pin both calls to one canvas.
    const bridge = initCanvasBridge(canvas, TEST_CONFIG);
    const instance = await bridge.getInstance(createMockContext());
    vi.spyOn(bridge, 'getInstance').mockResolvedValue(instance);
    expect((await callTool({ sql: 'SELECT 1 AS x', registerAs: 'taken' })).isError).toBeFalsy();
    const res = await callTool({ sql: 'SELECT 2 AS x', registerAs: 'taken' });
    const error = errorOf(res);
    expect(error.data?.reason).toBe('register_as_clash');
    expect(error.data?.recovery?.hint).toBe(recoveryFor('register_as_clash'));
  });

  it.each([
    ['DESCRIBE SELECT 1', undefined],
    ['SUMMARIZE SELECT 1 AS x', undefined],
    ['describe select 1', 'mine'],
    ['SHOW SELECT 1', undefined],
  ])(
    'rejects %s (registerAs %s) through sql_rejected with gateReason sql_parse_error',
    async (sql, registerAs) => {
      const res = await callTool(registerAs ? { sql, registerAs } : { sql });
      expect(res.isError).toBe(true);
      const error = errorOf(res);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data?.reason).toBe('sql_rejected');
      expect(error.data?.gateReason).toBe('sql_parse_error');
      expect(error.data?.recovery?.hint).toBe(recoveryFor('sql_rejected'));
      expect(error.message).toMatch(/brapi_dataframe_describe/);
      expect(error.message).not.toMatch(/_brapi_probe_|CREATE TABLE|Failed to extract/);
      expect(JSON.stringify(res.content)).not.toMatch(/_brapi_probe_|CREATE TABLE/);
    },
  );

  it('a SELECT that parses still answers after the DESCRIBE mapping', async () => {
    const res = await callTool({ sql: 'SELECT 1 AS x UNION ALL SELECT 2' });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { rowCount?: number }).rowCount).toBe(2);
  });

  it.each([...Object.values(SQL_GATE_REASONS), 'sql_read_only', 'sql_parse_error'])(
    'routes the %s refusal through sql_rejected',
    async (gateReason) => {
      // Every refusal the framework exports reaches the caller on the tool's
      // own contract, so a new gate reason cannot leak an undeclared reason.
      const bridge = initCanvasBridge(canvas, TEST_CONFIG);
      vi.spyOn(bridge, 'query').mockRejectedValue(
        validationError('refused', { reason: gateReason }),
      );
      const error = errorOf(await callTool({ sql: 'SELECT 1' }));
      expect(error.data?.reason).toBe('sql_rejected');
      expect(error.data?.gateReason).toBe(gateReason);
    },
  );
});

describe('brapi_dataframe_query preview ceiling against a real DuckDB canvas', () => {
  let canvas: DataCanvas | undefined;
  const threeThousand = 'SELECT n FROM t3k';

  afterEach(async () => {
    resetCanvasBridge();
    await canvas?.shutdown({ requestId: 'test-shutdown', timestamp: '' } as RequestContext);
    canvas = undefined;
  });

  /** Stage a 3,000-row table, then pin every call to that canvas (runToolContract gives each call fresh state). */
  async function run(input: Record<string, unknown>, config: ServerConfig = TEST_CONFIG) {
    await canvas?.shutdown({ requestId: 'test-shutdown', timestamp: '' } as RequestContext);
    canvas = createDuckdbCanvas();
    const bridge = initCanvasBridge(canvas, config);
    const instance = await bridge.getInstance(createMockContext());
    await instance.registerTable(
      't3k',
      Array.from({ length: 3000 }, (_, n) => ({ n })),
    );
    vi.spyOn(bridge, 'getInstance').mockResolvedValue(instance);
    const res = await runToolContract(brapiDataframeQuery, brapiDataframeQuery.input.parse(input));
    return {
      res,
      sc: res.structuredContent as {
        cap?: number;
        notice?: string;
        rowCount?: number;
        rows?: unknown[];
        shown?: number;
        truncated?: boolean;
      },
    };
  }

  it('serves a preview of 2,000 from a 3,000-row result and names preview as the lever', async () => {
    const { res, sc } = await run({ sql: threeThousand, preview: 2000 });
    expect(res.isError).toBeFalsy();
    expect(sc.rowCount).toBe(3000);
    expect(sc.rows).toHaveLength(2000);
    expect(sc.truncated).toBe(true);
    expect(sc.shown).toBe(2000);
    expect(sc.cap).toBe(2000);
    expect(sc.notice).toMatch(/^`preview` bound the response at 2000 of 3000 rows/);
    expect(JSON.stringify(res.content)).toMatch(/`preview` bound the response at 2000 of 3000/);
  });

  it('clamps a preview above rowLimit to rowLimit and names rowLimit as the lever', async () => {
    const { res, sc } = await run({ sql: threeThousand, preview: 800, rowLimit: 500 });
    expect(res.isError).toBeFalsy();
    expect(sc.rows).toHaveLength(500);
    expect(sc.shown).toBe(500);
    expect(sc.notice).toMatch(/^`rowLimit` bound the response at 500 of 3000 rows/);
  });

  it('never serves more than a preview-less call reaches when preview exceeds the deployment cap', async () => {
    const capped = { ...TEST_CONFIG, canvasMaxRows: 1000 };
    const withoutPreview = await run({ sql: threeThousand }, capped);
    const { res, sc } = await run({ sql: threeThousand, preview: 5000 }, capped);
    expect(res.isError).toBeFalsy();
    expect(withoutPreview.sc.rows).toHaveLength(1000);
    expect(sc.rows).toHaveLength(1000);
    expect(sc.notice).toMatch(
      /^The deployment-wide response cap bound the response at 1000 of 3000/,
    );
  });

  it('names the deployment cap, not rowLimit, when a rowLimit above the cap was clamped', async () => {
    const { sc } = await run(
      { sql: threeThousand, rowLimit: 50_000 },
      { ...TEST_CONFIG, canvasMaxRows: 1000 },
    );
    expect(sc.rows).toHaveLength(1000);
    expect(sc.notice).toMatch(/^The deployment-wide response cap bound/);
  });

  it('returns an empty result under a large preview without a truncation disclosure', async () => {
    const { res, sc } = await run({ sql: 'SELECT n FROM t3k WHERE n < 0', preview: 5000 });
    expect(res.isError).toBeFalsy();
    expect(sc.rowCount).toBe(0);
    expect(sc.rows).toEqual([]);
    expect(sc.truncated).toBeUndefined();
    expect(JSON.stringify(res.content)).toMatch(/No rows/);
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

describe('brapi_dataframe_query truncation disclosure', () => {
  afterEach(() => {
    resetCanvasBridge();
  });

  const threeRows = [{ n: 1 }, { n: 2 }, { n: 3 }];

  it('names rowLimit as the binding ceiling when preview is absent', async () => {
    vi.spyOn(fakeBridge(), 'query').mockResolvedValue({
      rows: threeRows,
      columns: ['n'],
      rowCount: 10,
    });
    const input = brapiDataframeQuery.input.parse({ sql: 'SELECT n FROM df_foo', rowLimit: 3 });
    const res = await runToolContract(brapiDataframeQuery, input);
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.cap).toBe(3);
    expect(sc.notice).toMatch(/`rowLimit` bound the response at 3 of 10 rows/);
  });

  it('emits no truncation fields when every row came back', async () => {
    vi.spyOn(fakeBridge(), 'query').mockResolvedValue({
      rows: threeRows,
      columns: ['n'],
      rowCount: 3,
    });
    const input = brapiDataframeQuery.input.parse({ sql: 'SELECT n FROM df_foo' });
    const res = await runToolContract(brapiDataframeQuery, input);
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.truncated).toBeUndefined();
    expect(sc.notice).toBeUndefined();
  });
});
