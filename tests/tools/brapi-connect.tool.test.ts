/**
 * @fileoverview End-to-end tests for the `brapi_connect` tool. Wires the
 * real ServerRegistry + CapabilityRegistry + BrapiClient with a stubbed
 * fetcher so the orientation envelope is composed from realistic upstream
 * responses without hitting a live server.
 *
 * @module tests/tools/brapi-connect.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
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
  searchPollTimeoutMs: 5_000,
  searchPollIntervalMs: 1,
  allowPrivateIps: false,
  enableWrites: false,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function envelope(result: unknown, pagination?: { totalCount: number }) {
  return {
    metadata: pagination ? { pagination } : {},
    result,
  };
}

describe('brapi_connect tool', () => {
  let fetcher: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetcher = vi.fn();
    initBrapiClient(baseConfig, fetcher as unknown as Fetcher);
    initCapabilityRegistry(baseConfig);
    initBrapiDialectRegistry();
    initServerRegistry(baseConfig);
    // Bun auto-loads .env, which can leak BRAPI_* vars into tests. Clear the
    // ones any test in this suite might unintentionally pick up.
    for (const key of [
      'BRAPI_DEFAULT_BASE_URL',
      'BRAPI_DEFAULT_USERNAME',
      'BRAPI_DEFAULT_PASSWORD',
      'BRAPI_DEFAULT_API_KEY',
      'BRAPI_DEFAULT_BEARER_TOKEN',
      'BRAPI_CASSAVA_BASE_URL',
      'BRAPI_CASSAVA_USERNAME',
      'BRAPI_CASSAVA_PASSWORD',
      'BRAPI_CGIAR_BASE_URL',
      'BRAPI_CGIAR_BEARER_TOKEN',
      'BRAPI_PROD_BASE_URL',
      'BRAPI_PROD_API_KEY',
      'BRAPI_PROD_API_KEY_HEADER',
    ]) {
      vi.stubEnv(key, '');
    }
  });

  afterEach(() => {
    resetBrapiClient();
    resetCapabilityRegistry();
    resetBrapiDialectRegistry();
    resetServerRegistry();
    vi.unstubAllEnvs();
  });

  it('registers the connection, loads the capability profile, and composes the orientation envelope', async () => {
    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/serverinfo')) {
        return jsonResponse(
          envelope({
            serverName: 'Test BrAPI',
            organizationName: 'Test Org',
            calls: [
              { service: 'studies', methods: ['GET'], versions: ['2.1'] },
              { service: 'germplasm', methods: ['GET'], versions: ['2.1'] },
              { service: 'search/studies', methods: ['POST'], versions: ['2.1'] },
            ],
          }),
        );
      }
      if (u.pathname.endsWith('/commoncropnames')) {
        return jsonResponse(envelope({ data: ['Cassava', 'Yam'] }));
      }
      if (u.pathname.endsWith('/studies')) {
        return jsonResponse(envelope({ data: [] }, { totalCount: 42 }));
      }
      if (u.pathname.endsWith('/germplasm')) {
        return jsonResponse(envelope({ data: [] }, { totalCount: 312 }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const ctx = createMockContext({ tenantId: 't1' });
    const input = brapiConnect.input.parse({ baseUrl: BASE_URL });

    const result = await brapiConnect.handler(input, ctx);

    expect(result.alias).toBe('default');
    expect(result.baseUrl).toBe(BASE_URL);
    expect(result.server.name).toBe('Test BrAPI');
    expect(result.server.brapiVersion).toBe('2.1');
    expect(result.auth.mode).toBe('none');
    expect(result.capabilities.supportedCount).toBe(3);
    expect(result.capabilities.supported).toContain('studies');
    expect(result.capabilities.notableGaps).toContain('observations');
    expect(result.content.crops).toEqual(['Cassava', 'Yam']);
    expect(result.content.studyCount).toBe(42);
    expect(result.content.germplasmCount).toBe(312);
    expect(result.content.programCount).toBeUndefined(); // programs not in /calls
    // Spec dialect (no quirks) for a generic test server.
    expect(result.dialect.id).toBe('spec');
    expect(result.dialect.source).toBe('fallback');
    expect(result.dialect.envVar).toBe('BRAPI_DEFAULT_DIALECT');
    expect(result.dialect.disabledSearchEndpoints).toEqual([]);
  });

  it('surfaces the cassavabase dialect with disabled-search nouns when /serverinfo names CassavaBase', async () => {
    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/serverinfo')) {
        return jsonResponse(
          envelope({
            serverName: 'CassavaBase',
            calls: [{ service: 'studies', methods: ['GET'], versions: ['2.1'] }],
          }),
        );
      }
      if (u.pathname.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: [] }));
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });

    const ctx = createMockContext({ tenantId: 't1' });
    const result = await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);

    expect(result.dialect.id).toBe('cassavabase');
    expect(result.dialect.source).toBe('server-name');
    expect(result.dialect.disabledSearchEndpoints).toContain('germplasm');
    expect(result.dialect.disabledSearchEndpoints).toContain('studies');
    expect(result.dialect.disabledSearchEndpoints).not.toContain('calls');
  });

  it('honors BRAPI_<ALIAS>_DIALECT env override and reflects source=env-override', async () => {
    vi.stubEnv('BRAPI_DEFAULT_DIALECT', 'spec');
    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/serverinfo')) {
        return jsonResponse(
          envelope({
            serverName: 'CassavaBase', // would otherwise resolve to cassavabase
            calls: [{ service: 'studies', methods: ['GET'], versions: ['2.1'] }],
          }),
        );
      }
      if (u.pathname.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: [] }));
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });

    const ctx = createMockContext({ tenantId: 't1' });
    const result = await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);

    expect(result.dialect.id).toBe('spec');
    expect(result.dialect.source).toBe('env-override');
    expect(result.dialect.disabledSearchEndpoints).toEqual([]);
  });

  it('attaches the bearer header on the upstream /serverinfo call', async () => {
    fetcher.mockImplementation(async () =>
      jsonResponse(envelope({ calls: [{ service: 'studies', methods: ['GET'] }] })),
    );

    const ctx = createMockContext({ tenantId: 't1' });
    const input = brapiConnect.input.parse({
      baseUrl: BASE_URL,
      auth: { mode: 'bearer', token: 'tok-123' },
    });
    await brapiConnect.handler(input, ctx);

    const serverInfoCall = fetcher.mock.calls.find((c) => String(c[0]).endsWith('/serverinfo'));
    expect(serverInfoCall).toBeDefined();
    const headers = (serverInfoCall![3] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer tok-123');
  });

  it('supports a custom alias and keeps connections separate', async () => {
    fetcher.mockImplementation(async () =>
      jsonResponse(envelope({ calls: [{ service: 'studies', methods: ['GET'] }] })),
    );

    const ctx = createMockContext({ tenantId: 't1' });
    await brapiConnect.handler(
      brapiConnect.input.parse({ baseUrl: BASE_URL, alias: 'cassava' }),
      ctx,
    );
    await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL, alias: 'yam' }), ctx);

    // Both aliases persisted in state.
    const cassava = await ctx.state.get('brapi/conn/cassava');
    const yam = await ctx.state.get('brapi/conn/yam');
    expect(cassava).toBeDefined();
    expect(yam).toBeDefined();
  });

  it('rejects invalid base URLs via ValidationError', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    await expect(
      brapiConnect.handler(
        {
          baseUrl: 'ftp://example.com' as unknown as string,
          auth: { mode: 'none' },
          alias: 'default',
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
  });

  it('falls back to BRAPI_DEFAULT_BASE_URL when agent omits baseUrl', async () => {
    vi.stubEnv('BRAPI_DEFAULT_BASE_URL', 'https://env-default.example.org/brapi/v2');
    fetcher.mockImplementation(async () =>
      jsonResponse(envelope({ calls: [{ service: 'studies', methods: ['GET'] }] })),
    );

    const ctx = createMockContext({ tenantId: 't1' });
    const result = await brapiConnect.handler(brapiConnect.input.parse({}), ctx);

    expect(result.baseUrl).toBe('https://env-default.example.org/brapi/v2');
    expect(result.auth.mode).toBe('none');
  });

  it('derives bearer auth from BRAPI_<ALIAS>_BEARER_TOKEN env var', async () => {
    vi.stubEnv('BRAPI_CGIAR_BASE_URL', BASE_URL);
    vi.stubEnv('BRAPI_CGIAR_BEARER_TOKEN', 'env-tok');
    fetcher.mockImplementation(async () =>
      jsonResponse(envelope({ calls: [{ service: 'studies', methods: ['GET'] }] })),
    );

    const ctx = createMockContext({ tenantId: 't1' });
    const result = await brapiConnect.handler(brapiConnect.input.parse({ alias: 'cgiar' }), ctx);

    expect(result.baseUrl).toBe(BASE_URL);
    expect(result.auth.mode).toBe('bearer');
    const serverInfoCall = fetcher.mock.calls.find((c) => String(c[0]).endsWith('/serverinfo'));
    const headers = (serverInfoCall![3] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer env-tok');
  });

  it('derives api_key auth from BRAPI_<ALIAS>_API_KEY env var with custom header', async () => {
    vi.stubEnv('BRAPI_PROD_BASE_URL', BASE_URL);
    vi.stubEnv('BRAPI_PROD_API_KEY', 'k123');
    vi.stubEnv('BRAPI_PROD_API_KEY_HEADER', 'X-API-Key');
    fetcher.mockImplementation(async () =>
      jsonResponse(envelope({ calls: [{ service: 'studies', methods: ['GET'] }] })),
    );

    const ctx = createMockContext({ tenantId: 't1' });
    const result = await brapiConnect.handler(brapiConnect.input.parse({ alias: 'prod' }), ctx);

    expect(result.auth.mode).toBe('api_key');
    const serverInfoCall = fetcher.mock.calls.find((c) => String(c[0]).endsWith('/serverinfo'));
    const headers = (serverInfoCall![3] as { headers: Record<string, string> }).headers;
    expect(headers['X-API-Key']).toBe('k123');
  });

  it('agent input overrides env vars', async () => {
    vi.stubEnv('BRAPI_CASSAVA_BASE_URL', 'https://env.example/brapi/v2');
    vi.stubEnv('BRAPI_CASSAVA_USERNAME', 'envuser');
    vi.stubEnv('BRAPI_CASSAVA_PASSWORD', 'envpass');
    fetcher.mockImplementation(async () =>
      jsonResponse(envelope({ calls: [{ service: 'studies', methods: ['GET'] }] })),
    );

    const ctx = createMockContext({ tenantId: 't1' });
    const result = await brapiConnect.handler(
      brapiConnect.input.parse({
        alias: 'cassava',
        baseUrl: BASE_URL,
        auth: { mode: 'bearer', token: 'agent-tok' },
      }),
      ctx,
    );

    expect(result.baseUrl).toBe(BASE_URL);
    expect(result.auth.mode).toBe('bearer');
    const serverInfoCall = fetcher.mock.calls.find((c) => String(c[0]).endsWith('/serverinfo'));
    const headers = (serverInfoCall![3] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer agent-tok');
  });

  it('throws ValidationError when no baseUrl is set anywhere', async () => {
    // Bun auto-loads .env, so explicitly clear any baseUrl env var that may
    // be present from the developer's local .env.
    vi.stubEnv('BRAPI_DEFAULT_BASE_URL', '');
    const ctx = createMockContext({ tenantId: 't1' });
    await expect(brapiConnect.handler(brapiConnect.input.parse({}), ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringMatching(/No baseUrl provided/),
    });
  });

  it('format() produces a readable markdown summary covering every surface', () => {
    const envelope = {
      alias: 'default',
      baseUrl: BASE_URL,
      server: { name: 'Test BrAPI', brapiVersion: '2.1', organizationName: 'Test Org' },
      auth: { mode: 'bearer' as const, headerName: 'Authorization' },
      capabilities: {
        supportedCount: 3,
        supported: ['germplasm', 'search/studies', 'studies'],
        notableGaps: ['observations', 'locations'],
      },
      dialect: {
        id: 'spec',
        source: 'fallback' as const,
        envVar: 'BRAPI_DEFAULT_DIALECT',
        disabledSearchEndpoints: [],
      },
      content: { crops: ['Cassava'], studyCount: 42 },
      notes: ['Test note'],
      fetchedAt: '2026-04-23T00:00:00.000Z',
    };
    const blocks = brapiConnect.format!(envelope);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Test BrAPI');
    expect(text).toContain('2.1');
    expect(text).toContain('Cassava');
    expect(text).toContain('42');
    expect(text).toContain('observations, locations');
    expect(text).toContain('Test note');
    // Dialect block surfaces id, source, and pin override.
    expect(text).toContain('spec');
    expect(text).toContain('fallback');
    expect(text).toContain('BRAPI_DEFAULT_DIALECT');
  });
});
