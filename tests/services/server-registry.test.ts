/**
 * @fileoverview Unit tests for ServerRegistry. Covers alias validation, URL
 * normalization, auth mode resolution (including SGN token exchange via
 * stubbed fetcher), lookup/unregister semantics.
 *
 * @module tests/services/server-registry.test
 */

import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { CALL_DEADLINE_MS, UPSTREAM_TIMEOUT_HINT } from '@/services/brapi-client/index.js';
import { ServerRegistry, type TokenFetcher } from '@/services/server-registry/server-registry.js';

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
  sessionIsolation: true,
};

describe('ServerRegistry', () => {
  let tokenFetcher: ReturnType<typeof vi.fn<Parameters<TokenFetcher>, ReturnType<TokenFetcher>>>;
  let registry: ServerRegistry;

  beforeEach(() => {
    tokenFetcher = vi.fn(async (url: string) => {
      throw new Error(`Unmocked token fetch: ${url}`);
    });
    registry = new ServerRegistry(baseConfig, tokenFetcher as unknown as TokenFetcher);
  });

  describe('resolve / save', () => {
    it('resolve exchanges the token but persists nothing; save persists it', async () => {
      tokenFetcher.mockResolvedValue({ access_token: 'tok' });
      const ctx = createMockContext({ tenantId: 't1' });
      const resolved = await registry.resolve(ctx, {
        alias: 'x',
        baseUrl: `${BASE_URL}/`,
        auth: { mode: 'sgn', username: 'u', password: 'p' },
      });
      expect(resolved).toMatchObject({
        alias: 'x',
        baseUrl: BASE_URL,
        authMode: 'sgn',
        resolvedAuth: { headerValue: 'Bearer tok' },
      });
      expect(await registry.getOptional(ctx, 'x')).toBeNull();

      await registry.save(ctx, resolved);
      expect(await registry.getOptional(ctx, 'x')).toEqual(resolved);
    });

    it('a failed resolve leaves the existing registration in place', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const existing = await registry.register(ctx, { alias: 'x', baseUrl: BASE_URL });
      await expect(
        registry.resolve(ctx, {
          alias: 'x',
          baseUrl: BASE_URL,
          auth: { mode: 'sgn', username: 'u', password: 'p' },
        }),
      ).rejects.toThrow();
      expect(await registry.getOptional(ctx, 'x')).toEqual(existing);
    });
  });

  describe('register', () => {
    it('stores a connection with mode=none and no auth header', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const registered = await registry.register(ctx, { baseUrl: BASE_URL });
      expect(registered.alias).toBe('default');
      expect(registered.baseUrl).toBe(BASE_URL);
      expect(registered.authMode).toBe('none');
      expect(registered.resolvedAuth).toBeUndefined();
      expect(tokenFetcher).not.toHaveBeenCalled();
    });

    it('resolves bearer auth into an Authorization header', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const registered = await registry.register(ctx, {
        baseUrl: BASE_URL,
        auth: { mode: 'bearer', token: 'abc-xyz' },
      });
      expect(registered.resolvedAuth).toEqual({
        headerName: 'Authorization',
        headerValue: 'Bearer abc-xyz',
      });
    });

    it('resolves api_key with a custom header when provided', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const registered = await registry.register(ctx, {
        baseUrl: BASE_URL,
        auth: { mode: 'api_key', apiKey: 'sk-123', headerName: 'X-API-Key' },
      });
      expect(registered.resolvedAuth).toEqual({
        headerName: 'X-API-Key',
        headerValue: 'sk-123',
      });
    });

    it('falls back to the default api-key header when not overridden', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const registered = await registry.register(ctx, {
        baseUrl: BASE_URL,
        auth: { mode: 'api_key', apiKey: 'sk-123' },
      });
      expect(registered.resolvedAuth?.headerName).toBe('Authorization');
    });

    it('exchanges SGN credentials for a bearer token and captures the expiry', async () => {
      tokenFetcher.mockResolvedValue({
        access_token: 'access-456',
        expires_in: 3600,
      });
      const ctx = createMockContext({ tenantId: 't1' });

      const registered = await registry.register(ctx, {
        baseUrl: `${BASE_URL}/`,
        auth: { mode: 'sgn', username: 'alice', password: 'secret' },
      });

      expect(registered.baseUrl).toBe(BASE_URL); // trailing slash stripped
      expect(tokenFetcher).toHaveBeenCalledTimes(1);
      const call = tokenFetcher.mock.calls[0]!;
      expect(call[0]).toBe(`${BASE_URL}/token`);
      expect(call[1]).toEqual({
        username: 'alice',
        password: 'secret',
        grant_type: 'password',
      });
      expect(registered.resolvedAuth?.headerValue).toBe('Bearer access-456');
      expect(registered.resolvedAuth?.expiresAt).toBeDefined();
    });

    it.each([
      ['SGN', { mode: 'sgn', username: 'alice', password: 'wrong' }],
      ['OAuth2', { mode: 'oauth2', clientId: 'client-1', clientSecret: 'bad' }],
    ] as const)('rejects a %s token exchange that omits access_token', async (_mode, auth) => {
      tokenFetcher.mockResolvedValue({ error: 'invalid_client' });
      const ctx = createMockContext({ tenantId: 't1' });

      await expect(registry.register(ctx, { baseUrl: BASE_URL, auth })).rejects.toMatchObject({
        code: JsonRpcErrorCode.Forbidden,
      });
    });

    it('exchanges OAuth2 client credentials for a bearer token', async () => {
      tokenFetcher.mockResolvedValue({
        access_token: 'oauth-access',
        expires_in: 7200,
        token_type: 'Bearer',
      });
      const ctx = createMockContext({ tenantId: 't1' });
      const registered = await registry.register(ctx, {
        baseUrl: BASE_URL,
        auth: { mode: 'oauth2', clientId: 'client-1', clientSecret: 'secret-1' },
      });

      expect(tokenFetcher).toHaveBeenCalledTimes(1);
      expect(tokenFetcher.mock.calls[0]?.[0]).toBe(`${BASE_URL}/token`);
      expect(tokenFetcher.mock.calls[0]?.[1]).toEqual({
        client_id: 'client-1',
        client_secret: 'secret-1',
        grant_type: 'client_credentials',
      });
      expect(registered.resolvedAuth?.headerValue).toBe('Bearer oauth-access');
      expect(registered.resolvedAuth?.expiresAt).toBeDefined();
    });

    it('honors a custom OAuth2 tokenUrl', async () => {
      tokenFetcher.mockResolvedValue({ access_token: 'oauth-access' });
      const ctx = createMockContext({ tenantId: 't1' });
      await registry.register(ctx, {
        baseUrl: BASE_URL,
        auth: {
          mode: 'oauth2',
          clientId: 'client-1',
          clientSecret: 'secret-1',
          tokenUrl: 'https://auth.example.org/oauth/token',
        },
      });

      expect(tokenFetcher.mock.calls[0]?.[0]).toBe('https://auth.example.org/oauth/token');
    });

    it('clips the token exchange timeout to what remains of the call deadline', async () => {
      tokenFetcher.mockResolvedValue({ access_token: 'tok' });
      const slowConfigRegistry = new ServerRegistry(
        { ...baseConfig, requestTimeoutMs: 120_000 },
        tokenFetcher as unknown as TokenFetcher,
      );
      for (const mode of ['sgn', 'oauth2'] as const) {
        tokenFetcher.mockClear();
        const ctx = {
          ...createMockContext({ tenantId: 't1' }),
          timestamp: new Date(Date.now() - (CALL_DEADLINE_MS - 2_000)).toISOString(),
        };
        await slowConfigRegistry.register(ctx, {
          baseUrl: BASE_URL,
          auth:
            mode === 'sgn'
              ? { mode, username: 'u', password: 'p' }
              : { mode, clientId: 'c', clientSecret: 's' },
        });
        const timeoutMs = tokenFetcher.mock.calls[0]?.[3]?.timeoutMs;
        expect(timeoutMs).toBeGreaterThan(0);
        expect(timeoutMs).toBeLessThanOrEqual(2_000);
      }
    });

    it('keeps the configured token exchange timeout when the call deadline is further off', async () => {
      tokenFetcher.mockResolvedValue({ access_token: 'tok' });
      await registry.register(createMockContext({ tenantId: 't1' }), {
        baseUrl: BASE_URL,
        auth: { mode: 'sgn', username: 'u', password: 'p' },
      });
      expect(tokenFetcher.mock.calls[0]?.[3]?.timeoutMs).toBe(baseConfig.requestTimeoutMs);
    });

    it.each([
      ['an alias with unsupported characters', { baseUrl: BASE_URL, alias: 'has spaces' }],
      ['a non-HTTP base URL', { baseUrl: 'ftp://example.com' }],
      ['a malformed base URL', { baseUrl: 'not-a-url' }],
    ])('rejects %s', async (_label, input) => {
      const ctx = createMockContext({ tenantId: 't1' });
      await expect(registry.register(ctx, input)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
      });
    });

    it('rejects base URLs carrying userinfo without echoing it', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const err = await registry
        .register(ctx, { baseUrl: 'https://alice:hunter2@brapi.example.org/brapi/v2' })
        .catch((e: unknown) => e as { code: number; message: string; data?: unknown });
      expect(err).toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      expect(JSON.stringify({ m: err.message, d: err.data })).not.toContain('hunter2');
      expect(await registry.getOptional(ctx, 'default')).toBeNull();
    });
  });

  describe('get / getOptional', () => {
    it('round-trips a registered connection', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      await registry.register(ctx, {
        baseUrl: BASE_URL,
        alias: 'cassava',
        auth: { mode: 'bearer', token: 'tok' },
      });
      const fetched = await registry.get(ctx, 'cassava');
      expect(fetched.baseUrl).toBe(BASE_URL);
      expect(fetched.resolvedAuth?.headerValue).toBe('Bearer tok');
    });

    it('throws NotFound for missing aliases via get()', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      await expect(registry.get(ctx, 'missing')).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
      });
    });

    it('returns null via getOptional() for missing aliases', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      expect(await registry.getOptional(ctx, 'missing')).toBeNull();
    });
  });

  describe('list / unregister', () => {
    it('lists every registered connection for the tenant', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      await registry.register(ctx, { baseUrl: BASE_URL, alias: 'a' });
      await registry.register(ctx, { baseUrl: BASE_URL, alias: 'b' });
      const listed = await registry.list(ctx);
      expect(listed.map((s) => s.alias).sort()).toEqual(['a', 'b']);
    });

    it('unregister removes an alias', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      await registry.register(ctx, { baseUrl: BASE_URL, alias: 'a' });
      await registry.unregister(ctx, 'a');
      expect(await registry.getOptional(ctx, 'a')).toBeNull();
    });
  });

  /**
   * Session isolation tests. Production behavior under HTTP stateful/auto +
   * BRAPI_SESSION_ISOLATION=true (default): same tenant, distinct sessions
   * each carve their own connection bucket. Stdio and stateless HTTP fall
   * back to per-tenant keying.
   */
  describe('session isolation', () => {
    /**
     * Build N contexts that share one tenant-scoped state Map but each carry
     * a distinct sessionId. Mirrors what the framework produces in production
     * under one tenantId across multiple stateful HTTP sessions: one shared
     * `ctx.state` view, but each request envelope carries its own session ID.
     */
    function createSharedTenantContextsWithSessions(
      tenantId: string,
      sessionIds: ReadonlyArray<string | undefined>,
    ): Context[] {
      const store = new Map<string, unknown>();
      const buildState = () =>
        ({
          async get<T>(key: string) {
            return (store.get(key) as T | undefined) ?? null;
          },
          async set(key: string, value: unknown) {
            store.set(key, value);
          },
          async delete(key: string) {
            store.delete(key);
          },
          async list(prefix: string) {
            const items: Array<{ key: string; value: unknown }> = [];
            for (const [key, value] of store) {
              if (key.startsWith(prefix)) items.push({ key, value });
            }
            return { items };
          },
          async deleteMany() {
            return 0;
          },
          async getMany() {
            return new Map();
          },
          async setMany() {
            /* unused */
          },
        }) as unknown as Context['state'];

      return sessionIds.map((sessionId) => {
        const opts: { tenantId: string; sessionId?: string } = { tenantId };
        if (sessionId !== undefined) opts.sessionId = sessionId;
        const ctx = createMockContext(opts);
        (ctx as { state: Context['state'] }).state = buildState();
        return ctx;
      });
    }

    it('isolates the same alias across distinct sessions in the same tenant', async () => {
      const [ctxA, ctxB] = createSharedTenantContextsWithSessions('t1', ['sess-A', 'sess-B']);
      if (!ctxA || !ctxB) throw new Error('test setup');
      await registry.register(ctxA, { baseUrl: 'https://a.example.org/brapi/v2' });
      await registry.register(ctxB, { baseUrl: 'https://b.example.org/brapi/v2' });

      // Each session sees its own baseUrl under the same alias.
      expect((await registry.get(ctxA)).baseUrl).toBe('https://a.example.org/brapi/v2');
      expect((await registry.get(ctxB)).baseUrl).toBe('https://b.example.org/brapi/v2');
    });

    it('lists only the current session’s connections', async () => {
      const [ctxA, ctxB] = createSharedTenantContextsWithSessions('t1', ['sess-A', 'sess-B']);
      if (!ctxA || !ctxB) throw new Error('test setup');
      await registry.register(ctxA, { baseUrl: BASE_URL, alias: 'a-only' });
      await registry.register(ctxB, { baseUrl: BASE_URL, alias: 'b-only' });

      expect((await registry.list(ctxA)).map((s) => s.alias)).toEqual(['a-only']);
      expect((await registry.list(ctxB)).map((s) => s.alias)).toEqual(['b-only']);
    });

    it('one session’s alias is NotFound from another session', async () => {
      const [ctxA, ctxB] = createSharedTenantContextsWithSessions('t1', ['sess-A', 'sess-B']);
      if (!ctxA || !ctxB) throw new Error('test setup');
      await registry.register(ctxA, { baseUrl: BASE_URL, alias: 'private' });
      await expect(registry.get(ctxB, 'private')).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
      });
    });

    it('falls back to per-tenant keying when sessionId is undefined (stdio path)', async () => {
      const [ctxA, ctxB] = createSharedTenantContextsWithSessions('t1', [undefined, undefined]);
      if (!ctxA || !ctxB) throw new Error('test setup');
      await registry.register(ctxA, { baseUrl: BASE_URL, alias: 'shared' });
      // Without a sessionId, both contexts hash to the same key — second sees first's state.
      const fetched = await registry.get(ctxB, 'shared');
      expect(fetched.baseUrl).toBe(BASE_URL);
    });

    it('shares state across sessions when isolation is disabled', async () => {
      const sharedRegistry = new ServerRegistry(
        { ...baseConfig, sessionIsolation: false },
        tokenFetcher as unknown as TokenFetcher,
      );
      const [ctxA, ctxB] = createSharedTenantContextsWithSessions('t1', ['sess-A', 'sess-B']);
      if (!ctxA || !ctxB) throw new Error('test setup');
      await sharedRegistry.register(ctxA, { baseUrl: BASE_URL, alias: 'collab' });
      // Shared collaboration mode: session B sees session A's registration.
      const fetched = await sharedRegistry.get(ctxB, 'collab');
      expect(fetched.baseUrl).toBe(BASE_URL);
    });
  });
});

