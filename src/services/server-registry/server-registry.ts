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
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
import {
  callDeadlineAt,
  callDeadlineExceeded,
  isPrivateAddressBlocked,
  PRIVATE_ADDRESS_BLOCKED_REASON,
  type ResolvedAuth,
  UPSTREAM_TIMEOUT_HINT,
} from '@/services/brapi-client/index.js';
import type { AuthMode, ConnectAuth, RegisteredServer } from './types.js';

export const DEFAULT_ALIAS = 'default';

const CONN_PREFIX = 'brapi/conn/';
const SESSION_CONN_PREFIX = 'brapi/conn/sess/';

export interface RegisterInput {
  alias?: string;
  auth?: ConnectAuth;
  baseUrl: string;
}

/** A first-use registration in flight, and the signal of the call running it. */
interface PendingRegistration {
  promise: Promise<RegisteredServer>;
  signal: AbortSignal;
}

export class ServerRegistry {
  /** In-flight {@link registerOnce} runs, keyed by tenant + scoped alias key. */
  private readonly pending = new Map<string, PendingRegistration>();

  constructor(
    private readonly serverConfig: ServerConfig,
    private readonly tokenFetcher: TokenFetcher = defaultTokenFetcher,
  ) {}

  /**
   * Run `register` for an alias, sharing one run among concurrent callers in
   * the same tenant and scope so a token exchange and capability discovery
   * happen once; every caller gets that run's connection or its error. A
   * caller whose shared run was cancelled by the call that started it starts
   * its own run instead of inheriting the cancellation. Shared within this
   * process only.
   */
  async registerOnce(
    ctx: Context,
    alias: string,
    register: () => Promise<RegisteredServer>,
  ): Promise<RegisteredServer> {
    const key = `${ctx.tenantId ?? ''}\n${this.connKey(ctx, alias)}`;
    const inflight = this.pending.get(key);
    if (inflight) {
      try {
        return await inflight.promise;
      } catch (err) {
        if (inflight.signal.aborted && !ctx.signal.aborted) {
          return await this.registerOnce(ctx, alias, register);
        }
        throw err;
      }
    }
    const promise = register().finally(() => this.pending.delete(key));
    this.pending.set(key, { promise, signal: ctx.signal });
    return await promise;
  }

  /**
   * Register a connection under an alias: {@link resolve} then {@link save}.
   */
  async register(ctx: Context, input: RegisterInput): Promise<RegisteredServer> {
    const registered = await this.resolve(ctx, input);
    await this.save(ctx, registered);
    return registered;
  }

  /**
   * Validate the alias and base URL and resolve the auth mode to a
   * ready-to-use header (performing token exchange for `sgn` / `oauth2`),
   * without persisting anything — callers that must verify the connection
   * first save it only once it works, so a failure leaves any previous
   * registration under the alias intact.
   */
  async resolve(ctx: Context, input: RegisterInput): Promise<RegisteredServer> {
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
    return registered;
  }

  /** Persist a resolved connection under its alias, replacing any previous one. */
  async save(ctx: Context, registered: RegisteredServer): Promise<void> {
    await ctx.state.set(this.connKey(ctx, registered.alias), registered);
  }

  /** Fetch a registered connection or throw `NotFound`. */
  async get(ctx: Context, alias: string = DEFAULT_ALIAS): Promise<RegisteredServer> {
    const entry = await ctx.state.get<RegisteredServer>(this.connKey(ctx, alias));
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
    return ctx.state.get<RegisteredServer>(this.connKey(ctx, alias));
  }

  async list(ctx: Context): Promise<RegisteredServer[]> {
    const servers: RegisteredServer[] = [];
    let cursor: string | undefined;
    const prefix = this.scopePrefix(ctx);
    do {
      const listOpts: { cursor?: string; limit: number } = { limit: 100 };
      if (cursor !== undefined) listOpts.cursor = cursor;
      const page = await ctx.state.list(prefix, listOpts);
      for (const item of page.items) {
        if (isRegisteredServer(item.value)) servers.push(item.value);
      }
      cursor = page.cursor;
    } while (cursor);
    return servers;
  }

  async unregister(ctx: Context, alias: string = DEFAULT_ALIAS): Promise<void> {
    await ctx.state.delete(this.connKey(ctx, alias));
  }

  /**
   * True when session isolation is on but this request carries no session ID
   * to scope on, so its connections land in the tenant-wide namespace that
   * every other session-less caller in the tenant reads and overwrites.
   */
  isolationFallsBackToShared(ctx: Context): boolean {
    return this.serverConfig.sessionIsolation === true && !ctx.sessionId;
  }

  /**
   * Resolve the state-key prefix for the current ctx. Under
   * `BRAPI_SESSION_ISOLATION=true` (default) and a present `ctx.sessionId`
   * (HTTP stateful/auto), folds the session ID in so concurrent sessions in
   * the same tenant don't share connection state. Falls back to the bare
   * tenant prefix for stdio, stateless HTTP without opt-in, or when
   * isolation is explicitly disabled. Used by both `connKey` (single-alias
   * keys) and `list` (prefix scans).
   */
  private scopePrefix(ctx: Context): string {
    if (this.serverConfig.sessionIsolation && ctx.sessionId) {
      return `${SESSION_CONN_PREFIX}${ctx.sessionId}/`;
    }
    return CONN_PREFIX;
  }

