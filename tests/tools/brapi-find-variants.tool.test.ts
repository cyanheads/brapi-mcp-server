/**
 * @fileoverview End-to-end tests for `brapi_find_variants` — capability gate,
 * region filter forwarding, start>=end warning, distribution computation,
 * spillover.
 *
 * @module tests/tools/brapi-find-variants.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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

async function connect(fetcher: MockFetcher, calls = ['variants'], serverName = 'Test') {
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

    await brapiFindVariants.handler(brapiFindVariants.input.parse({ start: 1000, end: 1000 }), ctx);
    expect(getEnrichment(ctx).warnings.join('\n')).toContain('start >= end');
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

  it('downcasts plural filters to singular when connected to a CassavaBase server', async () => {
    const ctx = await connect(fetcher, ['variants'], 'CassavaBase');
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));

    await brapiFindVariants.handler(
      brapiFindVariants.input.parse({
        variantSets: ['vset-1'],
        variants: ['v-1'],
        references: ['ref-1'],
      }),
      ctx,
    );

    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.getAll('variantSetDbId')).toEqual(['vset-1']);
    expect(url.searchParams.getAll('variantDbId')).toEqual(['v-1']);
    expect(url.searchParams.getAll('referenceDbId')).toEqual(['ref-1']);
    expect(url.searchParams.has('variantSetDbIds')).toBe(false);
    expect(url.searchParams.has('variantDbIds')).toBe(false);
    expect(url.searchParams.has('referenceDbIds')).toBe(false);
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

  it('sanitizes the reserved-word `end` column when the result spills to a dataframe', async () => {
    const ctx = await connect(fetcher);
    // loadLimit: 5 with 7 upstream variants → spillover (mirrors the issue's
    // repro). Each row carries an `end` field — a reserved SQL keyword the
    // canvas identifier gate rejects unsanitized.
    const rows = Array.from({ length: 7 }, (_, i) => variantRow({ variantDbId: `v-${i}` }));
    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(String(url));
      if (!u.pathname.endsWith('/variants')) throw new Error(`Unexpected path: ${u.pathname}`);
      const page = Number(u.searchParams.get('page') ?? '0');
      const pageSize = Number(u.searchParams.get('pageSize') ?? '10');
      const data = rows.slice(page * pageSize, page * pageSize + pageSize);
      return jsonResponse(envelope({ data }, { totalCount: rows.length }));
    });

    const result = await brapiFindVariants.handler(
      brapiFindVariants.input.parse({ loadLimit: 5 }),
      ctx,
    );

    expect(result.dataframe).toBeDefined();
    expect(result.dataframe?.columns).toContain('end_');
    expect(result.dataframe?.columns).not.toContain('end');
    expect(result.dataframe?.columnLegend).toMatchObject({ end_: 'end' });
    // format() surfaces the rename so the agent writes correct SQL.
    const text = (brapiFindVariants.format!(result)[0] as { text: string }).text;
    expect(text).toContain('end_ → end');
  });
});

describe('brapi_find_variants inline budget (#66)', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  /** Serve a paged /variants list; any other host fails the call. */
  function serve(rows: Record<string, unknown>[]): void {
    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(String(url));
      if (u.hostname !== 'brapi.example.org' || u.pathname !== '/brapi/v2/variants') {
        throw new Error(`unmocked fetch: ${u.href}`);
      }
      const page = Number.parseInt(u.searchParams.get('page') ?? '0', 10);
      const pageSize = Number.parseInt(u.searchParams.get('pageSize') ?? '10', 10);
      return jsonResponse(
        envelope(
          { data: rows.slice(page * pageSize, page * pageSize + pageSize) },
          { totalCount: rows.length },
        ),
      );
    });
  }

  async function call(ctx: Context, input: Record<string, unknown>) {
    const definition = {
      ...brapiFindVariants,
      handler: (parsed, contractCtx) =>
        brapiFindVariants.handler(parsed, { ...contractCtx, state: ctx.state }),
    } satisfies typeof brapiFindVariants;
    const result = await runToolContract(definition, input, { context: { tenantId: 't1' } });
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    return { result, structured: result.structuredContent as Record<string, unknown>, text };
  }

  const variants = (n: number, extra: Record<string, unknown> = {}) =>
    Array.from({ length: n }, (_, i) => variantRow({ variantDbId: `v-${i + 1}`, ...extra }));

  it('trims results[] to the byte budget and stages every matched row', async () => {
    const ctx = await connect(fetcher);
    // ~5 KB per row: four fit the 24,000-byte budget.
    serve(variants(8, { referenceBases: 'A'.repeat(4_800) }));

    const { result, structured, text } = await call(ctx, { variantSets: ['vset-1'] });

    expect(result.isError).toBeFalsy();
    expect(fetcher.mock.calls.length).toBe(1);
    expect(Buffer.byteLength(JSON.stringify(structured.results), 'utf8')).toBeLessThanOrEqual(
      24_000,
    );
    expect(structured).toMatchObject({
      returnedCount: 4,
      totalCount: 8,
      hasMore: true,
      truncated: true,
      shown: 4,
      cap: 1_000,
      dataframe: { rowCount: 8 },
    });
    expect(text).toContain('24,000-byte inline budget');
  });

  it('sets no truncation fields and stages nothing on an empty result', async () => {
    const ctx = await connect(fetcher);
    serve([]);

    const { result, structured } = await call(ctx, { variantSets: ['vset-1'] });

    expect(result.isError).toBeFalsy();
    expect(structured).toMatchObject({ returnedCount: 0, hasMore: false, results: [] });
    expect(structured.notice).toMatch(/^No variants matched/);
    for (const key of ['truncated', 'shown', 'cap', 'dataframe']) {
      expect(structured).not.toHaveProperty(key);
    }
  });
});
