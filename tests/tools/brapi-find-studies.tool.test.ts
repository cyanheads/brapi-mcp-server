/**
 * @fileoverview End-to-end tests for brapi_find_studies — capability gate,
 * named + extraFilters merge, distribution computation, dataframe spillover
 * when the upstream total exceeds loadLimit.
 *
 * @module tests/tools/brapi-find-studies.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { forbidden, JsonRpcErrorCode, unauthorized } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiFindStudies } from '@/mcp-server/tools/definitions/brapi-find-studies.tool.js';
import { getCanvasBridge } from '@/services/canvas-bridge/index.js';
import {
  BASE_URL,
  envelope,
  initTestServices,
  jsonResponse,
  type MockFetcher,
  pathnameOf,
  resetTestServices,
  stalledResponse,
  withCallRemaining,
} from './_tool-test-helpers.js';

function studyRow(dbId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    studyDbId: dbId,
    studyName: `Study ${dbId}`,
    studyType: 'Yield Trial',
    programName: 'Cassava Breeding',
    trialName: 'Advanced Yield',
    locationName: 'NCSU Station 1',
    commonCropName: 'Cassava',
    seasons: ['2022'],
    ...extra,
  };
}

type TestCall = string | { methods?: ('GET' | 'POST')[]; service: string };

async function connect(fetcher: MockFetcher, calls: TestCall[] = ['studies'], serverName = 'Test') {
  fetcher.mockImplementation(async (url: string) => {
    const path = pathnameOf(url);
    if (path.endsWith('/serverinfo')) {
      return jsonResponse(
        envelope({
          serverName,
          calls: calls.map((call) =>
            typeof call === 'string'
              ? { service: call, methods: ['GET'], versions: ['2.1'] }
              : { ...call, methods: call.methods ?? ['GET'], versions: ['2.1'] },
          ),
        }),
      );
    }
    if (path.endsWith('/commoncropnames')) {
      return jsonResponse(envelope({ data: ['Cassava'] }));
    }
    if (path.endsWith('/studies')) {
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    }
    throw new Error(`Unexpected connect path: ${path}`);
  });
  const ctx = createMockContext({ tenantId: 't1' });
  await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
  fetcher.mockReset();
  return ctx;
}

/** Serve `rows` as a paged /studies list that ignores every filter; any other URL fails. */
function serveStudies(fetcher: MockFetcher, rows: Record<string, unknown>[]): void {
  fetcher.mockImplementation(async (url: string) => {
    const u = new URL(String(url));
    if (u.hostname !== 'brapi.example.org' || u.pathname !== '/brapi/v2/studies') {
      throw new Error(`unmocked fetch: ${u.href}`);
    }
    const page = Number.parseInt(u.searchParams.get('page') ?? '0', 10);
    const pageSize = Number.parseInt(u.searchParams.get('pageSize') ?? '10', 10);
    return jsonResponse(
      envelope(
        { data: rows.slice(page * pageSize, page * pageSize + pageSize) },
        { totalCount: rows.length },
      ),
    );
  });
}

const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

/** Run the tool through `runToolContract` against the connection registered on `ctx`. */
async function callContract(ctx: Context, input: Record<string, unknown>) {
  const definition = {
    ...brapiFindStudies,
    handler: (parsed, contractCtx) =>
      brapiFindStudies.handler(parsed, { ...contractCtx, state: ctx.state }),
  } satisfies typeof brapiFindStudies;
  const result = await runToolContract(definition, input, { context: { tenantId: 't1' } });
  return {
    result,
    structured: result.structuredContent as Record<string, unknown>,
    text: textOf(result),
  };
}

