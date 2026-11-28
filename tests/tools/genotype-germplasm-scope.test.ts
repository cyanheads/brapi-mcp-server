/**
 * @fileoverview Genotype tools enforce germplasm scope before collecting calls.
 * @module tests/tools/genotype-germplasm-scope.test
 */
import type { Context } from '@cyanheads/mcp-ts-core';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiExportGenotypeMatrix } from '@/mcp-server/tools/definitions/brapi-export-genotype-matrix.tool.js';
import { brapiFindGenotypeCalls } from '@/mcp-server/tools/definitions/brapi-find-genotype-calls.tool.js';
import { breedbaseDialect } from '@/services/brapi-dialect/index.js';
import { registerDialect } from '@/services/brapi-dialect/registry.js';
import { getCanvasBridge } from '@/services/canvas-bridge/index.js';
import {
  BASE_URL,
  envelope,
  initTestServices,
  jsonResponse,
  resetTestServices,
} from './_tool-test-helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  resetTestServices();
});

const searchCalls = { service: 'search/calls', methods: ['POST'], versions: ['2.1'] };
const scopeRoutes = [
  { service: 'search/callsets', methods: ['POST'], versions: ['2.1'] },
  { service: 'search/samples', methods: ['POST'], versions: ['2.1'] },
  { service: 'search/samples/{searchResultsDbId}', methods: ['GET'], versions: ['2.1'] },
];
const getRoute = (service: string) => ({ service, methods: ['GET'], versions: ['2.1'] });

async function setup(routes = [searchCalls]) {
  const fetcher = initTestServices();
  fetcher.mockImplementation(async (url: string) =>
    new URL(url).pathname.endsWith('/serverinfo')
      ? jsonResponse(envelope({ serverName: 'Test', calls: routes }))
      : jsonResponse(envelope({ data: [] })),
  );
  const ctx = createMockContext({ tenantId: 't1', errors: brapiConnect.errors });
  await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
  fetcher.mockReset();
  return { ctx, fetcher };
}

function call(callSetDbId: string | null, variantDbId = 'v-1') {
  return { callSetDbId, variantDbId, variantSetDbId: 'vs-1', genotype: { values: ['A'] } };
}

type GenotypeArgs = Partial<
  Parameters<typeof brapiFindGenotypeCalls.handler>[0] &
    Parameters<typeof brapiExportGenotypeMatrix.handler>[0]
> & { germplasmDbId?: string[] };

async function run(
  ctx: Context,
  mode: 'find' | 'export',
  args: GenotypeArgs,
  signal?: AbortSignal,
) {
  const options = { context: { tenantId: 't1', ...(signal && { signal }) } };
  const result =
    mode === 'find'
      ? await runToolContract(
          {
            ...brapiFindGenotypeCalls,
            handler: (input, callCtx) =>
              brapiFindGenotypeCalls.handler(input, { ...callCtx, state: ctx.state }),
          } satisfies typeof brapiFindGenotypeCalls,
          args,
          options,
        )
      : await runToolContract(
          {
            ...brapiExportGenotypeMatrix,
            handler: (input, callCtx) =>
              brapiExportGenotypeMatrix.handler(input, { ...callCtx, state: ctx.state }),
          } satisfies typeof brapiExportGenotypeMatrix,
          { variantSetDbId: 'vs-1', format: 'matrix-json', ...args },
          options,
        );
  return {
    ...result,
    text: result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n'),
  };
}

it('keeps an explicitly scoped finder and export usable without membership routes', async () => {
  const { ctx, fetcher } = await setup();
  fetcher.mockImplementation(async () => jsonResponse(envelope({ data: [call('cs-1')] })));
  const found = await run(ctx, 'find', { callSetDbIds: ['cs-1'] });
  expect(found.structuredContent).toMatchObject({ results: [{ callSetDbId: 'cs-1' }] });
  expect(found.text).toContain('cs-1');
  const exported = await run(ctx, 'export', {});
  expect(exported.structuredContent).toMatchObject({
    rowCount: 1,
    warnings: [expect.stringContaining('does not advertise GET /callsets')],
  });
  expect(exported.text).toContain('does not advertise GET /callsets');
  expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
    '/brapi/v2/search/calls',
    '/brapi/v2/search/calls',
  ]);
});

