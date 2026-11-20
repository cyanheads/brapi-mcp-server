/**
 * @fileoverview Integration tests for source-aware collection, merge and partial results.
 * @module tests/tools/brapi-federated-find.tool.test
 */

import { tmpdir } from 'node:os';
import {
  CanvasRegistry,
  DataCanvas,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiFederatedFind } from '@/mcp-server/tools/definitions/brapi-federated-find.tool.js';
import { getCanvasBridge, initCanvasBridge } from '@/services/canvas-bridge/index.js';
import {
  envelope,
  initTestServices,
  jsonResponse,
  type MockFetcher,
  resetTestServices,
  TEST_CONFIG,
} from './_tool-test-helpers.js';

describe('brapi_federated_find', () => {
  let fetcher: MockFetcher;
  let nativeCanvas: DataCanvas | undefined;

  beforeEach(() => {
    fetcher = initTestServices();
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

  async function connect(...aliases: string[]) {
    fetcher.mockImplementation(async (url: string) =>
      new URL(url).pathname.endsWith('/serverinfo')
        ? jsonResponse(
            envelope({
              serverName:
                new URL(url).hostname === 'cassava.example.org' ? 'CassavaBase' : 'BrAPI Demo',
              calls: ['studies', 'germplasm', 'observations'].map((service) => ({
                service,
                methods: ['GET'],
                versions: ['2.1'],
              })),
            }),
          )
        : jsonResponse(envelope({ data: [] }, { totalCount: 0 })),
    );
    const ctx = createMockContext({ tenantId: 'federation' });
    for (const alias of aliases) {
      await brapiConnect.handler(
        brapiConnect.input.parse({
          alias,
          baseUrl: `https://${alias}.example.org/brapi/v2`,
        }),
        ctx,
      );
    }
    fetcher.mockReset();
    return ctx;
  }

  function call(
    ctx: Awaited<ReturnType<typeof connect>>,
    input: Record<string, unknown>,
    overrides?: Parameters<typeof createMockContext>[0],
  ) {
    const definition = {
      ...brapiFederatedFind,
      handler: (parsed, contractCtx) =>
        brapiFederatedFind.handler(parsed, { ...contractCtx, state: ctx.state }),
    } satisfies typeof brapiFederatedFind;
    return runToolContract(definition, input, {
      context: { tenantId: 'federation', ...overrides },
    });
  }

  it('merges exact PUIs, keeps ambiguous identities distinct, pages and stages one merged table', async () => {
    const ctx = await connect('east', 'west');
    const bySource = {
      east: [
        { germplasmDbId: '1', germplasmName: 'Same' },
        { germplasmDbId: '2', germplasmPUI: 'ambiguous' },
        { germplasmDbId: '3', germplasmPUI: 'ambiguous' },
        ...Array.from({ length: 7 }, (_, i) => ({
          germplasmDbId: `f${i}`,
          germplasmName: 'Other',
        })),
        { germplasmDbId: '12', germplasmPUI: 'urn:crop:pui', germplasmName: 'East ``` name' },
      ],
      west: [
        { germplasmDbId: '1', germplasmName: 'Same' },
        { germplasmDbId: '2', germplasmPUI: 'ambiguous' },
        { germplasmDbId: '3', germplasmPUI: 'URN:crop:pui' },
        { germplasmDbId: '11', germplasmPUI: 'urn:crop:pui', germplasmName: 'West name' },
      ],
    };
    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(url);
      const data = u.hostname === 'east.example.org' ? bySource.east : bySource.west;
      const pageSize = Number(u.searchParams.get('pageSize'));
      const page = Number(u.searchParams.get('page') ?? '0');
      return jsonResponse(
        envelope(
          {
            data: data.slice(page * pageSize, (page + 1) * pageSize),
          },
          { totalCount: data.length },
        ),
      );
    });
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
    const bridge = initCanvasBridge(nativeCanvas, TEST_CONFIG);
    const register = vi.spyOn(bridge, 'registerDataframe');
    const result = await call(ctx, {
      aliases: ['east', 'west', 'east', 'missing'],
      query: { entity: 'germplasm', filters: {} },
      loadLimit: 1,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      collectedCount: 15,
      mergedCount: 14,
      complete: false,
      results: [{ pui: null, sources: [{ alias: 'east', dbId: '1' }] }],
      coverage: [
        { alias: 'east', status: 'complete', matchedCount: 11, rowsScanned: 11 },
        { alias: 'west', status: 'complete', matchedCount: 4, rowsScanned: 4 },
        { alias: 'missing', status: 'failed', error: { reason: 'unknown_alias' } },
      ],
      dataframe: { rowCount: 14, truncated: true },
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining('"reason":"unknown_alias"'),
    });
    expect(register).toHaveBeenCalledTimes(1);
    const data = register.mock.calls[0]?.[1];
    expect(data?.query).toMatchObject({
      aliases: ['east', 'west', 'missing'],
      coverage: [expect.anything(), expect.anything(), { status: 'failed' }],
    });
    expect(data?.rows.filter((row) => row.pui === 'ambiguous')).toHaveLength(3);
    expect(
      data?.rows.filter((row) => row.pui === null && JSON.stringify(row).includes('"dbId":"1"')),
    ).toHaveLength(2);
    expect(data?.rows.find((row) => row.pui === 'urn:crop:pui')).toEqual({
      pui: 'urn:crop:pui',
      conflicts: ['germplasmName'],
      sources: [
        { alias: 'east', dbId: '12', record: bySource.east.at(-1) },
        { alias: 'west', dbId: '11', record: bySource.west.at(-1) },
      ],
    });
    const stagedTable = brapiFederatedFind.output.parse(result.structuredContent).dataframe
      ?.tableName;
    expect(stagedTable).toMatch(/^df_[A-Za-z0-9_]+$/);
    const canvas = await bridge.getInstance(ctx);
    const persisted = await canvas.query(
      `SELECT sources FROM "${stagedTable}" WHERE pui = 'urn:crop:pui'`,
    );
    expect(
      persisted.rows.map((row) =>
        typeof row.sources === 'string' ? JSON.parse(row.sources) : row.sources,
      ),
    ).toEqual([
      [
        { alias: 'east', dbId: '12', record: bySource.east.at(-1) },
        { alias: 'west', dbId: '11', record: bySource.west.at(-1) },
      ],
    ]);
  });

  it('counts rows examined before deduplicating overlapping GET branches', async () => {
    const ctx = await connect('cassava');
    fetcher.mockImplementation(async () =>
      jsonResponse(envelope({ data: [{ germplasmDbId: 'shared' }] }, { totalCount: 1 })),
    );
    const result = await call(ctx, {
      aliases: ['cassava'],
      query: { entity: 'germplasm', filters: { names: ['A', 'B'] } },
    });
    expect(result.structuredContent).toMatchObject({
      collectedCount: 1,
      coverage: [{ alias: 'cassava', status: 'complete', matchedCount: 1, rowsScanned: 2 }],
      results: [{ sources: [{ alias: 'cassava', dbId: 'shared' }] }],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('uses observation preflight and returns only the collected row from an incomplete source', async () => {
    const ctx = await connect('east', 'west');
    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(url);
      expect(u.pathname).toBe('/brapi/v2/observations');
      const data = u.hostname === 'east.example.org' ? [{ observationDbId: 'x', value: '4' }] : [];
      if (data.length) expect(u.searchParams.get('pageSize')).toBe('1');
      return jsonResponse(envelope({ data }, { totalCount: data.length ? 6_000 : 0 }));
    });
    const result = await call(ctx, {
      aliases: ['east', 'west'],
      query: { entity: 'observations', filters: {} },
    });
    expect(result.structuredContent).toMatchObject({
      complete: false,
      mergedCount: 1,
      coverage: [
        {
          alias: 'east',
          status: 'partial',
          matchedCount: 1,
          warnings: expect.arrayContaining([expect.stringContaining('Bulk pull skipped')]),
        },
        { alias: 'west', status: 'complete', matchedCount: 0 },
      ],
      results: [
        { sources: [{ alias: 'east', dbId: 'x', record: { observationDbId: 'x', value: '4' } }] },
      ],
    });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('Bulk pull skipped') });
  });

  it('validates nested finder filters and rejects inputs before dispatch', async () => {
    const ctx = await connect('east');
    const result = await call(ctx, {
      aliases: ['east'],
      query: { entity: 'studies', filters: { observations: ['o1'] } },
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: JsonRpcErrorCode.InvalidParams } },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns a complete empty collection and uses a fenced literal for arbitrary text', async () => {
    const ctx = await connect('east');
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));
    const args = { aliases: ['east'], query: { entity: 'studies', filters: {} } };
    expect((await call(ctx, args)).structuredContent).toMatchObject({
      complete: true,
      collectedCount: 0,
      mergedCount: 0,
      results: [],
    });
    const name = 'One ``` literal ````';
    fetcher.mockResolvedValue(
      jsonResponse(envelope({ data: [{ studyDbId: '1', studyName: name }] }, { totalCount: 1 })),
    );
    const result = await call(ctx, args);
    const block = result.content[0];
    expect(block?.type === 'text' && block.text).toMatch(/## Results\n\n`{5}json\n/);
    expect(result.structuredContent).toMatchObject({
      results: [{ sources: [{ alias: 'east', dbId: '1', record: { studyName: name } }] }],
    });
  });

  it('cancels the fan-out without dispatching queued sources', async () => {
    const ctx = await connect('east', 'west');
    vi.stubEnv('BRAPI_MAX_CONCURRENT_REQUESTS', '1');
    const controller = new AbortController();
    fetcher.mockImplementation(async () => {
      controller.abort();
      controller.signal.throwIfAborted();
    });
    const result = await call(
      ctx,
      { aliases: ['east', 'west'], query: { entity: 'studies', filters: {} } },
      { signal: controller.signal },
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: JsonRpcErrorCode.RequestCancelled } },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.content[0]).toMatchObject({ text: expect.stringMatching(/abort/i) });
  });

  it('marks undispatched aliases skipped when the shared deadline is exhausted', async () => {
    const ctx = await connect('east', 'west');
    const args = brapiFederatedFind.input.parse({
      aliases: ['east', 'west'],
      query: { entity: 'studies', filters: {} },
    });
    const result = await brapiFederatedFind.handler(args, {
      ...ctx,
      timestamp: new Date(Date.now() - 120_000).toISOString(),
    });
    expect(result).toMatchObject({
      complete: false,
      results: [],
      coverage: [
        { alias: 'east', status: 'skipped', error: { reason: 'call_deadline_exceeded' } },
        { alias: 'west', status: 'skipped', error: { reason: 'call_deadline_exceeded' } },
      ],
    });
    expect(brapiFederatedFind.format?.(result)[0]).toMatchObject({
      text: expect.stringContaining('call_deadline_exceeded'),
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('stages even the first row when its fenced rendering exceeds the inline budget', async () => {
    const ctx = await connect('east');
    const name = '"'.repeat(8_000);
    fetcher.mockResolvedValue(
      jsonResponse(
        envelope(
          {
            data: [{ studyDbId: '1', studyName: name }],
          },
          { totalCount: 1 },
        ),
      ),
    );
    const register = vi.spyOn(getCanvasBridge(), 'registerDataframe');
    const result = await call(ctx, {
      aliases: ['east'],
      query: { entity: 'studies', filters: {} },
    });
    expect(result.structuredContent).toMatchObject({
      mergedCount: 1,
      results: [],
      dataframe: { rowCount: 1 },
      shown: 0,
      truncated: true,
    });
    expect(
      result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n'),
    ).toContain('24,000-byte inline budget');
    expect(register.mock.calls[0]?.[1].rows).toMatchObject([
      { sources: [{ alias: 'east', dbId: '1', record: { studyName: name } }] },
    ]);
  });
});
