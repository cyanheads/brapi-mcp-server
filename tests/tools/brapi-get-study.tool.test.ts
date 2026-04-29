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

async function connect(fetcher: MockFetcher) {
  fetcher.mockImplementation(async (url: string) => {
    const path = pathnameOf(url);
    if (path.endsWith('/serverinfo')) {
      return jsonResponse(
        envelope({
          serverName: 'Test',
          calls: [{ service: 'studies', methods: ['GET'], versions: ['2.1'] }],
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
      if (path.endsWith('/observationvariables')) {
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
});
