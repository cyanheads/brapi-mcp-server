/**
 * @fileoverview Tests for shared find_* / get_* helpers — passthrough
 * rendering, distribution aggregation, refinement hints. These live in
 * `find-helpers.ts` and are exercised indirectly by every find/get tool;
 * unit tests pin the contract directly so the indirect coverage doesn't
 * have to.
 *
 * @module tests/tools/shared/find-helpers.test
 */

import { describe, expect, it } from 'vitest';
import {
  appendPassthroughLines,
  collectPassthroughParts,
  renderDataframeHandle,
  renderDistributions,
  toDataframeHandle,
} from '@/mcp-server/tools/shared/find-helpers.js';

describe('collectPassthroughParts', () => {
  it('renders scalars verbatim', () => {
    const parts = collectPassthroughParts({ name: 'Maize', count: 12, active: true }, new Set());
    expect(parts).toEqual(['name=Maize', 'count=12', 'active=true']);
  });

  it('skips rendered keys and nullish values', () => {
    const parts = collectPassthroughParts(
      { name: 'Maize', skipMe: 'no', maybe: undefined, empty: null },
      new Set(['skipMe']),
    );
    expect(parts).toEqual(['name=Maize']);
  });

  it('inlines small nested objects as JSON', () => {
    const parts = collectPassthroughParts({ trait: { dbId: 'T1', name: 'yield' } }, new Set());
    expect(parts).toEqual([`trait=${JSON.stringify({ dbId: 'T1', name: 'yield' })}`]);
  });

  it('collapses large nested objects to a size-aware placeholder', () => {
    // Build an object whose JSON is well over the 240-char inline cap.
    const big: Record<string, string> = {};
    for (let i = 0; i < 30; i++) big[`k${i}`] = `value-${i}-padded`;
    const parts = collectPassthroughParts({ additionalInfo: big }, new Set());
    expect(parts).toHaveLength(1);
    const rendered = parts[0]!;
    expect(rendered).toMatch(/^additionalInfo=<30 keys, \d+\.\d+KB — see structuredContent>$/);
    // The raw object data must not leak into the placeholder.
    expect(rendered).not.toContain('value-0-padded');
  });

  it('collapses large arrays with an entries count', () => {
    const features = Array.from({ length: 25 }, (_, i) => ({
      kind: 'Polygon',
      index: i,
      coordinates: [
        [10, 20],
        [11, 21],
        [12, 22],
      ],
    }));
    const parts = collectPassthroughParts({ features }, new Set());
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatch(/^features=<25 entries, \d+\.\d+KB — see structuredContent>$/);
  });
});

describe('appendPassthroughLines', () => {
  it('honors the same inline cap as collectPassthroughParts', () => {
    const lines: string[] = [];
    const big: Record<string, string> = {};
    for (let i = 0; i < 30; i++) big[`k${i}`] = `v${i}-padded-padded`;
    appendPassthroughLines(lines, { name: 'small', payload: big }, new Set());
    expect(lines[0]).toBe('- **name:** small');
    expect(lines[1]).toMatch(/^- \*\*payload:\*\* <30 keys, \d+\.\d+KB — see structuredContent>$/);
  });
});

describe('renderDataframeHandle', () => {
  const base = {
    tableName: 'df_AAAAA_BBBBB',
    rowCount: 12,
    columns: ['variantDbId', 'end_'],
    createdAt: '2026-06-01T00:00:00.000Z',
    expiresAt: '2999-01-01T00:00:00.000Z',
  };

  it('renders a renamedColumns line when a legend is present', () => {
    const lines = renderDataframeHandle({ ...base, columnLegend: { end_: 'end' } });
    expect(lines.join('\n')).toContain(
      'renamedColumns: end_ → end (query using the left-hand names)',
    );
  });

  it('omits the renamedColumns line when no columns were renamed', () => {
    expect(renderDataframeHandle(base).join('\n')).not.toContain('renamedColumns');
  });
});

describe('renderDistributions', () => {
  it('renders a simple distribution without a caveat', () => {
    const out = renderDistributions({ crop: { Maize: 3, Wheat: 1 } });
    expect(out).toBe('- **crop:** Maize (3), Wheat (1)');
    expect(out).not.toContain('Computed over');
  });

  it('omits the caveat when truncated is false', () => {
    const out = renderDistributions(
      { crop: { Maize: 3 } },
      { truncated: false, rowCount: 3, totalCount: 3 },
    );
    expect(out).not.toContain('Computed over');
  });

  it('prepends a caveat when truncated is true', () => {
    const out = renderDistributions(
      { crop: { Soybean: 250 } },
      { truncated: true, rowCount: 250, totalCount: 880 },
    );
    expect(out).toContain('_Computed over 250 of 880 upstream rows');
    expect(out).toContain('- **crop:** Soybean (250)');
  });

  it('returns empty string for empty distributions (no caveat with no data)', () => {
    expect(renderDistributions({})).toBe('');
  });
});

describe('toDataframeHandle', () => {
  it('propagates columnLegend from the register result', () => {
    const handle = toDataframeHandle({
      tableName: 'df_X',
      rowCount: 1,
      columns: ['end_'],
      createdAt: '2026-06-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      columnLegend: { end_: 'end' },
    });
    expect(handle.columnLegend).toEqual({ end_: 'end' });
  });

  it('propagates totalCount when supplied', () => {
    const handle = toDataframeHandle(
      {
        tableName: 'df_Y',
        rowCount: 250,
        columns: ['id'],
        createdAt: '2026-06-01T00:00:00.000Z',
        expiresAt: '2999-01-01T00:00:00.000Z',
        truncated: true,
      },
      880,
    );
    expect(handle.totalCount).toBe(880);
    expect(handle.truncated).toBe(true);
  });

  it('omits totalCount when not supplied', () => {
    const handle = toDataframeHandle({
      tableName: 'df_Z',
      rowCount: 5,
      columns: ['id'],
      createdAt: '2026-06-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    expect(handle.totalCount).toBeUndefined();
  });
});
