/**
 * @fileoverview Tests for the spec dialect — passthrough must not mutate or
 * drop anything from the filter map.
 *
 * @module tests/services/brapi-dialect/spec-dialect.test
 */

import { describe, expect, it } from 'vitest';
import { specDialect } from '@/services/brapi-dialect/spec-dialect.js';

describe('specDialect', () => {
  it('returns filters unchanged for any endpoint', () => {
    const input = {
      commonCropNames: ['Cassava', 'Maize'],
      studyTypes: ['Yield Trial'],
      programDbIds: ['p1'],
      active: true,
      page: 0,
      pageSize: 100,
    };
    const result = specDialect.adaptGetFilters('studies', input);
    expect(result.filters).toEqual(input);
    expect(result.warnings).toEqual([]);
  });

  it('returns a fresh outer object (callers can mutate the result without touching input)', () => {
    const input = { commonCropNames: ['Cassava'] };
    const result = specDialect.adaptGetFilters('studies', input);
    expect(result.filters).not.toBe(input);
    result.filters.studyTypes = ['Yield Trial'];
    expect((input as Record<string, unknown>).studyTypes).toBeUndefined();
  });

  it('preserves both plural and singular keys without translation', () => {
    const input = {
      commonCropNames: ['Cassava'],
      commonCropName: 'Cassava',
      searchText: 'foo',
    };
    const result = specDialect.adaptGetFilters('studies', input);
    expect(result.filters).toEqual(input);
  });
});
