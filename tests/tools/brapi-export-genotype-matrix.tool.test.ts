/**
 * @fileoverview End-to-end tests for `brapi_export_genotype_matrix` — capability
 * gate, sync POST /search/calls happy path, matrix pivot, column sanitization,
 * dataframe registration, and the typed error contract (unknown_alias,
 * no_filters, search_endpoint_disabled).
 *
 * @module tests/tools/brapi-export-genotype-matrix.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, timeout } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiExportGenotypeMatrix } from '@/mcp-server/tools/definitions/brapi-export-genotype-matrix.tool.js';
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
  TEST_CONFIG,
} from './_tool-test-helpers.js';

/** Build a minimal call row. */
function call(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    callSetDbId: 'cs-1',
    callSetName: 'TME419',
    variantDbId: 'v-1',
    variantName: 'rs1',
    variantSetDbId: 'vset-1',
    genotype: { values: ['A', 'G'] },
    ...overrides,
  };
}

/**
 * Render `format()` over a complete, schema-valid result. Exercises the real
 * content[] surface — the only place the preview cap and the legend live.
 */
function renderExport(
  overrides: {
    columnCount?: number;
    dataframeTableName?: string;
    map?: string;
    ped?: string;
    variantColumnLegend?: Record<string, string>;
    vcf?: string;
  } = {},
): string {
  const legend = overrides.variantColumnLegend ?? { v_1: 'v-1' };
  const result = {
    alias: 'default',
    format: 'vcf-lite' as const,
    rowCount: 1,
    columnCount: overrides.columnCount ?? Object.keys(legend).length,
    variantColumnLegend: legend,
    callFormatting: {
      expandHomozygotes: null,
      unknownString: '.',
      sepPhased: null,
      sepUnphased: '/',
    },
    dataframe: {
      tableName: overrides.dataframeTableName ?? 'df_AAAAA_BBBBB',
      rowCount: 1,
      columns: ['callSetDbId', 'callSetName', 'germplasmDbId', ...Object.keys(legend)],
      createdAt: '2026-06-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
    },
    truncated: false,
    warnings: [],
    ...(overrides.vcf !== undefined ? { vcf: overrides.vcf } : {}),
    ...(overrides.ped !== undefined ? { ped: overrides.ped } : {}),
    ...(overrides.map !== undefined ? { map: overrides.map } : {}),
  };
  const parts = brapiExportGenotypeMatrix.format(result) as { text: string }[];
  return parts[0]!.text;
}

/** An advertised call: a bare service name is advertised for POST. */
type AdvertisedCall = string | { methods: string[]; service: string };

/** Register a default connection with /search/calls advertised. */
async function connect(fetcher: MockFetcher, calls: AdvertisedCall[] = ['search/calls']) {
  fetcher.mockImplementation(async (url: string) => {
    const path = pathnameOf(url);
    if (path.endsWith('/serverinfo')) {
      return jsonResponse(
        envelope({
          serverName: 'Test',
          calls: calls.map((entry) => ({
            ...(typeof entry === 'string' ? { service: entry, methods: ['POST'] } : entry),
            versions: ['2.1'],
          })),
        }),
      );
    }
    if (path.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: [] }));
    return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
  });
  const ctx = createMockContext({ tenantId: 't1', errors: brapiExportGenotypeMatrix.errors });
  await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
  fetcher.mockReset();
  return ctx;
}

