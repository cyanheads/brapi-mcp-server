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

async function connect(fetcher: MockFetcher, calls = ['observations']) {
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
