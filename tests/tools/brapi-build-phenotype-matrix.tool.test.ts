/**
 * @fileoverview Tests for brapi_build_phenotype_matrix — observation pull
 * (direct /observations and /observationunits fallback), aggregation, shape,
 * variable legend, and dataframe materialization.
 *
 * @module tests/tools/brapi-build-phenotype-matrix.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, timeout } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { brapiBuildPhenotypeMatrix } from '@/mcp-server/tools/definitions/brapi-build-phenotype-matrix.tool.js';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { UPSTREAM_TIMEOUT_HINT } from '@/services/brapi-client/index.js';
import { registerDialect, specDialect } from '@/services/brapi-dialect/index.js';
import { getCanvasBridge } from '@/services/canvas-bridge/index.js';
import {
  BASE_URL,
  envelope,
  initTestServices,
  jsonResponse,
  type MockFetcher,
  pathnameOf,
  resetTestServices,
  TEST_CONFIG,
} from './_tool-test-helpers.js';

/**
 * Connect with observations + observationunits advertised. Pass
 * `advertiseObservationPaths: false` to advertise a server that exposes neither
 * (drives the `no_observation_path` fail-fast path); pass `errors` to wire the
 * typed `ctx.fail` so that path's thrown reason is assertable.
 */
async function connect(
  fetcher: MockFetcher,
  opts: {
    advertiseObservationPaths?: boolean;
    errors?: typeof brapiBuildPhenotypeMatrix.errors;
  } = {},
) {
  const advertise = opts.advertiseObservationPaths ?? true;
  fetcher.mockImplementation(async (url: string) => {
    const path = pathnameOf(url);
    if (path.endsWith('/serverinfo')) {
      return jsonResponse(
        envelope({
          serverName: 'Test',
          calls: advertise
            ? [
                { service: 'observations', methods: ['GET'], versions: ['2.1'] },
                { service: 'observationunits', methods: ['GET'], versions: ['2.1'] },
              ]
            : [{ service: 'studies', methods: ['GET'], versions: ['2.1'] }],
        }),
      );
    }
    if (path.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: [] }));
    return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
  });
  const ctx = createMockContext(
    opts.errors ? { tenantId: 't1', errors: opts.errors } : { tenantId: 't1' },
  );
  await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
  fetcher.mockReset();
  return ctx;
}

/** Build a flat /observations row. */
function obsRow(
  germplasmDbId: string,
  germplasmName: string,
  variableDbId: string,
  variableName: string,
  value: string,
  studyDbId = 'study1',
) {
  return {
    observationDbId: `obs_${germplasmDbId}_${variableDbId}`,
    observationVariableDbId: variableDbId,
    observationVariableName: variableName,
    germplasmDbId,
    germplasmName,
    studyDbId,
    value,
  };
}

