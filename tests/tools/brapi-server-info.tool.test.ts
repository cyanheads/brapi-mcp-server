/**
 * @fileoverview End-to-end tests for `brapi_server_info`. Shares the same
 * service wiring + mock fetcher as `brapi_connect`, but tests that the tool
 * reads a previously registered connection and can force a capability
 * refresh.
 *
 * @module tests/tools/brapi-server-info.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiServerInfo } from '@/mcp-server/tools/definitions/brapi-server-info.tool.js';
import { type Fetcher, initBrapiClient, resetBrapiClient } from '@/services/brapi-client/index.js';
import {
  initCapabilityRegistry,
  resetCapabilityRegistry,
} from '@/services/capability-registry/index.js';
import { initServerRegistry, resetServerRegistry } from '@/services/server-registry/index.js';

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

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function envelope(result: unknown) {
  return { metadata: {}, result };
}

describe('brapi_server_info tool', () => {
  let fetcher: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetcher = vi.fn(async () =>
      jsonResponse(envelope({ calls: [{ service: 'studies', methods: ['GET'] }] })),
    );
    initBrapiClient(baseConfig, fetcher as unknown as Fetcher);
    initCapabilityRegistry(baseConfig);
    initServerRegistry(baseConfig);
  });

  afterEach(() => {
    resetBrapiClient();
    resetCapabilityRegistry();
    resetServerRegistry();
  });

  it('returns the orientation envelope for the default connection', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);

    const result = await brapiServerInfo.handler(brapiServerInfo.input.parse({}), ctx);
    expect(result.alias).toBe('default');
    expect(result.baseUrl).toBe(BASE_URL);
  });

  it('throws NotFound when the alias has no registered connection', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    await expect(
      brapiServerInfo.handler(brapiServerInfo.input.parse({ alias: 'missing' }), ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
  });

  it('honors forceRefresh by re-fetching the capability profile', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
    const callsAfterConnect = fetcher.mock.calls.length;

    // Non-refreshed follow-up should reuse the cached profile — no new /serverinfo hit.
    await brapiServerInfo.handler(brapiServerInfo.input.parse({}), ctx);
    const callsAfterCached = fetcher.mock.calls.length;
    const newCallsNoRefresh = callsAfterCached - callsAfterConnect;

    // Refreshed follow-up must re-hit /serverinfo.
    await brapiServerInfo.handler(brapiServerInfo.input.parse({ forceRefresh: true }), ctx);
    const callsAfterRefresh = fetcher.mock.calls.length;
    const newCallsWithRefresh = callsAfterRefresh - callsAfterCached;

    expect(newCallsWithRefresh).toBeGreaterThan(newCallsNoRefresh);
    const refreshedServerInfoHits = fetcher.mock.calls
      .slice(callsAfterCached)
      .filter((c) => String(c[0]).endsWith('/serverinfo'));
    expect(refreshedServerInfoHits.length).toBeGreaterThan(0);
  });
});
