/**
 * @fileoverview Tests for brapi_germplasm_performance — germplasm existence,
 * study discovery with the dialect-honor cross-check, the study-anchored →
 * germplasm-anchored observation fallback (mirroring the BrAPI test server,
 * which ignores the studyDbId filter on /observations), per-variable
 * aggregation, and the typed error contract.
 *
 * @module tests/tools/brapi-germplasm-performance.tool.test
 */

import { JsonRpcErrorCode, McpError, timeout } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiGermplasmPerformance } from '@/mcp-server/tools/definitions/brapi-germplasm-performance.tool.js';
import {
  BASE_URL,
  envelope,
  initTestServices,
  jsonResponse,
  type MockFetcher,
  pathnameOf,
  resetTestServices,
  stalledResponse,
  TEST_CONFIG,
  withCallRemaining,
} from './_tool-test-helpers.js';

const SERVER_CALLS = [
  { service: 'germplasm', methods: ['GET'], versions: ['2.1'] },
  { service: 'studies', methods: ['GET'], versions: ['2.1'] },
  { service: 'observations', methods: ['GET'], versions: ['2.1'] },
  { service: 'observationunits', methods: ['GET'], versions: ['2.1'] },
];

async function connect(fetcher: MockFetcher) {
  fetcher.mockImplementation(async (url: string) => {
    const path = pathnameOf(url);
    if (path.endsWith('/serverinfo')) {
      return jsonResponse(envelope({ serverName: 'Test', calls: SERVER_CALLS }));
    }
    if (path.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: [] }));
    return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
  });
  const ctx = createMockContext({ tenantId: 't1', errors: brapiGermplasmPerformance.errors });
  await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
  fetcher.mockReset();
  return ctx;
}

/** Germplasm1's two replicate observations of variable1 (values 10, 20). */
const GERMPLASM1_OBS = [
  {
    observationDbId: 'o1',
    observationVariableDbId: 'variable1',
    observationVariableName: 'Corn Stalk Height',
    germplasmDbId: 'germplasm1',
    studyDbId: 'study1',
    value: '10',
    season: { seasonName: 'spring', year: 2013, seasonDbId: 'spring_2013' },
  },
  {
    observationDbId: 'o2',
    observationVariableDbId: 'variable1',
    observationVariableName: 'Corn Stalk Height',
    germplasmDbId: 'germplasm1',
    studyDbId: 'study1',
    value: '20',
    season: { seasonName: 'spring', year: 2013, seasonDbId: 'spring_2013' },
  },
];

/**
 * Mock a test-server-like deployment: /studies honors the germplasm filter,
 * /observations ignores studyDbId (returns empty when anchored), and germplasm-
 * anchored /observations returns the rows. `filteredStudiesTotal`/`baselineTotal`
 * drive the dialect-honor cross-check.
 */
function mockServer(
  fetcher: MockFetcher,
  opts: {
    germplasmMissing?: boolean;
    filteredStudiesTotal?: number;
    baselineStudiesTotal?: number;
    obs?: Record<string, unknown>[];
  } = {},
) {
  const obs = opts.obs ?? GERMPLASM1_OBS;
  fetcher.mockImplementation(async (url: string) => {
    const u = new URL(String(url));
    const path = pathnameOf(url);
    if (path.endsWith('/serverinfo')) {
      return jsonResponse(envelope({ serverName: 'Test', calls: SERVER_CALLS }));
    }
    if (path.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: [] }));
    if (path.includes('/germplasm/')) {
      if (opts.germplasmMissing) return jsonResponse(envelope({}), 404);
      return jsonResponse(envelope({ germplasmDbId: 'germplasm1', germplasmName: 'Germ One' }));
    }
    if (path.endsWith('/studies')) {
      const filtered = u.searchParams.has('germplasmDbIds') || u.searchParams.has('germplasmDbId');
      const total = filtered ? (opts.filteredStudiesTotal ?? 1) : (opts.baselineStudiesTotal ?? 3);
      return jsonResponse(envelope({ data: [{ studyDbId: 'study1' }] }, { totalCount: total }));
    }
    if (path.endsWith('/observationunits')) {
      return jsonResponse(
        envelope(
          {
            data: [
              {
                observationUnitDbId: 'ou1',
                germplasmDbId: 'germplasm1',
                germplasmName: 'Germ One',
                studyDbId: 'study1',
                observations: [],
              },
            ],
          },
          { totalCount: 1 },
        ),
      );
    }
    if (path.endsWith('/observations')) {
      const anchored = u.searchParams.has('studyDbIds') || u.searchParams.has('studyDbId');
      if (anchored) return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
      return jsonResponse(envelope({ data: obs }, { totalCount: obs.length }));
    }
    return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
  });
}