describe('brapi_export_genotype_matrix tool', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
    vi.unstubAllEnvs();
  });

  async function run(ctx: Context, format: 'matrix-json' | 'vcf-lite' | 'plink') {
    const definition = {
      ...brapiExportGenotypeMatrix,
      handler: (input, contractCtx) =>
        brapiExportGenotypeMatrix.handler(input, { ...contractCtx, state: ctx.state }),
    } satisfies typeof brapiExportGenotypeMatrix;
    const result = await runToolContract(
      definition,
      { variantSetDbId: 'vset-1', format },
      {
        context: { tenantId: 't1' },
      },
    );
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    return { result, structured: result.structuredContent as Record<string, unknown>, text };
  }

  it.each(['vcf-lite', 'plink'] as const)(
    'keeps scalar dosages in the matrix and emits missing in %s',
    async (format) => {
      const ctx = await connect(fetcher);
      const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
      const data = ['0', '0.5', '0/1'].map((values, index) =>
        call({
          variantDbId: `v${index}`,
          genotype: { values },
        }),
      );
      fetcher.mockImplementation(async (url: string) =>
        jsonResponse(envelope({ data: pathnameOf(url).endsWith('/search/calls') ? data : [] })),
      );
      const { result, structured, text } = await run(ctx, format);
      expect(result.isError).toBeFalsy();
      expect(register.mock.calls[0]?.[1].rows).toEqual([
        {
          callSetDbId: 'cs-1',
          callSetName: 'TME419',
          germplasmDbId: null,
          v0: '0',
          v1: '0.5',
          v2: '0/1',
        },
      ]);
      expect(structured.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('dosage')]),
      );
      expect(text).toContain('dosage');
      if (format === 'plink') {
        expect(structured.ped).toBe('0\tTME419\t0\t0\t0\t0\t0\t0\t0\t0\t1\t2');
        expect(text).toContain(structured.ped);
      } else {
        expect((structured.vcf as string).split('\n').slice(1)).toEqual([
          '.\t.\tv0\t.\t.\t.',
          '.\t.\tv1\t.\t.\t.',
          '.\t.\tv2\t.\t.\t0/1',
        ]);
        expect(text).toContain(structured.vcf);
      }
    },
  );

  it.each(['matrix-json', 'vcf-lite', 'plink'] as const)(
    'returns a typed, empty %s export with no metadata fetch',
    async (format) => {
      const ctx = await connect(fetcher);
      fetcher.mockResolvedValueOnce(jsonResponse(envelope({ data: [] })));
      const { result, structured, text } = await run(ctx, format);
      expect(result.isError).toBeFalsy();
      expect(structured).toMatchObject({
        rowCount: 0,
        columnCount: 0,
        variantColumnLegend: {},
        dataframe: { columns: ['callSetDbId', 'callSetName', 'germplasmDbId'], rowCount: 0 },
        notice: expect.stringContaining('No calls matched'),
      });
      const tableName = (structured.dataframe as { tableName: string }).tableName;
      expect(structured.notice).toContain(`Staged dataframe \`${tableName}\` (0 rows)`);
      expect(structured.notice).toContain('brapi_dataframe_describe');
      expect(structured.notice).toContain('brapi_dataframe_query');
      expect(text).toContain(structured.notice);
      expect(await getCanvasBridge().describe(ctx, { tableName })).toMatchObject([
        {
          name: tableName,
          rowCount: 0,
          provenance: { source: 'export_genotype_matrix' },
        },
      ]);
      expect(text).toContain('No calls matched');
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(structured.vcf).toBe(format === 'vcf-lite' ? '#CHROM\tPOS\tID\tREF\tALT' : undefined);
      expect(structured.ped).toBe(format === 'plink' ? '' : undefined);
      expect(structured.map).toBe(format === 'plink' ? '' : undefined);
    },
  );

  it('recodes indexed PED calls and preserves raw calls with incomplete or mixed metadata', async () => {
    const ctx = await connect(fetcher);
    const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
    const data = ['0/0', '0/1', '0/.', '0/2', '0/1'].map((genotypeValue, index) =>
      call({
        variantDbId: `v${index}`,
        genotype: null,
        genotypeValue,
      }),
    );
    data.push(
      call({
        callSetDbId: 'cs-2',
        callSetName: 'second',
        variantDbId: 'v4',
        genotype: { values: ['A', 'G'] },
      }),
    );
    fetcher.mockImplementation(async (url: string) =>
      jsonResponse(
        envelope({
          data: pathnameOf(url).endsWith('/search/calls')
            ? data
            : [
                { variantDbId: 'v0', referenceBases: 'A', alternateBases: ['G'] },
                { variantDbId: 'v3', referenceBases: 'C', alternateBases: [null, 'T'] },
              ],
          unknownString: '.',
        }),
      ),
    );
    const { result, structured, text } = await run(ctx, 'plink');
    expect(result.isError).toBeFalsy();
    expect(structured.ped).toBe(
      [
        '0\tTME419\t0\t0\t0\t0\tA\tA\t1\t2\t0\t0\tC\tT\t0\t0',
        '0\tsecond\t0\t0\t0\t0\t0\t0\t0\t0\t0\t0\t0\t0\tA\tG',
      ].join('\n'),
    );
    expect(text).toContain(structured.ped);
    expect(text).toContain('numeric labels');
    expect(text).toContain('literal');
    expect(register.mock.calls[0]?.[1].rows[0]).toMatchObject({
      v0: '0/0',
      v1: '0/1',
      v2: '0/.',
      v3: '0/2',
      v4: '0/1',
    });
  });

  it('propagates cancellation during variant metadata collection before staging', async () => {
    const ctx = await connect(fetcher);
    const controller = new AbortController();
    const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
    fetcher.mockImplementation(async (url: string) => {
      if (pathnameOf(url).endsWith('/search/calls')) {
        return jsonResponse(envelope({ data: [call()] }));
      }
      controller.abort();
      throw controller.signal.reason;
    });
    await expect(
      brapiExportGenotypeMatrix.handler(
        brapiExportGenotypeMatrix.input.parse({ variantSetDbId: 'vset-1', format: 'plink' }),
        { ...ctx, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(register).not.toHaveBeenCalled();
  });

  it('keeps numeric PED calls when variant metadata fails', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(async (url: string) => {
      if (pathnameOf(url).endsWith('/search/calls')) {
        return jsonResponse(
          envelope({
            data: [call({ genotype: { values: ['0', '1'] } })],
            sepUnphased: '::',
          }),
        );
      }
      throw new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Variant endpoint failed.', {
        status: 500,
        errorSource: 'FetchHttpError',
      });
    });
    const { result, structured, text } = await run(ctx, 'plink');
    expect(result.isError).toBeFalsy();
    expect(structured.ped).toBe('0\tTME419\t0\t0\t0\t0\t1\t2');
    expect(structured.map).toBe('0\tv-1\t0\t0');
    expect(text).toContain('Variant metadata could not be fully retrieved');
    expect(text).toContain('numeric labels');
  });

  it('uses earlier formatting hints to decode PED calls from a later page', async () => {
    const ctx = await connect(fetcher);
    const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
    fetcher.mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/search/calls')) {
        return jsonResponse(envelope({ searchResultsDbId: 'calls-job' }), 202);
      }
      if (parsed.pathname.endsWith('/variants')) return jsonResponse(envelope({ data: [] }));
      const page = Number(parsed.searchParams.get('page'));
      return jsonResponse({
        metadata: { pagination: { currentPage: page, totalPages: 2 } },
        result:
          page === 0
            ? {
                sepUnphased: '::',
                unknownString: 'NA',
                data: [call({ variantDbId: 'v0', genotype: { values: ['0', '1'] } })],
              }
            : {
                sepPhased: '|',
                data: [call({ variantDbId: 'v1', genotype: { values: '0::NA' } })],
              },
      });
    });

    const { result, structured, text } = await run(ctx, 'plink');
    expect(result.isError).toBeFalsy();
    expect(structured.ped).toBe('0\tTME419\t0\t0\t0\t0\t1\t2\t0\t0');
    expect(text).toContain(structured.ped);
    expect(register.mock.calls[0]?.[1].rows).toEqual([
      { callSetDbId: 'cs-1', callSetName: 'TME419', germplasmDbId: null, v0: '0::1', v1: '0::NA' },
    ]);
  });

  it('preserves names and encounter order for opaque sample identifiers', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      call({ callSetDbId: '__proto__', callSetName: 'First sample', variantDbId: 'v0' }),
      call({ callSetDbId: 'constructor', callSetName: 'Second sample', variantDbId: 'v0' }),
      call({ callSetDbId: '__proto__', callSetName: 'Ignored repeat', variantDbId: 'v1' }),
    ];
    fetcher.mockImplementation(async (url: string) =>
      jsonResponse(envelope({ data: pathnameOf(url).endsWith('/search/calls') ? rows : [] })),
    );
    const { result, structured, text } = await run(ctx, 'vcf-lite');
    expect(result.isError).toBeFalsy();
    expect(structured.rowCount).toBe(2);
    const header = '#CHROM\tPOS\tID\tREF\tALT\tFirst sample\tSecond sample';
    expect((structured.vcf as string).split('\n')[0]).toBe(header);
    expect(text).toContain(header);
  });

  it('names the matrix dataframe and the dataframe tools in a notice, adding export only when registered', async () => {
    const run = async () => {
      const ctx = await connect(fetcher);
      fetcher.mockImplementation(async (url: string) => {
        const u = new URL(String(url));
        if (u.hostname !== 'brapi.example.org' || u.pathname !== '/brapi/v2/search/calls') {
          throw new Error(`unmocked fetch: ${u.href}`);
        }
        return jsonResponse(
          envelope({ data: [call(), call({ callSetDbId: 'cs-2', callSetName: 'TMS' })] }),
        );
      });
      const definition = {
        ...brapiExportGenotypeMatrix,
        handler: (input, contractCtx) =>
          brapiExportGenotypeMatrix.handler(input, { ...contractCtx, state: ctx.state }),
      } satisfies typeof brapiExportGenotypeMatrix;
      const result = await runToolContract(
        definition,
        { variantSetDbId: 'vset-1', format: 'matrix-json' },
        { context: { tenantId: 't1' } },
      );
      const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
      return { structured: result.structuredContent as Record<string, unknown>, text };
    };

    const exportOff = await run();
    const tableName = (exportOff.structured.dataframe as { tableName: string }).tableName;
    expect(exportOff.structured.notice).toBe(
      `Staged dataframe \`${tableName}\` (2 rows): list its columns with brapi_dataframe_describe, then query it with brapi_dataframe_query (SQL).`,
    );
    expect(exportOff.text).toContain(`> ${exportOff.structured.notice as string}`);

    vi.stubEnv('BRAPI_EXPORT_DIR', '/tmp/brapi-exports');
    resetServerConfig();
    const exportOn = await run();
    expect(exportOn.structured.notice).toMatch(
      /, or write it to a file with brapi_dataframe_export\.$/,
    );
  });

  it('rejects at Zod parse when variantSetDbId is omitted', () => {
    // variantSetDbId is required; Zod should reject when absent
    expect(() => brapiExportGenotypeMatrix.input.parse({ format: 'matrix-json' })).toThrow();
  });

  it('throws unknown_alias when no connection is registered for the alias', async () => {
    const ctx = createMockContext({ tenantId: 't2', errors: brapiExportGenotypeMatrix.errors });
    await expect(
      brapiExportGenotypeMatrix.handler(
        brapiExportGenotypeMatrix.input.parse({
          variantSetDbId: 'vset-1',
          format: 'matrix-json',
          alias: 'nonexistent',
        }),
        ctx,
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
  });

  it('throws ValidationError when /search/calls is not advertised', async () => {
    const ctx = await connect(fetcher, ['studies']);
    fetcher.mockResolvedValueOnce(jsonResponse(envelope({ data: [] })));
    await expect(
      brapiExportGenotypeMatrix.handler(
        brapiExportGenotypeMatrix.input.parse({
          variantSetDbId: 'vset-1',
          format: 'matrix-json',
        }),
        ctx,
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
  });

  it('throws ValidationError when the active dialect disables /search/calls', async () => {
    registerDialect({
      id: 'test-matrix-disabled-calls',
      disabledSearchEndpoints: new Set(['calls']),
      adaptGetFilters: (_endpoint, filters) => ({ filters: { ...filters }, warnings: [] }),
    });
    vi.stubEnv('BRAPI_DEFAULT_DIALECT', 'test-matrix-disabled-calls');
    const ctx = await connect(fetcher);
    await expect(
      brapiExportGenotypeMatrix.handler(
        brapiExportGenotypeMatrix.input.parse({
          variantSetDbId: 'vset-1',
          format: 'matrix-json',
        }),
        ctx,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'search_endpoint_disabled', dialectId: 'test-matrix-disabled-calls' },
    });
  });

  it('produces a matrix-json dataframe for a multi-germplasm multi-variant pull', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      call({ callSetDbId: 'cs-1', variantDbId: 'v-1', genotype: { values: ['A', 'G'] } }),
      call({ callSetDbId: 'cs-1', variantDbId: 'v-2', genotype: { values: ['C', 'C'] } }),
      call({
        callSetDbId: 'cs-2',
        callSetName: 'TMS-30572',
        variantDbId: 'v-1',
        genotype: { values: ['A', 'A'] },
      }),
      call({
        callSetDbId: 'cs-2',
        callSetName: 'TMS-30572',
        variantDbId: 'v-2',
        genotype: { values: ['C', 'T'] },
      }),
    ];
    fetcher.mockResolvedValueOnce(
      jsonResponse(
        envelope({
          data: rows,
          unknownString: '.',
          sepUnphased: '/',
        }),
      ),
    );

    const result = await brapiExportGenotypeMatrix.handler(
      brapiExportGenotypeMatrix.input.parse({
        variantSetDbId: 'vset-1',
        format: 'matrix-json',
      }),
      ctx,
    );

    expect(result.rowCount).toBe(2); // cs-1, cs-2
    expect(result.columnCount).toBe(2); // v-1, v-2
    expect(result.dataframe.rowCount).toBe(2);
    expect(result.format).toBe('matrix-json');
    expect(result.callFormatting.unknownString).toBe('.');
    expect(result.callFormatting.sepUnphased).toBe('/');
    // Columns should include v-1 and v-2 (sanitized)
    expect(result.dataframe.columns).toContain('v_1');
    expect(result.dataframe.columns).toContain('v_2');
    // germplasmDbId column present
    expect(result.dataframe.columns).toContain('germplasmDbId');
    // Legend maps sanitized names back to originals
    expect(result.variantColumnLegend.v_1).toBe('v-1');
    expect(result.variantColumnLegend.v_2).toBe('v-2');
  });

  it('sanitizes reserved SQL keyword variant IDs into valid column names', async () => {
    const ctx = await connect(fetcher);
    // 'end' and 'null' are reserved; 'order' is also reserved
    const rows = [
      call({ callSetDbId: 'cs-1', variantDbId: 'end', genotype: { values: ['A'] } }),
      call({ callSetDbId: 'cs-1', variantDbId: 'null', genotype: { values: ['G'] } }),
      call({ callSetDbId: 'cs-1', variantDbId: 'order', genotype: { values: ['T'] } }),
    ];
    fetcher.mockResolvedValueOnce(jsonResponse(envelope({ data: rows })));

    const result = await brapiExportGenotypeMatrix.handler(
      brapiExportGenotypeMatrix.input.parse({
        variantSetDbId: 'vset-1',
        format: 'matrix-json',
      }),
      ctx,
    );

    // Columns should NOT be bare reserved words
    const cols = result.dataframe.columns;
    expect(cols).not.toContain('end');
    expect(cols).not.toContain('null');
    expect(cols).not.toContain('order');
    // They should be suffixed with underscore
    expect(cols).toContain('end_');
    expect(cols).toContain('null_');
    expect(cols).toContain('order_');
    // Legend maps back correctly
    expect(result.variantColumnLegend.end_).toBe('end');
    expect(result.variantColumnLegend.null_).toBe('null');
    expect(result.variantColumnLegend.order_).toBe('order');
  });

  it('sanitizes variant IDs with hyphens and leading digits', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      call({ callSetDbId: 'cs-1', variantDbId: '1variant', genotype: { values: ['A'] } }),
      call({ callSetDbId: 'cs-1', variantDbId: 'var-iant', genotype: { values: ['G'] } }),
    ];
    fetcher.mockResolvedValueOnce(jsonResponse(envelope({ data: rows })));

    const result = await brapiExportGenotypeMatrix.handler(
      brapiExportGenotypeMatrix.input.parse({
        variantSetDbId: 'vset-1',
        format: 'matrix-json',
      }),
      ctx,
    );

    const cols = result.dataframe.columns;
    // '1variant' starts with digit → prepend 'v_'
    expect(cols).toContain('v_1variant');
    // 'var-iant' hyphen → underscore
    expect(cols).toContain('var_iant');
  });

  it('uses genotypeValue fallback when genotype.values is absent', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      {
        callSetDbId: 'cs-1',
        variantDbId: 'v-1',
        variantSetDbId: 'vset-1',
        genotypeValue: 'A/T',
      },
    ];
    fetcher.mockResolvedValueOnce(jsonResponse(envelope({ data: rows })));

    const result = await brapiExportGenotypeMatrix.handler(
      brapiExportGenotypeMatrix.input.parse({
        variantSetDbId: 'vset-1',
        format: 'matrix-json',
      }),
      ctx,
    );

    expect(result.rowCount).toBe(1);
    expect(result.dataframe.rowCount).toBe(1);
  });

  it('sets truncated flag when maxCalls is hit', async () => {
    const ctx = await connect(fetcher);
    const rows = Array.from({ length: 5 }, (_, i) =>
      call({ callSetDbId: `cs-${i + 1}`, variantDbId: 'v-1' }),
    );
    fetcher.mockResolvedValueOnce(jsonResponse(envelope({ data: rows })));

    const result = await brapiExportGenotypeMatrix.handler(
      brapiExportGenotypeMatrix.input.parse({
        variantSetDbId: 'vset-1',
        format: 'matrix-json',
        maxCalls: 3,
      }),
      ctx,
    );

    expect(result.truncated).toBe(true);
    expect(result.dataframe.truncated).toBe(true);
    expect(result.rowCount).toBeLessThanOrEqual(3);
  });

  it('characterizes missing coordinate placeholders on both contract surfaces', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(async (url: string) =>
      jsonResponse(envelope({ data: pathnameOf(url).endsWith('/search/calls') ? [call()] : [] })),
    );
    const definition = {
      ...brapiExportGenotypeMatrix,
      handler: (input, contractCtx) =>
        brapiExportGenotypeMatrix.handler(input, { ...contractCtx, state: ctx.state }),
    } satisfies typeof brapiExportGenotypeMatrix;
    const result = await runToolContract(
      definition,
      { variantSetDbId: 'vs', format: 'vcf-lite' },
      { context: { tenantId: 't1' } },
    );
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { vcf: string }).vcf).toContain('.\t.\tv-1\t.\t.');
    expect(JSON.stringify(result.content)).toContain('v-1');
  });

  for (const format of ['vcf-lite', 'plink'] as const) {
    it(`${format}: converts valid zero-based starts and preserves missing/invalid coordinates`, async () => {
      const starts = [
        0,
        500,
        '0',
        '500',
        ' 500 ',
        '5e2',
        '00500',
        null,
        undefined,
        '',
        'oops',
        -1,
        1.5,
        '-1',
        '1.5',
        '0x10',
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER - 1,
      ];
      const expected = [
        '1',
        '501',
        '1',
        '501',
        '501',
        '501',
        '501',
        ...Array(10).fill(format === 'vcf-lite' ? '.' : '0'),
        String(Number.MAX_SAFE_INTEGER),
      ];
      const ctx = await connect(fetcher);
      const calls = starts.map((_, i) => call({ variantDbId: `v-${i}` }));
      const variants = starts.map((start, i) => ({
        variantDbId: `v-${i}`,
        referenceName: 'chr1',
        ...(start === undefined ? {} : { start }),
      }));
      fetcher.mockImplementation(async (url: string) =>
        jsonResponse(
          envelope({ data: pathnameOf(url).endsWith('/search/calls') ? calls : variants }),
        ),
      );
      const definition = {
        ...brapiExportGenotypeMatrix,
        handler: (input, contractCtx) =>
          brapiExportGenotypeMatrix.handler(input, { ...contractCtx, state: ctx.state }),
      } satisfies typeof brapiExportGenotypeMatrix;
      const result = await runToolContract(
        definition,
        { variantSetDbId: 'vs', format },
        { context: { tenantId: 't1' } },
      );
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { vcf?: string; map?: string };
      const lines = (format === 'vcf-lite' ? structured.vcf! : structured.map!)
        .split('\n')
        .slice(format === 'vcf-lite' ? 1 : 0);
      expect(lines.map((line) => line.split('\t')[format === 'vcf-lite' ? 1 : 3])).toEqual(
        expected,
      );
      const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
      expect(text).toContain(format === 'vcf-lite' ? 'chr1\t1\tv-0' : 'chr1\tv-0\t0\t1');
      expect(text).toContain(format === 'vcf-lite' ? 'chr1\t501\tv-1' : 'chr1\tv-1\t0\t501');
      expect(text).toContain(format === 'vcf-lite' ? 'chr1\t.\tv-7' : 'chr1\tv-7\t0\t0');
      expect(text).toContain(format === 'vcf-lite' ? 'chr1\t.\tv-11' : 'chr1\tv-11\t0\t0');
    });
  }

  it('converts metadata after the first page, including array-shaped upstream results', async () => {
    const ctx = await connect(fetcher);
    const first = Array.from({ length: 1000 }, (_, i) => ({
      variantDbId: i === 0 ? 'v-0' : `unused-${i}`,
      start: 0,
    }));
    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith('/search/calls'))
        return jsonResponse(
          envelope({ data: [call({ variantDbId: 'v-0' }), call({ variantDbId: 'v-1' })] }),
        );
      const page = Number(u.searchParams.get('page'));
      return jsonResponse({
        metadata: { pagination: { totalPages: 2 } },
        result: page === 0 ? { data: first } : [{ variantDbId: 'v-1', start: '500' }],
      });
    });
    const result = await brapiExportGenotypeMatrix.handler(
      brapiExportGenotypeMatrix.input.parse({ variantSetDbId: 'vs', format: 'plink' }),
      ctx,
    );
    expect(result.map).toBe('0\tv-0\t0\t1\n0\tv-1\t0\t501');
    expect(JSON.stringify(brapiExportGenotypeMatrix.format(result))).toContain('501');
    expect(
      fetcher.mock.calls.filter(([url]) => pathnameOf(url).endsWith('/variants')),
    ).toHaveLength(2);
  });

  it('vcf-lite: renders VCF text with CHROM/POS/REF/ALT from /variants and a genotype column per sample', async () => {
    const ctx = await connect(fetcher);
    const callRows = [
      call({
        callSetDbId: 'cs-1',
        callSetName: 'S1',
        variantDbId: 'variant01',
        genotype: { values: ['0/0'] },
      }),
      call({
        callSetDbId: 'cs-1',
        callSetName: 'S1',
        variantDbId: 'variant02',
        genotype: { values: ['0/1'] },
      }),
      call({
        callSetDbId: 'cs-2',
        callSetName: 'S2',
        variantDbId: 'variant01',
        genotype: { values: ['1/1'] },
      }),
      call({
        callSetDbId: 'cs-2',
        callSetName: 'S2',
        variantDbId: 'variant02',
        genotype: { values: ['0/0'] },
      }),
    ];
    const variantRows = [
      {
        variantDbId: 'variant01',
        referenceName: 'chr1',
        start: 1000,
        referenceBases: 'A',
        alternateBases: ['T'],
      },
      {
        variantDbId: 'variant02',
        referenceName: 'chr1',
        start: 2000,
        referenceBases: 'C',
        alternateBases: ['G'],
      },
    ];
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/search/calls')) {
        return jsonResponse(envelope({ data: callRows, unknownString: '.', sepUnphased: '/' }));
      }
      if (path.endsWith('/variants')) {
        return jsonResponse(envelope({ data: variantRows }, { totalCount: variantRows.length }));
      }
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });

    const result = await brapiExportGenotypeMatrix.handler(
      brapiExportGenotypeMatrix.input.parse({ variantSetDbId: 'variantset1', format: 'vcf-lite' }),
      ctx,
    );

    expect(result.format).toBe('vcf-lite');
    expect(result.vcf).toBeDefined();
    const vcfLines = (result.vcf ?? '').split('\n');
    expect(vcfLines[0]).toBe('#CHROM\tPOS\tID\tREF\tALT\tS1\tS2');
    expect(vcfLines).toContain('chr1\t1001\tvariant01\tA\tT\t0/0\t1/1');
    expect(vcfLines).toContain('chr1\t2001\tvariant02\tC\tG\t0/1\t0/0');
    expect(result.ped).toBeUndefined();
    expect(result.map).toBeUndefined();
  });

  it('vcf-lite: uses "." placeholders when /variants has no coordinates', async () => {
    const ctx = await connect(fetcher);
    const callRows = [
      call({
        callSetDbId: 'cs-1',
        callSetName: 'S1',
        variantDbId: 'variant01',
        genotype: { values: ['0/1'] },
      }),
    ];
    const variantRows = [
      {
        variantDbId: 'variant01',
        referenceName: null,
        start: null,
        referenceBases: null,
        alternateBases: [],
      },
    ];
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/search/calls')) {
        return jsonResponse(envelope({ data: callRows, unknownString: '.', sepUnphased: '/' }));
      }
      if (path.endsWith('/variants')) {
        return jsonResponse(envelope({ data: variantRows }, { totalCount: 1 }));
      }
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });

    const result = await brapiExportGenotypeMatrix.handler(
      brapiExportGenotypeMatrix.input.parse({ variantSetDbId: 'variantset1', format: 'vcf-lite' }),
      ctx,
    );

    const vcfLines = (result.vcf ?? '').split('\n');
    expect(vcfLines[0]).toBe('#CHROM\tPOS\tID\tREF\tALT\tS1');
    expect(vcfLines).toContain('.\t.\tvariant01\t.\t.\t0/1');
  });

  it('plink: renders .ped biallelic pairs and .map with chrom/pos from /variants', async () => {
    const ctx = await connect(fetcher);
    const callRows = [
      call({
        callSetDbId: 'cs-1',
        callSetName: 'S1',
        variantDbId: 'variant01',
        genotype: { values: ['A/A'] },
      }),
      call({
        callSetDbId: 'cs-1',
        callSetName: 'S1',
        variantDbId: 'variant02',
        genotype: { values: ['A/G'] },
      }),
    ];
    const variantRows = [
      { variantDbId: 'variant01', referenceName: 'chr1', start: 1000 },
      { variantDbId: 'variant02', referenceName: 'chr1', start: 2000 },
    ];
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/search/calls')) {
        return jsonResponse(envelope({ data: callRows, unknownString: '.', sepUnphased: '/' }));
      }
      if (path.endsWith('/variants')) {
        return jsonResponse(envelope({ data: variantRows }, { totalCount: variantRows.length }));
      }
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });

    const result = await brapiExportGenotypeMatrix.handler(
      brapiExportGenotypeMatrix.input.parse({ variantSetDbId: 'variantset1', format: 'plink' }),
      ctx,
    );

    expect(result.format).toBe('plink');
    expect(result.map).toBeDefined();
    expect(result.ped).toBeDefined();
    const mapLines = (result.map ?? '').split('\n');
    expect(mapLines).toContain('chr1\tvariant01\t0\t1001');
    expect(mapLines).toContain('chr1\tvariant02\t0\t2001');
    // FID IID PAT MAT SEX PHENO + biallelic pairs (variant01 A/A → A A, variant02 A/G → A G)
    expect(result.ped).toBe('0\tS1\t0\t0\t0\t0\tA\tA\tA\tG');
    expect(result.vcf).toBeUndefined();
  });

  it('clamps maxCalls to the deployment ceiling and reports the effective cap', async () => {
    vi.stubEnv('BRAPI_GENOTYPE_CALLS_MAX_PULL', '2');
    const ctx = await connect(fetcher);
    const rows = Array.from({ length: 5 }, (_, i) =>
      call({ callSetDbId: `cs-${i + 1}`, variantDbId: 'v-1' }),
    );
    fetcher.mockResolvedValueOnce(jsonResponse(envelope({ data: rows })));

    const result = await brapiExportGenotypeMatrix.handler(
      brapiExportGenotypeMatrix.input.parse({
        variantSetDbId: 'vset-1',
        format: 'matrix-json',
        maxCalls: 400_000,
      }),
      ctx,
    );

    // The operator's ceiling wins over the caller's override.
    expect(result.rowCount).toBeLessThanOrEqual(2);
    expect(result.dataframe.maxRows).toBe(2);
    expect(result.warnings.some((w) => w.includes("deployment's genotype-call ceiling (2)"))).toBe(
      true,
    );
    expect(JSON.stringify(result.warnings)).not.toContain('BRAPI_');
    expect(result.warnings.some((w) => w.includes('capped at 2 calls'))).toBe(true);
  });

  it('describes deployment ceilings without operator environment names', () => {
    expect(brapiExportGenotypeMatrix.input.shape.maxCalls.description).not.toContain('BRAPI_');
    expect(brapiExportGenotypeMatrix.input.shape.maxColumns.description).not.toContain('BRAPI_');
  });

  it('honors a maxCalls that lowers the pull below the ceiling, without warning', async () => {
    vi.stubEnv('BRAPI_GENOTYPE_CALLS_MAX_PULL', '100000');
    const ctx = await connect(fetcher);
    const rows = Array.from({ length: 5 }, (_, i) =>
      call({ callSetDbId: `cs-${i + 1}`, variantDbId: 'v-1' }),
    );
    fetcher.mockResolvedValueOnce(jsonResponse(envelope({ data: rows })));

    const result = await brapiExportGenotypeMatrix.handler(
      brapiExportGenotypeMatrix.input.parse({
        variantSetDbId: 'vset-1',
        format: 'matrix-json',
        maxCalls: 3,
      }),
      ctx,
    );

    expect(result.rowCount).toBeLessThanOrEqual(3);
    expect(result.warnings.some((w) => w.includes('exceeds this deployment'))).toBe(false);
  });

  it('rejects a maxCalls above the absolute ceiling at Zod parse', () => {
    expect(() =>
      brapiExportGenotypeMatrix.input.parse({
        variantSetDbId: 'vset-1',
        format: 'matrix-json',
        maxCalls: 500_001,
      }),
    ).toThrow();
    // The ceiling itself stays accepted.
    expect(() =>
      brapiExportGenotypeMatrix.input.parse({
        variantSetDbId: 'vset-1',
        format: 'matrix-json',
        maxCalls: 500_000,
      }),
    ).not.toThrow();
  });

  it('clamps columnCount to the deployment ceiling on a skewed one-call-set pull', async () => {
    vi.stubEnv('BRAPI_GENOTYPE_MATRIX_MAX_COLUMNS', '2');
    const ctx = await connect(fetcher);
    // The schema-legal skew #46 bounds: one call set × five distinct variants.
    const rows = Array.from({ length: 5 }, (_, i) =>
      call({ callSetDbId: 'cs-1', variantDbId: `v-${i + 1}` }),
    );
    fetcher.mockResolvedValueOnce(jsonResponse(envelope({ data: rows })));

    const result = await brapiExportGenotypeMatrix.handler(
      brapiExportGenotypeMatrix.input.parse({
        variantSetDbId: 'vset-1',
        format: 'matrix-json',
        maxColumns: 100,
      }),
      ctx,
    );

    // Distinct variants (5) exceed the column ceiling (2) → capped, not 5.
    expect(result.columnCount).toBe(2);
    expect(Object.keys(result.variantColumnLegend)).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.dataframe.truncated).toBe(true);
    // `maxRows` stays row-scoped — a pure column cap never sets it.
    expect(result.dataframe.maxRows).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('more than 2 distinct variants'))).toBe(true);
    expect(
      result.warnings.some((w) => w.includes("deployment's genotype-matrix column ceiling (2)")),
    ).toBe(true);
    expect(JSON.stringify(result.warnings)).not.toContain('BRAPI_');
    expect(JSON.stringify(brapiExportGenotypeMatrix.format(result))).toContain(
      'column ceiling (2)',
    );
    // The single call-set row survives; only beyond-cap variant columns drop.
    expect(result.rowCount).toBe(1);
    expect(result.dataframe.columns).toContain('germplasmDbId');
  });

  it('preserves every call-set row when a call set covers only beyond-cap variants (#46)', async () => {
    const ctx = await connect(fetcher);
    // Call-set-major order with disjoint variant coverage — the common
    // Breedbase /search/calls shape. cs-1 fills the 2-column cap (v-1, v-2);
    // cs-2's calls reference ONLY v-3/v-4, both net-new after the cap filled.
    // cs-2 must still appear — as an all-null row — not vanish from the matrix.
    const rows = [
      call({ callSetDbId: 'cs-1', callSetName: 'G1', variantDbId: 'v-1' }),
      call({ callSetDbId: 'cs-1', callSetName: 'G1', variantDbId: 'v-2' }),
      call({ callSetDbId: 'cs-2', callSetName: 'G2', variantDbId: 'v-3' }),
      call({ callSetDbId: 'cs-2', callSetName: 'G2', variantDbId: 'v-4' }),
    ];
    fetcher.mockResolvedValueOnce(jsonResponse(envelope({ data: rows })));

    const result = await brapiExportGenotypeMatrix.handler(
      brapiExportGenotypeMatrix.input.parse({
        variantSetDbId: 'vset-1',
        format: 'matrix-json',
        maxColumns: 2,
      }),
      ctx,
    );

    // Both call sets survive — the point of the fix. Pre-fix, cs-2 (whose calls
    // all hit the beyond-cap `continue`) was never registered, so rowCount was 1
    // and its entire row silently disappeared.
    expect(result.rowCount).toBe(2);
    expect(result.dataframe.rowCount).toBe(2);
    // Columns are capped to the kept variants only; v-3/v-4 are dropped.
    expect(result.columnCount).toBe(2);
    expect(Object.keys(result.variantColumnLegend)).toHaveLength(2);
    expect(Object.values(result.variantColumnLegend)).toContain('v-1');
    expect(Object.values(result.variantColumnLegend)).toContain('v-2');
    expect(Object.values(result.variantColumnLegend)).not.toContain('v-3');
    expect(Object.values(result.variantColumnLegend)).not.toContain('v-4');
    // The cap still trips the truncation flags.
    expect(result.truncated).toBe(true);
    expect(result.dataframe.truncated).toBe(true);
  });

  it('honors a maxColumns that lowers the cap below the ceiling, without a clamp warning', async () => {
    vi.stubEnv('BRAPI_GENOTYPE_MATRIX_MAX_COLUMNS', '10000');
    const ctx = await connect(fetcher);
    const rows = Array.from({ length: 5 }, (_, i) =>
      call({ callSetDbId: 'cs-1', variantDbId: `v-${i + 1}` }),
    );
    fetcher.mockResolvedValueOnce(jsonResponse(envelope({ data: rows })));

    const result = await brapiExportGenotypeMatrix.handler(
      brapiExportGenotypeMatrix.input.parse({
        variantSetDbId: 'vset-1',
        format: 'matrix-json',
        maxColumns: 2,
      }),
      ctx,
    );

    expect(result.columnCount).toBe(2);
    expect(result.truncated).toBe(true);
    // A caller-lowered cap is not a deployment-ceiling breach — no clamp warning.
    expect(result.warnings.some((w) => w.includes('exceeds this deployment'))).toBe(false);
    // ...but the genuine column-truncation warning still fires.
    expect(result.warnings.some((w) => w.includes('distinct variants'))).toBe(true);
  });

  it('rejects a maxColumns above the absolute ceiling at Zod parse', () => {
    expect(() =>
      brapiExportGenotypeMatrix.input.parse({
        variantSetDbId: 'vset-1',
        format: 'matrix-json',
        maxColumns: 500_001,
      }),
    ).toThrow();
    // The ceiling itself stays accepted.
    expect(() =>
      brapiExportGenotypeMatrix.input.parse({
        variantSetDbId: 'vset-1',
        format: 'matrix-json',
        maxColumns: 500_000,
      }),
    ).not.toThrow();
  });

  it('format(): renders every column remapping, not just the first 20', () => {
    const legend = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`v_variant_${i}`, `variant-${i}`]),
    );
    const text = renderExport({ variantColumnLegend: legend, columnCount: 30 });
    for (const [col, orig] of Object.entries(legend)) {
      expect(text).toContain(`\`${col}\` → \`${orig}\``);
    }
    expect(text).not.toContain('and 10 more');
  });

  it('format(): the vcf preview notice names the dataframe and discloses the coordinate gap', () => {
    const vcf = ['#CHROM\tPOS\tID\tREF\tALT\tS1']
      .concat(Array.from({ length: 30 }, (_, i) => `chr1\t${i}\tvariant${i}\tA\tT\t0/1`))
      .join('\n');
    const text = renderExport({ vcf, dataframeTableName: 'df_QWERT_12345' });

    // Named the retrieval path a content-only client can actually take...
    expect(text).toContain('df_QWERT_12345');
    expect(text).toContain('brapi_dataframe_query');
    expect(text).toContain('Every call set × variant genotype');
    expect(text).toContain('# Genotype matrix — vcf-lite — 1 call sets × 1 variants');
    // ...without overclaiming it as a complete substitute for the text.
    expect(text).toContain('genotypes only');
    expect(text).toContain('CHROM/POS/REF/ALT');
    // Still a preview — complete render is unsafe at the pull ceiling.
    expect(text).toContain('more line(s) not shown');
    expect(text).not.toContain('variant29');
  });

  it('plink: missing genotype → "0 0", absent variant coords → "0"', async () => {
    const ctx = await connect(fetcher);
    const callRows = [
      call({
        callSetDbId: 'cs-1',
        callSetName: 'S1',
        variantDbId: 'variant01',
        genotype: { values: ['A/T'] },
      }),
      call({
        callSetDbId: 'cs-2',
        callSetName: 'S2',
        variantDbId: 'variant02',
        genotype: { values: ['G/G'] },
      }),
    ];
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/search/calls')) {
        return jsonResponse(envelope({ data: callRows, unknownString: '.', sepUnphased: '/' }));
      }
      if (path.endsWith('/variants')) {
        return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
      }
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });

    const result = await brapiExportGenotypeMatrix.handler(
      brapiExportGenotypeMatrix.input.parse({ variantSetDbId: 'variantset1', format: 'plink' }),
      ctx,
    );

    const mapLines = (result.map ?? '').split('\n');
    expect(mapLines).toContain('0\tvariant01\t0\t0');
    // S1: variant01 A/T → A T, variant02 (no call) → 0 0
    expect(result.ped).toContain('0\tS1\t0\t0\t0\t0\tA\tT\t0\t0');
    // S2: variant01 (no call) → 0 0, variant02 G/G → G G
    expect(result.ped).toContain('0\tS2\t0\t0\t0\t0\t0\t0\tG\tG');
  });
});