describe('brapi_build_phenotype_matrix tool', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTestServices();
  });

  /** Serve `rows` on /observations (empty elsewhere), build study1's matrix, and capture the rows it stages. */
  async function build(
    ctx: Awaited<ReturnType<typeof connect>>,
    rows: Record<string, unknown>[],
    input: Record<string, unknown>,
  ) {
    fetcher.mockImplementation(async (url: string) =>
      pathnameOf(url).endsWith('/observations')
        ? jsonResponse(envelope({ data: rows }, { totalCount: rows.length }))
        : jsonResponse(envelope({ data: [] }, { totalCount: 0 })),
    );
    const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
    const result = await brapiBuildPhenotypeMatrix.handler(
      brapiBuildPhenotypeMatrix.input.parse({ studies: ['study1'], ...input }),
      ctx,
    );
    const staged = (register.mock.calls[0]?.[1].rows ?? []) as Record<string, unknown>[];
    return { result, staged };
  }

  /** Variable v1 ('Height') observations, one per [germplasmDbId, value] pair. */
  const heights = (pairs: readonly (readonly [string, string])[]) =>
    pairs.map(([g, value]) => obsRow(g, g.toUpperCase(), 'v1', 'Height', value));

  it.each([
    {
      label: 'mean averages each germplasm’s replicates',
      aggregate: 'mean',
      pairs: [
        ['g1', '10'],
        ['g1', '20'],
        ['g2', '30'],
        ['g2', '40'],
      ],
      cells: [
        ['g1', 15],
        ['g2', 35],
      ],
    },
    {
      label: 'median of an odd-length set is its middle value',
      aggregate: 'median',
      pairs: [
        ['g1', '10'],
        ['g1', '30'],
        ['g1', '20'],
      ],
      cells: [['g1', 20]],
    },
    {
      label: 'first keeps the first value, categorical or not',
      aggregate: 'first',
      pairs: [
        ['g1', 'red'],
        ['g1', 'blue'],
      ],
      cells: [['g1', 'red']],
    },
    {
      label: 'mean over a categorical trait leaves the cell null and warns',
      aggregate: 'mean',
      pairs: [
        ['g1', 'red'],
        ['g1', 'blue'],
      ],
      cells: [['g1', null]],
      nonNumeric: true,
    },
  ] as const)('wide + $aggregate: $label', async ({ aggregate, pairs, cells, ...rest }) => {
    const ctx = await connect(fetcher);
    const nonNumeric = 'nonNumeric' in rest;

    const { result, staged } = await build(ctx, heights(pairs), { shape: 'wide', aggregate });

    expect(staged).toEqual(
      cells.map(([g, v1]) => ({ germplasmDbId: g, germplasmName: g.toUpperCase(), v1 })),
    );
    expect(result).toMatchObject({
      observationCount: pairs.length,
      germplasmCount: cells.length,
      variableCount: 1,
      variableLegend: { v1: 'Height' },
      dataframe: { rowCount: cells.length },
    });
    expect(result.dataframe?.columns).toEqual(['germplasmDbId', 'germplasmName', 'v1']);
    expect(result.warnings.some((w) => /^Variable 'v1': all values are non-numeric/.test(w))).toBe(
      nonNumeric,
    );
  });

  it.each([
    ['long', { shape: 'long' }, false],
    ['wide + all falls back to long form', { shape: 'wide', aggregate: 'all' }, true],
  ] as const)('%s: one row per observation with a replicateIndex', async (_label, input, warns) => {
    const ctx = await connect(fetcher);

    const { result, staged } = await build(
      ctx,
      heights([
        ['g1', '10'],
        ['g1', '20'],
        ['g2', '30'],
      ]),
      input,
    );

    const long = (g: string, value: string, replicateIndex: number) => ({
      germplasmDbId: g,
      observationVariableDbId: 'v1',
      studyDbId: 'study1',
      value,
      replicateIndex,
    });
    expect(staged).toEqual([long('g1', '10', 0), long('g1', '20', 1), long('g2', '30', 0)]);
    expect(result.observationCount).toBe(3);
    expect(result.dataframe?.rowCount).toBe(3);
    expect(result.warnings.some((w) => /aggregate.*all.*long/i.test(w))).toBe(warns);
  });

  it.each([
    ['variables', { variables: ['v1'] }, ['g1:v1', 'g2:v1', 'g3:v1'], 3, 1],
    ['germplasm', { germplasm: ['g1', 'g2'] }, ['g1:v1', 'g1:v2', 'g2:v1'], 2, 2],
  ] as const)(
    'keeps only the requested %s',
    async (_label, subset, kept, germplasmCount, variableCount) => {
      const ctx = await connect(fetcher);
      const rows = [
        obsRow('g1', 'G1', 'v1', 'Height', '10'),
        obsRow('g1', 'G1', 'v2', 'Color', 'red'),
        obsRow('g2', 'G2', 'v1', 'Height', '20'),
        obsRow('g3', 'G3', 'v1', 'Height', '30'),
      ];

      const { result, staged } = await build(ctx, rows, { shape: 'long', ...subset });

      expect(staged.map((r) => `${r.germplasmDbId}:${r.observationVariableDbId}`)).toEqual(kept);
      expect(result).toMatchObject({
        observationCount: kept.length,
        germplasmCount,
        variableCount,
      });
    },
  );

  it('stages no dataframe, and warns, when no observations are found', async () => {
    const ctx = await connect(fetcher);

    // /observations and then /observationunits both answer empty.
    const { result, staged } = await build(ctx, [], { shape: 'wide' });

    expect(staged).toEqual([]);
    expect(result.observationCount).toBe(0);
    expect(result.germplasmCount).toBe(0);
    expect(result.variableCount).toBe(0);
    expect(result.warnings.some((w) => /empty/i.test(w))).toBe(true);
    expect(result.dataframe).toBeUndefined();
  });

  it('sanitizes numeric and reserved-word variable DbIds into safe wide columns', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      obsRow('g1', 'G1', '42', 'Plant Height', '10'), // numeric → v_42
      obsRow('g1', 'G1', 'end', 'End Date Trait', '20'), // reserved SQL word → end_
    ];

    const { result } = await build(ctx, rows, { shape: 'wide', aggregate: 'first' });

    const cols = result.dataframe?.columns ?? [];
    // Raw numeric / reserved names must NOT reach the dataframe (they fail the
    // framework's canvas identifier gate and would throw at registerTable).
    expect(cols).not.toContain('42');
    expect(cols).not.toContain('end');
    expect(cols).toContain('v_42');
    expect(cols).toContain('end_');
    // Legend resolves the safe column back to the display name.
    expect(result.variableLegend).toMatchObject({ v_42: 'Plant Height', end_: 'End Date Trait' });
  });

  // -------------------------------------------------------------------------
  // Format rendering
  // -------------------------------------------------------------------------
  it('format() renders header with germplasm × variable counts', async () => {
    const ctx = await connect(fetcher);

    const { result } = await build(ctx, heights([['g1', '10']]), { shape: 'wide' });

    const formatted = brapiBuildPhenotypeMatrix.format(result);
    expect(formatted[0]?.text).toMatch(/1 germplasm × 1 variables/);
    expect(formatted[0]?.text).toMatch(/tableName/);
  });

  // -------------------------------------------------------------------------
  // Concurrent pull — deterministic input-order column layout
  // -------------------------------------------------------------------------
  it('preserves input-order column layout under concurrent fetch (deterministic across runs)', async () => {
    const ctx = await connect(fetcher);
    // study1 carries variable v1 (slow response); study2 carries v2 (fast). The
    // studies fetch concurrently, so study2 (2nd in input) resolves FIRST —
    // completion order != input order. Wide-matrix columns must still follow
    // study encounter order (v1 before v2), or an identical query's column
    // layout would flap between runs.
    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(String(url));
      const path = pathnameOf(url);
      const studyId =
        u.searchParams.get('studyDbIds') ?? u.searchParams.get('studyDbId') ?? 'unknown';
      if (path.endsWith('/observations')) {
        if (studyId === 'study1') {
          await new Promise((r) => setTimeout(r, 30));
          return jsonResponse(
            envelope(
              { data: [obsRow('g1', 'G1', 'v1', 'Height', '10', 'study1')] },
              { totalCount: 1 },
            ),
          );
        }
        if (studyId === 'study2') {
          await new Promise((r) => setTimeout(r, 1));
          return jsonResponse(
            envelope(
              { data: [obsRow('g1', 'G1', 'v2', 'Width', '20', 'study2')] },
              { totalCount: 1 },
            ),
          );
        }
      }
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });

    const run = () =>
      brapiBuildPhenotypeMatrix.handler(
        brapiBuildPhenotypeMatrix.input.parse({
          studies: ['study1', 'study2'],
          shape: 'wide',
          aggregate: 'first',
        }),
        ctx,
      );
    const a = await run();
    const b = await run();

    // Columns follow study input order: v1 (study1) before v2 (study2), even
    // though study2's fetch resolves first. A completion-order reassembly would
    // yield ['v2', 'v1'] here.
    expect(a.observationCount).toBe(2);
    const varCols = (a.dataframe?.columns ?? []).filter((c) => c === 'v1' || c === 'v2');
    expect(varCols).toEqual(['v1', 'v2']);
    // Identical across identical runs.
    expect(b.dataframe?.columns ?? []).toEqual(a.dataframe?.columns ?? []);
    expect(Object.keys(b.variableLegend)).toEqual(Object.keys(a.variableLegend));
  });

  // -------------------------------------------------------------------------
  // Fail-fast — no observation path aborts the whole call
  // -------------------------------------------------------------------------
  it('fail-fast: throws no_observation_path when the server exposes neither observations endpoint', async () => {
    const ctx = await connect(fetcher, {
      advertiseObservationPaths: false,
      errors: brapiBuildPhenotypeMatrix.errors,
    });
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));

    await expect(
      brapiBuildPhenotypeMatrix.handler(
        brapiBuildPhenotypeMatrix.input.parse({ studies: ['study1', 'study2'], shape: 'long' }),
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'no_observation_path' } });
  });
});

