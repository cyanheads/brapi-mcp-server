/**
 * @fileoverview Strict inline row budget boundaries on both serialized surfaces.
 * @module tests/tools/shared/inline-preview.test
 */

import { describe, expect, it } from 'vitest';
import { selectInlineRows } from '@/mcp-server/tools/shared/find-helpers.js';
import { renderRawRows, selectPreviewRows } from '@/mcp-server/tools/shared/inline-preview.js';

describe('strict inline previews', () => {
  it.each(['a', 'é', '\\"\n'])('bounds both surfaces for %j including repeated rows', (value) => {
    const repeated = { value: value.repeat(1000) };
    const rows = Array.from({ length: 30 }, () => repeated);
    const selection = selectPreviewRows(rows, 30, renderRawRows);
    expect(selection.bound).toBe('budget');
    expect(selection.rows.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(selection.rows))).toBeLessThanOrEqual(24_000);
    expect(Buffer.byteLength(JSON.stringify(renderRawRows(selection.rows)))).toBeLessThanOrEqual(
      24_000,
    );
    const next = rows.slice(0, selection.rows.length + 1);
    expect(
      Math.max(
        Buffer.byteLength(JSON.stringify(next)),
        Buffer.byteLength(JSON.stringify(renderRawRows(next))),
      ),
    ).toBeGreaterThan(24_000);
  });

  it('allows no oversized-first-row exception while leaving finder selection unchanged', () => {
    const rows = [{ value: 'é'.repeat(24_000) }];
    expect(selectPreviewRows(rows, 10, renderRawRows)).toEqual({ rows: [], bound: 'budget' });
    expect(selectInlineRows(rows, 10).rows).toEqual(rows);
  });

  it('returns empty input without a bound and distinguishes the row ceiling', () => {
    expect(selectPreviewRows([], 5, renderRawRows)).toEqual({ rows: [] });
    expect(selectPreviewRows([{ n: 1 }, { n: 2 }], 1, renderRawRows)).toEqual({
      rows: [{ n: 1 }],
      bound: 'loadLimit',
    });
    expect(selectPreviewRows([{ n: 1 }], 1, renderRawRows)).toEqual({ rows: [{ n: 1 }] });
  });
});