describe('brapi_export_genotype_matrix variant-set discovery', () => {
  it('names where a variantSetDbId comes from', () => {
    const description = brapiExportGenotypeMatrix.input.shape.variantSetDbId.description ?? '';
    expect(description).toContain('brapi_raw_get({ path: "/variantsets" })');
    expect(description).toContain('params.studyDbId');
  });
});

// ---------------------------------------------------------------------------
// Shared fixtures for call-set identity (#128), variantDbIds (#129), and the
// pull / metadata disclosures.
// ---------------------------------------------------------------------------

/** Three of the BrAPI test server's `variantset1` call sets, as GET /callsets returns them. */
const CALL_SETS = [
  { callSetDbId: 'callset01', callSetName: 'P2', sampleDbId: 'sample3' },
  { callSetDbId: 'callset02', callSetName: 'F1-1', sampleDbId: 'sample2' },
  { callSetDbId: 'callset03', callSetName: 'F1-2', sampleDbId: 'sample1' },
];

const SAMPLE_GERMPLASM: Record<string, string> = {
  sample1: 'germplasm1',
  sample2: 'germplasm2',
  sample3: 'germplasm3',
};

/** `count` call sets `cs<i>`, each naming its own sample `s<i>`. */
function sampleBackedCallSets(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    callSetDbId: `cs${i}`,
    callSetName: `line-${i}`,
    sampleDbId: `s${i}`,
  }));
}

