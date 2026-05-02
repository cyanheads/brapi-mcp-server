/**
 * @fileoverview Shared test harness for tool-level integration tests. Wires
 * every service on the real implementations with a dependency-injected
 * fetcher so handlers can be exercised end-to-end against scripted
 * responses.
 *
 * @module tests/tools/_tool-test-helpers
 */

import { vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import type { Fetcher } from '@/services/brapi-client/index.js';
import { initBrapiClient, resetBrapiClient } from '@/services/brapi-client/index.js';
import {
  initBrapiDialectRegistry,
  resetBrapiDialectRegistry,
} from '@/services/brapi-dialect/index.js';
import {
  initCapabilityRegistry,
  resetCapabilityRegistry,
} from '@/services/capability-registry/index.js';
import { initDatasetStore, resetDatasetStore } from '@/services/dataset-store/index.js';
import {
  initReferenceDataCache,
  resetReferenceDataCache,
} from '@/services/reference-data-cache/index.js';
import { initServerRegistry, resetServerRegistry } from '@/services/server-registry/index.js';

export const BASE_URL = 'https://brapi.example.org/brapi/v2';

export const TEST_CONFIG: ServerConfig = {
  defaultApiKeyHeader: 'Authorization',
  datasetTtlSeconds: 86_400,
  loadLimit: 10,
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

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function envelope(result: unknown, pagination?: { totalCount: number }) {
  return {
    metadata: pagination ? { pagination } : {},
    result,
  };
}

export type MockFetcher = ReturnType<typeof vi.fn>;

export function initTestServices(config: ServerConfig = TEST_CONFIG): MockFetcher {
  const fetcher = vi.fn() as MockFetcher;
  initBrapiClient(config, fetcher as unknown as Fetcher);
  initCapabilityRegistry(config);
  initBrapiDialectRegistry();
  initReferenceDataCache(config);
  initDatasetStore(config);
  initServerRegistry(config);
  return fetcher;
}

export function resetTestServices(): void {
  resetBrapiClient();
  resetCapabilityRegistry();
  resetBrapiDialectRegistry();
  resetReferenceDataCache();
  resetDatasetStore();
  resetServerRegistry();
}

/** Extracts the pathname of a URL passed to the fetcher, without query. */
export function pathnameOf(url: unknown): string {
  return new URL(String(url)).pathname;
}
