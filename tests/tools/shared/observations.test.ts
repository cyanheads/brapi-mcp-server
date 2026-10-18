/**
 * @fileoverview Tests for the shared observation pull. `pullObservationsForStudies`
 * is exercised with an injected fake per-study pull so batching, ordering, and
 * failure policy are fully controlled. `pullStudyObservations` runs on a real
 * `BrapiClient` over a stubbed global `fetch`, so the framework's timeout and
 * HTTP-status classification, the retry loop, and the call deadline all run:
 * the `/observations` page walk, its truncation reporting, the fallback chain,
 * and the failure contract.
 *
 * @module tests/tools/shared/observations.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { MAX_SPILLOVER_PAGES } from '@/mcp-server/tools/shared/find-helpers.js';
import {
  type NormObs,
  type ObservationPullFilters,
  type PullObservationsForStudiesArgs,
  type PullStudyObservationsArgs,
  pullObservationsForStudies,
  pullStudyObservations,
  type StudyPull,
} from '@/mcp-server/tools/shared/observations.js';
import { BrapiClient, CALL_DEADLINE_MS } from '@/services/brapi-client/index.js';
import {
  type BrapiDialect,
  brapiTestDialect,
  specDialect,
} from '@/services/brapi-dialect/index.js';
import type { RegisteredServer } from '@/services/server-registry/index.js';
import { envelope, jsonResponse, TEST_CONFIG } from '../_tool-test-helpers.js';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A NormObs stamped with its source study, so input-order assertions trace each row back. */
function obs(studyDbId: string): NormObs {
  return {
    germplasmDbId: 'g1',
    germplasmName: 'G1',
    observationVariableDbId: 'v1',
    observationVariableName: 'V1',
    studyDbId,
    value: '1',
  };
}

/** A fake pull result carrying one observation for the study. */
const pulled = (studyDbId: string): StudyPull => ({ observations: [obs(studyDbId)] });

/**
 * Build the shared args. `client` / `connection` / `dialect` / `profile` / `input`
 * are never touched by the injected fake pull, so placeholder values suffice —
 * only `config.maxConcurrentRequests` and `ctx.signal` drive the helper itself.
 */
function baseArgs(
  studyDbIds: string[],
  maxConcurrentRequests: number,
  failFast: boolean,
  ctx = createMockContext(),
): PullObservationsForStudiesArgs {
  return {
    studyDbIds,
    input: {},
    client: {} as BrapiClient,
    connection: {} as RegisteredServer,
    dialect: {} as BrapiDialect,
    profile: {},
    loadLimit: 10,
    config: { maxConcurrentRequests } as ServerConfig,
    ctx,
    failFast,
  };
}

