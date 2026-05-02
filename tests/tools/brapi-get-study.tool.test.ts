/**
 * @fileoverview End-to-end tests for brapi_get_study — FK resolution via
 * ReferenceDataCache, companion counts, 404 surfacing.
 *
 * @module tests/tools/brapi-get-study.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiGetStudy } from '@/mcp-server/tools/definitions/brapi-get-study.tool.js';
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
          calls: [
            { service: 'studies', methods: ['GET'], versions: ['2.1'] },
            { service: 'observations', methods: ['GET'], versions: ['2.1'] },
            { service: 'observationunits', methods: ['GET'], versions: ['2.1'] },
            { service: 'variables', methods: ['GET'], versions: ['2.1'] },
            { service: 'programs', methods: ['GET'], versions: ['2.1'] },
            { service: 'trials', methods: ['GET'], versions: ['2.1'] },
            { service: 'locations', methods: ['GET'], versions: ['2.1'] },
          ],
        }),
      );
    }
    if (path.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: [] }));
    if (path.endsWith('/studies')) {
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    }
    throw new Error(`Unexpected connect path: ${path}`);
  });
  const ctx = createMockContext({ tenantId: 't1', errors: brapiGetStudy.errors });
  await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
  fetcher.mockReset();
  return ctx;
}

describe('brapi_get_study tool', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('fetches the study, resolves FKs, and attaches companion counts', async () => {
    const ctx = await connect(fetcher);

    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(String(url));
      const path = u.pathname;
      if (path.endsWith('/studies/s1')) {
        return jsonResponse(
          envelope({
            studyDbId: 's1',
            studyName: 'Cassava 2022',
            programDbId: 'prog-1',
            trialDbId: 'trial-1',
            locationDbId: 'loc-1',
            seasons: ['2022'],
          }),
        );
      }
      if (path.endsWith('/programs')) {
        return jsonResponse(
          envelope({ data: [{ programDbId: 'prog-1', programName: 'Cassava Breeding' }] }),
        );
      }
      if (path.endsWith('/trials')) {
        return jsonResponse(
          envelope({ data: [{ trialDbId: 'trial-1', trialName: 'Advanced Yield' }] }),
        );
      }
      if (path.endsWith('/locations')) {
        return jsonResponse(
          envelope({ data: [{ locationDbId: 'loc-1', locationName: 'Ibadan' }] }),
        );
      }
      if (path.endsWith('/observations')) {
        return jsonResponse(envelope({ data: [] }, { totalCount: 412 }));
      }
      if (path.endsWith('/observationunits')) {
        return jsonResponse(envelope({ data: [] }, { totalCount: 120 }));
      }
      if (path.endsWith('/variables')) {
        return jsonResponse(envelope({ data: [] }, { totalCount: 18 }));
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const result = await brapiGetStudy.handler(brapiGetStudy.input.parse({ studyDbId: 's1' }), ctx);

    expect(result.study.studyDbId).toBe('s1');
    expect(result.program?.programName).toBe('Cassava Breeding');
    expect(result.trial?.trialName).toBe('Advanced Yield');
    expect(result.location?.locationName).toBe('Ibadan');
    expect(result.observationCount).toBe(412);
    expect(result.observationUnitCount).toBe(120);
    expect(result.variableCount).toBe(18);
    expect(result.warnings).toEqual([]);
  });

  it('encodes special characters in studyDbId', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ studyDbId: 'odd/id' })));
    await brapiGetStudy.handler(brapiGetStudy.input.parse({ studyDbId: 'odd/id' }), ctx);
    const firstCall = fetcher.mock.calls[0]![0];
    expect(String(firstCall)).toContain('/studies/odd%2Fid');
  });

  it('surfaces NotFound when the study payload is empty or missing studyDbId', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({})));
    await expect(
      brapiGetStudy.handler(brapiGetStudy.input.parse({ studyDbId: 'ghost' }), ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
  });

  it('records warnings when FK lookups fail but still returns the study', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/studies/s1')) {
        return jsonResponse(envelope({ studyDbId: 's1', programDbId: 'prog-1' }));
      }
      if (path.endsWith('/programs')) {
        return new Response('', { status: 500 });
      }
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });

    const result = await brapiGetStudy.handler(brapiGetStudy.input.parse({ studyDbId: 's1' }), ctx);
    expect(result.study.studyDbId).toBe('s1');
    expect(result.program).toBeUndefined();
    expect(result.warnings.join('\n')).toContain('program FK lookup failed');
  });

  // Locks in the v0.4.7 foundational dialect-bypass fix. Before this release
  // the FK lookups and observation-count probes built their params manually
  // and bypassed the dialect adapter — which silently returned the wrong
  // record (cassavabase row 1911 instead of the requested 7526 trial) and
  // burned ~50s per call against a slow upstream. With the fix, the dialect
  // is threaded through the BrapiClient and translates plurals to singular
  // at the wire edge for every companion call.
  it('routes companion probes as singular keys when the dialect is cassavabase', async () => {
    const ctx = await connect(fetcher, 'Cassavabase');
    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(String(url));
      const path = u.pathname;
      if (path.endsWith('/studies/s1')) {
        return jsonResponse(
          envelope({
            studyDbId: 's1',
            programDbId: 'prog-1',
            trialDbId: 'trial-1',
            locationDbId: 'loc-1',
          }),
        );
      }
      if (path.endsWith('/programs')) {
        return jsonResponse(
          envelope({ data: [{ programDbId: 'prog-1', programName: 'Cassava Breeding' }] }),
        );
      }
      if (path.endsWith('/trials')) {
        return jsonResponse(
          envelope({ data: [{ trialDbId: 'trial-1', trialName: 'Advanced Yield' }] }),
        );
      }
      if (path.endsWith('/locations')) {
        return jsonResponse(
          envelope({ data: [{ locationDbId: 'loc-1', locationName: 'Ibadan' }] }),
        );
      }
      if (path.endsWith('/observations')) {
        return jsonResponse(envelope({ data: [] }, { totalCount: 7 }));
      }
      if (path.endsWith('/observationunits')) {
        return jsonResponse(envelope({ data: [] }, { totalCount: 4 }));
      }
      if (path.endsWith('/variables')) {
        return jsonResponse(envelope({ data: [] }, { totalCount: 3 }));
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const result = await brapiGetStudy.handler(brapiGetStudy.input.parse({ studyDbId: 's1' }), ctx);

    const calls = fetcher.mock.calls.map((c) => new URL(String(c[0])));
    const trialsCall = calls.find((u) => u.pathname.endsWith('/trials'))!;
    const programsCall = calls.find((u) => u.pathname.endsWith('/programs'))!;
    const locationsCall = calls.find((u) => u.pathname.endsWith('/locations'))!;
    const observationsCall = calls.find((u) => u.pathname.endsWith('/observations'))!;
    const observationUnitsCall = calls.find((u) => u.pathname.endsWith('/observationunits'))!;

    // Singular keys reach the wire — the v0.4.7 fix.
    expect(trialsCall.searchParams.getAll('trialDbId')).toEqual(['trial-1']);
    expect(trialsCall.searchParams.has('trialDbIds')).toBe(false);

    expect(programsCall.searchParams.getAll('programDbId')).toEqual(['prog-1']);
    expect(programsCall.searchParams.has('programDbIds')).toBe(false);

    expect(locationsCall.searchParams.getAll('locationDbId')).toEqual(['loc-1']);
    expect(locationsCall.searchParams.has('locationDbIds')).toBe(false);

    expect(observationsCall.searchParams.getAll('studyDbId')).toEqual(['s1']);
    expect(observationsCall.searchParams.has('studyDbIds')).toBe(false);

    expect(observationUnitsCall.searchParams.getAll('studyDbId')).toEqual(['s1']);
    expect(observationUnitsCall.searchParams.has('studyDbIds')).toBe(false);

    expect(result.observationCount).toBe(7);
    expect(result.observationUnitCount).toBe(4);
    expect(result.variableCount).toBe(3);
    expect(result.trial?.trialName).toBe('Advanced Yield');
  });

  it('tolerates null values on optional study fields (Cassavabase shape)', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/studies/s-cb')) {
        return jsonResponse(
          envelope({
            studyDbId: 's-cb',
            studyName: '00ayt11interspecIB',
            studyType: 'Advanced Yield Trial',
            // Cassavabase null fields:
            studyCode: null,
            studyPUI: null,
            culturalPractices: null,
            license: null,
            lastUpdate: null,
          }),
        );
      }
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });
    const result = await brapiGetStudy.handler(
      brapiGetStudy.input.parse({ studyDbId: 's-cb' }),
      ctx,
    );
    expect(result.study.studyDbId).toBe('s-cb');
    expect(result.study.studyCode).toBeNull();
  });
});