describe('ServerRegistry token exchange over a real socket', () => {
  const realFetch = globalThis.fetch;
  let server: Server;
  let origin: string;
  let tokenHits: number;
  let answer: ((res: ServerResponse) => void) | undefined;

  beforeEach(async () => {
    tokenHits = 0;
    answer = undefined;
    server = createServer((req, res) => {
      if (new URL(req.url ?? '/', 'http://stub').pathname !== '/brapi/v2/token') {
        res.writeHead(404).end();
        return;
      }
      tokenHits += 1;
      answer?.(res); // No answer: the exchange stalls.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/brapi/v2`;
    const localOrigin = new URL(origin).origin;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        new URL(String(input instanceof Request ? input.url : input)).origin === localOrigin
          ? realFetch(input, init)
          : Promise.reject(new Error(`Unmocked global fetch: ${String(input)}`)),
      ),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const realRegistry = (config: Partial<ServerConfig> = {}) =>
    new ServerRegistry({ ...baseConfig, allowPrivateIps: true, ...config });
  const AUTHS = [
    ['sgn', { mode: 'sgn', username: 'u', password: 'p' }],
    ['oauth2', { mode: 'oauth2', clientId: 'c', clientSecret: 's' }],
  ] as const;

  it.each(AUTHS)(
    'a %s /token that never answers fails as a retryable Timeout, not a credentials problem',
    async (_mode, auth) => {
      const ctx = createMockContext({ tenantId: 't1' });
      const startedAt = Date.now();

      const err = await realRegistry({ requestTimeoutMs: 300 })
        .register(ctx, { baseUrl: origin, auth })
        .catch((e: unknown) => e as McpError);

      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      expect(err.data).toMatchObject({
        retryable: true,
        recovery: { hint: UPSTREAM_TIMEOUT_HINT },
      });
      expect(err.data?.reason).toBeUndefined();
      expect(err.message).toMatch(/token exchange .* did not answer within 300 ms/i);
      expect(err.message).not.toMatch(/credentials/i);
      expect(tokenHits).toBe(1);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect((await ctx.state.list('brapi/conn/')).items).toEqual([]);
    },
  );

  it('a stall the call deadline cuts short reports the call deadline', async () => {
    const ctx = {
      ...createMockContext({ tenantId: 't1' }),
      // Enough of the deadline left that a loaded machine still sends the request.
      timestamp: new Date(Date.now() - (CALL_DEADLINE_MS - 1_000)).toISOString(),
    };

    const err = await realRegistry({ requestTimeoutMs: 30_000 })
      .register(ctx, { baseUrl: origin, auth: AUTHS[0][1] })
      .catch((e: unknown) => e as McpError);

    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data).toMatchObject({
      reason: 'call_deadline_exceeded',
      operation: 'POST /token',
      recovery: { hint: UPSTREAM_TIMEOUT_HINT },
    });
    expect(tokenHits).toBe(1);
  });

  it('a rejected exchange keeps auth_token_exchange_failed', async () => {
    answer = (res) => res.writeHead(401, { 'Content-Type': 'text/plain' }).end('denied');
    const err = await realRegistry()
      .register(createMockContext({ tenantId: 't1' }), { baseUrl: origin, auth: AUTHS[0][1] })
      .catch((e: unknown) => e as McpError);

    expect(err.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(err.data).toMatchObject({ reason: 'auth_token_exchange_failed' });
  });

  it.each(AUTHS)(
    'a %s /token on a private address fails private_address_blocked, not a credentials problem',
    async (_mode, auth) => {
      answer = (res) =>
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"access_token":"t"}');
      const ctx = createMockContext({ tenantId: 't1' });

      const err = await realRegistry({ allowPrivateIps: false })
        .register(ctx, { baseUrl: origin, auth })
        .catch((e: unknown) => e as McpError);

      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data).toMatchObject({
        reason: 'private_address_blocked',
        tokenUrl: `${origin}/token`,
      });
      expect(err.data?.recovery).toBeUndefined();
      expect(tokenHits).toBe(0);
      expect((await ctx.state.list('brapi/conn/')).items).toEqual([]);
    },
  );

  describe("never echoes a token URL's userinfo or query", () => {
    /** The stub's /token, carrying userinfo and a query secret. */
    const secretTokenUrl = () => {
      const u = new URL(`${origin}/token`);
      u.username = 'user';
      u.password = 'pass';
      u.search = '?client_secret=leak';
      return u.toString();
    };
    const SECRETS = ['user:pass', 'pass@', 'client_secret', 'leak'];
    const json = { 'Content-Type': 'application/json' };
    const register = () =>
      realRegistry({ requestTimeoutMs: 300 })
        .register(createMockContext({ tenantId: 't1' }), {
          baseUrl: origin,
          auth: { mode: 'oauth2', clientId: 'c', clientSecret: 's', tokenUrl: secretTokenUrl() },
        })
        .catch((e: unknown) => e as McpError);
    const expectNoSecrets = (err: McpError) => {
      expect(err.data?.tokenUrl).toBe(`${origin}/token`);
      // The log record carries the whole cause chain, so every link is checked.
      const chain: unknown[] = [];
      for (let e: unknown = err; e instanceof Error; e = e.cause) {
        chain.push({ message: e.message, data: (e as { data?: unknown }).data });
      }
      const surface = JSON.stringify(chain);
      for (const secret of SECRETS) expect(surface).not.toContain(secret);
    };

    it('when the runtime refuses to send a URL carrying userinfo', async () => {
      const err = await register();

      expect(err.code).toBe(JsonRpcErrorCode.Forbidden);
      expect(err.data?.reason).toBe('auth_token_exchange_failed');
      expect(tokenHits).toBe(0);
      expectNoSecrets(err);
    });

    it.each([
      ['a stall', undefined, JsonRpcErrorCode.Timeout],
      [
        'a rejection',
        (res: ServerResponse) => res.writeHead(401, { 'Content-Type': 'text/plain' }).end('no'),
        JsonRpcErrorCode.Forbidden,
      ],
      [
        'an answer without access_token',
        (res: ServerResponse) => res.writeHead(200, json).end('{"error":"invalid_client"}'),
        JsonRpcErrorCode.Forbidden,
      ],
      [
        'an empty body',
        (res: ServerResponse) => res.writeHead(200, json).end(),
        JsonRpcErrorCode.ServiceUnavailable,
      ],
      [
        'a non-JSON body',
        (res: ServerResponse) => res.writeHead(200, json).end('<html>'),
        JsonRpcErrorCode.ServiceUnavailable,
      ],
    ] as const)('on %s, names only its origin and path', async (_label, respond, code) => {
      answer = respond;
      // Node's fetch refuses a URL carrying userinfo before sending it, while
      // Bun sends it; drop the userinfo on the way out so the stub answers.
      const localOrigin = new URL(origin).origin;
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          const u = new URL(String(input instanceof Request ? input.url : input));
          if (u.origin !== localOrigin) return Promise.reject(new Error(`Unmocked: ${u.origin}`));
          u.username = '';
          u.password = '';
          return realFetch(u, init);
        }),
      );

      const err = await register();

      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(code);
      expect(tokenHits).toBe(1);
      expectNoSecrets(err);
    });
  });

  it('a caller cancelling a stalled exchange gets RequestCancelled, not a credentials failure', async () => {
    const controller = new AbortController();
    const ctx = createMockContext({ tenantId: 't1', signal: controller.signal });
    const pending = realRegistry({ requestTimeoutMs: 5_000 })
      .register(ctx, { baseUrl: origin, auth: AUTHS[0][1] })
      .catch((e: unknown) => e as McpError);
    await vi.waitFor(() => expect(tokenHits).toBe(1));
    controller.abort();

    const err = await pending;
    expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(err.data?.reason).not.toBe('auth_token_exchange_failed');
  });
});
