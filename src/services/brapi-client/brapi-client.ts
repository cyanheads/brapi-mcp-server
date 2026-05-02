/**
 * @fileoverview Low-level HTTP client for BrAPI v2 servers. Handles URL
 * construction, header assembly, JSON envelope parsing, retry with exponential
 * backoff, and the async-search poll loop
 * (`POST /search/{noun}` → `searchResultsDbId` → `GET /search/{noun}/{id}`).
 * Stateless across connections — callers pass `baseUrl` and resolved auth per
 * call; connection state is owned by `ServerRegistry` (added in a later phase).
 *
 * @module services/brapi-client/brapi-client
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  forbidden,
  internalError,
  JsonRpcErrorCode,
  McpError,
  notFound,
  rateLimited,
  serviceUnavailable,
  unauthorized,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { FetchWithTimeoutOptions, RequestContext } from '@cyanheads/mcp-ts-core/utils';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
import type {
  BinaryResponse,
  BrapiEnvelope,
  BrapiRequestOptions,
  ResolvedAuth,
  SearchResponse,
} from './types.js';
import { DIALECT_ALL_DROPPED_REASON } from './types.js';

/**
 * The framework's `Context` and `RequestContext` are structurally compatible
 * at runtime — framework docs confirm passing `Context` to `fetchWithTimeout`
 * and `withRetry` is safe. The types diverge only under
 * `exactOptionalPropertyTypes` (Context marks some fields as `| undefined`).
 * One cast, one place.
 */
const asRequestContext = (ctx: Context): RequestContext => ctx as unknown as RequestContext;

/**
 * Signature of the underlying HTTP fetcher. Accepts the handler `Context`
 * directly so callers (and tests) don't have to cast; the default
 * implementation adapts to `fetchWithTimeout`.
 */
export type Fetcher = (
  url: string | URL,
  timeoutMs: number,
  context: Context,
  options?: FetchWithTimeoutOptions,
) => Promise<Response>;

const defaultFetcher: Fetcher = (url, timeoutMs, context, options) =>
  fetchWithTimeout(url, timeoutMs, asRequestContext(context), options);

export class BrapiClient {
  constructor(
    private readonly serverConfig: ServerConfig,
    private readonly fetcher: Fetcher = defaultFetcher,
  ) {}

  /**
   * GET /{path} with optional query params and auth. When `options.dialect` is
   * supplied, `params` are routed through the dialect adapter at the client
   * edge — single source of truth for plural/singular translation across every
   * call site (find_* tools, FK lookups, count probes). Throws a structured
   * `validationError` (with `data.reason = DIALECT_ALL_DROPPED_REASON`) when
   * the dialect drops every supplied filter, so callers can detect and skip
   * without parsing message text.
   */
  async get<T>(
    baseUrl: string,
    path: string,
    ctx: Context,
    options: BrapiRequestOptions = {},
  ): Promise<BrapiEnvelope<T>> {
    const params = applyDialectToParams(path, options);
    return await withRetry(
      async () => {
        const response = await this.doFetch(
          this.buildUrl(baseUrl, path, params),
          ctx,
          { method: 'GET', headers: this.buildHeaders(options.auth) },
          options.timeoutMs,
        );
        return this.parseEnvelope<T>(response);
      },
      {
        operation: `brapi.get ${path}`,
        context: asRequestContext(ctx),
        maxRetries: options.retryMaxAttempts ?? this.serverConfig.retryMaxAttempts,
        baseDelayMs: this.serverConfig.retryBaseDelayMs,
        signal: ctx.signal,
      },
    );
  }

  /**
   * GET /{path} returning raw bytes — used for image content and other binary
   * payloads. Honors the same retry policy as `get()`. The `accept` option
   * overrides the default `image/*`.
   */
  getBinary(
    baseUrl: string,
    path: string,
    ctx: Context,
    options: BrapiRequestOptions & { accept?: string } = {},
  ): Promise<BinaryResponse> {
    return withRetry(
      async () => {
        const headers = this.buildHeaders(options.auth);
        headers.Accept = options.accept ?? 'image/*';
        const response = await this.doFetch(
          this.buildUrl(baseUrl, path, options.params),
          ctx,
          { method: 'GET', headers },
          options.timeoutMs,
        );
        const buffer = await response.arrayBuffer();
        const contentType = response.headers.get('Content-Type') ?? 'application/octet-stream';
        return { bytes: new Uint8Array(buffer), contentType };
      },
      {
        operation: `brapi.getBinary ${path}`,
        context: asRequestContext(ctx),
        maxRetries: this.serverConfig.retryMaxAttempts,
        baseDelayMs: this.serverConfig.retryBaseDelayMs,
        signal: ctx.signal,
      },
    );
  }

