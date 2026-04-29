/**
 * @fileoverview `brapi://dataset/{datasetId}` — metadata + provenance for a
 * persisted dataset (rows omitted; use `brapi_manage_dataset` mode `load` to
 * page through rows). Dataset IDs are unbounded and tenant-scoped — clients
 * obtain them from a `find_*` tool's spillover handle, then read this URI.
 *
 * @module mcp-server/resources/definitions/brapi-dataset.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getDatasetStore } from '@/services/dataset-store/index.js';

export const brapiDatasetResource = resource('brapi://dataset/{datasetId}', {
  name: 'brapi-dataset',
  title: 'BrAPI dataset metadata',
  description:
    'Persisted dataset metadata + provenance (source tool, baseUrl, original query, row count, columns, expiry). Rows themselves are accessible via brapi_manage_dataset (mode: load). IDs come from the spillover handle on find_* tools.',
  mimeType: 'application/json',
  params: z.object({
    datasetId: z.string().min(1).describe('Dataset UUID returned by a find_* tool spillover.'),
  }),
  handler(params, ctx) {
    return getDatasetStore().summary(ctx, params.datasetId);
  },
  list: async () => ({
    resources: [],
  }),
});
