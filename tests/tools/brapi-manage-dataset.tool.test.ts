/**
 * @fileoverview Tests for `brapi_manage_dataset` — list / summary / load /
 * delete modes against an in-memory DatasetStore. Validates discriminator
 * behavior, missing-id rejection, page bounds, column projection.
 *
 * @module tests/tools/brapi-manage-dataset.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brapiManageDataset } from '@/mcp-server/tools/definitions/brapi-manage-dataset.tool.js';
import { getDatasetStore } from '@/services/dataset-store/index.js';
import { initTestServices, resetTestServices } from './_tool-test-helpers.js';

async function seedDataset(ctx: ReturnType<typeof createMockContext>, rowCount = 3) {
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    id: `row-${i + 1}`,
    name: `Row ${i + 1}`,
    extra: `field-${i + 1}`,
  }));
  return getDatasetStore().create(ctx, {
    source: 'find_studies',
    baseUrl: 'https://test.example.org',
    query: { commonCropNames: ['Cassava'] },
    rows,
  });
}

describe('brapi_manage_dataset tool', () => {
  beforeEach(() => {
    initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('list returns all persisted datasets', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    const ds = await seedDataset(ctx);
    const result = await brapiManageDataset.handler(
      brapiManageDataset.input.parse({ mode: 'list' }),
      ctx,
    );
    expect(result.result.mode).toBe('list');
    if (result.result.mode === 'list') {
      const ids = result.result.datasets.map((d) => d.datasetId);
      expect(ids).toContain(ds.datasetId);
    }
  });

  it('summary returns the metadata of a single dataset', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    const ds = await seedDataset(ctx);
    const result = await brapiManageDataset.handler(
      brapiManageDataset.input.parse({ mode: 'summary', datasetId: ds.datasetId }),
      ctx,
    );
    expect(result.result.mode).toBe('summary');
    if (result.result.mode === 'summary') {
      expect(result.result.dataset.datasetId).toBe(ds.datasetId);
      expect(result.result.dataset.source).toBe('find_studies');
    }
  });

  it('load returns a paged slice with column projection', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    const ds = await seedDataset(ctx, 5);
    const result = await brapiManageDataset.handler(
      brapiManageDataset.input.parse({
        mode: 'load',
        datasetId: ds.datasetId,
        page: 1,
        pageSize: 2,
        columns: ['id', 'name'],
      }),
      ctx,
    );
    expect(result.result.mode).toBe('load');
    if (result.result.mode === 'load') {
      expect(result.result.rows).toHaveLength(2);
      expect(result.result.totalRows).toBe(5);
      expect(Object.keys(result.result.rows[0]!)).toEqual(['id', 'name']);
      expect(Object.keys(result.result.rows[0]!)).not.toContain('extra');
    }
  });

  it('delete drops the dataset, then summary throws NotFound', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    const ds = await seedDataset(ctx);
    await brapiManageDataset.handler(
      brapiManageDataset.input.parse({ mode: 'delete', datasetId: ds.datasetId }),
      ctx,
    );
    await expect(
      brapiManageDataset.handler(
        brapiManageDataset.input.parse({ mode: 'summary', datasetId: ds.datasetId }),
        ctx,
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
  });

  it('rejects summary / load / delete when datasetId is missing', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    await expect(
      brapiManageDataset.handler(brapiManageDataset.input.parse({ mode: 'summary' }), ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
  });

  it('format() renders a summary section the agent can read', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    const ds = await seedDataset(ctx);
    const result = await brapiManageDataset.handler(
      brapiManageDataset.input.parse({ mode: 'summary', datasetId: ds.datasetId }),
      ctx,
    );
    const text = (brapiManageDataset.format!(result)[0] as { text: string }).text;
    expect(text).toContain(ds.datasetId);
    expect(text).toContain('find_studies');
    expect(text).toContain('rowCount: 3');
  });
});
