/**
 * @fileoverview End-to-end tests for `brapi_walk_pedigree` — BFS traversal,
 * cycle detection, capability gap warnings, dead-end accounting, depth cap.
 *
 * @module tests/tools/brapi-walk-pedigree.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiWalkPedigree } from '@/mcp-server/tools/definitions/brapi-walk-pedigree.tool.js';
import {
  BASE_URL,
  envelope,
  initTestServices,
  jsonResponse,
  type MockFetcher,
  pathnameOf,
  resetTestServices,
} from './_tool-test-helpers.js';

interface Pedigree {
  parents: Array<{ germplasmDbId: string; germplasmName?: string; parentType?: string }>;
}

async function connect(fetcher: MockFetcher, supportedExtras: string[] = []) {
  const calls: { service: string; methods: string[]; versions: string[] }[] = [
    { service: 'germplasm', methods: ['GET'], versions: ['2.1'] },
    {
      service: 'germplasm/{germplasmDbId}/pedigree',
      methods: ['GET'],
      versions: ['2.1'],
    },
  ];
  for (const extra of supportedExtras) {
    calls.push({ service: extra, methods: ['GET'], versions: ['2.1'] });
  }
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

  it('walks ancestors BFS and produces nodes + edges', async () => {
    const ctx = await connect(fetcher);
    // g-1 → parents [g-2, g-3]; g-2 → parents [g-4]; g-3 → no parents; g-4 → no parents.
    const pedigrees: Record<string, Pedigree> = {
      'g-1': {
        parents: [
          { germplasmDbId: 'g-2', germplasmName: 'P1', parentType: 'FEMALE' },
          { germplasmDbId: 'g-3', germplasmName: 'P2', parentType: 'MALE' },
        ],
      },
      'g-2': { parents: [{ germplasmDbId: 'g-4', germplasmName: 'GP1', parentType: 'FEMALE' }] },
      'g-3': { parents: [] },
      'g-4': { parents: [] },
    };
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      const m = path.match(/\/germplasm\/([^/]+)\/pedigree$/);
      if (m) {
        const id = decodeURIComponent(m[1]!);
        return jsonResponse(envelope(pedigrees[id] ?? { parents: [] }));
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const result = await brapiWalkPedigree.handler(
      brapiWalkPedigree.input.parse({
        germplasmDbIds: ['g-1'],
        direction: 'ancestors',
        maxDepth: 3,
      }),
      ctx,
    );

    expect(result.rootCount).toBe(1);
    expect(result.nodes.map((n) => n.germplasmDbId).sort()).toEqual(['g-1', 'g-2', 'g-3', 'g-4']);
    expect(result.edges).toHaveLength(3); // g-2→g-1, g-3→g-1, g-4→g-2
    expect(result.depthReached).toBeGreaterThanOrEqual(2);
    expect(result.cycleCount).toBe(0);
    // Ancestor leaves are unparented ancestors (g-3, g-4) — not the root and
    // not nodes that have further ancestors recorded (g-2 has g-4 above it).
    expect(result.leafCount).toBe(2);
  });

  it('counts unparented ancestors as leaves (not the root)', async () => {
    const ctx = await connect(fetcher);
    // g-1 → parents [g-2, g-3, g-4]; all three are unparented terminals.
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      const m = path.match(/\/germplasm\/([^/]+)\/pedigree$/);
      if (m) {
        const id = decodeURIComponent(m[1]!);
        if (id === 'g-1') {
          return jsonResponse(
            envelope({
              parents: [
                { germplasmDbId: 'g-2' },
                { germplasmDbId: 'g-3' },
                { germplasmDbId: 'g-4' },
              ],
            }),
          );
        }
        return jsonResponse(envelope({ parents: [] }));
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const result = await brapiWalkPedigree.handler(
      brapiWalkPedigree.input.parse({
        germplasmDbIds: ['g-1'],
        direction: 'ancestors',
        maxDepth: 2,
      }),
      ctx,
    );
    expect(result.leafCount).toBe(3);
    expect(result.deadEndCount).toBe(0);
  });

  it('detects cycles when an ancestor reappears', async () => {
    const ctx = await connect(fetcher);
    const pedigrees: Record<string, Pedigree> = {
      'g-1': { parents: [{ germplasmDbId: 'g-2' }] },
      'g-2': { parents: [{ germplasmDbId: 'g-1' }] }, // cycle back to g-1
    };
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      const m = path.match(/\/germplasm\/([^/]+)\/pedigree$/);
      if (m) {
        return jsonResponse(envelope(pedigrees[decodeURIComponent(m[1]!)] ?? { parents: [] }));
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const result = await brapiWalkPedigree.handler(
      brapiWalkPedigree.input.parse({
        germplasmDbIds: ['g-1'],
        direction: 'ancestors',
        maxDepth: 4,
      }),
      ctx,
    );

    expect(result.cycleCount).toBeGreaterThanOrEqual(1);
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

    const result = await brapiWalkPedigree.handler(
      brapiWalkPedigree.input.parse({ germplasmDbIds: ['g-1'], direction: 'ancestors' }),
      ctx,
    );
    expect(result.deadEndCount).toBe(1);
  });

  it('warns when descendants direction is requested but /progeny is unavailable', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(async () => jsonResponse(envelope({ parents: [] })));

    const result = await brapiWalkPedigree.handler(
      brapiWalkPedigree.input.parse({
        germplasmDbIds: ['g-1'],
        direction: 'both',
      }),
      ctx,
    );
    expect(result.warnings.join('\n')).toContain('/germplasm/{id}/progeny');
  });

  it('does not count inverse-edge backtracks as cycles when direction=both', async () => {
    const ctx = await connect(fetcher, ['germplasm/{germplasmDbId}/progeny']);
    // g-1 ← parent of g-3; g-2 ← parent of g-3.
    // Walking from g-3 in direction=both: ancestors yields {g-1, g-2};
    // then expanding g-1+g-2 with descendants yields g-3 (already known).
    // The old logic counted those inverse-edge encounters as cycles. They
    // are not — they are the symmetric relation re-discovered from the
    // other side. cycleCount must stay 0.
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      const ped = path.match(/\/germplasm\/([^/]+)\/pedigree$/);
      if (ped) {
        const id = decodeURIComponent(ped[1]!);
        if (id === 'g-3') {
          return jsonResponse(
            envelope({
              parents: [{ germplasmDbId: 'g-1' }, { germplasmDbId: 'g-2' }],
            }),
          );
        }
        return jsonResponse(envelope({ parents: [] }));
      }
      const prog = path.match(/\/germplasm\/([^/]+)\/progeny$/);
      if (prog) {
        const id = decodeURIComponent(prog[1]!);
        if (id === 'g-1' || id === 'g-2') {
          return jsonResponse(envelope({ data: [{ germplasmDbId: 'g-3' }] }));
        }
        return jsonResponse(envelope({ data: [] }));
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const result = await brapiWalkPedigree.handler(
      brapiWalkPedigree.input.parse({
        germplasmDbIds: ['g-3'],
        direction: 'both',
        maxDepth: 3,
      }),
      ctx,
    );

    expect(result.cycleCount).toBe(0);
    // We still record both edges (parent and child) — that's the structural
    // representation; we just don't double-count it as a graph cycle.
    expect(result.edges.length).toBe(4);
  });

  it('throws ValidationError when /germplasm is not advertised', async () => {
    fetcher.mockReset();
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
    const ctx = createMockContext({ tenantId: 't1' });
    await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);

    await expect(
      brapiWalkPedigree.handler(brapiWalkPedigree.input.parse({ germplasmDbIds: ['g-1'] }), ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
  });
});
