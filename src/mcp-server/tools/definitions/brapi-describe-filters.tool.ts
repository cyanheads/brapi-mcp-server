/**
 * @fileoverview `brapi_describe_filters` — list valid filter names for a
 * BrAPI endpoint. Powers dynamic discovery before constructing
 * `extraFilters` on `find_*` tools. Returns a filter catalog with name,
 * type, description, and example per filter. Catalog entries reflect the
 * BrAPI v2.1 spec; individual servers may implement subsets.
 *
 * @module mcp-server/tools/definitions/brapi-describe-filters.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { getFilterCatalog, listFilterEndpoints } from '@/services/brapi-filters/index.js';

const ENDPOINT_VALUES = listFilterEndpoints();

const FilterDescriptorSchema = z.object({
  name: z.string().describe('Filter parameter name (as accepted by the BrAPI endpoint).'),
  type: z
    .enum(['string', 'integer', 'number', 'boolean', 'date', 'string[]', 'integer[]'])
    .describe('Expected value type.'),
  description: z.string().describe('Short description of what the filter does.'),
  example: z.string().describe('Example value (stringified).'),
});

export const brapiDescribeFilters = tool('brapi_describe_filters', {
  description:
    'List the valid filter names for a BrAPI endpoint (studies, germplasm, observations, variables, images, variants, locations). Use this to discover what keys can go into the `extraFilters` passthrough on any `find_*` tool. Entries reflect the BrAPI v2.1 spec — individual servers may implement subsets.',
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    endpoint: z
      .enum(ENDPOINT_VALUES as [string, ...string[]])
      .describe('BrAPI endpoint to describe filters for.'),
  }),
  output: z.object({
    endpoint: z.string().describe('The endpoint the filters apply to.'),
    filterCount: z.number().int().nonnegative().describe('Number of filters in the catalog.'),
    filters: z.array(FilterDescriptorSchema).describe('Filter catalog entries.'),
    specReference: z
      .string()
      .optional()
      .describe('Pointer to the BrAPI v2 spec section for this endpoint.'),
    availableEndpoints: z
      .array(z.string())
      .describe('Every endpoint this tool can describe — useful for discovery.'),
  }),

  handler(input, _ctx) {
    const catalog = getFilterCatalog(input.endpoint);
    if (!catalog) {
      throw notFound(
        `No filter catalog for endpoint '${input.endpoint}'. Available: ${ENDPOINT_VALUES.join(', ')}.`,
        { endpoint: input.endpoint, availableEndpoints: ENDPOINT_VALUES },
      );
    }
    return {
      endpoint: catalog.endpoint,
      filterCount: catalog.filters.length,
      filters: catalog.filters,
      ...(catalog.specReference !== undefined ? { specReference: catalog.specReference } : {}),
      availableEndpoints: ENDPOINT_VALUES,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`# Filters for \`${result.endpoint}\` (${result.filterCount} total)`);
    if (result.specReference) {
      lines.push('');
      lines.push(`**Spec:** ${result.specReference}`);
    }
    lines.push('');
    lines.push('| Name | Type | Description | Example |');
    lines.push('|:-----|:-----|:------------|:--------|');
    for (const filter of result.filters) {
      const description = filter.description.replace(/\|/g, '\\|');
      lines.push(
        `| \`${filter.name}\` | \`${filter.type}\` | ${description} | \`${filter.example}\` |`,
      );
    }
    lines.push('');
    lines.push(
      `_Available endpoints: ${result.availableEndpoints.map((e) => `\`${e}\``).join(', ')}._`,
    );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
