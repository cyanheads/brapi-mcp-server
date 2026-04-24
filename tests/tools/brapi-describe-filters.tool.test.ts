/**
 * @fileoverview Tests for `brapi_describe_filters`. Static-catalog tool —
 * no service wiring required.
 *
 * @module tests/tools/brapi-describe-filters.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { brapiDescribeFilters } from '@/mcp-server/tools/definitions/brapi-describe-filters.tool.js';

describe('brapi_describe_filters tool', () => {
  it('returns the studies filter catalog with pagination filters included', async () => {
    const ctx = createMockContext();
    const result = await brapiDescribeFilters.handler(
      brapiDescribeFilters.input.parse({ endpoint: 'studies' }),
      ctx,
    );
    expect(result.endpoint).toBe('studies');
    expect(result.filterCount).toBe(result.filters.length);
    const names = result.filters.map((f) => f.name);
    expect(names).toContain('commonCropNames');
    expect(names).toContain('seasonDbIds');
    expect(names).toContain('pageSize');
    expect(result.specReference).toContain('brapi.org');
    expect(result.availableEndpoints.length).toBeGreaterThanOrEqual(7);
  });

  it('returns the germplasm catalog distinct from studies', async () => {
    const ctx = createMockContext();
    const result = await brapiDescribeFilters.handler(
      brapiDescribeFilters.input.parse({ endpoint: 'germplasm' }),
      ctx,
    );
    const names = result.filters.map((f) => f.name);
    expect(names).toContain('germplasmPUIs');
    expect(names).toContain('accessionNumbers');
    expect(names).not.toContain('studyTypes');
  });

  it('rejects unknown endpoints at input validation', () => {
    expect(() => brapiDescribeFilters.input.parse({ endpoint: 'bogus' })).toThrow();
  });

  it('format() renders a markdown table with every filter', async () => {
    const ctx = createMockContext();
    const result = await brapiDescribeFilters.handler(
      brapiDescribeFilters.input.parse({ endpoint: 'locations' }),
      ctx,
    );
    const blocks = brapiDescribeFilters.format!(result);
    const text = (blocks[0] as { text: string }).text;
    for (const filter of result.filters) {
      expect(text).toContain(filter.name);
    }
    expect(text).toContain('| Name | Type | Description | Example |');
  });
});
