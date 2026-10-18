/**
 * @fileoverview Tests for `brapi_raw_get` — passthrough behavior, suggestion
 * surfacing for endpoints covered by curated tools, cross-origin path
 * rejection.
 *
 * @module tests/tools/brapi-raw-get.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiRawGet } from '@/mcp-server/tools/definitions/brapi-raw-get.tool.js';
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
        envelope({
          serverName: 'Test',
          calls: [{ service: 'studies', methods: ['GET'], versions: ['2.1'] }],
        }),
      );
    }
    if (path.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: [] }));
    return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
  });
  const ctx = createMockContext({ tenantId: 't1', errors: brapiRawGet.errors });
  await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
  fetcher.mockReset();
  return ctx;
}

describe('brapi_raw_get tool', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('passes through to the upstream and returns the raw envelope', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(
      jsonResponse(
        envelope({ data: [{ sampleDbId: 'sample-1' }] }, { totalCount: 1 } as unknown as {
          totalCount: number;
        }),
      ),
    );

    const result = await brapiRawGet.handler(
      brapiRawGet.input.parse({ path: '/samples', params: { studyDbIds: ['s-1'] } }),
      ctx,
    );

    expect(result.path).toBe('/samples');
    expect(result.url).toContain('/samples');
    expect(result.url).toContain('studyDbIds=s-1');
    expect(result.metadata.pagination?.totalCount).toBe(1);
    expect(result.suggestion).toBeUndefined();
  });

  it('emits a suggestion when the path is covered by a curated tool', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));

    const result = await brapiRawGet.handler(brapiRawGet.input.parse({ path: '/studies' }), ctx);
    expect(result.suggestion).toBeDefined();
    expect(result.suggestion).toContain('brapi_find_studies');
  });

  it('names the genotype tools that take a variantSetDbId when listing /variantsets', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(
      jsonResponse(envelope({ data: [{ variantSetDbId: 'vs1', studyDbId: '140' }] })),
    );

    const result = await brapiRawGet.handler(
      brapiRawGet.input.parse({ path: 'variantsets', params: { studyDbId: '140' } }),
      ctx,
    );

    const parsed = brapiRawGet.output.parse(result);
    expect(parsed.suggestion).toContain('variantSetDbId');
    expect(parsed.suggestion).toContain('brapi_find_genotype_calls');
    expect(parsed.suggestion).toContain('brapi_export_genotype_matrix');
    expect(brapiRawGet.format(result)[0]?.text).toContain('brapi_export_genotype_matrix');
  });

  it('normalizes a path missing the leading slash', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] })));
    const result = await brapiRawGet.handler(brapiRawGet.input.parse({ path: 'methods' }), ctx);
    expect(result.path).toBe('/methods');
  });

  it('rejects a fully-qualified URL as path (cross-origin smuggling guard)', async () => {
    const ctx = await connect(fetcher);
    await expect(
      brapiRawGet.handler(brapiRawGet.input.parse({ path: 'https://evil.example.com/leak' }), ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
  });

  it('format() includes the URL and pagination block when present', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(
      jsonResponse(
        envelope(
          { data: [{ a: 1 }] },
          // include a richer pagination block to exercise format()
          { totalCount: 12 } as unknown as { totalCount: number },
        ),
      ),
    );
    const result = await brapiRawGet.handler(brapiRawGet.input.parse({ path: '/samples' }), ctx);
    const text = (brapiRawGet.format!(result)[0] as { text: string }).text;
    expect(text).toContain('/samples');
    expect(text).toContain('totalCount=12');
  });

  it('does not spill when result is not a list shape (single object)', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(
      jsonResponse(
        envelope(
          { sampleDbId: 'sample-1', name: 'Sample One' },
          // pagination block exists but result is scalar — no spillover
          { totalCount: 9999 } as unknown as { totalCount: number },
        ),
      ),
    );
    const result = await brapiRawGet.handler(
      brapiRawGet.input.parse({ path: '/samples/sample-1', loadLimit: 10 }),
      ctx,
    );
    expect(result.dataframe).toBeUndefined();
  });

  it('does not spill when the caller drives paging via params.pageSize', async () => {
    const ctx = await connect(fetcher);
    const rows = Array.from({ length: 5 }, (_, i) => ({ sampleDbId: `s${i + 1}` }));
    fetcher.mockResolvedValue(
      jsonResponse(
        envelope({ data: rows }, { totalCount: 9999 } as unknown as {
          totalCount: number;
        }),
      ),
    );
    const result = await brapiRawGet.handler(
      brapiRawGet.input.parse({
        path: '/samples',
        params: { pageSize: 5, page: 0 },
        loadLimit: 10,
      }),
      ctx,
    );
    // User opted into manual paging — handler treats this as a single explicit
    // page fetch and skips the spillover walk even though totalCount is huge.
    expect(result.dataframe).toBeUndefined();
  });

  describe('dataframe spill and walk stop disclosure', () => {
    const allRows = Array.from({ length: 25 }, (_, i) => ({ sampleDbId: `s${i + 1}` }));

    /** Serve GET /samples pages, failing pages at or past `failFromPage`; any other host fails. */
    function serve(failFromPage: number): void {
      fetcher.mockImplementation(async (url: string) => {
        const u = new URL(String(url));
        if (u.hostname !== 'brapi.example.org' || u.pathname !== '/brapi/v2/samples') {
          throw new Error(`unmocked fetch: ${u.href}`);
        }
        const page = Number.parseInt(u.searchParams.get('page') ?? '0', 10);
        if (page >= failFromPage) return jsonResponse({ error: 'upstream down' }, 500);
        const pageSize = Number.parseInt(u.searchParams.get('pageSize') ?? '10', 10);
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
      });
    }

    async function run(ctx: Awaited<ReturnType<typeof connect>>, loadLimit = 10) {
      const definition = {
        ...brapiRawGet,
        handler(input, contractCtx) {
          return brapiRawGet.handler(input, { ...contractCtx, state: ctx.state });
        },
      } satisfies typeof brapiRawGet;
      const result = await runToolContract(
        definition,
        { path: '/samples', loadLimit },
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
      expect(structured.notice).toBe(
        `Staged dataframe \`${tableName}\` (10 rows, truncated — warnings says why): list its columns with brapi_dataframe_describe, then query it with brapi_dataframe_query (SQL).`,
      );
      expect(text).toContain(`> ${structured.notice as string}`);
    });

    it('spills a list past loadLimit, with no warnings when the walk reaches the upstream total', async () => {
      const ctx = await connect(fetcher);
      serve(Number.POSITIVE_INFINITY);

      const { structured, text } = await run(ctx);

      expect(structured.dataframe).toMatchObject({
        rowCount: 25,
        tableName: expect.stringMatching(/^df_/),
      });
      // Inline `result` is unchanged — raw passthrough preserves the upstream page.
      expect((structured.result as { data?: unknown[] }).data).toHaveLength(10);
      expect(structured).not.toHaveProperty('warnings');
      expect(structured.notice).toContain('brapi_dataframe_describe');
      expect(structured.notice).toContain('brapi_dataframe_query');
      expect(text).not.toContain('**Warnings:**');
    });

    it('stages nothing and carries no dataframe pointer when the list fits loadLimit', async () => {
      const ctx = await connect(fetcher);
      serve(Number.POSITIVE_INFINITY);

      const { result, structured } = await run(ctx, 50);

      expect(result.isError).toBeFalsy();
      expect(structured).not.toHaveProperty('dataframe');
      expect(structured).not.toHaveProperty('notice');
    });
  });
});
