/**
 * @fileoverview Handler tests for `brapi_dataframe_describe`. Covers the
 * empty/no-dataframes case and provenance augmentation for `df_*`-prefixed
 * dataframes.
 *
 * @module tests/tools/brapi-dataframe-describe.tool.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { brapiDataframeDescribe } from '@/mcp-server/tools/definitions/brapi-dataframe-describe.tool.js';
import { initCanvasBridge, resetCanvasBridge } from '@/services/canvas-bridge/index.js';
import { FakeDataCanvas } from '../services/_fake-canvas.js';
import { TEST_CONFIG } from './_tool-test-helpers.js';

describe('brapi_dataframe_describe', () => {
  afterEach(() => {
    resetCanvasBridge();
  });

  it('returns an empty list when no dataframes registered yet', async () => {
    const fake = new FakeDataCanvas();
    initCanvasBridge(fake as unknown as DataCanvas, TEST_CONFIG);
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeDescribe.errors });
    const result = await brapiDataframeDescribe.handler(
      brapiDataframeDescribe.input.parse({}),
      ctx,
    );
    expect(result.tables).toEqual([]);
  });

  it('surfaces df_<uuid> dataframes with provenance', async () => {
    const fake = new FakeDataCanvas();
    const bridge = initCanvasBridge(fake as unknown as DataCanvas, TEST_CONFIG);
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeDescribe.errors });
    const handle = await bridge.registerDataframe(ctx, {
      source: 'find_observations',
      baseUrl: 'https://brapi.example.org/brapi/v2',
      query: { studies: ['422'] },
      rows: [{ observationDbId: 'o1' }],
    });

    const result = await brapiDataframeDescribe.handler(
      brapiDataframeDescribe.input.parse({}),
      ctx,
    );
    expect(result.tables).toHaveLength(1);
    const [table] = result.tables;
    expect(table?.name).toBe(handle.tableName);
    expect(table?.name.startsWith('df_')).toBe(true);
    expect(table?.provenance?.source).toBe('find_observations');
    expect(table?.provenance?.baseUrl).toBe('https://brapi.example.org/brapi/v2');
  });

  it('renders an empty marker when no dataframes exist', () => {
    const formatted = brapiDataframeDescribe.format?.({ tables: [] });
    const text =
      (formatted ?? [])[0]?.type === 'text' ? (formatted![0] as { text: string }).text : '';
    expect(text).toContain('# 0 dataframe(s)');
    expect(text).toContain('No dataframes');
  });

  it('renders provenance lines for df_-prefixed dataframes', () => {
    const formatted = brapiDataframeDescribe.format?.({
      tables: [
        {
          name: 'df_abc',
          rowCount: 5,
          columns: [
            { name: 'id', type: 'VARCHAR' },
            { name: 'value', type: 'DOUBLE', nullable: true },
          ],
          provenance: {
            source: 'find_observations',
            baseUrl: 'https://b/v2',
            query: { studies: ['s1'] },
            createdAt: '2026-05-02T00:00:00.000Z',
            expiresAt: '2026-05-03T00:00:00.000Z',
          },
        },
      ],
    });
    const text =
      (formatted ?? [])[0]?.type === 'text' ? (formatted![0] as { text: string }).text : '';
    expect(text).toContain('## `df_abc`');
    expect(text).toContain('- provenance:');
    expect(text).toContain('source: find_observations');
    expect(text).toContain('baseUrl: https://b/v2');
  });
});
