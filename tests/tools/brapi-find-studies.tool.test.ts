/**
 * @fileoverview End-to-end tests for brapi_find_studies — capability gate,
 * named + extraFilters merge, distribution computation, dataframe spillover
 * when the upstream total exceeds loadLimit.
 *
 * @module tests/tools/brapi-find-studies.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiFindStudies } from '@/mcp-server/tools/definitions/brapi-find-studies.tool.js';
import {
  BASE_URL,
  envelope,
  initTestServices,
  jsonResponse,
  type MockFetcher,
  pathnameOf,
  resetTestServices,
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

describe('brapi_find_studies tool', () => {
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

    expect(result.returnedCount).toBe(3);
    expect(result.totalCount).toBe(3);
    expect(result.hasMore).toBe(false);
    expect(result.dataframe).toBeUndefined();
    expect(result.distributions.programName).toEqual({
      'Cassava Breeding': 2,
      'Yam Breeding': 1,
    });
    expect(result.distributions.seasons).toEqual({ '2022': 2, '2021': 1 });
    expect(result.appliedFilters.commonCropNames).toEqual(['Cassava']);
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

    const result = await brapiFindStudies.handler(
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
    expect(result.appliedFilters.commonCropNames).toEqual(['Cassava']);
    expect(result.warnings.some((w) => w.includes('POST /search/studies'))).toBe(true);
  });

  it('merges extraFilters with named params and warns on overrides', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));

    const result = await brapiFindStudies.handler(
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
    expect(result.warnings).toContain(
      'extraFilters.commonCropNames was overridden by the named param (named params take precedence).',
    );
  });

  it('spills to a canvas dataframe when totalCount exceeds loadLimit', async () => {
    const ctx = await connect(fetcher);
    const totalCount = 25; // loadLimit from TEST_CONFIG is 10
    // Build 25 rows split across 3 pages of 10 (last page has 5)
    const allRows = Array.from({ length: totalCount }, (_, i) => studyRow(`s${i + 1}`));

    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(String(url));
      const page = Number.parseInt(u.searchParams.get('page') ?? '0', 10);
      const pageSize = Number.parseInt(u.searchParams.get('pageSize') ?? '10', 10);
      const slice = allRows.slice(page * pageSize, page * pageSize + pageSize);
      return jsonResponse(envelope({ data: slice }, { totalCount }));
    });

    const result = await brapiFindStudies.handler(
      brapiFindStudies.input.parse({ crop: 'Cassava', loadLimit: 10 }),
      ctx,
    );

    expect(result.hasMore).toBe(true);
    expect(result.totalCount).toBe(25);
    expect(result.returnedCount).toBe(10); // in-context truncated to loadLimit
    expect(result.dataframe).toBeDefined();
    expect(result.dataframe?.rowCount).toBe(25);
    expect(result.refinementHint).toMatch(/25 rows exceed loadLimit=10/);
    // Distributions computed from full set — 25 programName hits
    expect(Object.values(result.distributions.programName).reduce((a, b) => a + b, 0)).toBe(25);
  });

  it('throws ValidationError when the server does not advertise /studies', async () => {
    const ctx = await connect(fetcher, ['germplasm']);
    await expect(
      brapiFindStudies.handler(brapiFindStudies.input.parse({ crop: 'Cassava' }), ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
  });

  it('throws NotFound when no connection exists for the alias', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    await expect(
      brapiFindStudies.handler(
        brapiFindStudies.input.parse({ alias: 'missing', crop: 'Cassava' }),
        ctx,
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
  });

  it('downcasts plural filters to singular when connected to a CassavaBase server', async () => {
    const ctx = await connect(fetcher, ['studies'], 'CassavaBase');
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));

    const result = await brapiFindStudies.handler(
      brapiFindStudies.input.parse({
        crop: 'Cassava',
        seasons: ['2022'],
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
    expect(result.appliedFilters).toEqual({
      commonCropName: 'Cassava',
      seasonDbId: '2022',
      programDbId: '162',
    });
  });

  it('warns when CassavaBase dialect downcasts a multi-value array', async () => {
    const ctx = await connect(fetcher, ['studies'], 'CassavaBase');
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));

    const result = await brapiFindStudies.handler(
      brapiFindStudies.input.parse({
        seasons: ['2022', '2023', '2024'],
      }),
      ctx,
    );

    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.getAll('seasonDbId')).toEqual(['2022']);
    expect(result.warnings.some((w) => /'seasonDbIds' downcast to 'seasonDbId'/.test(w))).toBe(
      true,
    );
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

    const result = await brapiFindStudies.handler(
      brapiFindStudies.input.parse({ locations: ['3'], programs: ['99'], trials: ['88'] }),
      ctx,
    );

    expect(result.warnings.some((w) => /Filter 'locations' requested .*\["3"\]/.test(w))).toBe(
      true,
    );
    expect(result.warnings.some((w) => /Filter 'programs' requested .*\["99"\]/.test(w))).toBe(
      true,
    );
    expect(result.warnings.some((w) => /Filter 'trials' requested .*\["88"\]/.test(w))).toBe(true);
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
    expect(result.returnedCount).toBe(1);
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
    expect(result.returnedCount).toBe(3);
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
});
