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
  type DataframeHandle,
  hasFindRoute,
  renderDataframeHandle,
  renderDistributions,
  resolveFindRoute,
  toDataframeHandle,
} from '@/mcp-server/tools/shared/find-helpers.js';
import type { BrapiDialect } from '@/services/brapi-dialect/index.js';
import type { CallDescriptor, CapabilityProfile } from '@/services/capability-registry/types.js';

function profileOf(calls: CallDescriptor[]): CapabilityProfile {
  return {
    baseUrl: 'https://brapi.example.org/brapi/v2',
    server: {},
    supported: Object.fromEntries(calls.map((c) => [c.service, c])),
    crops: [],
    fetchedAt: '2026-06-01T00:00:00.000Z',
  };
}

function dialectOf(disabled: string[] = []): BrapiDialect {
  return { id: 'test', disabledSearchEndpoints: new Set(disabled) } as unknown as BrapiDialect;
}

/** resolveFindRoute outcome as a short label: the route kind, or the thrown reason. */
function routeOutcome(profile: CapabilityProfile, dialect: BrapiDialect, escalate = false): string {
  try {
    return resolveFindRoute({
      profile,
      dialect,
      endpoint: 'studies',
      filters: {},
      searchBody: {},
      warnings: [],
      ...(escalate ? { requiresEscalation: true } : {}),
    }).kind;
  } catch (err) {
    return String((err as { data?: { reason?: string } }).data?.reason);
  }
}

const ROUTE_CASES: Array<[string, CallDescriptor[], string[], boolean, string]> = [
  ['GET advertised', [{ service: 'studies', methods: ['GET'] }], [], false, 'get'],
  ['GET without methods', [{ service: 'studies' }], [], false, 'get'],
  [
    'GET listed for POST only',
    [{ service: 'studies', methods: ['POST'] }],
    [],
    false,
    'missing_find_route',
  ],
  ['search only', [{ service: 'search/studies', methods: ['POST'] }], [], false, 'search'],
  ['search only, no methods', [{ service: 'search/studies' }], [], false, 'search'],
  [
    'search only, dialect-disabled',
    [{ service: 'search/studies' }],
    ['studies'],
    false,
    'search_endpoint_disabled',
  ],
  [
    'search listed for GET only',
    [{ service: 'search/studies', methods: ['GET'] }],
    [],
    false,
    'missing_find_route',
  ],
  ['nothing', [], [], false, 'missing_find_route'],
  [
    'escalation with both',
    [{ service: 'studies' }, { service: 'search/studies', methods: ['POST'] }],
    [],
    true,
    'search',
  ],
  [
    'escalation blocked by dialect',
    [{ service: 'studies' }, { service: 'search/studies', methods: ['POST'] }],
    ['studies'],
    true,
    'get',
  ],
];

describe('resolveFindRoute', () => {
  it.each(ROUTE_CASES)('%s', (_label, calls, disabled, escalate, expected) => {
    expect(routeOutcome(profileOf(calls), dialectOf(disabled), escalate)).toBe(expected);
  });
});

describe('hasFindRoute', () => {
  it.each(ROUTE_CASES)('agrees with resolveFindRoute: %s', (_label, calls, disabled, escalate) => {
    const profile = profileOf(calls);
    const dialect = dialectOf(disabled);
    const routed = ['get', 'search'].includes(routeOutcome(profile, dialect, escalate));
    expect(hasFindRoute(profile, dialect, 'studies')).toBe(routed);
  });
});