it.each(['find', 'export'] as const)(
  'scopes %s before collecting calls and filters over-returned rows',
  async (mode) => {
    const { ctx, fetcher } = await setup([searchCalls, ...scopeRoutes]);
    const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
    const bodies: unknown[] = [];
    const lookupPages: string[] = [];
    fetcher.mockImplementation(
      async (url: string, _timeout: number, _context: unknown, init: RequestInit) => {
        const path = new URL(url);
        const body = init.body ? JSON.parse(String(init.body)) : {};
        if (path.pathname.endsWith('/search/calls')) {
          bodies.push(body);
          return jsonResponse(
            envelope({ data: [call('cs-1'), call('cs-2', 'v-2'), call('cs-3'), call(null)] }),
          );
        }
        if (path.pathname.endsWith('/search/samples')) {
          return jsonResponse(envelope({ searchResultsDbId: 'samples-job' }), 202);
        }
        if (path.pathname.endsWith('/search/samples/samples-job')) {
          const page = Number(path.searchParams.get('page'));
          lookupPages.push(`samples:${page}`);
          return jsonResponse({
            metadata: { pagination: { currentPage: page, totalPages: 2 } },
            result: {
              data: [
                { sampleDbId: `s-${page + 1}`, germplasmDbId: `g-${page + 1}` },
                { sampleDbId: `outside-${page}`, germplasmDbId: 'outside' },
              ],
            },
          });
        }
        if (path.pathname.endsWith('/search/callsets')) {
          if (body.germplasmDbIds) return jsonResponse({}, 500);
          expect(body.sampleDbIds).toEqual(['s-1', 's-2']);
          lookupPages.push(`callsets:${body.page}`);
          return jsonResponse({
            metadata: { pagination: { currentPage: body.page, totalPages: 2 } },
            result: [{ callSetDbId: `cs-${body.page + 1}`, sampleDbId: `s-${body.page + 1}` }],
          });
        }
        throw new Error(`Unexpected request to ${path.pathname}`);
      },
    );

    const args = { germplasmDbId: ['g-1', 'g-2'], variantDbIds: ['v-1', 'v-2'] };
    const result = await run(
      ctx,
      mode,
      mode === 'find' ? { ...args, callSetDbIds: ['cs-2', 'cs-3'] } : args,
    );
    expect(result.isError).toBeFalsy();
    expect(lookupPages).toEqual(['samples:0', 'samples:1', 'callsets:0', 'callsets:1']);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty('germplasmDbIds');
    expect(bodies[0]).toMatchObject({
      callSetDbIds: mode === 'find' ? ['cs-2'] : ['cs-1', 'cs-2'],
      variantDbIds: ['v-1', 'v-2'],
    });
    expect(result.structuredContent).toMatchObject({
      warnings: [expect.stringContaining('call-set filter')],
    });
    expect(result.text).toContain('call-set filter');
    if (mode === 'find') {
      expect(result.structuredContent).toMatchObject({
        totalCount: 1,
        results: [{ callSetDbId: 'cs-2' }],
        appliedFilters: { germplasmDbIds: ['g-1', 'g-2'], callSetDbIds: ['cs-2', 'cs-3'] },
      });
      expect(result.text).toContain('cs-2');
    } else {
      expect(result.structuredContent).toMatchObject({ rowCount: 2 });
      expect(register.mock.calls[0]?.[1].rows).toMatchObject([
        { callSetDbId: 'cs-1', germplasmDbId: 'g-1' },
        { callSetDbId: 'cs-2', germplasmDbId: 'g-2' },
      ]);
    }
  },
);