describe('brapi_germplasm_performance tool', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('throws germplasm_not_found when the germplasm record is absent (404)', async () => {
    const ctx = await connect(fetcher);
    mockServer(fetcher, { germplasmMissing: true });
    await expect(
      brapiGermplasmPerformance.handler(
        brapiGermplasmPerformance.input.parse({ germplasmDbId: 'germplasm1' }),
        ctx,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'germplasm_not_found' },
    });
  });

  it('aggregates per-variable stats via the study-anchored → germplasm fallback', async () => {
    const ctx = await connect(fetcher);
    mockServer(fetcher);

    const result = await brapiGermplasmPerformance.handler(
      brapiGermplasmPerformance.input.parse({ germplasmDbId: 'germplasm1' }),
      ctx,
    );

    expect(result.germplasmName).toBe('Germ One');
    expect(result.studyDbIds).toEqual(['study1']);
    expect(result.studyCount).toBe(1);
    expect(result.perVariable).toHaveLength(1);

    const v = result.perVariable[0]!;
    expect(v.observationVariableDbId).toBe('variable1');
    expect(v.observationVariableName).toBe('Corn Stalk Height');
    expect(v.n).toBe(2);
    expect(v.mean).toBe(15);
    expect(v.median).toBe(15);
    expect(v.min).toBe('10');
    expect(v.max).toBe('20');
    expect(v.sd).toBeCloseTo(7.071, 2); // sample sd of [10,20] = sqrt(50)
    expect(v.studyCount).toBe(1);
    expect(v.studyDbIds).toEqual(['study1']);
    expect(v.seasons).toEqual(['spring 2013']);
  });

  it('warns when /studies ignores the germplasm filter (filtered total === baseline)', async () => {
    const ctx = await connect(fetcher);
    mockServer(fetcher, { filteredStudiesTotal: 3, baselineStudiesTotal: 3 });

    const result = await brapiGermplasmPerformance.handler(
      brapiGermplasmPerformance.input.parse({ germplasmDbId: 'germplasm1' }),
      ctx,
    );

    const warning = result.warnings.find((w) => /ignore the germplasm filter on \/studies/.test(w));
    expect(warning).toBeDefined();
    // The pulls are filtered client-side; the warning must not claim they are germplasm-scoped upstream.
    expect(warning).not.toMatch(/germplasm-scoped/);
    // Still aggregates from the per-study pull, filtered to the germplasm.
    expect(result.perVariable).toHaveLength(1);
    expect(result.perVariable[0]?.mean).toBe(15);
  });

  it('restricts aggregation to the requested variables', async () => {
    const ctx = await connect(fetcher);
    mockServer(fetcher, {
      obs: [
        ...GERMPLASM1_OBS,
        {
          observationDbId: 'o3',
          observationVariableDbId: 'variable2',
          observationVariableName: 'Leaf Width',
          germplasmDbId: 'germplasm1',
          studyDbId: 'study1',
          value: '5',
        },
      ],
    });

    const result = await brapiGermplasmPerformance.handler(
      brapiGermplasmPerformance.input.parse({
        germplasmDbId: 'germplasm1',
        variables: ['variable1'],
      }),
      ctx,
    );

    expect(result.perVariable).toHaveLength(1);
    expect(result.perVariable[0]?.observationVariableDbId).toBe('variable1');
  });

  it('bypasses study discovery (and its cap) when explicit studyDbIds are supplied', async () => {
    const ctx = await connect(fetcher);
    mockServer(fetcher);

    const result = await brapiGermplasmPerformance.handler(
      brapiGermplasmPerformance.input.parse({
        germplasmDbId: 'germplasm1',
        studyDbIds: ['study1'],
      }),
      ctx,
    );

    // Discovery is skipped entirely — /studies is never queried.
    const studiesCalls = fetcher.mock.calls.filter((c) => pathnameOf(c[0]).endsWith('/studies'));
    expect(studiesCalls).toHaveLength(0);
    // Still aggregates from the supplied study.
    expect(result.studyDbIds).toEqual(['study1']);
    expect(result.perVariable).toHaveLength(1);
    expect(result.perVariable[0]?.observationVariableDbId).toBe('variable1');
  });

  it('names the brapi_find_studies retrieval path when study discovery hits the cap', async () => {
    const ctx = await connect(fetcher);
    // /studies (germplasm-filtered) returns more than STUDY_DISCOVERY_CAP (200)
    // distinct studies in one page, tripping the cap. Observations stay empty so
    // the per-study pulls are cheap — the capped warning text is what we assert.
    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(String(url));
      const path = pathnameOf(url);
      if (path.endsWith('/serverinfo')) {
        return jsonResponse(envelope({ serverName: 'Test', calls: SERVER_CALLS }));
      }
      if (path.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: [] }));
      if (path.includes('/germplasm/')) {
        return jsonResponse(envelope({ germplasmDbId: 'germplasm1', germplasmName: 'Germ One' }));
      }
      if (path.endsWith('/studies')) {
        const filtered =
          u.searchParams.has('germplasmDbIds') || u.searchParams.has('germplasmDbId');
        if (filtered) {
          const data = Array.from({ length: 250 }, (_, i) => ({ studyDbId: `study-${i}` }));
          return jsonResponse(envelope({ data }, { totalCount: 250 }));
        }
        return jsonResponse(envelope({ data: [{ studyDbId: 'study-0' }] }, { totalCount: 999 }));
      }
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });

    const result = await brapiGermplasmPerformance.handler(
      brapiGermplasmPerformance.input.parse({ germplasmDbId: 'germplasm1' }),
      ctx,
    );

    const warnings = result.warnings.join('\n');
    expect(warnings).toContain('Study discovery capped at 200');
    expect(warnings).toContain('brapi_find_studies');
    expect(warnings).toContain('extraFilters.germplasmDbIds');
    expect(warnings).toContain('studyDbIds');
  });

  it('aggregates across multiple studies under concurrent fetch — deterministic across runs', async () => {
    const ctx = await connect(fetcher);
    // germplasm1 observed for variable1 in two studies (values 10, 20). The
    // germplasm-anchored /observations pull returns both rows; each study
    // iteration filters to its own studyDbId, so the aggregate combines both.
    mockServer(fetcher, {
      obs: [
        {
          observationDbId: 'o1',
          observationVariableDbId: 'variable1',
          observationVariableName: 'Corn Stalk Height',
          germplasmDbId: 'germplasm1',
          studyDbId: 'study1',
          value: '10',
        },
        {
          observationDbId: 'o2',
          observationVariableDbId: 'variable1',
          observationVariableName: 'Corn Stalk Height',
          germplasmDbId: 'germplasm1',
          studyDbId: 'study2',
          value: '20',
        },
      ],
    });

    const run = () =>
      brapiGermplasmPerformance.handler(
        brapiGermplasmPerformance.input.parse({
          germplasmDbId: 'germplasm1',
          studyDbIds: ['study1', 'study2'],
        }),
        ctx,
      );
    const a = await run();
    const b = await run();

    expect(a.studyDbIds).toEqual(['study1', 'study2']);
    expect(a.studyCount).toBe(2);
    expect(a.perVariable).toHaveLength(1);
    expect(a.perVariable[0]?.n).toBe(2);
    expect(a.perVariable[0]?.mean).toBe(15);
    expect(a.perVariable[0]?.studyDbIds).toEqual(['study1', 'study2']);
    // Output (including warning order) is identical across identical runs — the
    // per-study warnings buffers keep the concurrent fan-out deterministic.
    expect(b).toEqual(a);
  });
});

