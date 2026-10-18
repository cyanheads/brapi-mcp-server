/**
 * @fileoverview Raw preview coverage and staging invariants.
 * @module tests/tools/shared/raw-preview.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { previewRawResult } from '@/mcp-server/tools/shared/raw-preview.js';
import { getBrapiClient } from '@/services/brapi-client/index.js';
import { getCanvasBridge } from '@/services/canvas-bridge/index.js';
import { BASE_URL, envelope, initTestServices, resetTestServices } from '../_tool-test-helpers.js';

describe('raw preview staging', () => {
  beforeEach(() => {
    initTestServices();
  });
  afterEach(() => {
    resetTestServices();
  });

  function harness(totalCount: number | undefined, loadLimit = 100) {
    const ctx = createMockContext();
    const bridge = getCanvasBridge();
    const register = vi.spyOn(bridge, 'registerDataframe');
    const input = {
      ctx,
      bridge,
      client: getBrapiClient(),
      connection: {
        alias: 'default',
        authMode: 'none' as const,
        baseUrl: BASE_URL,
        registeredAt: new Date().toISOString(),
      },
      totalCount,
      loadLimit,
      source: 'raw_get',
      path: '/samples',
      filters: {},
    };
    return { ctx, register, input };
  }

  it.each([false, true])(
    'stages oversized first rows with missing totals (nested=%s)',
    async (nested) => {
      const { ctx, register, input } = harness();
      const rows = [{ id: 'wide', value: 'é'.repeat(24_000) }];
      const output = await previewRawResult(
        nested ? { data: rows, other: true } : rows,
        input,
        false,
      );
      expect(output.result).toEqual(nested ? { data: [], other: true } : []);
      expect(output.dataframe?.rowCount).toBe(1);
      expect(register.mock.calls[0]?.[1].rows).toEqual(rows);
      expect(getEnrichment(ctx)).toMatchObject({
        shown: 0,
        cap: 100,
        truncated: true,
        notice: expect.stringContaining('narrower projection'),
      });
      expect(getEnrichment(ctx).notice).not.toContain('OFFSET');
    },
  );

  it.each([[], { data: [] }, { singleton: 'untouched' }])(
    'leaves empty or non-list results unchanged: %j',
    async (raw) => {
      const { register, input, ctx } = harness(999);
      expect(await previewRawResult(raw, input, false)).toEqual({ result: raw });
      expect(register).not.toHaveBeenCalled();
      expect(getEnrichment(ctx)).toEqual({});
    },
  );

  it('does not falsely attribute a short first page to loadLimit and restarts ordered SQL at zero', async () => {
    const { ctx, register, input } = harness(2);
    const first = [{ id: 'z' }];
    vi.spyOn(input.client, 'get').mockResolvedValue(
      envelope({ data: [{ id: 'z' }, { id: 'a' }] }, { totalCount: 2 }),
    );
    await previewRawResult(first, input, false);
    expect(register.mock.calls[0]?.[1].rows).toEqual([{ id: 'z' }, { id: 'a' }]);
    const { notice } = getEnrichment(ctx);
    expect(notice).toContain('upstream first page');
    expect(notice).not.toContain('loadLimit');
    expect(notice).toContain('OFFSET 0');
    expect(notice).toContain('rows actually shown');
  });

  it('preserves fetched wide rows when the page walk fails', async () => {
    const { ctx, register, input } = harness(100, 10);
    const rows = Array.from({ length: 10 }, (_, id) => ({ id, value: 'é'.repeat(3000) }));
    vi.spyOn(input.client, 'get').mockRejectedValue(new Error('upstream unavailable'));
    const output = await previewRawResult({ data: rows }, input, false);
    expect(output.dataframe).toMatchObject({ rowCount: 10, truncated: true });
    expect(register.mock.calls[0]?.[1].rows).toEqual(rows);
    expect(getEnrichment(ctx).warnings).toHaveLength(1);
    expect(getEnrichment(ctx).notice).toContain('24,000-byte');
  });
});
