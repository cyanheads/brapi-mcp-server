/**
 * @fileoverview Unit tests for ServerRegistry. Covers alias validation, URL
 * normalization, auth mode resolution (including SGN token exchange via
 * stubbed fetcher), lookup/unregister semantics.
 *
 * @module tests/services/server-registry.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
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
    tokenFetcher = vi.fn();
    registry = new ServerRegistry(baseConfig, tokenFetcher as unknown as TokenFetcher);
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

    it('rejects SGN token exchange that omits access_token', async () => {
      tokenFetcher.mockResolvedValue({ error: 'bad creds' });
      const ctx = createMockContext({ tenantId: 't1' });

      await expect(
        registry.register(ctx, {
          baseUrl: BASE_URL,
          auth: { mode: 'sgn', username: 'alice', password: 'wrong' },
        }),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.Forbidden });
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

    it('rejects OAuth2 token exchange that omits access_token', async () => {
      tokenFetcher.mockResolvedValue({ error: 'invalid_client' });
      const ctx = createMockContext({ tenantId: 't1' });

      await expect(
        registry.register(ctx, {
          baseUrl: BASE_URL,
          auth: { mode: 'oauth2', clientId: 'client-1', clientSecret: 'bad' },
        }),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.Forbidden });
    });

    it('rejects aliases with unsupported characters', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      await expect(
        registry.register(ctx, { baseUrl: BASE_URL, alias: 'has spaces' }),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
    });

    it('rejects non-HTTP base URLs', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      await expect(registry.register(ctx, { baseUrl: 'ftp://example.com' })).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
      });
    });

    it('rejects malformed base URLs', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      await expect(registry.register(ctx, { baseUrl: 'not-a-url' })).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
      });
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
      // Legacy collaboration mode: session B sees session A's registration.
      const fetched = await sharedRegistry.get(ctxB, 'collab');
      expect(fetched.baseUrl).toBe(BASE_URL);
    });
  });
});
