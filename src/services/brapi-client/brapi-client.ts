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
  JsonRpcErrorCode,
  McpError,
  notFound,
  rateLimited,
  requestCancelled,
  serviceUnavailable,
  timeout,
  unauthorized,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { FetchWithTimeoutOptions, RetryAttempt } from '@cyanheads/mcp-ts-core/utils';
import { defaultIsTransient, fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
import { callDeadlineAt, callDeadlineExceeded, UPSTREAM_TIMEOUT_HINT } from './call-deadline.js';
import type {
  BinaryResponse,
  BrapiEnvelope,
  BrapiRequestOptions,
  ResolvedAuth,
  SearchResponse,
} from './types.js';
import { DIALECT_ALL_DROPPED_REASON, PRIVATE_ADDRESS_BLOCKED_REASON } from './types.js';

/**
 * Signature of the underlying HTTP fetcher. `Context extends RequestContext`,
 * so the handler context passes straight through to `fetchWithTimeout`.
 */
export type Fetcher = (
  url: string | URL,
  timeoutMs: number,
  context: Context,
  options?: FetchWithTimeoutOptions,
) => Promise<Response>;

const defaultFetcher: Fetcher = (url, timeoutMs, context, options) =>
  fetchWithTimeout(url, timeoutMs, context, options);

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
    return await this.withBudget(`GET ${path}`, ctx, options, async ({ signal }) => {
      const response = await this.doFetch(
        this.buildUrl(baseUrl, path, params),
        ctx,
        { method: 'GET', headers: this.buildHeaders(options.auth), signal },
        options.timeoutMs,
        options.singleton === true,
      );
      return this.parseEnvelope<T>(response);
    });
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
    return this.withBudget(`GET ${path}`, ctx, options, async ({ signal }) => {
      const headers = this.buildHeaders(options.auth);
      headers.Accept = options.accept ?? 'image/*';
      const response = await this.doFetch(
        this.buildUrl(baseUrl, path, options.params),
        ctx,
        { method: 'GET', headers, signal },
        options.timeoutMs,
      );
      return await readBinary(response);
    });
  }

  /**
   * Fetch binary bytes from an arbitrary URL — used as a fallback when a
   * BrAPI server doesn't expose `/images/{id}/imagecontent` but the image's
   * metadata carries an `imageURL` (CDN, S3, etc.). No auth is attached; the
   * assumption is that these URLs are publicly reachable. Still honors the
   * private-IP guard, request timeout, and call deadline; never retried.
   */
  fetchBinaryUrl(url: string, ctx: Context, accept = 'image/*'): Promise<BinaryResponse> {
    return this.withBudget(
      `GET ${new URL(url).origin}`,
      ctx,
      { retryMaxAttempts: 0 },
      async ({ signal }) => {
        const response = await this.doFetch(url, ctx, {
          method: 'GET',
          headers: { Accept: accept },
          signal,
        });
        return await readBinary(response);
      },
    );
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
    return this.withBudget(`POST /search/${noun}`, ctx, options, async ({ signal }) => {
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
          signal,
        },
        options.timeoutMs,
      );
      const envelope = await this.parseEnvelope<unknown>(response);
      const asyncId = extractAsyncId(envelope);
      if (asyncId !== undefined) {
        return { kind: 'async', searchResultsDbId: asyncId } as const;
      }
      return { kind: 'sync', envelope: envelope as BrapiEnvelope<T> } as const;
    });
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
    return this.withBudget(`${method} ${path}`, ctx, options, async ({ signal }) => {
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
          signal,
        },
        options.timeoutMs,
      );
      return this.parseEnvelope<T>(response);
    });
  }

  /**
   * Poll `GET /search/{noun}/{searchResultsDbId}`. Returns the envelope once
   * the server replies with 200. 202 means "still processing" — the method
   * sleeps `searchPollIntervalMs` and polls again until `searchPollTimeoutMs`,
   * `deadlineMs`, or the call deadline, whichever comes first, clipping each
   * poll's timeout to it. The `Timeout` names the bound that ended it: the
   * call deadline's reason, `retry_deadline_exceeded` for `deadlineMs` (as a
   * request whose retries outlast it rejects), or none for the poll budget.
   */
  async getSearchResults<T>(
    baseUrl: string,
    noun: string,
    searchResultsDbId: string,
    ctx: Context,
    options: BrapiRequestOptions = {},
  ): Promise<BrapiEnvelope<T>> {
    const operation = `GET /search/${noun}/${searchResultsDbId}`;
    const url = this.buildUrl(
      baseUrl,
      `/search/${noun}/${encodeURIComponent(searchResultsDbId)}`,
      options.params,
    );
    const pollTimeoutMs = Math.min(
      this.serverConfig.searchPollTimeoutMs,
      options.deadlineMs ?? Number.POSITIVE_INFINITY,
    );
    const pollIntervalMs = this.serverConfig.searchPollIntervalMs;
    const attemptTimeoutMs = options.timeoutMs ?? this.serverConfig.requestTimeoutMs;
    const startedAt = Date.now();
    const callAt = callDeadlineAt(ctx);
    // Polling stops at the poll budget; a poll's own timeout is clipped only
    // to the deadlines (call, caller), which also end the request in flight.
    const stopAt = Math.min(callAt, startedAt + pollTimeoutMs);
    const clipAt = Math.min(callAt, startedAt + (options.deadlineMs ?? Number.POSITIVE_INFINITY));
    let polls = 0;
    const callerBound =
      options.deadlineMs !== undefined &&
      options.deadlineMs <= this.serverConfig.searchPollTimeoutMs;
    const expired = (cause?: unknown) =>
      callAt <= startedAt + pollTimeoutMs
        ? callDeadlineExceeded(operation, { sent: polls > 0 }, cause)
        : timeout(
            `Async search ${noun}/${searchResultsDbId} timed out after ${pollTimeoutMs}ms`,
            {
              noun,
              searchResultsDbId,
              pollTimeoutMs,
              ...(callerBound && {
                reason: 'retry_deadline_exceeded',
                deadlineMs: options.deadlineMs,
              }),
              recovery: { hint: UPSTREAM_TIMEOUT_HINT },
            },
            cause === undefined ? undefined : { cause },
          );

    for (;;) {
      if (ctx.signal.aborted) {
        throw requestCancelled('Async search polling aborted by caller', {
          noun,
          searchResultsDbId,
        });
      }
      if (Date.now() >= stopAt) throw expired();

      const clipRemainingMs = clipAt - Date.now();
      const clipped = clipRemainingMs < attemptTimeoutMs;
      let response: Response;
      try {
        polls += 1;
        response = await this.doFetch(
          url,
          ctx,
          { method: 'GET', headers: this.buildHeaders(options.auth) },
          clipped ? clipRemainingMs : options.timeoutMs,
        );
      } catch (err) {
        if (clipped && isTimeout(err) && !ctx.signal.aborted) throw expired(err);
        throw withTimeoutHint(err);
      }

      if (response.status === 202) {
        await sleep(Math.min(pollIntervalMs, Math.max(0, stopAt - Date.now())), ctx);
        continue;
      }
      return this.parseEnvelope<T>(response);
    }
  }

  /**
   * Run one request under the call deadline (`callDeadlineAt(ctx)`) and the
   * caller's tighter `deadlineMs`, whichever ends first, with the retry
   * ladder inside that budget. A timed-out attempt is retried only when the
   * remaining budget still fits a full attempt; a request the call deadline
   * ends or keeps from starting rejects with the call-deadline `Timeout`, and
   * every other escaping `Timeout` gains a recovery hint.
   */
  private async withBudget<T>(
    operation: string,
    ctx: Context,
    options: BrapiRequestOptions,
    attempt: (a: RetryAttempt) => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    const callRemainingMs = callDeadlineAt(ctx) - startedAt;
    if (callRemainingMs <= 0) throw callDeadlineExceeded(operation, { sent: false });
    const callBound = options.deadlineMs === undefined || callRemainingMs <= options.deadlineMs;
    const deadlineMs = callBound ? callRemainingMs : (options.deadlineMs as number);
    const attemptTimeoutMs = options.timeoutMs ?? this.serverConfig.requestTimeoutMs;
    const isTransient = (error: unknown): boolean => {
      if (!defaultIsTransient(error)) return false;
      if (!isTimeout(error)) return true;
      if (options.retryOnTimeout === false) return false;
      return deadlineMs - (Date.now() - startedAt) >= attemptTimeoutMs;
    };
    try {
      return await withRetry(attempt, {
        operation: `brapi ${operation}`,
        context: ctx,
        maxRetries: options.retryMaxAttempts ?? this.serverConfig.retryMaxAttempts,
        baseDelayMs: this.serverConfig.retryBaseDelayMs,
        signal: ctx.signal,
        deadlineMs,
        isTransient,
      });
    } catch (err) {
      if (callBound && isRetryDeadline(err)) {
        const attempts = (err as McpError).data?.retryAttempts;
        throw callDeadlineExceeded(
          operation,
          { sent: true, ...(typeof attempts === 'number' && { retryAttempts: attempts }) },
          err,
        );
      }
      throw withTimeoutHint(err);
    }
  }

  /**
   * `init.signal` lets a `withRetry` caller pass the per-attempt
   * `RetryAttempt.signal` — `AbortSignal.any` over the caller abort and the
   * retry deadline clock — so an expiry firing mid-attempt aborts the request
   * already in flight instead of overshooting it. Callers outside a retry
   * ladder omit it and fall back to the caller signal.
   */
  private async doFetch(
    url: string,
    ctx: Context,
    init: Omit<FetchWithTimeoutOptions, 'rejectPrivateIPs'>,
    timeoutMs?: number,
    singleton: boolean = false,
  ): Promise<Response> {
    try {
      return await this.fetcher(url, timeoutMs ?? this.serverConfig.requestTimeoutMs, ctx, {
        ...init,
        signal: init.signal ?? ctx.signal,
        rejectPrivateIPs: !this.serverConfig.allowPrivateIps,
        // Every singleton caller catches the not-found and reports it as an
        // absent record, so a 404 here is an outcome, not an incident — log it
        // at debug. The mapped McpError is thrown either way.
        ...(singleton ? { expectedStatuses: [404] } : {}),
      });
    } catch (err) {
      reclassifyHttpError(err, singleton);
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
 * Stamp the documented `upstream_*` reason onto an HTTP error thrown by
 * `fetchWithTimeout`, keyed on the HTTP status in `data.status` rather than on
 * the code the framework picked: 401 → `Unauthorized`, 403 → `Forbidden`,
 * 404 → `NotFound`, 429 → `RateLimited` (still retried by the default policy),
 * every other 4xx → `ValidationError` + `upstream_bad_request`, except the 4xx
 * the framework classes as `Timeout` (408, 425): those pass through untouched
 * so the retry loop keeps retrying them. A 5xx keeps the framework's
 * classification, except that a `singleton` fetch (`/{noun}/{id}`)
 * turns a `ServiceUnavailable` 5xx into `NotFound` — some upstreams (notably
 * Breedbase) serve HTTP 500 for unknown DbIds instead of 404, and retrying
 * through that just delays the inevitable "not found" outcome. Network-level
 * errors, which have no `status`, pass through untouched.
 */
function reclassifyHttpError(err: unknown, singleton: boolean = false): void {
  if (!(err instanceof McpError)) return;
  const status = extractHttpStatus(err);
  if (status === undefined || status < 400) return;
  const data = asRecord(err.data) ?? {};
  if (status >= 500) {
    if (singleton && err.code === JsonRpcErrorCode.ServiceUnavailable) {
      throw notFound(
        err.message,
        { ...data, reason: 'upstream_not_found', upstreamStatus: status },
        { cause: err },
      );
    }
    return;
  }
  if (err.code === JsonRpcErrorCode.Timeout) return;
  const options = { cause: err };
  if (status === 429) {
    throw rateLimited(err.message, { ...data, reason: 'upstream_rate_limited' }, options);
  }
  if (status === 401) {
    throw unauthorized(err.message, { ...data, reason: 'upstream_unauthorized' }, options);
  }
  if (status === 403) {
    throw forbidden(err.message, { ...data, reason: 'upstream_forbidden' }, options);
  }
  if (status === 404) {
    throw notFound(err.message, { ...data, reason: 'upstream_not_found' }, options);
  }
  throw validationError(err.message, { ...data, reason: 'upstream_bad_request' }, options);
}

function isTimeout(error: unknown): error is McpError {
  return error instanceof McpError && error.code === JsonRpcErrorCode.Timeout;
}

/** `withRetry`'s expiry of the `deadlineMs` it was given. */
function isRetryDeadline(error: unknown): boolean {
  return isTimeout(error) && error.data?.reason === 'retry_deadline_exceeded';
}

/** A `Timeout` leaving the client carries the upstream-timeout recovery hint. */
function withTimeoutHint(error: unknown): unknown {
  if (!isTimeout(error) || error.data?.recovery !== undefined) return error;
  return new McpError(
    error.code,
    error.message,
    { ...error.data, recovery: { hint: UPSTREAM_TIMEOUT_HINT } },
    { cause: error },
  );
}

async function readBinary(response: Response): Promise<BinaryResponse> {
  const buffer = await response.arrayBuffer();
  const contentType = response.headers.get('Content-Type') ?? 'application/octet-stream';
  return { bytes: new Uint8Array(buffer), contentType };
}

function extractHttpStatus(err: McpError): number | undefined {
  const data = asRecord(err.data);
  if (!data) return;
  const status = data.status;
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
 * True when the fetch guard refused the request's host as a private or
 * reserved address. A configuration refusal, not an outage or a sparse
 * server: callers propagate it instead of degrading.
 */
export function isPrivateAddressBlocked(err: unknown): err is McpError {
  return err instanceof McpError && err.data?.reason === PRIVATE_ADDRESS_BLOCKED_REASON;
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
      reject(requestCancelled('Sleep aborted by caller'));
      return;
    }
    const timer = setTimeout(() => {
      ctx.signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(requestCancelled('Sleep aborted by caller'));
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
