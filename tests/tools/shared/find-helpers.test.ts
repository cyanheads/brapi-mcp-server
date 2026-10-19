/**
 * @fileoverview Tests for shared find_* / get_* helpers — passthrough
 * rendering, distribution aggregation, refinement hints. These live in
 * `find-helpers.ts` and are exercised indirectly by every find/get tool;
 * unit tests pin the contract directly so the indirect coverage doesn't
 * have to.
 *
 * @module tests/tools/shared/find-helpers.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  type McpError,
  requestCancelled,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { type FetchWithTimeoutOptions, fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { brapiCallsResource } from '@/mcp-server/resources/definitions/brapi-calls.resource.js';
import { brapiGermplasmResource } from '@/mcp-server/resources/definitions/brapi-germplasm.resource.js';
import { brapiServerInfoResource } from '@/mcp-server/resources/definitions/brapi-server-info.resource.js';
import { brapiStudyResource } from '@/mcp-server/resources/definitions/brapi-study.resource.js';
import { brapiVariableResource } from '@/mcp-server/resources/definitions/brapi-variable.resource.js';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiFindStudies } from '@/mcp-server/tools/definitions/brapi-find-studies.tool.js';
import {
  dropToolDefinitions,
  exportToolDefinitions,
  readOnlyToolDefinitions,
  writeToolDefinitions,
} from '@/mcp-server/tools/definitions/index.js';
import {
  appendPassthroughLines,
  buildRefinementHint,
  collectFindRoutes,
  collectPassthroughParts,
  type DataframeHandle,
  discloseInlineTrim,
  type FindRoute,
  hasFindRoute,
  INLINE_RESULTS_BUDGET_BYTES,
  loadInitialFindPage,
  MAX_SPILLOVER_PAGES,
  MAX_SPILLOVER_ROWS,
  type MaybeSpillInput,
  maybeSpill,
  renderDataframeHandle,
  renderDistributions,
  renderMoreRowsLine,
  renderWarningsTrailer,
  requireRegisteredConnection,
  resolveFindRoute,
  SPILL_WALK_DEADLINE_MS,
  selectInlineRows,
  spillWalkCeiling,
  stagedDataframeNotice,
  toDataframeHandle,
} from '@/mcp-server/tools/shared/find-helpers.js';
import { CALL_DEADLINE_MS, getBrapiClient } from '@/services/brapi-client/index.js';
import type { BrapiDialect } from '@/services/brapi-dialect/index.js';
import { getCanvasBridge } from '@/services/canvas-bridge/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import type { CallDescriptor, CapabilityProfile } from '@/services/capability-registry/types.js';
import { getServerRegistry, type RegisteredServer } from '@/services/server-registry/index.js';
import {
  BASE_URL,
  envelope,
  initTestServices,
  jsonResponse,
  type MockFetcher,
  resetTestServices,
  TEST_CONFIG,
} from '../_tool-test-helpers.js';

/** Every registered tool definition, across all registration gates. */
const ALL_TOOLS = [
  ...readOnlyToolDefinitions,
  ...dropToolDefinitions,
  ...exportToolDefinitions,
  ...writeToolDefinitions,
];

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

  it('names both dataframe tools on the tableName line', () => {
    expect(renderDataframeHandle(base)[0]).toBe(
      '- tableName: `df_AAAAA_BBBBB` (columns via brapi_dataframe_describe, rows via brapi_dataframe_query)',
    );
  });

  it('renders a renamedColumns line when a legend is present', () => {
    const lines = renderDataframeHandle({ ...base, columnLegend: { end_: 'end' } });
    expect(lines.join('\n')).toContain(
      'renamedColumns: end\\_ → end (query using the left-hand names)',
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
  it('ranks numeric and mixed keys by count before applying the budget', () => {
    expect(renderDistributions({ season: { '2011': 1, '2018': 3, Other: 2 } })).toBe(
      '- **season:** 2018 (3), Other (2), 2011 (1)',
    );
    const counts = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [String(i), i + 1]));
    const text = renderDistributions({ season: counts }, handle());
    expect(text).toMatch(/^- \*\*season:\*\* 99 \(100\), 98 \(99\)/);
    expect(text).toContain('aggregate dataframe');
    expect(text.length).toBeLessThan(700);
    expect(counts['99']).toBe(100);
  });
  it('renders a simple distribution without a caveat', () => {
    const out = renderDistributions({ crop: { Maize: 3, Wheat: 1 } });
    expect(out).toBe('- **crop:** Maize (3), Wheat (1)');
    expect(out).not.toContain('Computed over');
  });

  it('omits the caveat when the dataframe was not truncated', () => {
    const out = renderDistributions({ crop: { Maize: 3 } }, handle({ rowCount: 3 }));
    expect(out).not.toContain('Computed over');
  });

  it('prepends a caveat when truncated is true, suggesting narrower filters, never a larger loadLimit', () => {
    const out = renderDistributions(
      { crop: { Soybean: 250 } },
      handle({ truncated: true, rowCount: 250, totalCount: 880 }),
    );
    expect(out).toContain(
      '_Computed over the 250 row(s) in the truncated dataframe (the upstream reports 880) — narrow the filters for a representative sample._',
    );
    expect(out).not.toContain('loadLimit');
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
  const registered = {
    tableName: 'df_X',
    rowCount: 5,
    columns: ['end_'],
    createdAt: '2026-06-01T00:00:00.000Z',
    expiresAt: '2999-01-01T00:00:00.000Z',
  };

  it.each([
    ['propagates columnLegend', { columnLegend: { end_: 'end' } }, undefined],
    ['propagates totalCount and truncated when supplied', { truncated: true }, 880],
    ['omits totalCount when not supplied', {}, undefined],
  ])('%s', (_label, extra: Record<string, unknown>, totalCount) => {
    const out = toDataframeHandle({ ...registered, ...extra }, totalCount);
    expect(out).toMatchObject(extra);
    expect(out.totalCount).toBe(totalCount);
  });
});

describe('selectInlineRows — inline byte budget (#66)', () => {
  /** A row whose JSON serializes to exactly `bytes` bytes of `fill`. */
  function sizedRow(i: number, bytes: number, fill = 'x'): Record<string, unknown> {
    const id = `r${i}`;
    const fillBytes = Buffer.byteLength(fill, 'utf8');
    const room = bytes - JSON.stringify({ id, pad: '' }).length;
    return { id, pad: fill.repeat(Math.floor(room / fillBytes)) };
  }
  const sized = (n: number, bytes: number, fill?: string) =>
    Array.from({ length: n }, (_, i) => sizedRow(i + 1, bytes, fill));
  const arrayBytes = (rows: unknown[]) => Buffer.byteLength(JSON.stringify(rows), 'utf8');

  it('measures against the framework outline budget', () => {
    expect(INLINE_RESULTS_BUDGET_BYTES).toBe(24_000);
  });

  // [label, rows, loadLimit, expected length, expected bound]
  const CASES: Array<
    [string, () => Record<string, unknown>[], number, number, string | undefined]
  > = [
    ['empty', () => [], 10, 0, undefined],
    ['inside both bounds', () => sized(3, 100), 10, 3, undefined],
    ['loadLimit binds', () => sized(20, 100), 10, 10, 'loadLimit'],
    // 2 + 23 × 1,000 + 22 commas = 23,024 ≤ 24,000; a 24th row reaches 24,025.
    ['budget binds', () => sized(50, 1_000), 1_000, 23, 'budget'],
    ['budget binds before a lower loadLimit', () => sized(100, 1_000), 50, 23, 'budget'],
    // 2 + 11,998 + 11,999 + 1 comma = exactly 24,000 bytes.
    ['exactly at the budget', () => [sizedRow(1, 11_998), sizedRow(2, 11_999)], 10, 2, undefined],
    ['first row alone over budget, more rows', () => sized(3, 30_000), 10, 1, 'budget'],
    ['first row alone over budget, only row', () => sized(1, 30_000), 10, 1, undefined],
    ['loadLimit of 1 on a single fitting row', () => sized(5, 100), 1, 1, 'loadLimit'],
  ];

  it.each(CASES)('%s', (_label, makeRows, loadLimit, length, bound) => {
    const rows = makeRows();
    const selection = selectInlineRows(rows, loadLimit);
    expect(selection.rows).toHaveLength(length);
    expect(selection.rows).toEqual(rows.slice(0, length));
    expect(selection.bound).toBe(bound);
    if (length > 1) expect(arrayBytes(selection.rows)).toBeLessThanOrEqual(24_000);
    if (bound === 'budget' && length > 0 && length < rows.length) {
      expect(arrayBytes(rows.slice(0, length + 1))).toBeGreaterThan(24_000);
    }
  });

  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    // Each row carries ~1,000 two-byte characters: ~1,010 code units, ~2,010 bytes.
    const rows = sized(30, 2_010, 'é');
    const selection = selectInlineRows(rows, 100);
    expect(JSON.stringify(rows.slice(0, 23)).length).toBeLessThanOrEqual(24_000);
    expect(selection.rows.length).toBeLessThan(12);
    expect(arrayBytes(selection.rows)).toBeLessThanOrEqual(24_000);
    expect(arrayBytes(rows.slice(0, selection.rows.length + 1))).toBeGreaterThan(24_000);
  });
});