  private connKey(ctx: Context, alias: string): string {
    return `${this.scopePrefix(ctx)}${alias}`;
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
        return await this.exchangeOAuth2Token(auth, baseUrl, ctx);
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
    const payload = await this.fetchToken(
      tokenUrl,
      {
        username: auth.username,
        password: auth.password,
        grant_type: 'password',
      },
      ctx,
    );
    if (!payload.access_token) {
      throw forbidden('SGN token exchange returned no access_token', {
        tokenUrl: displayTokenUrl(tokenUrl),
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

  private async exchangeOAuth2Token(
    auth: Extract<ConnectAuth, { mode: 'oauth2' }>,
    baseUrl: string,
    ctx: Context,
  ): Promise<ResolvedAuth> {
    const tokenUrl = auth.tokenUrl ?? joinUrl(baseUrl, '/token');
    const payload = await this.fetchToken(
      tokenUrl,
      {
        client_id: auth.clientId,
        client_secret: auth.clientSecret,
        grant_type: 'client_credentials',
      },
      ctx,
    );
    if (!payload.access_token) {
      throw forbidden('OAuth2 token exchange returned no access_token', {
        tokenUrl: displayTokenUrl(tokenUrl),
        payloadKeys: Object.keys(payload),
        reason: 'auth_no_access_token',
      });
    }
    const tokenType =
      typeof payload.token_type === 'string' && payload.token_type.trim()
        ? payload.token_type.trim()
        : 'Bearer';
    const resolved: ResolvedAuth = {
      headerName: 'Authorization',
      headerValue: `${tokenType} ${payload.access_token}`,
    };
    if (payload.expires_in && Number.isFinite(payload.expires_in)) {
      resolved.expiresAt = new Date(Date.now() + payload.expires_in * 1000).toISOString();
    }
    return resolved;
  }

  /**
   * The token exchange runs first in a connect, under the same call deadline
   * as the BrAPI requests that follow it (see `callDeadlineAt`). A `/token`
   * that does not answer in time fails as a `Timeout` with the upstream-timeout
   * hint — it says nothing about the credentials — and the call deadline's
   * `Timeout` when that deadline is what cut the wait short.
   */
  private async fetchToken(
    tokenUrl: string,
    body: Record<string, unknown>,
    ctx: Context,
  ): Promise<TokenResponse> {
    const { requestTimeoutMs } = this.serverConfig;
    const callRemainingMs = callDeadlineAt(ctx) - Date.now();
    const clipped = callRemainingMs < requestTimeoutMs;
    try {
      return await this.tokenFetcher(tokenUrl, body, ctx, {
        timeoutMs: clipped ? callRemainingMs : requestTimeoutMs,
        rejectPrivateIPs: !this.serverConfig.allowPrivateIps,
      });
    } catch (err) {
      if (ctx.signal.aborted || !isTimeout(err)) throw err;
      if (clipped) throw callDeadlineExceeded('POST /token', { sent: true }, err);
      const shown = displayTokenUrl(tokenUrl);
      throw timeout(
        `Token exchange at ${shown} did not answer within ${requestTimeoutMs} ms.`,
        { tokenUrl: shown, retryable: true, recovery: { hint: UPSTREAM_TIMEOUT_HINT } },
        { cause: err },
      );
    }
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
  const shown = displayTokenUrl(url);
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined && value !== null) form.set(key, String(value));
  }
  let response: Response;
  try {
    response = await fetchWithTimeout(url, options.timeoutMs, ctx, {
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
    // A stall or a cancellation is not a rejected exchange; the registry reports those.
    if (ctx.signal.aborted || (isTimeout(err) && err.data?.errorSource !== 'FetchHttpError')) {
      throw err;
    }
    // Nor is a refused address: it fails with its own reason, and the calling
    // tool's contract supplies the hint.
    if (isPrivateAddressBlocked(err)) {
      throw new McpError(
        err.code,
        `Token exchange at ${shown} was refused: the host is on a private or reserved address, which this server is not allowed to reach.`,
        { tokenUrl: shown, reason: PRIVATE_ADDRESS_BLOCKED_REASON },
        { cause: err },
      );
    }
    throw forbidden(
      `Token exchange failed at ${shown}. Verify credentials and that the server exposes /token.`,
      {
        tokenUrl: shown,
        reason: 'auth_token_exchange_failed',
      },
      { cause: err },
    );
  }
  const text = await response.text();
  if (!text) {
    throw serviceUnavailable('Token exchange returned an empty body', { tokenUrl: shown });
  }
  try {
    return JSON.parse(text) as TokenResponse;
  } catch (err) {
    throw serviceUnavailable(
      'Token exchange returned non-JSON response',
      { tokenUrl: shown, bodyPreview: text.slice(0, 200) },
      { cause: err },
    );
  }
};

/**
 * A token URL as errors and logs name it: origin and path only. A configured
 * or caller-supplied token URL is never checked for userinfo or a query
 * string, either of which can carry a secret.
 */
function displayTokenUrl(tokenUrl: string): string {
  try {
    const parsed = new URL(tokenUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[unparseable token URL]';
  }
}

function isTimeout(error: unknown): error is McpError {
  return error instanceof McpError && error.code === JsonRpcErrorCode.Timeout;
}

function validateAlias(alias: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(alias)) {
    throw validationError(
      `Invalid connection alias '${alias}'. Use letters, digits, '_', or '-'.`,
      { alias },
    );
  }
}

/** Throw a `ValidationError` unless `baseUrl` is an absolute http(s) URL without userinfo. */
export function validateBaseUrl(baseUrl: string): void {
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
  // Userinfo is never sent upstream as auth, but a stored baseUrl is echoed and
  // logged, so it is refused rather than kept. The URL is not echoed back.
  if (parsed.username || parsed.password) {
    throw validationError(
      'Invalid baseUrl: credentials in the URL (user:password@host) are not supported. Pass them in `auth`, or configure them server-side for the alias.',
    );
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
