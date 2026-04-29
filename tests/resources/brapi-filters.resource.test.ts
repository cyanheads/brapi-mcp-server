/**
 * @fileoverview Tests for `brapi://filters/{endpoint}` — wraps the static
 * filter catalog. No connection required.
 *
 * @module tests/resources/brapi-filters.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { brapiFiltersResource } from '@/mcp-server/resources/definitions/brapi-filters.resource.js';

describe('brapi://filters/{endpoint} resource', () => {
  it('returns the filter catalog for a known endpoint', async () => {
    const ctx = createMockContext();
    const result = (await brapiFiltersResource.handler({ endpoint: 'studies' }, ctx)) as {
      endpoint: string;
      filterCount: number;
      filters: Array<{ name: string }>;
    };
    expect(result.endpoint).toBe('studies');
    const names = result.filters.map((f) => f.name);
    expect(names).toContain('commonCropNames');
    expect(names).toContain('seasonDbIds');
  });

  it('throws when the endpoint is unknown', async () => {
    const ctx = createMockContext();
    await expect(
      brapiFiltersResource.handler({ endpoint: 'unknown-endpoint' }, ctx),
    ).rejects.toThrow();
  });

  it('list() advertises one entry per known endpoint', async () => {
    const listing = await brapiFiltersResource.list!({} as never);
    expect(listing.resources.length).toBeGreaterThanOrEqual(7);
    const studiesEntry = listing.resources.find((r) => r.uri === 'brapi://filters/studies');
    expect(studiesEntry).toBeDefined();
  });
});
