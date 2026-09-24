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
    expect(names).toContain('germplasmDbIds');
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

  describe('format() table cells', () => {
    function render(filters: Array<{ name: string; description: string; example: string }>) {
      const blocks = brapiDescribeFilters.format!({
        endpoint: 'studies',
        filterCount: filters.length,
        filters: filters.map((f) => ({ ...f, type: 'string' as const })),
        availableEndpoints: ['studies'],
      });
      return (blocks[0] as { text: string }).text;
    }

    it('renders the full table shape with code-span Name/Type/Example cells', () => {
      const text = render([
        { name: 'studyDbIds', description: 'Study identifiers.', example: 'abc' },
        { name: 'mode', description: 'One of a | b.', example: 'x|y' },
      ]);
      expect(text).toBe(
        [
          '# Filters for `studies` (2 total)',
          '',
          '| Name | Type | Description | Example |',
          '|:-----|:-----|:------------|:--------|',
          '| `studyDbIds` | `string` | Study identifiers. | `abc` |',
          '| `mode` | `string` | One of a \\| b. | `x\\|y` |',
          '',
          '_Available endpoints: `studies`._',
        ].join('\n'),
      );
    });

    it('escapes backslashes before pipes in the Description cell so they survive rendering', () => {
      const text = render([
        { name: 'a', description: 'x\\|y', example: 'e' },
        { name: 'b', description: 'a\\*b', example: 'e' },
        { name: 'c', description: 'trailing \\', example: 'e' },
      ]);
      // `x\|y` → `x\\\|y`: the doubled backslash renders one literal `\`, the
      // escaped pipe renders a literal `|` without splitting the cell.
      expect(text).toContain('| `a` | `string` | x\\\\\\|y | `e` |');
      expect(text).toContain('| `b` | `string` | a\\\\*b | `e` |');
      expect(text).toContain('| `c` | `string` | trailing \\\\ | `e` |');
    });

    it('leaves backslashes in code-span cells untouched', () => {
      const text = render([{ name: 'n\\m', description: 'plain', example: 'C:\\path' }]);
      expect(text).toContain('| `n\\m` | `string` | plain | `C:\\path` |');
    });

    it('escapes pipes in code-span cells, which would otherwise split the row', () => {
      // GFM splits a row on every unescaped `|`, code spans included; `\|`
      // renders as `|` inside the span.
      const text = render([{ name: 'a|b', description: 'plain', example: 'x|y' }]);
      expect(text).toContain('| `a\\|b` | `string` | plain | `x\\|y` |');
    });
  });
});
