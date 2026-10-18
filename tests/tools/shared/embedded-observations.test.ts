/**
 * @fileoverview SGN observation-route regression tests at the HTTP boundary.
 * @module tests/tools/shared/embedded-observations.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import {
  collectEmbeddedObservations,
  normalizeObsRow,
  pullStudyObservations,
} from '@/mcp-server/tools/shared/observations.js';
import { BrapiClient, CALL_DEADLINE_MS } from '@/services/brapi-client/index.js';
import { breedbaseDialect, specDialect } from '@/services/brapi-dialect/index.js';
import type { RegisteredServer } from '@/services/server-registry/index.js';
import { envelope, jsonResponse, TEST_CONFIG } from '../_tool-test-helpers.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const observation = (id: string, value = '1') => ({
  observationDbId: id,
  studyDbId: 's1',
  germplasmDbId: 'g1',
  observationVariableDbId: 'v1',
  value,
});

it('distinguishes unavailable embedded measurements from explicit empty arrays', async () => {
  const unavailable = await scan(() =>
    jsonResponse(envelope({ data: [{ studyDbId: 's1', germplasmDbId: 'g1' }] }, { totalCount: 1 })),
  ).run();
  expect(unavailable.rawRows).toEqual([]);
  expect(unavailable.truncation?.reason).toContain('did not supply observations arrays');
  const empty = await scan(() => unitPage(0, 1, [])).run();
  expect(empty.rawRows).toEqual([]);
  expect(empty.truncation).toBeUndefined();
});

async function pull(sgn: boolean) {
  const config = { ...TEST_CONFIG, allowPrivateIps: true, pageSize: 1 };
  return pullStudyObservations({
    client: new BrapiClient(config),
    config,
    connection: {
      alias: 'test',
      baseUrl: 'https://brapi.example.org/brapi/v2',
    } as RegisteredServer,
    ctx: createMockContext(),
    dialect: sgn ? breedbaseDialect : specDialect,
    input: {},
    loadLimit: 100,
    studyDbId: 's1',
    warnings: [],
    profile: {
      observations: { service: 'observations', methods: ['GET'] },
      observationunits: { service: 'observationunits', methods: ['GET'] },
    },
  });
}

it('characterizes the non-SGN observation route', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse(envelope({ data: [observation('one')] }, { totalCount: 1 }))),
  );
  expect((await pull(false))?.observations.map((o) => o.value)).toEqual(['1']);
});

it('prefers SGN embedded rows, counts raw units and deduplicates real IDs while retaining zero and child metadata', async () => {
  const requests: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = new URL(url);
      requests.push(u);
      if (u.pathname.endsWith('/observations'))
        return jsonResponse(envelope({ data: [observation('one')] }, { totalCount: 1 }));
      const page = Number(u.searchParams.get('page') ?? 0);
      const data =
        page === 0
          ? [
              {
                observationUnitDbId: 'u1',
                studyDbId: 's1',
                germplasmDbId: 'parent',
                observations: [observation('one'), observation('zero', '0')],
              },
            ]
          : [
              {
                observationUnitDbId: 'u2',
                studyDbId: 's1',
                germplasmDbId: 'g1',
                observations: [observation('one'), observation('replicate', '0')],
              },
            ];
      return jsonResponse(envelope({ data }, { totalCount: 2 }));
    }),
  );
  const result = await pull(true);
  expect(result?.observations.map((o) => o.value)).toEqual(['1', '0', '0']);
  expect(result?.rawRows.map((o) => o.observationDbId)).toEqual(['one', 'zero', 'replicate']);
  expect(result?.rawRows[0]).toMatchObject({ germplasmDbId: 'g1', observationUnitDbId: 'u1' });
  expect(requests.map((u) => u.searchParams.get('page'))).toEqual(['0', '1']);
  expect(requests[0]?.searchParams.get('includeObservations')).toBe('true');
});

function scan(
  route: (page: number, signal: AbortSignal) => Response | Promise<Response>,
  options: {
    loadLimit?: number;
    perStudyLimit?: number;
    remainingMs?: number;
    controller?: AbortController;
    keep?: Parameters<typeof collectEmbeddedObservations>[0]['keep'];
  } = {},
) {
  const requests: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const u = new URL(url);
      requests.push(u);
      return route(Number(u.searchParams.get('page')), init.signal as AbortSignal);
    }),
  );
  const config = { ...TEST_CONFIG, allowPrivateIps: true, pageSize: 1, requestTimeoutMs: 1_000 };
  const ctx = {
    ...createMockContext({ ...(options.controller && { signal: options.controller.signal }) }),
    ...(options.remainingMs !== undefined && {
      timestamp: new Date(Date.now() - CALL_DEADLINE_MS + options.remainingMs).toISOString(),
    }),
  };
  const warnings: string[] = [];
  const run = () =>
    collectEmbeddedObservations({
      client: new BrapiClient(config),
      config,
      ctx,
      connection: {
        alias: 'test',
        baseUrl: 'https://brapi.example.org/brapi/v2',
      } as RegisteredServer,
      dialect: breedbaseDialect,
      filters: { studyDbIds: ['s1'] },
      warnings,
      loadLimit: options.loadLimit ?? 100,
      ...(options.perStudyLimit !== undefined && { perStudyLimit: options.perStudyLimit }),
      keep: options.keep ?? ((row) => normalizeObsRow(row) !== null),
    });
  return { run, requests, warnings };
}

const unitPage = (page: number, totalCount: number, children = [observation(`o${page}`)]) =>
  jsonResponse(
    envelope(
      {
        data: [
          {
            studyDbId: 's1',
            germplasmDbId: 'g1',
            observationUnitDbId: `u${page}`,
            observations: children,
          },
        ],
      },
      { totalCount },
    ),
  );

it.each(['empty', 'repeat', 'failed'] as const)(
  'discloses a later %s page while retaining preceding observations',
  async (mode) => {
    const { run, requests } = scan((page) =>
      page === 0
        ? unitPage(0, 3)
        : mode === 'empty'
          ? jsonResponse(envelope({ data: [] }, { totalCount: 3 }))
          : mode === 'repeat'
            ? unitPage(0, 3)
            : new Response('down', { status: 503 }),
    );
    const result = await run();
    expect(result.rawRows.map((row) => row.observationDbId)).toEqual(['o0']);
    expect(result.truncation).toMatchObject({ scanned: 1, totalCount: 3 });
    expect(result.truncation?.reason).toContain(
      mode === 'empty' ? 'empty' : mode === 'repeat' ? 'repeated' : 'failed',
    );
    expect(requests).toHaveLength(2);
  },
);

it('reports an empty first page with a positive total as partial, and authoritative zero as complete', async () => {
  const partial = await scan(() => jsonResponse(envelope({ data: [] }, { totalCount: 3 }))).run();
  expect(partial.truncation).toMatchObject({
    scanned: 0,
    totalCount: 3,
    reason: 'page 1 came back empty',
  });
  const empty = await scan(() => jsonResponse(envelope({ data: [] }, { totalCount: 0 }))).run();
  expect(empty.rawRows).toEqual([]);
  expect(empty.truncation).toBeUndefined();
});

it('caps matching observations inside a unit, rather than raw units or unmatched children', async () => {
  const { run } = scan(
    () =>
      unitPage(0, 1, [
        observation('wrong'),
        observation('zero', '0'),
        observation('one'),
        observation('two'),
      ]),
    { loadLimit: 2, keep: (row) => row.observationDbId !== 'wrong' },
  );
  const result = await run();
  expect(result.rawRows.map((row) => row.observationDbId)).toEqual(['zero', 'one']);
  expect(result.truncation).toMatchObject({ scanned: 1, totalCount: 1 });
});

it('keeps absent-ID replicates and child overrides while inheriting missing parent metadata', async () => {
  const missingId = { studyDbId: 's1', observationVariableDbId: 'v1', value: 0 };
  const result = await scan(() =>
    jsonResponse(
      envelope(
        {
          data: [
            {
              studyDbId: 'parent',
              germplasmDbId: 'g1',
              season: 'season',
              observationUnitDbId: 'u1',
              observations: [
                missingId,
                missingId,
                { ...observation('child'), germplasmDbId: null },
              ],
            },
          ],
        },
        { totalCount: 1 },
      ),
    ),
  ).run();
  expect(result.rawRows).toHaveLength(3);
  expect(result.rawRows[0]).toMatchObject({
    studyDbId: 's1',
    germplasmDbId: 'g1',
    season: 'season',
    value: '0',
  });
  expect(result.rawRows[0]?.observationDbId).toBeUndefined();
  expect(result.rawRows[2]?.germplasmDbId).toBe('g1');
});

it('a per-study cap retains later studies and walks the authoritative raw unit total', async () => {
  const { run, requests } = scan(
    (page) =>
      jsonResponse(
        envelope(
          {
            data: [
              {
                studyDbId: `s${page}`,
                germplasmDbId: 'g1',
                observationUnitDbId: `u${page}`,
                observations: [0, 1].map((i) => ({
                  ...observation(`o${page}-${i}`),
                  studyDbId: `s${page}`,
                })),
              },
            ],
          },
          { totalCount: 3 },
        ),
      ),
    { perStudyLimit: 1 },
  );
  const result = await run();
  expect(result.rawRows.map((row) => row.studyDbId)).toEqual(['s0', 's1', 's2']);
  expect(result.cappedStudyDbIds).toEqual(['s0', 's1', 's2']);
  expect(result.truncation).toBeUndefined();
  expect(requests.map((u) => u.searchParams.get('page'))).toEqual(['0', '1', '2']);
});

it('discloses the page cap even when no observations match', async () => {
  const { run, requests } = scan((page) => unitPage(page, 51), { keep: () => false });
  const result = await run();
  expect(result.rawRows).toEqual([]);
  expect(result.truncation).toMatchObject({
    scanned: 50,
    totalCount: 51,
    reason: 'reached the 50-page cap',
  });
  expect(requests).toHaveLength(50);
});

it('throws first-page failures without an observations fallback', async () => {
  const { run, requests } = scan(() => new Response('down', { status: 503 }));
  await expect(run()).rejects.toMatchObject({ data: { status: 503 } });
  expect(requests.map((u) => u.pathname)).toEqual(['/brapi/v2/observationunits']);
});

it('retains rows when a later request hits the shared call deadline', async () => {
  vi.useFakeTimers();
  const { run, requests } = scan(
    (page, signal) =>
      page === 0
        ? unitPage(0, 2)
        : new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
    { remainingMs: 40 },
  );
  const [result] = await Promise.all([run(), vi.advanceTimersByTimeAsync(40)]);
  expect(result.rawRows.map((row) => row.observationDbId)).toEqual(['o0']);
  expect(result.truncation?.reason).toContain('deadline');
  expect(requests).toHaveLength(2);
});

it('caller cancellation remains cancellation after a completed page', async () => {
  const controller = new AbortController();
  const { run } = scan(
    (page, signal) =>
      page === 0
        ? unitPage(0, 2)
        : new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            controller.abort();
          }),
    { controller },
  );
  await expect(run()).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
});
