/**
 * @fileoverview End-to-end tests for brapi_find_germplasm — filter merge,
 * distribution computation (crop/genus/species), dataset spillover.
 *
 * @module tests/tools/brapi-find-germplasm.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiFindGermplasm } from '@/mcp-server/tools/definitions/brapi-find-germplasm.tool.js';
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

describe('brapi_find_germplasm tool', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('returns rows and distributions', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      {
        germplasmDbId: 'g1',
        germplasmName: 'TME419',
        commonCropName: 'Cassava',
        genus: 'Manihot',
        species: 'esculenta',
      },
      {
        germplasmDbId: 'g2',
        germplasmName: 'TMS30572',
        commonCropName: 'Cassava',
        genus: 'Manihot',
        species: 'esculenta',
      },
      {
        germplasmDbId: 'g3',
        germplasmName: 'Yam Champion',
        commonCropName: 'Yam',
        genus: 'Dioscorea',
      },
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiFindGermplasm.handler(
      brapiFindGermplasm.input.parse({ crops: ['Cassava', 'Yam'] }),
      ctx,
    );

    expect(result.returnedCount).toBe(3);
    expect(result.distributions.commonCropName).toEqual({ Cassava: 2, Yam: 1 });
    expect(result.distributions.genus).toEqual({ Manihot: 2, Dioscorea: 1 });
    expect(result.distributions.species).toEqual({ esculenta: 2 });
  });

  it('routes names + PUIs + accession numbers to the right filter params', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));

    await brapiFindGermplasm.handler(
      brapiFindGermplasm.input.parse({
        names: ['TME419'],
        germplasmPUIs: ['doi:xyz'],
        accessionNumbers: ['TMe-419'],
        genus: 'Manihot',
      }),
      ctx,
    );
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.getAll('germplasmNames')).toEqual(['TME419']);
    expect(url.searchParams.getAll('germplasmPUIs')).toEqual(['doi:xyz']);
    expect(url.searchParams.getAll('accessionNumbers')).toEqual(['TMe-419']);
    expect(url.searchParams.get('genus')).toBe('Manihot');
  });

  it('spills to dataset when totalCount exceeds loadLimit', async () => {
    const ctx = await connect(fetcher);
    const totalCount = 15;
    const allRows = Array.from({ length: totalCount }, (_, i) => ({
      germplasmDbId: `g${i + 1}`,
      germplasmName: `Germ ${i + 1}`,
      commonCropName: 'Cassava',
    }));

    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(String(url));
      const page = Number.parseInt(u.searchParams.get('page') ?? '0', 10);
      const pageSize = Number.parseInt(u.searchParams.get('pageSize') ?? '10', 10);
      return jsonResponse(
        envelope(
          { data: allRows.slice(page * pageSize, page * pageSize + pageSize) },
          { totalCount },
        ),
      );
    });

    const result = await brapiFindGermplasm.handler(
      brapiFindGermplasm.input.parse({ crops: ['Cassava'], loadLimit: 10 }),
      ctx,
    );

    expect(result.hasMore).toBe(true);
    expect(result.dataset?.rowCount).toBe(15);
    expect(result.refinementHint).toMatch(/15 rows exceed loadLimit=10/);
  });

  it('applies free-text as a client-side post-filter and never sends searchText on the wire', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      { germplasmDbId: 'g1', germplasmName: 'TME419', commonCropName: 'Cassava' },
      { germplasmDbId: 'g2', germplasmName: 'TMS30572', commonCropName: 'Cassava' },
      { germplasmDbId: 'g3', germplasmName: 'IITA-CG-25', commonCropName: 'Cassava' },
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiFindGermplasm.handler(
      brapiFindGermplasm.input.parse({ crops: ['Cassava'], text: 'TME' }),
      ctx,
    );

    expect(result.returnedCount).toBe(1);
    expect(result.results[0]?.germplasmName).toBe('TME419');
    expect(result.totalCount).toBe(3);
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.has('searchText')).toBe(false);
    expect(url.searchParams.has('text')).toBe(false);
    // Distributions still reflect the un-filtered fullRows (3 Cassava rows).
    expect(result.distributions.commonCropName).toEqual({ Cassava: 3 });
    expect(
      result.warnings.some((w) => /narrowed in-context view to 1 of 3 returned rows/.test(w)),
    ).toBe(true);
  });

  it('matches free-text across registered synonyms', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      { germplasmDbId: 'g1', germplasmName: 'CG-25', synonyms: [{ synonym: 'Kantedza' }] },
      { germplasmDbId: 'g2', germplasmName: 'TME419' },
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiFindGermplasm.handler(
      brapiFindGermplasm.input.parse({ text: 'kantedza' }),
      ctx,
    );

    expect(result.returnedCount).toBe(1);
    expect(result.results[0]?.germplasmDbId).toBe('g1');
  });

  it('warns when free-text matches 0 of N returned rows', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      { germplasmDbId: 'g1', germplasmName: 'TME419' },
      { germplasmDbId: 'g2', germplasmName: 'TMS30572' },
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiFindGermplasm.handler(
      brapiFindGermplasm.input.parse({ text: 'no-such-name' }),
      ctx,
    );

    expect(result.returnedCount).toBe(0);
    expect(
      result.warnings.some((w) => /Free-text 'no-such-name' matched 0 of 2 returned rows/.test(w)),
    ).toBe(true);
  });

  it('mentions the dataset in the partial-match warning when spillover happened', async () => {
    const ctx = await connect(fetcher);
    const totalCount = 15;
    const allRows = Array.from({ length: totalCount }, (_, i) => ({
      germplasmDbId: `g${i + 1}`,
      // Only g1 matches `TME`; the rest are TMS-* so the post-filter narrows the in-context view.
      germplasmName: i === 0 ? 'TME419' : `TMS${i + 1}`,
      commonCropName: 'Cassava',
    }));
    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(String(url));
      const page = Number.parseInt(u.searchParams.get('page') ?? '0', 10);
      const pageSize = Number.parseInt(u.searchParams.get('pageSize') ?? '10', 10);
      return jsonResponse(
        envelope(
          { data: allRows.slice(page * pageSize, page * pageSize + pageSize) },
          { totalCount },
        ),
      );
    });

    const result = await brapiFindGermplasm.handler(
      brapiFindGermplasm.input.parse({ crops: ['Cassava'], text: 'TME', loadLimit: 10 }),
      ctx,
    );

    expect(result.dataset).toBeDefined();
    expect(result.returnedCount).toBe(1);
    expect(
      result.warnings.some((w) => /Full set retained in the dataset for follow-up/.test(w)),
    ).toBe(true);
  });

  it('downcasts plural filters to singular when connected to a CassavaBase server', async () => {
    const ctx = await connect(fetcher, 'CassavaBase');
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));

    const result = await brapiFindGermplasm.handler(
      brapiFindGermplasm.input.parse({
        crops: ['Cassava'],
        names: ['TME419'],
        accessionNumbers: ['TMe-419'],
      }),
      ctx,
    );

    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.getAll('commonCropName')).toEqual(['Cassava']);
    expect(url.searchParams.getAll('germplasmName')).toEqual(['TME419']);
    expect(url.searchParams.getAll('accessionNumber')).toEqual(['TMe-419']);
    expect(url.searchParams.has('commonCropNames')).toBe(false);
    expect(url.searchParams.has('germplasmNames')).toBe(false);
    expect(url.searchParams.has('accessionNumbers')).toBe(false);
    expect(result.appliedFilters).toEqual({
      commonCropName: 'Cassava',
      germplasmName: 'TME419',
      accessionNumber: 'TMe-419',
    });
  });

  it('renders appliedFilters back to user param names after CassavaBase singular downcast', async () => {
    const ctx = await connect(fetcher, 'CassavaBase');
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));

    const result = await brapiFindGermplasm.handler(
      brapiFindGermplasm.input.parse({ crops: ['Cassava'] }),
      ctx,
    );

    const text = (brapiFindGermplasm.format!(result)[0] as { text: string }).text;
    // SERVER_TO_USER maps singular `commonCropName` back to the user-facing `crops` param.
    expect(text).toMatch(/crops/);
  });

  it('tolerates null values on optional string fields (Cassavabase shape)', async () => {
    const ctx = await connect(fetcher);
    const sparseRow = {
      germplasmDbId: '2372141',
      germplasmName: 'unknown_accession',
      commonCropName: 'cassava,manioc,tapioca,yuca',
      genus: 'Manihot',
      species: 'Manihot esculenta',
      pedigree: 'NA/NA',
      // Cassavabase nulls in the wild:
      subtaxa: null,
      subtaxaAuthority: null,
      speciesAuthority: null,
      biologicalStatusOfAccessionDescription: null,
      germplasmPreprocessing: null,
      collection: null,
      synonyms: [{ synonym: 'Kantedza', type: null }],
      donors: [{ donorAccessionNumber: null, donorInstituteCode: null }],
    };
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [sparseRow] }, { totalCount: 1 })));
    const result = await brapiFindGermplasm.handler(brapiFindGermplasm.input.parse({}), ctx);
    expect(result.returnedCount).toBe(1);
    expect(result.results[0]?.subtaxa).toBeNull();
    expect(result.results[0]?.synonyms?.[0]?.type).toBeNull();
  });
});
