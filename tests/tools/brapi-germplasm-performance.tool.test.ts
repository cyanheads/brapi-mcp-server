/**
 * @fileoverview Tests for brapi_germplasm_performance — germplasm existence,
 * study discovery with the dialect-honor cross-check, the study-anchored →
 * germplasm-anchored observation fallback (mirroring the BrAPI test server,
 * which ignores the studyDbId filter on /observations), per-variable
 * aggregation, and the typed error contract.
 *
 * @module tests/tools/brapi-germplasm-performance.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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

  it('throws unknown_alias when no connection is registered for the alias', async () => {
    const ctx = createMockContext({ tenantId: 't2', errors: brapiGermplasmPerformance.errors });
    await expect(
      brapiGermplasmPerformance.handler(
        brapiGermplasmPerformance.input.parse({ germplasmDbId: 'germplasm1', alias: 'nope' }),
        ctx,
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
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

    expect(result.warnings.some((w) => /ignore the germplasm filter on \/studies/i.test(w))).toBe(
      true,
    );
    // Still aggregates from the per-study (germplasm-scoped) pull.
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
});
