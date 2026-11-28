/**
 * @fileoverview End-to-end tests for `brapi_find_variables` — capability
 * gate, free-text ranking via OntologyResolver, ontology-endpoint capability
 * gap warning, multi-study warning, distribution computation across nested
 * trait/scale objects.
 *
 * @module tests/tools/brapi-find-variables.tool.test
 */

import { tmpdir } from 'node:os';
import type { Context } from '@cyanheads/mcp-ts-core';
import {
  CanvasRegistry,
  DataCanvas,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiFindVariables } from '@/mcp-server/tools/definitions/brapi-find-variables.tool.js';
import { getCanvasBridge, initCanvasBridge } from '@/services/canvas-bridge/index.js';
import { initOntologyResolver } from '@/services/ontology-resolver/index.js';
import {
  BASE_URL,
  envelope,
  initTestServices,
  jsonResponse,
  type MockFetcher,
  pathnameOf,
  resetTestServices,
  TEST_CONFIG,
  withCallRemaining,
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
          calls: calls.map((service) => ({
            service,
            methods: [service.startsWith('search/') ? 'POST' : 'GET'],
            versions: ['2.1'],
          })),
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

  it('preserves a single study filter and empty-result behavior', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));

    await brapiFindVariables.handler(brapiFindVariables.input.parse({ studies: ['s-1'] }), ctx);

    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.get('studyDbId')).toBe('s-1');
    expect(getEnrichment(ctx).returnedCount).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { studies: ['S1'] },
    { studies: ['S1', 'S1'] },
    { studies: ['S1', 'S2'] },
    { extraFilters: { studyDbId: 'S1' } },
    { extraFilters: { studyDbIds: ['S1', 'S2'] } },
    { studies: ['S1'], text: 'height' },
  ])('rejects unsupported variable study-only scope on brapi-test (#133): %j', async (input) => {
    const ctx = await connect(fetcher, ['variables'], 'BrAPI Community Test Server');
    const { result, structured, text } = await callContract(ctx, input);
    expect(result.isError).toBe(true);
    expect(structured).toMatchObject({
      error: {
        data: {
          reason: 'all_filters_dropped',
          dialect: 'brapi-test',
          recovery: { hint: expect.stringContaining('text alone to rank the server catalog') },
        },
      },
    });
    expect(text).toContain('all_filters_dropped');
    expect(text).toContain('text alone to rank the server catalog');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['GET', 'POST'])(
    'drops study scope without losing remaining %s filters (#133)',
    async (method) => {
      const ctx = await connect(
        fetcher,
        ['variables', 'search/variables', 'ontologies'],
        'BrAPI Community Test Server',
      );
      const rows = [
        varRow({ observationVariableDbId: 'v1', commonCropName: 'Pawpaw' }),
        varRow({ observationVariableDbId: 'v2', commonCropName: 'Pawpaw' }),
      ];
      const wire: Record<string, unknown>[] = [];
      fetcher.mockImplementation(async (url, _timeout, _ctx, init) => {
        const query = new URL(String(url)).searchParams;
        const params =
          method === 'POST' ? JSON.parse(String(init?.body)) : Object.fromEntries(query);
        expect(pathnameOf(url)).toBe(
          method === 'POST' ? '/brapi/v2/search/variables' : '/brapi/v2/variables',
        );
        const { pageSize, page, ...filters } = params;
        wire.push(filters);
        const start = Number(page ?? 0) * Number(pageSize);
        return jsonResponse(
          envelope(
            { data: rows.slice(start, start + Number(pageSize)) },
            { totalCount: rows.length },
          ),
        );
      });
      const variables = ['v1', 'v2'];
      const expected =
        method === 'POST' ? { observationVariableDbIds: variables } : { commonCropName: 'Pawpaw' };
      const { result, structured, text } = await callContract(ctx, {
        studies: ['S1', 'S2'],
        extraFilters: { studyDbIds: ['S1', 'S2'] },
        ...(method === 'POST' ? { variables } : { crop: 'Pawpaw' }),
        loadLimit: 1,
      });
      expect(result.isError).toBeFalsy();
      expect(wire).toEqual([expected, expected]);
      expect(structured.appliedFilters).toEqual(expected);
      expect(structured).not.toHaveProperty('studyCoverage');
      expect((structured.results as Record<string, unknown>[])[0]).not.toHaveProperty('studyDbIds');
      expect(structured.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("dropped filter 'studyDbId'"),
          expect.stringContaining("dropped filter 'studyDbIds'"),
        ]),
      );
      expect(text).toContain("dropped filter 'studyDbId'");
      expect(text).not.toContain('## Study coverage');
      const described = await getCanvasBridge().describe(ctx);
      expect(described).toHaveLength(1);
      expect(described[0]?.provenance?.query).toEqual(expected);
    },
  );

  it('unions overlapping studies by actual variable ID with provenance', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(async (url: string) => {
      const study = new URL(url).searchParams.get('studyDbId');
      const rows =
        study === '4494'
          ? [
              varRow({ observationVariableDbId: '76736' }),
              varRow({ observationVariableDbId: '76745' }),
            ]
          : [
              varRow({ observationVariableDbId: '76736' }),
              varRow({ observationVariableDbId: '76745' }),
              varRow({ observationVariableDbId: '76742' }),
            ];
      return jsonResponse(envelope({ data: rows }, { totalCount: rows.length }));
    });
    const result = await brapiFindVariables.handler(
      brapiFindVariables.input.parse({ studies: ['4494', '4505', '4494'] }),
      ctx,
    );
    expect(result.results.map((row) => row.observationVariableDbId)).toEqual([
      '76736',
      '76745',
      '76742',
    ]);
    expect(result.results[0]).toMatchObject({ studyDbIds: ['4494', '4505'] });
    expect(result.results[2]).toMatchObject({ studyDbIds: ['4505'] });
    expect(getEnrichment(ctx).totalCount).toBe(3);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.distributions.ontologyDbId).toEqual({ CO_334: 3 });
    expect(brapiFindVariables.format!(result)[0]).toMatchObject({
      text: expect.stringContaining('4505'),
    });
  });

  it('warns when free-text is supplied but /ontologies is unavailable', async () => {
    const ctx = await connect(fetcher, ['variables']); // no ontologies in calls
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [varRow()] }, { totalCount: 1 })));

    await brapiFindVariables.handler(brapiFindVariables.input.parse({ text: 'dry matter' }), ctx);
    expect(getEnrichment(ctx).warnings.join('\n')).toContain('does not expose /ontologies');
  });

  it('paginates distinct studies under one page budget and stages the union once', async () => {
    const ctx = await connect(fetcher);
    const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(url);
      const study = u.searchParams.get('studyDbId');
      const page = Number(u.searchParams.get('page') ?? 0);
      return jsonResponse(
        envelope(
          {
            data: Array.from({ length: 10 }, (_, i) => ({
              observationVariableDbId: `${study}-${page * 10 + i}`,
            })),
          },
          { totalCount: 10_000 },
        ),
      );
    });
    const result = await brapiFindVariables.handler(
      brapiFindVariables.input.parse({ studies: ['a', 'b', 'c'], loadLimit: 5 }),
      ctx,
    );
    expect(fetcher).toHaveBeenCalledTimes(50);
    expect(register).toHaveBeenCalledTimes(1);
    const staged = register.mock.calls[0]![1].rows as Record<string, unknown>[];
    expect(staged).toHaveLength(500);
    expect(new Set(staged.map((row) => row.observationVariableDbId)).size).toBe(500);
    expect(result.studyCoverage?.every((item) => item.status === 'partial')).toBe(true);
    expect(result.dataframe?.truncated).toBe(true);
    expect(result.hasMore).toBe(true);
    const described = await getCanvasBridge().describe(ctx);
    expect(described).toHaveLength(1);
    expect(described[0]?.provenance?.query).toMatchObject({ studyDbId: ['a', 'b', 'c'] });
    vi.restoreAllMocks();
  });

  it.each([undefined, null])(
    'preserves upstream studyDbIds passthrough without union (value: %s)',
    async (studyDbIds) => {
      const ctx = await connect(fetcher);
      fetcher.mockImplementation(async () =>
        jsonResponse(envelope({ data: [varRow({ studyDbIds })] }, { totalCount: 1 })),
      );
      const definition = {
        ...brapiFindVariables,
        handler: (parsed, contractCtx) =>
          brapiFindVariables.handler(parsed, { ...contractCtx, state: ctx.state }),
      } satisfies typeof brapiFindVariables;
      const result = await runToolContract(definition, {}, { context: { tenantId: 't1' } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        results: [{ observationVariableDbId: 'var-1' }],
      });
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining('var-1') }),
        ]),
      );
    },
  );

  it('discloses changing study strides on both surfaces and stages only discovered identities', async () => {
    const ctx = await connect(fetcher);
    const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(url);
      if (u.searchParams.get('studyDbId') === 'empty')
        return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
      const page = Number(u.searchParams.get('page') ?? 0);
      const pageSize = page === 0 ? 3 : 2;
      return jsonResponse({
        metadata: { pagination: { totalCount: 5, pageSize } },
        result: {
          data: Array.from({ length: pageSize }, (_, i) =>
            varRow({ observationVariableDbId: String(page * pageSize + i) }),
          ),
        },
      });
    });
    const definition = {
      ...brapiFindVariables,
      handler: (parsed, contractCtx) =>
        brapiFindVariables.handler(parsed, { ...contractCtx, state: ctx.state }),
    } satisfies typeof brapiFindVariables;
    const result = await runToolContract(
      definition,
      { studies: ['changing', 'empty'], loadLimit: 1 },
      { context: { tenantId: 't1' } },
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      hasMore: true,
      studyCoverage: [
        { id: 'changing', status: 'partial', reason: 'page_size_changed' },
        { id: 'empty', status: 'complete' },
      ],
      dataframe: { rowCount: 4, truncated: true },
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('page_size_changed') }),
      ]),
    );
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]?.[1].rows.map((row) => row.observationVariableDbId)).toEqual([
      '0',
      '1',
      '2',
      '3',
    ]);
    vi.restoreAllMocks();
  });

  it('returns failed and empty-study coverage alongside successful rows on both surfaces', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(async (url: string) => {
      const study = new URL(url).searchParams.get('studyDbId');
      if (study === 'bad') return jsonResponse({ message: 'upstream failed' }, 500);
      const rows = study === 'empty' ? [] : [varRow()];
      return jsonResponse(envelope({ data: rows }, { totalCount: rows.length }));
    });
    const definition = {
      ...brapiFindVariables,
      handler: (parsed, contractCtx) =>
        brapiFindVariables.handler(parsed, { ...contractCtx, state: ctx.state }),
    } satisfies typeof brapiFindVariables;
    const result = await runToolContract(
      definition,
      { studies: ['ok', 'bad', 'empty'] },
      { context: { tenantId: 't1' } },
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      results: [{ observationVariableDbId: 'var-1', studyDbIds: ['ok'] }],
      hasMore: true,
      studyCoverage: [
        { id: 'ok', status: 'complete' },
        { id: 'bad', status: 'failed' },
        { id: 'empty', status: 'complete' },
      ],
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('`bad`: failed') }),
      ]),
    );
  });

  it('raises the upstream failure when every attempted study fails', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(async () => new Response('unavailable', { status: 503 }));
    await expect(
      brapiFindVariables.handler(
        brapiFindVariables.input.parse({ studies: ['bad', 'also-bad'] }),
        ctx,
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
  });

  it('reports deadline-skipped studies without dispatching requests', async () => {
    const ctx = await connect(fetcher);
    const result = await brapiFindVariables.handler(
      brapiFindVariables.input.parse({ studies: ['a', 'b'] }),
      withCallRemaining(ctx, 0),
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.studyCoverage).toEqual([
      { id: 'a', status: 'unprocessed', reason: 'deadline', rowsScanned: 0, pagesFetched: 0 },
      { id: 'b', status: 'unprocessed', reason: 'deadline', rowsScanned: 0, pagesFetched: 0 },
    ]);
    expect(result.hasMore).toBe(true);
  });

  it('propagates caller cancellation without scheduling later studies', async () => {
    const connected = await connect(fetcher);
    const controller = new AbortController();
    const ctx = { ...connected, signal: controller.signal };
    fetcher.mockImplementation(async () => {
      controller.abort();
      throw new Error('cancelled');
    });
    await expect(
      brapiFindVariables.handler(
        brapiFindVariables.input.parse({ studies: ['a', 'b', 'c', 'd', 'e'] }),
        ctx,
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('preserves named-study precedence over extraFilters before fanout', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(async () => jsonResponse(envelope({ data: [] }, { totalCount: 0 })));
    const result = await brapiFindVariables.handler(
      brapiFindVariables.input.parse({
        studies: ['a', 'b'],
        extraFilters: { studyDbId: 'override' },
      }),
      ctx,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      fetcher.mock.calls.map((call) => new URL(String(call[0])).searchParams.get('studyDbId')),
    ).toEqual(['a', 'b']);
    expect(result.studyCoverage).toHaveLength(2);
    expect(getEnrichment(ctx).appliedFilters).toMatchObject({ studyDbId: ['a', 'b'] });
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

  it('expands scalar filters inside each study walk and preserves study provenance', async () => {
    const ctx = await connect(fetcher, ['variables'], 'CassavaBase');
    const requests: string[] = [];
    fetcher.mockImplementation(async (url: string) => {
      const params = new URL(url).searchParams;
      const variable = params.get('observationVariableDbId');
      requests.push(`${params.get('studyDbId')}/${variable}`);
      return jsonResponse(
        envelope({ data: [{ observationVariableDbId: variable }] }, { totalCount: 1 }),
      );
    });
    const result = await brapiFindVariables.handler(
      brapiFindVariables.input.parse({ studies: ['S1', 'S2'], variables: ['V1', 'V2'] }),
      ctx,
    );
    expect(new Set(requests)).toEqual(new Set(['S1/V1', 'S1/V2', 'S2/V1', 'S2/V2']));
    expect(result.results).toEqual([
      expect.objectContaining({ observationVariableDbId: 'V1', studyDbIds: ['S1', 'S2'] }),
      expect.objectContaining({ observationVariableDbId: 'V2', studyDbIds: ['S1', 'S2'] }),
    ]);
    expect(result.studyCoverage).toMatchObject([
      { id: 'S1', status: 'complete', pagesFetched: 2 },
      { id: 'S2', status: 'complete', pagesFetched: 2 },
    ]);
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

  it('promotes the normalized base name in both candidates and results', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      varRow({
        observationVariableDbId: '78776',
        observationVariableName: 'dry matter content percentage|month 10|boiled root|COMP:0000195',
        observationVariablePUI: 'COMP:0000195',
        trait: { traitName: null },
      }),
      varRow({
        observationVariableDbId: '70741',
        observationVariableName: 'dry matter content percentage|CO_334:0000092',
        observationVariablePUI: 'CO_334:0000092',
        trait: { traitName: 'dry matter content percentage' },
      }),
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));
    const { result, structured, text } = await call(ctx, {
      text: 'dry matter content',
      loadLimit: 1,
    });
    expect(result.isError).not.toBe(true);
    expect(ids(structured)).toEqual(['70741']);
    expect(structured.ontologyCandidates).toMatchObject([
      { observationVariableDbId: '70741', termId: 'CO_334:0000092' },
      { observationVariableDbId: '78776', termId: 'COMP:0000195' },
    ]);
    expect(text).toContain('70741');
    expect(text.indexOf('CO_334:0000092')).toBeLessThan(text.indexOf('COMP:0000195'));
  });

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

/** Run the tool through `runToolContract` against the connection registered on `ctx`. */
async function callContract(ctx: Context, input: Record<string, unknown>) {
  const definition = {
    ...brapiFindVariables,
    handler: (parsed, contractCtx) =>
      brapiFindVariables.handler(parsed, { ...contractCtx, state: ctx.state }),
  } satisfies typeof brapiFindVariables;
  const result = await runToolContract(definition, input, { context: { tenantId: 't1' } });
  const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  return { result, structured: result.structuredContent as Record<string, unknown>, text };
}

describe('brapi_find_variables multi-study partial collection (#123)', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
    initOntologyResolver();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('leaves the total off a truncated handle when a study fails, and words the stop by its distinct rows', async () => {
    const ctx = await connect(fetcher);
    // S1 serves v0–v7 and S2 serves v4–v11 (12 distinct); S3 answers 503.
    fetcher.mockImplementation(async (url: string) => {
      const study = new URL(url).searchParams.get('studyDbId');
      if (study === 'S3') return jsonResponse({ error: 'down' }, 503);
      const offset = study === 'S1' ? 0 : 4;
      const data = Array.from({ length: 8 }, (_, i) => ({
        observationVariableDbId: `v${offset + i}`,
        observationVariableName: `Var ${offset + i}`,
      }));
      return jsonResponse(envelope({ data }, { totalCount: data.length }));
    });

    const { result, structured, text } = await callContract(ctx, {
      studies: ['S1', 'S2', 'S3'],
      loadLimit: 5,
    });

    expect(result.isError).toBeFalsy();
    expect(structured).toMatchObject({
      hasMore: true,
      totalCount: 12,
      studyCoverage: [
        { id: 'S1', status: 'complete' },
        { id: 'S2', status: 'complete' },
        { id: 'S3', status: 'failed' },
      ],
      dataframe: { rowCount: 12, truncated: true },
    });
    expect(structured.dataframe).not.toHaveProperty('totalCount');
    expect(structured.warnings).toContain(
      'Collection incomplete at 12 distinct row(s): multi-study coverage incomplete; see studyCoverage. The dataframe holds the rows fetched so far and is marked truncated; narrow the filters or retry the call.',
    );
    expect(text).toContain(
      'Collection incomplete at 12 distinct row(s): multi-study coverage incomplete',
    );
    expect(text).not.toContain('- totalCount: 12');
  });
});

describe('brapi_find_variables free-text match ranking (#127)', () => {
  let fetcher: MockFetcher;
  let nativeCanvas: DataCanvas | undefined;

  beforeEach(() => {
    fetcher = initTestServices();
    initOntologyResolver();
  });

  afterEach(async () => {
    try {
      if (nativeCanvas) await nativeCanvas.shutdown(createMockContext());
    } finally {
      nativeCanvas = undefined;
      vi.restoreAllMocks();
      resetTestServices();
    }
  });

  /** Swap the fake canvas for DuckDB so staged tables answer real SQL. */
  function useDuckdb() {
    const provider = new DuckdbProvider({
      defaultRowLimit: 100,
      exportRootPath: tmpdir(),
      memoryLimitMb: 128,
      schemaSniffRows: 100,
    });
    nativeCanvas = new DataCanvas(
      provider,
      new CanvasRegistry(provider, { ...DEFAULT_CANVAS_REGISTRY_OPTIONS, sweeperIntervalMs: 0 }),
    );
    return initCanvasBridge(nativeCanvas, TEST_CONFIG);
  }

  /**
   * 60 variables `v00`–`v59`; every fourth (`v03`, `v07`, … `v59`) is an
   * equal-length "dry matter content percentage" method variant, so the 15
   * matches tie and keep upstream order.
   */
  const rows60 = Array.from({ length: 60 }, (_, i) => {
    const id = `v${String(i).padStart(2, '0')}`;
    return {
      observationVariableDbId: id,
      observationVariableName:
        i % 4 === 3
          ? `dry matter content percentage|method ${id}`
          : `abiotic stress trait|month ${id}`,
    };
  });
  const matchIds = rows60.filter((_, i) => i % 4 === 3).map((row) => row.observationVariableDbId);
  const ids = (structured: Record<string, unknown>) =>
    (structured.results as { observationVariableDbId: string }[]).map(
      (row) => row.observationVariableDbId,
    );

  /** Serve `rows` as a paged /variables list, failing pages at or past `failFromPage`. */
  function serve(rows: Record<string, unknown>[], failFromPage?: number) {
    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(String(url));
      if (u.pathname !== '/brapi/v2/variables') throw new Error(`unmocked fetch: ${u.href}`);
      const page = Number.parseInt(u.searchParams.get('page') ?? '0', 10);
      const pageSize = Number.parseInt(u.searchParams.get('pageSize') ?? '10', 10);
      if (failFromPage !== undefined && page >= failFromPage && pageSize === 10) {
        return jsonResponse({ error: 'upstream down' }, 500);
      }
      return jsonResponse(
        envelope(
          { data: rows.slice(page * pageSize, page * pageSize + pageSize) },
          { totalCount: rows.length },
        ),
      );
    });
  }

  it('summarizes SGN references and data types over the fetched set (#132)', async () => {
    const ctx = await connect(fetcher, ['variables', 'ontologies'], 'CassavaBase');
    const rows = [
      {
        observationVariableDbId: 'v1',
        ontologyDbId: '  ',
        ontologyReference: { ontologyDbId: '186', ontologyName: 'CO_334' },
        scale: { dataType: 'Numerical', scaleName: null },
      },
      {
        observationVariableDbId: 'v2',
        ontologyDbId: '291',
        ontologyName: 'COMP',
        ontologyReference: { ontologyDbId: '186', ontologyName: 'CO_334' },
        scale: { dataType: 'Text' },
      },
    ];
    serve(rows);
    const { result, structured, text } = await callContract(ctx, {
      loadLimit: 1,
      ontologies: ['CO_334'],
    });
    expect(result.isError).toBeFalsy();
    expect(structured.distributions).toEqual({
      ontologyDbId: { '186': 1, '291': 1 },
      ontologyName: { CO_334: 1, COMP: 1 },
      traitClass: {},
      scaleName: {},
      scaleDataType: { Numerical: 1, Text: 1 },
    });
    expect(structured.results).toMatchObject([
      { ontologyDbId: '  ', ontologyReference: rows[0]?.ontologyReference },
    ]);
    expect(structured.warnings).toContain(
      'Fetched variables do not publish trait.traitClass or scale.scaleName.',
    );
    expect(structured.warnings).toContain(
      'Filter \'ontologies\' requested ["CO_334"] but no returned row matches — the server may not honor this filter. Observed values: 186, 291.',
    );
    expect(text).toContain('Fetched variables do not publish trait.traitClass or scale.scaleName.');
    expect(text).toContain('CO_334 (1)');
    expect(text).toContain('Numerical (1)');
  });

  it('skips unusable IDs before ranking and staging (#135)', async () => {
    const ctx = await connect(fetcher, ['variables', 'ontologies'], 'CassavaBase');
    const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
    serve([
      { observationVariableDbId: null, observationVariableName: 'dry matter content' },
      ...rows60,
      { observationVariableName: 'dry matter content', observationVariablePUI: 'CO_334:1' },
      { observationVariableDbId: 25, observationVariableName: 'dry matter content' },
      { observationVariableDbId: '  ', observationVariableName: 'dry matter content' },
    ]);
    const { result, structured, text } = await callContract(ctx, {
      text: 'dry matter content',
      loadLimit: 10,
    });
    expect(result.isError).toBeFalsy();
    expect(structured).toMatchObject({
      totalCount: 64,
      textMatchCount: 15,
      dataframe: { rowCount: 60, totalCount: 60 },
    });
    expect(ids(structured)).toEqual(matchIds.slice(0, 10));
    expect(structured.warnings).toContain(
      'Skipped 4 variable row(s) without a usable observationVariableDbId.',
    );
    expect(text).toContain('Skipped 4 variable row(s) without a usable observationVariableDbId.');
    const staged = register.mock.calls[0]?.[1].rows as Record<string, unknown>[];
    expect(staged.map((row) => row.observationVariableDbId)).toEqual(
      rows60.map((row) => row.observationVariableDbId),
    );
    expect(staged.flatMap((row) => row.textMatchRank ?? [])).toEqual(
      Array.from({ length: 15 }, (_, index) => index + 1),
    );
  });

  it('returns a complete empty result when all IDs are unusable and text is absent (#135)', async () => {
    const ctx = await connect(fetcher);
    serve([{ observationVariableName: 'height' }]);
    const { result, structured, text } = await callContract(ctx, {});
    expect(result.isError).toBeFalsy();
    expect(structured).toMatchObject({ totalCount: 1, hasMore: false, results: [] });
    expect(structured).not.toHaveProperty('dataframe');
    expect(structured).not.toHaveProperty('textMatchCount');
    expect(structured.warnings).toContain(
      'Skipped 1 variable row(s) without a usable observationVariableDbId.',
    );
    expect(text).toContain('Skipped 1 variable row(s) without a usable observationVariableDbId.');
  });

  it('preserves multi-study rows and scan coverage when one study has an unusable ID (#135)', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(async (url: string) => {
      const study = new URL(url).searchParams.get('studyDbId');
      const rows =
        study === 'S1'
          ? [rows60[3], { observationVariableName: 'dry matter content' }]
          : [rows60[3], rows60[7]];
      return jsonResponse(envelope({ data: rows }, { totalCount: rows.length }));
    });
    const { result, structured, text } = await callContract(ctx, {
      studies: ['S1', 'S2'],
      text: 'dry matter content',
    });
    expect(result.isError).toBeFalsy();
    expect(structured).toMatchObject({
      totalCount: 2,
      textMatchCount: 2,
      studyCoverage: [
        { id: 'S1', status: 'complete', rowsScanned: 2 },
        { id: 'S2', status: 'complete', rowsScanned: 2 },
      ],
      results: [
        { observationVariableDbId: 'v03', studyDbIds: ['S1', 'S2'], textMatchRank: 1 },
        { observationVariableDbId: 'v07', studyDbIds: ['S2'], textMatchRank: 2 },
      ],
    });
    expect(text).toContain('Skipped 1 variable row(s) without a usable observationVariableDbId.');
  });

  it('discards invalid IDs before scalar GET fanout deduplicates valid IDs (#135)', async () => {
    const ctx = await connect(fetcher, ['variables'], 'CassavaBase');
    fetcher.mockImplementation(async (url: string) => {
      const scale = new URL(url).searchParams.get('scaleDbId');
      const data =
        scale === 'S1'
          ? [{ observationVariableDbId: 25 }, { observationVariableDbId: 25 }]
          : [{ observationVariableDbId: '25', observationVariableName: 'Height' }];
      return jsonResponse(envelope({ data }, { totalCount: data.length }));
    });
    const { result, structured, text } = await callContract(ctx, { scales: ['S1', 'S2'] });
    expect(result.isError).toBeFalsy();
    expect(structured).toMatchObject({
      results: [{ observationVariableDbId: '25', observationVariableName: 'Height' }],
      totalCount: 1,
      hasMore: false,
    });
    expect(text).toContain('Skipped 2 variable row(s) without a usable observationVariableDbId.');
  });

  it('assigns each rank to the matching source row even when IDs collide (#135)', async () => {
    const ctx = await connect(fetcher);
    const rows = ['plant height', 'dry matter content percentage', 'dry matter content'].map(
      (observationVariableName) => ({ observationVariableDbId: 'dup', observationVariableName }),
    );
    serve(rows);
    const { structured, text } = await callContract(ctx, { text: 'dry matter content' });
    expect(structured.textMatchCount).toBe(2);
    expect(structured.results).toEqual([
      { ...rows[2], textMatchRank: 1 },
      { ...rows[1], textMatchRank: 2 },
      rows[0],
    ]);
    expect(structured.ontologyCandidates).toEqual([
      { observationVariableDbId: 'dup', name: 'dry matter content', source: 'nameMatch' },
      {
        observationVariableDbId: 'dup',
        name: 'dry matter content percentage',
        source: 'nameMatch',
      },
    ]);
    expect(text).toContain('top 2 of 2 text matches');
  });

  it('promotes every match in rank order, counts them, and stages each rank', async () => {
    const ctx = await connect(fetcher, ['variables', 'ontologies'], 'CassavaBase');
    const bridge = useDuckdb();
    serve(rows60);

    const { result, structured, text } = await callContract(ctx, {
      text: 'dry matter content',
      loadLimit: 40,
    });

    expect(result.isError).toBeFalsy();
    expect(structured.textMatchCount).toBe(15);
    expect(ids(structured).slice(0, 15)).toEqual(matchIds);
    const results = structured.results as Record<string, unknown>[];
    expect(results.slice(0, 15).map((row) => row.textMatchRank)).toEqual(
      Array.from({ length: 15 }, (_, i) => i + 1),
    );
    expect(results.slice(15).some((row) => 'textMatchRank' in row)).toBe(false);
    expect(ids(structured).slice(15, 18)).toEqual(['v00', 'v01', 'v02']);
    const candidates = structured.ontologyCandidates as { observationVariableDbId: string }[];
    expect(candidates.map((c) => c.observationVariableDbId)).toEqual(matchIds.slice(0, 10));
    expect(structured).toMatchObject({ hasMore: true, dataframe: { rowCount: 60 } });

    const tableName = (structured.dataframe as { tableName: string }).tableName;
    expect((structured.dataframe as { columns: string[] }).columns).toContain('textMatchRank');
    const canvas = await bridge.getInstance(ctx);
    const counted = await canvas.query(
      `SELECT count(*) AS n FROM "${tableName}" WHERE textMatchRank IS NOT NULL`,
    );
    expect(Number(counted.rows[0]?.n)).toBe(15);
    const ranked = await canvas.query(
      `SELECT observationVariableDbId FROM "${tableName}" WHERE textMatchRank IS NOT NULL ORDER BY textMatchRank`,
    );
    expect(ranked.rows.map((row) => row.observationVariableDbId)).toEqual(matchIds);

    expect(text).toContain('## Ontology candidates (top 10 of 15 text matches)');
    expect(text).toContain('textMatchRank=1');
    expect(text).toContain('textMatchRank=15');
  });

  it('ranks 70741 first and keeps ranks 1–10 equal to the candidate order (#118)', async () => {
    const ctx = await connect(fetcher, ['variables', 'ontologies'], 'CassavaBase');
    const variants = Array.from({ length: 12 }, (_, i) => ({
      observationVariableDbId: String(78_000 + i),
      observationVariableName: `dry matter content percentage|month ${i + 1}|boiled root|COMP:00001${String(i).padStart(2, '0')}`,
      observationVariablePUI: `COMP:00001${String(i).padStart(2, '0')}`,
      trait: { traitName: null },
    }));
    serve([
      ...variants.slice(0, 6),
      {
        observationVariableDbId: '70741',
        observationVariableName: 'dry matter content percentage|CO_334:0000092',
        observationVariablePUI: 'CO_334:0000092',
        trait: { traitName: 'dry matter content percentage' },
      },
      { observationVariableDbId: '1', observationVariableName: 'plant height' },
      ...variants.slice(6),
    ]);

    const { structured } = await callContract(ctx, { text: 'dry matter content' });

    const results = structured.results as Record<string, unknown>[];
    const candidates = structured.ontologyCandidates as { observationVariableDbId: string }[];
    expect(structured.textMatchCount).toBe(13);
    expect(results[0]).toMatchObject({ observationVariableDbId: '70741', textMatchRank: 1 });
    expect(candidates).toHaveLength(10);
    expect(results.slice(0, 10).map((row) => row.observationVariableDbId)).toEqual(
      candidates.map((c) => c.observationVariableDbId),
    );
    expect(results.at(-1)).toMatchObject({ observationVariableDbId: '1' });
    expect(results.at(-1)).not.toHaveProperty('textMatchRank');
  });

  it('leaves rows, order and the staged table unchanged without text', async () => {
    const ctx = await connect(fetcher, ['variables', 'ontologies'], 'CassavaBase');
    const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
    serve(rows60);

    const { structured, text } = await callContract(ctx, { loadLimit: 40 });

    expect(structured).not.toHaveProperty('textMatchCount');
    expect(ids(structured)).toEqual(rows60.slice(0, 40).map((row) => row.observationVariableDbId));
    expect(register.mock.calls[0]?.[1].rows).toEqual(rows60);
    expect(text).not.toContain('textMatchRank');
    expect(text).not.toContain('text matches');
  });

  it.each([undefined, 'dry matter content'])(
    'only reports finder-owned ranks inline and in the staged table (text: %s)',
    async (query) => {
      const ctx = await connect(fetcher, ['variables', 'ontologies'], 'CassavaBase');
      const bridge = useDuckdb();
      const unmatched = {
        observationVariableDbId: 'a',
        observationVariableName: 'plant height',
        sourceLabel: 'upstream-1',
      };
      const matched = {
        observationVariableDbId: 'b',
        observationVariableName: 'dry matter content',
        sourceLabel: 'upstream-2',
      };
      const stagedOnly = {
        observationVariableDbId: 'c',
        observationVariableName: 'canopy cover',
        sourceLabel: 'upstream-3',
      };
      serve([
        { ...unmatched, textMatchRank: 1 },
        { ...matched, textMatchRank: 99 },
        { ...stagedOnly, textMatchRank: 3 },
      ]);
      const { result, structured, text } = await callContract(ctx, {
        text: query,
        loadLimit: 2,
      });

      expect(result.isError).toBeFalsy();
      expect(structured.results).toEqual(
        query ? [{ ...matched, textMatchRank: 1 }, unmatched] : [unmatched, matched],
      );
      expect(text).toContain('upstream-1');
      expect(text).toContain('upstream-2');
      expect(text.match(/textMatchRank=\d+/g) ?? []).toEqual(query ? ['textMatchRank=1'] : []);
      if (query) expect(structured.textMatchCount).toBe(1);
      else expect(structured).not.toHaveProperty('textMatchCount');

      const tableName = (structured.dataframe as { tableName: string }).tableName;
      const canvas = await bridge.getInstance(ctx);
      const staged = await canvas.query(
        `SELECT * FROM "${tableName}" ORDER BY observationVariableDbId`,
      );
      if (query) {
        expect(staged.rows.map((row) => row.textMatchRank)).toEqual([null, '1', null]);
      } else {
        expect(staged.rows.every((row) => !Object.hasOwn(row, 'textMatchRank'))).toBe(true);
      }
      expect(staged.rows.map((row) => row.sourceLabel)).toEqual([
        'upstream-1',
        'upstream-2',
        'upstream-3',
      ]);
    },
  );

  it('reports zero matches with no rank on any row', async () => {
    const ctx = await connect(fetcher);
    serve(rows60.slice(0, 8));

    const { structured, text } = await callContract(ctx, { text: 'canopy temperature' });

    expect(structured).toMatchObject({ textMatchCount: 0, ontologyCandidates: [] });
    expect(ids(structured)).toEqual(rows60.slice(0, 8).map((row) => row.observationVariableDbId));
    expect(
      (structured.results as Record<string, unknown>[]).some((r) => 'textMatchRank' in r),
    ).toBe(false);
    expect(text).toContain('Free-text matches: 0 of the fetched rows.');
  });

  it('counts and ranks only fetched rows when the walk stops early', async () => {
    const ctx = await connect(fetcher, ['variables', 'ontologies'], 'CassavaBase');
    const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
    // The walk re-reads from page 0 in 10-row pages and fails at page 3: rows 30–59 stay unfetched.
    serve(rows60, 3);

    const { structured } = await callContract(ctx, { text: 'dry matter content', loadLimit: 20 });

    expect(structured.textMatchCount).toBe(7);
    expect(ids(structured).slice(0, 7)).toEqual(matchIds.slice(0, 7));
    expect(structured).toMatchObject({
      hasMore: true,
      dataframe: { rowCount: 30, truncated: true },
    });
    const staged = register.mock.calls[0]?.[1].rows as Record<string, unknown>[];
    expect(staged.filter((row) => row.textMatchRank !== undefined)).toHaveLength(7);
  });

  it('keeps multi-study provenance beside the rank', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(async (url: string) => {
      const study = new URL(url).searchParams.get('studyDbId');
      const data = study === 'S1' ? [rows60[0], rows60[3]] : [rows60[3], rows60[7], rows60[8]];
      return jsonResponse(envelope({ data }, { totalCount: data.length }));
    });

    const { structured, text } = await callContract(ctx, {
      studies: ['S1', 'S2'],
      text: 'dry matter content',
    });

    expect(structured.textMatchCount).toBe(2);
    expect(structured.results).toEqual([
      expect.objectContaining({
        observationVariableDbId: 'v03',
        studyDbIds: ['S1', 'S2'],
        textMatchRank: 1,
      }),
      expect.objectContaining({
        observationVariableDbId: 'v07',
        studyDbIds: ['S2'],
        textMatchRank: 2,
      }),
      expect.objectContaining({ observationVariableDbId: 'v00', studyDbIds: ['S1'] }),
      expect.objectContaining({ observationVariableDbId: 'v08', studyDbIds: ['S2'] }),
    ]);
    expect(text).toContain('## Ontology candidates (top 2 of 2 text matches)');
  });

  it('counts every fetched match when loadLimit holds fewer of them', async () => {
    const ctx = await connect(fetcher, ['variables', 'ontologies'], 'CassavaBase');
    const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
    serve(rows60);

    const { result, structured, text } = await callContract(ctx, {
      text: 'dry matter content',
      loadLimit: 10,
    });

    expect(result.isError).toBeFalsy();
    expect(structured.textMatchCount).toBe(15);
    const results = structured.results as Record<string, unknown>[];
    expect(ids(structured)).toEqual(matchIds.slice(0, 10));
    expect(results.map((row) => row.textMatchRank)).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 1),
    );
    const staged = register.mock.calls[0]?.[1].rows as Record<string, unknown>[];
    expect(staged.filter((row) => row.textMatchRank !== undefined)).toHaveLength(15);
    expect(text).toContain('## Ontology candidates (top 10 of 15 text matches)');
  });

  it('skips a late description match with a PUI but without a variable ID', async () => {
    const ctx = await connect(fetcher, ['variables', 'ontologies'], 'CassavaBase');
    const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
    // This would match by trait description after the 15 name matches.
    const puiOnly = {
      observationVariablePUI: 'CO_334:0000092',
      observationVariableName: 'root dry weight',
      trait: { traitDescription: 'Dry matter content of the storage root' },
    };
    serve([...rows60, puiOnly]);

    const { result, structured, text } = await callContract(ctx, {
      text: 'dry matter content',
      loadLimit: 10,
    });

    expect(result.isError).toBeFalsy();
    expect(structured.textMatchCount).toBe(15);
    const staged = register.mock.calls[0]?.[1].rows as Record<string, unknown>[];
    expect(staged.some((row) => row.observationVariablePUI === 'CO_334:0000092')).toBe(false);
    expect(staged.filter((row) => row.textMatchRank !== undefined)).toHaveLength(15);
    expect(text).toContain('Skipped 1 variable row(s) without a usable observationVariableDbId.');
  });

  it('gives a variable listed twice one rank per row, in row order', async () => {
    const ctx = await connect(fetcher);
    const listedTwice = {
      observationVariableDbId: 'v-dup',
      observationVariableName: 'dry matter content',
    };
    serve([
      listedTwice,
      { observationVariableDbId: 'v-other', observationVariableName: 'plant height' },
      listedTwice,
    ]);

    const { result, structured } = await callContract(ctx, { text: 'dry matter content' });

    expect(result.isError).toBeFalsy();
    expect(structured.textMatchCount).toBe(2);
    expect(
      (structured.results as Record<string, unknown>[]).map((row) => [
        row.observationVariableDbId,
        row.textMatchRank,
      ]),
    ).toEqual([
      ['v-dup', 1],
      ['v-dup', 2],
      ['v-other', undefined],
    ]);
  });
});
