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

async function connect(fetcher: MockFetcher, serverName?: string) {
  fetcher.mockImplementation(async (url: string) => {
    const path = pathnameOf(url);
    if (path.endsWith('/serverinfo')) {
      return jsonResponse(
        envelope({
          ...(serverName ? { serverName } : {}),
          calls: [
            { service: 'germplasm', methods: ['GET'], versions: ['2.1'] },
            { service: 'germplasm/{germplasmDbId}/pedigree', methods: ['GET'], versions: ['2.1'] },
            {
              service: 'germplasm/{germplasmDbId}/attributes',
              methods: ['GET'],
              versions: ['2.1'],
            },
            { service: 'germplasm/{germplasmDbId}/progeny', methods: ['GET'], versions: ['2.1'] },
            { service: 'studies', methods: ['GET'], versions: ['2.1'] },
          ],
        }),
      );
    }
    if (path.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: [] }));
    return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
  });
  const ctx = createMockContext({ tenantId: 't1', errors: brapiGetGermplasm.errors });
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
        // Filtered probe (germplasmDbIds=g1) → 7; unfiltered baseline → 42.
        // Distinct totals confirm the upstream honored the germplasm filter.
        const isFiltered = u.searchParams.has('germplasmDbIds');
        return jsonResponse(envelope({ data: [] }, { totalCount: isFiltered ? 7 : 42 }));
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

  // The BrAPI Community Test Server's /studies?germplasmDbIds= is silently
  // ignored — the singular germplasmDbId works. The brapi-test dialect
  // translates plural → singular before the studyCount probe goes out.
  // Locks in the Issue 2 fix.
  it('uses singular germplasmDbId on the studyCount probe when connected to the BrAPI Test Server', async () => {
    const ctx = await connect(fetcher, 'BrAPI Community Test Server');

    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(String(url));
      const path = u.pathname;
      if (path.endsWith('/germplasm/germplasm1')) {
        return jsonResponse(envelope({ germplasmDbId: 'germplasm1', germplasmName: 'g1' }));
      }
      if (path.endsWith('/germplasm/germplasm1/pedigree'))
        return jsonResponse(envelope({ parents: [] }));
      if (path.endsWith('/germplasm/germplasm1/attributes'))
        return jsonResponse(envelope({ data: [] }));
      if (path.endsWith('/studies')) {
        // Singular form filters → 1; plural would have been ignored and
        // returned the unfiltered baseline of 3.
        const isFilteredSingular = u.searchParams.has('germplasmDbId');
        return jsonResponse(envelope({ data: [] }, { totalCount: isFilteredSingular ? 1 : 3 }));
      }
      if (path.endsWith('/germplasm/germplasm1/progeny')) {
        return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const result = await brapiGetGermplasm.handler(
      brapiGetGermplasm.input.parse({ germplasmDbId: 'germplasm1' }),
      ctx,
    );

    // Studies probe must have used the singular key (verified by hitting the
    // mock branch above) — and the count survived the filtered≠baseline check.
    const studiesCalls = fetcher.mock.calls
      .map((c) => new URL(String(c[0])))
      .filter((u) => u.pathname.endsWith('/studies'));
    const filteredCalls = studiesCalls.filter((u) => u.searchParams.has('germplasmDbId'));
    const pluralCalls = studiesCalls.filter((u) => u.searchParams.has('germplasmDbIds'));
    expect(filteredCalls).toHaveLength(1);
    expect(pluralCalls).toHaveLength(0);
    expect(result.studyCount).toBe(1);
  });

  it('drops studyCount when the upstream silently ignores the germplasm filter', async () => {
    const ctx = await connect(fetcher);

    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(String(url));
      const path = u.pathname;
      if (path.endsWith('/germplasm/g1')) {
        return jsonResponse(envelope({ germplasmDbId: 'g1', germplasmName: 'TME419' }));
      }
      if (path.endsWith('/germplasm/g1/pedigree')) return jsonResponse(envelope({ parents: [] }));
      if (path.endsWith('/germplasm/g1/attributes')) return jsonResponse(envelope({ data: [] }));
      if (path.endsWith('/studies')) {
        // Both probes return the same total → upstream silently dropped the filter.
        return jsonResponse(envelope({ data: [] }, { totalCount: 8340 }));
      }
      if (path.endsWith('/germplasm/g1/progeny')) {
        return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const result = await brapiGetGermplasm.handler(
      brapiGetGermplasm.input.parse({ germplasmDbId: 'g1' }),
      ctx,
    );

    expect(result.studyCount).toBeUndefined();
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/studyCount omitted.*8340/)]),
    );
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

  it('tolerates null values on optional germplasm fields (Cassavabase shape)', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/germplasm/2372141')) {
        return jsonResponse(
          envelope({
            germplasmDbId: '2372141',
            germplasmName: 'unknown_accession',
            commonCropName: 'cassava,manioc,tapioca,yuca',
            genus: 'Manihot',
            species: 'Manihot esculenta',
            // Cassavabase null fields:
            subtaxa: null,
            subtaxaAuthority: null,
            speciesAuthority: null,
            biologicalStatusOfAccessionDescription: null,
          }),
        );
      }
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });
    const result = await brapiGetGermplasm.handler(
      brapiGetGermplasm.input.parse({ germplasmDbId: '2372141' }),
      ctx,
    );
    expect(result.germplasm.germplasmDbId).toBe('2372141');
    expect(result.germplasm.subtaxa).toBeNull();
  });
});