  /**
   * Fetch binary bytes from an arbitrary URL — used as a fallback when a
   * BrAPI server doesn't expose `/images/{id}/imagecontent` but the image's
   * metadata carries an `imageURL` (CDN, S3, etc.). No auth is attached; the
   * assumption is that these URLs are publicly reachable. Still honors the
   * private-IP guard and request timeout.
   */
  async fetchBinaryUrl(url: string, ctx: Context, accept = 'image/*'): Promise<BinaryResponse> {
    const response = await this.doFetch(
      url,
      ctx,
      { method: 'GET', headers: { Accept: accept } },
      this.serverConfig.requestTimeoutMs,
    );
    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get('Content-Type') ?? 'application/octet-stream';
    return { bytes: new Uint8Array(buffer), contentType };
  }

  /**
   * POST /search/{noun}. Returns a discriminated union — `sync` when the
   * server returns full results inline, `async` when it returns a
   * `searchResultsDbId` the caller must poll via `getSearchResults`.
   */
  postSearch<T>(
    baseUrl: string,
    noun: string,
    body: Record<string, unknown>,
    ctx: Context,
    options: BrapiRequestOptions = {},
  ): Promise<SearchResponse<T>> {
    return withRetry(
      async () => {
        const response = await this.doFetch(
          this.buildUrl(baseUrl, `/search/${noun}`),
          ctx,
          {
            method: 'POST',
            headers: {
              ...this.buildHeaders(options.auth),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          },
          options.timeoutMs,
        );
        const envelope = await this.parseEnvelope<unknown>(response);
        const asyncId = extractAsyncId(envelope);
        if (asyncId !== undefined) {
          return { kind: 'async', searchResultsDbId: asyncId };
        }
        return { kind: 'sync', envelope: envelope as BrapiEnvelope<T> };
      },
      {
        operation: `brapi.postSearch ${noun}`,
        context: asRequestContext(ctx),
        maxRetries: this.serverConfig.retryMaxAttempts,
        baseDelayMs: this.serverConfig.retryBaseDelayMs,
        signal: ctx.signal,
      },
    );
  }

  /**
   * POST /{path} with a JSON body. Used for write endpoints (e.g. creating
   * observations). Same retry + classification policy as `get()`. The body is
   * serialized as JSON and `Content-Type: application/json` is forced.
   */
  post<T>(
    baseUrl: string,
    path: string,
    body: unknown,
    ctx: Context,
    options: BrapiRequestOptions = {},
  ): Promise<BrapiEnvelope<T>> {
    return this.sendJson<T>('POST', baseUrl, path, body, ctx, options);
  }

  /**
   * PUT /{path} with a JSON body. Used for upsert / update endpoints. BrAPI
   * routes update calls (`PUT /observations`, `PUT /germplasm`) through this.
   */
  put<T>(
    baseUrl: string,
    path: string,
    body: unknown,
    ctx: Context,
    options: BrapiRequestOptions = {},
  ): Promise<BrapiEnvelope<T>> {
    return this.sendJson<T>('PUT', baseUrl, path, body, ctx, options);
  }

  private sendJson<T>(
    method: 'POST' | 'PUT',
    baseUrl: string,
    path: string,
    body: unknown,
    ctx: Context,
    options: BrapiRequestOptions = {},
  ): Promise<BrapiEnvelope<T>> {
    return withRetry(
      async () => {
        const response = await this.doFetch(
          this.buildUrl(baseUrl, path, options.params),
          ctx,
          {
            method,
            headers: {
              ...this.buildHeaders(options.auth),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          },
          options.timeoutMs,
        );
        return this.parseEnvelope<T>(response);
      },
      {
        operation: `brapi.${method.toLowerCase()} ${path}`,
        context: asRequestContext(ctx),
        maxRetries: this.serverConfig.retryMaxAttempts,
        baseDelayMs: this.serverConfig.retryBaseDelayMs,
        signal: ctx.signal,
      },
    );
  }

  /**
   * Poll `GET /search/{noun}/{searchResultsDbId}`. Returns the envelope once
   * the server replies with 200. 202 means "still processing" — the method
   * sleeps `searchPollIntervalMs` and retries until `searchPollTimeoutMs`.
   */
  async getSearchResults<T>(
    baseUrl: string,
    noun: string,
    searchResultsDbId: string,
    ctx: Context,
    options: BrapiRequestOptions = {},
  ): Promise<BrapiEnvelope<T>> {
    const url = this.buildUrl(
      baseUrl,
      `/search/${noun}/${encodeURIComponent(searchResultsDbId)}`,
      options.params,
    );
    const pollTimeoutMs = this.serverConfig.searchPollTimeoutMs;
    const pollIntervalMs = this.serverConfig.searchPollIntervalMs;
    const startedAt = Date.now();

    for (;;) {
      if (ctx.signal.aborted) {
        throw internalError('Async search polling aborted by caller', {
          noun,
          searchResultsDbId,
        });
      }
      if (Date.now() - startedAt > pollTimeoutMs) {
        throw serviceUnavailable(
          `Async search ${noun}/${searchResultsDbId} timed out after ${pollTimeoutMs}ms`,
          { noun, searchResultsDbId, pollTimeoutMs },
        );
      }

      const response = await this.doFetch(
        url,
        ctx,
        { method: 'GET', headers: this.buildHeaders(options.auth) },
        options.timeoutMs,
      );

      if (response.status === 202) {
        await sleep(pollIntervalMs, ctx);
        continue;
      }
      return this.parseEnvelope<T>(response);
    }
  }

  private async doFetch(
    url: string,
    ctx: Context,
    init: Omit<FetchWithTimeoutOptions, 'signal' | 'rejectPrivateIPs'>,
    timeoutMs?: number,
  ): Promise<Response> {
    try {
      return await this.fetcher(url, timeoutMs ?? this.serverConfig.requestTimeoutMs, ctx, {
        ...init,
        signal: ctx.signal,
        rejectPrivateIPs: !this.serverConfig.allowPrivateIps,
      });
    } catch (err) {
      reclassifyHttpError(err);
      throw err;
    }
  }

  private buildUrl(baseUrl: string, path: string, params?: BrapiRequestOptions['params']): string {
    const trimmedBase = baseUrl.replace(/\/$/, '');
    const prefixedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${trimmedBase}${prefixedPath}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const v of value) url.searchParams.append(key, String(v));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  private buildHeaders(auth?: ResolvedAuth): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (auth) {
      headers[auth.headerName] = auth.headerValue;
    }
    return headers;
  }

  private async parseEnvelope<T>(response: Response): Promise<BrapiEnvelope<T>> {
    const text = await response.text();
    if (!text) {
      throw validationError('BrAPI returned an empty response body', {
        httpStatus: response.status,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw serviceUnavailable(
        'BrAPI returned non-JSON response',
        { bodyPreview: text.slice(0, 500), httpStatus: response.status },
        { cause },
      );
    }
    if (!isEnvelope(parsed)) {
      throw validationError('BrAPI response did not match v2 envelope shape', {
        received: parsed,
        httpStatus: response.status,
      });
    }
    return parsed as BrapiEnvelope<T>;
  }
}

/**
 * Map the `ServiceUnavailable` thrown by `fetchWithTimeout` to the correct
 * non-transient code when the underlying HTTP status is a 4xx. 429 is promoted
 * to `RateLimited` so the default retry policy still kicks in; 5xx stays as
 * `ServiceUnavailable` (also retryable). Network-level errors, which have no
 * `statusCode`, pass through untouched.
 */
function reclassifyHttpError(err: unknown): void {
  if (!(err instanceof McpError)) return;
  if (err.code !== JsonRpcErrorCode.ServiceUnavailable) return;
  const status = extractHttpStatus(err);
  if (status === undefined) return;
  if (status >= 500) return;
  const data = asRecord(err.data) ?? {};
  if (status === 429) {
    throw rateLimited(err.message, { ...data, reason: 'upstream_rate_limited' });
  }
  if (status === 401) throw unauthorized(err.message, { ...data, reason: 'upstream_unauthorized' });
  if (status === 403) throw forbidden(err.message, { ...data, reason: 'upstream_forbidden' });
  if (status === 404) throw notFound(err.message, { ...data, reason: 'upstream_not_found' });
  throw validationError(err.message, { ...data, reason: 'upstream_bad_request' });
}

function extractHttpStatus(err: McpError): number | undefined {
  const data = asRecord(err.data);
  if (!data) return;
  const status = data.statusCode;
  return typeof status === 'number' ? status : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
  return value as Record<string, unknown>;
}

function isEnvelope(value: unknown): value is BrapiEnvelope<unknown> {
  return typeof value === 'object' && value !== null && 'metadata' in value && 'result' in value;
}

/**
 * Resolve the dialect endpoint segment from a request path. The segment is
 * the bare resource name dialect mappings are keyed by (`/trials` →
 * `trials`, `/germplasm/X/attributes` → `germplasm`). Path-param endpoints
 * generally don't need filter translation; passing the first segment keeps
 * lookups consistent and the dialect adapter no-ops on unknown endpoints.
 */
function dialectEndpointFor(path: string): string {
  return path.replace(/^\/+/, '').split('/')[0] ?? '';
}

/**
 * Apply the dialect adapter to a request's params when a dialect is supplied.
 * Empty / undefined params short-circuit (nothing to translate); when the
 * adapter drops every supplied filter we throw a structured `validationError`
 * with the canonical `dialect_all_filters_dropped` reason so companions can
 * `.catch` and skip without surfacing the unfiltered baseline.
 */
function applyDialectToParams(
  path: string,
  options: BrapiRequestOptions,
): BrapiRequestOptions['params'] {
  const dialect = options.dialect;
  const params = options.params;
  if (!dialect || !params) return params;
  const inputKeyCount = Object.keys(params).length;
  if (inputKeyCount === 0) return params;
  const adapted = dialect.adaptGetFilters(
    dialectEndpointFor(path),
    params as Readonly<Record<string, unknown>>,
  );
  if (options.warnings) options.warnings.push(...adapted.warnings);
  if (adapted.dropped.length > 0 && Object.keys(adapted.filters).length === 0) {
    throw validationError(
      `Every supplied filter was dropped by the ${dialect.id} dialect on ${path} (${adapted.dropped.join(', ')}); call would silently widen to the unfiltered baseline.`,
      {
        reason: DIALECT_ALL_DROPPED_REASON,
        dialect: dialect.id,
        path,
        dropped: adapted.dropped,
      },
    );
  }
  return adapted.filters as BrapiRequestOptions['params'];
}

/**
 * True when `err` was thrown by the client-level dialect adapter to signal
 * "every supplied filter dropped." Used by companion call sites to convert
 * the throw into a graceful warn-and-skip instead of propagating to the user.
 */
export function isDialectAllDropped(err: unknown): err is McpError {
  return (
    err instanceof McpError &&
    err.code === JsonRpcErrorCode.ValidationError &&
    typeof err.data === 'object' &&
    err.data !== null &&
    (err.data as Record<string, unknown>).reason === DIALECT_ALL_DROPPED_REASON
  );
}

/**
 * Some BrAPI servers embed `searchResultsDbId` inside the `result` object on
 * an otherwise empty payload. Detect that case.
 */
function extractAsyncId(envelope: BrapiEnvelope<unknown>): string | undefined {
  const result = envelope.result;
  if (typeof result !== 'object' || result === null) return;
  const id = (result as Record<string, unknown>).searchResultsDbId;
  if (typeof id !== 'string') return;
  const data = (result as Record<string, unknown>).data;
  if (Array.isArray(data) && data.length > 0) return;
  return id;
}

function sleep(ms: number, ctx: Context): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ctx.signal.aborted) {
      reject(internalError('Sleep aborted by caller'));
      return;
    }
    const timer = setTimeout(() => {
      ctx.signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(internalError('Sleep aborted by caller'));
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });
  });
}

let _client: BrapiClient | undefined;

export function initBrapiClient(serverConfig: ServerConfig, fetcher?: Fetcher): void {
  _client = new BrapiClient(serverConfig, fetcher);
}

export function getBrapiClient(): BrapiClient {
  if (!_client) {
    throw new Error('BrapiClient not initialized — call initBrapiClient() in setup()');
  }
  return _client;
}

/** Test-only — clears the singleton so successive suites start clean. */
export function resetBrapiClient(): void {
  _client = undefined;
}
