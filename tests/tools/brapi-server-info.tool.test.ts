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
  initBrapiDialectRegistry,
  resetBrapiDialectRegistry,
} from '@/services/brapi-dialect/index.js';
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
  companionTimeoutMs: 500,
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
    fetcher = vi.fn(async (url: string) => {
      if (String(url).includes('/serverinfo')) {
        return jsonResponse(envelope({ calls: [{ service: 'studies', methods: ['GET'] }] }));
      }
      throw new Error(`Unmocked fetcher call: ${url}`);
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        throw new Error(`Unmocked global fetch: ${String(input)}`);
      }),
    );
    initBrapiClient(baseConfig, fetcher as unknown as Fetcher);
    initCapabilityRegistry(baseConfig);
    initBrapiDialectRegistry();
    initServerRegistry(baseConfig);
  });

  afterEach(() => {
    resetBrapiClient();
    resetCapabilityRegistry();
    resetBrapiDialectRegistry();
    resetServerRegistry();
    vi.unstubAllGlobals();
  });

  it('returns the orientation envelope for the default connection', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: brapiServerInfo.errors });
    await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);

    const result = await brapiServerInfo.handler(brapiServerInfo.input.parse({}), ctx);
    expect(result.alias).toBe('default');
    expect(result.baseUrl).toBe(BASE_URL);
  });

  it('throws NotFound with unknown_alias recovery on the wire when alias is unregistered', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: brapiServerInfo.errors });
    await expect(
      brapiServerInfo.handler(brapiServerInfo.input.parse({ alias: 'missing' }), ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'unknown_alias',
        alias: 'missing',
        recovery: { hint: expect.stringContaining('brapi_connect') },
      },
    });
  });

  it('honors forceRefresh by re-fetching the capability profile', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: brapiServerInfo.errors });
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

  it('carries the same nextToolSuggestions as brapi_connect on both surfaces', async () => {
    fetcher.mockImplementation(async (url: string) => {
      if (String(url).includes('/serverinfo')) {
        return jsonResponse(
          envelope({
            calls: [
              { service: 'search/studies' },
              { service: 'variables', methods: ['GET'] },
              { service: 'locations', methods: ['GET'] },
            ],
          }),
        );
      }
      return jsonResponse(envelope({ data: [] }));
    });
    const ctx = createMockContext({ tenantId: 't1', errors: brapiServerInfo.errors });
    const connected = await brapiConnect.handler(
      brapiConnect.input.parse({ baseUrl: BASE_URL, alias: 'mine' }),
      ctx,
    );
    const info = await brapiServerInfo.handler(brapiServerInfo.input.parse({ alias: 'mine' }), ctx);

    expect(connected.nextToolSuggestions.map((s) => s.toolName)).toEqual([
      'brapi_find_studies',
      'brapi_find_variables',
      'brapi_find_locations',
    ]);
    expect(info.nextToolSuggestions).toEqual(connected.nextToolSuggestions);
    expect(info.nextToolSuggestions.every((s) => s.args.alias === 'mine')).toBe(true);

    const section = (text: string) => text.slice(text.indexOf('## Suggested next tools'));
    const connectText = (brapiConnect.format!(connected)[0] as { text: string }).text;
    const infoText = (brapiServerInfo.format!(info)[0] as { text: string }).text;
    expect(section(infoText).split('\n## ')[0]).toBe(section(connectText).split('\n## ')[0]);
    expect(infoText).toContain('`brapi_find_variables` `{"alias":"mine"}`');
  });
});
