/**
 * @fileoverview Tests for `brapi://dataset/{datasetId}` — wraps DatasetStore
 * summary lookup.
 *
 * @module tests/resources/brapi-dataset.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brapiDatasetResource } from '@/mcp-server/resources/definitions/brapi-dataset.resource.js';
import { getDatasetStore } from '@/services/dataset-store/index.js';
import { initTestServices, resetTestServices } from '../tools/_tool-test-helpers.js';

describe('brapi://dataset/{datasetId} resource', () => {
  beforeEach(() => {
    initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('returns metadata for a persisted dataset', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    const ds = await getDatasetStore().create(ctx, {
      source: 'find_studies',
      baseUrl: 'https://test.example.org',
      query: { commonCropNames: ['Cassava'] },
      rows: [{ studyDbId: 's-1' }],
    });

    const result = (await brapiDatasetResource.handler({ datasetId: ds.datasetId }, ctx)) as {
      datasetId: string;
      source: string;
      rowCount: number;
    };
    expect(result.datasetId).toBe(ds.datasetId);
    expect(result.source).toBe('find_studies');
    expect(result.rowCount).toBe(1);
  });

  it('throws NotFound for an unknown id', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    await expect(
      brapiDatasetResource.handler({ datasetId: '00000000-0000-0000-0000-000000000000' }, ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
  });

  it('list() returns an empty array (IDs are unbounded)', async () => {
    const listing = await brapiDatasetResource.list!({} as never);
    expect(listing.resources).toEqual([]);
  });
});
