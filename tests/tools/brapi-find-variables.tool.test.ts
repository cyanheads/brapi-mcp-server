/**
 * @fileoverview End-to-end tests for `brapi_find_variables` — capability
 * gate, free-text ranking via OntologyResolver, ontology-endpoint capability
 * gap warning, multi-study warning, distribution computation across nested
 * trait/scale objects.
 *
 * @module tests/tools/brapi-find-variables.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiFindVariables } from '@/mcp-server/tools/definitions/brapi-find-variables.tool.js';
import { getCanvasBridge } from '@/services/canvas-bridge/index.js';
import { initOntologyResolver } from '@/services/ontology-resolver/index.js';
import {
  BASE_URL,
  envelope,
  initTestServices,
  jsonResponse,
  type MockFetcher,
  pathnameOf,
  resetTestServices,
} from './_tool-test-helpers.js';

function varRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    observationVariableDbId: 'var-1',
    observationVariableName: 'Dry Matter %',
    observationVariablePUI: 'CO_334:0000013',
    ontologyDbId: 'CO_334',
    ontologyName: 'Cassava',
    trait: { traitDbId: 'trait-1', traitName: 'Dry matter content', traitClass: 'Agronomic' },
    scale: { scaleDbId: 'scale-1', scaleName: 'Percent', dataType: 'Numerical' },
    method: { methodDbId: 'method-1', methodName: 'Gravimetric' },
    ...extra,
  };
}

async function connect(
  fetcher: MockFetcher,
  calls: string[] = ['variables', 'ontologies'],
  serverName = 'Test',
) {
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

describe('brapi_find_variables tool', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
    initOntologyResolver();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('returns rows + nested-field distributions for trait class and scale', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      varRow(),
      varRow({
        observationVariableDbId: 'var-2',
        ontologyDbId: 'CO_334',
        trait: { traitName: 'Plant height', traitClass: 'Morphological' },
        scale: { scaleName: 'Centimeters', dataType: 'Numerical' },
      }),
      varRow({
        observationVariableDbId: 'var-3',
        ontologyDbId: 'CO_338',
        trait: { traitClass: 'Agronomic' },
        scale: { scaleName: 'Percent', dataType: 'Numerical' },
      }),
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiFindVariables.handler(
      brapiFindVariables.input.parse({ ontologies: ['CO_334'] }),
      ctx,
    );

    expect(getEnrichment(ctx).returnedCount).toBe(3);
    expect(result.distributions.ontologyDbId).toEqual({ CO_334: 2, CO_338: 1 });
    expect(result.distributions.traitClass).toEqual({ Agronomic: 2, Morphological: 1 });
    expect(result.distributions.scaleName).toEqual({ Percent: 2, Centimeters: 1 });
  });

  it('ranks free-text matches via OntologyResolver and promotes them to the top', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      varRow({
        observationVariableDbId: 'var-other',
        observationVariableName: 'Plant height',
        observationVariablePUI: 'CO_334:0000010',
        trait: { traitName: 'Plant height' },
      }),
      varRow(), // dry matter — should be promoted
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiFindVariables.handler(
      brapiFindVariables.input.parse({ text: 'dry matter' }),
      ctx,
    );

    expect(result.ontologyCandidates.length).toBeGreaterThan(0);
    // First result should be the dry-matter variable (promoted via PUI match in candidates).
    expect(result.results[0]?.observationVariableDbId).toBe('var-1');
  });

  it('surfaces candidates when the free-text query only matches trait.traitName (BrAPI v2.1 test-server shape)', async () => {
    const ctx = await connect(fetcher);
    // Mirrors the BrAPI Community Test Server: variable names don't contain
    // "plant height" but `trait.traitName` does. Without the field-name fix,
    // the resolver looked at `trait.name` (always undefined on v2.1 servers)
    // and returned an empty candidate list. With the fix, both rows surface
    // and get promoted to the top of `results`.
    const rows = [
      {
        observationVariableDbId: 'variable3',
        observationVariableName: 'Pawpaw Fruit Yield',
        trait: { traitName: 'Fruit Yield', traitDescription: 'fruit yield' },
      },
      {
        observationVariableDbId: 'variable1',
        observationVariableName: 'Corn Stalk Height',
        trait: { traitName: 'Plant Height', traitDescription: 'plant height' },
      },
      {
        observationVariableDbId: 'variable2',
        observationVariableName: 'Pawpaw Height',
        trait: { traitName: 'Plant Height', traitDescription: 'plant height' },
      },
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiFindVariables.handler(
      brapiFindVariables.input.parse({ text: 'plant height' }),
      ctx,
    );

    expect(result.ontologyCandidates.length).toBe(2);
    expect(result.ontologyCandidates.map((c) => c.observationVariableDbId).sort()).toEqual([
      'variable1',
      'variable2',
    ]);
    expect(
      result.results
        .slice(0, 2)
        .map((r) => r.observationVariableDbId)
        .sort(),
    ).toEqual(['variable1', 'variable2']);
  });

  it('promotes free-text matches by observationVariableDbId when PUI is missing (CassavaBase)', async () => {
    const ctx = await connect(fetcher);
    // Real CassavaBase variables don't carry observationVariablePUI; promotion
    // must fall back to observationVariableDbId, which is always populated.
    const rows = [
      {
        observationVariableDbId: 'var-other',
        observationVariableName: 'Plant height',
        trait: { traitName: 'Plant height' },
      },
      {
        observationVariableDbId: 'var-dm',
        observationVariableName: 'Dry matter percent',
        trait: { traitName: 'Dry matter content' },
      },
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiFindVariables.handler(
      brapiFindVariables.input.parse({ text: 'dry matter' }),
      ctx,
    );

    expect(result.ontologyCandidates.length).toBeGreaterThan(0);
    expect(result.ontologyCandidates[0]?.observationVariableDbId).toBe('var-dm');
    expect(result.results[0]?.observationVariableDbId).toBe('var-dm');
  });

  it('warns when more than one studyDbId is supplied (BrAPI accepts only one)', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));

    await brapiFindVariables.handler(
      brapiFindVariables.input.parse({ studies: ['s-1', 's-2'] }),
      ctx,
    );

    expect(getEnrichment(ctx).warnings.join('\n')).toContain('only one studyDbId');
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.get('studyDbId')).toBe('s-1');
  });

  it('warns when free-text is supplied but /ontologies is unavailable', async () => {
    const ctx = await connect(fetcher, ['variables']); // no ontologies in calls
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [varRow()] }, { totalCount: 1 })));

    await brapiFindVariables.handler(brapiFindVariables.input.parse({ text: 'dry matter' }), ctx);
    expect(getEnrichment(ctx).warnings.join('\n')).toContain('does not expose /ontologies');
  });

  it('throws ValidationError when /variables is not advertised', async () => {
    const ctx = await connect(fetcher, ['studies']);
    await expect(
      brapiFindVariables.handler(brapiFindVariables.input.parse({}), ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
  });

  it('downcasts plural filters to singular when connected to a CassavaBase server', async () => {
    const ctx = await connect(fetcher, ['variables', 'ontologies'], 'CassavaBase');
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));

    await brapiFindVariables.handler(
      brapiFindVariables.input.parse({
        variables: ['var-1'],
        ontologies: ['CO_334'],
        traitClasses: ['Agronomic'],
      }),
      ctx,
    );

    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.getAll('observationVariableDbId')).toEqual(['var-1']);
    expect(url.searchParams.getAll('ontologyDbId')).toEqual(['CO_334']);
    expect(url.searchParams.getAll('traitClass')).toEqual(['Agronomic']);
    expect(url.searchParams.has('observationVariableDbIds')).toBe(false);
    expect(url.searchParams.has('ontologyDbIds')).toBe(false);
    expect(url.searchParams.has('traitClasses')).toBe(false);
  });

  it('escalates GET → POST /search when multi-value filters would be downcast (#15)', async () => {
    // BrAPI Community Test Server singularizes plural GET filters but its
    // POST /search routes work natively with multi-value arrays. When the
    // caller passes multiple values, the route resolver should escalate to
    // POST /search/variables instead of silently downcasting to the first
    // value on the GET wire.
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/serverinfo')) {
        return jsonResponse(
          envelope({
            serverName: 'BrAPI Test Server',
            calls: [
              { service: 'variables', methods: ['GET'], versions: ['2.1'] },
              { service: 'search/variables', methods: ['POST'], versions: ['2.1'] },
              { service: 'ontologies', methods: ['GET'], versions: ['2.1'] },
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

    let searchCalledWith: Record<string, unknown> | undefined;
    fetcher.mockImplementation(
      async (
        url: string,
        _timeoutMs: number,
        _ctx: unknown,
        init?: { method?: string; body?: string },
      ) => {
        const path = pathnameOf(url);
        if (path.endsWith('/search/variables') && init?.method === 'POST') {
          searchCalledWith = JSON.parse(init.body ?? '{}');
          return jsonResponse(envelope({ data: [varRow()] }, { totalCount: 1 }));
        }
        return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
      },
    );

    await brapiFindVariables.handler(
      brapiFindVariables.input.parse({
        variables: ['var-1', 'var-2', 'var-3'],
      }),
      ctx,
    );

    expect(searchCalledWith).toBeDefined();
    // The full multi-value array must reach the search body — not be downcast.
    expect(searchCalledWith?.observationVariableDbIds).toEqual(['var-1', 'var-2', 'var-3']);
    expect(getEnrichment(ctx).warnings.join('\n')).toContain('escalated to POST /search/variables');
    expect(getEnrichment(ctx).returnedCount).toBe(1);
  });

  it('tolerates null values on nested trait/scale/method fields (Cassavabase shape)', async () => {
    const ctx = await connect(fetcher);
    const sparseRow = {
      observationVariableDbId: 'var-cb-1',
      observationVariableName: 'Cassava trait',
      // Cassavabase nulls in the wild on nested objects:
      trait: {
        traitDbId: 'trait-1',
        traitName: 'Some trait',
        traitClass: null,
        description: null,
      },
      scale: { scaleDbId: 'scale-1', scaleName: null, dataType: null },
      method: { methodDbId: null, methodName: null },
    };
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [sparseRow] }, { totalCount: 1 })));
    const result = await brapiFindVariables.handler(brapiFindVariables.input.parse({}), ctx);
    expect(getEnrichment(ctx).returnedCount).toBe(1);
    expect(result.results[0]?.trait?.traitClass).toBeNull();
    expect(result.results[0]?.scale?.scaleName).toBeNull();
  });
});

describe('brapi_find_variables inline budget (#66)', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
    initOntologyResolver();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTestServices();
  });

  /** Serve a paged /variables list; any other host fails the call. */
  function serve(rows: Record<string, unknown>[]): void {
    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(String(url));
      if (u.hostname !== 'brapi.example.org' || u.pathname !== '/brapi/v2/variables') {
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
      ...brapiFindVariables,
      handler: (parsed, contractCtx) =>
        brapiFindVariables.handler(parsed, { ...contractCtx, state: ctx.state }),
    } satisfies typeof brapiFindVariables;
    const result = await runToolContract(definition, input, { context: { tenantId: 't1' } });
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    return { result, structured: result.structuredContent as Record<string, unknown>, text };
  }

  const ids = (s: Record<string, unknown>) =>
    (s.results as { observationVariableDbId: string }[]).map((r) => r.observationVariableDbId);

  it('budgets the ranked rows: free-text matches lead results[], every row is staged', async () => {
    const ctx = await connect(fetcher);
    // ~5 KB per row; the two dry-matter rows sit last upstream.
    const description = 'x'.repeat(4_800);
    const rows = Array.from({ length: 8 }, (_, i) => {
      const n = i + 1;
      const dryMatter = n > 6;
      return varRow({
        observationVariableDbId: `var-${n}`,
        observationVariableName: dryMatter ? `Dry matter ${n}` : `Plant height ${n}`,
        observationVariablePUI: `CO_334:000${n}`,
        trait: { traitName: dryMatter ? 'Dry matter content' : 'Plant height', description },
      });
    });
    serve(rows);
    const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');

    const { result, structured, text } = await call(ctx, { text: 'dry matter' });

    expect(result.isError).toBeFalsy();
    expect(Buffer.byteLength(JSON.stringify(structured.results), 'utf8')).toBeLessThanOrEqual(
      24_000,
    );
    expect(ids(structured)).toEqual(['var-7', 'var-8', 'var-1', 'var-2']);
    expect(structured).toMatchObject({
      returnedCount: 4,
      totalCount: 8,
      hasMore: true,
      truncated: true,
      shown: 4,
      cap: 1_000,
      dataframe: { rowCount: 8 },
    });
    const staged = register.mock.calls[0]![1].rows as Record<string, unknown>[];
    expect(new Set(staged.map((r) => r.observationVariableDbId)).size).toBe(8);
    expect(text).toContain('24,000-byte inline budget');
  });

  it('measures the pruned rows it returns, staging nothing when only the empty containers overran the budget', async () => {
    const ctx = await connect(fetcher);
    // Each row carries a ~5 KB `method` container whose every field is null: the raw
    // set overruns the budget, the pruned rows results[] holds do not.
    const emptyMethod = Object.fromEntries(
      Array.from({ length: 400 }, (_, k) => [`k${String(k).padStart(4, '0')}`, null]),
    );
    serve(
      Array.from({ length: 8 }, (_, i) =>
        varRow({ observationVariableDbId: `var-${i + 1}`, method: emptyMethod }),
      ),
    );

    const { structured } = await call(ctx, {});

    expect(ids(structured)).toHaveLength(8);
    expect(structured.results as Record<string, unknown>[]).not.toContainEqual(
      expect.objectContaining({ method: expect.anything() }),
    );
    expect(structured).toMatchObject({ returnedCount: 8, hasMore: false });
    for (const key of ['truncated', 'shown', 'cap', 'notice', 'dataframe']) {
      expect(structured).not.toHaveProperty(key);
    }
  });

  it('sets no truncation fields on an empty result', async () => {
    const ctx = await connect(fetcher);
    serve([]);

    const { result, structured } = await call(ctx, {});

    expect(result.isError).toBeFalsy();
    expect(structured).toMatchObject({ returnedCount: 0, hasMore: false, results: [] });
    expect(structured.notice).toMatch(/^No variables matched/);
    for (const key of ['truncated', 'shown', 'cap', 'dataframe']) {
      expect(structured).not.toHaveProperty(key);
    }
  });
});
