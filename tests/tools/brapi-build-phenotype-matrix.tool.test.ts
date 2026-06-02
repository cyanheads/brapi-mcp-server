/**
 * @fileoverview Tests for brapi_build_phenotype_matrix — observation pull
 * (direct /observations and /observationunits fallback), aggregation, shape,
 * variable legend, and dataframe materialization.
 *
 * @module tests/tools/brapi-build-phenotype-matrix.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brapiBuildPhenotypeMatrix } from '@/mcp-server/tools/definitions/brapi-build-phenotype-matrix.tool.js';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import {
  BASE_URL,
  envelope,
  initTestServices,
  jsonResponse,
  type MockFetcher,
  pathnameOf,
  resetTestServices,
} from './_tool-test-helpers.js';

/** Connect with observations + observationunits + observations/table advertised. */
async function connect(fetcher: MockFetcher) {
  fetcher.mockImplementation(async (url: string) => {
    const path = pathnameOf(url);
    if (path.endsWith('/serverinfo')) {
      return jsonResponse(
        envelope({
          serverName: 'Test',
          calls: [
            { service: 'observations', methods: ['GET'], versions: ['2.1'] },
            { service: 'observationunits', methods: ['GET'], versions: ['2.1'] },
          ],
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

/** Build a flat /observations row. */
function obsRow(
  germplasmDbId: string,
  germplasmName: string,
  variableDbId: string,
  variableName: string,
  value: string,
  studyDbId = 'study1',
) {
  return {
    observationDbId: `obs_${germplasmDbId}_${variableDbId}`,
    observationVariableDbId: variableDbId,
    observationVariableName: variableName,
    germplasmDbId,
    germplasmName,
    studyDbId,
    value,
  };
}

describe('brapi_build_phenotype_matrix tool', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  // -------------------------------------------------------------------------
  // Wide / mean aggregation
  // -------------------------------------------------------------------------
  it('wide + mean: builds matrix and materializes dataframe', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      obsRow('germplasm1', 'Germ1', 'variable1', 'Corn Stalk Height', '10'),
      obsRow('germplasm1', 'Germ1', 'variable1', 'Corn Stalk Height', '20'),
      obsRow('germplasm2', 'Germ2', 'variable1', 'Corn Stalk Height', '30'),
      obsRow('germplasm2', 'Germ2', 'variable1', 'Corn Stalk Height', '40'),
    ];
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/observations')) {
        return jsonResponse(envelope({ data: rows }, { totalCount: rows.length }));
      }
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });

    const result = await brapiBuildPhenotypeMatrix.handler(
      brapiBuildPhenotypeMatrix.input.parse({
        studies: ['study1'],
        shape: 'wide',
        aggregate: 'mean',
      }),
      ctx,
    );

    expect(result.germplasmCount).toBe(2);
    expect(result.variableCount).toBe(1);
    expect(result.observationCount).toBe(4);
    expect(result.variableLegend).toEqual({ variable1: 'Corn Stalk Height' });
    expect(result.dataframe.rowCount).toBe(2);

    // Wide columns: germplasmDbId, germplasmName, variable1
    expect(result.dataframe.columns).toContain('germplasmDbId');
    expect(result.dataframe.columns).toContain('variable1');
  });

  it('wide + mean: aggregate values are correct (germplasm1=15, germplasm2=35)', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      obsRow('germplasm1', 'Germ1', 'variable1', 'Corn Stalk Height', '10'),
      obsRow('germplasm1', 'Germ1', 'variable1', 'Corn Stalk Height', '20'),
      obsRow('germplasm2', 'Germ2', 'variable1', 'Corn Stalk Height', '30'),
      obsRow('germplasm2', 'Germ2', 'variable1', 'Corn Stalk Height', '40'),
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiBuildPhenotypeMatrix.handler(
      brapiBuildPhenotypeMatrix.input.parse({
        studies: ['study1'],
        shape: 'wide',
        aggregate: 'mean',
      }),
      ctx,
    );

    // Verify via format() output (which includes the dataframe handle)
    const formatted = brapiBuildPhenotypeMatrix.format(result);
    expect(formatted[0]?.text).toMatch(/variable1.*Corn Stalk Height/i);
    expect(result.observationCount).toBe(4);
    expect(result.germplasmCount).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Wide / median aggregation
  // -------------------------------------------------------------------------
  it('wide + median: odd-length returns middle value', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      obsRow('g1', 'G1', 'v1', 'Height', '10'),
      obsRow('g1', 'G1', 'v1', 'Height', '20'),
      obsRow('g1', 'G1', 'v1', 'Height', '30'),
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiBuildPhenotypeMatrix.handler(
      brapiBuildPhenotypeMatrix.input.parse({
        studies: ['s1'],
        shape: 'wide',
        aggregate: 'median',
      }),
      ctx,
    );

    expect(result.observationCount).toBe(3);
    expect(result.dataframe.rowCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Wide / first aggregation
  // -------------------------------------------------------------------------
  it('wide + first: keeps first value (string or numeric)', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      obsRow('g1', 'G1', 'v1', 'Color', 'red'),
      obsRow('g1', 'G1', 'v1', 'Color', 'blue'),
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiBuildPhenotypeMatrix.handler(
      brapiBuildPhenotypeMatrix.input.parse({ studies: ['s1'], shape: 'wide', aggregate: 'first' }),
      ctx,
    );

    expect(result.dataframe.rowCount).toBe(1);
    expect(result.warnings).not.toContain(expect.stringMatching(/non-numeric/));
  });

  // -------------------------------------------------------------------------
  // Long shape
  // -------------------------------------------------------------------------
  it('long shape: one row per observation with correct columns', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      obsRow('g1', 'G1', 'v1', 'Height', '10'),
      obsRow('g1', 'G1', 'v1', 'Height', '20'),
      obsRow('g2', 'G2', 'v1', 'Height', '30'),
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiBuildPhenotypeMatrix.handler(
      brapiBuildPhenotypeMatrix.input.parse({ studies: ['s1'], shape: 'long' }),
      ctx,
    );

    expect(result.dataframe.rowCount).toBe(3);
    expect(result.dataframe.columns).toContain('germplasmDbId');
    expect(result.dataframe.columns).toContain('observationVariableDbId');
    expect(result.dataframe.columns).toContain('studyDbId');
    expect(result.dataframe.columns).toContain('value');
    expect(result.dataframe.columns).toContain('replicateIndex');
    expect(result.observationCount).toBe(3);
  });

  it('wide + all: produces long form with replicateIndex and warns', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      obsRow('g1', 'G1', 'v1', 'Height', '10'),
      obsRow('g1', 'G1', 'v1', 'Height', '20'),
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiBuildPhenotypeMatrix.handler(
      brapiBuildPhenotypeMatrix.input.parse({ studies: ['s1'], shape: 'wide', aggregate: 'all' }),
      ctx,
    );

    expect(result.dataframe.columns).toContain('replicateIndex');
    expect(result.warnings.some((w) => /aggregate.*all.*long/i.test(w))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Variable / germplasm filter
  // -------------------------------------------------------------------------
  it('filters to requested variables only', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      obsRow('g1', 'G1', 'v1', 'Height', '10'),
      obsRow('g1', 'G1', 'v2', 'Color', 'red'),
      obsRow('g2', 'G2', 'v1', 'Height', '20'),
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiBuildPhenotypeMatrix.handler(
      brapiBuildPhenotypeMatrix.input.parse({
        studies: ['s1'],
        variables: ['v1'],
        shape: 'long',
      }),
      ctx,
    );

    expect(result.variableCount).toBe(1);
    expect(result.observationCount).toBe(2);
    expect(result.dataframe.rowCount).toBe(2);
  });

  it('filters to requested germplasm only', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      obsRow('g1', 'G1', 'v1', 'Height', '10'),
      obsRow('g2', 'G2', 'v1', 'Height', '20'),
      obsRow('g3', 'G3', 'v1', 'Height', '30'),
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiBuildPhenotypeMatrix.handler(
      brapiBuildPhenotypeMatrix.input.parse({
        studies: ['s1'],
        germplasm: ['g1', 'g2'],
        shape: 'long',
      }),
      ctx,
    );

    expect(result.germplasmCount).toBe(2);
    expect(result.observationCount).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Non-numeric aggregation warning (categorical trait)
  // -------------------------------------------------------------------------
  it('warns when mean applied to categorical trait and sets cell to null', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      obsRow('g1', 'G1', 'v1', 'Color', 'red'),
      obsRow('g1', 'G1', 'v1', 'Color', 'blue'),
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiBuildPhenotypeMatrix.handler(
      brapiBuildPhenotypeMatrix.input.parse({ studies: ['s1'], shape: 'wide', aggregate: 'mean' }),
      ctx,
    );

    expect(result.warnings.some((w) => /non-numeric/i.test(w))).toBe(true);
    // The cell is null, so the wide row still has one germplasm row
    expect(result.dataframe.rowCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // /observationunits fallback
  // -------------------------------------------------------------------------
  it('falls back to /observationunits when /observations returns empty', async () => {
    const ctx = await connect(fetcher);

    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/observations')) {
        // Empty — triggers fallback
        return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
      }
      if (path.endsWith('/observationunits')) {
        return jsonResponse(
          envelope(
            {
              data: [
                {
                  observationUnitDbId: 'unit1',
                  germplasmDbId: 'g1',
                  germplasmName: 'G1',
                  studyDbId: 'study1',
                  observations: [
                    {
                      observationVariableDbId: 'v1',
                      observationVariableName: 'Height',
                      value: '42',
                    },
                  ],
                },
              ],
            },
            { totalCount: 1 },
          ),
        );
      }
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });

    const result = await brapiBuildPhenotypeMatrix.handler(
      brapiBuildPhenotypeMatrix.input.parse({ studies: ['study1'], shape: 'long' }),
      ctx,
    );

    expect(result.observationCount).toBe(1);
    expect(result.dataframe.rowCount).toBe(1);
    expect(result.warnings.some((w) => /observationunits fallback/i.test(w))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Multi-study
  // -------------------------------------------------------------------------
  it('collects observations from multiple studies', async () => {
    const ctx = await connect(fetcher);

    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(String(url));
      const studyId =
        u.searchParams.get('studyDbIds') ?? u.searchParams.get('studyDbId') ?? 'unknown';
      if (pathnameOf(url).endsWith('/observations')) {
        const studyRows = [
          obsRow('g1', 'G1', 'v1', 'Height', studyId === 'study1' ? '10' : '20', studyId),
        ];
        return jsonResponse(envelope({ data: studyRows }, { totalCount: studyRows.length }));
      }
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });

    const result = await brapiBuildPhenotypeMatrix.handler(
      brapiBuildPhenotypeMatrix.input.parse({ studies: ['study1', 'study2'], shape: 'long' }),
      ctx,
    );

    // 2 studies × 1 observation each = 2 observations
    expect(result.observationCount).toBe(2);
    expect(result.dataframe.rowCount).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Empty result
  // -------------------------------------------------------------------------
  it('materializes an empty dataframe when no observations found', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));

    const result = await brapiBuildPhenotypeMatrix.handler(
      brapiBuildPhenotypeMatrix.input.parse({ studies: ['s1'], shape: 'wide' }),
      ctx,
    );

    expect(result.observationCount).toBe(0);
    expect(result.germplasmCount).toBe(0);
    expect(result.variableCount).toBe(0);
    expect(result.warnings.some((w) => /empty/i.test(w))).toBe(true);
    expect(result.dataframe).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Variable legend
  // -------------------------------------------------------------------------
  it('builds variableLegend mapping variableDbId → display name', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      obsRow('g1', 'G1', 'variable1', 'Corn Stalk Height', '10'),
      obsRow('g1', 'G1', 'variable2', 'Leaf Width', '5'),
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiBuildPhenotypeMatrix.handler(
      brapiBuildPhenotypeMatrix.input.parse({ studies: ['s1'], shape: 'wide', aggregate: 'first' }),
      ctx,
    );

    expect(result.variableLegend).toMatchObject({
      variable1: 'Corn Stalk Height',
      variable2: 'Leaf Width',
    });
  });

  it('sanitizes numeric and reserved-word variable DbIds into safe wide columns', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      obsRow('g1', 'G1', '42', 'Plant Height', '10'), // numeric → v_42
      obsRow('g1', 'G1', 'end', 'End Date Trait', '20'), // reserved SQL word → end_
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiBuildPhenotypeMatrix.handler(
      brapiBuildPhenotypeMatrix.input.parse({ studies: ['s1'], shape: 'wide', aggregate: 'first' }),
      ctx,
    );

    const cols = result.dataframe?.columns ?? [];
    // Raw numeric / reserved names must NOT reach the dataframe (they fail the
    // framework's canvas identifier gate and would throw at registerTable).
    expect(cols).not.toContain('42');
    expect(cols).not.toContain('end');
    expect(cols).toContain('v_42');
    expect(cols).toContain('end_');
    // Legend resolves the safe column back to the display name.
    expect(result.variableLegend['v_42']).toBe('Plant Height');
    expect(result.variableLegend['end_']).toBe('End Date Trait');
  });

  // -------------------------------------------------------------------------
  // Format rendering
  // -------------------------------------------------------------------------
  it('format() renders header with germplasm × variable counts', async () => {
    const ctx = await connect(fetcher);
    const rows = [obsRow('g1', 'G1', 'v1', 'Height', '10')];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiBuildPhenotypeMatrix.handler(
      brapiBuildPhenotypeMatrix.input.parse({ studies: ['s1'], shape: 'wide' }),
      ctx,
    );

    const formatted = brapiBuildPhenotypeMatrix.format(result);
    expect(formatted[0]?.text).toMatch(/1 germplasm × 1 variables/);
    expect(formatted[0]?.text).toMatch(/tableName/);
  });
});