/** A genotyping server: calls search, call-set listing, and sample search. */
const GENOTYPING_CALLS: AdvertisedCall[] = [
  'search/calls',
  { service: 'callsets', methods: ['GET'] },
  'search/samples',
];

/** Call-set-major call rows: every call set called at every variant, in order. */
function callsFor(
  callSets: readonly { callSetDbId?: string; callSetName?: string }[],
  variants: readonly string[] = ['variant01', 'variant02'],
): Record<string, unknown>[] {
  return callSets.flatMap((cs) =>
    variants.map((variantDbId) => ({
      ...(cs.callSetDbId !== undefined && { callSetDbId: cs.callSetDbId }),
      ...(cs.callSetName !== undefined && { callSetName: cs.callSetName }),
      variantDbId,
      variantSetDbId: 'vset-1',
      genotype: { values: ['0', '1'] },
    })),
  );
}

interface GenotypingUpstream {
  /** Rows GET /callsets pages through (default `CALL_SETS`). */
  callSets?: Record<string, unknown>[];
  /** Call rows POST /search/calls returns (one page unless `callsPage` overrides). */
  calls?: Record<string, unknown>[];
  /** Replace the GET /callsets handler. */
  callsets?: (url: URL) => Response | Promise<Response>;
  /** Replace the POST /search/calls handler. */
  callsPage?: (body: Record<string, unknown>) => Response | Promise<Response>;
  /** Replace the POST /search/samples handler. */
  samples?: (body: Record<string, unknown>) => Response | Promise<Response>;
  /** Replace the GET /variants handler. */
  variants?: (url: URL) => Response | Promise<Response>;
}