describe('pullObservationsForStudies', () => {
  it('runs studies in bounded-concurrency batches — never more than maxConcurrentRequests in flight', async () => {
    const studyDbIds = ['s0', 's1', 's2', 's3', 's4', 's5'];
    let inFlight = 0;
    let peak = 0;
    const pull = async (a: PullStudyObservationsArgs): Promise<StudyPull | null> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await delay(15);
      inFlight--;
      return pulled(a.studyDbId);
    };

    const outcomes = await pullObservationsForStudies(baseArgs(studyDbIds, 2, false), pull);

    // Exactly 2 proves BOTH the bound (never 3) and real parallelism (never 1,
    // which is what a sequential pre-fix pull would produce).
    expect(peak).toBe(2);
    expect(outcomes).toHaveLength(6);
  });

  it('reassembles outcomes in input order even when later studies resolve first', async () => {
    const studyDbIds = ['s0', 's1', 's2', 's3'];
    const pull = async (a: PullStudyObservationsArgs): Promise<StudyPull | null> => {
      // Reverse the completion order within the single batch: s0 finishes last.
      const idx = studyDbIds.indexOf(a.studyDbId);
      await delay((studyDbIds.length - idx) * 8);
      return pulled(a.studyDbId);
    };

    const outcomes = await pullObservationsForStudies(baseArgs(studyDbIds, 4, false), pull);

    expect(outcomes.map((o) => o.studyDbId)).toEqual(studyDbIds);
    expect(outcomes.map((o) => o.observations?.[0]?.studyDbId)).toEqual(studyDbIds);
  });

  // s0 has no observation path (`null`) or throws; batches of 2 over six studies.
  // Only fail-fast on a no-path study stops the fan-out — after s0's batch.
  it.each([
    ['fail-fast stops after the batch with a no-path study', true, 'no-path', 2],
    ['fail-fast does not stop on a study that threw', true, 'throws', 6],
    ['continue-on-error pulls every study past a no-path one', false, 'no-path', 6],
    ['continue-on-error pulls every study past one that threw', false, 'throws', 6],
  ] as const)('%s', async (_label, failFast, s0, pulledCount) => {
    const studyDbIds = ['s0', 's1', 's2', 's3', 's4', 's5'];
    const seen: string[] = [];
    const pull = async (a: PullStudyObservationsArgs): Promise<StudyPull | null> => {
      seen.push(a.studyDbId);
      if (a.studyDbId !== 's0') return pulled(a.studyDbId);
      if (s0 === 'throws') throw new Error('boom');
      return null;
    };

    const outcomes = await pullObservationsForStudies(baseArgs(studyDbIds, 2, failFast), pull);

    const expected = studyDbIds.slice(0, pulledCount);
    expect(outcomes.map((o) => o.studyDbId)).toEqual(expected);
    expect([...seen].sort()).toEqual(expected);
    // s0 folds into its own outcome — a no-path sentinel is not an error — and
    // every other study keeps its rows.
    expect(outcomes[0]?.observations).toBeNull();
    if (s0 === 'throws') expect(outcomes[0]?.error).toBeInstanceOf(Error);
    else expect(outcomes[0]?.error).toBeUndefined();
    for (const o of outcomes.slice(1)) expect(o.observations).toEqual([obs(o.studyDbId)]);
  });

  it("keeps each study's warnings in its own outcome (no cross-study interleave)", async () => {
    const studyDbIds = ['s0', 's1'];
    const pull = async (a: PullStudyObservationsArgs): Promise<StudyPull | null> => {
      a.warnings.push(`warn:${a.studyDbId}`);
      return pulled(a.studyDbId);
    };

    const outcomes = await pullObservationsForStudies(baseArgs(studyDbIds, 4, false), pull);

    expect(outcomes[0]?.warnings).toEqual(['warn:s0']);
    expect(outcomes[1]?.warnings).toEqual(['warn:s1']);
  });

  it("carries a study's truncation onto its outcome", async () => {
    const truncation = {
      reason: 'reached loadLimit (10) matching rows',
      scanned: 20,
      totalCount: 50,
    };
    const pull = async (a: PullStudyObservationsArgs): Promise<StudyPull | null> =>
      a.studyDbId === 's1' ? { observations: [obs('s1')], truncation } : pulled(a.studyDbId);

    const outcomes = await pullObservationsForStudies(baseArgs(['s0', 's1'], 4, false), pull);

    expect(outcomes[0]?.truncation).toBeUndefined();
    expect(outcomes[1]?.truncation).toEqual(truncation);
  });

  it('a caller cancellation rejects instead of returning the studies that finished', async () => {
    const controller = new AbortController();
    const args = baseArgs(
      ['s0', 's1', 's2'],
      1,
      false,
      createMockContext({ signal: controller.signal }),
    );
    const seen: string[] = [];
    const pull = async (a: PullStudyObservationsArgs): Promise<StudyPull | null> => {
      seen.push(a.studyDbId);
      if (a.studyDbId === 's1') controller.abort();
      return pulled(a.studyDbId);
    };

    await expect(pullObservationsForStudies(args, pull)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
    });
    // s2's batch is never launched once the signal has fired.
    expect(seen).toEqual(['s0', 's1']);
  });
});

// ---------------------------------------------------------------------------
// pullStudyObservations — real client over a stubbed global fetch
// ---------------------------------------------------------------------------

const HOST = 'brapi.example.org';
const BASE_URL = `https://${HOST}/brapi/v2`;

const PROFILE = {
  observations: { service: 'observations', methods: ['GET' as const] },
  observationunits: { service: 'observationunits', methods: ['GET' as const] },
};

type Route = (u: URL, signal: AbortSignal) => Response | Promise<Response>;

/** Route the global fetch to `route` for the test host; returns every URL requested. */
function upstream(route: Route): URL[] {
  const requests: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(input instanceof Request ? input.url : String(input));
      if (u.hostname !== HOST) throw new Error(`Unmocked global fetch: ${u.toString()}`);
      requests.push(u);
      return await route(u, init?.signal as AbortSignal);
    }),
  );
  return requests;
}

