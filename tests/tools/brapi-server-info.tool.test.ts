/**
 * @fileoverview End-to-end tests for `brapi_server_info`. Shares the same
 * service wiring + mock fetcher as `brapi_connect`, but tests that the tool
 * reads a previously registered connection and can force a capability
 * refresh.
 *
 * @module tests/tools/brapi-server-info.tool.test
 */

import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
import {
  initTestServices,
  type MockFetcher,
  envelope as pagedEnvelope,
  resetTestServices,
  jsonResponse as statusResponse,
  TEST_CONFIG,
} from './_tool-test-helpers.js';

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

describe('brapi_server_info on a fresh session (#59)', () => {
  const host = new URL(BASE_URL).hostname;
  let fetcher: MockFetcher;
  let tokenFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetcher = initTestServices({ ...TEST_CONFIG, allowPrivateIps: true });
    for (const key of [
      'BRAPI_DEFAULT_BASE_URL',
      'BRAPI_DEFAULT_BEARER_TOKEN',
      'BRAPI_OPS_BASE_URL',
      'BRAPI_OPS_USERNAME',
      'BRAPI_OPS_PASSWORD',
    ]) {
      vi.stubEnv(key, '');
    }
    fetcher.mockImplementation(async (url: string) => {
      const { hostname, pathname } = new URL(String(url));
      if (hostname !== host) throw new Error(`Unmocked fetcher call: ${url}`);
      if (pathname.endsWith('/serverinfo')) {
        return statusResponse(
          pagedEnvelope({
            serverName: 'Configured',
            calls: [{ service: 'studies', methods: ['GET'] }],
          }),
        );
      }
      if (pathname.endsWith('/commoncropnames')) return statusResponse(pagedEnvelope({ data: [] }));
      return statusResponse(pagedEnvelope({ data: [] }, { totalCount: 0 }));
    });
    tokenFetch = vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(`Unmocked global fetch: ${String(input)}`);
    });
    vi.stubGlobal('fetch', tokenFetch);
  });

  afterEach(() => {
    resetTestServices();
    vi.unstubAllGlobals();
  });

  const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
    result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

  it('returns the configured default server’s envelope with no brapi_connect, registering it once', async () => {
    vi.stubEnv('BRAPI_DEFAULT_BASE_URL', BASE_URL);
    const { state } = createMockContext({ tenantId: 't1' });
    // Bound to one state store, so successive contract runs share a session.
    const definition = {
      ...brapiServerInfo,
      handler(input, contractCtx) {
        return brapiServerInfo.handler(input, { ...contractCtx, state });
      },
    } satisfies typeof brapiServerInfo;
    const discoveryCalls = () =>
      fetcher.mock.calls.filter(([url]) => String(url).endsWith('/serverinfo')).length;

    const first = await runToolContract(definition, {}, { context: { tenantId: 't1' } });
    expect(first.isError).toBeFalsy();
    expect(first.structuredContent).toMatchObject({
      alias: 'default',
      baseUrl: BASE_URL,
      server: { name: 'Configured' },
    });
    expect(textOf(first)).toContain(BASE_URL);
    const registered = await state.get('brapi/conn/default');
    expect(registered).toMatchObject({ baseUrl: BASE_URL });
    expect(discoveryCalls()).toBe(1);

    const second = await runToolContract(definition, {}, { context: { tenantId: 't1' } });
    expect(second.isError).toBeFalsy();
    expect(discoveryCalls()).toBe(1);
    expect(await state.get('brapi/conn/default')).toEqual(registered);
  });

  /*
   * First-use registration itself is tabled at its seam (find-helpers'
   * requireRegisteredConnection tests); these pin the hint this tool's own
   * contract fills for each failure.
   */
  it.each([
    {
      reason: 'unknown_alias',
      // A default server never stands in for an alias that has no URL of its own.
      setup: () => vi.stubEnv('BRAPI_DEFAULT_BASE_URL', BASE_URL),
      input: { alias: 'typo-alias' },
      code: JsonRpcErrorCode.NotFound,
      data: { alias: 'typo-alias' },
      hint: 'brapi_connect with this alias and a `baseUrl`',
      upstreamCalled: false,
    },
    {
      reason: 'auth_token_exchange_failed',
      setup: () => {
        vi.stubEnv('BRAPI_OPS_BASE_URL', BASE_URL);
        vi.stubEnv('BRAPI_OPS_USERNAME', 'envuser');
        vi.stubEnv('BRAPI_OPS_PASSWORD', 'envpass');
        tokenFetch.mockImplementation(async (input: RequestInfo | URL) => {
          const url = new URL(String(input instanceof Request ? input.url : input));
          if (url.hostname !== host) throw new Error(`Unmocked global fetch: ${url.href}`);
          return statusResponse({ error: 'boom' }, 500);
        });
      },
      input: { alias: 'ops' },
      code: JsonRpcErrorCode.Forbidden,
      data: {},
      hint: 'credentials configured for this alias',
      upstreamCalled: false,
    },
    {
      reason: 'capability_discovery_unavailable',
      setup: () => {
        vi.stubEnv('BRAPI_DEFAULT_BASE_URL', BASE_URL);
        fetcher.mockImplementation(async (url: string) => {
          if (new URL(String(url)).hostname !== host) {
            throw new Error(`Unmocked fetcher call: ${url}`);
          }
          throw serviceUnavailable('Fetch failed. Status: 503', { status: 503 });
        });
      },
      input: {},
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { retryable: true },
      hint: 'Retry brapi_server_info in a minute',
      upstreamCalled: true,
    },
  ])('fills the $reason hint on both surfaces', async (c) => {
    c.setup();

    const result = await runToolContract(brapiServerInfo, c.input, {
      context: { tenantId: 't1' },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: c.code,
        data: { reason: c.reason, ...c.data, recovery: { hint: expect.stringContaining(c.hint) } },
      },
    });
    expect(textOf(result)).toContain(c.hint);
    expect(fetcher.mock.calls.length > 0).toBe(c.upstreamCalled);
  });
});
