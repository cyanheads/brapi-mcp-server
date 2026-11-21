/**
 * @fileoverview End-to-end tests for brapi_find_studies — capability gate,
 * named + extraFilters merge, distribution computation, dataframe spillover
 * when the upstream total exceeds loadLimit.
 *
 * @module tests/tools/brapi-find-studies.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { forbidden, JsonRpcErrorCode, timeout, unauthorized } from '@cyanheads/mcp-ts-core/errors';
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

  it('queries each singular combination on CassavaBase and reports the full filter', async () => {
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
    expect(
      fetcher.mock.calls.map(([request]) =>
        new URL(String(request)).searchParams.get('seasonDbId'),
      ),
    ).toEqual(['2022', '2023', '2024']);
    expect(getEnrichment(ctx).appliedFilters).toEqual({
      commonCropName: 'Cassava',
      seasonDbId: ['2022', '2023', '2024'],
      programDbId: '162',
    });
    expect(
      getEnrichment(ctx).warnings.some((w) => /'seasonDbIds' downcast to 'seasonDbId'/.test(w)),
    ).toBe(false);
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

    // s14 and s25 sit on walk pages 1 and 2.
    expect(ids(structured)).toEqual(['s3', 's14']);
    expect(structured.returnedCount).toBe(2);
    expect(structured.totalCount).toBe(3);
    expect(structured.hasMore).toBe(true);
    expect(structured.dataframe).toMatchObject({ rowCount: 3, totalCount: 3 });
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

describe('brapi_find_studies variables (#130)', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  /**
   * BrAPI test server shape: each row lists the variables its study declares,
   * which disagrees with the filter — that keys on recorded observations, and
   * only `variable1` has any (in study1). study2 declares `variable2` yet the
   * filter excludes it.
   */
  const testServerStudies = () => [
    studyRow('study1', { observationVariableDbIds: ['variable1'] }),
    studyRow('study2', { observationVariableDbIds: ['variable4', 'variable3', 'variable2'] }),
    studyRow('study3', { observationVariableDbIds: [] }),
  ];
  const TEST_SERVER_RECORDED: Record<string, string[]> = { variable1: ['study1'] };
  const TEST_SERVER_CALLS: TestCall[] = [
    'studies',
    { service: 'search/studies', methods: ['POST'] },
  ];

  interface StudiesRequest {
    body?: Record<string, unknown>;
    method: 'GET' | 'POST';
    params: URLSearchParams;
  }

  /**
   * Serve GET /studies and POST /search/studies over `rows`. A variable filter
   * narrows to the studies `recorded` lists for its values — on GET only under
   * `getKey` (the test server and SGN honor the singular), on search always
   * (the plural body key). `ignoreVariables` answers every variable filter with
   * the full set; `omitTotal` drops totalCount; `failControl` answers 503 to any
   * request with no variable filter.
   */
  function serveVariableStudies(
    rows: Record<string, unknown>[],
    recorded: Record<string, string[]>,
    options: {
      failControl?: boolean;
      getKey?: 'observationVariableDbId' | 'observationVariableDbIds';
      ignoreVariables?: boolean;
      omitTotal?: boolean;
    } = {},
  ): StudiesRequest[] {
    const requests: StudiesRequest[] = [];
    const getKey = options.getKey ?? 'observationVariableDbId';
    fetcher.mockImplementation(
      async (url: string, _timeoutMs: number, _ctx: unknown, init?: RequestInit) => {
        const u = new URL(String(url));
        const method = init?.method === 'POST' ? 'POST' : 'GET';
        let variables: string[];
        let page: number;
        let pageSize: number;
        if (method === 'POST') {
          expect(u.pathname).toBe('/brapi/v2/search/studies');
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          requests.push({ method, params: u.searchParams, body });
          variables = (body.observationVariableDbIds as string[] | undefined) ?? [];
          page = Number(body.page ?? 0);
          pageSize = Number(body.pageSize ?? 10);
        } else {
          expect(u.pathname).toBe('/brapi/v2/studies');
          requests.push({ method, params: u.searchParams });
          variables = u.searchParams.getAll(getKey);
          page = Number(u.searchParams.get('page') ?? '0');
          pageSize = Number(u.searchParams.get('pageSize') ?? '10');
        }
        if (variables.length === 0 && options.failControl) {
          return jsonResponse({ error: 'unavailable' }, 503);
        }
        const keep =
          variables.length === 0 || options.ignoreVariables
            ? undefined
            : new Set(variables.flatMap((v) => recorded[v] ?? []));
        const matched = keep ? rows.filter((r) => keep.has(String(r.studyDbId))) : rows;
        return jsonResponse({
          metadata: {
            pagination: { pageSize, ...(options.omitTotal ? {} : { totalCount: matched.length }) },
          },
          result: { data: matched.slice(page * pageSize, (page + 1) * pageSize) },
        });
      },
    );
    return requests;
  }

  const ids = (structured: Record<string, unknown>) =>
    (structured.results as { studyDbId: string }[]).map((r) => r.studyDbId);

  describe('characterization — behavior that holds before and after #130', () => {
    it('keeps the existing study aliases routing to their filters', async () => {
      const ctx = await connect(fetcher);
      fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));

      const { result, structured } = await callContract(ctx, {
        seasonDbId: '2022',
        locationDbIds: ['loc1'],
        programDbId: 'p1',
        trialDbIds: ['t1'],
      });

      expect(result.isError).not.toBe(true);
      expect(structured.appliedFilters).toEqual({
        seasonDbIds: ['2022'],
        locationDbIds: ['loc1'],
        programDbIds: ['p1'],
        trialDbIds: ['t1'],
      });
    });

    it('sends extraFilters.observationVariableDbId as given and names it unverified', async () => {
      const ctx = await connect(fetcher, TEST_SERVER_CALLS, 'BrAPI Community Test Server');
      const requests = serveVariableStudies(testServerStudies(), TEST_SERVER_RECORDED);

      const { structured } = await callContract(ctx, {
        extraFilters: { observationVariableDbId: 'variable1' },
      });

      expect(ids(structured)).toEqual(['study1']);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.params.getAll('observationVariableDbId')).toEqual(['variable1']);
      expect(structured.warnings).toEqual([
        "Could not verify these extraFilters keys against returned rows: 'observationVariableDbId'. The server may have silently ignored them — check brapi_describe_filters for the valid filter keys on this endpoint.",
      ]);
    });
  });

  const variableWarning = "Could not verify whether 'variables' narrowed the study results.";
  /** Each request's variable filter (GET key or search body) and pageSize, in send order. */
  const sent = (requests: StudiesRequest[]) =>
    requests.map((r) =>
      r.method === 'POST'
        ? {
            method: r.method,
            variables: r.body?.observationVariableDbIds,
            pageSize: r.body?.pageSize,
          }
        : {
            method: r.method,
            variables: r.params.getAll('observationVariableDbId'),
            plural: r.params.getAll('observationVariableDbIds'),
            pageSize: r.params.get('pageSize'),
          },
    );

  it('returns only study1 for variable1 on the test server, verified by its count control', async () => {
    const ctx = await connect(fetcher, TEST_SERVER_CALLS, 'BrAPI Community Test Server');
    const requests = serveVariableStudies(testServerStudies(), TEST_SERVER_RECORDED);

    const { result, structured, text } = await callContract(ctx, { variables: ['variable1'] });

    expect(result.isError).not.toBe(true);
    expect(ids(structured)).toEqual(['study1']);
    expect(structured.totalCount).toBe(1);
    expect(structured.warnings).toEqual([]);
    expect(structured.appliedFilters).toEqual({ observationVariableDbId: 'variable1' });
    expect(text).toContain('- **variables:** variable1');
    expect(text).not.toContain(variableWarning);
    // The finder page, then the control: the same route without the variable, one row.
    expect(sent(requests)).toEqual([
      { method: 'GET', variables: ['variable1'], plural: [], pageSize: expect.any(String) },
      { method: 'GET', variables: [], plural: [], pageSize: '1' },
    ]);
  });

  it('returns no rows for variable2 and still verifies the filter (0 against 3)', async () => {
    const ctx = await connect(fetcher, TEST_SERVER_CALLS, 'BrAPI Community Test Server');
    serveVariableStudies(testServerStudies(), TEST_SERVER_RECORDED);

    const { structured, text } = await callContract(ctx, { variables: ['variable2'] });

    expect(structured.results).toEqual([]);
    expect(structured.totalCount).toBe(0);
    expect(structured.warnings).toEqual([]);
    expect(structured.notice).toBe(
      'No rows matched the applied filters. Try broadening crop, seasons, programs, trials, studyNames, variables, or active.',
    );
    expect(text).toContain('variables, or active');
  });

  it('routes two variables through POST /search/studies on the test server and verifies there', async () => {
    const ctx = await connect(fetcher, TEST_SERVER_CALLS, 'BrAPI Community Test Server');
    const requests = serveVariableStudies(testServerStudies(), TEST_SERVER_RECORDED);

    const { structured, text } = await callContract(ctx, {
      variables: ['variable1', 'variable2'],
    });

    expect(ids(structured)).toEqual(['study1']);
    expect(structured.appliedFilters).toEqual({
      observationVariableDbIds: ['variable1', 'variable2'],
    });
    expect(sent(requests)).toEqual([
      { method: 'POST', variables: ['variable1', 'variable2'], pageSize: expect.any(Number) },
      { method: 'POST', variables: undefined, pageSize: 1 },
    ]);
    expect(structured.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('Route escalated to POST /search/studies')]),
    );
    expect(structured.warnings).not.toContain(variableWarning);
    expect(text).toContain('- **variables:** variable1, variable2');
  });

  it('warns and keeps every row when the server answers the same total without the filter', async () => {
    // The spec dialect sends the plural on GET; a server that ignores it widens silently.
    const ctx = await connect(fetcher);
    const requests = serveVariableStudies(testServerStudies(), TEST_SERVER_RECORDED, {
      getKey: 'observationVariableDbIds',
      ignoreVariables: true,
    });

    const { structured, text } = await callContract(ctx, { variables: ['variable1'] });

    expect(ids(structured)).toEqual(['study1', 'study2', 'study3']);
    expect(requests[0]?.params.getAll('observationVariableDbIds')).toEqual(['variable1']);
    expect(structured.warnings).toEqual([variableWarning]);
    expect(text).toContain(`- ${variableWarning}`);
  });

  it('warns without sending a control when the upstream reports no total', async () => {
    const ctx = await connect(fetcher, TEST_SERVER_CALLS, 'BrAPI Community Test Server');
    const requests = serveVariableStudies(testServerStudies(), TEST_SERVER_RECORDED, {
      omitTotal: true,
    });

    const { structured } = await callContract(ctx, { variables: ['variable1'] });

    expect(ids(structured)).toEqual(['study1']);
    expect(requests).toHaveLength(1);
    expect(structured.warnings).toEqual([variableWarning]);
  });

  it('warns and keeps the filtered rows when the count control fails', async () => {
    const ctx = await connect(fetcher, TEST_SERVER_CALLS, 'BrAPI Community Test Server');
    const requests = serveVariableStudies(testServerStudies(), TEST_SERVER_RECORDED, {
      failControl: true,
    });

    const { result, structured } = await callContract(ctx, { variables: ['variable1'] });

    expect(result.isError).not.toBe(true);
    expect(ids(structured)).toEqual(['study1']);
    expect(requests).toHaveLength(2);
    expect(structured.warnings).toEqual([variableWarning]);
  });

  it.each([
    ['times out', () => timeout('Fetch timed out after 500ms', { errorSource: 'FetchTimeout' })],
    ['answers HTTP 401', () => unauthorized('Fetch failed. Status: 401', { status: 401 })],
    ['answers HTTP 403', () => forbidden('Fetch failed. Status: 403', { status: 403 })],
  ])(
    'keeps the filtered rows with the unverified warning when the count control %s',
    async (_label, failure) => {
      const ctx = await connect(fetcher, TEST_SERVER_CALLS, 'BrAPI Community Test Server');
      const requests = serveVariableStudies(testServerStudies(), TEST_SERVER_RECORDED);
      const serve = fetcher.getMockImplementation() as
        | ((url: string, ...rest: unknown[]) => Promise<Response>)
        | undefined;
      fetcher.mockImplementation(async (url: string, ...rest: unknown[]) => {
        if (!new URL(String(url)).searchParams.has('observationVariableDbId')) throw failure();
        return serve?.(url, ...rest);
      });

      const { result, structured } = await callContract(ctx, { variables: ['variable1'] });

      expect(result.isError).not.toBe(true);
      expect(ids(structured)).toEqual(['study1']);
      expect(structured.totalCount).toBe(1);
      expect(requests).toHaveLength(1);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(structured.warnings).toEqual([variableWarning]);
    },
  );

  it('unions several variables by GET on SGN and leaves the union unverified', async () => {
    // Sweetpotatobase marks POST /search/studies dead, so each variable is its own GET.
    const ctx = await connect(fetcher, TEST_SERVER_CALLS, 'Sweetpotatobase');
    const rows = ['a', 'b', 'c', 'd'].map((id) => studyRow(id));
    const requests = serveVariableStudies(rows, { '76736': ['a', 'b'], '77239': ['c'] });

    const { structured } = await callContract(ctx, { variables: ['76736', '77239'] });

    expect(ids(structured)).toEqual(['a', 'b', 'c']);
    expect(structured.totalCount).toBe(3);
    expect(structured.appliedFilters).toEqual({ observationVariableDbId: ['76736', '77239'] });
    // One GET per variable and no control request.
    expect(requests.map((r) => r.params.getAll('observationVariableDbId')).sort()).toEqual([
      ['76736'],
      ['77239'],
    ]);
    expect(structured.warnings).toEqual([variableWarning]);
  });

  it('verifies a single variable on SGN while locations apply client-side', async () => {
    const ctx = await connect(fetcher, ['studies'], 'Sweetpotatobase');
    const rows = [
      studyRow('a', { locationDbId: '23' }),
      studyRow('b', { locationDbId: '7' }),
      studyRow('c', { locationDbId: '23' }),
    ];
    const requests = serveVariableStudies(rows, { '76736': ['a', 'b'] });

    const { structured } = await callContract(ctx, { variables: ['76736'], locations: ['23'] });

    expect(ids(structured)).toEqual(['a']);
    expect(structured.totalCount).toBe(1);
    expect(structured.clientSideFilters).toEqual({ locations: ['23'] });
    // Neither the finder page nor the control sends a location; the control drops only the variable.
    expect(requests.map((r) => [...r.params.keys()].sort())).toEqual([
      ['observationVariableDbId', 'pageSize'],
      ['pageSize'],
    ]);
    expect(structured.warnings).not.toContain(variableWarning);
  });

  it('stages the matched studies past loadLimit and still verifies the filter', async () => {
    const ctx = await connect(fetcher, TEST_SERVER_CALLS, 'BrAPI Community Test Server');
    const rows = ['s1', 's2', 's3', 's4', 's5'].map((id) => studyRow(id));
    serveVariableStudies(rows, { variable1: ['s1', 's2', 's3'] });

    const { structured } = await callContract(ctx, { variables: ['variable1'], loadLimit: 1 });

    expect(ids(structured)).toEqual(['s1']);
    expect(structured).toMatchObject({
      totalCount: 3,
      hasMore: true,
      truncated: true,
      dataframe: { rowCount: 3 },
    });
    expect(structured.warnings).toEqual([]);
  });

  it.each([
    ['observationVariableDbId', 'variable1'],
    ['observationVariableDbIds', ['variable1']],
  ])('accepts %s as an alias of variables', async (key, value) => {
    const ctx = await connect(fetcher, TEST_SERVER_CALLS, 'BrAPI Community Test Server');
    serveVariableStudies(testServerStudies(), TEST_SERVER_RECORDED);

    const { result, structured } = await callContract(ctx, { [key]: value });

    expect(result.isError).not.toBe(true);
    expect(ids(structured)).toEqual(['study1']);
    expect(structured.warnings).toEqual([]);
  });

  it('rejects a blank or empty variable ID', () => {
    for (const variables of [['   '], ['variable1', ''], ['\t']]) {
      expect(brapiFindStudies.input.safeParse({ variables }).success).toBe(false);
    }
    expect(brapiFindStudies.input.safeParse({ variables: ['variable 1'] }).success).toBe(true);
  });

  it('names variables among the honored filters in the all_filters_dropped hint', async () => {
    const ctx = await connect(fetcher, ['studies'], 'Sweetpotatobase');

    const { result, text } = await callContract(ctx, { extraFilters: { locationDbIds: ['23'] } });

    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'all_filters_dropped',
          recovery: { hint: expect.stringContaining('studyNames, variables, or active') },
        },
      },
    });
    expect(text).toContain('studyNames, variables, or active');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('translates extraFilters.observationVariableDbIds on the test server and names it unverified', async () => {
    // The row field lists arrays, so no row check can speak to the filter.
    const ctx = await connect(fetcher, TEST_SERVER_CALLS, 'BrAPI Community Test Server');
    const requests = serveVariableStudies(testServerStudies(), TEST_SERVER_RECORDED);

    const { structured } = await callContract(ctx, {
      extraFilters: { observationVariableDbIds: ['variable1'] },
    });

    expect(requests[0]?.params.getAll('observationVariableDbId')).toEqual(['variable1']);
    expect(requests[0]?.params.has('observationVariableDbIds')).toBe(false);
    expect(ids(structured)).toEqual(['study1']);
    expect(structured.warnings).toEqual([
      "Could not verify these extraFilters keys against returned rows: 'observationVariableDbIds'. The server may have silently ignored them — check brapi_describe_filters for the valid filter keys on this endpoint.",
    ]);
  });

  it('narrows extraFilters.germplasmDbIds on SGN through the singular germplasmDbId', async () => {
    const ctx = await connect(fetcher, ['studies'], 'Sweetpotatobase');
    const rows = ['s1', 's2', 's3'].map((id) => studyRow(id));
    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(String(url));
      const germplasm = u.searchParams.get('germplasmDbId');
      const data = germplasm === '118251' ? rows.slice(0, 2) : rows;
      return jsonResponse(envelope({ data }, { totalCount: data.length }));
    });

    const { structured } = await callContract(ctx, {
      extraFilters: { germplasmDbIds: ['118251'] },
    });

    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.getAll('germplasmDbId')).toEqual(['118251']);
    expect(url.searchParams.has('germplasmDbIds')).toBe(false);
    expect(ids(structured)).toEqual(['s1', 's2']);
  });
});

