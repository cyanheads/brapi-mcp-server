/**
 * @fileoverview End-to-end tests for `brapi_walk_pedigree` — BFS traversal,
 * cycle detection, capability gap warnings, dead-end accounting, depth cap.
 *
 * @module tests/tools/brapi-walk-pedigree.tool.test
 */

import { tmpdir } from 'node:os';
import { CanvasRegistry, DataCanvas, DuckdbProvider } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiDataframeQuery } from '@/mcp-server/tools/definitions/brapi-dataframe-query.tool.js';
import { brapiWalkPedigree } from '@/mcp-server/tools/definitions/brapi-walk-pedigree.tool.js';
import { getCanvasBridge, initCanvasBridge } from '@/services/canvas-bridge/index.js';
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

interface PedigreeEntry {
  germplasmDbId: string;
  germplasmName?: string;
  parentType?: string;
}

interface PedigreeFixture {
  pedigree?: Record<string, { germplasmName?: string; parents: PedigreeEntry[] }>;
  /** A /progeny result lists its entries under `progeny` or, on some servers, `data`. */
  progeny?: Record<
    string,
    { germplasmName?: string; progeny?: PedigreeEntry[]; data?: PedigreeEntry[] }
  >;
}

type MockContext = ReturnType<typeof createMockContext>;
type WalkOutput = Parameters<NonNullable<typeof brapiWalkPedigree.format>>[0];

const UPSTREAM_HOST = new URL(BASE_URL).hostname;
const PEDIGREE = 'germplasm/{germplasmDbId}/pedigree';
const PROGENY = 'germplasm/{germplasmDbId}/progeny';

/** `n` unparented parents of one germplasm: g-p-0 … g-p-(n-1). */
const fanOut = (n: number) => Array.from({ length: n }, (_, i) => ({ germplasmDbId: `g-p-${i}` }));

function walk(ctx: MockContext, input: Record<string, unknown>) {
  return brapiWalkPedigree.handler(brapiWalkPedigree.input.parse(input), ctx);
}

/** The tool bound to `ctx`'s state, so a contract run sees the connection `connect` saved. */
function bound(ctx: MockContext) {
  return {
    ...brapiWalkPedigree,
    handler: (input, contractCtx) =>
      brapiWalkPedigree.handler(input, { ...contractCtx, state: ctx.state }),
  } satisfies typeof brapiWalkPedigree;
}

/**
 * Serve `/germplasm/{id}/pedigree` and `/progeny` from a fixture and record
 * every call as `pedigree:<id>` / `progeny:<id>`. Any other host or path
 * fails the test.
 */
function serveFixture(fetcher: MockFetcher, fixture: PedigreeFixture): string[] {
  const calls: string[] = [];
  fetcher.mockImplementation(async (url: string) => {
    const parsed = new URL(String(url));
    if (parsed.hostname !== UPSTREAM_HOST) throw new Error(`Unmocked host: ${parsed.hostname}`);
    const m = parsed.pathname.match(/\/germplasm\/([^/]+)\/(pedigree|progeny)$/);
    if (!m) throw new Error(`Unexpected path: ${parsed.pathname}`);
    const id = decodeURIComponent(m[1]!);
    calls.push(`${m[2]}:${id}`);
    if (m[2] === 'pedigree') {
      return jsonResponse(envelope(fixture.pedigree?.[id] ?? { parents: [] }));
    }
    return jsonResponse(envelope(fixture.progeny?.[id] ?? { progeny: [] }));
  });
  return calls;
}

function textOf(result: WalkOutput): string {
  return (brapiWalkPedigree.format!(result)[0] as { text: string }).text;
}

/** Connect a server advertising `services` (default: /germplasm and /pedigree) plus `extras`. */
async function connect(
  fetcher: MockFetcher,
  extras: string[] = [],
  services: string[] = ['germplasm', PEDIGREE],
) {
  const calls = [...services, ...extras].map((service) => ({
    service,
    methods: ['GET'],
    versions: ['2.1'],
  }));
  fetcher.mockImplementation(async (url: string) => {
    const path = pathnameOf(url);
    if (path.endsWith('/serverinfo')) {
      return jsonResponse(envelope({ serverName: 'Test', calls }));
    }
    if (path.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: [] }));
    return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
  });
  const ctx = createMockContext({ tenantId: 't1' });
  await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
  fetcher.mockReset();
  return ctx;
}