/** Page a row list the way the BrAPI test server pages GET /callsets. */
function pagedResponse(rows: readonly unknown[], url: URL): Response {
  const pageSize = Number(url.searchParams.get('pageSize'));
  const page = Number(url.searchParams.get('page'));
  return jsonResponse({
    metadata: {
      pagination: {
        currentPage: page,
        pageSize,
        totalCount: rows.length,
        totalPages: Math.ceil(rows.length / pageSize),
      },
    },
    result: { data: rows.slice(page * pageSize, (page + 1) * pageSize) },
  });
}

/** A scripted genotyping upstream; any other path fails the test. */
function genotypingUpstream(up: GenotypingUpstream) {
  return async (url: string, _timeoutMs: number, _ctx: unknown, init?: { body?: unknown }) => {
    const u = new URL(String(url));
    const body = () => JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (u.pathname.endsWith('/search/calls')) {
      return up.callsPage ? up.callsPage(body()) : jsonResponse(envelope({ data: up.calls ?? [] }));
    }
    if (u.pathname.endsWith('/callsets')) {
      return up.callsets ? up.callsets(u) : pagedResponse(up.callSets ?? CALL_SETS, u);
    }
    if (u.pathname.endsWith('/search/samples')) {
      if (up.samples) return up.samples(body());
      const ids = body().sampleDbIds as string[];
      return jsonResponse(
        envelope({
          data: ids
            .filter((id) => SAMPLE_GERMPLASM[id] !== undefined)
            .map((sampleDbId) => ({ sampleDbId, germplasmDbId: SAMPLE_GERMPLASM[sampleDbId] })),
        }),
      );
    }
    if (u.pathname.endsWith('/variants')) {
      return up.variants ? up.variants(u) : jsonResponse(envelope({ data: [] }));
    }
    throw new Error(`unmocked fetch: ${u.href}`);
  };
}

/** A POST /search/samples answer naming germplasm `g-<sampleDbId>` for every requested sample. */
function germplasmPerSample(body: Record<string, unknown>): Response {
  return jsonResponse(
    envelope({
      data: (body.sampleDbIds as string[]).map((sampleDbId) => ({
        sampleDbId,
        germplasmDbId: `g-${sampleDbId}`,
      })),
    }),
  );
}

/** The fetcher calls whose path ends with `suffix`. */
function requestsTo(fetcher: MockFetcher, suffix: string) {
  return fetcher.mock.calls.filter(([url]) => pathnameOf(url).endsWith(suffix));
}

/** JSON body of the first POST /search/calls request. */
function callsSearchBody(fetcher: MockFetcher): Record<string, unknown> {
  const [request] = requestsTo(fetcher, '/search/calls');
  return JSON.parse(String(request?.[3]?.body)) as Record<string, unknown>;
}

/** Run the export through the real tool contract against the connection on `ctx`. */
async function runExport(ctx: Context, input: Record<string, unknown>) {
  const definition = {
    ...brapiExportGenotypeMatrix,
    handler: (parsed, contractCtx) =>
      brapiExportGenotypeMatrix.handler(parsed, { ...contractCtx, state: ctx.state }),
  } satisfies typeof brapiExportGenotypeMatrix;
  const result = await runToolContract(
    definition,
    { variantSetDbId: 'vset-1', ...input },
    { context: { tenantId: 't1' } },
  );
  const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  return { result, structured: result.structuredContent as Record<string, unknown>, text };
}

function warningsOf(structured: Record<string, unknown>): string[] {
  return structured.warnings as string[];
}

const IDENTITY_COLUMNS = ['callSetDbId', 'callSetName', 'germplasmDbId'];

