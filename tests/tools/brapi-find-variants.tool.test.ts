/**
 * @fileoverview End-to-end tests for `brapi_find_variants` — capability gate,
 * region filter forwarding, start>=end warning, distribution computation,
 * spillover.
 *
 * @module tests/tools/brapi-find-variants.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiFindVariants } from '@/mcp-server/tools/definitions/brapi-find-variants.tool.js';
import {
  BASE_URL,
  envelope,
  initTestServices,
  jsonResponse,
  type MockFetcher,
  pathnameOf,
  resetTestServices,
} from './_tool-test-helpers.js';

function variantRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    variantDbId: 'v-1',
    variantNames: ['rs1234'],
    variantSetDbId: 'vset-1',
    variantType: 'SNP',
    referenceName: 'chr1',
    referenceBases: 'A',
    alternateBases: ['G'],
    start: 1000,
    end: 1001,
    ...extra,
  };
}

async function connect(fetcher: MockFetcher, calls = ['variants']) {
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

describe('brapi_find_variants tool', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('forwards region filters as query params', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));

    await brapiFindVariants.handler(
      brapiFindVariants.input.parse({
        variantSets: ['vset-1'],
        referenceName: 'chr1',
        start: 1000,
        end: 5000,
      }),
      ctx,
    );

    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.getAll('variantSetDbIds')).toEqual(['vset-1']);
    expect(url.searchParams.get('referenceName')).toBe('chr1');
    expect(url.searchParams.get('start')).toBe('1000');
    expect(url.searchParams.get('end')).toBe('5000');
  });

  it('warns when start >= end', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));

    const result = await brapiFindVariants.handler(
      brapiFindVariants.input.parse({ start: 1000, end: 1000 }),
      ctx,
    );
    expect(result.warnings.join('\n')).toContain('start >= end');
  });

  it('returns rows + per-type / per-reference distributions', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      variantRow(),
      variantRow({ variantDbId: 'v-2', variantType: 'INDEL' }),
      variantRow({ variantDbId: 'v-3', referenceName: 'chr2' }),
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiFindVariants.handler(brapiFindVariants.input.parse({}), ctx);

    expect(result.distributions.variantType).toEqual({ SNP: 2, INDEL: 1 });
    expect(result.distributions.referenceName).toEqual({ chr1: 2, chr2: 1 });
    expect(result.distributions.variantSetDbId).toEqual({ 'vset-1': 3 });
  });

  it('throws ValidationError when /variants is not advertised', async () => {
    const ctx = await connect(fetcher, ['studies']);
    await expect(
      brapiFindVariants.handler(brapiFindVariants.input.parse({}), ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
  });

  it('format() includes variant IDs, type, position, and ref/alt bases', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [variantRow()] }, { totalCount: 1 })));
    const result = await brapiFindVariants.handler(brapiFindVariants.input.parse({}), ctx);
    const text = (brapiFindVariants.format!(result)[0] as { text: string }).text;
    expect(text).toContain('v-1');
    expect(text).toContain('SNP');
    expect(text).toContain('chr1');
    expect(text).toContain('start=1000');
    expect(text).toContain('refBases=A');
    expect(text).toContain('altBases=G');
  });
});