describe('discloseInlineTrim', () => {
  const dataframe: DataframeHandle = {
    tableName: 'df_TRIM',
    rowCount: 40,
    columns: ['id'],
    createdAt: '2026-06-01T00:00:00.000Z',
    expiresAt: '2999-01-01T00:00:00.000Z',
  };

  it('discloses a budget trim with shown, cap = loadLimit, and a notice naming the budget', () => {
    const ctx = createMockContext();
    discloseInlineTrim(ctx, { results: new Array(7), inlineBound: 'budget', dataframe }, 1_000);
    const enrichment = getEnrichment(ctx);
    expect(enrichment).toMatchObject({ truncated: true, shown: 7, cap: 1_000 });
    expect(enrichment.notice).toBe(
      'results[] holds the first 7 matched row(s): the 24,000-byte inline budget bound before loadLimit (1000). Staged dataframe `df_TRIM` (40 rows): list its columns with brapi_dataframe_describe, then query it with brapi_dataframe_query (SQL).',
    );
  });

  it('discloses a loadLimit trim with a notice naming loadLimit', () => {
    const ctx = createMockContext();
    discloseInlineTrim(ctx, { results: new Array(5), inlineBound: 'loadLimit', dataframe }, 5);
    const enrichment = getEnrichment(ctx);
    expect(enrichment).toMatchObject({ truncated: true, shown: 5, cap: 5 });
    expect(enrichment.notice).toContain('loadLimit (5)');
    expect(enrichment.notice).not.toContain('byte inline budget');
  });

  it('writes nothing when no bound fired', () => {
    const ctx = createMockContext();
    discloseInlineTrim(ctx, { results: new Array(3) }, 10);
    expect(getEnrichment(ctx)).toEqual({});
  });
});

