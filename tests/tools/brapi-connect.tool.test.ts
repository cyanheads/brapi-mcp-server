/**
 * @fileoverview End-to-end tests for the `brapi_connect` tool. Wires the
 * real ServerRegistry + CapabilityRegistry + BrapiClient with a stubbed
 * fetcher so the orientation envelope is composed from realistic upstream
 * responses without hitting a live server.
 *
 * @module tests/tools/brapi-connect.tool.test
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resetConfig } from '@cyanheads/mcp-ts-core/config';
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

/** Captured before any test stubs `globalThis.fetch`; used only to reach local stub servers. */
const realFetch = globalThis.fetch;

/** Global fetch that rejects everything except the given local origin. */
function unmockedGlobalFetch(allowOrigin?: string) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    return allowOrigin && url.startsWith(allowOrigin)
      ? realFetch(input, init)
      : Promise.reject(new Error(`Unmocked global fetch: ${url}`));
  });
}

/** Env vars any test here may set; blanked per test so a developer `.env` never leaks in. */
const BLANKED_ENV = [
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
];

describe('brapi_connect tool', () => {
  let fetcher: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetcher = vi.fn(async (url: string) => {
      throw new Error(`Unmocked fetcher call: ${url}`);
    });
    vi.stubGlobal('fetch', unmockedGlobalFetch());
    initBrapiClient(baseConfig, fetcher as unknown as Fetcher);
    initCapabilityRegistry(baseConfig);
    initBrapiDialectRegistry();
    initServerRegistry(baseConfig);
    // Bun auto-loads .env, which can leak BRAPI_* vars into tests. Clear the
    // ones any test in this suite might unintentionally pick up.
    for (const key of BLANKED_ENV) vi.stubEnv(key, '');
  });

  afterEach(() => {
    resetBrapiClient();
    resetCapabilityRegistry();
    resetBrapiDialectRegistry();
    resetServerRegistry();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
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
    expect(result.dialect.notes).toEqual([]);
    // studies via GET, germplasm via GET; no variables or locations route.
    expect(result.nextToolSuggestions).toEqual([
      {
        toolName: 'brapi_find_studies',
        reason: 'The server exposes studies; start here to find study DbIds.',
        args: { alias: 'default' },
      },
      {
        toolName: 'brapi_find_germplasm',
        reason: 'The server exposes germplasm; start here to find germplasm DbIds.',
        args: { alias: 'default' },
      },
    ]);
    const text = (brapiConnect.format!(result)[0] as { text: string }).text;
    for (const suggestion of result.nextToolSuggestions) {
      expect(text).toContain(`\`${suggestion.toolName}\` \`{"alias":"default"}\``);
    }
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
    expect(result.dialect.notes.some((note) => note.includes('SGN/Breedbase'))).toBe(true);
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
    expect(result.dialect.notes).toEqual([]);
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
        notes: [],
      },
      content: { crops: ['Cassava'], studyCount: 42 },
      nextToolSuggestions: [
        {
          toolName: 'brapi_find_germplasm' as const,
          reason: 'The server exposes germplasm; start here to find germplasm DbIds.',
          args: { alias: 'default' },
        },
      ],
      notes: ['Test note'],
      fetchedAt: '2026-04-23T00:00:00.000Z',
    };
    const blocks = brapiConnect.format!(envelope);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain(
      '- `brapi_find_germplasm` `{"alias":"default"}` — The server exposes germplasm; start here to find germplasm DbIds.',
    );
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

  it('advertises only the anonymous-read builtins and the shared-namespace caveat', () => {
    expect(brapiConnect.description).toContain('`bti-cassava`');
    expect(brapiConnect.description).not.toMatch(/t3-/);
    expect(brapiConnect.description).toMatch(/re-registering an alias re-points/i);
  });
});

