/**
 * @fileoverview Unit tests for ReferenceDataCache. Exercises batch caching,
 * cache-hit/miss partitioning, dedup, and per-noun endpoint routing.
 *
 * @module tests/services/reference-data-cache.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import type { BrapiClient, BrapiEnvelope } from '@/services/brapi-client/index.js';
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
  searchPollTimeoutMs: 5_000,
  searchPollIntervalMs: 1,
  allowPrivateIps: false,
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

  describe('invalidate', () => {
    it('evicts all cached entries for a base url so subsequent calls refetch', async () => {
      client.get.mockResolvedValue(
        envelope<{ data: Program[] }>({
          data: [{ programDbId: 'p1', programName: 'Cached' }],
        }),
      );
      const ctx = createMockContext({ tenantId: 'test-tenant' });

      await cache.getPrograms(BASE_URL, ['p1'], ctx);
      await cache.invalidate(BASE_URL, ctx);
      await cache.getPrograms(BASE_URL, ['p1'], ctx);

      expect(client.get).toHaveBeenCalledTimes(2);
    });
  });
});