// ---------------------------------------------------------------------------
// Observation pull — page walk (#61) and failure contract (#62)
// ---------------------------------------------------------------------------

const HOST = 'brapi.example.org';
const enrichmentSchema = z.object(brapiBuildPhenotypeMatrix.enrichment);

/** Rejects any request that is not to the test upstream host. */
function assertHost(url: string): URL {
  const u = new URL(String(url));
  if (u.hostname !== HOST) throw new Error(`Unmocked request: ${u.toString()}`);
  return u;
}

/** The fetcher-level shape of an HTTP error, as `fetchWithTimeout` throws it. */
function httpError(url: string, status: number): McpError {
  return new McpError(
    JsonRpcErrorCode.ServiceUnavailable,
    `Fetch failed for ${url}. Status: ${status}`,
    { status, errorSource: 'FetchHttpError' },
  );
}

/** The fetcher-level shape of a per-request timeout, as `fetchWithTimeout` throws it. */
function fetchTimeout(url: string): McpError {
  return timeout(`Fetch GET ${url} timed out.`, { errorSource: 'FetchTimeout' });
}

/** Serve one BrAPI page of `rows` honoring `page` / `pageSize` (and nothing else). */
function pageOf(u: URL, rows: Record<string, unknown>[]): Response {
  const pageSize = Number(u.searchParams.get('pageSize'));
  const page = Number(u.searchParams.get('page') ?? '0');
  return jsonResponse(
    envelope(
      { data: rows.slice(page * pageSize, (page + 1) * pageSize) },
      { totalCount: rows.length },
    ),
  );
}

