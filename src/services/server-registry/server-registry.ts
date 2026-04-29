/**
 * @fileoverview Session-scoped BrAPI connection registry. Maps named aliases
 * to resolved connection state (base URL, auth header) within a tenant's
 * `ctx.state`. Multi-server workflows register distinct aliases; tools read
 * the alias from input (defaulting to `default`) and pull the base URL +
 * auth header for routing. Auth modes that require a token exchange
 * (`sgn`, `oauth2`) perform the exchange at registration time.
 *
 * @module services/server-registry/server-registry
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  forbidden,
  notFound,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { RequestContext } from '@cyanheads/mcp-ts-core/utils';
import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
import type { ResolvedAuth } from '@/services/brapi-client/index.js';
import type { AuthMode, ConnectAuth, RegisteredServer } from './types.js';

export const DEFAULT_ALIAS = 'default';

const CONN_PREFIX = 'brapi/conn/';

export interface RegisterInput {
  alias?: string;
  auth?: ConnectAuth;
  baseUrl: string;
}

export class ServerRegistry {
  constructor(
    private readonly serverConfig: ServerConfig,
    private readonly tokenFetcher: TokenFetcher = defaultTokenFetcher,
  ) {}

  /**
   * Register a connection under an alias. Resolves the auth mode to a
   * ready-to-use header (performing token exchange for `sgn` / `oauth2`) and
   * persists the result in `ctx.state`.
   */
  async register(ctx: Context, input: RegisterInput): Promise<RegisteredServer> {
    const alias = input.alias?.trim() || DEFAULT_ALIAS;
    validateAlias(alias);
    validateBaseUrl(input.baseUrl);

    const auth: ConnectAuth = input.auth ?? { mode: 'none' };
    const registered: RegisteredServer = {
      alias,
      baseUrl: normalizeBaseUrl(input.baseUrl),
      authMode: auth.mode,
      registeredAt: new Date().toISOString(),
    };
    const resolvedAuth = await this.resolveAuth(auth, registered.baseUrl, ctx);
    if (resolvedAuth) registered.resolvedAuth = resolvedAuth;

    await ctx.state.set(connKey(alias), registered);
    return registered;
  }

  /** Fetch a registered connection or throw `NotFound`. */
  async get(ctx: Context, alias: string = DEFAULT_ALIAS): Promise<RegisteredServer> {
    const entry = await ctx.state.get<RegisteredServer>(connKey(alias));
    if (!entry) {
      throw notFound(
        `No BrAPI connection registered under alias '${alias}'. Call brapi_connect first.`,
        { alias, reason: 'unknown_alias' },
      );
    }
    return entry;
  }

  /** Non-throwing variant of `get`. */
  getOptional(ctx: Context, alias: string = DEFAULT_ALIAS): Promise<RegisteredServer | null> {
    return ctx.state.get<RegisteredServer>(connKey(alias));
  }

  async list(ctx: Context): Promise<RegisteredServer[]> {
    const servers: RegisteredServer[] = [];
    let cursor: string | undefined;
    do {
      const listOpts: { cursor?: string; limit: number } = { limit: 100 };
      if (cursor !== undefined) listOpts.cursor = cursor;
      const page = await ctx.state.list(CONN_PREFIX, listOpts);
      for (const item of page.items) {
        if (isRegisteredServer(item.value)) servers.push(item.value);
      }
      cursor = page.cursor;
    } while (cursor);
    return servers;
  }

  async unregister(ctx: Context, alias: string = DEFAULT_ALIAS): Promise<void> {
    await ctx.state.delete(connKey(alias));
  }

  private async resolveAuth(
    auth: ConnectAuth,
    baseUrl: string,
    ctx: Context,
  ): Promise<ResolvedAuth | undefined> {
    switch (auth.mode) {
      case 'none':
        return;
      case 'bearer':
        return { headerName: 'Authorization', headerValue: `Bearer ${auth.token}` };
      case 'api_key':
        return {
          headerName: auth.headerName ?? this.serverConfig.defaultApiKeyHeader,
          headerValue: auth.apiKey,
        };
      case 'sgn':
        return await this.exchangeSgnToken(auth, baseUrl, ctx);
      case 'oauth2':
        throw validationError(
          'OAuth2 auth is not yet implemented. Use mode="bearer" with a pre-obtained access token for now.',
          { mode: 'oauth2' },
        );
      default: {
        const _exhaustive: never = auth;
        throw validationError('Unknown auth mode', { received: _exhaustive });
      }
    }
  }

  private async exchangeSgnToken(
    auth: Extract<ConnectAuth, { mode: 'sgn' }>,
    baseUrl: string,
    ctx: Context,
  ): Promise<ResolvedAuth> {
    const tokenUrl = joinUrl(baseUrl, '/token');
    const payload = await this.tokenFetcher(
      tokenUrl,
      {
        username: auth.username,
        password: auth.password,
        grant_type: 'password',
      },
      ctx,
      {
        timeoutMs: this.serverConfig.requestTimeoutMs,
        rejectPrivateIPs: !this.serverConfig.allowPrivateIps,
      },
    );
    if (!payload.access_token) {
      throw forbidden('SGN token exchange returned no access_token', {
        tokenUrl,
        payloadKeys: Object.keys(payload),
        reason: 'auth_no_access_token',
      });
    }
    const resolved: ResolvedAuth = {
      headerName: 'Authorization',
      headerValue: `Bearer ${payload.access_token}`,
    };
    if (payload.expires_in && Number.isFinite(payload.expires_in)) {
      resolved.expiresAt = new Date(Date.now() + payload.expires_in * 1000).toISOString();
    }
    return resolved;
  }
}