describe('collectFindRoutes — shared operation bounds', () => {
  const connection: RegisteredServer = {
    alias: 'default',
    authMode: 'none',
    baseUrl: BASE_URL,
    registeredAt: '2026-10-18T00:00:00.000Z',
  };
  let fetcher: MockFetcher;
  beforeEach(() => {
    fetcher = initTestServices();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetTestServices();
  });
  const routes = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `s${i}`,
      route: {
        kind: 'get',
        path: '/things',
        service: 'things',
        filters: { studyDbId: `s${i}` },
      } satisfies FindRoute,
    }));

  it.each([10, 10_000])(
    'reserves a shared page and row budget at page size %s',
    async (pageSize) => {
      vi.stubEnv('BRAPI_PAGE_SIZE', String(pageSize));
      resetServerConfig();
      let scanned = 0;
      fetcher.mockImplementation(async (url: string) => {
        const u = new URL(url);
        const page = Number(u.searchParams.get('page') ?? 0);
        return jsonResponse(
          envelope(
            {
              data: Array.from({ length: pageSize }, (_, i) => ({
                id: `${u.searchParams.get('studyDbId')}-${page}-${i}`,
              })),
            },
            { totalCount: 1_000_000 },
          ),
        );
      });
      const coverage = await collectFindRoutes({
        client: getBrapiClient(),
        connection,
        ctx: createMockContext(),
        routes: routes(8),
        consume: (_id, rows) => {
          scanned += rows.length;
        },
      });
      expect(fetcher).toHaveBeenCalledTimes(pageSize === 10 ? 50 : 5);
      expect(scanned).toBe(pageSize === 10 ? 500 : 50_000);
      expect(coverage.reduce((sum, item) => sum + item.rowsScanned, 0)).toBe(scanned);
      expect(coverage.every((item) => item.status !== 'complete')).toBe(true);
      expect(
        coverage.some((item) => item.reason === (pageSize === 10 ? 'page_cap' : 'row_cap')),
      ).toBe(true);
    },
  );

  it.each([false, true])(
    'reports served page stride changes honestly (changing: %s)',
    async (changing) => {
      const kept: unknown[] = [];
      fetcher.mockImplementation(async (url: string) => {
        const page = Number(new URL(url).searchParams.get('page') ?? 0);
        const pageSize = !changing || page === 0 ? 3 : 2;
        const start = page * pageSize;
        return jsonResponse({
          metadata: { pagination: { pageSize, totalCount: 5 } },
          result: {
            data: Array.from({ length: Math.max(0, Math.min(pageSize, 5 - start)) }, (_, i) => ({
              id: String(start + i),
            })),
          },
        });
      });
      const coverage = await collectFindRoutes({
        client: getBrapiClient(),
        connection,
        ctx: createMockContext(),
        routes: routes(1),
        consume: (_id, rows) => kept.push(...rows),
      });
      expect(coverage[0]).toMatchObject(
        changing ? { status: 'partial', reason: 'page_size_changed' } : { status: 'complete' },
      );
      expect(kept).toEqual(
        changing
          ? [{ id: '0' }, { id: '1' }, { id: '2' }, { id: '2' }, { id: '3' }]
          : [{ id: '0' }, { id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }],
      );
    },
  );

  it('bounds concurrent requests and preserves every completed route', async () => {
    let active = 0;
    let peak = 0;
    fetcher.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });
    const coverage = await collectFindRoutes({
      client: getBrapiClient(),
      connection,
      ctx: createMockContext(),
      routes: routes(12),
      consume: () => {},
    });
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(coverage.every((item) => item.status === 'complete')).toBe(true);
  });

  it('keeps rows from a study whose later page fails and reports partial coverage', async () => {
    const kept: unknown[] = [];
    fetcher.mockImplementation(async (url: string) => {
      const page = Number(new URL(url).searchParams.get('page') ?? 0);
      return page === 0
        ? jsonResponse(envelope({ data: [{ id: 'real-id' }] }, { totalCount: 2 }))
        : new Response('unavailable', { status: 503 });
    });
    const coverage = await collectFindRoutes({
      client: getBrapiClient(),
      connection,
      ctx: createMockContext(),
      routes: routes(1),
      consume: (_id, rows) => kept.push(...rows),
    });
    expect(kept).toEqual([{ id: 'real-id' }]);
    expect(coverage).toMatchObject([
      { status: 'partial', rowsScanned: 1, pagesFetched: 1, reason: 'upstream_failure' },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('shares one decreasing deadline across fanout and later pages', async () => {
    let now = Date.now();
    const ctx = createMockContext();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const client = getBrapiClient();
    const get = vi.spyOn(client, 'get');
    fetcher.mockImplementation(async (url: string) => {
      const page = Number(new URL(url).searchParams.get('page') ?? 0);
      now += 10_001;
      return jsonResponse(envelope({ data: [{ id: `row-${page}` }] }, { totalCount: 100 }));
    });
    const coverage = await collectFindRoutes({
      client,
      connection,
      ctx,
      routes: routes(8),
      consume: () => {},
    });
    const budgets = get.mock.calls.map((call) => call[3]?.deadlineMs ?? Infinity);
    expect(budgets[0]).toBe(SPILL_WALK_DEADLINE_MS);
    expect(budgets.some((value) => value < SPILL_WALK_DEADLINE_MS)).toBe(true);
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(4);
    expect(
      coverage.some((item) => item.status === 'unprocessed' && item.reason === 'deadline'),
    ).toBe(true);
  });
});

describe('maybeSpill — client-side row filter over the spill walk', () => {
  // TEST_CONFIG pageSize is 10, so the walk ceiling is 10 × MAX_SPILLOVER_PAGES = 500 rows.
  const connection: RegisteredServer = {
    alias: 'default',
    authMode: 'none',
    baseUrl: BASE_URL,
    registeredAt: '2026-10-17T00:00:00.000Z',
  };
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  interface ServeOptions {
    /** Fail with HTTP 500 when this returns true for the requested page / pageSize. */
    failWhen?: (page: number, pageSize: number) => boolean;
    /** Ignore `page` and always serve the first page. */
    ignorePage?: boolean;
    /** Upstream's own pageSize cap: a larger request is served at this size, offset by it. */
    maxPageSize?: number;
    /** Report no totalCount at all. */
    omitTotal?: boolean;
    /** Called with the served page index before each response. */
    onRequest?: (page: number) => void;
    /** totalCount to report, when it differs from the rows actually served. */
    reportedTotal?: number;
    /** Report the pageSize the page was served at in `pagination.pageSize`. */
    reportPageSize?: boolean;
  }

  /** Serve `rows` as a paged /things list; any other host or path fails the call. */
  function serve(rows: Record<string, unknown>[], options: ServeOptions = {}): void {
    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(String(url));
      if (u.hostname !== 'brapi.example.org' || u.pathname !== '/brapi/v2/things') {
        throw new Error(`unmocked fetch: ${u.href}`);
      }
      const page = options.ignorePage ? 0 : Number.parseInt(u.searchParams.get('page') ?? '0', 10);
      const requested = Number.parseInt(u.searchParams.get('pageSize') ?? '10', 10);
      const pageSize = Math.min(requested, options.maxPageSize ?? requested);
      if (options.failWhen?.(page, requested)) {
        return jsonResponse({ error: 'upstream down' }, 500);
      }
      options.onRequest?.(page);
      const pagination: Record<string, number> = {};
      if (!options.omitTotal) pagination.totalCount = options.reportedTotal ?? rows.length;
      if (options.reportPageSize) pagination.pageSize = pageSize;
      return jsonResponse({
        metadata: { pagination },
        result: { data: rows.slice(page * pageSize, page * pageSize + pageSize) },
      });
    });
  }

  type Row = Record<string, unknown>;
  /** GET /things, the default route for these walks. */
  const GET_ROUTE: FindRoute = { kind: 'get', path: '/things', service: 'things', filters: {} };
  /** POST /search/things, for walks that run through the search route. */
  const SEARCH_ROUTE: FindRoute = {
    kind: 'search',
    noun: 'things',
    searchBody: {},
    service: 'search/things',
  };

  /**
   * Load the first page under `ctx` (GET /things, or POST `route`), then spill it.
   * `skipWalk` hands maybeSpill a first page that says nothing more exists.
   */
  async function spillWith(
    ctx: Context,
    loadLimit: number,
    options: { route?: FindRoute; skipWalk?: boolean } & Partial<MaybeSpillInput<Row>> = {},
  ) {
    const { route, skipWalk, ...extra } = options;
    const client = getBrapiClient();
    const loaded = await loadInitialFindPage<Row>(
      client,
      connection,
      route ?? GET_ROUTE,
      loadLimit,
      ctx,
    );
    return await maybeSpill<Row>({
      firstPage: skipWalk ? { ...loaded, hasMore: false } : loaded,
      client,
      connection,
      bridge: getCanvasBridge(),
      ctx,
      filters: {},
      path: '/things',
      source: 'find_things',
      loadLimit,
      ...(route ? { route } : {}),
      ...extra,
    });
  }

  function run(
    loadLimit: number,
    rowFilter?: (row: Row) => boolean,
    warnings?: string[],
    inlineView?: (rows: Row[]) => Row[],
  ) {
    return spillWith(createMockContext({ tenantId: 't1' }), loadLimit, {
      ...(rowFilter ? { rowFilter } : {}),
      ...(warnings ? { warnings } : {}),
      ...(inlineView ? { inlineView } : {}),
    });
  }

  /** Drive `Date.now()` from a counter that starts at real time (the call deadline reads ctx.timestamp). */
  function fakeClock(): { now: number } {
    const clock = { now: Date.now() };
    vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
    return clock;
  }

  /** After each served walk page (pageSize 10), record its timeout and advance `clock` by `stepMs`. */
  function chargeWalkPages(clock: { now: number }, stepMs: number): number[] {
    const served = fetcher.getMockImplementation()!;
    const walkTimeouts: number[] = [];
    fetcher.mockImplementation(async (url: string, timeoutMs: number, ...rest: unknown[]) => {
      const response = await served(url, timeoutMs, ...rest);
      if (new URL(String(url)).searchParams.get('pageSize') === '10') {
        walkTimeouts.push(timeoutMs);
        clock.now += stepMs;
      }
      return response;
    });
    return walkTimeouts;
  }

  const things = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `t${i + 1}`, n: i + 1 }));

  it('reports the walk ceiling as min(MAX_SPILLOVER_ROWS, pageSize × MAX_SPILLOVER_PAGES)', () => {
    expect(spillWalkCeiling()).toBe(Math.min(MAX_SPILLOVER_ROWS, 10 * MAX_SPILLOVER_PAGES));
    expect(spillWalkCeiling()).toBe(500);
  });

  it('registers no dataframe when the filter keeps zero rows of a multi-page walk', async () => {
    serve(things(25));
    const result = await run(5, () => false);
    // First page (pageSize 5) plus the re-walk from page 0 at pageSize 10: pages 0, 1, 2.
    expect(fetcher.mock.calls.length).toBe(4);
    expect(result.fullRows).toEqual([]);
    expect(result.dataframe).toBeUndefined();
    expect(result.rowsScanned).toBe(25);
  });

  it('registers only the kept rows and counts every scanned row', async () => {
    serve(things(25));
    const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
    const result = await run(5, (row) => (row.n as number) % 3 === 0);
    expect(result.fullRows.map((r) => r.id)).toEqual([
      't3',
      't6',
      't9',
      't12',
      't15',
      't18',
      't21',
      't24',
    ]);
    expect(result.results).toHaveLength(5);
    expect(result.dataframe?.rowCount).toBe(8);
    expect(result.dataframe?.totalCount).toBe(25);
    expect((register.mock.calls[0]![1].rows as unknown[]).length).toBe(8);
    expect(result.rowsScanned).toBe(25);
    vi.restoreAllMocks();
  });

  it('stages nothing when every kept row of a walk fits inline', async () => {
    serve(things(25));
    const result = await run(5, (row) => (row.n as number) % 7 === 0);
    expect(result.results.map((r) => r.id)).toEqual(['t7', 't14', 't21']);
    expect(result.rowsScanned).toBe(25);
    expect(result.hasMore).toBe(false);
    expect(result.dataframe).toBeUndefined();
  });

  it('stops at the walk ceiling and reports the bounded scan, with no dataframe for zero matches', async () => {
    serve(things(600));
    const result = await run(5, (row) => row.n === 599);
    // First page + 50 walk pages; row 599 sits past the 500-row ceiling and is never scanned.
    expect(fetcher.mock.calls.length).toBe(1 + MAX_SPILLOVER_PAGES);
    expect(result.rowsScanned).toBe(500);
    expect(result.fullRows).toEqual([]);
    expect(result.dataframe).toBeUndefined();
  });

  it('keeps a truncated dataframe when the bounded walk matches rows', async () => {
    serve(things(600));
    const result = await run(5, (row) => (row.n as number) > 490);
    expect(result.rowsScanned).toBe(500);
    expect(result.fullRows).toHaveLength(10);
    expect(result.dataframe?.truncated).toBe(true);
    expect(result.dataframe?.totalCount).toBe(600);
  });

  it('counts first-page rows as scanned when no spill runs', async () => {
    serve(things(4));
    const result = await run(10, (row) => row.n === 2);
    expect(fetcher.mock.calls.length).toBe(1);
    expect(result.rowsScanned).toBe(4);
    expect(result.fullRows.map((r) => r.id)).toEqual(['t2']);
    expect(result.dataframe).toBeUndefined();
  });

  it('stages the rows a failed walk already fetched, marked truncated', async () => {
    serve(things(25), { failWhen: (page) => page >= 1 });
    const warnings: string[] = [];
    const result = await run(5, () => true, warnings);
    // First page (5) + walk page 0 (10 rows) + the failed walk page 1.
    expect(fetcher.mock.calls.length).toBe(3);
    expect(result.rowsScanned).toBe(10);
    expect(result.fullRows.map((r) => r.id)).toEqual(things(10).map((r) => r.id));
    expect(result.dataframe).toMatchObject({ rowCount: 10, truncated: true, totalCount: 25 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/stopped after 10 of 25 upstream row\(s\)/);
  });

  it('says no dataframe was staged when a failed walk kept no filtered row', async () => {
    serve(things(25), { failWhen: (page) => page >= 1 });
    const warnings: string[] = [];
    const result = await run(5, () => false, warnings);
    expect(result.dataframe).toBeUndefined();
    expect(result.hasMore).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('No dataframe was staged: no fetched row matched');
    expect(warnings[0]).not.toContain('The dataframe holds');
  });

  it('keeps the in-memory first page when the walk fails before passing it', async () => {
    serve(things(25), { failWhen: (_page, pageSize) => pageSize === 10 });
    const warnings: string[] = [];
    const result = await run(5, undefined, warnings);
    expect(fetcher.mock.calls.length).toBe(2);
    expect(result.fullRows.map((r) => r.id)).toEqual(['t1', 't2', 't3', 't4', 't5']);
    // Every kept row is inline, so nothing is staged; the warning says so.
    expect(result.results).toHaveLength(5);
    expect(result.hasMore).toBe(true);
    expect(result.dataframe).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/stopped after 5 of 25 upstream row\(s\): page 0 failed/);
    expect(warnings[0]).toContain('results[] holds every row fetched');
  });

  describe('inline budget staging (#66)', () => {
    /** `n` rows whose JSON each serializes to exactly `bytes` bytes. */
    const wide = (n: number, bytes: number) =>
      Array.from({ length: n }, (_, i) => {
        const id = `t${i + 1}`;
        return { id, pad: 'x'.repeat(bytes - JSON.stringify({ id, pad: '' }).length) };
      });

    it('stages the in-memory page, with no extra request, when the budget trims a result inside loadLimit', async () => {
      serve(wide(8, 5_000));
      const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
      const result = await run(10);
      expect(fetcher.mock.calls.length).toBe(1);
      // 2 + 4 × 5,000 + 3 commas = 20,005 bytes; a fifth row would reach 25,006.
      expect(result.results.map((r) => r.id)).toEqual(['t1', 't2', 't3', 't4']);
      expect(result.inlineBound).toBe('budget');
      expect(result.hasMore).toBe(true);
      expect(result.dataframe).toMatchObject({ rowCount: 8, totalCount: 8 });
      expect(result.dataframe?.truncated).toBeUndefined();
      const staged = register.mock.calls[0]![1].rows as Record<string, unknown>[];
      expect(staged).toHaveLength(8);
      expect(new Set(staged.map((r) => r.id)).size).toBe(8);
    });

    it('stages nothing and sets no bound when the result fits both bounds', async () => {
      serve(wide(3, 1_000));
      const result = await run(10);
      expect(result.results).toHaveLength(3);
      expect(result.inlineBound).toBeUndefined();
      expect(result.hasMore).toBe(false);
      expect(result.dataframe).toBeUndefined();
    });

    it('names the budget when it binds below loadLimit on a walked result', async () => {
      serve(wide(25, 5_000));
      const result = await run(10);
      expect(result.results).toHaveLength(4);
      expect(result.inlineBound).toBe('budget');
      expect(result.dataframe).toMatchObject({ rowCount: 25 });
    });

    it('names loadLimit when it binds before the budget', async () => {
      serve(things(25));
      const result = await run(5);
      expect(result.results.map((r) => r.id)).toEqual(['t1', 't2', 't3', 't4', 't5']);
      expect(result.inlineBound).toBe('loadLimit');
      expect(result.hasMore).toBe(true);
    });

    it('reports hasMore for an unscanned remainder even when every match is inline', async () => {
      serve(things(600));
      const result = await run(5, (row) => row.n === 7);
      expect(result.results.map((r) => r.id)).toEqual(['t7']);
      expect(result.inlineBound).toBeUndefined();
      expect(result.rowsScanned).toBe(500);
      expect(result.hasMore).toBe(true);
    });

    it('returns the empty set with no bound and no dataframe', async () => {
      serve([]);
      const result = await run(10);
      expect(result.results).toEqual([]);
      expect(result.inlineBound).toBeUndefined();
      expect(result.hasMore).toBe(false);
      expect(result.dataframe).toBeUndefined();
    });

    describe('inlineView', () => {
      const idsOf = (rows: Record<string, unknown>[]) => rows.map((r) => r.id);
      const reversed = (rows: Record<string, unknown>[]) => [...rows].reverse();

      afterEach(() => {
        vi.restoreAllMocks();
      });

      it('measures the projected rows, staging nothing when the projection fits', async () => {
        serve(wide(8, 5_000));
        const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
        const result = await run(10, undefined, undefined, (rows) =>
          rows.map((r) => ({ id: r.id })),
        );
        expect(fetcher.mock.calls.length).toBe(1);
        expect(result.results).toEqual(things(8).map((r) => ({ id: r.id })));
        expect(result.inlineBound).toBeUndefined();
        expect(result.hasMore).toBe(false);
        expect(result.dataframe).toBeUndefined();
        expect(register).not.toHaveBeenCalled();
      });

      it('cuts results[] from the reordered rows and stages the unprojected set', async () => {
        serve(wide(8, 5_000));
        const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
        const result = await run(10, undefined, undefined, reversed);
        expect(idsOf(result.results)).toEqual(['t8', 't7', 't6', 't5']);
        expect(result.inlineBound).toBe('budget');
        expect(result.hasMore).toBe(true);
        expect(idsOf(result.fullRows)).toEqual(idsOf(wide(8, 5_000)));
        const staged = register.mock.calls[0]![1].rows as Record<string, unknown>[];
        expect(idsOf(staged)).toEqual(idsOf(wide(8, 5_000)));
        expect(staged.every((r) => typeof r.pad === 'string' && r.pad.length > 0)).toBe(true);
      });

      it('applies to every walked row, not the first page alone', async () => {
        serve(things(25));
        const result = await run(5, undefined, undefined, reversed);
        expect(idsOf(result.results)).toEqual(['t25', 't24', 't23', 't22', 't21']);
        expect(result.inlineBound).toBe('loadLimit');
        expect(result.dataframe).toMatchObject({ rowCount: 25 });
      });
    });
  });

  describe('walk termination (#75)', () => {
    const distinctIds = (rows: Record<string, unknown>[]) => new Set(rows.map((r) => r.id)).size;

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('walks an honest server to its last short page with no extra request', async () => {
      serve(things(25));
      const result = await run(10);
      // First page reused (loadLimit === pageSize), then walk pages 1 and 2.
      expect(fetcher.mock.calls.length).toBe(3);
      expect(result.fullRows).toHaveLength(25);
      expect(result.dataframe).toMatchObject({ rowCount: 25, totalCount: 25 });
      expect(result.dataframe?.truncated).toBeUndefined();
    });

    it('keeps walking past a full page served under the upstream pageSize cap', async () => {
      serve(things(20), { maxPageSize: 5 });
      const result = await run(5);
      expect(result.fullRows).toHaveLength(20);
      expect(distinctIds(result.fullRows)).toBe(20);
      expect(result.dataframe).toMatchObject({ rowCount: 20, totalCount: 20 });
      expect(result.dataframe?.truncated).toBeUndefined();
    });

    it('walks a capped upstream whose total fits loadLimit, returning every row inline and staging nothing', async () => {
      serve(things(8), { maxPageSize: 5 });
      const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
      const result = await run(10);
      // First page (5 of 8, reused as walk page 0) + walk page 1 (the last 3).
      expect(fetcher.mock.calls.length).toBe(2);
      expect(result.fullRows.map((r) => r.id)).toEqual(things(8).map((r) => r.id));
      expect(result.results.map((r) => r.id)).toEqual(things(8).map((r) => r.id));
      expect(result.hasMore).toBe(false);
      expect(result.dataframe).toBeUndefined();
      expect(register).not.toHaveBeenCalled();
    });

    it('stages nothing when a capped walk under a large loadLimit fits inline', async () => {
      serve(things(20), { maxPageSize: 5 });
      const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
      const result = await run(1_000);
      expect(result.results).toHaveLength(20);
      expect(distinctIds(result.results)).toBe(20);
      expect(result.inlineBound).toBeUndefined();
      expect(result.hasMore).toBe(false);
      expect(result.dataframe).toBeUndefined();
      expect(register).not.toHaveBeenCalled();
    });

    it('marks the dataframe truncated, with a warning, when an empty page ends the walk short of totalCount', async () => {
      serve(things(25), { reportedTotal: 30 });
      const warnings: string[] = [];
      const result = await run(5, undefined, warnings);
      expect(result.fullRows).toHaveLength(25);
      expect(result.dataframe).toMatchObject({ rowCount: 25, truncated: true, totalCount: 30 });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(
        /stopped after 25 of 30 upstream row\(s\): page 3 came back empty/,
      );
    });

    it('warns, with no dataframe, when an overstated total leaves every served row inline', async () => {
      serve(things(25), { reportedTotal: 30 });
      const warnings: string[] = [];
      const result = await run(1_000, undefined, warnings);
      expect(result.results).toHaveLength(25);
      expect(result.dataframe).toBeUndefined();
      expect(result.hasMore).toBe(true);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/stopped after 25 of 30 upstream row\(s\)/);
      expect(warnings[0]).toContain('results[] holds every row fetched');
      expect(warnings[0]).not.toContain('The dataframe holds');
    });

    it('warns when the page cap ends the walk', async () => {
      serve(things(600));
      const warnings: string[] = [];
      const result = await run(5, undefined, warnings);
      expect(fetcher.mock.calls.length).toBe(1 + MAX_SPILLOVER_PAGES);
      expect(result.dataframe).toMatchObject({ rowCount: 500, truncated: true, totalCount: 600 });
      expect(result.dataframe?.maxRows).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(
        new RegExp(
          `stopped after 500 of 600 upstream row\\(s\\): the ${MAX_SPILLOVER_PAGES}-page walk cap was reached`,
        ),
      );
    });

    it('warns when the row cap ends the walk', async () => {
      resetTestServices();
      fetcher = initTestServices({ ...TEST_CONFIG, pageSize: 5_000 });
      serve(things(MAX_SPILLOVER_ROWS + 5_000));
      const warnings: string[] = [];
      const result = await run(5_000, undefined, warnings);
      expect(result.dataframe).toMatchObject({
        rowCount: MAX_SPILLOVER_ROWS,
        truncated: true,
        maxRows: MAX_SPILLOVER_ROWS,
      });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(
        `the ${MAX_SPILLOVER_ROWS.toLocaleString('en-US')}-row dataframe cap was reached`,
      );
    });

    it('stops on a page that repeats the previous one and marks the dataframe truncated', async () => {
      serve(things(30), { ignorePage: true });
      const result = await run(5);
      // First page + walk page 0 + walk page 1 (a repeat of page 0).
      expect(fetcher.mock.calls.length).toBe(3);
      expect(result.fullRows).toHaveLength(10);
      expect(distinctIds(result.fullRows)).toBe(10);
      expect(result.dataframe).toMatchObject({ rowCount: 10, truncated: true });
    });

    it('rejects instead of staging a partial set when the caller cancels mid-walk', async () => {
      const controller = new AbortController();
      serve(things(50));
      const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
      const pending = spillWith(
        createMockContext({ tenantId: 't1', signal: controller.signal }),
        5,
        {
          warnings: [],
          // Cancel between walk pages: after page 1's rows arrive, before page 2 is requested.
          normalizeRow: (row) => {
            if (row.id === 't11') controller.abort();
            return row;
          },
        },
      );
      await expect(pending).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      expect(register).not.toHaveBeenCalled();
    });

    it('stops at the walk deadline and stages what it fetched, marked truncated', async () => {
      const clock = fakeClock();
      serve(things(100));
      const walkTimeouts = chargeWalkPages(clock, SPILL_WALK_DEADLINE_MS * 0.4);
      const warnings: string[] = [];
      const result = await run(5, undefined, warnings);
      // Walk pages 0, 1, 2 start at 0 %, 40 %, 80 % of the budget; page 3 would start past it.
      expect(walkTimeouts).toHaveLength(3);
      expect(walkTimeouts[2]).toBeLessThanOrEqual(SPILL_WALK_DEADLINE_MS * 0.2);
      expect(result.fullRows).toHaveLength(30);
      expect(result.dataframe).toMatchObject({ rowCount: 30, truncated: true, totalCount: 100 });
      expect(warnings.join('\n')).toMatch(/time budget/);
    });

    it('stops at the call deadline when it ends before the walk budget', async () => {
      const clock = fakeClock();
      serve(things(100));
      const walkTimeouts = chargeWalkPages(clock, SPILL_WALK_DEADLINE_MS * 0.4);
      // 20 s of the call deadline left when the walk starts — half the walk budget.
      const ctx = {
        ...createMockContext({ tenantId: 't1' }),
        timestamp: new Date(
          clock.now - (CALL_DEADLINE_MS - SPILL_WALK_DEADLINE_MS / 2),
        ).toISOString(),
      };
      const warnings: string[] = [];
      const result = await spillWith(ctx, 5, { warnings });
      // Walk pages 0 and 1 start with 20 s and 4 s of the call deadline left; page 2 would start past it.
      expect(walkTimeouts).toHaveLength(2);
      expect(result.fullRows).toHaveLength(20);
      expect(result.dataframe).toMatchObject({ rowCount: 20, truncated: true, totalCount: 100 });
      const text = warnings.join('\n');
      expect(text).toMatch(/this call's 50 s deadline for upstream requests ran out before page 2/);
      expect(text).not.toMatch(/page 2 failed/);
    });

    it('holds a POST /search walk to the same deadline', async () => {
      const clock = fakeClock();
      const rows = things(100);
      const walkTimeouts: number[] = [];
      fetcher.mockImplementation(async (url: string, timeoutMs: number, _ctx: unknown, init) => {
        const u = new URL(String(url));
        if (u.hostname !== 'brapi.example.org' || u.pathname !== '/brapi/v2/search/things') {
          throw new Error(`unmocked fetch: ${u.href}`);
        }
        const { page = 0, pageSize } = JSON.parse(String((init as RequestInit).body)) as {
          page?: number;
          pageSize: number;
        };
        if (pageSize === 10) {
          walkTimeouts.push(timeoutMs);
          clock.now += SPILL_WALK_DEADLINE_MS * 0.4;
        }
        return jsonResponse(
          envelope(
            { data: rows.slice(page * pageSize, page * pageSize + pageSize) },
            { totalCount: rows.length },
          ),
        );
      });
      const warnings: string[] = [];
      const result = await spillWith(createMockContext({ tenantId: 't1' }), 5, {
        route: SEARCH_ROUTE,
        warnings,
      });
      expect(walkTimeouts).toHaveLength(3);
      expect(walkTimeouts[2]).toBeLessThanOrEqual(SPILL_WALK_DEADLINE_MS * 0.2);
      expect(result.dataframe).toMatchObject({ rowCount: 30, truncated: true });
      expect(warnings.join('\n')).toMatch(/time budget/);
    });

    it('labels an async poll the walk budget cut short as a budget stop', async () => {
      resetTestServices();
      fetcher = initTestServices({ ...TEST_CONFIG, searchPollTimeoutMs: 60_000 });
      const clock = fakeClock();
      const rows = things(100);
      let polls = 0;
      fetcher.mockImplementation(async (url: string, _timeoutMs: number, _ctx: unknown, init) => {
        const u = new URL(String(url));
        if (
          u.hostname !== 'brapi.example.org' ||
          !u.pathname.startsWith('/brapi/v2/search/things')
        ) {
          throw new Error(`unmocked fetch: ${u.href}`);
        }
        if (u.pathname !== '/brapi/v2/search/things') {
          // Poll of an async page: never completes; each poll costs 5 s.
          polls += 1;
          clock.now += 5_000;
          return new Response('', { status: 202 });
        }
        const { page = 0, pageSize } = JSON.parse(String((init as RequestInit).body)) as {
          page?: number;
          pageSize: number;
        };
        if (page >= 1) return jsonResponse(envelope({ searchResultsDbId: `sr${page}` }));
        return jsonResponse(
          envelope({ data: rows.slice(0, pageSize) }, { totalCount: rows.length }),
        );
      });
      const warnings: string[] = [];
      const result = await spillWith(createMockContext({ tenantId: 't1' }), 5, {
        route: SEARCH_ROUTE,
        warnings,
      });
      expect(polls).toBeGreaterThan(1);
      expect(result.dataframe).toMatchObject({ rowCount: 10, truncated: true, totalCount: 100 });
      const text = warnings.join('\n');
      expect(text).toMatch(/dataframe walk time budget ran out during page 1/);
      expect(text).not.toMatch(/page 1 failed/);
    });
  });

  describe('upstream totals the first page does not settle', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('walks a full first page with no totalCount to the short last page', async () => {
      serve(things(25), { omitTotal: true });
      const warnings: string[] = [];
      const result = await run(10, undefined, warnings);
      // First page reused as walk page 0, then pages 1 and 2 (5 rows, short: the end).
      expect(fetcher.mock.calls.length).toBe(3);
      expect(result.fullRows.map((r) => r.id)).toEqual(things(25).map((r) => r.id));
      expect(result.rowsScanned).toBe(25);
      expect(result.scanComplete).toBe(true);
      expect(result.hasMore).toBe(true);
      expect(result.dataframe).toMatchObject({ rowCount: 25 });
      expect(result.dataframe?.truncated).toBeUndefined();
      expect(result.dataframe?.totalCount).toBeUndefined();
      expect(warnings).toEqual([]);
    });

    it('ends a no-total walk on an empty page when the rows fill every page', async () => {
      serve(things(20), { omitTotal: true });
      const result = await run(10);
      expect(fetcher.mock.calls.length).toBe(3);
      expect(result.fullRows).toHaveLength(20);
      expect(result.scanComplete).toBe(true);
      expect(result.dataframe?.truncated).toBeUndefined();
    });

    it('walks a no-total upstream that caps pageSize and reports the size it served', async () => {
      serve(things(23), { omitTotal: true, maxPageSize: 5, reportPageSize: true });
      const result = await run(1_000);
      expect(result.fullRows.map((r) => r.id)).toEqual(things(23).map((r) => r.id));
      expect(result.scanComplete).toBe(true);
      expect(result.hasMore).toBe(false);
      expect(result.dataframe).toBeUndefined();
    });

    it('treats a short first page with no totalCount as the whole set', async () => {
      serve(things(4), { omitTotal: true });
      const result = await run(10);
      expect(fetcher.mock.calls.length).toBe(1);
      expect(result.fullRows).toHaveLength(4);
      expect(result.scanComplete).toBe(true);
      expect(result.hasMore).toBe(false);
      expect(result.dataframe).toBeUndefined();
    });

    it('marks a no-total walk the page cap stopped as truncated, with a warning', async () => {
      serve(things(600), { omitTotal: true });
      const warnings: string[] = [];
      const result = await run(5, undefined, warnings);
      expect(result.rowsScanned).toBe(500);
      expect(result.scanComplete).toBe(false);
      expect(result.hasMore).toBe(true);
      expect(result.dataframe).toMatchObject({ rowCount: 500, truncated: true });
      expect(result.dataframe?.totalCount).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(
        /stopped after 500 upstream row\(s\) \(the upstream reported no total\): the 50-page walk cap was reached/,
      );
    });

    it('marks a dataframe truncated against the upstream total when the caller skips the walk', async () => {
      const wideRows = Array.from({ length: 8 }, (_, i) => ({
        id: `t${i + 1}`,
        pad: 'x'.repeat(4_990),
      }));
      serve(wideRows, { reportedTotal: 6_000 });
      const result = await spillWith(createMockContext({ tenantId: 't1' }), 10, {
        skipWalk: true,
        warnings: [],
      });
      expect(fetcher.mock.calls.length).toBe(1);
      expect(result.results).toHaveLength(4);
      expect(result.scanComplete).toBe(false);
      expect(result.hasMore).toBe(true);
      expect(result.dataframe).toMatchObject({ rowCount: 8, truncated: true, totalCount: 6_000 });
    });
  });
});