describe('brapi_export_genotype_matrix call-set rows and germplasm (#128)', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetTestServices();
    vi.unstubAllEnvs();
  });

  it('leads every row with callSetDbId, callSetName, and the germplasm resolved through its sample', async () => {
    vi.stubEnv('BRAPI_COMPANION_TIMEOUT_MS', '750');
    resetServerConfig();
    const ctx = await connect(fetcher, GENOTYPING_CALLS);
    const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
    fetcher.mockImplementation(genotypingUpstream({ calls: callsFor(CALL_SETS) }));

    const { result, structured, text } = await runExport(ctx, { format: 'matrix-json' });

    expect(result.isError).toBeFalsy();
    expect(register.mock.calls[0]?.[1].rows).toEqual([
      {
        callSetDbId: 'callset01',
        callSetName: 'P2',
        germplasmDbId: 'germplasm3',
        variant01: '0/1',
        variant02: '0/1',
      },
      {
        callSetDbId: 'callset02',
        callSetName: 'F1-1',
        germplasmDbId: 'germplasm2',
        variant01: '0/1',
        variant02: '0/1',
      },
      {
        callSetDbId: 'callset03',
        callSetName: 'F1-2',
        germplasmDbId: 'germplasm1',
        variant01: '0/1',
        variant02: '0/1',
      },
    ]);
    expect((structured.dataframe as { columns: string[] }).columns).toEqual([
      ...IDENTITY_COLUMNS,
      'variant01',
      'variant02',
    ]);
    expect(structured).toMatchObject({ rowCount: 3, columnCount: 2, warnings: [] });
    expect(text).toContain('3 call sets × 2 variants');

    // Batch lookups only: one call-set page for the variant set (singular GET
    // filter — the plural is ignored upstream), one sample search for the
    // distinct samples. Each on the companion timeout.
    const callsets = requestsTo(fetcher, '/callsets');
    expect(callsets).toHaveLength(1);
    const callsetsUrl = new URL(String(callsets[0]?.[0]));
    expect(callsetsUrl.searchParams.get('variantSetDbId')).toBe('vset-1');
    expect(callsetsUrl.searchParams.has('variantSetDbIds')).toBe(false);
    const samples = requestsTo(fetcher, '/search/samples');
    expect(samples).toHaveLength(1);
    expect(JSON.parse(String(samples[0]?.[3]?.body))).toMatchObject({
      sampleDbIds: ['sample3', 'sample2', 'sample1'],
    });
    for (const [, timeoutMs] of [...callsets, ...samples]) {
      expect(timeoutMs).toBe(750);
    }
  });

  it('pages /callsets and splits the sample search until every call set resolves', async () => {
    // Test page size is 10: twelve call sets need two call-set pages and two
    // sample searches.
    const callSets = sampleBackedCallSets(12);
    const ctx = await connect(fetcher, GENOTYPING_CALLS);
    const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
    fetcher.mockImplementation(
      genotypingUpstream({
        calls: callsFor(callSets, ['v1']),
        callSets,
        samples: germplasmPerSample,
      }),
    );

    const { result, structured } = await runExport(ctx, { format: 'matrix-json' });

    expect(result.isError).toBeFalsy();
    expect(warningsOf(structured)).toEqual([]);
    const rows = register.mock.calls[0]?.[1].rows as Record<string, unknown>[];
    expect(rows.map((r) => r.germplasmDbId)).toEqual(callSets.map((cs) => `g-${cs.sampleDbId}`));
    const pages = requestsTo(fetcher, '/callsets').map(([url]) =>
      new URL(String(url)).searchParams.get('page'),
    );
    expect(pages).toEqual(['0', '1']);
    const sampleBatches = requestsTo(fetcher, '/search/samples').map(
      ([, , , init]) => (JSON.parse(String(init?.body)).sampleDbIds as string[]).length,
    );
    expect(sampleBatches).toEqual([10, 2]);
  });

  it('stops a /callsets walk whose upstream ignores page, keeping what resolved', async () => {
    const callSets = sampleBackedCallSets(12);
    const ctx = await connect(fetcher, GENOTYPING_CALLS);
    const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
    fetcher.mockImplementation(
      genotypingUpstream({
        calls: callsFor(callSets, ['v1']),
        // Every page serves the first ten rows and claims more exist.
        callsets: () =>
          jsonResponse({
            metadata: { pagination: { totalCount: 12, totalPages: 2, pageSize: 10 } },
            result: { data: callSets.slice(0, 10) },
          }),
        samples: germplasmPerSample,
      }),
    );

    const { result, structured, text } = await runExport(ctx, { format: 'matrix-json' });

    expect(result.isError).toBeFalsy();
    expect(requestsTo(fetcher, '/callsets')).toHaveLength(2);
    const rows = register.mock.calls[0]?.[1].rows as Record<string, unknown>[];
    expect(rows.slice(0, 10).map((r) => r.germplasmDbId)).toEqual(
      callSets.slice(0, 10).map((cs) => `g-${cs.sampleDbId}`),
    );
    expect(rows.slice(10).map((r) => [r.callSetDbId, r.germplasmDbId])).toEqual([
      ['cs10', null],
      ['cs11', null],
    ]);
    const germplasmWarnings = warningsOf(structured).filter((w) => w.includes('germplasmDbId'));
    expect(germplasmWarnings).toHaveLength(1);
    expect(germplasmWarnings[0]).toContain('germplasmDbId is null for 2 of 12 call sets');
    expect(germplasmWarnings[0]).toContain('/callsets');
    expect(text).toContain('germplasmDbId is null for 2 of 12 call sets');
  });

  it('ends the /callsets walk once every pulled call set is listed', async () => {
    // The variant set lists 25 call sets over three pages; the pull holds the first five.
    const callSets = sampleBackedCallSets(25);
    const ctx = await connect(fetcher, GENOTYPING_CALLS);
    const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
    fetcher.mockImplementation(
      genotypingUpstream({
        calls: callsFor(callSets.slice(0, 5), ['v1']),
        callSets,
        samples: germplasmPerSample,
      }),
    );

    const { result, structured } = await runExport(ctx, { format: 'matrix-json' });

    expect(result.isError).toBeFalsy();
    expect(requestsTo(fetcher, '/callsets')).toHaveLength(1);
    const rows = register.mock.calls[0]?.[1].rows as Record<string, unknown>[];
    expect(rows.map((r) => r.germplasmDbId)).toEqual(['g-s0', 'g-s1', 'g-s2', 'g-s3', 'g-s4']);
    expect(warningsOf(structured)).toEqual([]);
  });

  it('stops a /callsets walk at its 50,000-row cap', async () => {
    // A frozen clock keeps the companion timeout from ending the walk first.
    vi.useFakeTimers({ toFake: ['Date'] });
    const ctx = await connect(fetcher, GENOTYPING_CALLS);
    fetcher.mockImplementation(
      genotypingUpstream({
        calls: callsFor(CALL_SETS),
        // Full pages of other call sets: the three pulled never appear.
        callsets: (url) => {
          const page = Number(url.searchParams.get('page'));
          return jsonResponse({
            metadata: { pagination: { currentPage: page, totalPages: 60 } },
            result: {
              data: Array.from({ length: 1_000 }, (_, i) => ({
                callSetDbId: `other-${page}-${i}`,
                sampleDbId: `other-sample-${page}-${i}`,
              })),
            },
          });
        },
      }),
    );

    const { result, structured, text } = await runExport(ctx, { format: 'matrix-json' });

    expect(result.isError).toBeFalsy();
    expect(requestsTo(fetcher, '/callsets')).toHaveLength(50);
    expect(requestsTo(fetcher, '/search/samples')).toHaveLength(0);
    const capped =
      'germplasmDbId is null for 3 of 3 call sets: the GET /callsets scan stopped at its 50,000-row cap.';
    expect(warningsOf(structured).filter((w) => w.includes('germplasmDbId'))).toEqual([
      expect.stringContaining(capped),
    ]);
    expect(text).toContain(capped);
  });

  it('polls an asynchronous sample search on the companion timeout', async () => {
    // A frozen clock keeps each request's timeout at the full companion budget.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.stubEnv('BRAPI_COMPANION_TIMEOUT_MS', '750');
    resetServerConfig();
    const ctx = await connect(fetcher, GENOTYPING_CALLS);
    const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
    const upstream = genotypingUpstream({
      calls: callsFor(CALL_SETS),
      samples: () =>
        jsonResponse({ metadata: {}, result: { searchResultsDbId: 'samples-job' } }, 202),
    });
    fetcher.mockImplementation(
      async (url: string, timeoutMs: number, fetchCtx: unknown, init?: { body?: unknown }) =>
        pathnameOf(url).endsWith('/search/samples/samples-job')
          ? jsonResponse(
              envelope({
                data: Object.entries(SAMPLE_GERMPLASM).map(([sampleDbId, germplasmDbId]) => ({
                  sampleDbId,
                  germplasmDbId,
                })),
              }),
            )
          : upstream(url, timeoutMs, fetchCtx, init),
    );

    const { result, structured } = await runExport(ctx, { format: 'matrix-json' });

    expect(result.isError).toBeFalsy();
    const rows = register.mock.calls[0]?.[1].rows as Record<string, unknown>[];
    expect(rows.map((r) => [r.callSetDbId, r.germplasmDbId])).toEqual([
      ['callset01', 'germplasm3'],
      ['callset02', 'germplasm2'],
      ['callset03', 'germplasm1'],
    ]);
    expect(warningsOf(structured)).toEqual([]);
    const polls = requestsTo(fetcher, '/search/samples/samples-job');
    expect(polls).toHaveLength(1);
    const pollUrl = new URL(String(polls[0]?.[0]));
    expect([pollUrl.searchParams.get('page'), pollUrl.searchParams.get('pageSize')]).toEqual([
      '0',
      '10',
    ]);
    expect(polls[0]?.[1]).toBe(750);
  });

  it('ends a /callsets walk at one companion timeout, not the call deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.stubEnv('BRAPI_COMPANION_TIMEOUT_MS', '500');
    resetServerConfig();
    const ctx = await connect(fetcher, GENOTYPING_CALLS);
    fetcher.mockImplementation(
      genotypingUpstream({
        calls: callsFor(CALL_SETS),
        // Ignores variantSetDbId: endless pages of other call sets, each
        // answering inside the companion timeout but taking 40% of it.
        callsets: (url) => {
          vi.setSystemTime(Date.now() + 200);
          const page = url.searchParams.get('page');
          return jsonResponse({
            metadata: { pagination: { totalCount: 100_000, totalPages: 10_000, pageSize: 10 } },
            result: {
              data: Array.from({ length: 10 }, (_, i) => ({
                callSetDbId: `other-${page}-${i}`,
                sampleDbId: `other-sample-${page}-${i}`,
              })),
            },
          });
        },
      }),
    );

    const { result, structured } = await runExport(ctx, { format: 'matrix-json' });

    expect(result.isError).toBeFalsy();
    expect(structured.rowCount).toBe(3);
    // Pages start at 0, 200, and 400 ms of the 500 ms budget; a fourth would start past it.
    expect(requestsTo(fetcher, '/callsets')).toHaveLength(3);
    const germplasmWarnings = warningsOf(structured).filter((w) => w.includes('germplasmDbId'));
    expect(germplasmWarnings).toEqual([
      expect.stringContaining('germplasmDbId is null for 3 of 3 call sets'),
    ]);
    expect(germplasmWarnings[0]).toContain('GET /callsets');
  });

  it('ends the sample search at one companion timeout, keeping the batches it resolved', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.stubEnv('BRAPI_COMPANION_TIMEOUT_MS', '500');
    resetServerConfig();
    // Test page size is 10: forty call sets need four sample batches.
    const callSets = sampleBackedCallSets(40);
    const ctx = await connect(fetcher, GENOTYPING_CALLS);
    const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
    fetcher.mockImplementation(
      genotypingUpstream({
        calls: callsFor(callSets, ['v1']),
        callSets,
        samples: (body) => {
          vi.setSystemTime(Date.now() + 200);
          return germplasmPerSample(body);
        },
      }),
    );

    const { result, structured } = await runExport(ctx, { format: 'matrix-json' });

    expect(result.isError).toBeFalsy();
    // Batches start at 0, 200, and 400 ms of the 500 ms budget; the fourth would start past it.
    expect(requestsTo(fetcher, '/search/samples')).toHaveLength(3);
    const rows = register.mock.calls[0]?.[1].rows as Record<string, unknown>[];
    expect(rows.map((r) => r.germplasmDbId)).toEqual([
      ...callSets.slice(0, 30).map((cs) => `g-${cs.sampleDbId}`),
      ...Array(10).fill(null),
    ]);
    const germplasmWarnings = warningsOf(structured).filter((w) => w.includes('germplasmDbId'));
    expect(germplasmWarnings).toEqual([
      expect.stringContaining('germplasmDbId is null for 10 of 40 call sets'),
    ]);
    expect(germplasmWarnings[0]).toContain('POST /search/samples');
  });

  const failing = () => {
    throw new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Upstream failed.', {
      status: 500,
      errorSource: 'FetchHttpError',
    });
  };
  const stalled = () => {
    throw timeout(`Fetch timed out after ${TEST_CONFIG.companionTimeoutMs}ms`, {
      errorSource: 'FetchTimeout',
    });
  };

  it.each([
    {
      name: 'GET /callsets is not advertised',
      advertised: ['search/calls', 'search/samples'] as AdvertisedCall[],
      upstream: {},
      lookups: [0, 0],
      reason: 'GET /callsets',
    },
    {
      name: 'GET /callsets fails',
      advertised: GENOTYPING_CALLS,
      upstream: { callsets: failing },
      lookups: [1, 0],
      reason: 'GET /callsets',
    },
    {
      name: 'GET /callsets times out',
      advertised: GENOTYPING_CALLS,
      upstream: { callsets: stalled },
      lookups: [1, 0],
      reason: 'GET /callsets',
    },
    {
      name: 'POST /search/samples is not advertised',
      advertised: ['search/calls', { service: 'callsets', methods: ['GET'] }] as AdvertisedCall[],
      upstream: {},
      lookups: [1, 0],
      reason: 'POST /search/samples',
    },
    {
      name: 'POST /search/samples fails',
      advertised: GENOTYPING_CALLS,
      upstream: { samples: failing },
      lookups: [1, 1],
      reason: 'POST /search/samples',
    },
    {
      name: 'GET /callsets answers HTTP 401',
      advertised: GENOTYPING_CALLS,
      upstream: {
        callsets: () => {
          throw new McpError(JsonRpcErrorCode.Unauthorized, 'Fetch failed. Status: 401', {
            status: 401,
          });
        },
      },
      lookups: [1, 0],
      reason: 'GET /callsets',
    },
    {
      name: 'GET /callsets answers HTTP 200 with result: null (SGN)',
      advertised: GENOTYPING_CALLS,
      upstream: { callsets: () => jsonResponse({ metadata: {}, result: null }) },
      lookups: [1, 0],
      reason: 'not listed by GET /callsets',
    },
    {
      name: 'POST /search/samples answers HTTP 403',
      advertised: GENOTYPING_CALLS,
      upstream: {
        samples: () => {
          throw new McpError(JsonRpcErrorCode.Forbidden, 'Fetch failed. Status: 403', {
            status: 403,
          });
        },
      },
      lookups: [1, 1],
      reason: 'POST /search/samples',
    },
    {
      name: 'POST /search/samples times out',
      advertised: GENOTYPING_CALLS,
      upstream: { samples: stalled },
      lookups: [1, 1],
      reason: 'POST /search/samples',
    },
    {
      name: 'POST /search/samples answers HTTP 200 with result: null (SGN)',
      advertised: GENOTYPING_CALLS,
      upstream: { samples: () => jsonResponse({ metadata: {}, result: null }) },
      lookups: [1, 1],
      reason: 'POST /search/samples returned no germplasmDbId for 3',
    },
  ])('keeps the export with null germplasm and one warning when $name', async (scenario) => {
    const { advertised, upstream, lookups, reason } = scenario;
    // Retries are on for the deployment; a companion lookup still makes one attempt.
    resetTestServices();
    fetcher = initTestServices({ ...TEST_CONFIG, retryMaxAttempts: 3 });
    const ctx = await connect(fetcher, advertised);
    const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
    fetcher.mockImplementation(genotypingUpstream({ calls: callsFor(CALL_SETS), ...upstream }));

    const { result, structured, text } = await runExport(ctx, { format: 'vcf-lite' });

    expect(result.isError).toBeFalsy();
    const rows = register.mock.calls[0]?.[1].rows as Record<string, unknown>[];
    expect(rows.map((r) => [r.callSetDbId, r.germplasmDbId])).toEqual([
      ['callset01', null],
      ['callset02', null],
      ['callset03', null],
    ]);
    const germplasmWarnings = warningsOf(structured).filter((w) => w.includes('germplasmDbId'));
    expect(germplasmWarnings).toHaveLength(1);
    expect(germplasmWarnings[0]).toContain('germplasmDbId is null for 3 of 3 call sets');
    expect(germplasmWarnings[0]).toContain(reason);
    expect(germplasmWarnings[0]).toContain('cannot be joined');
    expect(text).toContain('germplasmDbId is null for 3 of 3 call sets');
    expect([
      requestsTo(fetcher, '/callsets').length,
      requestsTo(fetcher, '/search/samples').length,
    ]).toEqual(lookups);
    // Text sample labels stay callSetName.
    expect((structured.vcf as string).split('\n')[0]).toBe(
      '#CHROM\tPOS\tID\tREF\tALT\tP2\tF1-1\tF1-2',
    );
  });

  it('makes no lookup for an empty pull and stages the identity columns', async () => {
    const ctx = await connect(fetcher, GENOTYPING_CALLS);
    fetcher.mockImplementation(genotypingUpstream({ calls: [] }));

    const { result, structured } = await runExport(ctx, { format: 'matrix-json' });

    expect(result.isError).toBeFalsy();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(structured.dataframe).toMatchObject({ columns: IDENTITY_COLUMNS, rowCount: 0 });
    expect(warningsOf(structured)).toEqual([]);
  });

  it('leaves callSetDbId null when a call row has none; a name never fills an ID column', async () => {
    const ctx = await connect(fetcher, GENOTYPING_CALLS);
    const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
    fetcher.mockImplementation(
      genotypingUpstream({
        calls: callsFor([{ callSetName: 'NoId' }, {}, CALL_SETS[0]!], ['v1']),
      }),
    );

    const { result, structured } = await runExport(ctx, { format: 'matrix-json' });

    expect(result.isError).toBeFalsy();
    expect(register.mock.calls[0]?.[1].rows).toEqual([
      { callSetDbId: null, callSetName: 'NoId', germplasmDbId: null, v1: '0/1' },
      { callSetDbId: null, callSetName: null, germplasmDbId: null, v1: '0/1' },
      { callSetDbId: 'callset01', callSetName: 'P2', germplasmDbId: 'germplasm3', v1: '0/1' },
    ]);
    expect(warningsOf(structured).filter((w) => w.includes('germplasmDbId'))).toEqual([
      expect.stringContaining('germplasmDbId is null for 2 of 3 call sets'),
    ]);
  });

  it('resolves Breedbase call sets from additionalInfo.germplasmDbId without a sample search', async () => {
    vi.stubEnv('BRAPI_DEFAULT_DIALECT', 'breedbase');
    const ctx = await connect(fetcher, GENOTYPING_CALLS);
    const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
    // An accession-genotyped call set (stock = germplasm) and a tissue-sample
    // one whose germplasm is its source accession.
    const callSets = [
      {
        callSetDbId: '41',
        callSetName: 'TMEB419',
        sampleDbId: '41',
        additionalInfo: { germplasmDbId: '41' },
        studyDbId: null,
      },
      {
        callSetDbId: '902',
        callSetName: 'TMEB419_plant_1',
        sampleDbId: '902',
        additionalInfo: { germplasmDbId: '41' },
        studyDbId: null,
      },
    ];
    fetcher.mockImplementation(
      genotypingUpstream({ calls: callsFor(callSets, ['S1_100']), callSets }),
    );

    const { result, structured } = await runExport(ctx, { format: 'matrix-json' });

    expect(result.isError).toBeFalsy();
    const rows = register.mock.calls[0]?.[1].rows as Record<string, unknown>[];
    expect(rows.map((r) => [r.callSetDbId, r.germplasmDbId])).toEqual([
      ['41', '41'],
      ['902', '41'],
    ]);
    expect(warningsOf(structured).filter((w) => w.includes('germplasmDbId'))).toEqual([]);
    expect(requestsTo(fetcher, '/search/samples')).toHaveLength(0);
    expect(
      new URL(String(requestsTo(fetcher, '/callsets')[0]?.[0])).searchParams.get('variantSetDbId'),
    ).toBe('vset-1');
  });

  it('leaves Breedbase sample-only call sets null without a sample search the dialect marks dead', async () => {
    vi.stubEnv('BRAPI_DEFAULT_DIALECT', 'breedbase');
    const ctx = await connect(fetcher, GENOTYPING_CALLS);
    const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
    const callSets = [{ callSetDbId: '41', callSetName: 'TMEB419', sampleDbId: '41' }];
    fetcher.mockImplementation(
      genotypingUpstream({ calls: callsFor(callSets, ['S1_100']), callSets }),
    );

    const { result, structured } = await runExport(ctx, { format: 'matrix-json' });

    expect(result.isError).toBeFalsy();
    const rows = register.mock.calls[0]?.[1].rows as Record<string, unknown>[];
    expect(rows.map((r) => [r.callSetDbId, r.germplasmDbId])).toEqual([['41', null]]);
    expect(warningsOf(structured).filter((w) => w.includes('germplasmDbId'))).toEqual([
      expect.stringContaining(
        "germplasmDbId is null for 1 of 1 call sets: the 'breedbase' dialect marks POST /search/samples as unavailable",
      ),
    ]);
    expect(requestsTo(fetcher, '/search/samples')).toHaveLength(0);
  });

  it('keeps identity column names out of the variant columns', async () => {
    const ctx = await connect(fetcher, GENOTYPING_CALLS);
    const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
    fetcher.mockImplementation(
      genotypingUpstream({
        calls: callsFor([CALL_SETS[0]!], ['germplasmDbId', 'CallSetDbId', 'callSetName']),
      }),
    );

    const { result, structured } = await runExport(ctx, { format: 'matrix-json' });

    expect(result.isError).toBeFalsy();
    expect(structured.variantColumnLegend).toEqual({
      germplasmDbId_2: 'germplasmDbId',
      CallSetDbId_2: 'CallSetDbId',
      callSetName_2: 'callSetName',
    });
    expect(register.mock.calls[0]?.[1].rows).toEqual([
      {
        callSetDbId: 'callset01',
        callSetName: 'P2',
        germplasmDbId: 'germplasm3',
        germplasmDbId_2: '0/1',
        CallSetDbId_2: '0/1',
        callSetName_2: '0/1',
      },
    ]);
  });

  it('sends no lookup once the call deadline is spent, and keeps the export', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const ctx = await connect(fetcher, GENOTYPING_CALLS);
    fetcher.mockImplementation(
      genotypingUpstream({
        callsPage: () => {
          // The pull itself used up the call's deadline for upstream requests.
          vi.setSystemTime(Date.now() + TEST_CONFIG.callDeadlineMs + 1_000);
          return jsonResponse(envelope({ data: callsFor(CALL_SETS) }));
        },
      }),
    );

    const { result, structured } = await runExport(ctx, { format: 'matrix-json' });

    expect(result.isError).toBeFalsy();
    expect(structured.rowCount).toBe(3);
    expect(requestsTo(fetcher, '/callsets')).toHaveLength(0);
    expect(warningsOf(structured).filter((w) => w.includes('germplasmDbId'))).toEqual([
      expect.stringContaining('germplasmDbId is null for 3 of 3 call sets'),
    ]);
  });

  it('propagates caller cancellation during the call-set lookup before staging', async () => {
    const ctx = await connect(fetcher, GENOTYPING_CALLS);
    const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
    const controller = new AbortController();
    fetcher.mockImplementation(
      genotypingUpstream({
        calls: callsFor(CALL_SETS),
        callsets: () => {
          controller.abort();
          throw controller.signal.reason;
        },
      }),
    );

    await expect(
      brapiExportGenotypeMatrix.handler(
        brapiExportGenotypeMatrix.input.parse({ variantSetDbId: 'vset-1', format: 'matrix-json' }),
        { ...ctx, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(register).not.toHaveBeenCalled();
  });

  it.each(['vcf-lite', 'plink'] as const)(
    '%s labels a sample by callSetDbId when the calls carry no callSetName',
    async (format) => {
      const ctx = await connect(fetcher);
      fetcher.mockImplementation(
        genotypingUpstream({
          calls: callsFor([{ callSetDbId: 'cs-9' }], ['v1']),
        }),
      );

      const { result, structured, text } = await runExport(ctx, { format });

      expect(result.isError).toBeFalsy();
      if (format === 'vcf-lite') {
        expect((structured.vcf as string).split('\n')[0]).toBe('#CHROM\tPOS\tID\tREF\tALT\tcs-9');
      } else {
        expect(structured.ped).toBe('0\tcs-9\t0\t0\t0\t0\t1\t2');
      }
      expect(text).toContain('cs-9');
    },
  );
});

describe('brapi_export_genotype_matrix variantDbIds (#129)', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetTestServices();
    vi.unstubAllEnvs();
  });

  /** Calls for the requested variants only, as a server that honors the filter answers. */
  function honoring(callSets = CALL_SETS) {
    return genotypingUpstream({
      callsPage: (body) =>
        jsonResponse(envelope({ data: callsFor(callSets, body.variantDbIds as string[]) })),
    });
  }

  it.each([
    { input: { variantDbIds: ['variant03', 'variant04'] }, expected: ['variant03', 'variant04'] },
    { input: { variantDbId: 'variant03' }, expected: ['variant03'] },
  ])('forwards $input to the calls search and pivots only them', async ({ input, expected }) => {
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(honoring());

    const { result, structured } = await runExport(ctx, { format: 'matrix-json', ...input });

    expect(result.isError).toBeFalsy();
    expect(callsSearchBody(fetcher)).toMatchObject({
      variantSetDbIds: ['vset-1'],
      variantDbIds: expected,
    });
    expect((structured.dataframe as { columns: string[] }).columns).toEqual([
      ...IDENTITY_COLUMNS,
      ...expected,
    ]);
    expect(warningsOf(structured).some((w) => w.includes('did not apply'))).toBe(false);
  });

  it('leaves out calls outside variantDbIds and says the server did not apply the filter', async () => {
    const ctx = await connect(fetcher);
    // The server ignores the filter and returns every variant.
    fetcher.mockImplementation(
      genotypingUpstream({
        calls: callsFor(CALL_SETS, ['variant01', 'variant02', 'variant03', 'variant04']),
      }),
    );

    const { result, structured, text } = await runExport(ctx, {
      format: 'matrix-json',
      variantDbIds: ['variant02'],
    });

    expect(result.isError).toBeFalsy();
    expect(structured).toMatchObject({ rowCount: 3, columnCount: 1 });
    expect((structured.dataframe as { columns: string[] }).columns).toEqual([
      ...IDENTITY_COLUMNS,
      'variant02',
    ]);
    const filterWarnings = warningsOf(structured).filter((w) => w.includes('did not apply'));
    expect(filterWarnings).toHaveLength(1);
    expect(filterWarnings[0]).toContain('9 returned calls');
    expect(filterWarnings[0]).toContain('variantDbIds');
    expect(text).toContain(filterWarnings[0]);
  });

  it('leaves the calls search body unchanged when variantDbIds is omitted', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(genotypingUpstream({ calls: callsFor(CALL_SETS) }));

    const { result } = await runExport(ctx, { format: 'matrix-json' });

    expect(result.isError).toBeFalsy();
    expect(callsSearchBody(fetcher)).toEqual({
      variantSetDbIds: ['vset-1'],
      pageSize: 10_000,
      page: 0,
    });
  });

  it('rejects a blank variantDbIds entry at parse and accepts a real one', () => {
    const base = { variantSetDbId: 'vset-1', format: 'matrix-json' };
    expect(() =>
      brapiExportGenotypeMatrix.input.parse({ ...base, variantDbIds: ['ok', '  '] }),
    ).toThrow();
    expect(brapiExportGenotypeMatrix.input.parse({ ...base, variantDbIds: ['ok'] })).toMatchObject({
      variantDbIds: ['ok'],
    });
  });

  it('points a column cap at variantColumnLegend and variantDbIds, keeping every call set (#46)', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(
      genotypingUpstream({
        calls: callsFor(CALL_SETS, ['variant01', 'variant02', 'variant03', 'variant04']),
      }),
    );

    const { result, structured, text } = await runExport(ctx, {
      format: 'matrix-json',
      maxColumns: 2,
    });

    expect(result.isError).toBeFalsy();
    expect(structured).toMatchObject({
      rowCount: 3,
      columnCount: 2,
      truncated: true,
      dataframe: { truncated: true },
    });
    expect((structured.dataframe as { maxRows?: number }).maxRows).toBeUndefined();
    const [capWarning, ...others] = warningsOf(structured).filter((w) =>
      w.includes('distinct variants'),
    );
    expect(others).toEqual([]);
    expect(capWarning).toContain('more than 2 distinct variants');
    expect(capWarning).toContain('variantColumnLegend');
    expect(capWarning).toContain('Every call set is still present');
    expect(capWarning).toContain('variantDbIds');
    expect(capWarning).toContain('brapi_find_variants');
    expect(capWarning).not.toContain('germplasm');
    expect(text).toContain('variantColumnLegend');
  });

  it.each([
    {
      maxCalls: 10,
      cut: 'The pull ended at call set `callset03` (F1-2), which carries 2 of the 4 kept variants; its other cells are null',
    },
    { maxCalls: 8, cut: undefined },
  ])('names where a $maxCalls-call cap ended the pull', async ({ maxCalls, cut }) => {
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(
      genotypingUpstream({
        calls: callsFor(CALL_SETS, ['variant01', 'variant02', 'variant03', 'variant04']),
      }),
    );

    const { result, structured, text } = await runExport(ctx, { format: 'matrix-json', maxCalls });

    expect(result.isError).toBeFalsy();
    expect(structured).toMatchObject({ truncated: true, columnCount: 4 });
    const warnings = warningsOf(structured);
    // The shared pull-limit warning stays generic.
    expect(warnings).toContain(
      `Truncated at the pull limit (${maxCalls} calls): the calls collected up to it are kept. Narrow the filters and re-pull to reach the rest.`,
    );
    const pointer = warnings.find((w) => w.includes('variantDbIds'));
    expect(pointer).toContain('brapi_find_variants');
    expect(pointer).not.toContain('germplasm');
    if (cut) {
      expect(pointer).toContain(cut);
      // content[] escapes the backticks around the call-set ID.
      expect(text).toContain('callset03');
      expect(text).toContain('which carries 2 of the 4 kept variants');
    } else {
      expect(pointer).not.toContain('ended at');
      expect(text).toContain('export the variants in batches with variantDbIds');
    }
  });

  it('points a deadline-stopped pull to variantDbIds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(
      genotypingUpstream({
        callsPage: () => {
          vi.setSystemTime(Date.now() + TEST_CONFIG.callDeadlineMs + 1_000);
          return jsonResponse({
            metadata: { pagination: { totalPages: 2 } },
            result: { data: callsFor(CALL_SETS, ['variant01', 'variant02']).slice(0, 5) },
          });
        },
      }),
    );

    const { result, structured } = await runExport(ctx, { format: 'matrix-json' });

    expect(result.isError).toBeFalsy();
    expect(structured.truncated).toBe(true);
    const warnings = warningsOf(structured);
    expect(warnings.some((w) => w.startsWith('Genotype-call pull stopped after 5 call(s)'))).toBe(
      true,
    );
    const pointer = warnings.find((w) => w.includes('variantDbIds'));
    expect(pointer).toContain(
      'The pull ended at call set `callset03` (F1-2), which carries 1 of the 2 kept variants',
    );
    expect(pointer).toContain('brapi_find_variants');
  });
});

