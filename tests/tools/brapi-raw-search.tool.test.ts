/**
 * @fileoverview Tests for `brapi_raw_search` — sync POST passthrough, async
 * polling, suggestion surfacing, body forwarding.
 *
 * @module tests/tools/brapi-raw-search.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiRawSearch } from '@/mcp-server/tools/definitions/brapi-raw-search.tool.js';
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
      return jsonResponse(envelope({ serverName, calls: [] }));
    }
    if (path.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: [] }));
    return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
  });
  const ctx = createMockContext({ tenantId: 't1', errors: brapiRawSearch.errors });
  await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
  fetcher.mockReset();
  return ctx;
}

describe('brapi_raw_search tool', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('returns sync results when the server inlines the response', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [{ studyDbId: 's-1' }] })));

    const result = await brapiRawSearch.handler(
      brapiRawSearch.input.parse({ noun: 'studies', body: { commonCropNames: ['Cassava'] } }),
      ctx,
    );

    expect(result.kind).toBe('sync');
    expect(result.searchResultsDbId).toBeUndefined();
    expect(result.suggestion).toContain('brapi_find_studies');

    const init = fetcher.mock.calls[0]![3] as RequestInit;
    expect(init.method).toBe('POST');
    // Caller didn't drive paging, so the handler injects pageSize=loadLimit on
    // the body to align with the spillover walk's pageSize. Original keys are
    // preserved verbatim alongside it.
    const body = JSON.parse(init.body as string);
    expect(body.commonCropNames).toEqual(['Cassava']);
    expect(typeof body.pageSize).toBe('number');
  });

  it('bounds a wide array page and stages every fetched row without walking', async () => {
    const ctx = await connect(fetcher);
    const rows = Array.from({ length: 30 }, (_, n) => ({ n, value: 'é'.repeat(1000) }));
    fetcher.mockResolvedValue(
      jsonResponse(
        envelope(rows, { totalCount: 100, currentPage: 2, pageSize: 30, totalPages: 4 }),
      ),
    );
    const definition = {
      ...brapiRawSearch,
      handler: (input, contractCtx) =>
        brapiRawSearch.handler(input, { ...contractCtx, state: ctx.state }),
    } satisfies typeof brapiRawSearch;
    const res = await runToolContract(
      definition,
      { noun: 'samples', body: { page: 2, pageSize: 30 } },
      { context: { tenantId: 't1' } },
    );
    expect(res.isError, JSON.stringify(res.structuredContent)).toBeFalsy();
    const sc = res.structuredContent as {
      result: unknown[];
      dataframe: { rowCount: number };
      shown: number;
      notice: string;
    };
    expect(Buffer.byteLength(JSON.stringify(sc.result))).toBeLessThanOrEqual(24_000);
    expect(sc.dataframe.rowCount).toBe(30);
    expect(sc.shown).toBe(sc.result.length);
    expect(sc.notice).toContain('requested upstream page');
    expect(sc.notice).toContain('OFFSET 0');
    const text = res.content.find((block) => block.type === 'text')?.text ?? '';
    expect(Buffer.byteLength(JSON.stringify(text.split('## Raw result\n')[1]))).toBeLessThanOrEqual(
      24_000,
    );
    expect(JSON.stringify(res.content)).toContain('24,000-byte');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('bounds an async oversized first row without losing its resolved envelope siblings', async () => {
    const ctx = await connect(fetcher);
    fetcher
      .mockResolvedValueOnce(jsonResponse(envelope({ searchResultsDbId: 'wide-search' })))
      .mockResolvedValueOnce(
        jsonResponse({
          metadata: { pagination: { currentPage: 2 }, marker: 'kept' },
          result: { data: [{ id: 'wide', value: 'é'.repeat(24_000) }], sibling: true },
        }),
      );
    const definition = {
      ...brapiRawSearch,
      handler: (input, contractCtx) =>
        brapiRawSearch.handler(input, { ...contractCtx, state: ctx.state }),
    } satisfies typeof brapiRawSearch;
    const res = await runToolContract(
      definition,
      { noun: 'samples', body: { page: 2, pageSize: 1 } },
      { context: { tenantId: 't1' } },
    );
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      kind: 'async',
      searchResultsDbId: 'wide-search',
      metadata: { pagination: { currentPage: 2 }, marker: 'kept' },
      result: { data: [], sibling: true },
      dataframe: { rowCount: 1 },
      shown: 0,
    });
    expect(JSON.stringify(res.content)).toContain('narrower projection');
    expect(JSON.stringify(res.content)).toContain('page 2');
    expect(JSON.stringify(res.content)).not.toContain('undefined');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetcher.mock.calls[1]?.[0])).searchParams.get('page')).toBe('2');
    expect(new URL(String(fetcher.mock.calls[1]?.[0])).searchParams.get('pageSize')).toBe('1');
  });

  it('polls when the server returns an async searchResultsDbId', async () => {
    const ctx = await connect(fetcher);
    fetcher
      .mockResolvedValueOnce(jsonResponse(envelope({ searchResultsDbId: 'abc-123' })))
      .mockResolvedValueOnce(jsonResponse(envelope({ data: [{ ok: true }] })));

    const result = await brapiRawSearch.handler(
      brapiRawSearch.input.parse({ noun: 'observations', body: {} }),
      ctx,
    );

    expect(result.kind).toBe('async');
    expect(result.searchResultsDbId).toBe('abc-123');
    expect(result.suggestion).toContain('brapi_find_observations');
  });

  it('names the genotype tools that take a variantSetDbId when searching variantsets', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [{ variantSetDbId: 'vs1' }] })));

    const result = await brapiRawSearch.handler(
      brapiRawSearch.input.parse({ noun: 'variantsets', body: {} }),
      ctx,
    );

    expect(result.suggestion).toContain('brapi_find_genotype_calls');
    expect(result.suggestion).toContain('brapi_export_genotype_matrix');
  });

  it('renders async cancellation consistently on both error surfaces without polling again', async () => {
    const ctx = await connect(fetcher);
    const controller = new AbortController();
    fetcher.mockImplementationOnce(async () => {
      controller.abort();
      return jsonResponse(envelope({ searchResultsDbId: 'cancelled-search' }));
    });
    const definition = {
      ...brapiRawSearch,
      handler(input, contractCtx) {
        return brapiRawSearch.handler(input, { ...contractCtx, state: ctx.state });
      },
    } satisfies typeof brapiRawSearch;
    const result = await runToolContract(
      definition,
      { noun: 'observations', body: {} },
      {
        context: { tenantId: 't1', signal: controller.signal },
      },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.RequestCancelled,
        message: 'Async search polling aborted by caller',
      },
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('Async search polling aborted by caller'),
        }),
      ]),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects nouns containing path separators at parse time', () => {
    expect(() => brapiRawSearch.input.parse({ noun: 'studies/sub', body: {} })).toThrow();
  });

  it('throws ValidationError when the dialect disables this search noun', async () => {
    const ctx = await connect(fetcher, 'CassavaBase');
    // CassavaBase dialect declares /search/germplasm as known-dead.
    await expect(
      brapiRawSearch.handler(
        brapiRawSearch.input.parse({ noun: 'germplasm', body: { commonCropNames: ['Cassava'] } }),
        ctx,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'search_endpoint_disabled', dialectId: 'cassavabase', noun: 'germplasm' },
    });
    // Should NOT have hit the upstream — disable check runs before the POST.
    expect(fetcher.mock.calls.length).toBe(0);
  });

  it('routes through normally when the dialect does not disable the noun (calls on cassavabase)', async () => {
    const ctx = await connect(fetcher, 'CassavaBase');
    // `calls` is intentionally NOT in the cassavabase disabled set.
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] })));
    const result = await brapiRawSearch.handler(
      brapiRawSearch.input.parse({ noun: 'calls', body: { variantSetDbIds: ['vset-1'] } }),
      ctx,
    );
    expect(result.kind).toBe('sync');
  });

  it('format() includes the noun and async ID when present', async () => {
    const ctx = await connect(fetcher);
    fetcher
      .mockResolvedValueOnce(jsonResponse(envelope({ searchResultsDbId: 'rid-1' })))
      .mockResolvedValueOnce(jsonResponse(envelope({ data: [] })));
    const result = await brapiRawSearch.handler(
      brapiRawSearch.input.parse({ noun: 'observations', body: {} }),
      ctx,
    );
    const text = (brapiRawSearch.format!(result)[0] as { text: string }).text;
    expect(text).toContain('/search/observations');
    expect(text).toContain('rid-1');
    expect(text).toContain('async');
  });

  it('does not spill when totalCount fits within loadLimit', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(
      jsonResponse(
        envelope({ data: [{ observationDbId: 'o-1' }] }, { totalCount: 1 } as unknown as {
          totalCount: number;
        }),
      ),
    );
    const result = await brapiRawSearch.handler(
      brapiRawSearch.input.parse({ noun: 'observations', body: {}, loadLimit: 10 }),
      ctx,
    );
    expect(result.dataframe).toBeUndefined();
  });

  it('does not spill when the caller drives paging via body.pageSize', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(
      jsonResponse(
        envelope({ data: [{ observationDbId: 'o-1' }] }, { totalCount: 9999 } as unknown as {
          totalCount: number;
        }),
      ),
    );
    const result = await brapiRawSearch.handler(
      brapiRawSearch.input.parse({
        noun: 'observations',
        body: { pageSize: 5, page: 0 },
        loadLimit: 10,
      }),
      ctx,
    );
    expect(result.dataframe).toBeUndefined();
    // The handler must not have injected pageSize=loadLimit on top of the
    // caller's choice — it preserves their value verbatim.
    const init = fetcher.mock.calls[0]![3] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.pageSize).toBe(5);
  });

  describe('dataframe spill and walk stop disclosure', () => {
    const allRows = Array.from({ length: 25 }, (_, i) => ({ observationDbId: `o${i + 1}` }));

    /** Serve POST /search/observations pages, failing pages at or past `failFromPage`. */
    function serve(failFromPage: number): void {
      fetcher.mockImplementation(
        async (url: string, _init?: unknown, _signal?: unknown, init?: RequestInit) => {
          const u = new URL(String(url));
          if (
            u.hostname !== 'brapi.example.org' ||
            u.pathname !== '/brapi/v2/search/observations'
          ) {
            throw new Error(`unmocked fetch: ${u.href}`);
          }
          const body = init?.body ? JSON.parse(init.body as string) : {};
          const page = typeof body.page === 'number' ? body.page : 0;
          if (page >= failFromPage) return jsonResponse({ error: 'upstream down' }, 500);
          const pageSize = typeof body.pageSize === 'number' ? body.pageSize : 10;
          const totalCount = allRows.length;
          return jsonResponse({
            metadata: {
              pagination: {
                currentPage: page,
                pageSize,
                totalCount,
                totalPages: Math.ceil(totalCount / pageSize),
              },
            },
            result: { data: allRows.slice(page * pageSize, page * pageSize + pageSize) },
          });
        },
      );
    }

    async function run(ctx: Awaited<ReturnType<typeof connect>>) {
      const definition = {
        ...brapiRawSearch,
        handler(input, contractCtx) {
          return brapiRawSearch.handler(input, { ...contractCtx, state: ctx.state });
        },
      } satisfies typeof brapiRawSearch;
      const result = await runToolContract(
        definition,
        { noun: 'observations', body: {}, loadLimit: 10 },
        { context: { tenantId: 't1' } },
      );
      const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
      return { result, structured: result.structuredContent as Record<string, unknown>, text };
    }

    it('warns on both surfaces when a walk page fails, staging the rows already fetched', async () => {
      const ctx = await connect(fetcher);
      serve(1);

      const { result, structured, text } = await run(ctx);

      expect(result.isError).toBeFalsy();
      expect(structured.dataframe).toMatchObject({ rowCount: 10, truncated: true });
      const warnings = structured.warnings as string[];
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Dataframe walk stopped after 10 of 25 upstream row(s)');
      expect(warnings[0]).toContain('page 1 failed');
      expect(text).toContain('Dataframe walk stopped after 10 of 25 upstream row(s)');
      expect(text).toContain(`**Warnings:**\n- ${warnings[0]}`);
      const tableName = (structured.dataframe as { tableName: string }).tableName;
      expect(structured.notice).toContain(
        `Staged dataframe \`${tableName}\` (10 rows, truncated — warnings says why): list its columns with brapi_dataframe_describe, then query it with brapi_dataframe_query (SQL).`,
      );
      expect(text).toContain(`> ${structured.notice as string}`);
    });

    it('spills sync results past loadLimit, with no warnings when the walk reaches the upstream total', async () => {
      const ctx = await connect(fetcher);
      serve(Number.POSITIVE_INFINITY);

      const { structured, text } = await run(ctx);

      expect(structured.kind).toBe('sync');
      expect(structured.dataframe).toMatchObject({
        rowCount: 25,
        tableName: expect.stringMatching(/^df_/),
      });
      expect(structured).not.toHaveProperty('warnings');
      expect(structured.notice).toContain('brapi_dataframe_describe');
      expect(structured.notice).toContain('brapi_dataframe_query');
      expect(text).not.toContain('**Warnings:**');
    });
  });
});
