/**
 * @fileoverview Unit tests for ServerRegistry. Covers alias validation, URL
 * normalization, auth mode resolution (including SGN token exchange via
 * stubbed fetcher), lookup/unregister semantics.
 *
 * @module tests/services/server-registry.test
 */

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
});
