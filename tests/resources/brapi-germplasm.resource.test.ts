/**
 * @fileoverview Tests for `brapi://germplasm/{germplasmDbId}` — wraps the
 * brapi_get_germplasm tool.
 *
 * @module tests/resources/brapi-germplasm.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brapiGermplasmResource } from '@/mcp-server/resources/definitions/brapi-germplasm.resource.js';
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
          calls: [{ service: 'germplasm', methods: ['GET'], versions: ['2.1'] }],
        }),
      );
    }
    if (path.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: [] }));
    return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
  });
  const ctx = createMockContext({ tenantId: 't1' });
  await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
  fetcher.mockReset();
  return ctx;
}

describe('brapi://germplasm/{germplasmDbId} resource', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('returns the get-germplasm payload for a valid id', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/germplasm/g-1')) {
        return jsonResponse(envelope({ germplasmDbId: 'g-1', germplasmName: 'TME419' }));
      }
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });

    const result = (await brapiGermplasmResource.handler({ germplasmDbId: 'g-1' }, ctx)) as {
      germplasm: { germplasmDbId: string; germplasmName?: string };
      alias: string;
    };
    expect(result.alias).toBe('default');
    expect(result.germplasm.germplasmDbId).toBe('g-1');
    expect(result.germplasm.germplasmName).toBe('TME419');
  });

  it('throws NotFound when the germplasm payload is empty', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({})));
    await expect(
      brapiGermplasmResource.handler({ germplasmDbId: 'ghost' }, ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
  });

  it('list() returns no specific entries (resource is unbounded)', async () => {
    const listing = await brapiGermplasmResource.list!({} as never);
    expect(listing.resources).toEqual([]);
  });
});