/** A spilled-result dataframe handle, as a `find_*` format() would receive it. */
function handle(overrides: Partial<DataframeHandle> = {}): DataframeHandle {
  return {
    tableName: 'df_AAAAA_BBBBB',
    rowCount: 26,
    columns: ['studyDbId', 'additionalInfo'],
    createdAt: '2026-06-01T00:00:00.000Z',
    expiresAt: '2999-01-01T00:00:00.000Z',
    ...overrides,
  };
}

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

  it('points an oversized value at the dataframe that holds it, not structuredContent', () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 30; i++) big[`k${i}`] = `value-${i}-padded`;
    const parts = collectPassthroughParts(
      { additionalInfo: big },
      new Set(),
      handle({ tableName: 'df_XHBZO_ZO23P' }),
    );
    const rendered = parts[0]!;
    expect(rendered).toMatch(
      /^additionalInfo=<30 keys, \d+\.\d+KB — query `df_XHBZO_ZO23P` via brapi_dataframe_query>$/,
    );
    // A content-only client cannot read structuredContent — naming it here is
    // the bug, so the pointer must not fall back to it when a dataframe exists.
    expect(rendered).not.toContain('structuredContent');
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

  it('renders a realistic column list complete — the budget must not fire on find_* shapes', () => {
    // The live bti-breedbase-demo find_studies dataframe: 18 columns.
    const columns = [
      'locationName',
      'studyName',
      'externalReferences',
      'trialName',
      'dataLinks',
      'experimentalDesign',
      'commonCropName',
      'seasons',
      'studyType',
      'studyDescription',
      'trialDbId',
      'documentationURL',
      'studyDbId',
      'additionalInfo',
      'locationDbId',
      'active',
      'startDate',
      'endDate',
    ];
    const out = renderDataframeHandle({ ...base, columns }).join('\n');
    for (const col of columns) expect(out).toContain(col);
    expect(out).not.toContain('…+');
  });

  it('caps a pathological column list at the query path, but never the sole decoder', () => {
    // A genotype matrix's wide pivot: one column per variant.
    const columns = ['germplasmDbId', ...Array.from({ length: 5_000 }, (_, i) => `v_${i}`)];
    // renamedColumns is the only safe→original mapping, with no describe or
    // re-call path behind it — it renders complete however long it gets.
    const columnLegend = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`v_${i}`, `variant-${i}`]),
    );
    const out = renderDataframeHandle({ ...base, columns, columnLegend }).join('\n');

    const columnsLine = out.split('\n').find((l) => l.startsWith('- columns:')) ?? '';
    expect(columnsLine).toContain('…+');
    // Points at the uncapped path (a query), not describe — whose own per-column
    // listing is now budgeted the same way, so pointing there would be circular.
    expect(columnsLine).toContain('brapi_dataframe_query');
    expect(columnsLine).toContain(`SELECT * FROM ${base.tableName} LIMIT 0`);
    expect(columnsLine).not.toContain('brapi_dataframe_describe lists the full schema');
    expect(columnsLine.length).toBeLessThan(700);

    const renamedLine = out.split('\n').find((l) => l.startsWith('- renamedColumns:')) ?? '';
    for (const [safe, original] of Object.entries(columnLegend)) {
      expect(renamedLine).toContain(`${safe} → ${original}`);
    }
    expect(renamedLine).not.toContain('…+');
  });
});

describe('renderDistributions', () => {
  it('renders a simple distribution without a caveat', () => {
    const out = renderDistributions({ crop: { Maize: 3, Wheat: 1 } });
    expect(out).toBe('- **crop:** Maize (3), Wheat (1)');
    expect(out).not.toContain('Computed over');
  });

  it('omits the caveat when the dataframe was not truncated', () => {
    const out = renderDistributions({ crop: { Maize: 3 } }, handle({ rowCount: 3 }));
    expect(out).not.toContain('Computed over');
  });

  it('prepends a caveat when truncated is true', () => {
    const out = renderDistributions(
      { crop: { Soybean: 250 } },
      handle({ truncated: true, rowCount: 250, totalCount: 880 }),
    );
    expect(out).toContain('_Computed over 250 of 880 upstream rows');
    expect(out).toContain('- **crop:** Soybean (250)');
  });

  it('returns empty string for empty distributions (no caveat with no data)', () => {
    expect(renderDistributions({})).toBe('');
  });

  it('renders every value when the distribution fits the line budget', () => {
    // The studyType distribution of the 26-study bti-breedbase-demo server:
    // 9 values over an unspilled result set, where rendering all of them costs
    // ~200 chars. A fixed top-5 cap dropped four of them for no benefit.
    const studyType = {
      'drone trial': 7,
      activity_record: 2,
      phenotyping_trial: 2,
      storage_trial: 2,
      'Flight trial': 1,
      transformation_project: 1,
      'Preliminary Yield Trial': 1,
      'Clonal Evaluation': 1,
      health_status_trial: 1,
    };
    const out = renderDistributions({ studyType });
    for (const value of Object.keys(studyType)) expect(out).toContain(value);
    expect(out).not.toContain('more');
  });

  it('caps a high-cardinality distribution and names the dataframe holding the rest', () => {
    const counts = Object.fromEntries(
      Array.from({ length: 5_000 }, (_, i) => [`germplasm-accession-${i}`, 1]),
    );
    const out = renderDistributions({ germplasmName: counts }, handle({ tableName: 'df_BIG' }));
    expect(out).toContain('…+');
    expect(out).toContain('aggregate dataframe `df_BIG` with brapi_dataframe_query');
    // The whole point of capping: the line stays bounded regardless of input.
    expect(out.length).toBeLessThan(700);
  });

  it('falls back to structuredContent when a capped distribution has no dataframe', () => {
    const counts = Object.fromEntries(
      Array.from({ length: 5_000 }, (_, i) => [`germplasm-accession-${i}`, 1]),
    );
    const out = renderDistributions({ germplasmName: counts });
    expect(out).toContain('…+');
    expect(out).toContain('see structuredContent.distributions');
    expect(out).not.toContain('brapi_dataframe_query');
  });

  it('renders the leading value even when it alone overruns the budget', () => {
    const out = renderDistributions({ note: { ['x'.repeat(900)]: 2 } });
    expect(out).toContain('x'.repeat(900));
    expect(out).toContain('(2)');
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