it('falls back from a failed direct POST to scoped GET with normalized Breedbase identities', async () => {
  const { ctx, fetcher } = await setup([searchCalls, scopeRoutes[0]!, getRoute('callsets')]);
  const dialectId = 'test-breedbase-with-callset-search';
  registerDialect({ ...breedbaseDialect, id: dialectId, disabledSearchEndpoints: new Set() });
  vi.stubEnv('BRAPI_DEFAULT_DIALECT', dialectId);
  fetcher.mockImplementation(async (url: string) => {
    const path = new URL(url);
    if (path.pathname.endsWith('/search/callsets')) return jsonResponse({}, 500);
    if (path.pathname.endsWith('/callsets')) {
      expect(path.searchParams.get('germplasmDbId')).toBe('g-1');
      return jsonResponse(
        envelope({
          data: [
            { callSetDbId: 'cs-1', additionalInfo: { germplasmDbId: 'g-1' } },
            { callSetDbId: 'cs-2', additionalInfo: { germplasmDbId: 'g-2' } },
          ],
        }),
      );
    }
    return jsonResponse(envelope({ data: [call('cs-1')] }));
  });
  const result = await run(ctx, 'find', { germplasmDbIds: ['g-1'] });
  expect(result.structuredContent).toMatchObject({ results: [{ callSetDbId: 'cs-1' }] });
  expect(result.text).toContain('cs-1');
  expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
    '/brapi/v2/search/callsets',
    '/brapi/v2/callsets',
    '/brapi/v2/search/calls',
  ]);
});

it('accepts one call set with the same identity across two scalar lookups', async () => {
  const { ctx, fetcher } = await setup([searchCalls, getRoute('callsets')]);
  fetcher.mockImplementation(async (url: string) =>
    new URL(url).pathname.endsWith('/callsets')
      ? jsonResponse(envelope({ data: [{ callSetDbId: 'cs-1', germplasmDbId: 'g-1' }] }))
      : jsonResponse(envelope({ data: [call('cs-1')] })),
  );
  const result = await run(ctx, 'find', { germplasmDbIds: ['g-1', 'g-2'] });
  expect(result.structuredContent).toMatchObject({
    results: [{ callSetDbId: 'cs-1' }],
    totalCount: 1,
  });
  expect(result.text).toContain('cs-1');
  expect(
    fetcher.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('germplasmDbId')),
  ).toEqual(['g-1', 'g-2', null]);
});

it.each([
  ['callsets', 'g-2', 'callSetDbId'],
  ['callsets', 'outside', 'callSetDbId'],
  ['samples', 'g-2', 'sampleDbId'],
  ['samples', 'outside', 'sampleDbId'],
] as const)(
  'rejects %s with conflicting second identity %s across scalar lookups',
  async (entity, second, idKey) => {
    const { ctx, fetcher } = await setup([searchCalls, getRoute('callsets'), getRoute(entity)]);
    fetcher.mockImplementation(async (url: string) => {
      const path = new URL(url);
      if (path.pathname.endsWith('/search/calls'))
        return jsonResponse(envelope({ data: [call('cs-1')] }));
      if (path.pathname.endsWith('/callsets') && entity === 'samples') {
        if (path.searchParams.has('germplasmDbId')) return jsonResponse({}, 500);
        return jsonResponse(envelope({ data: [{ callSetDbId: 'cs-1', sampleDbId: 'shared' }] }));
      }
      expect(path.pathname).toBe(`/brapi/v2/${entity}`);
      const germplasmDbId = path.searchParams.get('germplasmDbId') === 'g-1' ? 'g-1' : second;
      return jsonResponse(
        envelope({ data: [{ [idKey]: entity === 'callsets' ? 'cs-1' : 'shared', germplasmDbId }] }),
      );
    });

    const result = await run(ctx, 'find', { germplasmDbIds: ['g-1', 'g-2'] });
    const conflict = `conflicting germplasm identities for the same ${idKey}`;
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'germplasm_scope_unavailable',
          lookupFailures: expect.arrayContaining([expect.stringContaining(conflict)]),
        },
      },
    });
    expect(result.text).toContain(conflict);
    expect(result.text).toContain('Retry with explicit callSetDbIds');
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/search/calls'))).toBe(false);
  },
);

