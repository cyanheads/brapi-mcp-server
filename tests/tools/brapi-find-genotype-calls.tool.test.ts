/**
 * @fileoverview End-to-end tests for `brapi_find_genotype_calls` — capability
 * gate, sync POST /search/calls happy path, distribution + dataframe spillover,
 * input validation when no filter is supplied, truncation at the deployment
 * pull limit (BRAPI_GENOTYPE_CALLS_MAX_PULL).
 *
 * @module tests/tools/brapi-find-genotype-calls.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiFindGenotypeCalls } from '@/mcp-server/tools/definitions/brapi-find-genotype-calls.tool.js';
import { registerDialect } from '@/services/brapi-dialect/registry.js';
import { getCanvasBridge } from '@/services/canvas-bridge/index.js';
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
  const ctx = createMockContext({ tenantId: 't1', errors: brapiFindGenotypeCalls.errors });
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
    vi.unstubAllEnvs();
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

    expect(getEnrichment(ctx).totalCount).toBe(3);
    expect(getEnrichment(ctx).returnedCount).toBe(3);
    expect(result.distributions.callSetName).toEqual({ TME419: 2, 'TMS-30572': 1 });
    expect(result.distributions.variantName).toEqual({ rs1: 2, rs2: 1 });
    expect(result.callFormatting.unknownString).toBe('.');
    expect(result.callFormatting.sepPhased).toBe('|');
    expect(getEnrichment(ctx).appliedFilters.variantSetDbIds).toEqual(['vset-1']);
    expect(getEnrichment(ctx).appliedFilters.germplasmDbIds).toEqual(['g-1', 'g-2']);
  });

  it('throws ValidationError when the active dialect disables /search/calls', async () => {
    // Register a one-off test dialect that disables `calls`, then pin it via
    // env override. CassavaBase intentionally leaves `calls` enabled, so we
    // need a dedicated dialect to exercise this code path.
    registerDialect({
      id: 'test-disabled-calls',
      disabledSearchEndpoints: new Set(['calls']),
      adaptGetFilters: (_endpoint, filters) => ({ filters: { ...filters }, warnings: [] }),
    });
    vi.stubEnv('BRAPI_DEFAULT_DIALECT', 'test-disabled-calls');
    const ctx = await connect(fetcher);
    await expect(
      brapiFindGenotypeCalls.handler(
        brapiFindGenotypeCalls.input.parse({ variantSetDbId: 'vset-1' }),
        ctx,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'search_endpoint_disabled', dialectId: 'test-disabled-calls' },
    });
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

describe('brapi_find_genotype_calls inline budget (#66)', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTestServices();
    vi.unstubAllEnvs();
  });

  /** Answer POST /search/calls synchronously with `rows` on one page; any other host fails the call. */
  function serve(rows: Record<string, unknown>[]): void {
    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(String(url));
      if (u.hostname !== 'brapi.example.org' || u.pathname !== '/brapi/v2/search/calls') {
        throw new Error(`unmocked fetch: ${u.href}`);
      }
      return jsonResponse(envelope({ data: rows, unknownString: '.' }));
    });
  }

  async function run(ctx: Context, input: Record<string, unknown>) {
    const definition = {
      ...brapiFindGenotypeCalls,
      handler: (parsed, contractCtx) =>
        brapiFindGenotypeCalls.handler(parsed, { ...contractCtx, state: ctx.state }),
    } satisfies typeof brapiFindGenotypeCalls;
    const result = await runToolContract(definition, input, { context: { tenantId: 't1' } });
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    return { result, structured: result.structuredContent as Record<string, unknown>, text };
  }

  const calls = (n: number, extra: Record<string, unknown> = {}) =>
    Array.from({ length: n }, (_, i) =>
      call({ callSetDbId: `cs-${i + 1}`, variantDbId: `v-${i + 1}`, ...extra }),
    );
  /** ~5 KB per call: four fit the 24,000-byte budget. */
  const wide = { genotype: { values: ['A', 'G'], depth: 'd'.repeat(4_800) } };

  it('trims results[] to the byte budget, stages every collected call, and keeps truncated for the pull cap', async () => {
    const ctx = await connect(fetcher);
    serve(calls(8, wide));
    const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');

    const { result, structured, text } = await run(ctx, { variantSetDbId: 'vset-1' });

    expect(result.isError).toBeFalsy();
    expect(Buffer.byteLength(JSON.stringify(structured.results), 'utf8')).toBeLessThanOrEqual(
      24_000,
    );
    expect(structured).toMatchObject({
      returnedCount: 4,
      totalCount: 8,
      shown: 4,
      cap: 1_000,
      truncated: false,
      hasMore: false,
      dataframe: { rowCount: 8 },
    });
    expect(structured.dataframe).not.toHaveProperty('truncated');
    const staged = register.mock.calls[0]![1].rows as Record<string, unknown>[];
    expect(new Set(staged.map((r) => r.callSetDbId)).size).toBe(8);
    expect(structured.notice).toContain('24,000-byte inline budget');
    expect(structured.notice).toContain((structured.dataframe as { tableName: string }).tableName);
    expect(text).toContain('24,000-byte inline budget');
  });

  it('spills to a dataframe, naming loadLimit, when collected calls exceed it before the budget', async () => {
    const ctx = await connect(fetcher);
    serve(calls(25));

    const { structured } = await run(ctx, { variantSetDbId: 'vset-1', loadLimit: 10 });

    expect(structured).toMatchObject({
      totalCount: 25,
      returnedCount: 10,
      shown: 10,
      cap: 10,
      truncated: false,
      dataframe: { rowCount: 25 },
    });
    expect(structured.notice).toContain('loadLimit (10) bound');
  });

  it('sets no shown, cap, or notice and stages nothing inside both bounds', async () => {
    const ctx = await connect(fetcher);
    serve(calls(3));

    const { structured } = await run(ctx, { variantSetDbId: 'vset-1' });

    expect(structured).toMatchObject({ returnedCount: 3, truncated: false, hasMore: false });
    for (const key of ['shown', 'cap', 'notice', 'dataframe']) {
      expect(structured).not.toHaveProperty(key);
    }
  });

  it('keeps truncated and hasMore for the pull cap when every collected call fits inline', async () => {
    vi.stubEnv('BRAPI_GENOTYPE_CALLS_MAX_PULL', '3');
    const ctx = await connect(fetcher);
    serve(calls(5));

    const { structured } = await run(ctx, { variantSetDbId: 'vset-1' });

    expect(structured).toMatchObject({
      returnedCount: 3,
      totalCount: 3,
      truncated: true,
      hasMore: true,
    });
    for (const key of ['shown', 'cap', 'dataframe']) {
      expect(structured).not.toHaveProperty(key);
    }
    // Nothing was staged, so the pull-cap warning names no dataframe.
    const capWarning = (structured.warnings as string[]).find((w) => w.includes('pull limit'));
    expect(capWarning).toBe(
      'Truncated at the pull limit (3 calls): the calls collected up to it are kept. Narrow the filters and re-pull to reach the rest.',
    );
  });

  it('names the truncated dataframe and both dataframe tools when a pull-capped set is staged', async () => {
    vi.stubEnv('BRAPI_GENOTYPE_CALLS_MAX_PULL', '20');
    const ctx = await connect(fetcher);
    serve(calls(25));

    const { structured, text } = await run(ctx, { variantSetDbId: 'vset-1', loadLimit: 5 });

    const tableName = (structured.dataframe as { tableName: string }).tableName;
    expect(structured).toMatchObject({
      truncated: true,
      dataframe: { rowCount: 20, truncated: true },
    });
    expect(structured.notice).toBe(
      `results[] holds the first 5 matched row(s): loadLimit (5) bound. Staged dataframe \`${tableName}\` (20 rows, truncated — warnings says why): list its columns with brapi_dataframe_describe, then query it with brapi_dataframe_query (SQL).`,
    );
    expect(text).toContain(`> ${structured.notice as string}`);
  });

  it('warns when the pull cap stops the page walk on a page boundary', async () => {
    vi.stubEnv('BRAPI_GENOTYPE_CALLS_MAX_PULL', '8');
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(async (url: string, _t: number, _c: unknown, init) => {
      const u = new URL(String(url));
      if (u.hostname !== 'brapi.example.org' || u.pathname !== '/brapi/v2/search/calls') {
        throw new Error(`unmocked fetch: ${u.href}`);
      }
      const { page = 0 } = JSON.parse(String((init as RequestInit).body)) as { page?: number };
      return jsonResponse({
        metadata: { pagination: { currentPage: page, totalPages: 3 } },
        result: {
          data: Array.from({ length: 4 }, (_, i) =>
            call({ callSetDbId: `cs-${page}-${i}`, variantDbId: `v-${page}-${i}` }),
          ),
        },
      });
    });

    const { structured } = await run(ctx, { variantSetDbId: 'vset-1' });

    expect(structured).toMatchObject({ totalCount: 8, truncated: true, hasMore: true });
    expect(structured.warnings).toContain(
      'Truncated at the pull limit (8 calls): the calls collected up to it are kept. Narrow the filters and re-pull to reach the rest.',
    );
  });

  it('returns the empty-result notice with no shown or cap', async () => {
    const ctx = await connect(fetcher);
    serve([]);

    const { result, structured } = await run(ctx, { variantSetDbId: 'vset-1' });

    expect(result.isError).toBeFalsy();
    expect(structured).toMatchObject({ returnedCount: 0, results: [] });
    expect(structured.notice).toMatch(/No calls matched/);
    for (const key of ['shown', 'cap', 'dataframe']) {
      expect(structured).not.toHaveProperty(key);
    }
  });

  describe('page walk under the call deadline', () => {
    /**
     * Answer POST /search/calls synchronously, one page per request out of
     * `totalPages`, each page holding `perPage` calls; `onPage` runs before
     * each response.
     */
    function servePages(
      totalPages: number,
      perPage: (page: number) => Record<string, unknown>[],
      onPage: (page: number) => void = () => {},
    ): number[] {
      const served: number[] = [];
      fetcher.mockImplementation(async (url: string, _t: number, _c: unknown, init) => {
        const u = new URL(String(url));
        if (u.hostname !== 'brapi.example.org' || u.pathname !== '/brapi/v2/search/calls') {
          throw new Error(`unmocked fetch: ${u.href}`);
        }
        const { page = 0 } = JSON.parse(String((init as RequestInit).body)) as { page?: number };
        served.push(page);
        onPage(page);
        return jsonResponse({
          metadata: { pagination: { currentPage: page, totalPages } },
          result: { data: perPage(page), unknownString: '.' },
        });
      });
      return served;
    }

    const pageOf = (page: number) =>
      Array.from({ length: 4 }, (_, i) =>
        call({ callSetDbId: `cs-${page}-${i}`, variantDbId: `v-${page}-${i}`, ...wide }),
      );

    it('returns and stages the calls collected before the deadline, marked truncated, with a warning', async () => {
      const ctx = await connect(fetcher);
      let clock = Date.now();
      vi.spyOn(Date, 'now').mockImplementation(() => clock);
      // Each page takes 26 s: pages 0 and 1 land, page 2 would start past the 50 s deadline.
      const served = servePages(5, pageOf, () => {
        clock += 26_000;
      });
      const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');

      const { result, structured, text } = await run(ctx, { variantSetDbId: 'vset-1' });

      expect(result.isError).toBeFalsy();
      expect(served).toEqual([0, 1]);
      expect(structured).toMatchObject({
        totalCount: 8,
        returnedCount: 4,
        truncated: false,
        hasMore: true,
        dataframe: { rowCount: 8, truncated: true },
      });
      expect(structured.dataframe).not.toHaveProperty('maxRows');
      const staged = register.mock.calls[0]![1].rows as Record<string, unknown>[];
      expect(new Set(staged.map((r) => r.callSetDbId)).size).toBe(8);
      const warning = (structured.warnings as string[]).find((w) => w.includes('deadline'));
      expect(warning).toMatch(
        /Genotype-call pull stopped after 8 call\(s\): this call's 50 s deadline for upstream requests ran out before page 2/,
      );
      expect(text).toContain('Genotype-call pull stopped after 8 call(s)');
    });

    it('still fails the call when the deadline passes before the first page, with nothing collected', async () => {
      const ctx = await connect(fetcher);
      const served = servePages(5, pageOf);
      const late = new Date(Date.now() + 60_000).getTime();
      vi.spyOn(Date, 'now').mockImplementation(() => late);

      const { result } = await run(ctx, { variantSetDbId: 'vset-1' });

      expect(result.isError).toBe(true);
      expect(served).toEqual([]);
      const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
      expect(text).toContain('call_deadline_exceeded');
    });

    it('rejects when the caller cancels between pages instead of returning a partial pull', async () => {
      const ctx = await connect(fetcher);
      const controller = new AbortController();
      servePages(5, pageOf, (page) => {
        if (page === 0) controller.abort();
      });

      await expect(
        brapiFindGenotypeCalls.handler(
          brapiFindGenotypeCalls.input.parse({ variantSetDbId: 'vset-1' }),
          { ...ctx, signal: controller.signal } as Context,
        ),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    });
  });
});

describe('brapi_find_genotype_calls variant-set discovery', () => {
  it('names where a variantSetDbId comes from', () => {
    const description = brapiFindGenotypeCalls.input.shape.variantSetDbId.description ?? '';
    expect(description).toContain('brapi_raw_get({ path: "/variantsets" })');
    expect(description).toContain('params.studyDbId');
  });
});
