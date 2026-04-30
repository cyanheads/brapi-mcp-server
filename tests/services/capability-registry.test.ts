/**
 * @fileoverview Unit tests for CapabilityRegistry. Uses a stub BrapiClient
 * to exercise profile caching, embedded-vs-fallback /calls loading,
 * /commoncropnames degradation, and capability probing.
 *
 * @module tests/services/capability-registry.test
 */

import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import type { BrapiClient, BrapiEnvelope } from '@/services/brapi-client/index.js';
import { CapabilityRegistry } from '@/services/capability-registry/capability-registry.js';

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
  return {
    get: vi.fn(),
    postSearch: vi.fn(),
    getSearchResults: vi.fn(),
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
