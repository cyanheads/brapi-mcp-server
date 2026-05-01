/**
 * @fileoverview End-to-end tests for `brapi_find_observations` — capability
 * gate, distribution computation, dataset spillover, sparse upstream payloads.
 *
 * @module tests/tools/brapi-find-observations.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiFindObservations } from '@/mcp-server/tools/definitions/brapi-find-observations.tool.js';
import {
  BASE_URL,
  envelope,
  initTestServices,
  jsonResponse,
  type MockFetcher,
  pathnameOf,
  resetTestServices,
} from './_tool-test-helpers.js';

function obsRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    observationDbId: 'obs-1',
    observationUnitDbId: 'ou-1',
    observationVariableDbId: 'var-1',
    observationVariableName: 'Dry Matter %',
    studyDbId: 's-1',
    studyName: 'Cassava 2022',
    germplasmDbId: 'g-1',
    germplasmName: 'TME419',
    observationLevel: 'plot',
    season: '2022',
    value: '32.4',
    ...extra,
  };
}

async function connect(fetcher: MockFetcher, calls = ['observations'], serverName = 'Test') {
  fetcher.mockImplementation(async (url: string) => {
    const path = pathnameOf(url);
    if (path.endsWith('/serverinfo')) {
      return jsonResponse(
        envelope({
          serverName,
          calls: calls.map((service) => ({ service, methods: ['GET'], versions: ['2.1'] })),
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

describe('brapi_find_observations tool', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('returns rows + distributions and forwards filters as query params', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      obsRow(),
      obsRow({ observationDbId: 'obs-2', value: '30.1', observationLevel: 'plant' }),
      obsRow({ observationDbId: 'obs-3', germplasmName: 'IITA-CG-25' }),
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiFindObservations.handler(
      brapiFindObservations.input.parse({
        studies: ['s-1'],
        variables: ['var-1'],
        germplasm: ['g-1', 'g-2'],
      }),
      ctx,
    );

    expect(result.returnedCount).toBe(3);
    expect(result.totalCount).toBe(3);
    expect(result.distributions.observationVariableName).toEqual({ 'Dry Matter %': 3 });
    expect(result.distributions.observationLevel).toEqual({ plot: 2, plant: 1 });

    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.getAll('studyDbIds')).toEqual(['s-1']);
    expect(url.searchParams.getAll('observationVariableDbIds')).toEqual(['var-1']);
    expect(url.searchParams.getAll('germplasmDbIds')).toEqual(['g-1', 'g-2']);
  });

  it('handles sparse upstream rows without inventing values', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(
      jsonResponse(envelope({ data: [{ observationDbId: 'obs-only-id' }] }, { totalCount: 1 })),
    );

    const result = await brapiFindObservations.handler(brapiFindObservations.input.parse({}), ctx);

    expect(result.returnedCount).toBe(1);
    expect(result.results[0]?.observationDbId).toBe('obs-only-id');
    // The distribution map is empty because every other field is missing.
    expect(Object.keys(result.distributions.observationVariableName)).toHaveLength(0);
  });

  it('accepts upstream rows with explicit null fields (CassavaBase shape)', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(
      jsonResponse(
        envelope(
          {
            data: [
              {
                observationDbId: 'obs-1',
                observationUnitDbId: null,
                observationVariableDbId: 'var-1',
                observationVariableName: 'Dry Matter %',
                studyDbId: 's-1',
                studyName: null,
                germplasmDbId: 'g-1',
                germplasmName: null,
                observationLevel: null,
                season: null,
                value: '32.4',
                observationTimeStamp: null,
                collector: null,
                uploadedBy: null,
              },
            ],
          },
          { totalCount: 1 },
        ),
      ),
    );

    const result = await brapiFindObservations.handler(brapiFindObservations.input.parse({}), ctx);

    expect(result.returnedCount).toBe(1);
    expect(result.results[0]?.observationTimeStamp).toBeNull();
    expect(result.results[0]?.season).toBeNull();
  });

  it('spills to DatasetStore when totalCount exceeds loadLimit', async () => {
    const ctx = await connect(fetcher);
    const all = Array.from({ length: 25 }, (_, i) =>
      obsRow({ observationDbId: `obs-${i + 1}`, value: String(i) }),
    );
    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(String(url));
      const page = Number.parseInt(u.searchParams.get('page') ?? '0', 10);
      const pageSize = Number.parseInt(u.searchParams.get('pageSize') ?? '10', 10);
      const slice = all.slice(page * pageSize, page * pageSize + pageSize);
      return jsonResponse(envelope({ data: slice }, { totalCount: all.length }));
    });

    const result = await brapiFindObservations.handler(
      brapiFindObservations.input.parse({ loadLimit: 10 }),
      ctx,
    );

    expect(result.hasMore).toBe(true);
    expect(result.dataset?.rowCount).toBe(25);
    expect(result.refinementHint).toMatch(/25 rows exceed loadLimit=10/);
  });

  it('throws ValidationError when /observations is not advertised', async () => {
    const ctx = await connect(fetcher, ['studies']);
    await expect(
      brapiFindObservations.handler(brapiFindObservations.input.parse({}), ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
  });

  it('downcasts plural filters to singular when connected to a CassavaBase server', async () => {
    const ctx = await connect(fetcher, ['observations'], 'CassavaBase');
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));

    await brapiFindObservations.handler(
      brapiFindObservations.input.parse({
        studies: ['s-1'],
        germplasm: ['g-1'],
        variables: ['var-1'],
      }),
      ctx,
    );

    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.getAll('studyDbId')).toEqual(['s-1']);
    expect(url.searchParams.getAll('germplasmDbId')).toEqual(['g-1']);
    expect(url.searchParams.getAll('observationVariableDbId')).toEqual(['var-1']);
    expect(url.searchParams.has('studyDbIds')).toBe(false);
    expect(url.searchParams.has('germplasmDbIds')).toBe(false);
    expect(url.searchParams.has('observationVariableDbIds')).toBe(false);
  });

  it('preflights unscoped germplasm queries and skips bulk pull above threshold', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(String(url));
      const pageSize = Number.parseInt(u.searchParams.get('pageSize') ?? '0', 10);
      // Preflight uses pageSize=1; only return one row + the huge totalCount.
      if (pageSize === 1) {
        return jsonResponse(envelope({ data: [obsRow()] }, { totalCount: 50_000 }));
      }
      // If anything but the preflight goes out, the test should fail.
      throw new Error(`Bulk pull should have been skipped; got pageSize=${pageSize}`);
    });

    const result = await brapiFindObservations.handler(
      brapiFindObservations.input.parse({ germplasm: ['g-1'] }),
      ctx,
    );

    expect(fetcher.mock.calls.length).toBe(1);
    expect(result.returnedCount).toBe(1);
    expect(result.totalCount).toBe(50_000);
    expect(result.dataset).toBeUndefined();
    expect(
      result.warnings.some((w) =>
        /Preflight detected 50000 observations.*Bulk pull skipped/.test(w),
      ),
    ).toBe(true);
  });

  it('skips preflight when the query has a study scope', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [obsRow()] }, { totalCount: 1 })));

    const result = await brapiFindObservations.handler(
      brapiFindObservations.input.parse({ studies: ['s-1'], germplasm: ['g-1'] }),
      ctx,
    );

    // Only one HTTP call — the bulk pull, no preflight.
    expect(fetcher.mock.calls.length).toBe(1);
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    // Confirms it was the bulk pull (loadLimit) and not a pageSize=1 preflight.
    expect(url.searchParams.get('pageSize')).not.toBe('1');
    expect(result.returnedCount).toBe(1);
  });

  it('preflights and proceeds when the upstream total fits under the threshold', async () => {
    const ctx = await connect(fetcher);
    let calls = 0;
    fetcher.mockImplementation(async (url: string) => {
      calls += 1;
      const u = new URL(String(url));
      const pageSize = Number.parseInt(u.searchParams.get('pageSize') ?? '0', 10);
      // Preflight returns small total → bulk pull should follow.
      if (pageSize === 1) {
        return jsonResponse(envelope({ data: [obsRow()] }, { totalCount: 50 }));
      }
      const rows = Array.from({ length: 50 }, (_, i) =>
        obsRow({ observationDbId: `obs-${i + 1}` }),
      );
      return jsonResponse(envelope({ data: rows }, { totalCount: 50 }));
    });

    const result = await brapiFindObservations.handler(
      brapiFindObservations.input.parse({ germplasm: ['g-1'] }),
      ctx,
    );

    expect(calls).toBe(2);
    expect(result.returnedCount).toBe(50);
    expect(result.totalCount).toBe(50);
  });

  it('format() renders observation IDs and study/variable names', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [obsRow()] }, { totalCount: 1 })));
    const result = await brapiFindObservations.handler(brapiFindObservations.input.parse({}), ctx);
    const text = (brapiFindObservations.format!(result)[0] as { text: string }).text;
    expect(text).toContain('obs-1');
    expect(text).toContain('Dry Matter %');
    expect(text).toContain('Cassava 2022');
    expect(text).toContain('TME419');
  });
});
