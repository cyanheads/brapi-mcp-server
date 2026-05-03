/**
 * @fileoverview Handler tests for `brapi_dataframe_query`. Covers the
 * dataframe-disabled error path and the happy path through a fake bridge.
 *
 * @module tests/tools/brapi-dataframe-query.tool.test
 */

import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { brapiDataframeQuery } from '@/mcp-server/tools/definitions/brapi-dataframe-query.tool.js';
import {
  CanvasBridge,
  initCanvasBridge,
  resetCanvasBridge,
} from '@/services/canvas-bridge/index.js';
import { FakeDataCanvas } from '../services/_fake-canvas.js';
import { TEST_CONFIG } from './_tool-test-helpers.js';

describe('brapi_dataframe_query', () => {
  afterEach(() => {
    resetCanvasBridge();
  });

  it('throws dataframe_disabled when the bridge is off', async () => {
    initCanvasBridge(undefined, { ...TEST_CONFIG, canvasEnabled: false });
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeQuery.errors });
    const input = brapiDataframeQuery.input.parse({ sql: 'SELECT 1' });
    await expect(brapiDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: expect.objectContaining({ reason: 'dataframe_disabled' }),
    });
  });

  it('runs through to the workspace when enabled and surfaces the dataframe name from registerAs', async () => {
    const fake = new FakeDataCanvas();
    initCanvasBridge(fake, { ...TEST_CONFIG, canvasEnabled: true });
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeQuery.errors });
    const input = brapiDataframeQuery.input.parse({
      sql: 'SELECT * FROM ds_foo',
      registerAs: 'derived_t',
    });
    const result = await brapiDataframeQuery.handler(input, ctx);
    expect(result.dataframe).toBe('derived_t');
    expect(result.rowCount).toBe(0);
    expect(result.rows).toEqual([]);
  });

  it('translates framework SQL-gate rejections into ctx.fail("sql_rejected")', async () => {
    const fake = new FakeDataCanvas();
    const bridge = initCanvasBridge(fake, { ...TEST_CONFIG, canvasEnabled: true });
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

  it('passes non-gate errors through unchanged', async () => {
    const fake = new FakeDataCanvas();
    const bridge = initCanvasBridge(fake, { ...TEST_CONFIG, canvasEnabled: true });
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
  it('renders count, columns, returned, and a row block per result', () => {
    const formatted = brapiDataframeQuery.format?.({
      rowCount: 2,
      columns: ['name', 'count'],
      rows: [
        { name: 'Cassava', count: 12 },
        { name: 'Wheat', count: 8 },
      ],
    });
    expect(formatted).toBeDefined();
    const text =
      (formatted ?? [])[0]?.type === 'text' ? (formatted![0] as { text: string }).text : '';
    expect(text).toContain('# 2 row(s)');
    expect(text).toContain('- columns: name, count');
    expect(text).toContain('Cassava');
    expect(text).toContain('Wheat');
  });

  it('renders the empty marker when rows is []', () => {
    const formatted = brapiDataframeQuery.format?.({
      rowCount: 0,
      columns: ['x'],
      rows: [],
    });
    const text =
      (formatted ?? [])[0]?.type === 'text' ? (formatted![0] as { text: string }).text : '';
    expect(text).toContain('No rows');
  });
});

// Reset before each top-level test too — the suite mixes init-with-canvas
// and init-without-canvas paths and we don't want one test bleeding.
beforeEach(() => {
  resetCanvasBridge();
});
// Defensive: confirm CanvasBridge module loads without circular issues.
void CanvasBridge;