it('rejects a call set whose direct germplasm identity disagrees with its sample', async () => {
  const { ctx, fetcher } = await setup([searchCalls, ...scopeRoutes]);
  fetcher.mockImplementation(
    async (url: string, _timeout: number, _ctx: unknown, init: RequestInit) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(String(init.body));
      if (path.endsWith('/search/samples')) {
        return jsonResponse(envelope({ data: [{ sampleDbId: 's-1', germplasmDbId: 'g-1' }] }));
      }
      if (path.endsWith('/search/callsets')) {
        if (body.germplasmDbIds) return jsonResponse({}, 500);
        expect(body.sampleDbIds).toEqual(['s-1']);
        return jsonResponse(
          envelope({ data: [{ callSetDbId: 'cs-1', sampleDbId: 's-1', germplasmDbId: 'g-2' }] }),
        );
      }
      return jsonResponse(envelope({ data: [call('cs-1')] }));
    },
  );
  const result = await run(ctx, 'find', { germplasmDbIds: ['g-1', 'g-2'] });
  const detail = 'a call set disagrees with its sample on germplasm identity';
  expect(result.structuredContent).toMatchObject({
    error: {
      data: {
        reason: 'germplasm_scope_unavailable',
        lookupFailures: expect.arrayContaining([expect.stringContaining(detail)]),
      },
    },
  });
  expect(result.text).toContain(detail);
  expect(result.text).toContain('Retry with explicit callSetDbIds');
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/search/calls'))).toBe(false);
});

it('recovers through an independently consistent sample route after a direct identity conflict', async () => {
  const { ctx, fetcher } = await setup([searchCalls, getRoute('callsets'), getRoute('samples')]);
  fetcher.mockImplementation(async (url: string) => {
    const path = new URL(url);
    const germplasm = path.searchParams.get('germplasmDbId');
    if (path.pathname.endsWith('/search/calls'))
      return jsonResponse(envelope({ data: [call('recovered')] }));
    if (path.pathname.endsWith('/samples')) {
      return jsonResponse(
        envelope({
          data: germplasm === 'g-1' ? [{ sampleDbId: 's-1', germplasmDbId: 'g-1' }] : [],
        }),
      );
    }
    return jsonResponse(
      envelope({
        data: germplasm
          ? [{ callSetDbId: 'conflict', germplasmDbId: germplasm }]
          : [{ callSetDbId: 'recovered', sampleDbId: 's-1' }],
      }),
    );
  });
  const result = await run(ctx, 'find', { germplasmDbIds: ['g-1', 'g-2'] });
  expect(result.structuredContent).toMatchObject({
    results: [{ callSetDbId: 'recovered' }],
    warnings: [],
  });
  expect(result.text).toContain('recovered');
  expect(
    fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname.endsWith('/samples')),
  ).toContain(true);
});