describe('brapi_find_studies tool', () => {
  it('keeps SGN normalized program fields in inline rows, distributions and staged rows', async () => {
    const ctx = await connect(fetcher, ['studies'], 'Breedbase');
    const rows = Array.from({ length: 12 }, (_, i) => ({
      studyDbId: `s${i}`,
      additionalInfo: { programDbId: 'p1', programName: 'Program', retained: null },
      seasons: i === 0 ? ['2011'] : ['2018'],
    }));
    serveStudies(fetcher, rows);
    const staged = vi.spyOn(getCanvasBridge(), 'registerDataframe');
    const definition = {
      ...brapiFindStudies,
      handler: (input, contractCtx) =>
        brapiFindStudies.handler(input, { ...contractCtx, state: ctx.state }),
    } satisfies typeof brapiFindStudies;
    const result = await runToolContract(
      definition,
      { programs: ['p1'], loadLimit: 1 },
      { context: { tenantId: 't1' } },
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      results: [
        { programDbId: 'p1', programName: 'Program', additionalInfo: rows[0]?.additionalInfo },
      ],
      distributions: { programName: { Program: 12 }, seasons: { '2011': 1, '2018': 11 } },
      dataframe: { rowCount: 12 },
    });
    expect(textOf(result)).toContain('2018 (11), 2011 (1)');
    expect(textOf(result)).toContain('Program (12)');
    expect(staged).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        rows: rows.map((row) => ({ ...row, programDbId: 'p1', programName: 'Program' })),
      }),
    );
    const structured = result.structuredContent as { warnings?: string[] };
    expect(structured.warnings?.some((warning) => warning.includes("Filter 'programs'"))).not.toBe(
      true,
    );
  });
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('returns rows and distributions when totalCount <= loadLimit', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      studyRow('s1'),
      studyRow('s2', { programName: 'Yam Breeding', seasons: ['2021'] }),
      studyRow('s3', { locationName: 'Cornell' }),
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiFindStudies.handler(
      brapiFindStudies.input.parse({ crop: 'Cassava' }),
      ctx,
    );

    expect(getEnrichment(ctx).returnedCount).toBe(3);
    expect(getEnrichment(ctx).totalCount).toBe(3);
    expect(result.hasMore).toBe(false);
    expect(result.dataframe).toBeUndefined();
    expect(result.distributions.programName).toEqual({
      'Cassava Breeding': 2,
      'Yam Breeding': 1,
    });
    expect(result.distributions.seasons).toEqual({ '2022': 2, '2021': 1 });
    expect(getEnrichment(ctx).appliedFilters.commonCropNames).toEqual(['Cassava']);
    // Inside both inline bounds: no truncation disclosure.
    for (const key of ['truncated', 'shown', 'cap', 'notice']) {
      expect(getEnrichment(ctx)).not.toHaveProperty(key);
    }
  });

  it('passes named filters as BrAPI query params', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));

    await brapiFindStudies.handler(
      brapiFindStudies.input.parse({
        crop: 'Cassava',
        seasons: ['2022', '2023'],
        programs: ['prog-1'],
        loadLimit: 10,
      }),
      ctx,
    );

    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.getAll('commonCropNames')).toEqual(['Cassava']);
    expect(url.searchParams.getAll('seasonDbIds')).toEqual(['2022', '2023']);
    expect(url.searchParams.getAll('programDbIds')).toEqual(['prog-1']);
    expect(url.searchParams.get('pageSize')).toBe('10');
  });

  it('falls back to POST /search/studies when GET /studies is not advertised', async () => {
    const ctx = await connect(fetcher, [{ service: 'search/studies', methods: ['POST'] }]);
    const rows = [studyRow('s1')];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    await brapiFindStudies.handler(
      brapiFindStudies.input.parse({ crop: 'Cassava', loadLimit: 10 }),
      ctx,
    );

    const url = new URL(String(fetcher.mock.calls[0]![0]));
    const options = fetcher.mock.calls[0]![3] as { body: string; method: string };
    expect(url.pathname).toBe('/brapi/v2/search/studies');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toMatchObject({
      commonCropNames: ['Cassava'],
      page: 0,
      pageSize: 10,
    });
    expect(getEnrichment(ctx).appliedFilters.commonCropNames).toEqual(['Cassava']);
    expect(getEnrichment(ctx).warnings.some((w) => w.includes('POST /search/studies'))).toBe(true);
  });

  it('merges extraFilters with named params and warns on overrides', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));

    await brapiFindStudies.handler(
      brapiFindStudies.input.parse({
        crop: 'Cassava',
        extraFilters: {
          commonCropNames: ['Yam'], // conflict — named should win
          studyCodes: ['IBA-YT-22'], // not in named
        },
      }),
      ctx,
    );

    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.getAll('commonCropNames')).toEqual(['Cassava']);
    expect(url.searchParams.getAll('studyCodes')).toEqual(['IBA-YT-22']);
    expect(getEnrichment(ctx).warnings).toContain(
      'extraFilters.commonCropNames was overridden by the named param (named params take precedence).',
    );
  });

  it('warns when an extraFilters key is unhonored by the upstream', async () => {
    // Repro: agent passes `extraFilters: { locationName: 'Ibadan' }`. The
    // server doesn't honor it (locationName isn't a valid filter — the spec
    // key is locationDbIds), returns rows spanning many locations, and the
    // post-hoc validator must surface the discrepancy as a warning rather
    // than the trace falsely asserting the filter was applied.
    const ctx = await connect(fetcher);
    const rows = [
      studyRow('s1', { locationName: 'Ibadan' }),
      studyRow('s2', { locationName: 'Ubiaja' }),
      studyRow('s3', { locationName: 'Mokwa' }),
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    await brapiFindStudies.handler(
      brapiFindStudies.input.parse({
        extraFilters: { locationName: 'Ibadan' },
      }),
      ctx,
    );

    expect(
      getEnrichment(ctx).warnings.some(
        (w) =>
          w.includes("Filter 'extraFilters.locationName'") &&
          w.includes('returned row(s) carried other values'),
      ),
    ).toBe(true);
  });

  it('warns when an extraFilters key cannot be cross-referenced against rows', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(
      jsonResponse(envelope({ data: [studyRow('s1')] }, { totalCount: 1 })),
    );

    await brapiFindStudies.handler(
      brapiFindStudies.input.parse({
        extraFilters: { madeUpFilter: 'whatever' },
      }),
      ctx,
    );

    expect(
      getEnrichment(ctx).warnings.some(
        (w) => w.includes('Could not verify these extraFilters keys') && w.includes('madeUpFilter'),
      ),
    ).toBe(true);
  });

  it('spills to a canvas dataframe when totalCount exceeds loadLimit', async () => {
    const ctx = await connect(fetcher);
    // 25 rows across 3 pages of 10 (the last has 5).
    serveStudies(
      fetcher,
      Array.from({ length: 25 }, (_, i) => studyRow(`s${i + 1}`)),
    );

    const result = await brapiFindStudies.handler(
      brapiFindStudies.input.parse({ crop: 'Cassava', loadLimit: 10 }),
      ctx,
    );

    expect(result.hasMore).toBe(true);
    expect(getEnrichment(ctx).totalCount).toBe(25);
    expect(getEnrichment(ctx).returnedCount).toBe(10); // in-context truncated to loadLimit
    expect(getEnrichment(ctx)).toMatchObject({ truncated: true, shown: 10, cap: 10 });
    expect(getEnrichment(ctx).notice).toContain('loadLimit (10)');
    expect(result.dataframe).toBeDefined();
    expect(result.dataframe?.rowCount).toBe(25);
    expect(getEnrichment(ctx).refinementHint).toMatch(
      /^All 25 matched rows are in dataframe `df_[^`]+`: narrow them there with brapi_dataframe_query/,
    );
    // Distributions computed from full set — 25 programName hits
    expect(Object.values(result.distributions.programName).reduce((a, b) => a + b, 0)).toBe(25);
  });

  it('throws ValidationError when the server does not advertise /studies', async () => {
    const ctx = await connect(fetcher, ['germplasm']);
    await expect(
      brapiFindStudies.handler(brapiFindStudies.input.parse({ crop: 'Cassava' }), ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
  });

  it('fails NotFound with the unknown_alias recovery hint when no connection exists for the alias', async () => {
    const result = await runToolContract(
      brapiFindStudies,
      { alias: 'missing', crop: 'Cassava' },
      { context: { tenantId: 't1' } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'unknown_alias',
          alias: 'missing',
          recovery: { hint: expect.stringContaining('brapi_connect') },
        },
      },
    });
  });

  it('connects a built-in alias on first use, with no brapi_connect (#59)', async () => {
    vi.stubEnv('BRAPI_BTI_BREEDBASE_DEMO_BASE_URL', '');
    vi.stubEnv('BRAPI_BUILTIN_ALIASES_DISABLED', '');
    const rows = [studyRow('s1'), studyRow('s2')];
    fetcher.mockImplementation(async (url: string) => {
      const { hostname, pathname } = new URL(String(url));
      if (hostname !== 'breedbase.org') throw new Error(`Unmocked fetcher call: ${url}`);
      if (pathname.endsWith('/serverinfo')) {
        return jsonResponse(
          envelope({ serverName: 'Demo', calls: [{ service: 'studies', methods: ['GET'] }] }),
        );
      }
      if (pathname.endsWith('/studies')) {
        return jsonResponse(envelope({ data: rows }, { totalCount: rows.length }));
      }
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });

    const result = await runToolContract(
      brapiFindStudies,
      { alias: 'bti-breedbase-demo' },
      { context: { tenantId: 't1' } },
    );

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      results: [{ studyDbId: 's1' }, { studyDbId: 's2' }],
    });
    expect(textOf(result)).toContain('Study s1');
    const paths = fetcher.mock.calls.map(([url]) => pathnameOf(url));
    expect(paths.filter((p) => p.endsWith('/serverinfo'))).toHaveLength(1);
  });

  describe('connection failures carry their recovery hints', () => {
    const host = new URL(BASE_URL).hostname;
    /** Answer every discovery request on the configured host with HTTP `status`. */
    function wallDiscovery(status: 401 | 403) {
      fetcher.mockImplementation(async (url: string) => {
        if (new URL(String(url)).hostname !== host)
          throw new Error(`Unmocked fetcher call: ${url}`);
        const message = `Fetch failed. Status: ${status}`;
        throw status === 401 ? unauthorized(message, { status }) : forbidden(message, { status });
      });
    }

    it('fills the upstream_unauthorized hint when first-use discovery hits a login wall', async () => {
      vi.stubEnv('BRAPI_DEFAULT_BASE_URL', BASE_URL);
      wallDiscovery(401);

      const result = await runToolContract(brapiFindStudies, {}, { context: { tenantId: 't1' } });

      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.Unauthorized,
          data: {
            reason: 'upstream_unauthorized',
            recovery: { hint: expect.stringContaining('then retry brapi_find_studies') },
          },
        },
      });
      expect(textOf(result)).toContain('server-side credentials for this alias');
    });

    it('fills the upstream_forbidden hint when an expired capability cache meets a 403', async () => {
      const { state } = createMockContext({ tenantId: 't1' });
      await state.set('brapi/conn/default', {
        alias: 'default',
        baseUrl: BASE_URL,
        authMode: 'none',
        registeredAt: '2026-10-17T00:00:00.000Z',
      });
      // Registered, but no cached profile: ensure() rediscovers.
      const definition = {
        ...brapiFindStudies,
        handler(input, contractCtx) {
          return brapiFindStudies.handler(input, { ...contractCtx, state });
        },
      } satisfies typeof brapiFindStudies;
      wallDiscovery(403);

      const result = await runToolContract(definition, {}, { context: { tenantId: 't1' } });

      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.Forbidden,
          data: {
            reason: 'upstream_forbidden',
            recovery: { hint: expect.stringContaining('then retry brapi_find_studies') },
          },
        },
      });
    });

    it('fills the alias_base_url_invalid hint naming the variable to fix, with no request', async () => {
      vi.stubEnv('BRAPI_FOO_BASE_URL', 'notaurl');

      const result = await runToolContract(
        brapiFindStudies,
        { alias: 'foo' },
        { context: { tenantId: 't1' } },
      );

      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ConfigurationError,
          data: {
            reason: 'alias_base_url_invalid',
            recovery: { hint: expect.stringContaining('BRAPI_FOO_BASE_URL') },
          },
        },
      });
      expect(textOf(result)).not.toContain('notaurl');
      expect(fetcher).not.toHaveBeenCalled();
    });
  });

  it('downcasts plural filters to singular on CassavaBase, warning when a multi-value list loses values', async () => {
    const ctx = await connect(fetcher, ['studies'], 'CassavaBase');
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));

    await brapiFindStudies.handler(
      brapiFindStudies.input.parse({
        crop: 'Cassava',
        seasons: ['2022', '2023', '2024'],
        programs: ['162'],
      }),
      ctx,
    );

    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.getAll('commonCropName')).toEqual(['Cassava']);
    expect(url.searchParams.getAll('seasonDbId')).toEqual(['2022']);
    expect(url.searchParams.getAll('programDbId')).toEqual(['162']);
    expect(url.searchParams.has('commonCropNames')).toBe(false);
    expect(url.searchParams.has('seasonDbIds')).toBe(false);
    expect(url.searchParams.has('programDbIds')).toBe(false);
    expect(getEnrichment(ctx).appliedFilters).toEqual({
      commonCropName: 'Cassava',
      seasonDbId: '2022',
      programDbId: '162',
    });
    expect(
      getEnrichment(ctx).warnings.some((w) => /'seasonDbIds' downcast to 'seasonDbId'/.test(w)),
    ).toBe(true);
  });

  it('warns when locations / programs / trials filter requested but no rows match', async () => {
    const ctx = await connect(fetcher);
    // Server returns rows with locationDbIds the agent didn't ask for —
    // simulating the CassavaBase pattern where the filter is silently ignored.
    fetcher.mockResolvedValue(
      jsonResponse(
        envelope(
          {
            data: [
              {
                studyDbId: 's-1',
                studyName: 'Study One',
                locationDbId: '23',
                locationName: 'Mokwa',
                programDbId: '7',
                trialDbId: '4',
              },
              {
                studyDbId: 's-2',
                studyName: 'Study Two',
                locationDbId: '45',
                locationName: 'Zaria',
                programDbId: '7',
                trialDbId: '4',
              },
            ],
          },
          { totalCount: 2 },
        ),
      ),
    );

    await brapiFindStudies.handler(
      brapiFindStudies.input.parse({ locations: ['3'], programs: ['99'], trials: ['88'] }),
      ctx,
    );

    expect(
      getEnrichment(ctx).warnings.some((w) => /Filter 'locations' requested .*\["3"\]/.test(w)),
    ).toBe(true);
    expect(
      getEnrichment(ctx).warnings.some((w) => /Filter 'programs' requested .*\["99"\]/.test(w)),
    ).toBe(true);
    expect(
      getEnrichment(ctx).warnings.some((w) => /Filter 'trials' requested .*\["88"\]/.test(w)),
    ).toBe(true);
  });

  // Cassavabase returns null for many optional string fields rather than
  // omitting them. Schemas use .nullish() so the handler accepts both shapes.
  it('tolerates null values on optional string fields (Cassavabase shape)', async () => {
    const ctx = await connect(fetcher);
    const sparseRow = {
      studyDbId: 's-cb-1',
      studyName: '00ayt11interspecIB',
      studyType: 'Advanced Yield Trial',
      trialName: '00_Ibadan',
      locationName: 'Ibadan',
      commonCropName: 'Cassava',
      seasons: ['2000'],
      active: true,
      // Fields Cassavabase returns as null in the wild:
      studyCode: null,
      studyPUI: null,
      studyDescription: null,
      programDbId: null,
      programName: null,
      locationDbId: null,
    };
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [sparseRow] }, { totalCount: 1 })));
    const result = await brapiFindStudies.handler(brapiFindStudies.input.parse({}), ctx);
    expect(getEnrichment(ctx).returnedCount).toBe(1);
    expect(result.results[0]?.studyCode).toBeNull();
    expect(result.results[0]?.studyName).toBe('00ayt11interspecIB');
  });

  // The breedbase.org demo deployment serves studies with a literal null
  // inside the seasons array — the per-row schema must accept this shape
  // without rejecting the whole batch, and downstream consumers (distribution
  // computation, format renderer) must skip the null entry.
  it('tolerates null entries inside the seasons array (breedbase demo shape)', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      studyRow('s-bd-1', { seasons: [null] as unknown as string[] }),
      studyRow('s-bd-2', { seasons: ['2024'] }),
      studyRow('s-bd-3', { seasons: [null, '2023'] as unknown as string[] }),
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: 3 })));
    const result = await brapiFindStudies.handler(brapiFindStudies.input.parse({}), ctx);
    expect(getEnrichment(ctx).returnedCount).toBe(3);
    // Distribution should count only the non-null values.
    expect(result.distributions.seasons).toEqual({ '2024': 1, '2023': 1 });
    // Null entries pass through to results as-is — schema is permissive, the
    // format renderer is responsible for filtering before display.
    expect(result.results[0]?.seasons).toEqual([null]);
    expect(result.results[2]?.seasons).toEqual([null, '2023']);
    // Format output should not render `null` as a literal "null" string.
    const formatted = brapiFindStudies.format!(result);
    expect(typeof formatted).toBe('object');
    const text = (formatted as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).not.toMatch(/seasons=null/);
    expect(text).not.toMatch(/seasons=,/);
    expect(text).toMatch(/seasons=2023/);
  });

  it('a stalled first page ends at the call deadline with a Timeout', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(
      (_url: string, timeoutMs: number, _ctx: unknown, init?: { signal?: AbortSignal }) =>
        stalledResponse(timeoutMs, init?.signal),
    );
    const startedAt = Date.now();

    await expect(
      brapiFindStudies.handler(brapiFindStudies.input.parse({}), withCallRemaining(ctx, 300)),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'call_deadline_exceeded', recovery: { hint: expect.any(String) } },
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});

describe('brapi_find_studies locations on dialects that drop locationDbIds', () => {
  // TEST_CONFIG pageSize is 10, so one spill walk scans at most 10 × 50 = 500 rows.
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  /** The paged /studies fake ignores every location filter, as SGN servers do. */
  const serve = (rows: Record<string, unknown>[]) => serveStudies(fetcher, rows);
  const call = callContract;

  const ids = (s: Record<string, unknown>) =>
    (s.results as { studyDbId: string }[]).map((r) => r.studyDbId);

  /** breedbase.org shape: five studies at location 23, one with a null locationDbId. */
  const demoStudies = () => [
    studyRow('s1', { locationDbId: '23', seasons: ['2022'] }),
    studyRow('s2', { locationDbId: '23', seasons: ['2021'] }),
    studyRow('s3', { locationDbId: '23', seasons: ['2022'] }),
    studyRow('s4', { locationDbId: '24', seasons: ['2022'] }),
    studyRow('s5', { locationDbId: '23', seasons: ['2022'] }),
    studyRow('s135', { locationDbId: null, locationName: '' }),
  ];

  it('keeps locationDbIds on the wire and runs no row filter on a dialect that honors it', async () => {
    const ctx = await connect(fetcher);
    serve(demoStudies());

    const { structured } = await call(ctx, { locations: ['23'] });

    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.getAll('locationDbIds')).toEqual(['23']);
    expect(ids(structured)).toEqual(['s1', 's2', 's3', 's4', 's5', 's135']);
    expect(structured.totalCount).toBe(6);
    expect((structured.warnings as string[]).join('\n')).not.toContain('client-side');
    expect(structured.appliedFilters).toEqual({ locationDbIds: ['23'] });
    expect(structured).not.toHaveProperty('clientSideFilters');
  });

  it('still fails all_filters_dropped for locationDbIds passed only through extraFilters', async () => {
    const ctx = await connect(fetcher, ['studies'], 'Sweetpotatobase');
    serve(demoStudies());

    const { result } = await call(ctx, { extraFilters: { locationDbIds: ['23'] } });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'all_filters_dropped' } },
    });
  });

  it('applies a locations-only filter client-side instead of failing all_filters_dropped', async () => {
    const ctx = await connect(fetcher, ['studies'], 'Sweetpotatobase');
    serve(demoStudies());

    const { result, structured, text } = await call(ctx, { locations: ['23'] });

    expect(result.isError).toBeFalsy();
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.has('locationDbIds')).toBe(false);
    expect(url.searchParams.has('locationDbId')).toBe(false);
    expect(ids(structured)).toEqual(['s1', 's2', 's3', 's5']);
    expect(structured.returnedCount).toBe(4);
    expect(structured.totalCount).toBe(4);
    expect(structured.hasMore).toBe(false);
    expect(structured.distributions).toMatchObject({ seasons: { '2022': 3, '2021': 1 } });
    expect(structured.warnings).toContain(
      "Filter 'locations' applied client-side — this server ignores locationDbIds on /studies. 4 of 6 upstream studies matched; a study with no locationDbId never matches.",
    );
    expect(text).toContain("Filter 'locations' applied client-side");
    expect(text).not.toContain("dropped filter 'locationDbIds'");
    // Listed under Applied Filters, marked as not sent upstream.
    expect(structured.appliedFilters).toEqual({});
    expect(structured.clientSideFilters).toEqual({ locations: ['23'] });
    expect(text).toContain(
      '**Applied Filters:** none sent upstream\n- **locations:** 23 _(applied client-side: this server ignores it, so it was not sent upstream)_',
    );
    expect(text).not.toMatch(/\*\*Applied Filters:\*\* none$/m);
  });

  it('matches every listed location ID', async () => {
    const ctx = await connect(fetcher, ['studies'], 'CassavaBase');
    serve(demoStudies());

    const { structured } = await call(ctx, { locations: ['23', '24'] });

    expect(ids(structured)).toEqual(['s1', 's2', 's3', 's4', 's5']);
  });

  it('keeps seasons on the wire and filters by location client-side, listing both filters', async () => {
    const ctx = await connect(fetcher, ['studies'], 'CassavaBase');
    serve(demoStudies().filter((s) => (s.seasons as string[] | undefined)?.includes('2022')));

    const { structured, text } = await call(ctx, { locations: ['23'], seasons: ['2022'] });

    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.getAll('seasonDbId')).toEqual(['2022']);
    expect(url.searchParams.has('locationDbId')).toBe(false);
    expect(structured.appliedFilters).toEqual({ seasonDbId: '2022' });
    expect(ids(structured)).toEqual(['s1', 's3', 's5']);
    expect(text).toContain(
      '**Applied Filters:**\n- **seasons:** 2022\n\n- **locations:** 23 _(applied client-side',
    );
  });

  it('returns zero rows and a warning, with no dataframe, when no study is at the location', async () => {
    const ctx = await connect(fetcher, ['studies'], 'Sweetpotatobase');
    serve(Array.from({ length: 25 }, (_, i) => studyRow(`s${i + 1}`, { locationDbId: '23' })));

    const { result, structured, text } = await call(ctx, { locations: ['99999'], loadLimit: 5 });

    expect(result.isError).toBeFalsy();
    // First page + the spill walk (pages 0–2 at pageSize 10).
    expect(fetcher.mock.calls.length).toBe(4);
    expect(structured.results).toEqual([]);
    expect(structured).not.toHaveProperty('dataframe');
    expect(structured.totalCount).toBe(0);
    expect(structured.hasMore).toBe(false);
    expect(structured.notice).toMatch(/No rows returned/);
    expect(structured.warnings).toContain(
      "Filter 'locations' applied client-side — this server ignores locationDbIds on /studies. 0 of 25 upstream studies matched; a study with no locationDbId never matches.",
    );
    expect(text).not.toContain('Table schema');
  });

  it('filters every page of a multi-page spill and returns the filtered rows inline', async () => {
    const ctx = await connect(fetcher, ['studies'], 'Sweetpotatobase');
    const rows = Array.from({ length: 25 }, (_, i) =>
      studyRow(`s${i + 1}`, { locationDbId: [3, 14, 25].includes(i + 1) ? '23' : '7' }),
    );
    serve(rows);

    const { structured } = await call(ctx, { locations: ['23'], loadLimit: 2 });

    // s14 and s25 sit on walk pages 1 and 2; today `results` is the unfiltered first page.
    expect(ids(structured)).toEqual(['s3', 's14']);
    expect(structured.returnedCount).toBe(2);
    expect(structured.totalCount).toBe(3);
    expect(structured.hasMore).toBe(true);
    expect(structured.dataframe).toMatchObject({ rowCount: 3, totalCount: 25 });
  });

  it('says only the first N of M studies were checked when the walk stops at its ceiling', async () => {
    const ctx = await connect(fetcher, ['studies'], 'Sweetpotatobase');
    const rows = Array.from({ length: 600 }, (_, i) =>
      studyRow(`s${i + 1}`, { locationDbId: i + 1 === 7 || i + 1 === 550 ? '23' : '7' }),
    );
    serve(rows);

    const { structured } = await call(ctx, { locations: ['23'], loadLimit: 5 });

    expect(fetcher.mock.calls.length).toBe(1 + 50);
    expect(ids(structured)).toEqual(['s7']);
    expect(structured.totalCount).toBe(1);
    expect(structured.hasMore).toBe(true);
    // The one match is inline, so nothing is staged; the page-cap warning carries the stop.
    expect(structured).not.toHaveProperty('dataframe');
    expect(structured.warnings).toContain(
      "Filter 'locations' applied client-side — this server ignores locationDbIds on /studies. 1 matched among the first 500 of 600 upstream studies; the rest were not checked. Narrow with crop, seasons, programs, or trials to bring the set into one scan.",
    );
    expect((structured.warnings as string[]).join('\n')).toMatch(/50-page walk cap was reached/);
  });
});

describe('brapi_find_studies inline budget (#66)', () => {
  // Budget bounds, staging, and walk stops are tabled at their seam in
  // tests/tools/shared/find-helpers.test.ts; this proves the tool wires them.
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('trims results[] to the byte budget inside loadLimit and stages the whole match', async () => {
    const ctx = await connect(fetcher);
    // ~5 KB per study: four fit the 24,000-byte budget, five do not.
    serveStudies(
      fetcher,
      Array.from({ length: 8 }, (_, i) =>
        studyRow(`s${i + 1}`, { studyDescription: 'd'.repeat(4_800) }),
      ),
    );

    // loadLimit defaults to BRAPI_LOAD_LIMIT's 1,000, well above what fits.
    const { result, structured, text } = await callContract(ctx, {});

    expect(result.isError).toBeFalsy();
    expect(fetcher.mock.calls.length).toBe(1);
    expect((structured.results as unknown[]).length).toBe(4);
    expect(Buffer.byteLength(JSON.stringify(structured.results), 'utf8')).toBeLessThanOrEqual(
      24_000,
    );
    expect(structured).toMatchObject({
      returnedCount: 4,
      totalCount: 8,
      hasMore: true,
      truncated: true,
      shown: 4,
      cap: 1_000,
      dataframe: { rowCount: 8, totalCount: 8 },
    });
    expect(structured.notice).toContain('24,000-byte inline budget');
    expect(text).toContain('24,000-byte inline budget');
    expect(text).toContain(`\`${(structured.dataframe as { tableName: string }).tableName}\``);
  });
});
