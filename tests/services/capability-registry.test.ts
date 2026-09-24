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
import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { BrapiClient, type BrapiEnvelope } from '@/services/brapi-client/index.js';
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

  describe('profile', () => {
    it('fetches /serverinfo + /commoncropnames and uses embedded calls when present', async () => {
      client.get.mockImplementation(async (_base, path: string) => {
        if (path === '/serverinfo') {
          return envelope({
            serverName: 'Test Server',
            organizationName: 'Test Org',
            calls: [
              { service: 'studies', methods: ['GET'], versions: ['2.1'] },
              { service: 'search/studies', methods: ['POST'], versions: ['2.1'] },
            ],
          });
        }
        if (path === '/commoncropnames') return envelope({ data: ['Cassava', 'Yam'] });
        throw new Error(`Unexpected path: ${path}`);
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
      client.get.mockImplementation(async (_base, path: string) => {
        if (path === '/serverinfo') return envelope({ serverName: 'Sparse Server' });
        if (path === '/calls') {
          return envelope({
            data: [
              { service: 'studies', methods: ['GET'], versions: ['2.0'] },
              { service: 'studies', methods: ['POST'], versions: ['2.1'] },
            ],
          });
        }
        if (path === '/commoncropnames') return envelope({ data: [] });
        throw new Error(`Unexpected path: ${path}`);
      });
      const ctx = createMockContext({ tenantId: 'test-tenant' });

      const profile = await registry.profile(BASE_URL, ctx);

      // Multi-version + multi-method should merge.
      expect(profile.supported.studies?.methods?.sort()).toEqual(['GET', 'POST']);
      expect(profile.supported.studies?.versions?.sort()).toEqual(['2.0', '2.1']);
      expect(profile.server.brapiVersion).toBe('2.1');
    });

    it('builds a partial profile from /calls when /serverinfo is unavailable', async () => {
      client.get.mockImplementation(async (_base, path: string) => {
        if (path === '/serverinfo') throw serviceUnavailable('503 maintenance');
        if (path === '/calls') {
          return envelope({
            data: [{ service: 'studies', methods: ['GET'], versions: ['2.1'] }],
          });
        }
        if (path === '/commoncropnames') return envelope({ data: [] });
        throw new Error(`Unexpected path: ${path}`);
      });
      const ctx = createMockContext({ tenantId: 'test-tenant' });

      const profile = await registry.profile(BASE_URL, ctx);

      expect(profile.supported.studies?.methods).toContain('GET');
      expect(profile.server.brapiVersion).toBe('2.1');
      expect(profile.warnings?.some((w) => w.includes('/serverinfo was unavailable'))).toBe(true);
    });

    it('degrades gracefully when /commoncropnames is unavailable', async () => {
      client.get.mockImplementation(async (_base, path: string) => {
        if (path === '/serverinfo') {
          return envelope({ calls: [{ service: 'studies', methods: ['GET'] }] });
        }
        if (path === '/commoncropnames') throw serviceUnavailable('404 missing endpoint');
        throw new Error(`Unexpected path: ${path}`);
      });
      const ctx = createMockContext({ tenantId: 'test-tenant' });

      const profile = await registry.profile(BASE_URL, ctx);
      expect(profile.crops).toEqual([]);
      expect(profile.supported.studies).toBeDefined();
      expect(profile.warnings?.some((w) => w.includes('/commoncropnames'))).toBe(true);
    });

    it('degrades gracefully when the /calls fallback also fails', async () => {
      client.get.mockImplementation(async (_base, path: string) => {
        if (path === '/serverinfo') return envelope({}); // no calls embedded
        if (path === '/calls') throw serviceUnavailable('501 not implemented');
        if (path === '/commoncropnames') return envelope({ data: [] });
        throw new Error(`Unexpected path: ${path}`);
      });
      const ctx = createMockContext({ tenantId: 'test-tenant' });

      const profile = await registry.profile(BASE_URL, ctx);
      expect(Object.keys(profile.supported)).toHaveLength(0);
      expect(profile.crops).toEqual([]);
      expect(profile.warnings?.some((w) => w.includes('/calls'))).toBe(true);
    });

    it('caches profiles on the first fetch and reuses them on subsequent calls', async () => {
      client.get.mockImplementation(async (_base, path: string) => {
        if (path === '/serverinfo') {
          return envelope({ calls: [{ service: 'studies', methods: ['GET'] }] });
        }
        if (path === '/commoncropnames') return envelope({ data: ['Yam'] });
        throw new Error(path);
      });
      const ctx = createMockContext({ tenantId: 'test-tenant' });

      await registry.profile(BASE_URL, ctx);
      await registry.profile(BASE_URL, ctx);
      await registry.profile(BASE_URL, ctx);

      expect(client.get).toHaveBeenCalledTimes(2);
    });

    it('refetches when forceRefresh is set', async () => {
      client.get.mockImplementation(async (_base, path: string) => {
        if (path === '/serverinfo') {
          return envelope({ calls: [{ service: 'studies', methods: ['GET'] }] });
        }
        if (path === '/commoncropnames') return envelope({ data: [] });
        throw new Error(path);
      });
      const ctx = createMockContext({ tenantId: 'test-tenant' });

      await registry.profile(BASE_URL, ctx);
      await registry.profile(BASE_URL, ctx, { forceRefresh: true });
      expect(client.get).toHaveBeenCalledTimes(4);
    });

    it('forwards the auth option to client.get', async () => {
      client.get.mockImplementation(async (_base, path: string) => {
        if (path === '/serverinfo') return envelope({ calls: [] });
        if (path === '/calls') return envelope({ data: [] });
        if (path === '/commoncropnames') return envelope({ data: [] });
        throw new Error(path);
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
      client.get.mockImplementation(async (_base, path: string) => {
        if (path === '/serverinfo') {
          return envelope({
            calls: [
              { service: 'studies', methods: ['GET', 'POST'] },
              { service: 'observations', methods: ['GET'] },
            ],
          });
        }
        if (path === '/commoncropnames') return envelope({ data: [] });
        throw new Error(path);
      });
    });

    it('returns the descriptor for a supported service', async () => {
      const ctx = createMockContext({ tenantId: 'test-tenant' });
      const descriptor = await registry.ensure(BASE_URL, { service: 'studies' }, ctx);
      expect(descriptor.service).toBe('studies');
    });

    it('throws ValidationError when the service is missing', async () => {
      const ctx = createMockContext({ tenantId: 'test-tenant' });
      await expect(registry.ensure(BASE_URL, { service: 'genomics' }, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
      });
    });

    it('throws ValidationError when a requested method is not supported', async () => {
      const ctx = createMockContext({ tenantId: 'test-tenant' });
      await expect(
        registry.ensure(BASE_URL, { service: 'observations', method: 'POST' }, ctx),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
    });

    it('allows any method when the descriptor omits methods', async () => {
      client.get.mockReset();
      client.get.mockImplementation(async (_base, path: string) => {
        if (path === '/serverinfo') {
          return envelope({ calls: [{ service: 'studies' }] });
        }
        if (path === '/commoncropnames') return envelope({ data: [] });
        throw new Error(path);
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
      client.get.mockImplementation(async (_base, path: string) => {
        if (path === '/serverinfo') {
          return envelope({ calls: [{ service: 'studies', methods: ['GET'] }] });
        }
        if (path === '/commoncropnames') return envelope({ data: [] });
        throw new Error(path);
      });
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

  it('propagates a 401 on /serverinfo as upstream_unauthorized and caches nothing', async () => {
    routes['/serverinfo'] = status(401);
    routes['/commoncropnames'] = ok({ data: ['Wheat'] });
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    await expect(registry.profile(origin, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Unauthorized,
      data: { reason: 'upstream_unauthorized', status: 401 },
    });
    // No fallback to /calls, no crop probe, no retry of the 401.
    expect(hits.map((h) => h.path)).toEqual(['/serverinfo']);

    await expect(registry.profile(origin, ctx)).rejects.toMatchObject({
      data: { reason: 'upstream_unauthorized' },
    });
    expect(hits.map((h) => h.path)).toEqual(['/serverinfo', '/serverinfo']);
  });

  it('propagates a 403 on /serverinfo as upstream_forbidden', async () => {
    routes['/serverinfo'] = status(403);
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    await expect(registry.profile(origin, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: { reason: 'upstream_forbidden', status: 403 },
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

  it('propagates a 401 on the /calls fallback when /serverinfo carries no calls', async () => {
    routes['/serverinfo'] = ok({ serverName: 'Walled' });
    routes['/calls'] = status(401);
    routes['/commoncropnames'] = ok({ data: ['Oat'] });
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    await expect(registry.profile(origin, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Unauthorized,
      data: { reason: 'upstream_unauthorized', status: 401 },
    });
    expect(hits.map((h) => h.path)).toEqual(['/serverinfo', '/calls']);
  });

  it('propagates a 403 on the /calls fallback as upstream_forbidden', async () => {
    routes['/serverinfo'] = ok({});
    routes['/calls'] = status(403);
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    await expect(registry.profile(origin, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: { reason: 'upstream_forbidden' },
    });
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

  it('carries the calling tool contract recovery hint for the auth reasons', async () => {
    routes['/serverinfo'] = status(401);
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: [
        {
          reason: 'upstream_unauthorized',
          code: JsonRpcErrorCode.Unauthorized,
          when: 'test contract entry',
          recovery: 'Supply credentials for this test server.',
        },
      ] as const,
    });

    await expect(registry.profile(origin, ctx)).rejects.toMatchObject({
      data: {
        reason: 'upstream_unauthorized',
        recovery: { hint: 'Supply credentials for this test server.' },
      },
    });
  });
});
