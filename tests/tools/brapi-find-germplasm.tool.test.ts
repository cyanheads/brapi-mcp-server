/**
 * @fileoverview End-to-end tests for brapi_find_germplasm — filter merge,
 * distribution computation (crop/genus/species), dataframe spillover.
 *
 * @module tests/tools/brapi-find-germplasm.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiFindGermplasm } from '@/mcp-server/tools/definitions/brapi-find-germplasm.tool.js';
import {
  BASE_URL,
  envelope,
  initTestServices,
  jsonResponse,
  type MockFetcher,
  pathnameOf,
  resetTestServices,
} from './_tool-test-helpers.js';

async function connect(fetcher: MockFetcher, serverName = 'Test') {
  fetcher.mockImplementation(async (url: string) => {
    const path = pathnameOf(url);
    if (path.endsWith('/serverinfo')) {
      return jsonResponse(
        envelope({
          serverName,
          calls: [{ service: 'germplasm', methods: ['GET'], versions: ['2.1'] }],
        }),
      );
    }
    if (path.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: [] }));
    return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
  });
  const ctx = createMockContext({ tenantId: 't1' });
  await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
  fetcher.mockReset();
  return ctx;
}

/**
 * Serve a paged /germplasm list, with or without a totalCount, answering 500
 * for walk pages at or past `failFromPage`; any other host fails the call.
 */
function serveGermplasm(
  fetcher: MockFetcher,
  rows: Record<string, unknown>[],
  options: {
    failFromPage?: number;
    omitTotal?: boolean;
    clamp?: number;
    reportedTotal?: number;
  } = {},
): void {
  fetcher.mockImplementation(async (url: string) => {
    const u = new URL(String(url));
    if (u.hostname !== 'brapi.example.org') throw new Error(`unmocked fetch: ${u.href}`);
    const page = Number.parseInt(u.searchParams.get('page') ?? '0', 10);
    if (options.failFromPage !== undefined && page >= options.failFromPage) {
      return jsonResponse({ error: 'upstream down' }, 500);
    }
    const pageSize = Math.min(
      Number.parseInt(u.searchParams.get('pageSize') ?? '10', 10),
      options.clamp ?? Infinity,
    );
    const data = rows.slice(page * pageSize, page * pageSize + pageSize);
    return jsonResponse({
      metadata: {
        pagination: {
          pageSize,
          ...(options.omitTotal ? {} : { totalCount: options.reportedTotal ?? rows.length }),
        },
      },
      result: { data },
    });
  });
}