describe('brapi_walk_pedigree tool', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('characterizes a depth-boundary terminal without expanding beyond the requested side', async () => {
    const ctx = await connect(fetcher, [PROGENY]);
    const calls = serveFixture(fetcher, {
      progeny: {
        R: { progeny: [{ germplasmDbId: 'C' }] },
        C: { progeny: [{ germplasmDbId: 'G' }] },
      },
    });
    const result = await walk(ctx, {
      germplasmDbIds: ['R'],
      direction: 'descendants',
      maxDepth: 1,
    });
    expect(result.leafCount).toBe(1);
    expect(result.deadEndCount).toBe(0);
    expect(calls).toEqual(['pedigree:R', 'progeny:R']);
  });

  it('bounds wide node and edge previews independently and retains a discovered-graph diagram', async () => {
    const ctx = await connect(fetcher);
    serveFixture(fetcher, {
      pedigree: {
        R: {
          parents: [
            { germplasmDbId: 'P', germplasmName: 'é'.repeat(13000), parentType: 'é'.repeat(13000) },
          ],
        },
      },
    });
    const result = await walk(ctx, {
      germplasmDbIds: ['R'],
      maxDepth: 1,
      loadLimit: 10,
      diagram: 'dot',
    });
    expect(Buffer.byteLength(JSON.stringify(result.nodes))).toBeLessThanOrEqual(24000);
    expect(Buffer.byteLength(JSON.stringify(result.edges))).toBeLessThanOrEqual(24000);
    expect(result.nodesDataframe?.rowCount).toBe(2);
    expect(result.edgesDataframe?.rowCount).toBe(1);
    expect(result.edges).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it.each(['ancestors', 'descendants', 'both'] as const)(
    'retains known omissions and safety frontier for %s',
    async (direction) => {
      const ctx = await connect(fetcher, [PROGENY]);
      serveFixture(fetcher, {
        pedigree: { R: { parents: fanOut(1500) } },
        progeny: { R: { progeny: fanOut(1500) } },
      });
      const wire = await runToolContract(
        bound(ctx),
        { germplasmDbIds: ['R'], direction, maxDepth: 2, loadLimit: 10 },
        { context: { tenantId: 't1' } },
      );
      const result = wire.structuredContent as WalkOutput;
      expect(wire.isError).not.toBe(true);
      expect(result.leafCount).toBe(999);
      expect(result).toMatchObject({
        confirmedLeafCount: 0,
        knownOmittedRelativeCount: direction === 'both' ? 2001 : 501,
      });
      expect(result.nodesDataframe?.truncated).toBe(true);
      expect(result.edgesDataframe?.truncated).toBe(true);
      expect(result).toHaveProperty('omittedRelativesDataframe');
      expect(JSON.stringify(wire.content)).toContain('ORDER BY ordinal');
      expect(JSON.stringify(wire.content)).toContain('OFFSET 0');
    },
  );

  it('retrieves every fetched omission in ordered real-DuckDB slices including past-end', async () => {
    const ctx = await connect(fetcher, [PROGENY]);
    const provider = new DuckdbProvider({
      exportRootPath: tmpdir(),
      tempRootPath: tmpdir(),
      memoryLimitMb: 256,
      defaultRowLimit: 10000,
      schemaSniffRows: 100,
    });
    const registry = new CanvasRegistry(provider, {
      absoluteCapMs: 600000,
      maxCanvasesPerTenant: 10,
      sweeperIntervalMs: 0,
      ttlMs: 600000,
    });
    const canvas = new DataCanvas(provider, registry);
    initCanvasBridge(canvas, TEST_CONFIG);
    try {
      serveFixture(fetcher, { progeny: { R: { progeny: fanOut(1024) } } });
      const result = await walk(ctx, {
        germplasmDbIds: ['R'],
        direction: 'descendants',
        maxDepth: 2,
        loadLimit: 10,
      });
      expect(result.knownOmittedRelativeCount).toBe(25);
      const table = result.omittedRelativesDataframe!.tableName;
      const seen: string[] = [];
      for (const offset of [0, 10, 20, 25]) {
        const query = await brapiDataframeQuery.handler(
          brapiDataframeQuery.input.parse({
            sql: `SELECT germplasmDbId, expansionNodeDbId, side FROM ${table} ORDER BY ordinal LIMIT 10 OFFSET ${offset}`,
          }),
          ctx,
        );
        expect(query.rows).toHaveLength(offset < 20 ? 10 : offset === 20 ? 5 : 0);
        expect(
          query.rows.every((row) => row.side === 'descendant' && row.expansionNodeDbId === 'R'),
        ).toBe(true);
        seen.push(...query.rows.map((row) => String(row.germplasmDbId)));
      }
      expect(seen).toEqual(
        fanOut(1024)
          .slice(999)
          .map((row) => row.germplasmDbId),
      );
      const described = await getCanvasBridge().describe(ctx, {
        tableName: result.nodesDataframe!.tableName,
      });
      expect(described[0]?.provenance?.query).toMatchObject({
        coverage: 'partial_discovered_graph',
      });
    } finally {
      await canvas.shutdown();
    }
  });

  it('distinguishes confirmed leaves, depth frontiers and a failed side without dropping its successful sibling', async () => {
    const ctx = await connect(fetcher, [PROGENY]);
    const calls = serveFixture(fetcher, {
      pedigree: { R: { parents: [{ germplasmDbId: 'P' }] } },
      progeny: {
        R: { progeny: [{ germplasmDbId: 'C' }] },
        C: { progeny: [{ germplasmDbId: 'G' }] },
      },
    });
    const depth = await walk(ctx, { germplasmDbIds: ['R'], direction: 'both', maxDepth: 2 });
    expect(depth.confirmedLeafCount).toBe(1);
    expect(depth.frontier).toEqual([
      { germplasmDbId: 'G', side: 'descendant', outcome: 'depth_limited' },
    ]);
    expect(calls).not.toContain('progeny:P');
    expect(calls).not.toContain('pedigree:C');
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/pedigree')) throw new Error('lookup failed');
      return jsonResponse(
        envelope({ progeny: path.includes('/R/') ? [{ germplasmDbId: 'C' }] : [] }),
      );
    });
    const failed = await walk(ctx, { germplasmDbIds: ['R'], direction: 'both', maxDepth: 2 });
    expect(failed.deadEndCount).toBe(1);
    expect(failed.confirmedLeafCount).toBe(1);
    expect(failed.edges).toEqual([{ from: 'C', to: 'R', relationship: 'child' }]);
    expect(failed.frontier).toMatchObject([
      { germplasmDbId: 'R', side: 'ancestor', outcome: 'failed' },
    ]);
    expect(textOf(failed)).toContain('ancestor · failed');
  });

  it('retains already-fetched omissions from every root after an interrupted expansion', async () => {
    const ctx = await connect(fetcher, [PROGENY]);
    serveFixture(fetcher, {
      progeny: { A: { progeny: fanOut(1500) }, B: { progeny: [{ germplasmDbId: 'only-B' }] } },
    });
    const result = await walk(ctx, {
      germplasmDbIds: ['A', 'B'],
      direction: 'descendants',
      maxDepth: 1,
      loadLimit: 2000,
    });
    expect(result.knownOmittedRelativeCount).toBe(503);
    expect(
      result.frontier.filter((row) => row.knownOmittedRelativeCount !== undefined),
    ).toMatchObject([
      {
        germplasmDbId: 'A',
        side: 'descendant',
        outcome: 'safety_skipped',
        knownOmittedRelativeCount: 502,
      },
      {
        germplasmDbId: 'B',
        side: 'descendant',
        outcome: 'safety_skipped',
        knownOmittedRelativeCount: 1,
      },
    ]);
  });

  it('deduplicates repeated relatives at the safety boundary and preserves depth-limited frontier', async () => {
    const ctx = await connect(fetcher);
    serveFixture(fetcher, {
      pedigree: {
        R: {
          parents: [
            ...fanOut(999),
            { germplasmDbId: 'g-p-998' },
            { germplasmDbId: 'omitted' },
            { germplasmDbId: 'omitted' },
          ],
        },
      },
    });
    const result = await walk(ctx, { germplasmDbIds: ['R'], maxDepth: 1, loadLimit: 2000 });
    expect(result.knownOmittedRelativeCount).toBe(1);
    expect(result.omittedRelativesDataframe?.rowCount).toBe(1);
    expect(result.frontier.find((entry) => entry.germplasmDbId === 'R')).toMatchObject({
      outcome: 'safety_skipped',
      knownOmittedRelativeCount: 1,
    });
    expect(
      result.frontier
        .filter((entry) => entry.germplasmDbId !== 'R')
        .every((entry) => entry.outcome === 'depth_limited'),
    ).toBe(true);
    expect(result.frontierCount).toBe(1000);
  });

  it('returns zero oversized-first-node rows while preserving the staged root', async () => {
    const ctx = await connect(fetcher);
    serveFixture(fetcher, { pedigree: { R: { germplasmName: 'é'.repeat(13000), parents: [] } } });
    const result = await walk(ctx, { germplasmDbIds: ['R'], loadLimit: 10 });
    expect(result.nodes).toEqual([]);
    expect(result.nodesDataframe?.rowCount).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.frontier).toEqual([]);
    expect(result.confirmedLeafCount).toBe(0);
    expect(textOf(result)).toContain('## Nodes dataframe');
  });

  it('measures the actual serialized node and edge row renderers within the byte budget', async () => {
    const ctx = await connect(fetcher);
    serveFixture(fetcher, {
      pedigree: {
        R: {
          parents: fanOut(200).map((relative) => ({
            ...relative,
            germplasmName: 'é\\"'.repeat(100),
            parentType: 'é\\"'.repeat(100),
          })),
        },
      },
    });
    const result = await walk(ctx, { germplasmDbIds: ['R'], maxDepth: 1, loadLimit: 1000 });
    const text = textOf(result);
    const lines = text.split('\n');
    const nodeRows = lines.filter((line) => line.startsWith('- **')).join('\n');
    const edgeRows = lines.filter((line) => line.includes(' · parent')).join('\n');
    for (const section of [result.nodes, result.edges, nodeRows, edgeRows])
      expect(Buffer.byteLength(JSON.stringify(section))).toBeLessThanOrEqual(24000);
    expect(result.nodesDataframe?.rowCount).toBe(201);
    expect(result.edgesDataframe?.rowCount).toBe(200);
    expect(result.nodes.length).toBeLessThan(201);
    expect(result.edges.length).toBeLessThan(200);
  });

  it('walks ancestors BFS, counting only unparented ancestors as leaves', async () => {
    const ctx = await connect(fetcher);
    // g-1 → parents [g-2, g-3]; g-2 → parents [g-4]; g-3 and g-4 have none.
    serveFixture(fetcher, {
      pedigree: {
        'g-1': {
          parents: [
            { germplasmDbId: 'g-2', germplasmName: 'P1', parentType: 'FEMALE' },
            { germplasmDbId: 'g-3', germplasmName: 'P2', parentType: 'MALE' },
          ],
        },
        'g-2': { parents: [{ germplasmDbId: 'g-4', germplasmName: 'GP1', parentType: 'FEMALE' }] },
      },
    });

    const result = await walk(ctx, {
      germplasmDbIds: ['g-1'],
      direction: 'ancestors',
      maxDepth: 3,
    });

    expect(result.rootCount).toBe(1);
    expect(result.nodes.map((n) => n.germplasmDbId).sort()).toEqual(['g-1', 'g-2', 'g-3', 'g-4']);
    expect(result.edges).toHaveLength(3); // g-2→g-1, g-3→g-1, g-4→g-2
    expect(result.depthReached).toBe(2);
    expect(result.cycleCount).toBe(0);
    expect(result.deadEndCount).toBe(0);
    // Ancestor leaves are unparented ancestors (g-3, g-4) — not the root and
    // not nodes that have further ancestors recorded (g-2 has g-4 above it).
    expect(result.leafCount).toBe(2);
  });

  it('detects cycles when an ancestor reappears', async () => {
    const ctx = await connect(fetcher);
    serveFixture(fetcher, {
      pedigree: {
        'g-1': { parents: [{ germplasmDbId: 'g-2' }] },
        'g-2': { parents: [{ germplasmDbId: 'g-1' }] }, // cycle back to g-1
      },
    });

    const result = await walk(ctx, {
      germplasmDbIds: ['g-1'],
      direction: 'ancestors',
      maxDepth: 4,
    });

    // One loop-closing edge: g-1 → g-2, found while expanding g-2.
    expect(result.cycleCount).toBe(1);
    expect(result.edges).toEqual([
      { from: 'g-2', to: 'g-1', relationship: 'parent' },
      { from: 'g-1', to: 'g-2', relationship: 'parent', isCycle: true },
    ]);
    const parsed = brapiWalkPedigree.output.parse(result);
    expect(parsed.edges[1]?.isCycle).toBe(true);
    expect(textOf(parsed)).toContain('`g-1` → `g-2` · parent · isCycle');
  });

  it('marks only the loop-closing edge of a longer loop and never re-walks it', async () => {
    const ctx = await connect(fetcher);
    // g-1 ← g-2 ← g-3 ← g-1: g-1 becomes its own great-grandparent.
    const calls = serveFixture(fetcher, {
      pedigree: {
        'g-1': { parents: [{ germplasmDbId: 'g-2' }] },
        'g-2': { parents: [{ germplasmDbId: 'g-3' }] },
        'g-3': { parents: [{ germplasmDbId: 'g-1' }] },
      },
    });

    const result = await walk(ctx, {
      germplasmDbIds: ['g-1'],
      direction: 'ancestors',
      maxDepth: 8,
    });

    expect(result.nodes).toHaveLength(3);
    expect(result.edges).toHaveLength(3);
    expect(result.cycleCount).toBe(1);
    expect(result.edges.filter((e) => e.isCycle)).toEqual([
      { from: 'g-1', to: 'g-3', relationship: 'parent', isCycle: true },
    ]);
    // Every node's /pedigree is read once — the loop is not walked again.
    expect(calls.filter((c) => c === 'pedigree:g-1')).toHaveLength(1);
    expect(calls.filter((c) => c === 'pedigree:g-2')).toHaveLength(1);
    expect(calls.filter((c) => c === 'pedigree:g-3')).toHaveLength(1);
    expect(result.depthReached).toBe(3);
  });

  it('marks a germplasm listed as its own parent as a cycle', async () => {
    const ctx = await connect(fetcher);
    serveFixture(fetcher, {
      pedigree: { 'g-1': { parents: [{ germplasmDbId: 'g-1', parentType: 'SELF' }] } },
    });

    const result = await walk(ctx, { germplasmDbIds: ['g-1'], direction: 'ancestors' });

    expect(result.cycleCount).toBe(1);
    expect(result.edges).toEqual([
      { from: 'g-1', to: 'g-1', relationship: 'parent', parentType: 'SELF', isCycle: true },
    ]);
    expect(result.nodes).toHaveLength(1);
  });

  it('records dead ends when a pedigree fetch fails', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/germplasm/g-1/pedigree')) {
        return new Response('', { status: 500 });
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const result = await walk(ctx, { germplasmDbIds: ['g-1'], direction: 'ancestors' });
    expect(result.deadEndCount).toBe(1);
  });

  it('warns when descendants direction is requested but /progeny is unavailable', async () => {
    const ctx = await connect(fetcher);
    serveFixture(fetcher, {});

    const result = await walk(ctx, { germplasmDbIds: ['g-1'], direction: 'both' });
    expect(result.warnings.join('\n')).toContain('/germplasm/{id}/progeny');
  });

  it('tags nodes with their direction relative to the root', async () => {
    const ctx = await connect(fetcher, [PROGENY]);
    // g-1's parent is g-2; g-1's child is g-3, listed under `data`.
    serveFixture(fetcher, {
      pedigree: { 'g-1': { parents: [{ germplasmDbId: 'g-2' }] } },
      progeny: { 'g-1': { data: [{ germplasmDbId: 'g-3' }] } },
    });

    const result = await walk(ctx, { germplasmDbIds: ['g-1'], direction: 'both', maxDepth: 2 });

    const byId = new Map(result.nodes.map((n) => [n.germplasmDbId, n] as const));
    expect(byId.get('g-1')?.direction).toBe('root');
    expect(byId.get('g-2')?.direction).toBe('ancestor');
    expect(byId.get('g-3')?.direction).toBe('descendant');
  });

  it('tags a node as `both` when it appears as ancestor and descendant', async () => {
    const ctx = await connect(fetcher, [PROGENY]);
    // g-2 is BOTH a parent and a child of g-1 — describes a degenerate
    // backcross/selfing scenario, but the node-tagging contract must handle it.
    serveFixture(fetcher, {
      pedigree: { 'g-1': { parents: [{ germplasmDbId: 'g-2' }] } },
      progeny: { 'g-1': { progeny: [{ germplasmDbId: 'g-2' }] } },
    });

    const result = await walk(ctx, { germplasmDbIds: ['g-1'], direction: 'both', maxDepth: 2 });

    const g2 = result.nodes.find((n) => n.germplasmDbId === 'g-2');
    expect(g2?.direction).toBe('both');
    // g-2 is a parent and a child of g-1 — a real two-node loop. The second
    // pair found closes it.
    expect(result.cycleCount).toBe(1);
    expect(result.edges).toEqual([
      { from: 'g-2', to: 'g-1', relationship: 'parent' },
      { from: 'g-2', to: 'g-1', relationship: 'child', isCycle: true },
    ]);
  });

  it('walks ancestor-side nodes upward only when direction=both', async () => {
    const ctx = await connect(fetcher, [PROGENY]);
    // g-1 and g-2 are the parents of g-3. Walking from g-3 in direction=both,
    // g-1 and g-2 are ancestors, so only their /pedigree is read — their
    // progeny (g-3 again) is never fetched, and each pair is one edge.
    const calls = serveFixture(fetcher, {
      pedigree: { 'g-3': { parents: [{ germplasmDbId: 'g-1' }, { germplasmDbId: 'g-2' }] } },
      progeny: {
        'g-1': { progeny: [{ germplasmDbId: 'g-3' }] },
        'g-2': { progeny: [{ germplasmDbId: 'g-3' }] },
      },
    });

    const result = await walk(ctx, { germplasmDbIds: ['g-3'], direction: 'both', maxDepth: 3 });

    expect(result.cycleCount).toBe(0);
    expect(result.edges).toEqual([
      { from: 'g-1', to: 'g-3', relationship: 'parent' },
      { from: 'g-2', to: 'g-3', relationship: 'parent' },
    ]);
    expect(calls).not.toContain('progeny:g-1');
    expect(calls).not.toContain('progeny:g-2');
    expect(calls).toContain('pedigree:g-1');
    expect(calls).toContain('pedigree:g-2');
  });

  it('direction=both is the union of the ancestor and descendant walks', async () => {
    const ctx = await connect(fetcher, [PROGENY]);
    // R has parents P1 × P2 and progeny C1–C3, all crossed with co-parent CO.
    // A sideways walk would reach CO (and its parent GCO) through the progeny,
    // and P1's other child SIB through P1's progeny.
    const crossed = (id: string) => ({
      parents: [
        { germplasmDbId: 'R', parentType: 'FEMALE' },
        { germplasmDbId: 'CO', parentType: 'MALE' },
      ],
      germplasmName: id,
    });
    const calls = serveFixture(fetcher, {
      pedigree: {
        R: {
          germplasmName: 'Root accession',
          parents: [
            { germplasmDbId: 'P1', germplasmName: 'Mother', parentType: 'FEMALE' },
            { germplasmDbId: 'P2', germplasmName: 'Father', parentType: 'MALE' },
          ],
        },
        C1: crossed('C1'),
        C2: crossed('C2'),
        C3: crossed('C3'),
        CO: { parents: [{ germplasmDbId: 'GCO' }] },
      },
      progeny: {
        R: {
          germplasmName: 'Root accession',
          progeny: ['C1', 'C2', 'C3'].map((id) => ({
            germplasmDbId: id,
            germplasmName: `cross ${id}`,
            parentType: 'FEMALE',
          })),
        },
        P1: { progeny: [{ germplasmDbId: 'R' }, { germplasmDbId: 'SIB' }] },
      },
    });

    const result = await walk(ctx, { germplasmDbIds: ['R'], direction: 'both', maxDepth: 3 });

    expect(result.nodes.map((n) => n.germplasmDbId).sort()).toEqual([
      'C1',
      'C2',
      'C3',
      'P1',
      'P2',
      'R',
    ]);
    expect(result.edges).toEqual([
      { from: 'P1', to: 'R', relationship: 'parent', parentType: 'FEMALE' },
      { from: 'P2', to: 'R', relationship: 'parent', parentType: 'MALE' },
      { from: 'C1', to: 'R', relationship: 'child', parentType: 'FEMALE' },
      { from: 'C2', to: 'R', relationship: 'child', parentType: 'FEMALE' },
      { from: 'C3', to: 'R', relationship: 'child', parentType: 'FEMALE' },
    ]);
    expect(result.cycleCount).toBe(0);
    // P1, P2 have no parents; C1–C3 have no progeny.
    expect(result.leafCount).toBe(5);
    expect(result.nodes.some((n) => n.direction === 'both')).toBe(false);
    // Ancestors read only /pedigree, descendants only /progeny, the root both —
    // and the root's /pedigree once, shared by the root check and depth 1.
    expect(calls.filter((c) => c === 'pedigree:R')).toHaveLength(1);
    expect(calls.filter((c) => c === 'progeny:R')).toHaveLength(1);
    expect(calls.filter((c) => /^progeny:P/.test(c))).toEqual([]);
    expect(calls.filter((c) => /^pedigree:C/.test(c))).toEqual([]);
    expect(calls.filter((c) => /^progeny:C/.test(c)).sort()).toEqual([
      'progeny:C1',
      'progeny:C2',
      'progeny:C3',
    ]);
    // The root's name comes from its own lookup.
    const root = result.nodes.find((n) => n.germplasmDbId === 'R');
    expect(root).toMatchObject({
      isRoot: true,
      direction: 'root',
      germplasmName: 'Root accession',
    });

    const parsed = brapiWalkPedigree.output.parse(result);
    const text = textOf(parsed);
    expect(text).toContain('**Root accession**');
    expect(text).toContain('`C1` ← `R` · child (FEMALE)');
    expect(text).toContain('- cycleCount: 0');
  });

  it('names a root from its /progeny response when its /pedigree carries no name', async () => {
    const ctx = await connect(fetcher, [PROGENY]);
    const calls = serveFixture(fetcher, {
      progeny: { R: { germplasmName: 'Root from progeny', progeny: [{ germplasmDbId: 'C1' }] } },
    });

    const result = await walk(ctx, { germplasmDbIds: ['R'], direction: 'descendants' });

    expect(result.nodes.find((n) => n.isRoot)?.germplasmName).toBe('Root from progeny');
    // The root check reads /pedigree once; no request is added for the name.
    expect(calls.sort()).toEqual(['pedigree:R', 'progeny:C1', 'progeny:R']);
  });

  it('pins single-root descendants output (child edges point child → parent)', async () => {
    const ctx = await connect(fetcher, [PROGENY]);
    serveFixture(fetcher, {
      progeny: {
        R: { progeny: [{ germplasmDbId: 'C1' }, { germplasmDbId: 'C2' }] },
        C1: { progeny: [{ germplasmDbId: 'GC1' }] },
      },
    });

    const result = await walk(ctx, { germplasmDbIds: ['R'], direction: 'descendants' });

    expect(result.nodes.map((n) => [n.germplasmDbId, n.depth, n.direction])).toEqual([
      ['R', 0, 'root'],
      ['C1', 1, 'descendant'],
      ['C2', 1, 'descendant'],
      ['GC1', 2, 'descendant'],
    ]);
    expect(result.edges).toEqual([
      { from: 'C1', to: 'R', relationship: 'child' },
      { from: 'C2', to: 'R', relationship: 'child' },
      { from: 'GC1', to: 'C1', relationship: 'child' },
    ]);
    expect(result.cycleCount).toBe(0);
    expect(result.leafCount).toBe(2);
    expect(result.depthReached).toBe(2);
  });

  it('counts no cycle when full siblings share parents and grandparents', async () => {
    const ctx = await connect(fetcher);
    // S1 and S2 are full siblings (M × F). M's parents A and B share the
    // grandparent G, which is reached twice at depth 3 and walked once.
    const calls = serveFixture(fetcher, {
      pedigree: {
        S1: { parents: [{ germplasmDbId: 'M' }, { germplasmDbId: 'F' }] },
        S2: { parents: [{ germplasmDbId: 'M' }, { germplasmDbId: 'F' }] },
        M: { parents: [{ germplasmDbId: 'A' }, { germplasmDbId: 'B' }] },
        A: { parents: [{ germplasmDbId: 'G' }] },
        B: { parents: [{ germplasmDbId: 'G' }] },
        G: { parents: [{ germplasmDbId: 'H' }] },
      },
    });

    const result = await walk(ctx, {
      germplasmDbIds: ['S1', 'S2'],
      direction: 'ancestors',
      maxDepth: 5,
    });

    expect(result.cycleCount).toBe(0);
    expect(result.nodes.map((n) => n.germplasmDbId).sort()).toEqual([
      'A',
      'B',
      'F',
      'G',
      'H',
      'M',
      'S1',
      'S2',
    ]);
    // S1←M, S1←F, S2←M, S2←F, M←A, M←B, A←G, B←G, G←H
    expect(result.edges).toHaveLength(9);
    expect(result.edges.some((e) => e.isCycle)).toBe(false);
    expect(calls.filter((c) => c === 'pedigree:G')).toHaveLength(1);
    expect(result.nodes.find((n) => n.germplasmDbId === 'H')?.depth).toBe(4);
  });

  it.each<{
    name: string;
    roots: string[];
    direction: 'ancestors' | 'descendants' | 'both';
    maxDepth?: number;
    fixture: PedigreeFixture;
    edges: unknown[];
    directions: Record<string, string>;
  }>([
    {
      name: 'two roots share progeny',
      roots: ['A', 'B'],
      direction: 'descendants',
      fixture: {
        progeny: {
          A: { progeny: [{ germplasmDbId: 'C1' }, { germplasmDbId: 'C2' }] },
          B: { progeny: [{ germplasmDbId: 'C1' }, { germplasmDbId: 'C2' }] },
        },
      },
      edges: [
        { from: 'C1', to: 'A', relationship: 'child' },
        { from: 'C2', to: 'A', relationship: 'child' },
        { from: 'C1', to: 'B', relationship: 'child' },
        { from: 'C2', to: 'B', relationship: 'child' },
      ],
      directions: { A: 'root', B: 'root', C1: 'descendant', C2: 'descendant' },
    },
    {
      name: 'one root is an ancestor of another',
      roots: ['R1', 'R2'],
      direction: 'ancestors',
      fixture: {
        pedigree: { R2: { parents: [{ germplasmDbId: 'R1' }, { germplasmDbId: 'X' }] } },
      },
      edges: [
        { from: 'R1', to: 'R2', relationship: 'parent' },
        { from: 'X', to: 'R2', relationship: 'parent' },
      ],
      directions: { R1: 'root', R2: 'root', X: 'ancestor' },
    },
    {
      // R1's /progeny and R2's /pedigree both report the pair; it is listed once, as parent.
      name: 'a pair is found from both sides',
      roots: ['R1', 'R2'],
      direction: 'both',
      fixture: {
        pedigree: { R2: { parents: [{ germplasmDbId: 'R1', parentType: 'MALE' }] } },
        progeny: { R1: { progeny: [{ germplasmDbId: 'R2', parentType: 'MALE' }] } },
      },
      edges: [{ from: 'R1', to: 'R2', relationship: 'parent', parentType: 'MALE' }],
      directions: { R1: 'root', R2: 'root' },
    },
    {
      // X is a child of root A and a parent of root D, so it is tagged `both`.
      name: 'a node is reached from both sides of two roots',
      roots: ['A', 'D'],
      direction: 'both',
      maxDepth: 1,
      fixture: {
        pedigree: { D: { parents: [{ germplasmDbId: 'X' }] } },
        progeny: { A: { progeny: [{ germplasmDbId: 'X' }] } },
      },
      edges: [
        { from: 'X', to: 'A', relationship: 'child' },
        { from: 'X', to: 'D', relationship: 'parent' },
      ],
      directions: { A: 'root', D: 'root', X: 'both' },
    },
    {
      // One edge, carrying the first-listed parentType.
      name: 'a parent is listed twice',
      roots: ['R'],
      direction: 'ancestors',
      fixture: {
        pedigree: {
          R: {
            parents: [
              { germplasmDbId: 'P', parentType: 'FEMALE' },
              { germplasmDbId: 'P', parentType: 'MALE' },
            ],
          },
        },
      },
      edges: [{ from: 'P', to: 'R', relationship: 'parent', parentType: 'FEMALE' }],
      directions: { R: 'root', P: 'ancestor' },
    },
  ])(
    'counts no cycle when $name',
    async ({ roots, direction, maxDepth, fixture, edges, directions }) => {
      const ctx = await connect(fetcher, [PROGENY]);
      serveFixture(fetcher, fixture);

      const result = await walk(ctx, {
        germplasmDbIds: roots,
        direction,
        ...(maxDepth !== undefined && { maxDepth }),
      });

      expect(result.cycleCount).toBe(0);
      expect(result.edges).toEqual(edges);
      expect(Object.fromEntries(result.nodes.map((n) => [n.germplasmDbId, n.direction]))).toEqual(
        directions,
      );
    },
  );

  it('accepts germplasmDbId as an alias of germplasmDbIds', async () => {
    // The alias is rewritten before the handler runs, so a call with no
    // registered connection gets past argument parsing to unknown_alias.
    const aliased = await runToolContract(
      brapiWalkPedigree,
      { germplasmDbId: 'g-1', alias: 'missing' } as never,
      { context: { tenantId: 't1' } },
    );
    expect(aliased.isError).toBe(true);
    expect(aliased.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'unknown_alias' } },
    });

    const both = await runToolContract(
      brapiWalkPedigree,
      { germplasmDbId: 'g-1', germplasmDbIds: ['g-2'], alias: 'missing' } as never,
      { context: { tenantId: 't1' } },
    );
    expect(both.isError).toBe(true);
    expect(both.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(JSON.stringify(both.content)).toContain('germplasmDbId is an alias of germplasmDbIds');
  });

  it('throws ValidationError when /germplasm is not advertised', async () => {
    const ctx = await connect(fetcher, [], ['studies']);

    await expect(walk(ctx, { germplasmDbIds: ['g-1'] })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
    });
  });

  it('enforces the node cap mid-depth instead of overshooting it', async () => {
    const ctx = await connect(fetcher);
    // A single prolific founder enumerates far more parents in ONE depth than
    // the 1,000-node cap. The cap must hold mid-expansion, not just at the next
    // depth boundary — the pre-fix code overshot to ~1,500 here.
    serveFixture(fetcher, { pedigree: { 'g-root': { parents: fanOut(1500) } } });

    const result = await walk(ctx, {
      germplasmDbIds: ['g-root'],
      direction: 'ancestors',
      maxDepth: 3,
      // Pin loadLimit above the node cap so this test isolates the MAX_NODES
      // ceiling; loadLimit-driven dataframe spillover is covered separately.
      loadLimit: 2_000,
    });

    expect(result.truncated).toBe(true);
    expect(result.nodesDataframe?.rowCount).toBe(1000); // Discovered graph: 1 root + 999 parents.
    expect(result.warnings.join('\n')).toContain('safety cap');
    expect(textOf(result)).toContain('truncated: true');
  });

  it('stops at the edge cap when a few germplasm list each other densely', async () => {
    const ctx = await connect(fetcher, [PROGENY]);
    // 150 germplasm, each listing every lower-numbered one as progeny: under
    // 200 nodes but over 11,000 distinct pairs, each reconnecting known nodes.
    const ids = Array.from({ length: 150 }, (_, i) => `c${i}`);
    fetcher.mockImplementation(async (url: string) => {
      const parsed = new URL(String(url));
      if (parsed.hostname !== UPSTREAM_HOST) throw new Error(`Unmocked host: ${parsed.hostname}`);
      const m = parsed.pathname.match(/\/germplasm\/([^/]+)\/(pedigree|progeny)$/);
      if (!m) throw new Error(`Unexpected path: ${parsed.pathname}`);
      if (m[2] === 'pedigree') return jsonResponse(envelope({ parents: [] }));
      const id = decodeURIComponent(m[1]!);
      const below = id === 'root' ? ids : ids.slice(0, Number(id.slice(1)));
      return jsonResponse(envelope({ progeny: below.map((g) => ({ germplasmDbId: g })) }));
    });

    const cpuStart = process.threadCpuUsage();
    const result = await walk(ctx, {
      germplasmDbIds: ['root'],
      direction: 'descendants',
      maxDepth: 2,
      loadLimit: 20_000,
    });
    const cpu = process.threadCpuUsage(cpuStart);

    expect(result.truncated).toBe(true);
    expect(result.edgesDataframe?.rowCount).toBe(10_000);
    expect(result.nodes).toHaveLength(151);
    expect(result.cycleCount).toBe(0);
    expect(result.warnings.join('\n')).toContain('10000 edges');
    // Loop detection stays bounded by the cap (about 0.3 s of CPU here).
    expect((cpu.user + cpu.system) / 1000).toBeLessThan(2_000);
  });

  it('spills the node and edge sets to two dataframes, named with their join in one notice, past loadLimit', async () => {
    const ctx = await connect(fetcher);
    // Root fans out to 20 parents → 21 nodes, 20 edges; loadLimit=5 spills both sets.
    serveFixture(fetcher, { pedigree: { 'g-root': { parents: fanOut(20) } } });

    const result = await runToolContract(
      bound(ctx),
      { germplasmDbIds: ['g-root'], maxDepth: 2, loadLimit: 5 },
      { context: { tenantId: 't1' } },
    );

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as WalkOutput & { notice?: string };
    // Full sets land in the dataframes; the inline arrays are bounded previews.
    expect(structured.nodesDataframe?.rowCount).toBe(21);
    expect(structured.edgesDataframe?.rowCount).toBe(20);
    expect(structured.nodes).toHaveLength(5);
    expect(structured.edges).toHaveLength(5);
    // The reserved SQL word `from` in the edge schema is renamed to `from_`,
    // with a legend mapping it back.
    expect(structured.edgesDataframe?.columnLegend).toMatchObject({ from_: 'from' });
    // isCycle is a column of the edge table even when no edge closes a loop.
    expect(structured.edgesDataframe?.columns).toContain('isCycle');
    // Stats still describe the full walk, not the preview.
    expect(structured.rootCount).toBe(1);
    const nodes = structured.nodesDataframe!.tableName;
    const edges = structured.edgesDataframe!.tableName;
    expect(structured.notice).toContain(
      `Staged dataframes \`${nodes}\` (21 rows) and \`${edges}\` (20 rows): list their columns with brapi_dataframe_describe, then query them with brapi_dataframe_query (SQL) — join germplasmDbId in \`${nodes}\` to from_ or to in \`${edges}\`.`,
    );
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain(`> ${structured.notice}`);
    expect(text).toContain(`## Nodes (preview — 5 of 21; full set in dataframe \`${nodes}\`)`);
  });

  it('stays inline, with no dataframe or notice, when the walk fits loadLimit', async () => {
    const ctx = await connect(fetcher);
    serveFixture(fetcher, {
      pedigree: { 'g-1': { parents: [{ germplasmDbId: 'g-2' }, { germplasmDbId: 'g-3' }] } },
    });

    const result = await runToolContract(
      bound(ctx),
      { germplasmDbIds: ['g-1'] },
      { context: { tenantId: 't1' } },
    );

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as WalkOutput;
    expect(structured.nodes).toHaveLength(3);
    expect(structured.edges).toHaveLength(2);
    expect(structured).not.toHaveProperty('nodesDataframe');
    expect(structured).not.toHaveProperty('edgesDataframe');
    expect(structured).not.toHaveProperty('notice');
  });

  describe('diagram', () => {
    const unionFixture: PedigreeFixture = {
      pedigree: {
        R: {
          germplasmName: 'Root "accession"',
          parents: [
            { germplasmDbId: 'P1', germplasmName: 'Mother', parentType: 'FEMALE' },
            { germplasmDbId: 'P2', germplasmName: 'Father', parentType: 'MALE' },
          ],
        },
      },
      progeny: {
        R: {
          progeny: [
            { germplasmDbId: 'C1', germplasmName: 'cross 1', parentType: 'FEMALE' },
            { germplasmDbId: 'C2', germplasmName: 'cross\n2', parentType: 'FEMALE' },
          ],
        },
      },
    };

    it('leaves the output and format() unchanged when diagram is omitted', async () => {
      const ctx = await connect(fetcher, [PROGENY]);
      serveFixture(fetcher, unionFixture);
      const result = await walk(ctx, { germplasmDbIds: ['R'], direction: 'both' });
      expect('diagram' in result).toBe(false);
      const text = textOf(brapiWalkPedigree.output.parse(result));
      expect(text).not.toContain('## Diagram');
      expect(text).not.toContain('```');
    });

    it('renders the walk as Mermaid, every arrow parent → child', async () => {
      const ctx = await connect(fetcher, [PROGENY]);
      serveFixture(fetcher, unionFixture);
      const result = await walk(ctx, {
        germplasmDbIds: ['R'],
        direction: 'both',
        diagram: 'mermaid',
      });

      // Nodes sort by depth then id: R, C1, C2, P1, P2.
      expect(result.diagram).toBe(
        [
          'flowchart TD',
          '  n0["Root #34;accession#34;"]',
          '  n1["cross 1"]',
          '  n2["cross 2"]',
          '  n3["Mother"]',
          '  n4["Father"]',
          '  n3 -->|"FEMALE"| n0',
          '  n4 -->|"MALE"| n0',
          '  n0 -->|"FEMALE"| n1',
          '  n0 -->|"FEMALE"| n2',
          '  classDef root stroke-width:3px',
          '  class n0 root',
        ].join('\n'),
      );
      const parsed = brapiWalkPedigree.output.parse(result);
      expect(textOf(parsed)).toContain(`## Diagram\n\`\`\`mermaid\n${result.diagram}\n\`\`\``);
    });

    it('renders the walk as a Graphviz digraph in a dot fence', async () => {
      const ctx = await connect(fetcher, [PROGENY]);
      serveFixture(fetcher, unionFixture);
      const result = await walk(ctx, { germplasmDbIds: ['R'], direction: 'both', diagram: 'dot' });
      expect(result.diagram?.startsWith('digraph pedigree {')).toBe(true);
      expect(result.diagram).toContain(
        '  n0 [label="Root \\"accession\\"", style=bold, penwidth=2];',
      );
      expect(result.diagram).toContain('  n0 -> n2 [label="FEMALE"];');
      expect(textOf(brapiWalkPedigree.output.parse(result))).toContain(
        `\`\`\`dot\n${result.diagram}\n\`\`\``,
      );
    });

    it('renders a spilled walk from the full node and edge sets', async () => {
      const ctx = await connect(fetcher);
      serveFixture(fetcher, { pedigree: { 'g-root': { parents: fanOut(20) } } });
      const result = await walk(ctx, {
        germplasmDbIds: ['g-root'],
        maxDepth: 1,
        loadLimit: 5,
        diagram: 'mermaid',
      });
      expect(result.nodes).toHaveLength(5);
      expect(result.edges).toHaveLength(5);
      const lines = result.diagram?.split('\n') ?? [];
      expect(lines.filter((l) => /^ {2}n\d+\["/.test(l))).toHaveLength(21);
      expect(lines.filter((l) => / --> /.test(l))).toHaveLength(20);
    });

    it('omits a Mermaid diagram past 500 edges with one warning and nothing else changed', async () => {
      const ctx = await connect(fetcher);
      serveFixture(fetcher, { pedigree: { 'g-root': { parents: fanOut(501) } } });
      const input = { germplasmDbIds: ['g-root'], maxDepth: 1, loadLimit: 1_000 };

      const plain = await walk(ctx, input);
      const asked = await walk(ctx, { ...input, diagram: 'mermaid' });

      expect('diagram' in asked).toBe(false);
      expect(asked.warnings).toEqual([
        'Mermaid diagram omitted: the walk has 501 edges, past Mermaid\'s default limit of 500. Lower maxDepth, pass fewer germplasmDbIds, or request diagram: "dot".',
      ]);
      const stable = (output: WalkOutput) => ({
        ...output,
        warnings: [],
        nodesDataframe: output.nodesDataframe && {
          ...output.nodesDataframe,
          tableName: '',
          createdAt: '',
          expiresAt: '',
        },
        edgesDataframe: output.edgesDataframe && {
          ...output.edgesDataframe,
          tableName: '',
          createdAt: '',
          expiresAt: '',
        },
        frontierDataframe: output.frontierDataframe && {
          ...output.frontierDataframe,
          tableName: '',
          createdAt: '',
          expiresAt: '',
        },
      });
      expect(stable(asked)).toEqual(stable(plain));
    });

    it('omits a DOT diagram past 50,000 characters with one warning, from both surfaces', async () => {
      const ctx = await connect(fetcher);
      const parents = Array.from({ length: 60 }, (_, i) => ({
        germplasmDbId: `p-${i}`,
        germplasmName: 'n'.repeat(1_000),
      }));
      serveFixture(fetcher, { pedigree: { 'g-root': { parents } } });

      const result = await walk(ctx, { germplasmDbIds: ['g-root'], maxDepth: 1, diagram: 'dot' });

      const parsed = brapiWalkPedigree.output.parse(result);
      expect('diagram' in parsed).toBe(false);
      expect(parsed.warnings).toEqual([
        expect.stringMatching(
          /^DOT diagram omitted: its source is \d{2},\d{3} characters, past the 50,000-character limit\. Lower maxDepth or pass fewer germplasmDbIds\.$/,
        ),
      ]);
      const text = textOf(parsed);
      expect(text).not.toContain('## Diagram');
      expect(text).toContain('DOT diagram omitted');
    });
  });
});