describe('brapi_find_studies partial GET union counts (#123)', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('counts a study two seasons matched once when the third season fails, on both surfaces', async () => {
    const ctx = await connect(fetcher, ['studies'], 'CassavaBase');
    fetcher.mockImplementation(async (url: string) => {
      const season = new URL(url).searchParams.get('seasonDbId');
      if (season === '2024') return jsonResponse({ error: 'unavailable' }, 503);
      return jsonResponse(
        envelope({ data: [studyRow('S1', { seasons: ['2022', '2023'] })] }, { totalCount: 1 }),
      );
    });

    const { result, structured, text } = await callContract(ctx, {
      seasons: ['2022', '2023', '2024'],
    });

    expect(result.isError).toBeFalsy();
    expect(structured).toMatchObject({
      results: [{ studyDbId: 'S1' }],
      hasMore: true,
      totalCount: 1,
    });
    const stop = (structured.warnings as string[]).find((w) => w.startsWith('Collection'));
    expect(stop).toBe(
      'Collection incomplete at 1 distinct row(s): GET combination collection stopped early (see warnings). results[] holds every row fetched; narrow the filters or retry the call.',
    );
    expect(text).toContain(
      'Collection incomplete at 1 distinct row(s): GET combination collection stopped early',
    );
    expect(text).not.toContain('the upstream reported no total');
  });
});
