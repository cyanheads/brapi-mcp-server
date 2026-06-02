/**
 * @fileoverview End-to-end tests for `brapi_export_genotype_matrix` — capability
 * gate, sync POST /search/calls happy path, matrix pivot, column sanitization,
 * dataframe registration, and the typed error contract (unknown_alias,
 * no_filters, search_endpoint_disabled).
 *
 * @module tests/tools/brapi-export-genotype-matrix.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiExportGenotypeMatrix } from '@/mcp-server/tools/definitions/brapi-export-genotype-matrix.tool.js';
import { registerDialect } from '@/services/brapi-dialect/registry.js';
import {
  BASE_URL,
  envelope,
  initTestServices,
  jsonResponse,
  type MockFetcher,
  pathnameOf,
  resetTestServices,
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

/** Register a default connection with /search/calls advertised. */
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
    expect(vcfLines).toContain('chr1\t1000\tvariant01\tA\tT\t0/0\t1/1');
    expect(vcfLines).toContain('chr1\t2000\tvariant02\tC\tG\t0/1\t0/0');
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
    expect(mapLines).toContain('chr1\tvariant01\t0\t1000');
    expect(mapLines).toContain('chr1\tvariant02\t0\t2000');
    // FID IID PAT MAT SEX PHENO + biallelic pairs (variant01 A/A → A A, variant02 A/G → A G)
    expect(result.ped).toBe('0\tS1\t0\t0\t0\t0\tA\tA\tA\tG');
    expect(result.vcf).toBeUndefined();
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
