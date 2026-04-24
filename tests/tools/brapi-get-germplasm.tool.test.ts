/**
 * @fileoverview End-to-end tests for brapi_get_germplasm — direct-parent
 * extraction from /pedigree, attribute lookup, and companion counts
 * (studies, progeny).
 *
 * @module tests/tools/brapi-get-germplasm.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiGetGermplasm } from '@/mcp-server/tools/definitions/brapi-get-germplasm.tool.js';
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
        envelope({ calls: [{ service: 'germplasm', methods: ['GET'], versions: ['2.1'] }] }),
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

describe('brapi_get_germplasm tool', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('returns the germplasm with parents, attributes, and counts', async () => {
    const ctx = await connect(fetcher);

    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(String(url));
      const path = u.pathname;
      if (path.endsWith('/germplasm/g1')) {
        return jsonResponse(
          envelope({
            germplasmDbId: 'g1',
            germplasmName: 'TME419',
            commonCropName: 'Cassava',
            genus: 'Manihot',
          }),
        );
      }
      if (path.endsWith('/germplasm/g1/pedigree')) {
        return jsonResponse(
          envelope({
            parents: [
              { germplasmDbId: 'p1', germplasmName: 'Parent A', parentType: 'FEMALE' },
              { germplasmDbId: 'p2', germplasmName: 'Parent B', parentType: 'MALE' },
            ],
          }),
        );
      }
      if (path.endsWith('/germplasm/g1/attributes')) {
        return jsonResponse(
          envelope({
            data: [
              { attributeName: 'Ploidy', attributeValue: '2n' },
              { attributeName: 'Flowering', attributeValue: 'Yes' },
            ],
          }),
        );
      }
      if (path.endsWith('/studies')) {
        return jsonResponse(envelope({ data: [] }, { totalCount: 7 }));
      }
      if (path.endsWith('/germplasm/g1/progeny')) {
        return jsonResponse(envelope({ data: [] }, { totalCount: 14 }));
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const result = await brapiGetGermplasm.handler(
      brapiGetGermplasm.input.parse({ germplasmDbId: 'g1' }),
      ctx,
    );

    expect(result.germplasm.germplasmDbId).toBe('g1');
    expect(result.parents).toHaveLength(2);
    expect(result.directParentCount).toBe(2);
    expect(result.attributes).toHaveLength(2);
    expect(result.studyCount).toBe(7);
    expect(result.directDescendantCount).toBe(14);
    expect(result.warnings).toEqual([]);
  });

  it('handles missing pedigree and attribute endpoints gracefully', async () => {
    const ctx = await connect(fetcher);

    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path === '/brapi/v2/germplasm/g2') {
        return jsonResponse(envelope({ germplasmDbId: 'g2', germplasmName: 'Orphan' }));
      }
      if (path.endsWith('/pedigree')) {
        return new Response('', { status: 404 });
      }
      if (path.endsWith('/attributes')) {
        return new Response('', { status: 404 });
      }
      if (path.endsWith('/progeny')) {
        return new Response('', { status: 404 });
      }
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });

    const result = await brapiGetGermplasm.handler(
      brapiGetGermplasm.input.parse({ germplasmDbId: 'g2' }),
      ctx,
    );

    expect(result.germplasm.germplasmDbId).toBe('g2');
    expect(result.parents).toEqual([]);
    expect(result.attributes).toEqual([]);
    expect(result.directParentCount).toBe(0);
    expect(result.directDescendantCount).toBeUndefined();
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('surfaces NotFound when the germplasm payload is empty', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({})));
    await expect(
      brapiGetGermplasm.handler(brapiGetGermplasm.input.parse({ germplasmDbId: 'ghost' }), ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
  });
});