describe('brapi_connect against an auth-walled server (real socket)', () => {
  type Route = (req: IncomingMessage, res: ServerResponse) => void;
  const socketConfig: ServerConfig = { ...baseConfig, allowPrivateIps: true };
  let server: Server;
  let baseUrl: string;
  let hits: string[];
  let routes: Record<string, Route>;

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
      res.writeHead(code).end(`HTTP ${code}`);
    };
  const walled =
    (code: number, ok200: Route): Route =>
    (req, res) =>
      req.headers.authorization === 'Bearer good' ? ok200(req, res) : status(code)(req, res);

  beforeEach(async () => {
    hits = [];
    routes = {};
    server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://stub').pathname.replace(/^\/brapi\/v2/, '');
      hits.push(path);
      (routes[path] ?? status(404))(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    baseUrl = `${origin}/brapi/v2`;
    vi.stubGlobal('fetch', unmockedGlobalFetch(origin));
    initBrapiClient(socketConfig);
    initCapabilityRegistry(socketConfig);
    initBrapiDialectRegistry();
    initServerRegistry(socketConfig);
    for (const key of BLANKED_ENV) vi.stubEnv(key, '');
  });

  afterEach(async () => {
    resetBrapiClient();
    resetCapabilityRegistry();
    resetBrapiDialectRegistry();
    resetServerRegistry();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function cachedProfileKeys(ctx: ReturnType<typeof createMockContext>) {
    return (await ctx.state.list('brapi/capability/')).items.map((i) => i.key);
  }

  it('fails with upstream_unauthorized and a credentials hint on a 401 /serverinfo, caching nothing', async () => {
    routes['/serverinfo'] = walled(401, ok({ calls: [{ service: 'studies', methods: ['GET'] }] }));
    routes['/commoncropnames'] = ok({ data: ['Wheat'] });
    const ctx = createMockContext({ tenantId: 't1', errors: brapiConnect.errors });

    const error = await brapiConnect
      .handler(brapiConnect.input.parse({ baseUrl, alias: 'walled' }), ctx)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Unauthorized,
      data: {
        reason: 'upstream_unauthorized',
        status: 401,
        recovery: { hint: expect.stringMatching(/credentials/i) },
      },
    });
    expect(hits).toEqual(['/serverinfo']);
    expect(await cachedProfileKeys(ctx)).toEqual([]);

    // A later connect with working credentials succeeds and orients normally.
    const result = await brapiConnect.handler(
      brapiConnect.input.parse({
        baseUrl,
        alias: 'walled',
        auth: { mode: 'bearer', token: 'good' },
      }),
      ctx,
    );
    expect(result.auth.mode).toBe('bearer');
    expect(result.capabilities.supported).toEqual(['studies']);
    expect(result.content.crops).toEqual(['Wheat']);
  });

  it('fails with upstream_forbidden on a 403 /serverinfo', async () => {
    routes['/serverinfo'] = status(403);
    const ctx = createMockContext({ tenantId: 't1', errors: brapiConnect.errors });

    await expect(
      brapiConnect.handler(brapiConnect.input.parse({ baseUrl }), ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: {
        reason: 'upstream_forbidden',
        recovery: { hint: expect.stringMatching(/credentials/i) },
      },
    });
    expect(await cachedProfileKeys(ctx)).toEqual([]);
  });

  it('fails the same way when only the /calls fallback answers 401', async () => {
    routes['/serverinfo'] = ok({ serverName: 'Walled BrAPI' });
    routes['/calls'] = status(401);
    const ctx = createMockContext({ tenantId: 't1', errors: brapiConnect.errors });

    await expect(
      brapiConnect.handler(brapiConnect.input.parse({ baseUrl }), ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Unauthorized,
      data: { reason: 'upstream_unauthorized' },
    });
    expect(hits).toEqual(['/serverinfo', '/calls']);
    expect(await cachedProfileKeys(ctx)).toEqual([]);
  });

  it('still connects when only /commoncropnames answers 401', async () => {
    routes['/serverinfo'] = ok({ calls: [{ service: 'studies', methods: ['GET'] }] });
    routes['/commoncropnames'] = status(401);
    routes['/studies'] = (_req, res) => {
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ metadata: { pagination: { totalCount: 7 } }, result: { data: [] } }));
    };
    const ctx = createMockContext({ tenantId: 't1', errors: brapiConnect.errors });

    const result = await brapiConnect.handler(brapiConnect.input.parse({ baseUrl }), ctx);
    expect(result.capabilities.supported).toEqual(['studies']);
    expect(result.content.crops).toEqual([]);
    expect(result.content.studyCount).toBe(7);
    expect(result.notes.some((n) => n.includes('/commoncropnames'))).toBe(true);
  });

  describe('a failed connect leaves registration state untouched', () => {
    const STUDIES = ok({ calls: [{ service: 'studies', methods: ['GET'] }] });

    it('does not register an alias whose profile fetch answers 401', async () => {
      routes['/serverinfo'] = status(401);
      const ctx = createMockContext({ tenantId: 't1', errors: brapiConnect.errors });

      await expect(
        brapiConnect.handler(brapiConnect.input.parse({ baseUrl, alias: 'fresh' }), ctx),
      ).rejects.toMatchObject({ data: { reason: 'upstream_unauthorized' } });
      expect(await ctx.state.get('brapi/conn/fresh')).toBeNull();
      expect(await cachedProfileKeys(ctx)).toEqual([]);
    });

    it('does not register an alias whose profile fetch answers 403', async () => {
      routes['/serverinfo'] = status(403);
      const ctx = createMockContext({ tenantId: 't1', errors: brapiConnect.errors });

      await expect(
        brapiConnect.handler(brapiConnect.input.parse({ baseUrl, alias: 'fresh' }), ctx),
      ).rejects.toMatchObject({ data: { reason: 'upstream_forbidden' } });
      expect(await ctx.state.get('brapi/conn/fresh')).toBeNull();
    });

    it('keeps the previous working registration and its cached profile after a 401 reconnect', async () => {
      routes['/serverinfo'] = walled(401, STUDIES);
      routes['/commoncropnames'] = ok({ data: ['Wheat'] });
      const ctx = createMockContext({ tenantId: 't1', errors: brapiConnect.errors });

      await brapiConnect.handler(
        brapiConnect.input.parse({
          baseUrl,
          alias: 'walled',
          auth: { mode: 'bearer', token: 'good' },
        }),
        ctx,
      );
      const before = await ctx.state.get('brapi/conn/walled');
      const profilesBefore = await cachedProfileKeys(ctx);
      expect(before).toMatchObject({ authMode: 'bearer' });
      expect(profilesBefore).toHaveLength(1);

      await expect(
        brapiConnect.handler(brapiConnect.input.parse({ baseUrl, alias: 'walled' }), ctx),
      ).rejects.toMatchObject({ data: { reason: 'upstream_unauthorized' } });

      expect(await ctx.state.get('brapi/conn/walled')).toEqual(before);
      expect(await cachedProfileKeys(ctx)).toEqual(profilesBefore);

      // The surviving registration still works without another connect.
      const hitsBefore = hits.length;
      const info = await brapiServerInfo.handler(
        brapiServerInfo.input.parse({ alias: 'walled' }),
        ctx,
      );
      expect(info.auth.mode).toBe('bearer');
      expect(info.capabilities.supported).toEqual(['studies']);
      expect(hits.slice(hitsBefore)).not.toContain('/serverinfo');
    });

    it('keeps the previous registration when a token exchange fails', async () => {
      routes['/serverinfo'] = STUDIES;
      routes['/token'] = status(500);
      const ctx = createMockContext({ tenantId: 't1', errors: brapiConnect.errors });

      await brapiConnect.handler(brapiConnect.input.parse({ baseUrl, alias: 'sgn' }), ctx);
      const before = await ctx.state.get('brapi/conn/sgn');
      expect(before).toMatchObject({ authMode: 'none' });

      await expect(
        brapiConnect.handler(
          brapiConnect.input.parse({
            baseUrl,
            alias: 'sgn',
            auth: { mode: 'sgn', username: 'u', password: 'p' },
          }),
          ctx,
        ),
      ).rejects.toMatchObject({ data: { reason: 'auth_token_exchange_failed' } });
      expect(await ctx.state.get('brapi/conn/sgn')).toEqual(before);
    });
  });
});

