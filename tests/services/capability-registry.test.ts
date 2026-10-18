/**
 * @fileoverview Unit tests for CapabilityRegistry. Uses a stub BrapiClient
 * to exercise profile caching, embedded-vs-fallback /calls loading,
 * /commoncropnames degradation, and capability probing. Auth rejections run
 * through a real BrapiClient against a local socket.
 *
 * @module tests/services/capability-registry.test
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  requestCancelled,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import {
  BrapiClient,
  type BrapiEnvelope,
  CALL_DEADLINE_MS,
} from '@/services/brapi-client/index.js';
import { CapabilityRegistry } from '@/services/capability-registry/capability-registry.js';

const BASE_URL = 'https://brapi.example.org/brapi/v2';

/** Captured before any test stubs `globalThis.fetch`; used only to reach the local stub server. */
const realFetch = globalThis.fetch;

/** Unmocked network access fails loudly instead of reaching a real host. */
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(`Unmocked global fetch: ${String(input)}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const baseConfig: ServerConfig = {
  defaultApiKeyHeader: 'Authorization',
  datasetTtlSeconds: 86_400,
  loadLimit: 200,
  maxConcurrentRequests: 4,
  retryMaxAttempts: 0,
  retryBaseDelayMs: 1,
  referenceCacheTtlSeconds: 3_600,
  requestTimeoutMs: 1_000,
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
  const unmocked = async (...args: unknown[]) => {
    throw new Error(`Unmocked client call: ${JSON.stringify(args.slice(0, 2))}`);
  };
  return {
    get: vi.fn(unmocked),
    postSearch: vi.fn(unmocked),
    getSearchResults: vi.fn(unmocked),
  };
}

function makeRegistry(client: MockBrapiClient) {
  return new CapabilityRegistry(baseConfig, () => client as unknown as BrapiClient);
}

describe('CapabilityRegistry', () => {
  let client: MockBrapiClient;
  let registry: CapabilityRegistry;

  beforeEach(() => {
    client = makeClient();
    registry = makeRegistry(client);
  });

  /** Route `client.get` by path; unrouted paths fail the test. */
  function route(routes: Record<string, () => unknown>) {
    client.get.mockImplementation(async (_base, path: string) => {
      const handler = routes[path];
      if (!handler) throw new Error(`Unexpected path: ${path}`);
      return handler();
    });
  }
  /** A /serverinfo advertising GET /studies, with no crops. */
  const studiesOnly = () =>
    route({
      '/serverinfo': () => envelope({ calls: [{ service: 'studies', methods: ['GET'] }] }),
      '/commoncropnames': () => envelope({ data: [] }),
    });

  describe('profile', () => {
    it('fetches /serverinfo + /commoncropnames and uses embedded calls when present', async () => {
      route({
        '/serverinfo': () =>
          envelope({
            serverName: 'Test Server',
            organizationName: 'Test Org',
            calls: [
              { service: 'studies', methods: ['GET'], versions: ['2.1'] },
              { service: 'search/studies', methods: ['POST'], versions: ['2.1'] },
            ],
          }),
        '/commoncropnames': () => envelope({ data: ['Cassava', 'Yam'] }),
      });
      const ctx = createMockContext({ tenantId: 'test-tenant' });

      const profile = await registry.profile(BASE_URL, ctx);

      expect(profile.baseUrl).toBe(BASE_URL);
      expect(profile.server.name).toBe('Test Server');
      expect(profile.server.brapiVersion).toBe('2.1');
      expect(profile.crops).toEqual(['Cassava', 'Yam']);
      expect(profile.supported.studies?.methods).toContain('GET');
      expect(profile.supported['search/studies']?.methods).toContain('POST');

      // No fallback /calls hit because /serverinfo had embedded calls.
      const calledPaths = client.get.mock.calls.map((c) => c[1]);
      expect(calledPaths).toEqual(['/serverinfo', '/commoncropnames']);
    });

    it('never serves one base URL the cached profile of another', async () => {
      // Distinct servers whose URLs differ only in punctuation.
      const pairs = [
        ['https://a.b/brapi/v2', 'https://a-b/brapi/v2'],
        ['https://x.org/brapi/v2', 'https://x.org-brapi/v2'],
        ['https://h.example/brapi/v2', 'https://h.example/brapi-v2'],
      ];
      client.get.mockImplementation(async (base: string, path: string) => {
        if (path === '/serverinfo') {
          return envelope({ serverName: base, calls: [{ service: 'studies', methods: ['GET'] }] });
        }
        return envelope({ data: [] });
      });
      const ctx = createMockContext({ tenantId: 'test-tenant' });
      for (const [first, second] of pairs) {
        expect((await registry.profile(first!, ctx)).server.name).toBe(first);
        expect((await registry.profile(second!, ctx)).server.name).toBe(second);
        expect((await registry.profile(first!, ctx)).server.name).toBe(first);
      }
    });

    it('falls back to /calls when /serverinfo omits them', async () => {
      route({
        '/serverinfo': () => envelope({ serverName: 'Sparse Server' }),
        '/calls': () =>
          envelope({
            data: [
              { service: 'studies', methods: ['GET'], versions: ['2.0'] },
              { service: 'studies', methods: ['POST'], versions: ['2.1'] },
            ],
          }),
        '/commoncropnames': () => envelope({ data: [] }),
      });
      const ctx = createMockContext({ tenantId: 'test-tenant' });

      const profile = await registry.profile(BASE_URL, ctx);

      // Multi-version + multi-method should merge.
      expect(profile.supported.studies?.methods?.sort()).toEqual(['GET', 'POST']);
      expect(profile.supported.studies?.versions?.sort()).toEqual(['2.0', '2.1']);
      expect(profile.server.brapiVersion).toBe('2.1');
    });

    it('builds a partial profile from /calls when /serverinfo is unavailable', async () => {
      route({
        '/serverinfo': () => {
          throw serviceUnavailable('503 maintenance');
        },
        '/calls': () =>
          envelope({ data: [{ service: 'studies', methods: ['GET'], versions: ['2.1'] }] }),
        '/commoncropnames': () => envelope({ data: [] }),
      });
      const ctx = createMockContext({ tenantId: 'test-tenant' });

      const profile = await registry.profile(BASE_URL, ctx);

      expect(profile.supported.studies?.methods).toContain('GET');
      expect(profile.server.brapiVersion).toBe('2.1');
      expect(profile.warnings?.some((w) => w.includes('/serverinfo was unavailable'))).toBe(true);
    });

    it('degrades gracefully when /commoncropnames is unavailable', async () => {
      route({
        '/serverinfo': () => envelope({ calls: [{ service: 'studies', methods: ['GET'] }] }),
        '/commoncropnames': () => {
          throw serviceUnavailable('404 missing endpoint');
        },
      });
      const ctx = createMockContext({ tenantId: 'test-tenant' });

      const profile = await registry.profile(BASE_URL, ctx);
      expect(profile.crops).toEqual([]);
      expect(profile.supported.studies).toBeDefined();
      expect(profile.warnings?.some((w) => w.includes('/commoncropnames'))).toBe(true);
    });

    it('degrades gracefully when the /calls fallback also fails', async () => {
      route({
        '/serverinfo': () => envelope({}), // no calls embedded
        // The shape the client gives an HTTP 501: a definitive answer, not retryable.
        '/calls': () => {
          throw serviceUnavailable('501 not implemented', { status: 501, retryable: false });
        },
        '/commoncropnames': () => envelope({ data: [] }),
      });
      const ctx = createMockContext({ tenantId: 'test-tenant' });

      const profile = await registry.profile(BASE_URL, ctx);
      expect(Object.keys(profile.supported)).toHaveLength(0);
      expect(profile.crops).toEqual([]);
      expect(profile.warnings?.some((w) => w.includes('/calls'))).toBe(true);
    });

    describe('transient discovery failure', () => {
      const stalled = () => timeout('Fetch GET timed out.', { errorSource: 'FetchTimeout' });
      const http503 = () => serviceUnavailable('Fetch failed. Status: 503', { status: 503 });

      const cases: Array<{ name: string; serverinfo: () => unknown; calls: () => unknown }> = [
        {
          name: 'both time out',
          serverinfo: () => {
            throw stalled();
          },
          calls: () => {
            throw stalled();
          },
        },
        {
          name: 'both answer 5xx',
          serverinfo: () => {
            throw http503();
          },
          calls: () => {
            throw http503();
          },
        },
        {
          name: 'both hit a network error',
          serverinfo: () => {
            throw new TypeError('fetch failed');
          },
          calls: () => {
            throw new TypeError('fetch failed');
          },
        },
        {
          name: '/serverinfo answers without calls and /calls times out',
          serverinfo: () => envelope({ serverName: 'Sparse' }),
          calls: () => {
            throw stalled();
          },
        },
        {
          name: '/serverinfo answers 404 and /calls times out',
          serverinfo: () => {
            throw notFound('Fetch failed. Status: 404', {
              status: 404,
              reason: 'upstream_not_found',
            });
          },
          calls: () => {
            throw stalled();
          },
        },
      ];

      for (const { name, serverinfo, calls } of cases) {
        it(`fails retryable and caches nothing when ${name}`, async () => {
          route({ '/serverinfo': serverinfo, '/calls': calls });
          const ctx = createMockContext({ tenantId: 'test-tenant' });

          const error = await registry.profile(BASE_URL, ctx).catch((e: unknown) => e);

          expect(error).toBeInstanceOf(McpError);
          expect(error).toMatchObject({
            code: JsonRpcErrorCode.ServiceUnavailable,
            data: {
              reason: 'capability_discovery_unavailable',
              retryable: true,
              baseUrl: BASE_URL,
            },
          });
          // Which call to retry depends on the caller, so the hint comes from its contract.
          expect((error as McpError).data?.recovery).toBeUndefined();
          const failed = (error as McpError).data?.failedEndpoints as string[];
          expect(failed.length).toBeGreaterThan(0);
          for (const endpoint of failed) expect((error as Error).message).toContain(endpoint);
          expect(failed).toContain('/calls');
          // No crop probe once discovery has failed.
          const paths = client.get.mock.calls.map((c) => c[1]);
          expect(paths).not.toContain('/commoncropnames');

          // Nothing cached: the next lookup goes back to the server.
          client.get.mockClear();
          await registry.profile(BASE_URL, ctx).catch(() => undefined);
          expect(client.get.mock.calls.map((c) => c[1])).toContain('/serverinfo');
        });
      }

      it('caches nothing and reports the cancellation when the caller cancels mid-discovery', async () => {
        const controller = new AbortController();
        const cancelled = () => requestCancelled('Request cancelled by the caller.');
        route({
          '/serverinfo': () => {
            controller.abort();
            throw cancelled();
          },
          '/calls': () => {
            throw cancelled();
          },
          '/commoncropnames': () => {
            throw cancelled();
          },
        });
        const state = createMockContext({ tenantId: 'test-tenant' }).state;
        const ctx = {
          ...createMockContext({ tenantId: 'test-tenant', signal: controller.signal }),
          state,
        };

        const error = await registry.profile(BASE_URL, ctx).catch((e: unknown) => e);
        expect(error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });

        // Nothing cached: the next caller's lookup goes back to the server.
        studiesOnly();
        const next = await registry.profile(BASE_URL, {
          ...createMockContext({ tenantId: 'test-tenant' }),
          state,
        });
        expect(Object.keys(next.supported)).toEqual(['studies']);
      });

      it('still builds and caches a profile when only /serverinfo failed and /calls answered', async () => {
        route({
          '/serverinfo': () => {
            throw stalled();
          },
          '/calls': () => envelope({ data: [{ service: 'studies', methods: ['GET'] }] }),
          '/commoncropnames': () => envelope({ data: [] }),
        });
        const ctx = createMockContext({ tenantId: 'test-tenant' });

        const profile = await registry.profile(BASE_URL, ctx);
        expect(Object.keys(profile.supported)).toEqual(['studies']);
        client.get.mockClear();
        await registry.profile(BASE_URL, ctx);
        expect(client.get).not.toHaveBeenCalled();
      });

      it('caches an empty profile for a server that answers but advertises nothing', async () => {
        route({
          '/serverinfo': () => envelope({ serverName: 'Empty' }),
          '/calls': () => {
            throw notFound('Fetch failed. Status: 404', {
              status: 404,
              reason: 'upstream_not_found',
            });
          },
          '/commoncropnames': () => envelope({ data: [] }),
        });
        const ctx = createMockContext({ tenantId: 'test-tenant' });

        const profile = await registry.profile(BASE_URL, ctx);
        expect(profile.supported).toEqual({});
        client.get.mockClear();
        await registry.profile(BASE_URL, ctx);
        expect(client.get).not.toHaveBeenCalled();
      });

      it('caches an empty profile when /serverinfo answers with a non-JSON body', async () => {
        route({
          '/serverinfo': () => {
            throw serviceUnavailable('BrAPI returned non-JSON response', {
              bodyPreview: '<html>',
              httpStatus: 200,
            });
          },
          '/calls': () => envelope({ data: [] }),
          '/commoncropnames': () => envelope({ data: [] }),
        });
        const ctx = createMockContext({ tenantId: 'test-tenant' });

        const profile = await registry.profile(BASE_URL, ctx);
        expect(profile.supported).toEqual({});
      });
    });

    it('caches profiles on the first fetch and reuses them on subsequent calls', async () => {
      studiesOnly();
      const ctx = createMockContext({ tenantId: 'test-tenant' });

      await registry.profile(BASE_URL, ctx);
      await registry.profile(BASE_URL, ctx);
      await registry.profile(BASE_URL, ctx);

      expect(client.get).toHaveBeenCalledTimes(2);
    });

    it('refetches when forceRefresh is set', async () => {
      studiesOnly();
      const ctx = createMockContext({ tenantId: 'test-tenant' });

      await registry.profile(BASE_URL, ctx);
      await registry.profile(BASE_URL, ctx, { forceRefresh: true });
      expect(client.get).toHaveBeenCalledTimes(4);
    });

    it('forwards the auth option to client.get', async () => {
      route({
        '/serverinfo': () => envelope({ calls: [] }),
        '/calls': () => envelope({ data: [] }),
        '/commoncropnames': () => envelope({ data: [] }),
      });
      const ctx = createMockContext({ tenantId: 'test-tenant' });
      const auth = { headerName: 'Authorization', headerValue: 'Bearer xyz' };

      await registry.profile(BASE_URL, ctx, { auth });

      for (const call of client.get.mock.calls) {
        expect(call[3]).toMatchObject({ auth });
      }
    });
  });

  describe('ensure', () => {
    beforeEach(() => {
      route({
        '/serverinfo': () =>
          envelope({
            calls: [
              { service: 'studies', methods: ['GET', 'POST'] },
              { service: 'observations', methods: ['GET'] },
            ],
          }),
        '/commoncropnames': () => envelope({ data: [] }),
      });
    });

    it('returns the descriptor for a supported service', async () => {
      const ctx = createMockContext({ tenantId: 'test-tenant' });
      const descriptor = await registry.ensure(BASE_URL, { service: 'studies' }, ctx);
      expect(descriptor.service).toBe('studies');
    });

    it.each([
      ['the service is missing', { service: 'genomics' }],
      ['a requested method is not supported', { service: 'observations', method: 'POST' }],
    ])('throws ValidationError when %s', async (_label, call) => {
      const ctx = createMockContext({ tenantId: 'test-tenant' });
      await expect(registry.ensure(BASE_URL, call, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
      });
    });

    it('allows any method when the descriptor omits methods', async () => {
      route({
        '/serverinfo': () => envelope({ calls: [{ service: 'studies' }] }),
        '/commoncropnames': () => envelope({ data: [] }),
      });
      const ctx = createMockContext({ tenantId: 'test-tenant' });
      const descriptor = await registry.ensure(
        BASE_URL,
        { service: 'studies', method: 'POST' },
        ctx,
      );
      expect(descriptor.service).toBe('studies');
    });
  });

  describe('invalidate', () => {
    it('clears the cached profile so the next profile() call refetches', async () => {
      studiesOnly();
      const ctx = createMockContext({ tenantId: 'test-tenant' });

      await registry.profile(BASE_URL, ctx);
      await registry.invalidate(BASE_URL, ctx);
      await registry.profile(BASE_URL, ctx);

      expect(client.get).toHaveBeenCalledTimes(4);
    });
  });
});

/**
 * Capability discovery against a real `BrapiClient` + `fetchWithTimeout` over
 * a local socket, so the HTTP-status → reason stamping the registry keys on
 * runs for real instead of being pre-coded by a stub client.
 */
describe('CapabilityRegistry auth rejections over a real socket', () => {
  type Route = (req: IncomingMessage, res: ServerResponse) => void;
  let server: Server;
  let origin: string;
  let hits: Array<{ path: string; authorization: string | undefined }>;
  let routes: Record<string, Route>;
  let registry: CapabilityRegistry;

  const ok =
    (result: unknown): Route =>
    (_req, res) => {
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ metadata: {}, result }));
    };
  const status =
    (code: number): Route =>
    (_req, res) => {
      res.writeHead(code, { 'Content-Type': 'text/plain' }).end(`HTTP ${code}`);
    };
  const STUDIES_CALLS = { calls: [{ service: 'studies', methods: ['GET'], versions: ['2.1'] }] };

  beforeEach(async () => {
    hits = [];
    routes = {};
    server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://stub').pathname.replace(/^\/brapi\/v2/, '');
      hits.push({ path, authorization: req.headers.authorization });
      (routes[path] ?? status(404))(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/brapi/v2`;
    const localOrigin = new URL(origin).origin;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        String(input instanceof Request ? input.url : input).startsWith(localOrigin)
          ? realFetch(input, init)
          : Promise.reject(new Error(`Unmocked global fetch: ${String(input)}`)),
      ),
    );
    const client = new BrapiClient({ ...baseConfig, allowPrivateIps: true, retryMaxAttempts: 2 });
    registry = new CapabilityRegistry(baseConfig, () => client);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each([
    {
      name: 'a 401 on /serverinfo',
      serverinfo: status(401),
      code: JsonRpcErrorCode.Unauthorized,
      reason: 'upstream_unauthorized',
      httpStatus: 401,
      // No fallback to /calls, no crop probe, no retry of the 401.
      paths: ['/serverinfo'],
    },
    {
      name: 'a 403 on /serverinfo',
      serverinfo: status(403),
      code: JsonRpcErrorCode.Forbidden,
      reason: 'upstream_forbidden',
      httpStatus: 403,
      paths: ['/serverinfo'],
    },
    {
      name: 'a 401 on the /calls fallback when /serverinfo carries no calls',
      serverinfo: ok({ serverName: 'Walled' }),
      calls: status(401),
      code: JsonRpcErrorCode.Unauthorized,
      reason: 'upstream_unauthorized',
      httpStatus: 401,
      paths: ['/serverinfo', '/calls'],
    },
    {
      name: 'a 403 on the /calls fallback',
      serverinfo: ok({}),
      calls: status(403),
      code: JsonRpcErrorCode.Forbidden,
      reason: 'upstream_forbidden',
      httpStatus: 403,
      paths: ['/serverinfo', '/calls'],
    },
  ])('propagates $name as $reason, caching nothing', async (c) => {
    routes['/serverinfo'] = c.serverinfo;
    if (c.calls) routes['/calls'] = c.calls;
    routes['/commoncropnames'] = ok({ data: ['Wheat'] });
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const error = await registry.profile(origin, ctx).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: c.code,
      data: { reason: c.reason, status: c.httpStatus },
    });
    // The hint depends on which tool called, so it comes from that tool's contract.
    expect((error as { data?: Record<string, unknown> }).data?.recovery).toBeUndefined();
    expect(hits.map((h) => h.path)).toEqual(c.paths);

    // Nothing cached: a second lookup asks the server again and fails the same way.
    await expect(registry.profile(origin, ctx)).rejects.toMatchObject({
      data: { reason: c.reason },
    });
  });

  it('says whether credentials were sent when naming the auth rejection', async () => {
    routes['/serverinfo'] = status(403);
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const anonymous = await registry.profile(origin, ctx).catch((e: Error) => e);
    expect(anonymous.message).toContain('refused anonymous access');
    expect(anonymous.message).not.toContain('supplied credentials');

    routes['/serverinfo'] = status(401);
    const auth = { headerName: 'Authorization', headerValue: 'Bearer stale' };
    const rejected = await registry.profile(origin, ctx, { auth }).catch((e: Error) => e);
    expect(rejected.message).toContain('rejected the supplied credentials');
  });

  it('still degrades softly when only /commoncropnames answers 401', async () => {
    routes['/serverinfo'] = ok(STUDIES_CALLS);
    routes['/commoncropnames'] = status(401);
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const profile = await registry.profile(origin, ctx);
    expect(profile.supported.studies).toBeDefined();
    expect(profile.crops).toEqual([]);
    expect(profile.warnings?.some((w) => w.includes('/commoncropnames'))).toBe(true);
  });

  it('still degrades softly when /serverinfo answers 404 and /calls answers', async () => {
    routes['/calls'] = ok({ data: STUDIES_CALLS.calls });
    routes['/commoncropnames'] = ok({ data: [] });
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const profile = await registry.profile(origin, ctx);
    expect(Object.keys(profile.supported)).toEqual(['studies']);
    expect(profile.warnings?.some((w) => w.includes('/serverinfo was unavailable'))).toBe(true);
  });

  it('fails capability_discovery_unavailable when /serverinfo and /calls answer 429', async () => {
    routes['/serverinfo'] = status(429);
    routes['/calls'] = status(429);
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    await expect(registry.profile(origin, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'capability_discovery_unavailable', retryable: true },
    });
    expect(hits.filter((h) => h.path === '/calls').length).toBeGreaterThan(0);
  });

  it('caches a profile with no services when /serverinfo and /calls answer 501', async () => {
    routes['/serverinfo'] = status(501);
    routes['/calls'] = status(501);
    routes['/commoncropnames'] = ok({ data: [] });
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const profile = await registry.profile(origin, ctx);
    expect(profile.supported).toEqual({});
    expect(profile.warnings?.some((w) => w.includes('/calls was unavailable'))).toBe(true);
  });

  it('propagates private_address_blocked for a base URL on a loopback address, sending and caching nothing', async () => {
    routes['/serverinfo'] = ok(STUDIES_CALLS);
    routes['/calls'] = ok({ data: STUDIES_CALLS.calls });
    routes['/commoncropnames'] = ok({ data: [] });
    const guarded = new BrapiClient({ ...baseConfig, allowPrivateIps: false });
    const guardedRegistry = new CapabilityRegistry(baseConfig, () => guarded);
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const error = await guardedRegistry.profile(origin, ctx).catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'private_address_blocked', baseUrl: origin },
    });
    expect((error as Error).message).toContain(origin);
    // The calling tool's contract supplies the hint.
    expect((error as { data?: Record<string, unknown> }).data?.recovery).toBeUndefined();
    expect(hits).toEqual([]);
    expect((await ctx.state.list('brapi/capability/')).items).toEqual([]);
  });

  it('succeeds and caches once working credentials are supplied after a 401', async () => {
    const walled: Route = (req, res) =>
      req.headers.authorization === 'Bearer good'
        ? ok(STUDIES_CALLS)(req, res)
        : status(401)(req, res);
    routes['/serverinfo'] = walled;
    routes['/commoncropnames'] = ok({ data: ['Barley'] });
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    await expect(registry.profile(origin, ctx)).rejects.toMatchObject({
      data: { reason: 'upstream_unauthorized' },
    });
    const auth = { headerName: 'Authorization', headerValue: 'Bearer good' };
    const profile = await registry.profile(origin, ctx, { auth });
    expect(profile.supported.studies).toBeDefined();
    expect(profile.crops).toEqual(['Barley']);

    // Cached now: a later lookup does not touch the network.
    const before = hits.length;
    await registry.profile(origin, ctx);
    expect(hits.length).toBe(before);
  });

  it('fails retryable inside the call deadline when the host never answers, caching nothing', async () => {
    const stallingClient = new BrapiClient({
      ...baseConfig,
      allowPrivateIps: true,
      requestTimeoutMs: 30_000,
      retryMaxAttempts: 3,
    });
    const stallingRegistry = new CapabilityRegistry(baseConfig, () => stallingClient);
    routes['/serverinfo'] = () => {};
    routes['/calls'] = () => {};
    const base = createMockContext({ tenantId: 'test-tenant' });
    const ctx = {
      ...base,
      timestamp: new Date(Date.now() - (CALL_DEADLINE_MS - 400)).toISOString(),
    };
    const startedAt = Date.now();

    const error = await stallingRegistry.profile(origin, ctx).catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'capability_discovery_unavailable',
        failedEndpoints: ['/serverinfo', '/calls'],
      },
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    // The deadline left /calls unsent; nothing reached /commoncropnames.
    expect(hits.map((h) => h.path)).toEqual(['/serverinfo']);
    server.closeAllConnections();
  });
});