// ---------------------------------------------------------------------------
// Observation pull — page walk (#61) and failure contract (#62)
// ---------------------------------------------------------------------------

const HOST = 'brapi.example.org';

/**
 * Study 139 as Breedbase serves it: 1,427 observations whose `/observations`
 * endpoint ignores `germplasmDbId`; germplasm 38884's three rows sit at 1-based
 * positions 1,392–1,394, on the second 1,000-row page.
 */
function study139Rows(): Record<string, unknown>[] {
  const target = [
    ['70666', 'dry matter content percentage', '28.2'],
    ['70773', 'fresh shoot weight', '1.5'],
    ['70741', 'fresh root weight', '1.94'],
  ] as const;
  return Array.from({ length: 1427 }, (_, i) => {
    const t = target[i + 1 - 1392];
    return {
      observationDbId: `o${i}`,
      observationVariableDbId: t ? t[0] : '70666',
      observationVariableName: t ? t[1] : 'dry matter content percentage',
      germplasmDbId: t ? '38884' : `g${i % 300}`,
      studyDbId: '139',
      value: t ? t[2] : '1',
    };
  });
}

/**
 * An upstream holding germplasm 38884 whose `/observations` honors only
 * `page` / `pageSize`. `onObservations` may throw to simulate a failure; it
 * receives the request URL.
 */
