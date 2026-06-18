/**
 * @fileoverview Tests for `brapi://study/{studyDbId}` — wraps the
 * brapi_get_study tool.
 *
 * @module tests/resources/brapi-study.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brapiStudyResource } from '@/mcp-server/resources/definitions/brapi-study.resource.js';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import {
  BASE_URL,
  envelope,
  initTestServices,
  jsonResponse,
  type MockFetcher,
  pathnameOf,
  resetTestServices,
} from '../tools/_tool-test-helpers.js';

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
    return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
  });
  const ctx = createMockContext({ tenantId: 't1', errors: brapiStudyResource.errors });
  await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
  fetcher.mockReset();
  return ctx;
}

describe('brapi://study/{studyDbId} resource', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('returns the get-study payload for a valid id', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/studies/s-1')) {
        return jsonResponse(envelope({ studyDbId: 's-1', studyName: 'Cassava 2022' }));
      }
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });

    const result = (await brapiStudyResource.handler({ studyDbId: 's-1' }, ctx)) as {
      study: { studyDbId: string; studyName?: string };
      alias: string;
    };
    expect(result.alias).toBe('default');
    expect(result.study.studyDbId).toBe('s-1');
    expect(result.study.studyName).toBe('Cassava 2022');
  });

  it('omits unscopable counts and surfaces the warning, mirroring the tool (#40)', async () => {
    // Connect to a dialect that can't scope the counts, advertising the count
    // endpoints so the probes run.
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/serverinfo')) {
        return jsonResponse(
          envelope({
            serverName: 'BrAPI Community Test Server',
            calls: [
              { service: 'studies', methods: ['GET'], versions: ['2.1'] },
              { service: 'observations', methods: ['GET'], versions: ['2.1'] },
              { service: 'observationunits', methods: ['GET'], versions: ['2.1'] },
              { service: 'variables', methods: ['GET'], versions: ['2.1'] },
            ],
          }),
        );
      }
      if (path.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: [] }));
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });
    const ctx = createMockContext({ tenantId: 't1', errors: brapiStudyResource.errors });
    await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
    fetcher.mockReset();

    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/studies/study3')) {
        return jsonResponse(envelope({ studyDbId: 'study3', observationVariableDbIds: [] }));
      }
      if (path.endsWith('/observationunits')) {
        return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
      }
      // /variables returns the same total filtered or not (server ignores the
      // filter); /observations is dropped by the dialect and never probed.
      return jsonResponse(envelope({ data: [] }, { totalCount: 4 }));
    });

    const result = (await brapiStudyResource.handler({ studyDbId: 'study3' }, ctx)) as {
      observationCount?: number;
      variableCount?: number;
      observationUnitCount?: number;
      warnings: string[];
    };
    expect(result.observationCount).toBeUndefined();
    expect(result.variableCount).toBeUndefined();
    expect(result.observationUnitCount).toBe(0);
    expect(result.warnings.join('\n')).toMatch(/variableCount omitted/);
  });

  it('throws NotFound when the study payload is empty', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({})));
    await expect(brapiStudyResource.handler({ studyDbId: 'ghost' }, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('list() returns no specific entries (resource is unbounded)', async () => {
    const listing = await brapiStudyResource.list!({} as never);
    expect(listing.resources).toEqual([]);
  });
});