it('completes a walk when a later page supplies a previously absent total', async () => {
  const { ctx, fetcher } = await setup([searchCalls, scopeRoutes[0]!]);
  fetcher.mockImplementation(
    async (url: string, _timeout: number, _ctx: unknown, init: RequestInit) => {
      if (String(url).endsWith('/search/calls'))
        return jsonResponse(envelope({ data: [call('cs-1')] }));
      const { page } = JSON.parse(String(init.body));
      return jsonResponse({
        metadata: {
          pagination: { currentPage: page, pageSize: 1, ...(page === 1 && { totalCount: 2 }) },
        },
        result: { data: [{ callSetDbId: `cs-${page}`, germplasmDbId: 'g-1' }] },
      });
    },
  );
  const result = await run(ctx, 'find', { germplasmDbIds: ['g-1'] });
  expect(result.structuredContent).toMatchObject({ results: [{ callSetDbId: 'cs-1' }] });
  expect(result.text).toContain('cs-1');
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it.each(['shrinking', 'missing bounds', 'changing page size'] as const)(
  'rejects an incomplete lookup with %s metadata',
  async (issue) => {
    const { ctx, fetcher } = await setup([searchCalls, scopeRoutes[0]!]);
    const pages: number[] = [];
    fetcher.mockImplementation(
      async (url: string, _timeout: number, _ctx: unknown, init: RequestInit) => {
        if (String(url).endsWith('/search/calls'))
          return jsonResponse(envelope({ data: [call('cs-1')] }));
        const { page } = JSON.parse(String(init.body));
        pages.push(page);
        const rows = page < 2 ? [{ callSetDbId: `cs-${page}`, germplasmDbId: 'g-1' }] : [];
        if (page === 0)
          return jsonResponse({
            metadata: { pagination: { currentPage: 0, pageSize: 1, totalCount: 4, totalPages: 4 } },
            result: { data: rows },
          });
        if (issue === 'missing bounds') return jsonResponse(envelope({ data: rows }));
        return jsonResponse({
          metadata: {
            pagination: {
              currentPage: page,
              pageSize: issue === 'changing page size' ? 2 : 1,
              totalCount: 2,
              totalPages: 2,
            },
          },
          result: { data: rows },
        });
      },
    );
    const result = await run(ctx, 'find', { germplasmDbIds: ['g-1'] });
    const detail =
      issue === 'shrinking'
        ? 'decreased its declared pagination bounds'
        : issue === 'changing page size'
          ? 'changed its effective page size'
          : 'returned an incomplete page walk';
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'germplasm_scope_unavailable',
          lookupFailures: expect.arrayContaining([expect.stringContaining(detail)]),
        },
      },
    });
    expect(result.text).toContain(detail);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/search/calls'))).toBe(false);
    expect(pages).toEqual(issue === 'missing bounds' ? [0, 1, 2] : [0, 1]);
  },
);

it('honors growing totals and keeps those bounds when later pages omit metadata', async () => {
  const { ctx, fetcher } = await setup([searchCalls, scopeRoutes[0]!]);
  const bodies: unknown[] = [];
  fetcher.mockImplementation(
    async (url: string, _timeout: number, _ctx: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (String(url).endsWith('/search/calls')) {
        bodies.push(body);
        return jsonResponse(envelope({ data: [call('cs-3')] }));
      }
      const { page } = body;
      const rows = [{ callSetDbId: `cs-${page}`, germplasmDbId: 'g-1' }];
      if (page >= 2) return jsonResponse(envelope({ data: rows }));
      const total = page === 0 ? 2 : 4;
      return jsonResponse({
        metadata: {
          pagination: { currentPage: page, pageSize: 1, totalCount: total, totalPages: total },
        },
        result: { data: rows },
      });
    },
  );
  const result = await run(ctx, 'find', { germplasmDbIds: ['g-1'] });
  expect(result.structuredContent).toMatchObject({
    results: [{ callSetDbId: 'cs-3' }],
    totalCount: 1,
  });
  expect(result.text).toContain('cs-3');
  expect(bodies).toEqual([
    expect.objectContaining({ callSetDbIds: ['cs-0', 'cs-1', 'cs-2', 'cs-3'] }),
  ]);
});

