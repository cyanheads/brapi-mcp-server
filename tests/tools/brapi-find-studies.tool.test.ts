/**
 * @fileoverview End-to-end tests for brapi_find_studies — capability gate,
 * named + extraFilters merge, distribution computation, dataset spillover
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

async function connect(fetcher: MockFetcher, calls = ['studies']) {
  fetcher.mockImplementation(async (url: string) => {
    const path = pathnameOf(url);
    if (path.endsWith('/serverinfo')) {
      return jsonResponse(
        envelope({
          serverName: 'Test',
          calls: calls.map((service) => ({ service, methods: ['GET'], versions: ['2.1'] })),
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
    expect(result.dataset).toBeUndefined();
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

  it('spills to DatasetStore when totalCount exceeds loadLimit', async () => {
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
    expect(result.dataset).toBeDefined();
    expect(result.dataset?.rowCount).toBe(25);
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
});
