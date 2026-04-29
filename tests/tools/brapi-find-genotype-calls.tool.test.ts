/**
 * @fileoverview End-to-end tests for `brapi_find_genotype_calls` — capability
 * gate, sync POST /search/calls happy path, distribution + dataset spillover,
 * input validation when no filter is supplied, truncation at maxCalls.
 *
 * @module tests/tools/brapi-find-genotype-calls.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiFindGenotypeCalls } from '@/mcp-server/tools/definitions/brapi-find-genotype-calls.tool.js';
import {
  BASE_URL,
  envelope,
  initTestServices,
  jsonResponse,
  type MockFetcher,
  pathnameOf,
  resetTestServices,
} from './_tool-test-helpers.js';

function call(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    callSetDbId: 'cs-1',
    callSetName: 'TME419',
    variantDbId: 'v-1',
    variantName: 'rs1',
    variantSetDbId: 'vset-1',
    genotype: { values: ['A', 'G'] },
    ...extra,
  };
}

async function connect(fetcher: MockFetcher, calls = ['search/calls']) {
  fetcher.mockImplementation(async (url: string) => {
    const path = pathnameOf(url);
    if (path.endsWith('/serverinfo')) {
      return jsonResponse(
        envelope({
          serverName: 'Test',
          calls: calls.map((service) => ({ service, methods: ['POST'], versions: ['2.1'] })),
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

describe('brapi_find_genotype_calls tool', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('rejects unfiltered pulls with ValidationError', async () => {
    const ctx = await connect(fetcher);
    await expect(
      brapiFindGenotypeCalls.handler(brapiFindGenotypeCalls.input.parse({}), ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
  });

  it('returns rows + distributions for a sync /search/calls response', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      call(),
      call({ variantDbId: 'v-2', variantName: 'rs2' }),
      call({ callSetDbId: 'cs-2', callSetName: 'TMS-30572' }),
    ];
    fetcher.mockResolvedValueOnce(
      jsonResponse(
        envelope({
          data: rows,
          expandHomozygotes: false,
          unknownString: '.',
          sepPhased: '|',
          sepUnphased: '/',
        }),
      ),
    );

    const result = await brapiFindGenotypeCalls.handler(
      brapiFindGenotypeCalls.input.parse({
        variantSetDbId: 'vset-1',
        germplasmDbIds: ['g-1', 'g-2'],
      }),
      ctx,
    );

    expect(result.totalCount).toBe(3);
    expect(result.distributions.callSetName).toEqual({ TME419: 2, 'TMS-30572': 1 });
    expect(result.distributions.variantName).toEqual({ rs1: 2, rs2: 1 });
    expect(result.callFormatting.unknownString).toBe('.');
    expect(result.callFormatting.sepPhased).toBe('|');
    expect(result.searchBody.variantSetDbIds).toEqual(['vset-1']);
    expect(result.searchBody.germplasmDbIds).toEqual(['g-1', 'g-2']);
  });

  it('spills to DatasetStore when collected calls exceed loadLimit', async () => {
    const ctx = await connect(fetcher);
    const rows = Array.from({ length: 25 }, (_, i) =>
      call({ callSetDbId: `cs-${i + 1}`, variantDbId: `v-${i + 1}` }),
    );
    fetcher.mockResolvedValueOnce(jsonResponse(envelope({ data: rows })));

    const result = await brapiFindGenotypeCalls.handler(
      brapiFindGenotypeCalls.input.parse({
        variantSetDbId: 'vset-1',
        loadLimit: 10,
      }),
      ctx,
    );

    expect(result.totalCount).toBe(25);
    expect(result.returnedCount).toBe(10);
    expect(result.dataset?.rowCount).toBe(25);
  });

  it('throws ValidationError when /search/calls is not advertised', async () => {
    const ctx = await connect(fetcher, ['studies']);
    await expect(
      brapiFindGenotypeCalls.handler(
        brapiFindGenotypeCalls.input.parse({ variantSetDbId: 'vset-1' }),
        ctx,
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
  });
});