/**
 * Study 139 as Breedbase serves it: 1,427 observations, germplasm 38884's three
 * rows at 1-based positions 1,392–1,394 (the second 1,000-row page).
 */
function study139Rows() {
  const target = [
    ['70666', 'dry matter content percentage', '28.2'],
    ['70773', 'fresh shoot weight', '1.5'],
    ['70741', 'fresh root weight', '1.94'],
  ] as const;
  return Array.from({ length: 1427 }, (_, i) => {
    const t = target[i + 1 - 1392];
    if (t) return obsRow('38884', 'TMEB419', t[0], t[1], t[2], '139');
    return obsRow(
      `g${i % 300}`,
      `G${i % 300}`,
      '70666',
      'dry matter content percentage',
      '1',
      '139',
    );
  });
}

/** `/observations` requests the fetcher received, with the timeout each was given. */
function observationRequests(fetcher: MockFetcher): { url: URL; timeoutMs: number }[] {
  return fetcher.mock.calls
    .map((c) => ({ url: new URL(String(c[0])), timeoutMs: c[1] as number }))
    .filter((r) => r.url.pathname.endsWith('/observations'));
}

describe('brapi_build_phenotype_matrix observation pull', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices({ ...TEST_CONFIG, pageSize: 1000 });
  });

  afterEach(() => {
    resetTestServices();
  });

  it('an upstream ignoring every filter: pages past the first page to the germplasm’s rows, keeping only the requested study’s', async () => {
    const ctx = await connect(fetcher);
    // The global set: another study's row for the same germplasm sits first.
    const rows = [
      obsRow('38884', 'TMEB419', '70666', 'dry matter content percentage', '99', 'sOther'),
      ...study139Rows(),
    ];
    fetcher.mockImplementation(async (url: string) => {
      const u = assertHost(url);
      if (u.pathname.endsWith('/observations')) return pageOf(u, rows);
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });

    const result = await brapiBuildPhenotypeMatrix.handler(
      brapiBuildPhenotypeMatrix.input.parse({
        studies: ['139'],
        germplasm: ['38884'],
        shape: 'long',
      }),
      ctx,
    );

    const parsed = brapiBuildPhenotypeMatrix.output.parse(result);
    expect(parsed.observationCount).toBe(3);
    expect(parsed.germplasmCount).toBe(1);
    expect(parsed.variableCount).toBe(3);
    expect(observationRequests(fetcher).map((r) => r.url.searchParams.get('page'))).toEqual([
      '0',
      '1',
    ]);
    expect(parsed.warnings.join('\n')).toMatch(
      /Study '139': \/observations returned 1 rows from other studies/,
    );
    const enrichment = enrichmentSchema.parse(getEnrichment(ctx));
    expect(enrichment.truncated).toBeUndefined();
    const text = brapiBuildPhenotypeMatrix.format(result)[0]?.text;
    expect(text).toMatch(/1 germplasm × 3 variables/);
    expect(text).toMatch(/from other studies/);
  });

  it('a later-page failure keeps the rows already collected and sets truncated naming the study', async () => {
    const ctx = await connect(fetcher);
    const rows = study139Rows();
    fetcher.mockImplementation(async (url: string) => {
      const u = assertHost(url);
      if (u.pathname.endsWith('/observations')) {
        if (u.searchParams.get('page') === '1') throw httpError(u.toString(), 502);
        return pageOf(u, rows);
      }
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });

    const result = await brapiBuildPhenotypeMatrix.handler(
      brapiBuildPhenotypeMatrix.input.parse({ studies: ['139'], shape: 'long' }),
      ctx,
    );

    expect(result.observationCount).toBe(1000);
    const enrichment = enrichmentSchema.parse(getEnrichment(ctx));
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(1000);
    expect(enrichment.notice).toMatch(/139/);
    expect(enrichment.notice).toMatch(/1000 of 1427/);
    expect(result.warnings.join('\n')).toMatch(/Study '139'.*1000 of 1427/);
  });

  it('a loadLimit stop sets truncated, cap, and one notice: the scan guidance, then the dataframe pointer', async () => {
    const ctx = await connect(fetcher);
    const rows = study139Rows();
    fetcher.mockImplementation(async (url: string) => {
      const u = assertHost(url);
      if (u.pathname.endsWith('/observations')) return pageOf(u, rows);
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });

    const result = await brapiBuildPhenotypeMatrix.handler(
      brapiBuildPhenotypeMatrix.input.parse({ studies: ['139'], shape: 'long', loadLimit: 50 }),
      ctx,
    );

    expect(result.observationCount).toBe(50);
    expect(observationRequests(fetcher)).toHaveLength(1);
    const enrichment = enrichmentSchema.parse(getEnrichment(ctx));
    expect(enrichment).toMatchObject({ truncated: true, shown: 50, cap: 50 });
    const notice = enrichment.notice ?? '';
    expect(notice).toMatch(
      /^Observation scans stopped early for 139 \(stopped after 51 of 1427 rows: reached loadLimit \(50\) matching rows\)/,
    );
    expect(notice).toContain(
      `Staged dataframe \`${result.dataframe?.tableName}\` (50 rows): list its columns with brapi_dataframe_describe, then query it with brapi_dataframe_query (SQL).`,
    );
  });

  it('points at the matrix dataframe when no scan stopped early', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      obsRow('g1', 'G1', 'v1', 'Height', '10'),
      obsRow('g2', 'G2', 'v1', 'Height', '20'),
    ];
    fetcher.mockImplementation(async (url: string) => {
      const u = assertHost(url);
      if (u.pathname.endsWith('/observations')) return pageOf(u, rows);
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });

    const result = await brapiBuildPhenotypeMatrix.handler(
      brapiBuildPhenotypeMatrix.input.parse({ studies: ['study1'] }),
      ctx,
    );

    const enrichment = enrichmentSchema.parse(getEnrichment(ctx));
    expect(enrichment.truncated).toBeUndefined();
    expect(enrichment.notice).toBe(
      `Staged dataframe \`${result.dataframe?.tableName}\` (2 rows): list its columns with brapi_dataframe_describe, then query it with brapi_dataframe_query (SQL).`,
    );
  });

  describe('extraFilters verification', () => {
    /** Rows of study1, each on its own observation unit. */
    const unitRows = () => [
      { ...obsRow('g1', 'G1', 'v1', 'Height', '10'), observationUnitDbId: 'u1' },
      { ...obsRow('g2', 'G2', 'v1', 'Height', '20'), observationUnitDbId: 'u2' },
    ];

    async function build(rows: Record<string, unknown>[], extraFilters: Record<string, unknown>) {
      const ctx = await connect(fetcher);
      fetcher.mockImplementation(async (url: string) => {
        const u = assertHost(url);
        if (u.pathname.endsWith('/observations')) return pageOf(u, rows);
        return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
      });
      const result = await brapiBuildPhenotypeMatrix.handler(
        brapiBuildPhenotypeMatrix.input.parse({ studies: ['study1'], shape: 'long', extraFilters }),
        ctx,
      );
      return { result: brapiBuildPhenotypeMatrix.output.parse(result), ctx };
    }

    it('forwards the key and warns when the returned rows contradict it', async () => {
      const { result } = await build(unitRows(), { observationUnitDbIds: ['u1'] });

      expect(
        observationRequests(fetcher)[0]?.url.searchParams.getAll('observationUnitDbIds'),
      ).toEqual(['u1']);
      expect(result.observationCount).toBe(2);
      const warning = result.warnings.find((w) => w.includes('extraFilters.observationUnitDbIds'));
      expect(warning).toMatch(
        /requested \["u1"\] but 1 returned row\(s\) carried other values \(u2\)/,
      );
      expect(brapiBuildPhenotypeMatrix.format(result)[0]?.text).toContain(
        'extraFilters.observationUnitDbIds',
      );
    });

    it('a key every returned row satisfies adds no warning', async () => {
      const { result } = await build(unitRows().slice(0, 1), { observationUnitDbIds: ['u1'] });

      expect(result.observationCount).toBe(1);
      expect(result.warnings.some((w) => /extraFilters|Could not verify/.test(w))).toBe(false);
    });

    it('checks across every study, once, naming a key no returned row can speak to as unverified', async () => {
      const ctx = await connect(fetcher);
      fetcher.mockImplementation(async (url: string) => {
        const u = assertHost(url);
        if (!u.pathname.endsWith('/observations')) {
          return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
        }
        const study = u.searchParams.getAll('studyDbIds')[0] ?? '';
        return pageOf(u, [
          { ...obsRow('g1', 'G1', 'v1', 'Height', '1', study), observationUnitDbId: `u-${study}` },
        ]);
      });

      const result = await brapiBuildPhenotypeMatrix.handler(
        brapiBuildPhenotypeMatrix.input.parse({
          studies: ['study1', 'study2'],
          shape: 'long',
          extraFilters: { observationUnitDbIds: ['u-study1'], noSuchKey: 'x' },
        }),
        ctx,
      );

      expect(result.observationCount).toBe(2);
      expect(result.warnings.filter((w) => w.startsWith('Could not verify'))).toEqual([
        expect.stringMatching(
          /^Could not verify these extraFilters keys against returned rows: 'noSuchKey'/,
        ),
      ]);
      expect(result.warnings.filter((w) => /requested \["u-study1"\]/.test(w))).toHaveLength(1);
    });
  });

  it('a failed study among several is a warning; the other study still builds the matrix', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(async (url: string) => {
      const u = assertHost(url);
      const studyId = u.searchParams.get('studyDbIds') ?? u.searchParams.get('studyDbId');
      if (u.pathname.endsWith('/observations')) {
        if (studyId === 'bad') throw fetchTimeout(u.toString());
        return pageOf(u, [obsRow('g1', 'G1', 'v1', 'Height', '10', 'good')]);
      }
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });

    const result = await brapiBuildPhenotypeMatrix.handler(
      brapiBuildPhenotypeMatrix.input.parse({ studies: ['good', 'bad'], shape: 'long' }),
      ctx,
    );

    expect(result.observationCount).toBe(1);
    expect(result.warnings.some((w) => /^Study 'bad'.*failed/.test(w))).toBe(true);
  });

  it('fails only when every requested study failed, naming each — first-page timeouts at the request timeout, with no fallback', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(async (url: string) => {
      const u = assertHost(url);
      if (u.pathname.endsWith('/observations')) throw fetchTimeout(u.toString());
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });

    const err = await brapiBuildPhenotypeMatrix
      .handler(brapiBuildPhenotypeMatrix.input.parse({ studies: ['s1', 's2'] }), ctx)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.Timeout);
    expect((err as McpError).message).toMatch(/s1/);
    expect((err as McpError).message).toMatch(/s2/);
    // The first study's Timeout hint survives the rebuild.
    expect((err as McpError).data).toMatchObject({
      recovery: { hint: UPSTREAM_TIMEOUT_HINT },
      studyDbIds: ['s1', 's2'],
    });
    const obsRequests = observationRequests(fetcher);
    expect(obsRequests.map((r) => r.timeoutMs)).toEqual([
      TEST_CONFIG.requestTimeoutMs,
      TEST_CONFIG.requestTimeoutMs,
    ]);
    expect(fetcher.mock.calls.some((c) => pathnameOf(c[0]).endsWith('/observationunits'))).toBe(
      false,
    );
  });

  it('every study failing on a dialect that drops the observation-unit study filter fails dialect_all_filters_dropped with its declared hint', async () => {
    registerDialect({
      ...specDialect,
      id: 'drops-unit-filters',
      adaptGetFilters: (endpoint, filters) =>
        endpoint === 'observationunits'
          ? { filters: {}, dropped: Object.keys(filters), warnings: [] }
          : specDialect.adaptGetFilters(endpoint, filters),
    });
    vi.stubEnv('BRAPI_DEFAULT_DIALECT', 'drops-unit-filters');
    try {
      const ctx = await connect(fetcher);
      fetcher.mockImplementation(async (url: string) => {
        const u = assertHost(url);
        if (u.pathname.endsWith('/observations')) return pageOf(u, []);
        throw new Error(`Unexpected request: ${u.toString()}`);
      });
      const definition = {
        ...brapiBuildPhenotypeMatrix,
        handler: (parsed, contractCtx) =>
          brapiBuildPhenotypeMatrix.handler(parsed, { ...contractCtx, state: ctx.state }),
      } satisfies typeof brapiBuildPhenotypeMatrix;

      const result = await runToolContract(
        definition,
        { studies: ['s1', 's2'] },
        { context: { tenantId: 't1' } },
      );

      const declared = brapiBuildPhenotypeMatrix.errors.find(
        (e) => e.reason === 'dialect_all_filters_dropped',
      );
      expect(declared).toBeDefined();
      expect(brapiBuildPhenotypeMatrix.errors.map((e) => e.reason)).not.toContain(
        'all_filters_dropped',
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'dialect_all_filters_dropped',
            recovery: { hint: declared?.recovery },
            studyDbIds: ['s1', 's2'],
          },
        },
      });
      const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
      expect(text).toContain(`Recovery: ${declared?.recovery}`);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