it('uses the effective response page size for async lookup results without totals', async () => {
  const { ctx, fetcher } = await setup([
    searchCalls,
    scopeRoutes[0]!,
    getRoute('search/callsets/{searchResultsDbId}'),
  ]);
  const pages: number[] = [];
  fetcher.mockImplementation(async (url: string) => {
    const path = new URL(url);
    if (path.pathname.endsWith('/search/callsets'))
      return jsonResponse(envelope({ searchResultsDbId: 'callsets-job' }), 202);
    if (path.pathname.endsWith('/search/callsets/callsets-job')) {
      const page = Number(path.searchParams.get('page'));
      pages.push(page);
      return jsonResponse({
        metadata: { pagination: { currentPage: page, pageSize: 1 } },
        result: {
          data:
            page === 0
              ? [{ callSetDbId: 'outside', germplasmDbId: 'g-other' }]
              : page === 1
                ? [{ callSetDbId: 'cs-1', germplasmDbId: 'g-1' }]
                : [],
        },
      });
    }
    return jsonResponse(envelope({ data: [call('cs-1')] }));
  });
  const result = await run(ctx, 'find', { germplasmDbIds: ['g-1'] });
  expect(result.structuredContent).toMatchObject({
    results: [{ callSetDbId: 'cs-1' }],
    totalCount: 1,
  });
  expect(result.text).toContain('cs-1');
  expect(pages).toEqual([0, 1, 2]);
});

it('falls back to GET when advertised sample and sample-scoped call-set searches fail', async () => {
  const { ctx, fetcher } = await setup([
    searchCalls,
    ...scopeRoutes,
    getRoute('samples'),
    getRoute('callsets'),
  ]);
  fetcher.mockImplementation(async (url: string) => {
    const path = new URL(url);
    if (path.pathname.endsWith('/search/samples') || path.pathname.endsWith('/search/callsets')) {
      return jsonResponse({}, 500);
    }
    if (path.pathname.endsWith('/samples')) {
      expect(path.searchParams.get('germplasmDbId')).toBe('g-1');
      return jsonResponse(envelope({ data: [{ sampleDbId: 's-1', germplasmDbId: 'g-1' }] }));
    }
    if (path.pathname.endsWith('/callsets')) {
      if (path.searchParams.has('germplasmDbId')) return jsonResponse({}, 500);
      expect(path.searchParams.get('variantSetDbId')).toBe('vs-1');
      return jsonResponse(
        envelope({
          data: [
            { callSetDbId: 'cs-1', sampleDbId: 's-1' },
            { callSetDbId: 'cs-2', sampleDbId: 's-2' },
          ],
        }),
      );
    }
    return jsonResponse(envelope({ data: [call('cs-1')] }));
  });
  const result = await run(ctx, 'export', { germplasmDbIds: ['g-1'] });
  expect(result.structuredContent).toMatchObject({ rowCount: 1, warnings: [] });
  expect(result.text).toContain('1 call set');
});

it.each(['find', 'export'] as const)(
  'returns the normal empty %s result without querying calls',
  async (mode) => {
    const { ctx, fetcher } = await setup([searchCalls, ...scopeRoutes]);
    fetcher.mockImplementation(async (url: string) => {
      if (new URL(url).pathname.endsWith('/search/callsets')) {
        return jsonResponse(envelope({ data: [{ callSetDbId: 'cs-1', germplasmDbId: 'g-1' }] }));
      }
      throw new Error('Unexpected request');
    });
    const result = await run(
      ctx,
      mode,
      mode === 'find'
        ? { germplasmDbIds: ['g-1'], callSetDbIds: ['cs-2'] }
        : { germplasmDbIds: ['g-2'] },
    );
    expect(result.structuredContent).toMatchObject(
      mode === 'find'
        ? { results: [], totalCount: 0, hasMore: false, truncated: false }
        : {
            rowCount: 0,
            columnCount: 0,
            truncated: false,
            dataframe: { columns: ['callSetDbId', 'callSetName', 'germplasmDbId'] },
          },
    );
    expect(result.text).toContain('No calls matched');
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

it.each([
  ['unavailable', 'does not advertise'],
  ['repeated', 'repeated a callSetDbId'],
  ['offset past end', 'incomplete page walk'],
  ['unresolved', 'lacks verifiable germplasm membership'],
  ['deadline', 'lookup deadline expired'],
] as const)('returns an actionable scope error for %s membership', async (failure, detail) => {
  const { ctx, fetcher } = await setup(
    failure === 'unavailable' ? [searchCalls] : [searchCalls, scopeRoutes[0]!],
  );
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  fetcher.mockImplementation(
    async (url: string, _timeout: number, _context: unknown, init: RequestInit) => {
      expect(new URL(url).pathname).toBe('/brapi/v2/search/callsets');
      const { page } = JSON.parse(String(init.body));
      if (failure === 'deadline') now += 9_000;
      return jsonResponse({
        metadata: { pagination: { currentPage: page, totalPages: 2, totalCount: 2 } },
        result: {
          data:
            page === 1 && failure === 'offset past end'
              ? []
              : [
                  {
                    callSetDbId: 'cs-1',
                    ...(failure !== 'unresolved' && { germplasmDbId: 'g-1' }),
                  },
                ],
        },
      });
    },
  );
  const result = await run(ctx, 'find', { germplasmDbIds: ['g-1'] });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: {
      data: {
        reason: 'germplasm_scope_unavailable',
        lookupFailures: expect.arrayContaining([expect.stringContaining(detail)]),
      },
    },
  });
  expect(result.text).toContain('germplasm_scope_unavailable');
  expect(result.text).toContain('Retry with explicit callSetDbIds');
  expect(result.text).toContain(detail);
  expect(fetcher.mock.calls.every(([url]) => !String(url).endsWith('/search/calls'))).toBe(true);
});