/** A response that never arrives — settles only when the request is aborted. */
function hang(signal: AbortSignal): Promise<Response> {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** One observation row; `germplasmDbId` defaults to a per-row id. */
function row(i: number, germplasmDbId = `g${i}`, studyDbId = 's1') {
  return {
    observationDbId: `o${i}`,
    observationVariableDbId: 'v1',
    observationVariableName: 'Height',
    germplasmDbId,
    studyDbId,
    value: String(i),
  };
}

/** Serve one page of `rows` honoring only `page` / `pageSize`. */
function pageOf(u: URL, rows: Record<string, unknown>[], withTotal = true): Response {
  const pageSize = Number(u.searchParams.get('pageSize'));
  const page = Number(u.searchParams.get('page') ?? '0');
  const data = rows.slice(page * pageSize, (page + 1) * pageSize);
  return jsonResponse(envelope({ data }, withTotal ? { totalCount: rows.length } : undefined));
}

const emptyPage = () => jsonResponse(envelope({ data: [] }, { totalCount: 0 }));

/** A context whose call deadline (`CALL_DEADLINE_MS` from its timestamp) is `remainingMs` away. */
function ctxWithRemaining(remainingMs: number): Context {
  return {
    ...createMockContext(),
    timestamp: new Date(Date.now() - (CALL_DEADLINE_MS - remainingMs)).toISOString(),
  };
}

function studyArgs(
  over: {
    config?: Partial<ServerConfig>;
    ctx?: Context;
    /** Time left of the call deadline; defaults to a call that just started. */
    remainingMs?: number;
    dialect?: BrapiDialect;
    input?: ObservationPullFilters;
    loadLimit?: number;
    profile?: PullStudyObservationsArgs['profile'];
  } = {},
): PullStudyObservationsArgs {
  const config: ServerConfig = { ...TEST_CONFIG, allowPrivateIps: true, ...over.config };
  return {
    client: new BrapiClient(config),
    config,
    connection: { alias: 'test', baseUrl: BASE_URL } as RegisteredServer,
    ctx:
      over.ctx ??
      (over.remainingMs === undefined ? createMockContext() : ctxWithRemaining(over.remainingMs)),
    dialect: over.dialect ?? specDialect,
    input: over.input ?? {},
    loadLimit: over.loadLimit ?? 100,
    profile: over.profile ?? PROFILE,
    studyDbId: 's1',
    warnings: [],
  };
}

const paths = (requests: URL[]) => requests.map((u) => u.pathname.replace('/brapi/v2', ''));

describe('pullStudyObservations', () => {
  beforeEach(() => {
    upstream((u) => {
      throw new Error(`Unrouted request: ${u.toString()}`);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('/observations page walk', () => {
    it('pages against totalCount until the study is exhausted, with no warning for an honored filter', async () => {
      const rows = Array.from({ length: 25 }, (_, i) => row(i));
      const requests = upstream((u) => pageOf(u, rows));
      const args = studyArgs();

      const result = await pullStudyObservations(args);

      expect(result?.observations).toHaveLength(25);
      expect(result?.truncation).toBeUndefined();
      expect(requests.map((u) => u.searchParams.get('page'))).toEqual(['0', '1', '2']);
      expect(requests.every((u) => u.searchParams.get('pageSize') === '10')).toBe(true);
      expect(args.warnings).toEqual([]);
    });

    it('finds a germplasm subset on a later page when the upstream ignores germplasmDbId', async () => {
      const rows = Array.from({ length: 25 }, (_, i) => row(i, i >= 22 ? 'target' : `g${i}`));
      const requests = upstream((u) => pageOf(u, rows));

      const result = await pullStudyObservations(studyArgs({ input: { germplasm: ['target'] } }));

      expect(result?.observations.map((o) => o.value)).toEqual(['22', '23', '24']);
      expect(result?.truncation).toBeUndefined();
      expect(requests).toHaveLength(3);
      // The filter was sent; the upstream ignored it.
      expect(requests[0]?.searchParams.getAll('germplasmDbIds')).toEqual(['target']);
    });

    it('keeps only the study’s rows when the upstream ignores studyDbId, and says so', async () => {
      // An upstream that ignores every filter: the global set, two studies interleaved.
      const rows = Array.from({ length: 25 }, (_, i) =>
        row(i, i % 2 === 0 ? 'target' : `g${i}`, i % 5 === 0 ? 'sOther' : 's1'),
      );
      upstream((u) => pageOf(u, rows));
      const args = studyArgs({ input: { germplasm: ['target'] } });

      const result = await pullStudyObservations(args);

      const kept = result?.observations ?? [];
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.every((o) => o.studyDbId === 's1' && o.germplasmDbId === 'target')).toBe(true);
      // Rows 0, 10, 20 are the target germplasm in the other study.
      expect(kept.map((o) => o.value)).toEqual([
        '2',
        '4',
        '6',
        '8',
        '12',
        '14',
        '16',
        '18',
        '22',
        '24',
      ]);
      expect(result?.rawRows.map((r) => r.observationDbId)).toEqual(kept.map((o) => `o${o.value}`));
      expect(args.warnings.join('\n')).toMatch(
        /Study 's1': \/observations returned 5 rows from other studies/,
      );
    });

    // A stop counts the rows examined: mid-page, the row proving more matches
    // exist is the last one read; the rest of the page never is.
    it.each([
      {
        label: 'stops at loadLimit mid-page, counting the row that proves more matches exist',
        total: 25,
        loadLimit: 5,
        values: ['0', '1', '2', '3', '4'],
        requests: 1,
        truncation: { reason: 'reached loadLimit (5) matching rows', scanned: 6, totalCount: 25 },
      },
      {
        label: 'a loadLimit stop mid-page on a later page counts only the rows examined',
        total: 25,
        // The matches sit at rows 21–23 (third page); loadLimit 2 stops on the third.
        targets: [21, 23],
        loadLimit: 2,
        values: ['21', '22'],
        requests: 3,
        truncation: { reason: 'reached loadLimit (2) matching rows', scanned: 24, totalCount: 25 },
      },
      {
        label: 'a page that fills loadLimit exactly mid-study stops the walk as truncated',
        total: 25,
        loadLimit: 10,
        values: Array.from({ length: 10 }, (_, i) => String(i)),
        requests: 1,
        truncation: { reason: 'reached loadLimit (10) matching rows', scanned: 10, totalCount: 25 },
      },
      {
        label: 'rows exactly filling loadLimit at totalCount are not a truncation',
        total: 10,
        loadLimit: 10,
        values: Array.from({ length: 10 }, (_, i) => String(i)),
        requests: 1,
      },
    ])('$label', async ({ total, targets, loadLimit, values, requests, truncation }) => {
      const rows = Array.from({ length: total }, (_, i) =>
        row(i, targets && i >= targets[0] && i <= targets[1] ? 'target' : `g${i}`),
      );
      const sent = upstream((u) => pageOf(u, rows));
      const args = studyArgs({ loadLimit, ...(targets && { input: { germplasm: ['target'] } }) });

      const result = await pullStudyObservations(args);

      expect(result?.observations.map((o) => o.value)).toEqual(values);
      expect(sent).toHaveLength(requests);
      expect(result?.truncation).toEqual(truncation);
      if (truncation) {
        expect(args.warnings.join('\n')).toMatch(
          new RegExp(`Study 's1'.*stopped after ${truncation.scanned} of ${total} rows`),
        );
      }
    });

    it('without a totalCount, walks until a short page', async () => {
      const rows = Array.from({ length: 15 }, (_, i) => row(i));
      const requests = upstream((u) => pageOf(u, rows, false));

      const result = await pullStudyObservations(studyArgs());

      expect(result?.observations).toHaveLength(15);
      expect(result?.truncation).toBeUndefined();
      expect(requests).toHaveLength(2);
    });

    it('stops at the page cap and reports truncation', async () => {
      const rows = Array.from({ length: MAX_SPILLOVER_PAGES * 10 + 7 }, (_, i) => row(i, 'g'));
      const requests = upstream((u) => pageOf(u, rows));

      const result = await pullStudyObservations(
        studyArgs({ input: { germplasm: ['nobody'] }, loadLimit: 10 }),
      );

      expect(requests).toHaveLength(MAX_SPILLOVER_PAGES);
      expect(result?.observations).toEqual([]);
      expect(result?.truncation).toEqual({
        reason: `reached the ${MAX_SPILLOVER_PAGES}-page cap`,
        scanned: MAX_SPILLOVER_PAGES * 10,
        totalCount: MAX_SPILLOVER_PAGES * 10 + 7,
      });
    });

    it('a later page failure keeps the collected rows and reports truncation with the status', async () => {
      const rows = Array.from({ length: 25 }, (_, i) => row(i));
      upstream((u) =>
        u.searchParams.get('page') === '1'
          ? new Response('upstream down', { status: 503 })
          : pageOf(u, rows),
      );

      const result = await pullStudyObservations(studyArgs({ config: { retryMaxAttempts: 1 } }));

      expect(result?.observations).toHaveLength(10);
      expect(result?.truncation).toEqual({
        reason: 'page 2 failed (HTTP 503 after 2 attempts)',
        scanned: 10,
        totalCount: 25,
      });
    });

    it('an empty page before totalCount is a truncation, not the end of the study', async () => {
      const rows = Array.from({ length: 25 }, (_, i) => row(i));
      upstream((u) =>
        u.searchParams.get('page') === '1'
          ? jsonResponse(envelope({ data: [] }, { totalCount: 25 }))
          : pageOf(u, rows),
      );

      const result = await pullStudyObservations(studyArgs());

      expect(result?.truncation).toEqual({
        reason: 'page 2 came back empty',
        scanned: 10,
        totalCount: 25,
      });
    });
  });

  describe('request budget', () => {
    it('retries a 5xx on /observations and returns the rows', async () => {
      let attempts = 0;
      const requests = upstream((u) => {
        attempts++;
        return attempts === 1 ? new Response('busy', { status: 503 }) : pageOf(u, [row(1), row(2)]);
      });

      const result = await pullStudyObservations(studyArgs({ config: { retryMaxAttempts: 2 } }));

      expect(result?.observations).toHaveLength(2);
      expect(paths(requests)).toEqual(['/observations', '/observations']);
    });

    it('a first-page timeout is not retried and sends no fallback request', async () => {
      const requests = upstream((_, signal) => hang(signal));

      await expect(
        pullStudyObservations(studyArgs({ config: { requestTimeoutMs: 50, retryMaxAttempts: 3 } })),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.Timeout });

      expect(paths(requests)).toEqual(['/observations']);
    });

    it('the call deadline aborts a request in flight, well before the per-request timeout', async () => {
      const requests = upstream((_, signal) => hang(signal));
      const started = Date.now();

      await expect(
        pullStudyObservations(studyArgs({ config: { requestTimeoutMs: 30_000 }, remainingMs: 80 })),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'call_deadline_exceeded' },
      });

      expect(Date.now() - started).toBeLessThan(5_000);
      expect(requests).toHaveLength(1);
    });

    it('the call deadline also bounds retry backoff', async () => {
      const requests = upstream(() => new Response('busy', { status: 503 }));
      const started = Date.now();

      await expect(
        pullStudyObservations(
          studyArgs({
            config: { retryMaxAttempts: 10, retryBaseDelayMs: 1_000 },
            remainingMs: 150,
            profile: { observations: PROFILE.observations },
          }),
        ),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.Timeout });

      expect(Date.now() - started).toBeLessThan(5_000);
      expect(requests.length).toBeLessThan(10);
    });

    it('a later page cut off by the call deadline is a truncation, not a failure', async () => {
      const rows = Array.from({ length: 25 }, (_, i) => row(i));
      upstream((u, signal) =>
        u.searchParams.get('page') === '1' ? hang(signal) : pageOf(u, rows),
      );

      const result = await pullStudyObservations(studyArgs({ remainingMs: 150 }));

      expect(result?.observations).toHaveLength(10);
      expect(result?.truncation?.reason).toMatch(/^page 2 failed .*deadline/);
    });
  });

  describe('fallback chain and failure contract', () => {
    it.each([
      ['/observations 0 rows and 0 units is an empty success', emptyPage, /No observations found/],
      [
        'a /observations 5xx with 0 units stays an empty success naming the failure and its status',
        () => new Response('boom', { status: 500 }),
        /\/observations failed \(HTTP 500\) and \/observationunits lists 0 observation units/,
      ],
    ])('%s', async (_label, observations, warning) => {
      const requests = upstream((u) =>
        u.pathname.endsWith('/observations') ? observations() : emptyPage(),
      );
      const args = studyArgs();

      const result = await pullStudyObservations(args);

      expect(result).toEqual({ observations: [], rawRows: [] });
      expect(paths(requests)).toEqual(['/observations', '/observationunits']);
      expect(args.warnings.at(-1)).toMatch(warning);
    });

    it('a dialect that drops the study filter goes straight to /observationunits', async () => {
      const requests = upstream((u) =>
        jsonResponse(
          envelope(
            {
              data: [
                {
                  observationUnitDbId: 'ou1',
                  germplasmDbId: 'g1',
                  studyDbId: 's1',
                  observations: [{ observationVariableDbId: 'v1', value: '7' }],
                },
              ],
            },
            { totalCount: u.pathname.endsWith('/observationunits') ? 1 : 0 },
          ),
        ),
      );
      const args = studyArgs({ dialect: brapiTestDialect });

      const result = await pullStudyObservations(args);

      expect(paths(requests)).toEqual(['/observationunits']);
      expect(result?.observations.map((o) => o.value)).toEqual(['7']);
    });

    it("embedded observations keep only the study's units and the requested subsets", async () => {
      // /observations has nothing; /observationunits ignores studyDbId, so a
      // unit from another study rides along.
      upstream((u) =>
        u.pathname.endsWith('/observations')
          ? emptyPage()
          : jsonResponse(
              envelope(
                {
                  data: [
                    {
                      observationUnitDbId: 'ou1',
                      germplasmDbId: 'g1',
                      studyDbId: 's1',
                      observations: [
                        { observationDbId: 'o1', observationVariableDbId: 'v1', value: '7' },
                        { observationDbId: 'o2', observationVariableDbId: 'v2', value: '8' },
                      ],
                    },
                    {
                      observationUnitDbId: 'ou2',
                      germplasmDbId: 'g1',
                      studyDbId: 'sOther',
                      observations: [
                        { observationDbId: 'o3', observationVariableDbId: 'v1', value: '9' },
                      ],
                    },
                    {
                      observationUnitDbId: 'ou3',
                      germplasmDbId: 'g2',
                      studyDbId: 's1',
                      observations: [
                        { observationDbId: 'o4', observationVariableDbId: 'v1', value: '10' },
                      ],
                    },
                  ],
                },
                { totalCount: 3 },
              ),
            ),
      );
      const args = studyArgs({ input: { germplasm: ['g1'], variables: ['v1'] } });

      const result = await pullStudyObservations(args);

      expect(result?.observations.map((o) => [o.studyDbId, o.value])).toEqual([['s1', '7']]);
      expect(result?.rawRows.map((r) => r.observationDbId)).toEqual(['o1']);
    });

    it('a non-timeout /observations failure falls back; embedded unit observations answer with the failure named', async () => {
      const requests = upstream((u) =>
        u.pathname.endsWith('/observations')
          ? new Response('<html>error</html>', { status: 500 })
          : jsonResponse(
              envelope(
                {
                  data: [
                    {
                      observationUnitDbId: 'ou1',
                      germplasmDbId: 'g1',
                      studyDbId: 's1',
                      observations: [{ observationVariableDbId: 'v1', value: '7' }],
                    },
                  ],
                },
                { totalCount: 1 },
              ),
            ),
      );
      const args = studyArgs();

      const result = await pullStudyObservations(args);

      expect(result?.observations).toHaveLength(1);
      expect(paths(requests)).toEqual(['/observations', '/observationunits']);
      expect(args.warnings.join('\n')).toMatch(
        /embedded .* after \/observations failed \(HTTP 500/,
      );
    });

    it('a non-timeout /observations failure with units that answer nothing definitive fails with the first error', async () => {
      upstream((u) => {
        if (u.pathname.endsWith('/observationunits')) {
          return jsonResponse(
            envelope(
              { data: [{ observationUnitDbId: 'ou1', germplasmDbId: 'g1', studyDbId: 's1' }] },
              { totalCount: 1 },
            ),
          );
        }
        // Study-anchored pull fails; the per-germplasm pull answers with another study's rows.
        if (u.searchParams.has('studyDbIds')) return new Response('boom', { status: 500 });
        return pageOf(u, [row(1, 'g1', 'other-study')]);
      });

      await expect(pullStudyObservations(studyArgs())).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { status: 500 },
      });
    });

    it('/observationunits failing after a 0-row /observations fails the study', async () => {
      upstream((u) =>
        u.pathname.endsWith('/observationunits')
          ? new Response('boom', { status: 502 })
          : emptyPage(),
      );

      await expect(pullStudyObservations(studyArgs())).rejects.toMatchObject({
        data: { status: 502 },
      });
    });

    it('the germplasm fallback requests nothing after its first failure', async () => {
      const requests = upstream((u) => {
        if (u.pathname.endsWith('/observationunits')) {
          return jsonResponse(
            envelope(
              {
                data: ['g1', 'g2', 'g3'].map((g) => ({
                  observationUnitDbId: `u_${g}`,
                  germplasmDbId: g,
                  studyDbId: 's1',
                })),
              },
              { totalCount: 3 },
            ),
          );
        }
        if (u.searchParams.has('studyDbIds')) return emptyPage();
        return new Response('down', { status: 503 });
      });

      await expect(
        pullStudyObservations(studyArgs({ config: { retryMaxAttempts: 1 } })),
      ).rejects.toMatchObject({ data: { status: 503 } });

      const germplasmRequests = requests.filter((u) => u.searchParams.has('germplasmDbIds'));
      // One germplasm, two attempts (one retry) — g2 and g3 are never requested.
      expect(germplasmRequests.map((u) => u.searchParams.get('germplasmDbIds'))).toEqual([
        'g1',
        'g1',
      ]);
    });

    it("the germplasm fallback keeps only the study's rows within the requested germplasm and variables", async () => {
      const requests = upstream((u) => {
        if (u.pathname.endsWith('/observationunits')) {
          return jsonResponse(
            envelope(
              {
                data: ['g1', 'g2'].map((g) => ({
                  observationUnitDbId: `u_${g}`,
                  germplasmDbId: g,
                  studyDbId: 's1',
                })),
              },
              { totalCount: 2 },
            ),
          );
        }
        if (u.searchParams.has('studyDbIds')) return emptyPage();
        // The per-germplasm request ignores its filter and answers other studies and variables too.
        return jsonResponse(
          envelope({
            data: [
              { ...row(1, 'g1'), observationVariableDbId: 'v1' },
              { ...row(2, 'g1'), observationVariableDbId: 'v2' },
              { ...row(3, 'g1', 'sOther'), observationVariableDbId: 'v1' },
              { ...row(4, 'g2'), observationVariableDbId: 'v1' },
            ],
          }),
        );
      });

      const result = await pullStudyObservations(
        studyArgs({ input: { germplasm: ['g1'], variables: ['v1'] } }),
      );

      expect(result?.observations.map((o) => o.value)).toEqual(['1']);
      expect(result?.rawRows.map((r) => r.observationDbId)).toEqual(['o1']);
      // Only the requested germplasm is fanned out to.
      expect(
        requests
          .filter((u) => !u.searchParams.has('studyDbIds'))
          .map((u) => u.searchParams.getAll('germplasmDbIds')),
      ).toEqual([['g1']]);
    });

    it('a dialect dropping every /observationunits filter still propagates dialect_all_filters_dropped', async () => {
      upstream(() => emptyPage());
      const dropsUnitFilters = {
        ...specDialect,
        id: 'drops-unit-filters',
        adaptGetFilters: (endpoint: string, filters: Readonly<Record<string, unknown>>) =>
          endpoint === 'observationunits'
            ? { filters: {}, dropped: Object.keys(filters), warnings: [] }
            : specDialect.adaptGetFilters(endpoint, filters),
      } as BrapiDialect;

      await expect(
        pullStudyObservations(
          studyArgs({
            dialect: dropsUnitFilters,
            profile: { observationunits: PROFILE.observationunits },
          }),
        ),
      ).rejects.toMatchObject({ data: { reason: 'dialect_all_filters_dropped' } });
    });
  });

  it('one call deadline spans studies: a study whose turn comes after it fails without a request', async () => {
    const requests = upstream((u, signal) =>
      u.searchParams.get('studyDbIds') === 'slow' ? hang(signal) : emptyPage(),
    );
    const args = studyArgs({ remainingMs: 100 });

    const outcomes = await pullObservationsForStudies({
      ...args,
      config: { ...args.config, maxConcurrentRequests: 1 },
      studyDbIds: ['slow', 'late'],
      failFast: false,
    });

    expect(outcomes.map((o) => (o.error as { code?: number } | undefined)?.code)).toEqual([
      JsonRpcErrorCode.Timeout,
      JsonRpcErrorCode.Timeout,
    ]);
    expect(requests.every((u) => u.searchParams.get('studyDbIds') === 'slow')).toBe(true);
  });
});
