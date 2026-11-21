/**
 * @fileoverview Unit tests for ReferenceDataCache. Exercises batch caching,
 * cache-hit/miss partitioning, dedup, the detail-route vs list-filter choice
 * per noun, and miss warnings.
 *
 * @module tests/services/reference-data-cache.test
 */

import {
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { BrapiClient, type BrapiEnvelope, type Fetcher } from '@/services/brapi-client/index.js';
import { breedbaseDialect, cassavabaseDialect } from '@/services/brapi-dialect/index.js';
import type { BrapiDialect } from '@/services/brapi-dialect/types.js';
import type { CallDescriptor, CapabilityProfile } from '@/services/capability-registry/types.js';
import { ReferenceDataCache } from '@/services/reference-data-cache/reference-data-cache.js';
import type { Location, Program, Trial } from '@/services/reference-data-cache/types.js';

const BASE_URL = 'https://brapi.example.org/brapi/v2';

const baseConfig: ServerConfig = {
  defaultApiKeyHeader: 'Authorization',
  datasetTtlSeconds: 86_400,
  loadLimit: 200,
  maxConcurrentRequests: 4,
  retryMaxAttempts: 0,
  retryBaseDelayMs: 1,
  referenceCacheTtlSeconds: 3_600,
  requestTimeoutMs: 1_000,
  callDeadlineMs: 50_000,
  companionTimeoutMs: 500,
  searchPollTimeoutMs: 5_000,
  searchPollIntervalMs: 1,
  allowPrivateIps: false,
  enableWrites: false,
};

function envelope<T>(result: T): BrapiEnvelope<T> {
  return { metadata: {}, result };
}

type MockBrapiClient = {
  get: ReturnType<typeof vi.fn>;
  postSearch: ReturnType<typeof vi.fn>;
  getSearchResults: ReturnType<typeof vi.fn>;
};

function makeClient(): MockBrapiClient {
  return { get: vi.fn(), postSearch: vi.fn(), getSearchResults: vi.fn() };
}

function makeCache(client: MockBrapiClient) {
  return new ReferenceDataCache(baseConfig, () => client as unknown as BrapiClient);
}

describe('ReferenceDataCache', () => {
  let client: MockBrapiClient;
  let cache: ReferenceDataCache;

  beforeEach(() => {
    client = makeClient();
    cache = makeCache(client);
  });

  describe('getPrograms', () => {
    it('returns an empty map when ids is empty without hitting the client', async () => {
      const ctx = createMockContext({ tenantId: 'test-tenant' });
      const result = await cache.getPrograms(BASE_URL, [], ctx);
      expect(result.size).toBe(0);
      expect(client.get).not.toHaveBeenCalled();
    });

    it('fetches missing programs and caches them', async () => {
      client.get.mockResolvedValue(
        envelope<{ data: Program[] }>({
          data: [
            { programDbId: 'p1', programName: 'Cassava Breeding' },
            { programDbId: 'p2', programName: 'Yam Diversity' },
          ],
        }),
      );
      const ctx = createMockContext({ tenantId: 'test-tenant' });

      const first = await cache.getPrograms(BASE_URL, ['p1', 'p2'], ctx);
      expect(first.get('p1')?.programName).toBe('Cassava Breeding');
      expect(first.get('p2')?.programName).toBe('Yam Diversity');
      expect(client.get).toHaveBeenCalledTimes(1);
      const call = client.get.mock.calls[0]!;
      expect(call[1]).toBe('/programs');
      expect((call[3] as { params: { programDbIds: string[] } }).params.programDbIds).toEqual([
        'p1',
        'p2',
      ]);

      // Second call — entirely cached.
      const second = await cache.getPrograms(BASE_URL, ['p1', 'p2'], ctx);
      expect(second.get('p1')?.programName).toBe('Cassava Breeding');
      expect(client.get).toHaveBeenCalledTimes(1);
    });

    it('keeps servers whose URLs differ only in punctuation apart', async () => {
      client.get.mockImplementation(async (base: string) =>
        envelope<{ data: Program[] }>({ data: [{ programDbId: 'p1', programName: base }] }),
      );
      const ctx = createMockContext({ tenantId: 'test-tenant' });
      const a = 'https://a.b/brapi/v2';
      const b = 'https://a-b/brapi/v2';
      expect((await cache.getPrograms(a, ['p1'], ctx)).get('p1')?.programName).toBe(a);
      expect((await cache.getPrograms(b, ['p1'], ctx)).get('p1')?.programName).toBe(b);
    });

    it('partitions cache hits from misses and only fetches the missing subset', async () => {
      const ctx = createMockContext({ tenantId: 'test-tenant' });

      client.get.mockResolvedValueOnce(
        envelope<{ data: Program[] }>({
          data: [{ programDbId: 'p1', programName: 'First' }],
        }),
      );
      await cache.getPrograms(BASE_URL, ['p1'], ctx);

      client.get.mockResolvedValueOnce(
        envelope<{ data: Program[] }>({
          data: [{ programDbId: 'p2', programName: 'Second' }],
        }),
      );
      const result = await cache.getPrograms(BASE_URL, ['p1', 'p2'], ctx);

      expect(result.get('p1')?.programName).toBe('First');
      expect(result.get('p2')?.programName).toBe('Second');
      // Second fetch carried only the missing id.
      const secondFetchCall = client.get.mock.calls[1]!;
      expect(
        (secondFetchCall[3] as { params: { programDbIds: string[] } }).params.programDbIds,
      ).toEqual(['p2']);
    });

    it('dedupes repeated ids in the input before fetching', async () => {
      client.get.mockResolvedValue(
        envelope<{ data: Program[] }>({
          data: [{ programDbId: 'p1', programName: 'Only' }],
        }),
      );
      const ctx = createMockContext({ tenantId: 'test-tenant' });

      await cache.getPrograms(BASE_URL, ['p1', 'p1', 'p1'], ctx);
      const call = client.get.mock.calls[0]!;
      expect((call[3] as { params: { programDbIds: string[] } }).params.programDbIds).toEqual([
        'p1',
      ]);
    });

    it('silently drops fetched items missing the id field', async () => {
      client.get.mockResolvedValue(
        envelope<{ data: Partial<Program>[] }>({
          data: [
            { programDbId: 'p1', programName: 'Good' },
            { programName: 'Ghost' }, // missing id
          ],
        }),
      );
      const ctx = createMockContext({ tenantId: 'test-tenant' });

      const result = await cache.getPrograms(BASE_URL, ['p1', 'ghost-id'], ctx);
      expect(result.size).toBe(1);
      expect(result.get('p1')?.programName).toBe('Good');
      expect(result.has('ghost-id')).toBe(false);
    });

    it('forwards auth on upstream calls', async () => {
      client.get.mockResolvedValue(envelope<{ data: Program[] }>({ data: [] }));
      const ctx = createMockContext({ tenantId: 'test-tenant' });
      const auth = { headerName: 'Authorization', headerValue: 'Bearer abc' };

      await cache.getPrograms(BASE_URL, ['p1'], ctx, { auth });
      const call = client.get.mock.calls[0]!;
      expect((call[3] as { auth: typeof auth }).auth).toEqual(auth);
    });
  });

  describe('getTrials', () => {
    it('routes to /trials with trialDbIds param', async () => {
      client.get.mockResolvedValue(
        envelope<{ data: Trial[] }>({
          data: [{ trialDbId: 't1', trialName: 'Advanced Yield' }],
        }),
      );
      const ctx = createMockContext({ tenantId: 'test-tenant' });

      const result = await cache.getTrials(BASE_URL, ['t1'], ctx);
      expect(result.get('t1')?.trialName).toBe('Advanced Yield');
      const call = client.get.mock.calls[0]!;
      expect(call[1]).toBe('/trials');
      expect((call[3] as { params: { trialDbIds: string[] } }).params.trialDbIds).toEqual(['t1']);
    });
  });

  describe('getLocations', () => {
    it('routes to /locations with locationDbIds param', async () => {
      client.get.mockResolvedValue(
        envelope<{ data: Location[] }>({
          data: [{ locationDbId: 'l1', locationName: 'Ibadan' }],
        }),
      );
      const ctx = createMockContext({ tenantId: 'test-tenant' });

      const result = await cache.getLocations(BASE_URL, ['l1'], ctx);
      expect(result.get('l1')?.locationName).toBe('Ibadan');
      const call = client.get.mock.calls[0]!;
      expect(call[1]).toBe('/locations');
      expect((call[3] as { params: { locationDbIds: string[] } }).params.locationDbIds).toEqual([
        'l1',
      ]);
    });
  });

  // The v0.4.7 foundational fix: ReferenceDataCache forwards the dialect into
  // the client so plural ID filters get translated to whatever the active
  // server actually honors. Before this, the cache hardcoded the v2.1 plural
  // (`trialDbIds`, `programDbIds`, `locationDbIds`) and SGN-family servers
  // silently ignored the filter — returning a page-zero row instead of the
  // requested record.
  describe('dialect threading', () => {
    it('forwards dialect to the client so the client can translate plurals', async () => {
      client.get.mockResolvedValue(
        envelope<{ data: Trial[] }>({
          data: [{ trialDbId: 't1', trialName: 'Advanced Yield' }],
        }),
      );
      const ctx = createMockContext({ tenantId: 'test-tenant' });

      await cache.getTrials(BASE_URL, ['t1'], ctx, { dialect: cassavabaseDialect });

      const call = client.get.mock.calls[0]!;
      const opts = call[3] as { dialect?: BrapiDialect };
      expect(opts.dialect?.id).toBe('cassavabase');
    });

    it('rethrows non-dialect errors so transient upstream failures are visible', async () => {
      client.get.mockRejectedValue({ code: JsonRpcErrorCode.ServiceUnavailable });
      const ctx = createMockContext({ tenantId: 'test-tenant' });

      await expect(
        cache.getTrials(BASE_URL, ['t1'], ctx, { dialect: cassavabaseDialect }),
      ).rejects.toEqual({ code: JsonRpcErrorCode.ServiceUnavailable });
    });
  });
});

/**
 * Route choice and miss handling through the real BrapiClient, so the
 * singleton 5xx → NotFound reclassification and the companion request options
 * run as they do in production; only the network fetch is faked.
 */
describe('ReferenceDataCache foreign-key routes (#125)', () => {
  function profileWith(calls: CallDescriptor[]): CapabilityProfile {
    const supported: Record<string, CallDescriptor> = {};
    for (const call of calls) supported[call.service] = call;
    return {
      baseUrl: BASE_URL,
      crops: [],
      fetchedAt: '2026-01-01T00:00:00Z',
      server: {},
      supported,
    };
  }

  /** SGN-shaped discovery: every collection and detail route listed with GET. */
  const DETAIL_PROFILE = profileWith(
    [
      'programs',
      'trials',
      'locations',
      'programs/{programDbId}',
      'trials/{trialDbId}',
      'locations/{locationDbId}',
    ].map((service) => ({ service, methods: ['GET'] })),
  );

  let fetcher: ReturnType<typeof vi.fn>;
  let cache: ReferenceDataCache;

  beforeEach(() => {
    fetcher = vi.fn();
    const client = new BrapiClient(baseConfig, fetcher as unknown as Fetcher);
    cache = new ReferenceDataCache(baseConfig, () => client);
  });

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  const requested = () => fetcher.mock.calls.map((c) => new URL(String(c[0])));
  const lastSegment = (url: unknown) => decodeURIComponent(String(url).split('/').pop() ?? '');
  const notFound404 = () =>
    new McpError(JsonRpcErrorCode.NotFound, 'Fetch failed. Status: 404', { status: 404 });

  it('resolves each ID through GET /{noun}/{id} on the companion budget and caches the record', async () => {
    fetcher.mockImplementation(async (url: string) =>
      json(envelope({ programDbId: lastSegment(url), programName: 'NCSU' })),
    );
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const warnings: string[] = [];

    const first = await cache.getPrograms(BASE_URL, ['132'], ctx, {
      profile: DETAIL_PROFILE,
      warnings,
    });

    expect(first.get('132')).toEqual({ programDbId: '132', programName: 'NCSU' });
    expect(warnings).toEqual([]);
    expect(requested().map((u) => u.pathname)).toEqual(['/brapi/v2/programs/132']);
    expect(fetcher.mock.calls[0]![1]).toBe(baseConfig.companionTimeoutMs);

    const second = await cache.getPrograms(BASE_URL, ['132'], ctx, { profile: DETAIL_PROFILE });
    expect(second.get('132')?.programName).toBe('NCSU');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'HTTP 404',
      async () => {
        throw notFound404();
      },
    ],
    [
      'the HTTP 500 SGN serves for an unknown ID',
      async () => {
        throw serviceUnavailable('Fetch failed. Status: 500', { status: 500, body: '<html>' });
      },
    ],
    [
      'HTTP 200 with result: null',
      async () =>
        json({
          metadata: {
            status: [{ message: 'The given trialDbId not found.', messageType: 'ERROR' }],
          },
          result: null,
        }),
    ],
    ['HTTP 200 carrying another record', async () => json(envelope({ trialDbId: 't-other' }))],
  ])(
    'treats %s as a final miss: warns, sends no list request, caches nothing',
    async (_label, answer) => {
      fetcher.mockImplementation(answer);
      const ctx = createMockContext({ tenantId: 'test-tenant' });
      const warnings: string[] = [];

      const result = await cache.getTrials(BASE_URL, ['t1'], ctx, {
        profile: DETAIL_PROFILE,
        warnings,
      });

      expect(result.size).toBe(0);
      expect(warnings).toEqual([
        "trial 't1' not found: GET /trials/t1 returned no matching record.",
      ]);
      expect(requested().map((u) => u.pathname)).toEqual(['/brapi/v2/trials/t1']);

      await cache.getTrials(BASE_URL, ['t1'], ctx, { profile: DETAIL_PROFILE });
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it('resolves a mix of hits and misses per ID, warning for each miss', async () => {
    fetcher.mockImplementation(async (url: string) => {
      const id = lastSegment(url);
      if (id === 'l2') throw notFound404();
      return json(envelope({ locationDbId: id }));
    });
    const warnings: string[] = [];

    const result = await cache.getLocations(
      BASE_URL,
      ['l1', 'l2', 'l3'],
      createMockContext({ tenantId: 'test-tenant' }),
      { profile: DETAIL_PROFILE, warnings },
    );

    expect([...result.keys()].sort()).toEqual(['l1', 'l3']);
    expect(warnings).toEqual([
      "location 'l2' not found: GET /locations/l2 returned no matching record.",
    ]);
    expect(requested().map((u) => u.pathname)).toEqual([
      '/brapi/v2/locations/l1',
      '/brapi/v2/locations/l2',
      '/brapi/v2/locations/l3',
    ]);
  });

  it('bounds concurrent detail requests by maxConcurrentRequests', async () => {
    const limit = baseConfig.maxConcurrentRequests;
    let inflight = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetcher.mockImplementation(async (url: string) => {
      inflight++;
      peak = Math.max(peak, inflight);
      if (inflight === limit) release();
      await gate;
      inflight--;
      return json(envelope({ programDbId: lastSegment(url) }));
    });
    const ids = Array.from({ length: limit + 2 }, (_, i) => `p${i}`);

    const result = await cache.getPrograms(
      BASE_URL,
      ids,
      createMockContext({ tenantId: 'test-tenant' }),
      { profile: DETAIL_PROFILE },
    );

    expect(result.size).toBe(ids.length);
    expect(peak).toBe(limit);
  });

  it('hands out no further IDs once a detail request fails', async () => {
    const client = new BrapiClient(baseConfig, fetcher as unknown as Fetcher);
    const twoWorkers = new ReferenceDataCache(
      { ...baseConfig, maxConcurrentRequests: 2 },
      () => client,
    );
    fetcher.mockImplementation(async (url: string, timeoutMs: number) => {
      const id = lastSegment(url);
      if (id === 'p1') {
        throw timeout(`Fetch timed out after ${timeoutMs}ms`, { errorSource: 'FetchTimeout' });
      }
      // The other worker's request answers after p1's failure has settled.
      await new Promise((resolve) => setImmediate(resolve));
      return json(envelope({ programDbId: id }));
    });

    await expect(
      twoWorkers.getPrograms(
        BASE_URL,
        ['p1', 'p2', 'p3', 'p4'],
        createMockContext({ tenantId: 'test-tenant' }),
        { profile: DETAIL_PROFILE },
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.Timeout });
    expect(requested().map((u) => u.pathname)).toEqual([
      '/brapi/v2/programs/p1',
      '/brapi/v2/programs/p2',
    ]);
  });

  it('encodes the ID into the detail path', async () => {
    fetcher.mockImplementation(async () => json(envelope({ programDbId: 'odd/id' })));

    const result = await cache.getPrograms(
      BASE_URL,
      ['odd/id'],
      createMockContext({ tenantId: 'test-tenant' }),
      { profile: DETAIL_PROFILE },
    );

    expect(result.has('odd/id')).toBe(true);
    expect(String(fetcher.mock.calls[0]![0])).toContain('/programs/odd%2Fid');
  });

  it('propagates a detail timeout without a list follow-up', async () => {
    fetcher.mockImplementation(async (_url: string, timeoutMs: number) => {
      throw timeout(`Fetch timed out after ${timeoutMs}ms`, { errorSource: 'FetchTimeout' });
    });
    const warnings: string[] = [];

    await expect(
      cache.getPrograms(BASE_URL, ['132'], createMockContext({ tenantId: 'test-tenant' }), {
        profile: DETAIL_PROFILE,
        warnings,
      }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.Timeout });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([]);
  });

  it('propagates caller cancellation without a miss warning', async () => {
    const controller = new AbortController();
    fetcher.mockImplementation(
      (_url: string, _timeoutMs: number, _ctx: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
          queueMicrotask(() => controller.abort());
        }),
    );
    const ctx = createMockContext({ tenantId: 'test-tenant', signal: controller.signal });
    const warnings: string[] = [];

    await expect(
      cache.getPrograms(BASE_URL, ['132'], ctx, { profile: DETAIL_PROFILE, warnings }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([]);
  });

  it.each([
    ['listed with no methods', { service: 'programs/{programDbId}' }, '/brapi/v2/programs/132'],
    [
      'listed without GET',
      { service: 'programs/{programDbId}', methods: ['PUT'] },
      '/brapi/v2/programs',
    ],
    ['not listed', undefined, '/brapi/v2/programs'],
  ] as const)(
    'takes the detail route only when it is advertised for GET (%s)',
    async (_label, detail, path) => {
      fetcher.mockImplementation(async (url: string) =>
        new URL(url).pathname.endsWith('/programs')
          ? json(envelope({ data: [{ programDbId: '132' }] }))
          : json(envelope({ programDbId: '132' })),
      );
      const profile = profileWith([
        { service: 'programs', methods: ['GET'] },
        ...(detail ? [detail as CallDescriptor] : []),
      ]);

      const result = await cache.getPrograms(
        BASE_URL,
        ['132'],
        createMockContext({ tenantId: 'test-tenant' }),
        { profile },
      );

      expect(result.has('132')).toBe(true);
      expect(requested().map((u) => u.pathname)).toEqual([path]);
    },
  );

  it('warns and returns nothing for an ID the list response omits (ignored filter)', async () => {
    // SGN /programs ignores the ID filter and answers its first page.
    fetcher.mockImplementation(async () =>
      json(envelope({ data: [{ programDbId: '1288', programName: 'First' }] }, { totalCount: 31 })),
    );
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const warnings: string[] = [];

    const result = await cache.getPrograms(BASE_URL, ['132'], ctx, {
      dialect: breedbaseDialect,
      warnings,
    });

    expect([...result.keys()]).toEqual([]);
    expect(warnings).toEqual([
      "program '132' not found: GET /programs filtered by ID did not return it.",
    ]);
    expect(requested()[0]!.searchParams.get('programDbId')).toBe('132');

    await cache.getPrograms(BASE_URL, ['132'], ctx, { dialect: breedbaseDialect });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

/**
 * Detail-route outcomes per upstream status, through the framework's real
 * `fetchWithTimeout` status mapping and the client's reclassification — only
 * the global `fetch` is faked. A miss (the section omitted with the noun and ID
 * named) is final and uncached; every other failure rejects, which
 * `brapi_get_study` records as `<noun> FK lookup failed` and returns the study.
 */
describe('ReferenceDataCache detail route — upstream status map (#125)', () => {
  const config: ServerConfig = { ...baseConfig, allowPrivateIps: true };
  const profile: CapabilityProfile = {
    baseUrl: BASE_URL,
    crops: [],
    fetchedAt: '2026-01-01T00:00:00Z',
    server: {},
    supported: {
      programs: { service: 'programs', methods: ['GET'] },
      'programs/{programDbId}': { service: 'programs/{programDbId}', methods: ['GET'] },
    },
  };
  const miss = "program '132' not found: GET /programs/132 returned no matching record.";
  const record = () =>
    new Response(JSON.stringify({ metadata: {}, result: { programDbId: '132' } }), {
      headers: { 'Content-Type': 'application/json' },
    });
  const status = (code: number) => () =>
    new Response(JSON.stringify({ metadata: {}, result: null }), {
      status: code,
      headers: { 'Content-Type': 'application/json' },
    });

  let upstream: ReturnType<typeof vi.fn>;
  let cache: ReferenceDataCache;

  beforeEach(() => {
    upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const client = new BrapiClient(config, (url, timeoutMs, ctx, options) =>
      fetchWithTimeout(url, timeoutMs, ctx, options),
    );
    cache = new ReferenceDataCache(config, () => client);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([404, 500, 502, 503])(
    'reads HTTP %i as a miss: warns with the noun and ID, caches nothing, and a later hit resolves',
    async (code) => {
      upstream.mockImplementationOnce(status(code)).mockImplementationOnce(record);
      const ctx = createMockContext({ tenantId: 'test-tenant' });
      const warnings: string[] = [];

      const missed = await cache.getPrograms(BASE_URL, ['132'], ctx, { profile, warnings });
      expect(missed.size).toBe(0);
      expect(warnings).toEqual([miss]);

      const later: string[] = [];
      const hit = await cache.getPrograms(BASE_URL, ['132'], ctx, { profile, warnings: later });
      expect(hit.get('132')).toEqual({ programDbId: '132' });
      expect(later).toEqual([]);
      expect(upstream).toHaveBeenCalledTimes(2);
      expect(upstream.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
        '/brapi/v2/programs/132',
        '/brapi/v2/programs/132',
      ]);
    },
  );

  it('reads HTTP 200 with result: null as a miss, and a later hit resolves', async () => {
    upstream.mockImplementationOnce(status(200)).mockImplementationOnce(record);
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const warnings: string[] = [];

    expect((await cache.getPrograms(BASE_URL, ['132'], ctx, { profile, warnings })).size).toBe(0);
    expect(warnings).toEqual([miss]);
    expect((await cache.getPrograms(BASE_URL, ['132'], ctx, { profile })).has('132')).toBe(true);
  });

  it.each([
    [400, JsonRpcErrorCode.ValidationError, 'upstream_bad_request'],
    [401, JsonRpcErrorCode.Unauthorized, 'upstream_unauthorized'],
    [403, JsonRpcErrorCode.Forbidden, 'upstream_forbidden'],
    [429, JsonRpcErrorCode.RateLimited, 'upstream_rate_limited'],
    [504, JsonRpcErrorCode.Timeout, undefined],
  ])(
    'rejects HTTP %i without a miss warning, a list follow-up, or a cache entry',
    async (code, errorCode, reason) => {
      upstream.mockImplementationOnce(status(code)).mockImplementationOnce(record);
      const ctx = createMockContext({ tenantId: 'test-tenant' });
      const warnings: string[] = [];

      const failure = await cache.getPrograms(BASE_URL, ['132'], ctx, { profile, warnings }).then(
        () => undefined,
        (err: unknown) => err as McpError,
      );
      expect(failure).toBeInstanceOf(McpError);
      expect(failure?.code).toBe(errorCode);
      if (reason) expect(failure?.data).toMatchObject({ reason });
      expect(warnings).toEqual([]);
      expect(upstream).toHaveBeenCalledTimes(1);

      const hit = await cache.getPrograms(BASE_URL, ['132'], ctx, { profile });
      expect(hit.has('132')).toBe(true);
    },
  );
});
