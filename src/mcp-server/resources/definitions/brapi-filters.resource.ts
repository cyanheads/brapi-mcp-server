/**
 * @fileoverview `brapi://filters/{endpoint}` — filter catalog for a BrAPI
 * endpoint (studies, germplasm, observations, variables, images, variants,
 * locations). Mirror of `brapi_describe_filters`. Static catalog — no
 * connection or auth required.
 *
 * @module mcp-server/resources/definitions/brapi-filters.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { brapiDescribeFilters } from '@/mcp-server/tools/definitions/brapi-describe-filters.tool.js';
import { listFilterEndpoints } from '@/services/brapi-filters/index.js';

const ENDPOINTS = listFilterEndpoints();

export const brapiFiltersResource = resource('brapi://filters/{endpoint}', {
  name: 'brapi-filters',
  title: 'BrAPI filter catalog',
  description:
    'BrAPI filter catalog for a single endpoint (name, type, description, example per filter). Mirrors the brapi_describe_filters tool.',
  mimeType: 'application/json',
  params: z.object({
    endpoint: z
      .string()
      .min(1)
      .describe(`BrAPI endpoint to describe filters for. Known values: ${ENDPOINTS.join(', ')}.`),
  }),
  async handler(params, ctx) {
    return await brapiDescribeFilters.handler(
      brapiDescribeFilters.input.parse({ endpoint: params.endpoint }),
      ctx,
    );
  },
  list: async () => ({
    resources: ENDPOINTS.map((endpoint) => ({
      uri: `brapi://filters/${endpoint}`,
      name: `BrAPI filter catalog · ${endpoint}`,
      description: `Filter names accepted by /${endpoint} on a BrAPI v2.1 server.`,
      mimeType: 'application/json',
    })),
  }),
});