describe('brapi_connect env credential pairing', () => {
  let fetcher: ReturnType<typeof vi.fn>;
  let globalFetch: ReturnType<typeof unmockedGlobalFetch>;

  beforeEach(() => {
    fetcher = vi.fn(async (url: string) => {
      throw new Error(`Unmocked fetcher call: ${url}`);
    });
    globalFetch = unmockedGlobalFetch();
    vi.stubGlobal('fetch', globalFetch);
    initBrapiClient(baseConfig, fetcher as unknown as Fetcher);
    initCapabilityRegistry(baseConfig);
    initBrapiDialectRegistry();
    initServerRegistry(baseConfig);
    for (const key of BLANKED_ENV) vi.stubEnv(key, '');
  });

  afterEach(() => {
    resetBrapiClient();
    resetCapabilityRegistry();
    resetBrapiDialectRegistry();
    resetServerRegistry();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('refuses a mismatched caller baseUrl before any /token exchange or upstream request', async () => {
    vi.stubEnv('BRAPI_CASSAVA_BASE_URL', BASE_URL);
    vi.stubEnv('BRAPI_CASSAVA_USERNAME', 'envuser');
    vi.stubEnv('BRAPI_CASSAVA_PASSWORD', 'envpass');
    const ctx = createMockContext({ tenantId: 't1', errors: brapiConnect.errors });

    const error = await brapiConnect
      .handler(
        brapiConnect.input.parse({ alias: 'cassava', baseUrl: 'https://other.example/brapi/v2' }),
        ctx,
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: {
        reason: 'auth_base_url_mismatch',
        retryable: false,
        recovery: { hint: expect.stringContaining('Omit `baseUrl`') },
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(await ctx.state.get('brapi/conn/cassava')).toBeNull();
  });

  it('refuses a caller baseUrl carrying userinfo without echoing it, even for a credentialed alias', async () => {
    vi.stubEnv('BRAPI_CASSAVA_BASE_URL', BASE_URL);
    vi.stubEnv('BRAPI_CASSAVA_USERNAME', 'envuser');
    vi.stubEnv('BRAPI_CASSAVA_PASSWORD', 'envpass');
    const ctx = createMockContext({ tenantId: 't1', errors: brapiConnect.errors });

    const error = await brapiConnect
      .handler(
        brapiConnect.input.parse({
          alias: 'cassava',
          baseUrl: 'https://someone:url-secret@other.example/brapi/v2',
        }),
        ctx,
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.ValidationError });
    const { message, data } = error as { message: string; data?: unknown };
    expect(JSON.stringify({ message, data })).not.toContain('url-secret');
    expect(fetcher).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(await ctx.state.get('brapi/conn/cassava')).toBeNull();
  });

  it('keeps the previous registration for the alias after a mismatch refusal', async () => {
    vi.stubEnv('BRAPI_CGIAR_BASE_URL', BASE_URL);
    vi.stubEnv('BRAPI_CGIAR_BEARER_TOKEN', 'env-tok');
    fetcher.mockImplementation(async () =>
      jsonResponse(envelope({ calls: [{ service: 'studies', methods: ['GET'] }] })),
    );
    const ctx = createMockContext({ tenantId: 't1', errors: brapiConnect.errors });
    await brapiConnect.handler(brapiConnect.input.parse({ alias: 'cgiar' }), ctx);
    const before = await ctx.state.get('brapi/conn/cgiar');
    const callsBefore = fetcher.mock.calls.length;

    await expect(
      brapiConnect.handler(
        brapiConnect.input.parse({ alias: 'cgiar', baseUrl: 'https://other.example/brapi/v2' }),
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'auth_base_url_mismatch' } });
    expect(await ctx.state.get('brapi/conn/cgiar')).toEqual(before);
    expect(fetcher.mock.calls.length).toBe(callsBefore);
  });

  it('keeps the env credentials when the caller baseUrl names the configured server', async () => {
    vi.stubEnv('BRAPI_CGIAR_BASE_URL', BASE_URL);
    vi.stubEnv('BRAPI_CGIAR_BEARER_TOKEN', 'env-tok');
    fetcher.mockImplementation(async () =>
      jsonResponse(envelope({ calls: [{ service: 'studies', methods: ['GET'] }] })),
    );
    const ctx = createMockContext({ tenantId: 't1', errors: brapiConnect.errors });

    const result = await brapiConnect.handler(
      brapiConnect.input.parse({ alias: 'cgiar', baseUrl: `${BASE_URL}/` }),
      ctx,
    );
    expect(result.auth.mode).toBe('bearer');
    const serverInfoCall = fetcher.mock.calls.find((c) => String(c[0]).endsWith('/serverinfo'));
    expect((serverInfoCall![3] as { headers: Record<string, string> }).headers.Authorization).toBe(
      'Bearer env-tok',
    );
  });

  it('refuses alias credentials with no URL of their own before any request', async () => {
    vi.stubEnv('BRAPI_DEFAULT_BASE_URL', BASE_URL);
    vi.stubEnv('BRAPI_CGIAR_BEARER_TOKEN', 'orphan-tok');
    const ctx = createMockContext({ tenantId: 't1', errors: brapiConnect.errors });

    const error = await brapiConnect
      .handler(brapiConnect.input.parse({ alias: 'cgiar' }), ctx)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      data: {
        reason: 'alias_base_url_unset',
        retryable: false,
        recovery: { hint: expect.stringContaining('BRAPI_CGIAR_BASE_URL') },
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(await ctx.state.get('brapi/conn/cgiar')).toBeNull();
  });

  it('connects anonymously when only default credentials exist for another server', async () => {
    vi.stubEnv('BRAPI_DEFAULT_BASE_URL', 'https://default.example/brapi/v2');
    vi.stubEnv('BRAPI_DEFAULT_BEARER_TOKEN', 'default-tok');
    fetcher.mockImplementation(async () =>
      jsonResponse(envelope({ calls: [{ service: 'studies', methods: ['GET'] }] })),
    );
    const ctx = createMockContext({ tenantId: 't1', errors: brapiConnect.errors });

    const result = await brapiConnect.handler(
      brapiConnect.input.parse({ alias: 'elsewhere', baseUrl: BASE_URL }),
      ctx,
    );
    expect(result.auth.mode).toBe('none');
    for (const call of fetcher.mock.calls) {
      const headers = (call[3] as { headers: Record<string, string> }).headers;
      expect(headers.Authorization).toBeUndefined();
    }
  });
});

describe('brapi_connect session gate for caller-supplied credentials', () => {
  const isolatedConfig: ServerConfig = { ...baseConfig, sessionIsolation: true };
  let fetcher: ReturnType<typeof vi.fn>;
  let globalFetch: ReturnType<typeof unmockedGlobalFetch>;

  function setDeployment(env: Record<string, string>, config: ServerConfig = isolatedConfig) {
    resetConfig(env);
    initServerRegistry(config);
  }

  beforeEach(() => {
    fetcher = vi.fn(async () =>
      jsonResponse(envelope({ calls: [{ service: 'studies', methods: ['GET'] }] })),
    );
    globalFetch = unmockedGlobalFetch();
    vi.stubGlobal('fetch', globalFetch);
    initBrapiClient(baseConfig, fetcher as unknown as Fetcher);
    initCapabilityRegistry(baseConfig);
    initBrapiDialectRegistry();
    for (const key of BLANKED_ENV) vi.stubEnv(key, '');
    setDeployment({ MCP_TRANSPORT_TYPE: 'http', MCP_AUTH_MODE: 'none' });
  });

  afterEach(() => {
    resetConfig();
    resetBrapiClient();
    resetCapabilityRegistry();
    resetBrapiDialectRegistry();
    resetServerRegistry();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const bearerInput = () =>
    brapiConnect.input.parse({
      baseUrl: BASE_URL,
      alias: 'mine',
      auth: { mode: 'bearer', token: 'caller-tok' },
    });

  it('refuses caller credentials on session-less HTTP with no per-user auth', async () => {
    const ctx = createMockContext({ tenantId: 'default', errors: brapiConnect.errors });

    const error = await brapiConnect.handler(bearerInput(), ctx).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: {
        reason: 'auth_session_required',
        retryable: false,
        recovery: { hint: expect.stringMatching(/session/i) },
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
    // Nothing registered, so no other session-less caller can ride the token.
    expect(await ctx.state.get('brapi/conn/mine')).toBeNull();
  });

  it('refuses SGN credentials before the /token exchange', async () => {
    const ctx = createMockContext({ tenantId: 'default', errors: brapiConnect.errors });
    await expect(
      brapiConnect.handler(
        brapiConnect.input.parse({
          baseUrl: BASE_URL,
          auth: { mode: 'sgn', username: 'u', password: 'p' },
        }),
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'auth_session_required' } });
    expect(globalFetch).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('allows the same call when the request carries a session', async () => {
    const ctx = createMockContext({
      tenantId: 'default',
      sessionId: 'sess-1',
      errors: brapiConnect.errors,
    });
    const result = await brapiConnect.handler(bearerInput(), ctx);
    expect(result.auth.mode).toBe('bearer');
    expect(await ctx.state.get('brapi/conn/sess/sess-1/mine')).not.toBeNull();
  });

  it('keeps the previous keyless registration after refusing caller credentials', async () => {
    const ctx = createMockContext({ tenantId: 'default', errors: brapiConnect.errors });
    await brapiConnect.handler(
      brapiConnect.input.parse({ baseUrl: BASE_URL, alias: 'mine', auth: { mode: 'none' } }),
      ctx,
    );
    const before = await ctx.state.get('brapi/conn/mine');
    expect(before).toMatchObject({ authMode: 'none' });

    await expect(brapiConnect.handler(bearerInput(), ctx)).rejects.toMatchObject({
      data: { reason: 'auth_session_required' },
    });
    expect(await ctx.state.get('brapi/conn/mine')).toEqual(before);
  });

  it('allows keyless connections without a session', async () => {
    const ctx = createMockContext({ tenantId: 'default', errors: brapiConnect.errors });
    const result = await brapiConnect.handler(
      brapiConnect.input.parse({ baseUrl: BASE_URL, auth: { mode: 'none' } }),
      ctx,
    );
    expect(result.auth.mode).toBe('none');
  });

  it('allows operator env credentials without a session', async () => {
    vi.stubEnv('BRAPI_CGIAR_BASE_URL', BASE_URL);
    vi.stubEnv('BRAPI_CGIAR_BEARER_TOKEN', 'env-tok');
    const ctx = createMockContext({ tenantId: 'default', errors: brapiConnect.errors });
    const result = await brapiConnect.handler(brapiConnect.input.parse({ alias: 'cgiar' }), ctx);
    expect(result.auth.mode).toBe('bearer');
  });

  it('allows caller credentials over stdio', async () => {
    setDeployment({ MCP_TRANSPORT_TYPE: 'stdio', MCP_AUTH_MODE: 'none' });
    const ctx = createMockContext({ tenantId: 'default', errors: brapiConnect.errors });
    await expect(brapiConnect.handler(bearerInput(), ctx)).resolves.toMatchObject({
      auth: { mode: 'bearer' },
    });
  });

  it('allows caller credentials on an auth-scoped deployment', async () => {
    setDeployment({
      MCP_TRANSPORT_TYPE: 'http',
      MCP_AUTH_MODE: 'jwt',
      MCP_AUTH_SECRET_KEY: 'x'.repeat(32),
    });
    const ctx = createMockContext({ tenantId: 'tenant-a', errors: brapiConnect.errors });
    await expect(brapiConnect.handler(bearerInput(), ctx)).resolves.toMatchObject({
      auth: { mode: 'bearer' },
    });
  });

  it('allows caller credentials when session isolation is off', async () => {
    setDeployment(
      { MCP_TRANSPORT_TYPE: 'http', MCP_AUTH_MODE: 'none' },
      { ...baseConfig, sessionIsolation: false },
    );
    const ctx = createMockContext({ tenantId: 'default', errors: brapiConnect.errors });
    await expect(brapiConnect.handler(bearerInput(), ctx)).resolves.toMatchObject({
      auth: { mode: 'bearer' },
    });
  });
});