describe('brapi_export_genotype_matrix variant metadata scan cap', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
    vi.unstubAllEnvs();
  });

  it.each([
    { name: 'stops at its 50,000-row cap', totalPages: 60, scanned: 50, warns: true },
    { name: 'ends at the last page', totalPages: 3, scanned: 3, warns: false },
  ])('discloses uncovered variants when the scan $name', async ({ totalPages, scanned, warns }) => {
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(
      genotypingUpstream({
        calls: callsFor([CALL_SETS[0]!], ['need-a', 'need-b']),
        // Full pages of other variants: the matrix's two never appear.
        variants: (url) => {
          const page = Number(url.searchParams.get('page'));
          return jsonResponse({
            metadata: { pagination: { currentPage: page, totalPages } },
            result: {
              data: Array.from({ length: 1_000 }, (_, i) => ({
                variantDbId: `other-${page}-${i}`,
              })),
            },
          });
        },
      }),
    );

    const { result, structured, text } = await runExport(ctx, { format: 'vcf-lite' });

    expect(result.isError).toBeFalsy();
    expect(requestsTo(fetcher, '/variants')).toHaveLength(scanned);
    const capWarning = warningsOf(structured).find((w) => w.includes('50,000'));
    if (warns) {
      expect(capWarning).toContain('2 of the 2 matrix variants');
      expect(text).toContain('2 of the 2 matrix variants');
    } else {
      expect(capWarning).toBeUndefined();
    }
    expect((structured.vcf as string).split('\n').slice(1)).toEqual([
      '.\t.\tneed-a\t.\t.\t0/1',
      '.\t.\tneed-b\t.\t.\t0/1',
    ]);
  });
});