describe('brapi_find_germplasm tool', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('returns rows and distributions', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      {
        germplasmDbId: 'g1',
        germplasmName: 'TME419',
        commonCropName: 'Cassava',
        genus: 'Manihot',
        species: 'esculenta',
      },
      {
        germplasmDbId: 'g2',
        germplasmName: 'TMS30572',
        commonCropName: 'Cassava',
        genus: 'Manihot',
        species: 'esculenta',
      },
      {
        germplasmDbId: 'g3',
        germplasmName: 'Yam Champion',
        commonCropName: 'Yam',
        genus: 'Dioscorea',
      },
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiFindGermplasm.handler(
      brapiFindGermplasm.input.parse({ crops: ['Cassava', 'Yam'] }),
      ctx,
    );

    expect(getEnrichment(ctx).returnedCount).toBe(3);
    expect(result.distributions.commonCropName).toEqual({ Cassava: 2, Yam: 1 });
    expect(result.distributions.genus).toEqual({ Manihot: 2, Dioscorea: 1 });
    expect(result.distributions.species).toEqual({ esculenta: 2 });
  });

  it('routes names + PUIs + accession numbers to the right filter params', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));

    await brapiFindGermplasm.handler(
      brapiFindGermplasm.input.parse({
        names: ['TME419'],
        germplasmPUIs: ['doi:xyz'],
        accessionNumbers: ['TMe-419'],
        genus: 'Manihot',
      }),
      ctx,
    );
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.getAll('germplasmNames')).toEqual(['TME419']);
    expect(url.searchParams.getAll('germplasmPUIs')).toEqual(['doi:xyz']);
    expect(url.searchParams.getAll('accessionNumbers')).toEqual(['TMe-419']);
    expect(url.searchParams.get('genus')).toBe('Manihot');
  });

  it('spills to a canvas dataframe when totalCount exceeds loadLimit', async () => {
    const ctx = await connect(fetcher);
    serveGermplasm(
      fetcher,
      Array.from({ length: 15 }, (_, i) => ({
        germplasmDbId: `g${i + 1}`,
        germplasmName: `Germ ${i + 1}`,
        commonCropName: 'Cassava',
      })),
    );

    const result = await brapiFindGermplasm.handler(
      brapiFindGermplasm.input.parse({ crops: ['Cassava'], loadLimit: 10 }),
      ctx,
    );

    expect(result.hasMore).toBe(true);
    expect(result.dataframe?.rowCount).toBe(15);
    expect(getEnrichment(ctx).refinementHint).toMatch(
      /^All 15 matched rows are in dataframe `df_[^`]+`: narrow them there with brapi_dataframe_query/,
    );
  });

  it('applies free-text as a client-side post-filter and never sends searchText on the wire', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      { germplasmDbId: 'g1', germplasmName: 'TME419', commonCropName: 'Cassava' },
      { germplasmDbId: 'g2', germplasmName: 'TMS30572', commonCropName: 'Cassava' },
      { germplasmDbId: 'g3', germplasmName: 'IITA-CG-25', commonCropName: 'Cassava' },
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiFindGermplasm.handler(
      brapiFindGermplasm.input.parse({ crops: ['Cassava'], text: 'TME' }),
      ctx,
    );

    expect(getEnrichment(ctx).returnedCount).toBe(1);
    expect(result.results[0]?.germplasmName).toBe('TME419');
    expect(getEnrichment(ctx).totalCount).toBe(3);
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.has('searchText')).toBe(false);
    expect(url.searchParams.has('text')).toBe(false);
    // Distributions reflect the matched set (only the TME419 row passed the text filter).
    expect(result.distributions.commonCropName).toEqual({ Cassava: 1 });
    expect(getEnrichment(ctx).warnings).toContain(
      "Free-text 'TME' matched 1 of 3 row(s) scanned (the full upstream set).",
    );
  });

  it('stops at the first page when free-text misses it and the set exceeds the scan ceiling', async () => {
    const ctx = await connect(fetcher);
    const totalCount = 842_000;
    const firstPageRows = Array.from({ length: 10 }, (_, i) => ({
      germplasmDbId: `g${i + 1}`,
      germplasmName: `RandomAccession${i + 1}`,
      commonCropName: 'Cassava',
    }));

    fetcher.mockImplementation(async () =>
      jsonResponse(envelope({ data: firstPageRows }, { totalCount })),
    );

    const result = await brapiFindGermplasm.handler(
      brapiFindGermplasm.input.parse({ text: 'TMS30572', loadLimit: 10 }),
      ctx,
    );

    // Only one HTTP call — no spillover pulls.
    expect(fetcher.mock.calls.length).toBe(1);
    expect(result.dataframe).toBeUndefined();
    expect(getEnrichment(ctx).returnedCount).toBe(0);
    expect(result.hasMore).toBe(true);
    expect(getEnrichment(ctx).warnings).toContain(
      "Free-text 'TMS30572' matched 0 of the first 10 row(s) scanned out of 842000 upstream; the remaining rows were not scanned. Narrow with server-side filters (crops, genus, species, collections) to bring the set under the 500-row scan ceiling. For an exact name, accession number, or DbId, use names, accessionNumbers, or germplasmDbIds.",
    );
    expect(getEnrichment(ctx).warnings.join('\n')).not.toContain('unlikely to surface hits');
  });

  it('downcasts plural filters to singular on CassavaBase and renders appliedFilters under the user param names', async () => {
    const ctx = await connect(fetcher, 'CassavaBase');
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));

    await brapiFindGermplasm.handler(
      brapiFindGermplasm.input.parse({
        crops: ['Cassava'],
        names: ['TME419'],
        accessionNumbers: ['TMe-419'],
      }),
      ctx,
    );

    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.getAll('commonCropName')).toEqual(['Cassava']);
    expect(url.searchParams.getAll('germplasmName')).toEqual(['TME419']);
    expect(url.searchParams.getAll('accessionNumber')).toEqual(['TMe-419']);
    expect(url.searchParams.has('commonCropNames')).toBe(false);
    expect(url.searchParams.has('germplasmNames')).toBe(false);
    expect(url.searchParams.has('accessionNumbers')).toBe(false);
    expect(getEnrichment(ctx).appliedFilters).toEqual({
      commonCropName: 'Cassava',
      germplasmName: 'TME419',
      accessionNumber: 'TMe-419',
    });
    // SERVER_TO_USER maps singular `commonCropName` back to the user-facing `crops` param.
    const render = brapiFindGermplasm.enrichmentTrailer!.appliedFilters!.render!;
    expect(render(getEnrichment(ctx).appliedFilters as Record<string, unknown>)).toMatch(/crops/);
  });

  it('tolerates null values on optional string fields (Cassavabase shape)', async () => {
    const ctx = await connect(fetcher);
    const sparseRow = {
      germplasmDbId: '2372141',
      germplasmName: 'unknown_accession',
      commonCropName: 'cassava,manioc,tapioca,yuca',
      genus: 'Manihot',
      species: 'Manihot esculenta',
      pedigree: 'NA/NA',
      // Cassavabase nulls in the wild:
      subtaxa: null,
      subtaxaAuthority: null,
      speciesAuthority: null,
      biologicalStatusOfAccessionDescription: null,
      germplasmPreprocessing: null,
      collection: null,
      synonyms: [{ synonym: 'Kantedza', type: null }],
      donors: [{ donorAccessionNumber: null, donorInstituteCode: null }],
    };
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [sparseRow] }, { totalCount: 1 })));
    const result = await brapiFindGermplasm.handler(brapiFindGermplasm.input.parse({}), ctx);
    expect(getEnrichment(ctx).returnedCount).toBe(1);
    expect(result.results[0]?.subtaxa).toBeNull();
    expect(result.results[0]?.synonyms?.[0]?.type).toBeNull();
  });
});

describe('brapi_find_germplasm free-text scan scope', () => {
  // TEST_CONFIG pageSize is 10, so one spill walk scans at most 10 × 50 = 500 rows.
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  const serve = (rows: Record<string, unknown>[], options?: { omitTotal?: boolean }) =>
    serveGermplasm(fetcher, rows, options);

  /** `n` germplasm rows; rows whose 1-based index satisfies `isMatch` carry a UG1201… name. */
  function germplasm(n: number, isMatch: (i: number) => boolean): Record<string, unknown>[] {
    return Array.from({ length: n }, (_, idx) => {
      const i = idx + 1;
      return {
        germplasmDbId: `g${i}`,
        germplasmName: isMatch(i) ? `UG1201${String(i).padStart(2, '0')}` : `test_accession${i}`,
        commonCropName: 'Cassava',
      };
    });
  }

  async function call(ctx: Context, input: Record<string, unknown>) {
    const definition = {
      ...brapiFindGermplasm,
      handler: (parsed, contractCtx) =>
        brapiFindGermplasm.handler(parsed, { ...contractCtx, state: ctx.state }),
    } satisfies typeof brapiFindGermplasm;
    const result = await runToolContract(definition, input, { context: { tenantId: 't1' } });
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    return { result, structured: result.structuredContent as Record<string, unknown>, text };
  }

  const isUg = (i: number) => i >= 111 && i <= 210;

  it('scans configured first-page depth independently of a five-row preview above the ceiling', async () => {
    const ctx = await connect(fetcher);
    const rows = germplasm(20, (i) => i === 8);
    fetcher.mockImplementation(async (url: string) => {
      const size = Number(new URL(url).searchParams.get('pageSize'));
      return jsonResponse(envelope({ data: rows.slice(0, size) }, { totalCount: 842_000 }));
    });
    const { structured, text } = await call(ctx, { text: 'UG1201', loadLimit: 5 });
    expect(
      (structured.results as { germplasmDbId: string }[]).map((row) => row.germplasmDbId),
    ).toEqual(['g8']);
    expect(new URL(String(fetcher.mock.calls[0]![0])).searchParams.get('pageSize')).toBe('10');
    expect(text).toContain('g8');
  });

  it.each([false, true])(
    'keeps first/second/last/past-end identities aligned under a served-size clamp (unknown total: %s)',
    async (omitTotal) => {
      const ctx = await connect(fetcher);
      const rows = germplasm(9, () => true);
      serveGermplasm(fetcher, rows, { clamp: 3, omitTotal });
      const { structured, text } = await call(ctx, { text: 'UG1201', loadLimit: 20 });
      expect(
        (structured.results as { germplasmDbId: string }[]).map((row) => row.germplasmDbId),
      ).toEqual(rows.map((row) => row.germplasmDbId));
      expect(
        fetcher.mock.calls.map((call) =>
          Number(new URL(String(call[0])).searchParams.get('page') ?? 0),
        ),
      ).toEqual(omitTotal ? [0, 1, 2, 3] : [0, 1, 2]);
      expect(structured.hasMore).toBe(false);
      expect(text).toContain('9 of 9 row(s) scanned');
    },
  );

  it('discloses an upstream stride change instead of declaring a complete text scan', async () => {
    const ctx = await connect(fetcher);
    const rows = germplasm(5, () => true);
    fetcher.mockImplementation(async (url: string) => {
      const page = Number(new URL(url).searchParams.get('page') ?? 0);
      const pageSize = page === 0 ? 3 : 2;
      return jsonResponse({
        metadata: { pagination: { pageSize, totalCount: 5 } },
        result: { data: rows.slice(page * pageSize, (page + 1) * pageSize) },
      });
    });
    const { structured, text } = await call(ctx, { text: 'UG1201', loadLimit: 20 });
    expect(structured.hasMore).toBe(true);
    expect(text).toContain('page size changed');
    expect(text).not.toContain('5 of 5 row(s) scanned');
  });

  it('keeps an above-ceiling clamped miss to one request and reports actual scanned rows', async () => {
    const ctx = await connect(fetcher);
    serveGermplasm(
      fetcher,
      germplasm(20, () => false),
      { clamp: 3, reportedTotal: 842_000 },
    );
    const { structured, text } = await call(ctx, { text: 'NOPE', loadLimit: 5 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(structured.results).toEqual([]);
    expect(structured.hasMore).toBe(true);
    expect(text).toContain('first 3 row(s) scanned out of 842000');
  });

  it('scans the whole set when it fits one spill walk, staging only the matches and pointing at them', async () => {
    const ctx = await connect(fetcher);
    serve(germplasm(479, isUg));

    const { result, structured, text } = await call(ctx, { text: 'UG1201', loadLimit: 50 });

    expect(result.isError).toBeFalsy();
    // First page is walk page 0: 48 pages of 10 cover all 479 rows.
    expect(fetcher.mock.calls.length).toBe(48);
    expect(structured.returnedCount).toBe(50);
    expect(structured.totalCount).toBe(479);
    expect(structured.hasMore).toBe(true);
    // The dataframe holds the 100 matches, not the 479 scanned rows.
    expect(structured.dataframe).toMatchObject({ rowCount: 100, totalCount: 479 });
    expect(structured.distributions).toMatchObject({ commonCropName: { Cassava: 100 } });
    expect((structured.results as { germplasmName: string }[])[0]?.germplasmName).toBe('UG1201111');
    expect(structured.warnings).toContain(
      "Free-text 'UG1201' matched 100 of 479 row(s) scanned (the full upstream set).",
    );
    expect(text).toContain("Free-text 'UG1201' matched 100 of 479 row(s) scanned");
    expect(text).not.toContain('unlikely to surface hits');

    // One notice names the bound, the table, and both dataframe tools.
    const tableName = (structured.dataframe as { tableName: string }).tableName;
    expect(structured.notice).toBe(
      `results[] holds the first 50 matched row(s): loadLimit (50) bound. Staged dataframe \`${tableName}\` (100 rows): list its columns with brapi_dataframe_describe, then query it with brapi_dataframe_query (SQL).`,
    );
    expect(text).toContain(`> ${structured.notice as string}`);
    expect(text).toContain(
      `⚠ More rows exist beyond results[]: all 100 matched rows are in dataframe \`${tableName}\`.`,
    );
    // The complete dataframe is the refinement path, not a narrower re-pull.
    expect(structured.refinementHint).toContain(`dataframe \`${tableName}\``);
    expect(structured.refinementHint).toContain('brapi_dataframe_query');
    expect(structured.refinementHint).not.toMatch(/loadLimit|rows exceed/);

    // A loadLimit that holds the whole match set returns the same matches, all inline.
    const whole = await call(ctx, { text: 'UG1201', loadLimit: 500 });
    const names = (s: Record<string, unknown>) =>
      (s.results as { germplasmName: string }[]).map((r) => r.germplasmName);
    expect(names(whole.structured)).toHaveLength(100);
    expect(names(structured)).toEqual(names(whole.structured).slice(0, 50));
    expect(structured.distributions).toEqual(whole.structured.distributions);
    expect(whole.structured.hasMore).toBe(false);
  });

  it('returns zero results and a warning, with no dataframe or hint, when a fully scanned set has no match', async () => {
    const ctx = await connect(fetcher);
    serve(germplasm(479, () => false));

    const { result, structured, text } = await call(ctx, { text: 'NOPE', loadLimit: 50 });

    expect(result.isError).toBeFalsy();
    expect(fetcher.mock.calls.length).toBe(48);
    expect(structured.results).toEqual([]);
    expect(structured).not.toHaveProperty('dataframe');
    expect(structured).not.toHaveProperty('refinementHint');
    expect(structured.hasMore).toBe(false);
    expect(structured.notice).toMatch(/No rows returned/);
    // Distributions cover the matched set, so a zero-match query shows no `Cassava (479)` block.
    expect((structured.distributions as Record<string, unknown>).commonCropName).toEqual({});
    const warning = (structured.warnings as string[]).find((w) => w.startsWith("Free-text 'NOPE'"));
    expect(warning).toBe(
      "Free-text 'NOPE' matched 0 of 479 row(s) scanned (the full upstream set). For an exact name, accession number, or DbId, use names, accessionNumbers, or germplasmDbIds; otherwise check spelling.",
    );
    expect(text).not.toContain('matched 0 of 50');
    expect(text).not.toContain('Table schema');
    expect(text).not.toContain('exceed loadLimit');
  });

  it('words a spill that ends at the walk ceiling as a bounded scan', async () => {
    const ctx = await connect(fetcher);
    // 600 rows > the 500-row ceiling; row 1 matches (so the walk runs), row 550 is never reached.
    serve(germplasm(600, (i) => i === 1 || i === 550));

    const { structured } = await call(ctx, { text: 'UG1201', loadLimit: 5 });

    expect(fetcher.mock.calls.length).toBe(50);
    expect(structured.returnedCount).toBe(1);
    expect(structured.hasMore).toBe(true);
    // The one match is inline, so nothing is staged; the page-cap warning carries the stop.
    expect(structured).not.toHaveProperty('dataframe');
    expect(structured.warnings).toContain(
      "Free-text 'UG1201' matched 1 of the first 500 row(s) scanned out of 600 upstream; the remaining rows were not scanned. Narrow with server-side filters (crops, genus, species, collections) to bring the set under the 500-row scan ceiling.",
    );
    expect((structured.warnings as string[]).join('\n')).toMatch(/50-page walk cap was reached/);
  });

  it('walks a full first page from an upstream that reports no totalCount, scanning to its end', async () => {
    const ctx = await connect(fetcher);
    serve(
      germplasm(30, (i) => i >= 25),
      { omitTotal: true },
    );

    const { structured } = await call(ctx, { text: 'UG1201', loadLimit: 10 });

    // First page (reused as walk page 0), walk pages 1 and 2, then the empty page 3.
    expect(fetcher.mock.calls.length).toBe(4);
    expect(structured.returnedCount).toBe(6);
    expect(structured.totalCount).toBe(30);
    expect(structured.hasMore).toBe(false);
    // Every match fits inline, so nothing is staged.
    expect(structured).not.toHaveProperty('dataframe');
    expect(structured.warnings).toContain(
      "Free-text 'UG1201' matched 6 of 30 row(s) scanned (the full upstream set).",
    );
  });

  it('words a no-total walk the page cap stopped as a bounded scan, never the full set', async () => {
    const ctx = await connect(fetcher);
    serve(
      germplasm(600, (i) => i === 1 || i === 550),
      { omitTotal: true },
    );

    const { structured } = await call(ctx, { text: 'UG1201', loadLimit: 5 });

    expect(structured.returnedCount).toBe(1);
    expect(structured.hasMore).toBe(true);
    const warnings = structured.warnings as string[];
    expect(warnings).toContain(
      "Free-text 'UG1201' matched 1 of the first 500 row(s) scanned; the upstream reported no total, and rows past them were not scanned. Narrow with server-side filters (crops, genus, species, collections) to bring the set under the 500-row scan ceiling.",
    );
    expect(warnings.join('\n')).not.toContain('the full upstream set');
  });

  it.each([
    [
      'a registered synonym',
      [
        { germplasmDbId: 'g1', germplasmName: 'CG-25', synonyms: [{ synonym: 'Kantedza' }] },
        { germplasmDbId: 'g2', germplasmName: 'TME419' },
      ],
      'kantedza',
    ],
    [
      'the germplasm PUI',
      [
        { germplasmDbId: 'g1', germplasmName: 'A', germplasmPUI: 'doi:10.18730/ABC123' },
        { germplasmDbId: 'g2', germplasmName: 'B', germplasmPUI: 'doi:10.18730/XYZ' },
      ],
      'abc123',
    ],
  ])('matches free-text against %s, case-insensitively', async (_label, rows, text) => {
    const ctx = await connect(fetcher);
    serve(rows);
    const { structured } = await call(ctx, { text });
    expect((structured.results as { germplasmDbId: string }[]).map((r) => r.germplasmDbId)).toEqual(
      ['g1'],
    );
  });

  // Budget bounds, staging, and walk stops are tabled at their seam in
  // tests/tools/shared/find-helpers.test.ts; these prove the tool wires them.
  it('budgets the free-text matches, not the scanned page, and stages every match', async () => {
    const ctx = await connect(fetcher);
    // 7 of 10 rows match; their ~5 KB rows overrun the 24,000-byte budget after four.
    serve(
      germplasm(10, (i) => i % 5 !== 0 && i !== 3).map((row) => ({
        ...row,
        pedigree: 'P'.repeat(4_900),
      })),
    );

    // loadLimit defaults to BRAPI_LOAD_LIMIT's 1,000, well above what fits.
    const { result, structured, text } = await call(ctx, { text: 'UG1201' });

    expect(result.isError).toBeFalsy();
    expect(fetcher.mock.calls.length).toBe(1);
    const names = (structured.results as { germplasmName: string }[]).map((r) => r.germplasmName);
    expect(names).toEqual(['UG120101', 'UG120102', 'UG120104', 'UG120106']);
    expect(Buffer.byteLength(JSON.stringify(structured.results), 'utf8')).toBeLessThanOrEqual(
      24_000,
    );
    expect(structured).toMatchObject({
      returnedCount: 4,
      hasMore: true,
      truncated: true,
      shown: 4,
      cap: 1_000,
      dataframe: { rowCount: 7 },
    });
    expect(text).toContain('24,000-byte inline budget');
  });

  it('sets no truncation fields inside both bounds and renders no empty warnings heading', async () => {
    const ctx = await connect(fetcher);
    serve(germplasm(3, () => true));

    const { structured, text } = await call(ctx, {});

    expect(structured).toMatchObject({ returnedCount: 3, hasMore: false });
    for (const key of ['truncated', 'shown', 'cap', 'notice', 'dataframe']) {
      expect(structured).not.toHaveProperty(key);
    }
    expect(structured.warnings).toEqual([]);
    expect(text).toContain('**Applied Filters:** none');
    expect(text).not.toContain('_none_');
    expect(text).not.toContain('**Warnings:**');
  });

  it('renders warnings under their own heading, apart from the Applied Filters list', async () => {
    const ctx = await connect(fetcher);
    serve(germplasm(30, (i) => i <= 3));

    const { structured, text } = await call(ctx, { crops: ['Cassava'], text: 'UG1201' });

    expect((structured.warnings as string[]).length).toBeGreaterThan(0);
    expect(text).toMatch(/- \*\*crops:\*\* Cassava\n\n\*\*Warnings:\*\*\n- Free-text 'UG1201'/);
  });
});