describe('requireRegisteredConnection — first-use registration (#59)', () => {
  const ENV_HOST = new URL(BASE_URL).hostname;
  const DEMO_URL = 'https://breedbase.org/brapi/v2';
  /** Env vars these tests set; blanked per test so a developer environment never leaks in. */
  const BLANKED_ENV = [
    'BRAPI_DEFAULT_BASE_URL',
    'BRAPI_DEFAULT_USERNAME',
    'BRAPI_DEFAULT_PASSWORD',
    'BRAPI_DEFAULT_BEARER_TOKEN',
    'BRAPI_DEFAULT_API_KEY',
    'BRAPI_BUILTIN_ALIASES_DISABLED',
    'BRAPI_BTI_BREEDBASE_DEMO_BASE_URL',
    'BRAPI_BTI_BREEDBASE_DEMO_BEARER_TOKEN',
    'BRAPI_TYPO_ALIAS_BASE_URL',
    'BRAPI_OPS_BASE_URL',
    'BRAPI_OPS_USERNAME',
    'BRAPI_OPS_PASSWORD',
  ];
  const SERVERINFO = { serverName: 'X', calls: [{ service: 'studies', methods: ['GET'] }] };

  let fetcher: MockFetcher;
  let tokenFetch: ReturnType<typeof vi.fn>;
  /** `host/path` of every BrAPI request, in order. */
  let hits: string[];
  /** Per-path overrides for the BrAPI fake; anything else answers a one-service server. */
  let overrides: Record<string, (init?: RequestInit) => Promise<Response> | Response>;

  beforeEach(() => {
    fetcher = initTestServices({ ...TEST_CONFIG, allowPrivateIps: true, sessionIsolation: true });
    for (const key of BLANKED_ENV) vi.stubEnv(key, '');
    hits = [];
    overrides = {};
    fetcher.mockImplementation(
      async (url: string, _timeoutMs: number, _ctx: unknown, init?: RequestInit) => {
        const { hostname, pathname } = new URL(String(url));
        if (hostname !== ENV_HOST && hostname !== new URL(DEMO_URL).hostname) {
          throw new Error(`Unmocked fetcher call: ${url}`);
        }
        hits.push(`${hostname}${pathname}`);
        const leaf = pathname.slice(pathname.lastIndexOf('/'));
        const override = overrides[leaf];
        if (override) return override(init);
        if (leaf === '/serverinfo') return jsonResponse(envelope(SERVERINFO));
        if (leaf === '/commoncropnames') return jsonResponse(envelope({ data: [] }));
        throw new Error(`Unexpected path: ${url}`);
      },
    );
    tokenFetch = vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(`Unmocked global fetch: ${String(input)}`);
    });
    vi.stubGlobal('fetch', tokenFetch);
  });

  afterEach(() => {
    resetTestServices();
    vi.unstubAllGlobals();
  });

  function contextFor(options: { sessionId?: string; signal?: AbortSignal } = {}) {
    return createMockContext({ tenantId: 't1', errors: brapiFindStudies.errors, ...options });
  }

  /** Answer `/token` on the env host with `status` and `body`. */
  function serveToken(status: number, body: unknown): void {
    tokenFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.hostname !== ENV_HOST || url.pathname !== '/brapi/v2/token') {
        throw new Error(`Unmocked global fetch: ${url.href}`);
      }
      return jsonResponse(body, status);
    });
  }

  function configureSgnAlias(): void {
    vi.stubEnv('BRAPI_OPS_BASE_URL', BASE_URL);
    vi.stubEnv('BRAPI_OPS_USERNAME', 'envuser');
    vi.stubEnv('BRAPI_OPS_PASSWORD', 'envpass');
  }

  const serverinfoHits = () => hits.filter((h) => h.endsWith('/serverinfo')).length;

  it.each([
    [
      'an alias with no URL of its own, even with BRAPI_DEFAULT_* set',
      { BRAPI_DEFAULT_BASE_URL: BASE_URL, BRAPI_DEFAULT_BEARER_TOKEN: 'default-tok' },
      'typo-alias',
    ],
    [
      'a disabled built-in',
      { BRAPI_BUILTIN_ALIASES_DISABLED: 'bti-breedbase-demo' },
      'bti-breedbase-demo',
    ],
    ['`default` when no default server is configured', {}, undefined],
  ])('fails unknown_alias, with no request, for %s', async (_label, env, alias) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const ctx = contextFor();
    const expectedAlias = alias ?? 'default';

    await expect(requireRegisteredConnection(ctx, alias)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'unknown_alias', alias: expectedAlias },
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(tokenFetch).not.toHaveBeenCalled();
    expect(await ctx.state.get(`brapi/conn/${expectedAlias}`)).toBeNull();
  });

  it('registers `default` from the configured default server on first use, then reuses it', async () => {
    vi.stubEnv('BRAPI_DEFAULT_BASE_URL', BASE_URL);
    const ctx = contextFor();

    const first = await requireRegisteredConnection(ctx, undefined);
    expect(first).toMatchObject({ alias: 'default', baseUrl: BASE_URL, authMode: 'none' });
    expect(await ctx.state.get('brapi/conn/default')).toEqual(first);
    expect(hits).toEqual([
      `${ENV_HOST}/brapi/v2/serverinfo`,
      `${ENV_HOST}/brapi/v2/commoncropnames`,
    ]);

    const second = await requireRegisteredConnection(ctx, undefined);
    expect(second).toEqual(first);
    expect(hits).toHaveLength(2);
  });

  it('registers a built-in by every spelling of its env prefix, with that prefix’s credentials', async () => {
    vi.stubEnv('BRAPI_BTI_BREEDBASE_DEMO_BEARER_TOKEN', 'demo-tok');
    const ctx = contextFor();

    const hyphenated = await requireRegisteredConnection(ctx, 'bti-breedbase-demo');
    const underscored = await requireRegisteredConnection(ctx, 'BTI_BREEDBASE_DEMO');

    for (const connection of [hyphenated, underscored]) {
      expect(connection).toMatchObject({
        baseUrl: DEMO_URL,
        authMode: 'bearer',
        resolvedAuth: { headerName: 'Authorization', headerValue: 'Bearer demo-tok' },
      });
    }
    expect(await ctx.state.get('brapi/conn/BTI_BREEDBASE_DEMO')).toEqual(underscored);
    // The second spelling reuses the cached profile: one discovery for the URL.
    expect(serverinfoHits()).toBe(1);
  });

  it('saves where brapi_connect saves: per session under isolation, shared without a session', async () => {
    vi.stubEnv('BRAPI_DEFAULT_BASE_URL', BASE_URL);
    const keys = async (ctx: ReturnType<typeof contextFor>) =>
      (await ctx.state.list('brapi/conn/')).items.map((item) => item.key);

    const sessionCtx = contextFor({ sessionId: 's-a' });
    await requireRegisteredConnection(sessionCtx, undefined);
    const connectCtx = contextFor({ sessionId: 's-a' });
    await brapiConnect.handler(brapiConnect.input.parse({}), connectCtx);
    expect(await keys(sessionCtx)).toEqual(['brapi/conn/sess/s-a/default']);
    expect(await keys(sessionCtx)).toEqual(await keys(connectCtx));

    const sharedCtx = contextFor();
    await requireRegisteredConnection(sharedCtx, undefined);
    expect(await keys(sharedCtx)).toEqual(['brapi/conn/default']);

    // Another session in the same tenant and state does not see the first one's entry.
    const otherSession = { ...contextFor({ sessionId: 's-b' }), state: sessionCtx.state };
    const hitsBefore = hits.length;
    await requireRegisteredConnection(otherSession, undefined);
    expect(await sessionCtx.state.get('brapi/conn/sess/s-b/default')).not.toBeNull();
    expect(hits.length).toBe(hitsBefore); // cached profile, new registration
  });

  it('a failed token exchange registers nothing and surfaces auth_token_exchange_failed', async () => {
    configureSgnAlias();
    serveToken(500, { error: 'boom' });
    const ctx = contextFor();

    await expect(requireRegisteredConnection(ctx, 'ops')).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: { reason: 'auth_token_exchange_failed' },
    });
    expect(tokenFetch).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await ctx.state.get('brapi/conn/ops')).toBeNull();

    // Nothing was poisoned: once the token endpoint works, the next call connects.
    serveToken(200, { access_token: 'sgn-tok' });
    await expect(requireRegisteredConnection(ctx, 'ops')).resolves.toMatchObject({
      authMode: 'sgn',
      resolvedAuth: { headerValue: 'Bearer sgn-tok' },
    });
  });

  it('a token endpoint without an access token registers nothing and surfaces auth_no_access_token', async () => {
    configureSgnAlias();
    serveToken(200, { token_type: 'Bearer' });
    const ctx = contextFor();

    await expect(requireRegisteredConnection(ctx, 'ops')).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: { reason: 'auth_no_access_token' },
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await ctx.state.get('brapi/conn/ops')).toBeNull();
  });

  it('a token endpoint that never answers registers nothing and fails as a retryable Timeout', async () => {
    configureSgnAlias();
    tokenFetch.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          const url = new URL(String(input instanceof Request ? input.url : input));
          if (url.hostname !== ENV_HOST) reject(new Error(`Unmocked global fetch: ${url.href}`));
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const ctx = contextFor();

    const err = await requireRegisteredConnection(ctx, 'ops').catch((e: unknown) => e as McpError);
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { retryable: true, recovery: { hint: expect.stringContaining('not answering') } },
    });
    expect(err.data?.reason).toBeUndefined();
    expect(tokenFetch).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await ctx.state.get('brapi/conn/ops')).toBeNull();
  });

  it('a configured base URL that is not a URL fails alias_base_url_invalid naming its variable, with no request', async () => {
    vi.stubEnv('BRAPI_OPS_BASE_URL', 'notaurl');
    const ctx = contextFor();

    await expect(requireRegisteredConnection(ctx, 'ops')).rejects.toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      data: {
        reason: 'alias_base_url_invalid',
        envVar: 'BRAPI_OPS_BASE_URL',
        recovery: { hint: expect.stringContaining('BRAPI_OPS_BASE_URL') },
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(tokenFetch).not.toHaveBeenCalled();
    expect(await ctx.state.get('brapi/conn/ops')).toBeNull();
  });

  it('a configured base URL on a private address fails private_address_blocked, registering and caching nothing', async () => {
    const PRIVATE_URL = 'http://10.20.30.40/brapi/v2';
    vi.stubEnv('BRAPI_DEFAULT_BASE_URL', PRIVATE_URL);
    // The real fetch guard, with private addresses not allowed.
    const guarded = initTestServices({ ...TEST_CONFIG, allowPrivateIps: false });
    guarded.mockImplementation(
      (url: string, timeoutMs: number, ctx: Context, init?: FetchWithTimeoutOptions) =>
        fetchWithTimeout(url, timeoutMs, ctx, init),
    );
    const ctx = contextFor();

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(requireRegisteredConnection(ctx, undefined)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'private_address_blocked', baseUrl: PRIVATE_URL },
      });
    }
    expect(tokenFetch).not.toHaveBeenCalled();
    expect(await ctx.state.get('brapi/conn/default')).toBeNull();
    expect((await ctx.state.list('brapi/capability/')).items).toEqual([]);
  });

  it('a transient discovery failure registers nothing and surfaces capability_discovery_unavailable', async () => {
    vi.stubEnv('BRAPI_DEFAULT_BASE_URL', BASE_URL);
    const http503 = () => {
      throw serviceUnavailable('Fetch failed. Status: 503', { status: 503 });
    };
    overrides['/serverinfo'] = http503;
    overrides['/calls'] = http503;
    const ctx = contextFor();

    await expect(requireRegisteredConnection(ctx, undefined)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'capability_discovery_unavailable', retryable: true },
    });
    expect(await ctx.state.get('brapi/conn/default')).toBeNull();
  });

  it('concurrent first calls in one scope share one token exchange and one discovery', async () => {
    configureSgnAlias();
    serveToken(200, { access_token: 'sgn-tok' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    overrides['/serverinfo'] = async () => {
      await gate;
      return jsonResponse(envelope(SERVERINFO));
    };
    const ctx = contextFor();
    const sibling = { ...contextFor(), state: ctx.state };

    const first = requireRegisteredConnection(ctx, 'ops');
    const second = requireRegisteredConnection(sibling, 'ops');
    await vi.waitFor(() => expect(serverinfoHits()).toBe(1));
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(b).toBe(a);
    expect(tokenFetch).toHaveBeenCalledTimes(1);
    expect(serverinfoHits()).toBe(1);
    expect(await ctx.state.list('brapi/conn/')).toMatchObject({
      items: [{ key: 'brapi/conn/ops', value: a }],
    });
  });

  it('a caller whose shared run was cancelled by its starter registers on its own run', async () => {
    vi.stubEnv('BRAPI_DEFAULT_BASE_URL', BASE_URL);
    const controller = new AbortController();
    let serverinfoCalls = 0;
    overrides['/serverinfo'] = (init) => {
      serverinfoCalls += 1;
      if (serverinfoCalls > 1) return jsonResponse(envelope(SERVERINFO));
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(requestCancelled('aborted')), {
          once: true,
        });
      });
    };
    overrides['/calls'] = (init) => {
      if (init?.signal?.aborted) throw requestCancelled('aborted');
      return jsonResponse(envelope({ data: [] }));
    };
    overrides['/commoncropnames'] = (init) => {
      if (init?.signal?.aborted) throw requestCancelled('aborted');
      return jsonResponse(envelope({ data: [] }));
    };
    // The mock state store honors its own context's signal, so the shared store is the joiner's.
    const joiner = contextFor();
    const starter = { ...contextFor({ signal: controller.signal }), state: joiner.state };

    const started = requireRegisteredConnection(starter, undefined);
    const joined = requireRegisteredConnection(joiner, undefined);
    await vi.waitFor(() => expect(serverinfoCalls).toBe(1));
    controller.abort();

    await expect(started).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    await expect(joined).resolves.toMatchObject({ alias: 'default', baseUrl: BASE_URL });
    expect(serverinfoCalls).toBe(2);
    const profile = await getCapabilityRegistry().profile(BASE_URL, joiner);
    expect(Object.keys(profile.supported)).toEqual(['studies']);
  });

  it('keeps a registration that landed while a first-use registration was in flight', async () => {
    vi.stubEnv('BRAPI_DEFAULT_BASE_URL', BASE_URL);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    overrides['/serverinfo'] = async () => {
      await gate;
      return jsonResponse(envelope(SERVERINFO));
    };
    const ctx = contextFor();
    const explicit: RegisteredServer = {
      alias: 'default',
      baseUrl: 'https://other.example/brapi/v2',
      authMode: 'none',
      registeredAt: '2026-10-17T00:00:00.000Z',
    };

    const pending = requireRegisteredConnection(ctx, undefined);
    await vi.waitFor(() => expect(serverinfoHits()).toBe(1));
    await getServerRegistry().save(ctx, explicit);
    release();

    await expect(pending).resolves.toEqual(explicit);
    expect(await ctx.state.get('brapi/conn/default')).toEqual(explicit);
  });
});