it('does not query calls or try a fallback when the caller cancels during membership paging', async () => {
  const { ctx, fetcher } = await setup([searchCalls, ...scopeRoutes, getRoute('callsets')]);
  const controller = new AbortController();
  fetcher.mockImplementation(
    async (url: string, _timeout: number, _context: unknown, init: RequestInit) => {
      expect(new URL(url).pathname).toBe('/brapi/v2/search/callsets');
      const { page } = JSON.parse(String(init.body));
      if (page === 1) controller.abort();
      return jsonResponse({
        metadata: { pagination: { currentPage: page, totalPages: 2 } },
        result: { data: [{ callSetDbId: `cs-${page}`, germplasmDbId: 'g-1' }] },
      });
    },
  );
  const result = await run(ctx, 'find', { germplasmDbIds: ['g-1'] }, controller.signal);
  expect(result.structuredContent).toMatchObject({
    error: { message: expect.stringContaining('cancelled') },
  });
  expect(result.text).toContain('cancelled');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('keeps the pull cap on raw upstream rows while dropping out-of-scope calls', async () => {
  vi.stubEnv('BRAPI_GENOTYPE_CALLS_MAX_PULL', '3');
  const { ctx, fetcher } = await setup([searchCalls, scopeRoutes[0]!]);
  fetcher.mockImplementation(async (url: string) =>
    new URL(url).pathname.endsWith('/search/callsets')
      ? jsonResponse(envelope({ data: [{ callSetDbId: 'cs-1', germplasmDbId: 'g-1' }] }))
      : jsonResponse(
          envelope({ data: [call('outside'), call('cs-1'), call(null), call('cs-1', 'v-2')] }),
        ),
  );
  const result = await run(ctx, 'find', { germplasmDbIds: ['g-1'] });
  expect(result.structuredContent).toMatchObject({
    results: [{ callSetDbId: 'cs-1', variantDbId: 'v-1' }],
    totalCount: 1,
    truncated: true,
    hasMore: true,
    warnings: [expect.stringContaining('3 calls'), expect.stringContaining('2 call(s)')],
  });
  expect(result.text).toContain('pull limit (3 calls)');
  expect(result.text).toContain('call-set filter to 2 call(s)');
});

it.each(['find', 'export'] as const)(
  'rejects blank germplasm for %s before requests',
  async (mode) => {
    const { ctx, fetcher } = await setup();
    const result = await run(ctx, mode, { germplasmDbIds: [' '] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('germplasmDbIds');
    expect(fetcher).not.toHaveBeenCalled();
  },
);