function mockPagedServer(
  fetcher: MockFetcher,
  rows: Record<string, unknown>[],
  onObservations?: (u: URL) => void,
) {
  fetcher.mockImplementation(async (url: string) => {
    const u = new URL(String(url));
    if (u.hostname !== HOST) throw new Error(`Unmocked request: ${u.toString()}`);
    if (u.pathname.includes('/germplasm/')) {
      return jsonResponse(envelope({ germplasmDbId: '38884', germplasmName: 'TMEB419' }));
    }
    if (u.pathname.endsWith('/observations')) {
      onObservations?.(u);
      const pageSize = Number(u.searchParams.get('pageSize'));
      const page = Number(u.searchParams.get('page') ?? '0');
      return jsonResponse(
        envelope(
          { data: rows.slice(page * pageSize, (page + 1) * pageSize) },
          { totalCount: rows.length },
        ),
      );
    }
    return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
  });
}

describe('brapi_germplasm_performance observation pull', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices({ ...TEST_CONFIG, pageSize: 1000 });
  });

  afterEach(() => {
    resetTestServices();
  });

  it("aggregates rows past the first page, and only the requested study's, when /observations ignores every filter", async () => {
    const ctx = await connect(fetcher);
    const other = {
      observationDbId: 'oOther',
      observationVariableDbId: '70666',
      observationVariableName: 'dry matter content percentage',
      germplasmDbId: '38884',
      studyDbId: 'sOther',
      value: '99',
    };
    mockPagedServer(fetcher, [other, ...study139Rows()]);

    const result = await brapiGermplasmPerformance.handler(
      brapiGermplasmPerformance.input.parse({ germplasmDbId: '38884', studyDbIds: ['139'] }),
      ctx,
    );

    const parsed = brapiGermplasmPerformance.output.parse(result);
    expect(parsed.studyDbIds).toEqual(['139']);
    expect(
      parsed.perVariable.map((v) => [v.observationVariableDbId, v.n, v.mean, v.studyDbIds]),
    ).toEqual([
      ['70666', 1, 28.2, ['139']],
      ['70741', 1, 1.94, ['139']],
      ['70773', 1, 1.5, ['139']],
    ]);
    expect(parsed.warnings.some((w) => /stopped after/.test(w))).toBe(false);
    expect(brapiGermplasmPerformance.format(result)[0]?.text).toMatch(/studies: 1 · variables: 3/);
  });

  it('warns with rows scanned vs totalCount when a later page fails', async () => {
    const ctx = await connect(fetcher);
    mockPagedServer(fetcher, study139Rows(), (u) => {
      if (u.searchParams.get('page') === '1') {
        throw new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Fetch failed. Status: 502', {
          status: 502,
          errorSource: 'FetchHttpError',
        });
      }
    });

    const result = await brapiGermplasmPerformance.handler(
      brapiGermplasmPerformance.input.parse({ germplasmDbId: '38884', studyDbIds: ['139'] }),
      ctx,
    );

    expect(result.perVariable).toHaveLength(0);
    const warning = result.warnings.find((w) => w.startsWith("Study '139'"));
    expect(warning).toMatch(/1000 of 1427 rows/);
    expect(warning).toMatch(/502/);
  });

  it('a first-page timeout is a per-study failure warning, not an empty study', async () => {
    const ctx = await connect(fetcher);
    mockPagedServer(fetcher, study139Rows(), (u) => {
      throw timeout(`Fetch GET ${u.toString()} timed out.`, { errorSource: 'FetchTimeout' });
    });

    const result = await brapiGermplasmPerformance.handler(
      brapiGermplasmPerformance.input.parse({ germplasmDbId: '38884', studyDbIds: ['139'] }),
      ctx,
    );

    expect(result.studyDbIds).toEqual([]);
    expect(result.warnings.some((w) => w.startsWith("Study '139': observation pull failed"))).toBe(
      true,
    );
    expect(result.warnings.some((w) => /No observations found/.test(w))).toBe(false);
  });

  it('a caller cancellation mid-pull rejects instead of returning a partial aggregate', async () => {
    const controller = new AbortController();
    const ctx = await connect(fetcher);
    const cancellable = createMockContext({
      tenantId: 't1',
      signal: controller.signal,
      errors: brapiGermplasmPerformance.errors,
    });
    // Reuse the registered connection: the registry reads it from tenant state.
    Object.assign(cancellable, { state: ctx.state });
    mockPagedServer(fetcher, study139Rows(), () => {
      controller.abort();
      throw new DOMException('The operation was aborted.', 'AbortError');
    });

    await expect(
      brapiGermplasmPerformance.handler(
        brapiGermplasmPerformance.input.parse({ germplasmDbId: '38884', studyDbIds: ['139'] }),
        cancellable,
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
  });
});