describe('first-use registration error contracts (#59)', () => {
  const FIRST_USE_REASONS = [
    'auth_token_exchange_failed',
    'auth_no_access_token',
    'capability_discovery_unavailable',
    'upstream_unauthorized',
    'upstream_forbidden',
    'alias_base_url_invalid',
    'private_address_blocked',
  ];
  type ContractEntry = { reason: string; recovery: string; when: string };
  const reasonsOf = (def: { errors?: ReadonlyArray<{ reason: string }> }) =>
    (def.errors ?? []).map((entry) => entry.reason);
  const entryOf = (def: { errors?: ReadonlyArray<ContractEntry> }, reason: string) => {
    const entry = def.errors?.find((e) => e.reason === reason);
    if (!entry) throw new Error(`no '${reason}' entry`);
    return entry;
  };
  /** Every definition that resolves a connection through `requireRegisteredConnection`. */
  const connectionScoped = [
    ...[...readOnlyToolDefinitions, ...writeToolDefinitions].filter(
      (def) => def.name !== 'brapi_connect' && reasonsOf(def).includes('unknown_alias'),
    ),
    brapiServerInfoResource,
    brapiCallsResource,
    brapiStudyResource,
    brapiGermplasmResource,
    brapiVariableResource,
  ];

  it('covers the 19 connection-scoped tools and 5 resources', () => {
    expect(connectionScoped).toHaveLength(24);
  });

  it.each(connectionScoped.map((def) => [def.name, def] as const))(
    '%s declares every reason a first-use registration can raise',
    (_name, def) => {
      expect(reasonsOf(def)).toEqual(expect.arrayContaining(FIRST_USE_REASONS));
    },
  );

  it.each(connectionScoped.map((def) => [def.name, def] as const))(
    '%s points an auth wall at credentials and back at itself',
    (name, def) => {
      const isTool = !name.startsWith('brapi-');
      for (const reason of ['upstream_unauthorized', 'upstream_forbidden']) {
        const { recovery } = entryOf(def, reason);
        expect(recovery).toContain('brapi_connect');
        expect(recovery).toMatch(/server-side credentials/);
        expect(recovery).toContain(isTool ? `retry ${name}` : 'read this resource again');
      }
    },
  );

  it.each([brapiConnect, ...connectionScoped].map((def) => [def.name, def] as const))(
    '%s describes capability_discovery_unavailable as the registry raises it, 429 included',
    (_name, def) => {
      const { when } = entryOf(def, 'capability_discovery_unavailable');
      expect(when).toContain('timed out, was unreachable, or answered 429 or a 5xx other than 501');
      expect(when).toContain('at least one of them');
    },
  );

  it.each([brapiConnect, ...connectionScoped].map((def) => [def.name, def] as const))(
    '%s says alias_base_url_invalid also covers a configured URL that carries credentials',
    (_name, def) => {
      expect(entryOf(def, 'alias_base_url_invalid').when).toContain('carries credentials');
    },
  );
});