/**
 * Swappable token-exchange fetcher. Production uses `fetchWithTimeout`; tests
 * inject a stub to avoid real network calls.
 */
export type TokenFetcher = (
  url: string,
  body: Record<string, unknown>,
  ctx: Context,
  options: { timeoutMs: number; rejectPrivateIPs: boolean },
) => Promise<TokenResponse>;

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
  [key: string]: unknown;
}

const defaultTokenFetcher: TokenFetcher = async (url, body, ctx, options) => {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined && value !== null) form.set(key, String(value));
  }
  let response: Response;
  try {
    response = await fetchWithTimeout(url, options.timeoutMs, ctx as unknown as RequestContext, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form.toString(),
      signal: ctx.signal,
      rejectPrivateIPs: options.rejectPrivateIPs,
    });
  } catch (err) {
    throw forbidden(
      `Token exchange failed at ${url}. Verify credentials and that the server exposes /token.`,
      { tokenUrl: url, reason: 'auth_token_exchange_failed' },
      { cause: err },
    );
  }
  const text = await response.text();
  if (!text) {
    throw serviceUnavailable('Token exchange returned an empty body', { tokenUrl: url });
  }
  try {
    return JSON.parse(text) as TokenResponse;
  } catch (err) {
    throw serviceUnavailable(
      'Token exchange returned non-JSON response',
      { tokenUrl: url, bodyPreview: text.slice(0, 200) },
      { cause: err },
    );
  }
};

function connKey(alias: string): string {
  return `${CONN_PREFIX}${alias}`;
}

function validateAlias(alias: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(alias)) {
    throw validationError(
      `Invalid connection alias '${alias}'. Use letters, digits, '_', or '-'.`,
      { alias },
    );
  }
}

function validateBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw validationError(`Invalid baseUrl '${baseUrl}' — not a valid URL.`, { baseUrl });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw validationError(`Invalid baseUrl protocol '${parsed.protocol}'. Use http or https.`, {
      baseUrl,
    });
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function joinUrl(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const prefixedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${prefixedPath}`;
}

function isRegisteredServer(value: unknown): value is RegisteredServer {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.alias === 'string' && typeof v.baseUrl === 'string' && typeof v.authMode === 'string'
  );
}

let _registry: ServerRegistry | undefined;

export function initServerRegistry(serverConfig: ServerConfig): void {
  _registry = new ServerRegistry(serverConfig);
}

export function getServerRegistry(): ServerRegistry {
  if (!_registry) {
    throw new Error('ServerRegistry not initialized — call initServerRegistry() in setup()');
  }
  return _registry;
}

export function resetServerRegistry(): void {
  _registry = undefined;
}

export type { AuthMode, ConnectAuth, RegisteredServer };
