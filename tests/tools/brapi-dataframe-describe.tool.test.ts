/**
 * @fileoverview Handler tests for `brapi_dataframe_describe`. Covers
 * dataframe-disabled, the empty/no-dataframes case, and provenance augmentation
 * for ds_-prefixed dataframes.
 *
 * @module tests/tools/brapi-dataframe-describe.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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

  it('throws dataframe_disabled when the bridge is off', async () => {
    initCanvasBridge(undefined, { ...TEST_CONFIG, canvasEnabled: false });
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeDescribe.errors });
    const input = brapiDataframeDescribe.input.parse({});
    await expect(brapiDataframeDescribe.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: expect.objectContaining({ reason: 'dataframe_disabled' }),
    });
  });

  it('returns an empty list when no dataframes registered yet', async () => {
    const fake = new FakeDataCanvas();
    initCanvasBridge(fake, { ...TEST_CONFIG, canvasEnabled: true });
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeDescribe.errors });
    const result = await brapiDataframeDescribe.handler(
      brapiDataframeDescribe.input.parse({}),
      ctx,
    );
    expect(result.tables).toEqual([]);
  });

  it('surfaces ds_<datasetId> dataframes with provenance', async () => {
    const fake = new FakeDataCanvas();
    const bridge = initCanvasBridge(fake, { ...TEST_CONFIG, canvasEnabled: true });
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeDescribe.errors });
    await bridge.registerDataset(
      ctx,
      {
        datasetId: '7b2f9c3a-8d4e-4b1a-9c5f-1e2d3c4b5a6e',
        source: 'find_observations',
        baseUrl: 'https://brapi.example.org/brapi/v2',
        query: { studies: ['422'] },
        rowCount: 1,
        columns: ['observationDbId'],
        sizeBytes: 100,
        createdAt: '2026-05-02T10:00:00.000Z',
        expiresAt: '2026-05-03T10:00:00.000Z',
      },
      [{ observationDbId: 'o1' }],
    );

    const result = await brapiDataframeDescribe.handler(
      brapiDataframeDescribe.input.parse({}),
      ctx,
    );
    expect(result.tables).toHaveLength(1);
    const [table] = result.tables;
    expect(table?.name).toBe('ds_7b2f9c3a_8d4e_4b1a_9c5f_1e2d3c4b5a6e');
    expect(table?.provenance?.source).toBe('find_observations');
    expect(table?.provenance?.datasetId).toBe('7b2f9c3a-8d4e-4b1a-9c5f-1e2d3c4b5a6e');
  });

  it('renders an empty marker when no dataframes exist', () => {
    const formatted = brapiDataframeDescribe.format?.({ tables: [] });
    const text =
      (formatted ?? [])[0]?.type === 'text' ? (formatted![0] as { text: string }).text : '';
    expect(text).toContain('# 0 dataframe(s)');
    expect(text).toContain('No dataframes');
  });

  it('renders provenance lines for ds_-prefixed dataframes', () => {
    const formatted = brapiDataframeDescribe.format?.({
      tables: [
        {
          name: 'ds_abc',
          rowCount: 5,
          columns: [
            { name: 'id', type: 'VARCHAR' },
            { name: 'value', type: 'DOUBLE', nullable: true },
          ],
          provenance: {
            datasetId: 'abc',
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
    expect(text).toContain('## `ds_abc`');
    expect(text).toContain('- provenance:');
    expect(text).toContain('source: find_observations');
    expect(text).toContain('baseUrl: https://b/v2');
  });
});