describe('brapi_germplasm_performance against a stalled upstream', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    // Retries on, as in production: a timed-out attempt may only retry while
    // the call deadline still fits another.
    fetcher = initTestServices({ ...TEST_CONFIG, requestTimeoutMs: 1_000, retryMaxAttempts: 3 });
  });

  afterEach(() => {
    resetTestServices();
  });

  /** Serve `mockServer`, except requests whose path matches `stalls` never answer. */
  function stallOn(stalls: (path: string) => boolean) {
    mockServer(fetcher);
    const served = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(
      (url: string, timeoutMs: number, ctx: unknown, init?: { signal?: AbortSignal }) =>
        stalls(pathnameOf(url))
          ? stalledResponse(timeoutMs, init?.signal)
          : served(url, timeoutMs, ctx, init),
    );
  }

  async function run(
    ctx: Awaited<ReturnType<typeof connect>>,
    remainingMs: number,
    input: { germplasmDbId: string; studyDbIds?: string[] },
  ) {
    const definition = {
      ...brapiGermplasmPerformance,
      handler(parsed, contractCtx) {
        return brapiGermplasmPerformance.handler(
          parsed,
          withCallRemaining({ ...contractCtx, state: ctx.state }, remainingMs),
        );
      },
    } satisfies typeof brapiGermplasmPerformance;
    const startedAt = Date.now();
    const result = await runToolContract(definition, input, { context: { tenantId: 't1' } });
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    return { result, text, elapsedMs: Date.now() - startedAt };
  }

  it('a stalled /germplasm/{id} with studyDbIds supplied ends at the call deadline', async () => {
    const ctx = await connect(fetcher);
    stallOn((path) => path.includes('/germplasm/'));

    const { result, text, elapsedMs } = await run(ctx, 300, {
      germplasmDbId: 'germplasm1',
      studyDbIds: ['study1'],
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.Timeout, data: { reason: 'call_deadline_exceeded' } },
    });
    expect(text).toContain("did not finish within this call's 50 s deadline");
    expect(text).toMatch(/Recovery: /);
    expect(elapsedMs).toBeLessThan(1_000);
  });
});