describe('stagedDataframeNotice', () => {
  beforeEach(() => {
    initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('names one table, its row count, and both read tools', () => {
    expect(stagedDataframeNotice([handle({ rowCount: 1_427 })])).toBe(
      'Staged dataframe `df_AAAAA_BBBBB` (1427 rows): list its columns with brapi_dataframe_describe, then query it with brapi_dataframe_query (SQL).',
    );
  });

  it('marks a truncated table and points at the warnings for why', () => {
    expect(stagedDataframeNotice([handle({ rowCount: 200, truncated: true })])).toContain(
      '`df_AAAAA_BBBBB` (200 rows, truncated — warnings says why)',
    );
  });

  it('names two tables and appends the join hint', () => {
    expect(
      stagedDataframeNotice(
        [handle({ tableName: 'df_N', rowCount: 1 }), handle({ tableName: 'df_E', rowCount: 3 })],
        { join: 'join A to B' },
      ),
    ).toBe(
      'Staged dataframes `df_N` (1 row) and `df_E` (3 rows): list their columns with brapi_dataframe_describe, then query them with brapi_dataframe_query (SQL) — join A to B.',
    );
  });

  it('names brapi_dataframe_export only where that tool registers (BRAPI_EXPORT_DIR on stdio)', () => {
    const one = [handle()];
    expect(stagedDataframeNotice(one)).not.toContain('brapi_dataframe_export');

    vi.stubEnv('BRAPI_EXPORT_DIR', '/tmp/brapi-exports');
    resetServerConfig();
    expect(stagedDataframeNotice(one)).toMatch(
      /, or write it to a file with brapi_dataframe_export\.$/,
    );

    vi.stubEnv('MCP_TRANSPORT_TYPE', 'http');
    expect(stagedDataframeNotice(one)).not.toContain('brapi_dataframe_export');
  });
});

describe('buildRefinementHint', () => {
  it('selects a maximum-count numeric value rather than the smallest key', () => {
    const hint = buildRefinementHint(
      { fullRows: [], scanComplete: false },
      { season: { '2011': 1, '2018': 3 } },
    );
    expect(hint).toContain('narrowing to `2018` would cut to ~3 row(s)');
  });
  const distributions = {
    observationUnitName: { UG130050: 6, UG130051: 5, UG130052: 4 },
    season: { '2014': 15 },
  };
  const filters = { availableFilters: ['studies', 'germplasm'] };
  const spill = (
    fullRows: number,
    scanComplete: boolean,
    dataframe?: DataframeHandle,
  ): Parameters<typeof buildRefinementHint>[0] => ({
    fullRows: new Array(fullRows),
    scanComplete,
    ...(dataframe ? { dataframe } : {}),
  });

  it('points at a complete dataframe instead of suggesting a narrower re-pull', () => {
    const hint = buildRefinementHint(
      spill(1_427, true, handle({ rowCount: 1_427 })),
      distributions,
      filters,
    );
    expect(hint).toBe(
      'All 1427 matched rows are in dataframe `df_AAAAA_BBBBB`: narrow them there with brapi_dataframe_query rather than re-pulling — the observationUnitName distribution spans 3 values, and `UG130050` covers 6 row(s).',
    );
  });

  it('suggests narrowing server-side when the dataframe is truncated', () => {
    const hint = buildRefinementHint(
      spill(200, false, handle({ rowCount: 200, truncated: true })),
      distributions,
      filters,
    );
    expect(hint).toBe(
      'Dataframe `df_AAAAA_BBBBB` is partial: the scan stopped before the upstream total (see warnings). Narrow the filters — the observationUnitName distribution spans 3 values, and narrowing to `UG130050` would cut to ~6 row(s).',
    );
  });

  it('falls back to the tool filters when no distribution has two values', () => {
    const hint = buildRefinementHint(spill(0, false), { season: {} }, filters);
    expect(hint).toBe(
      'Unscanned upstream rows may still match: the scan stopped before the upstream total (see warnings). Narrow the filters — try `studies`, `germplasm`.',
    );
  });

  it('gives no hint when every matched row is inline and the scan was complete', () => {
    expect(buildRefinementHint(spill(0, true), distributions, filters)).toBeUndefined();
    expect(buildRefinementHint(spill(5, true), distributions, filters)).toBeUndefined();
  });

  it('never suggests raising loadLimit', () => {
    const hints = [
      buildRefinementHint(spill(10, true, handle()), {}, filters),
      buildRefinementHint(spill(10, false, handle({ truncated: true })), {}, filters),
      buildRefinementHint(spill(10, false), {}, {}),
    ];
    expect(hints.every((h) => typeof h === 'string')).toBe(true);
    for (const hint of hints) expect(hint).not.toMatch(/loadLimit/);
  });
});

describe('renderWarningsTrailer', () => {
  it('renders nothing for an absent or empty list', () => {
    expect(renderWarningsTrailer(undefined)).toBe('');
    expect(renderWarningsTrailer([])).toBe('');
  });

  it('renders the bullets under their own heading', () => {
    expect(renderWarningsTrailer(['a', 'b'])).toBe('**Warnings:**\n- a\n- b');
  });
});

describe('renderMoreRowsLine', () => {
  it('says the whole matched set is in a complete dataframe', () => {
    expect(renderMoreRowsLine({ hasMore: true, dataframe: handle({ rowCount: 40 }) })).toBe(
      '⚠ More rows exist beyond results[]: all 40 matched rows are in dataframe `df_AAAAA_BBBBB`.',
    );
  });

  it('never calls a truncated dataframe the full set', () => {
    const line = renderMoreRowsLine({
      hasMore: true,
      dataframe: handle({ rowCount: 200, truncated: true }),
    });
    expect(line).toBe(
      '⚠ More rows exist beyond results[]: dataframe `df_AAAAA_BBBBB` holds the 200 matched row(s) fetched and is truncated — the walk stopped before the upstream total (see warnings).',
    );
    expect(line).not.toMatch(/full set/i);
  });

  it('names the stopped scan when nothing was staged', () => {
    expect(renderMoreRowsLine({ hasMore: true })).toBe(
      '⚠ More rows may exist upstream: the scan stopped before the upstream total (see warnings). Narrow the filters to cover the whole set.',
    );
  });

  it('renders nothing when no rows exist beyond results[]', () => {
    expect(renderMoreRowsLine({ hasMore: false })).toBeUndefined();
  });
});

describe('enrichment surface across tool definitions', () => {
  it.each(ALL_TOOLS.map((def) => [def.name, def] as const))(
    '%s sets no enrichmentTrailer entry with both label and render',
    (_name, def) => {
      const trailer = (def.enrichmentTrailer ?? {}) as Record<
        string,
        { label?: string; render?: unknown }
      >;
      for (const entry of Object.values(trailer)) {
        expect(entry.label !== undefined && entry.render !== undefined).toBe(false);
      }
    },
  );

  const STAGING_TOOLS = [
    'brapi_find_studies',
    'brapi_find_germplasm',
    'brapi_find_observations',
    'brapi_find_variables',
    'brapi_find_images',
    'brapi_find_locations',
    'brapi_find_variants',
    'brapi_find_genotype_calls',
    'brapi_build_phenotype_matrix',
    'brapi_export_genotype_matrix',
    'brapi_walk_pedigree',
    'brapi_raw_get',
    'brapi_raw_search',
  ];

  it.each([
    ...STAGING_TOOLS.filter((n) => n.startsWith('brapi_find_')),
    'brapi_raw_get',
    'brapi_raw_search',
  ])('%s renders warnings under a heading, and nothing when there are none', (name) => {
    const def = ALL_TOOLS.find((d) => d.name === name);
    const render = (
      def?.enrichmentTrailer as { warnings?: { render?: (w: string[]) => string } } | undefined
    )?.warnings?.render;
    expect(render?.([])).toBe('');
    expect(render?.(['dialect dropped x'])).toBe('**Warnings:**\n- dialect dropped x');
  });

  it.each(STAGING_TOOLS)(
    '%s declares the notice enrichment that carries the dataframe pointer and names both dataframe tools',
    (name) => {
      const def = ALL_TOOLS.find((d) => d.name === name);
      expect(def?.enrichment).toHaveProperty('notice');
      expect(def?.description).toContain('brapi_dataframe_describe');
      expect(def?.description).toContain('brapi_dataframe_query');
    },
  );
});

describe('blank ID and filter inputs across tool definitions', () => {
  /** The smallest input each tool accepts, so a rejection is the blank field's alone. */
  const BASE: Record<string, Record<string, unknown>> = {
    brapi_build_phenotype_matrix: { studies: ['s1'] },
    brapi_get_study: { studyDbId: 's1' },
    brapi_get_germplasm: { germplasmDbId: 'g1' },
    brapi_walk_pedigree: { germplasmDbIds: ['g1'] },
    brapi_germplasm_performance: { germplasmDbId: 'g1' },
    brapi_get_image: { imageDbIds: ['i1'] },
    brapi_export_genotype_matrix: { variantSetDbId: 'vs1', format: 'matrix-json' },
    brapi_raw_get: { path: '/samples' },
    brapi_submit_observations: {
      studyDbId: 's1',
      observations: [{ observationUnitDbId: 'u1', observationVariableDbId: 'v1', value: '1' }],
    },
  };

  /** [tool, field path, whether the field is a list of strings]. */
  const FIELDS: [string, string, boolean][] = [
    ...['studies', 'variables', 'germplasm'].map(
      (f) => ['brapi_build_phenotype_matrix', f, true] as [string, string, boolean],
    ),
    ['brapi_find_studies', 'crop', false],
    ...['trialTypes', 'seasons', 'locations', 'programs', 'trials', 'studyNames'].map(
      (f) => ['brapi_find_studies', f, true] as [string, string, boolean],
    ),
    ['brapi_get_study', 'studyDbId', false],
    ...[
      'names',
      'germplasmDbIds',
      'germplasmPUIs',
      'accessionNumbers',
      'crops',
      'synonyms',
      'collections',
    ].map((f) => ['brapi_find_germplasm', f, true] as [string, string, boolean]),
    ['brapi_find_germplasm', 'genus', false],
    ['brapi_find_germplasm', 'species', false],
    ['brapi_find_germplasm', 'text', false],
    ['brapi_get_germplasm', 'germplasmDbId', false],
    ['brapi_walk_pedigree', 'germplasmDbIds', true],
    ['brapi_germplasm_performance', 'germplasmDbId', false],
    ['brapi_germplasm_performance', 'studyDbIds', true],
    ['brapi_germplasm_performance', 'variables', true],
    ...[
      'variables',
      'variableNames',
      'variablePUIs',
      'traitClasses',
      'ontologies',
      'studies',
      'methods',
      'scales',
    ].map((f) => ['brapi_find_variables', f, true] as [string, string, boolean]),
    ['brapi_find_variables', 'crop', false],
    ['brapi_find_variables', 'text', false],
    ...[
      'studies',
      'germplasm',
      'variables',
      'observationUnits',
      'observations',
      'seasons',
      'programs',
      'trials',
      'observationLevels',
    ].map((f) => ['brapi_find_observations', f, true] as [string, string, boolean]),
    ['brapi_find_observations', 'timestampFrom', false],
    ['brapi_find_observations', 'timestampTo', false],
    ...[
      'images',
      'observationUnits',
      'observations',
      'studies',
      'imageFileNames',
      'mimeTypes',
      'descriptiveOntologyTerms',
    ].map((f) => ['brapi_find_images', f, true] as [string, string, boolean]),
    ['brapi_get_image', 'imageDbIds', true],
    ...[
      'locations',
      'locationNames',
      'countryCodes',
      'countryNames',
      'locationTypes',
      'abbreviations',
    ].map((f) => ['brapi_find_locations', f, true] as [string, string, boolean]),
    ...['variantSets', 'variants', 'references'].map(
      (f) => ['brapi_find_variants', f, true] as [string, string, boolean],
    ),
    ['brapi_find_variants', 'referenceName', false],
    ['brapi_find_genotype_calls', 'variantSetDbId', false],
    ...['variantSetDbIds', 'germplasmDbIds', 'callSetDbIds', 'variantDbIds'].map(
      (f) => ['brapi_find_genotype_calls', f, true] as [string, string, boolean],
    ),
    ['brapi_export_genotype_matrix', 'variantSetDbId', false],
    ['brapi_export_genotype_matrix', 'germplasmDbIds', true],
    ['brapi_raw_get', 'path', false],
    ['brapi_submit_observations', 'studyDbId', false],
    ['brapi_submit_observations', 'observations.0.observationDbId', false],
    ['brapi_submit_observations', 'observations.0.observationUnitDbId', false],
    ['brapi_submit_observations', 'observations.0.observationVariableDbId', false],
  ];

  /** `BASE[tool]` with `path` (dotted, numeric segments index arrays) set to `value`. */
  function withField(tool: string, path: string, value: unknown): Record<string, unknown> {
    const input = structuredClone(BASE[tool] ?? {});
    const keys = path.split('.');
    let target: Record<string, unknown> = input;
    for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
    target[keys.at(-1) as string] = value;
    return input;
  }

  function schemaOf(tool: string) {
    const def = ALL_TOOLS.find((d) => d.name === tool);
    if (!def) throw new Error(`no tool ${tool}`);
    return def.input;
  }

  it.each(FIELDS)(
    '%s rejects a whitespace-only %s and accepts a real value',
    (tool, path, list) => {
      const schema = schemaOf(tool);
      const blankInputs = list ? [['   '], ['ok', '\t\n']] : ['   ', '\t'];
      for (const blank of blankInputs) {
        const parsed = schema.safeParse(withField(tool, path, blank));
        expect(parsed.success).toBe(false);
        const issuePath = parsed.error?.issues[0]?.path.join('.');
        expect(issuePath).toBe(list ? `${path}.${(blank as string[]).length - 1}` : path);
      }
      const ok = list ? ['x 1'] : ' x ';
      expect(schema.safeParse(withField(tool, path, ok)).success).toBe(true);
    },
  );

  it.each([
    ['brapi_find_germplasm', 'text'],
    ['brapi_find_variables', 'text'],
  ])('%s keeps an empty %s as "no text filter", as before', (tool, field) => {
    expect(schemaOf(tool).safeParse({ [field]: '' }).success).toBe(true);
  });

  it.each(
    FIELDS.filter(([, path]) => !(path === 'text')).map(([tool, path, list]) => [tool, path, list]),
  )('%s rejects an empty %s', (tool, path, list) => {
    const parsed = schemaOf(tool).safeParse(withField(tool, path, list ? [''] : ''));
    expect(parsed.success).toBe(false);
  });
});
