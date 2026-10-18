/**
 * @fileoverview Unit tests for BrapiClient. Uses dependency-injected mock
 * fetcher to exercise URL construction, header assembly, envelope parsing,
 * HTTP error reclassification, and the async-search poll loop.
 *
 * @module tests/services/brapi-client.test
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import {
  BrapiClient,
  CALL_DEADLINE_MS,
  type Fetcher,
  type ResolvedAuth,
} from '@/services/brapi-client/index.js';

const BASE_URL = 'https://brapi.example.org/brapi/v2';

/** Captured before any test stubs `globalThis.fetch`; used only to reach the local stub server. */
const realFetch = globalThis.fetch;

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

function jsonResponse(body: unknown, status = 200, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function httpError(status: number, body = 'error'): McpError {
  // Mirrors the canonical `error.data` shape fetchWithTimeout emits. The
  // legacy `statusCode` / `responseBody` aliases are deliberately omitted so
  // the client stays pinned to the canonical names.
  return serviceUnavailable(`Fetch failed. Status: ${status}`, {
    status,
    statusText: 'Error',
    body,
  });
}

function envelope<T>(result: T) {
  return { metadata: { pagination: undefined }, result };
}

describe('BrapiClient', () => {
  let fetcher: Fetcher & ReturnType<typeof vi.fn>;
  let client: BrapiClient;

  beforeEach(() => {
    fetcher = vi.fn(async (url: string | URL) => {
      throw new Error(`Unmocked fetcher call: ${String(url)}`);
    }) as unknown as Fetcher & ReturnType<typeof vi.fn>;
    client = new BrapiClient(baseConfig, fetcher);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        throw new Error(`Unmocked global fetch: ${String(input)}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('production fetch classification and retries', () => {
    it('maps an HTTP 500 singleton to NotFound without retrying', async () => {
      const network = vi.fn().mockResolvedValue(new Response('unknown study', { status: 500 }));
      vi.stubGlobal('fetch', network);
      const realClient = new BrapiClient({
        ...baseConfig,
        allowPrivateIps: true,
        retryMaxAttempts: 2,
      });
      await expect(
        realClient.get(BASE_URL, '/studies/missing', createMockContext(), { singleton: true }),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'upstream_not_found', upstreamStatus: 500 },
      });
      expect(network).toHaveBeenCalledTimes(1);
    });

    it('retries an ordinary HTTP 500 and returns the successful response', async () => {
      const network = vi
        .fn()
        .mockResolvedValueOnce(new Response('temporarily unavailable', { status: 500 }))
        .mockResolvedValueOnce(jsonResponse(envelope({ data: [{ studyDbId: 's1' }] })));
      vi.stubGlobal('fetch', network);
      const realClient = new BrapiClient({
        ...baseConfig,
        allowPrivateIps: true,
        retryMaxAttempts: 2,
      });
      await expect(
        realClient.get(BASE_URL, '/studies', createMockContext()),
      ).resolves.toMatchObject({
        result: { data: [{ studyDbId: 's1' }] },
      });
      expect(network).toHaveBeenCalledTimes(2);
    });

    it('preserves HTTP 501 retryable=false instead of retrying the unsupported method', async () => {
      const network = vi.fn().mockResolvedValue(new Response('not implemented', { status: 501 }));
      vi.stubGlobal('fetch', network);
      const realClient = new BrapiClient({
        ...baseConfig,
        allowPrivateIps: true,
        retryMaxAttempts: 2,
      });
      await expect(realClient.get(BASE_URL, '/studies', createMockContext())).rejects.toMatchObject(
        {
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { status: 501, retryable: false },
        },
      );
      expect(network).toHaveBeenCalledTimes(1);
    });
  });

  describe('HTTP 4xx classification over a real socket', () => {
    let server: Server;
    let origin: string;
    let hits: Array<{ method: string; path: string }>;
    let respond: (req: IncomingMessage, res: ServerResponse) => void;

    beforeEach(async () => {
      hits = [];
      respond = (_req, res) => {
        res.writeHead(500).end('respond() not set by the test');
      };
      server = createServer((req, res) => {
        hits.push({ method: req.method ?? '', path: req.url ?? '' });
        respond(req, res);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      // Only the local stub is reachable; anything else still rejects.
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
          String(input instanceof Request ? input.url : input).startsWith(origin)
            ? realFetch(input, init)
            : Promise.reject(new Error(`Unmocked global fetch: ${String(input)}`)),
        ),
      );
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    function productionClient(retryMaxAttempts = 2) {
      return new BrapiClient({ ...baseConfig, allowPrivateIps: true, retryMaxAttempts });
    }

    const cases: Array<{ status: number; code: JsonRpcErrorCode; reason: string }> = [
      { status: 400, code: JsonRpcErrorCode.ValidationError, reason: 'upstream_bad_request' },
      { status: 401, code: JsonRpcErrorCode.Unauthorized, reason: 'upstream_unauthorized' },
      { status: 402, code: JsonRpcErrorCode.ValidationError, reason: 'upstream_bad_request' },
      { status: 403, code: JsonRpcErrorCode.Forbidden, reason: 'upstream_forbidden' },
      { status: 404, code: JsonRpcErrorCode.NotFound, reason: 'upstream_not_found' },
      { status: 405, code: JsonRpcErrorCode.ValidationError, reason: 'upstream_bad_request' },
      { status: 409, code: JsonRpcErrorCode.ValidationError, reason: 'upstream_bad_request' },
      { status: 422, code: JsonRpcErrorCode.ValidationError, reason: 'upstream_bad_request' },
    ];

    for (const { status, code, reason } of cases) {
      it(`maps a GET HTTP ${status} to ${reason} without retrying`, async () => {
        respond = (_req, res) => {
          res.writeHead(status, { 'Content-Type': 'text/plain' }).end(`upstream said ${status}`);
        };
        const error = await productionClient()
          .get(origin, '/brapi/v2/studies', createMockContext())
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(McpError);
        expect(error).toMatchObject({
          code,
          data: { reason, status, body: `upstream said ${status}` },
        });
        expect(hits).toHaveLength(1);
      });
    }

    it('maps HTTP 429 to upstream_rate_limited and retries it until the budget runs out', async () => {
      respond = (_req, res) => {
        res.writeHead(429).end('slow down');
      };
      await expect(
        productionClient(2).get(origin, '/brapi/v2/studies', createMockContext()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: { reason: 'upstream_rate_limited', status: 429 },
      });
      expect(hits).toHaveLength(3);
    });

    /** Answer `first` for the first `failures` hits, then a real envelope. */
    function failThenSucceed(first: number, failures: number) {
      respond = (_req, res) => {
        if (hits.length <= failures) {
          res.writeHead(first).end(`HTTP ${first}`);
          return;
        }
        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify(envelope({ data: [{ studyDbId: 'recovered' }] })));
      };
    }

    for (const status of [408, 425, 429]) {
      it(`retries HTTP ${status} through the retry loop and returns the recovered response`, async () => {
        failThenSucceed(status, 2);
        await expect(
          productionClient(2).get(origin, '/brapi/v2/studies', createMockContext()),
        ).resolves.toMatchObject({ result: { data: [{ studyDbId: 'recovered' }] } });
        expect(hits).toHaveLength(3);
      });
    }

    it('keeps HTTP 408 and 425 as the framework classifies them (Timeout) once retries run out', async () => {
      for (const status of [408, 425]) {
        hits = [];
        respond = (_req, res) => {
          res.writeHead(status).end(`HTTP ${status}`);
        };
        const error = await productionClient(2)
          .get(origin, '/brapi/v2/studies', createMockContext())
          .catch((e: unknown) => e);
        expect(error).toMatchObject({ code: JsonRpcErrorCode.Timeout, data: { status } });
        expect((error as McpError).data).not.toHaveProperty('reason');
        expect(hits).toHaveLength(3);
      }
    });

    it('maps a POST /search HTTP 401 to upstream_unauthorized', async () => {
      respond = (_req, res) => {
        res.writeHead(401).end('login required');
      };
      await expect(
        productionClient().postSearch(
          origin,
          'studies',
          { studyDbIds: ['s1'] },
          createMockContext(),
        ),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.Unauthorized,
        data: { reason: 'upstream_unauthorized', status: 401 },
      });
      expect(hits).toEqual([{ method: 'POST', path: '/search/studies' }]);
    });

    it('maps a 403 on a singleton GET to upstream_forbidden, not NotFound', async () => {
      respond = (_req, res) => {
        res.writeHead(403).end('forbidden');
      };
      await expect(
        productionClient().get(origin, '/brapi/v2/studies/s1', createMockContext(), {
          singleton: true,
        }),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.Forbidden,
        data: { reason: 'upstream_forbidden', status: 403 },
      });
    });
  });

  describe('get', () => {
    it('returns the parsed envelope on 2xx', async () => {
      fetcher.mockResolvedValue(jsonResponse(envelope({ data: [{ studyDbId: 's1' }] })));
      const ctx = createMockContext();

      const result = await client.get<{ data: { studyDbId: string }[] }>(BASE_URL, '/studies', ctx);

      expect(result.result.data[0]?.studyDbId).toBe('s1');
    });

    it('builds URLs with scalar, array, and undefined query params', async () => {
      fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] })));
      const ctx = createMockContext();

      await client.get(BASE_URL, '/studies', ctx, {
        params: {
          pageSize: 50,
          seasons: ['2022', '2023'],
          programDbIds: undefined,
          active: true,
        },
      });

      const calledUrl = new URL(fetcher.mock.calls[0]![0] as string);
      expect(calledUrl.pathname).toBe('/brapi/v2/studies');
      expect(calledUrl.searchParams.get('pageSize')).toBe('50');
      expect(calledUrl.searchParams.getAll('seasons')).toEqual(['2022', '2023']);
      expect(calledUrl.searchParams.get('active')).toBe('true');
      expect(calledUrl.searchParams.has('programDbIds')).toBe(false);
    });

    it('trims trailing slash from baseUrl and prefixes path slash', async () => {
      fetcher.mockResolvedValue(jsonResponse(envelope({})));
      const ctx = createMockContext();

      await client.get(`${BASE_URL}/`, 'studies', ctx);

      const calledUrl = fetcher.mock.calls[0]![0] as string;
      expect(calledUrl).toBe(`${BASE_URL}/studies`);
    });

    it('attaches the resolved auth header', async () => {
      fetcher.mockResolvedValue(jsonResponse(envelope({})));
      const ctx = createMockContext();
      const auth: ResolvedAuth = {
        headerName: 'Authorization',
        headerValue: 'Bearer token-123',
      };

      await client.get(BASE_URL, '/studies', ctx, { auth });

      const init = fetcher.mock.calls[0]![3] as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-123');
    });

    it('passes SSRF rejection based on allowPrivateIps', async () => {
      fetcher.mockImplementation(async () => jsonResponse(envelope({})));
      const ctx = createMockContext();

      await client.get(BASE_URL, '/studies', ctx);
      const opts = fetcher.mock.calls[0]![3] as { rejectPrivateIPs?: boolean };
      expect(opts.rejectPrivateIPs).toBe(true);

      const permissive = new BrapiClient({ ...baseConfig, allowPrivateIps: true }, fetcher);
      await permissive.get(BASE_URL, '/studies', ctx);
      const opts2 = fetcher.mock.calls[1]![3] as { rejectPrivateIPs?: boolean };
      expect(opts2.rejectPrivateIPs).toBe(false);
    });

    it.each([
      [404, JsonRpcErrorCode.NotFound],
      [401, JsonRpcErrorCode.Unauthorized],
      [403, JsonRpcErrorCode.Forbidden],
      [429, JsonRpcErrorCode.RateLimited],
      [503, JsonRpcErrorCode.ServiceUnavailable],
      // A non-singleton 500 stays ServiceUnavailable; only singleton=true maps it to NotFound.
      [500, JsonRpcErrorCode.ServiceUnavailable],
    ])('reclassifies HTTP %i to code %i', async (status, code) => {
      fetcher.mockRejectedValue(httpError(status));

      await expect(client.get(BASE_URL, '/studies', createMockContext())).rejects.toMatchObject({
        code,
      });
    });

    it('reclassifies 400 as ValidationError and preserves response body', async () => {
      fetcher.mockRejectedValue(httpError(400, 'Unknown filter: bogusFilter'));
      const ctx = createMockContext();

      const result = await client.get(BASE_URL, '/studies', ctx).catch((e: McpError) => e);

      expect(result).toBeInstanceOf(McpError);
      expect((result as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
      expect((result as McpError).data).toMatchObject({
        body: 'Unknown filter: bogusFilter',
      });
    });

    it('reclassifies 5xx as NotFound when singleton=true (#30)', async () => {
      // Breedbase serves HTTP 500 for unknown `/studies/{id}` instead of 404.
      // With singleton=true the client must fast-fail as NotFound so the
      // calling tool can route through its `*_not_found` contract instead of
      // burning the full retry budget on a record that doesn't exist.
      fetcher.mockRejectedValue(httpError(500, 'Internal Server Error'));
      const ctx = createMockContext();

      await expect(
        client.get(BASE_URL, '/studies/does-not-exist', ctx, { singleton: true }),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'upstream_not_found', upstreamStatus: 500 },
      });
    });

    it.each([
      ['a payload that is not a BrAPI envelope', () => jsonResponse({ notAnEnvelope: true })],
      ['an empty response body', () => new Response('', { status: 200 })],
    ])('rejects %s as ValidationError', async (_label, response) => {
      fetcher.mockResolvedValue(response());

      await expect(client.get(BASE_URL, '/studies', createMockContext())).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
      });
    });

    it('rejects non-JSON bodies with a ServiceUnavailable', async () => {
      fetcher.mockResolvedValue(
        new Response('<!DOCTYPE html><h1>Gateway</h1>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
      );
      const ctx = createMockContext();

      await expect(client.get(BASE_URL, '/studies', ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
      });
    });
  });

  describe('postSearch', () => {
    it('returns sync variant with envelope when results are inline', async () => {
      fetcher.mockResolvedValue(jsonResponse(envelope({ data: [{ studyDbId: 's1' }] })));
      const ctx = createMockContext();

      const result = await client.postSearch<{
        data: { studyDbId: string }[];
      }>(BASE_URL, 'studies', { crop: 'Cassava' }, ctx);

      expect(result.kind).toBe('sync');
      if (result.kind === 'sync') {
        expect(result.envelope.result.data[0]?.studyDbId).toBe('s1');
      }
    });

    it('returns async variant when result carries only a searchResultsDbId', async () => {
      fetcher.mockResolvedValue(jsonResponse(envelope({ searchResultsDbId: 'abc123' })));
      const ctx = createMockContext();

      const result = await client.postSearch(BASE_URL, 'observations', {}, ctx);

      expect(result.kind).toBe('async');
      if (result.kind === 'async') {
        expect(result.searchResultsDbId).toBe('abc123');
      }
    });

    it('treats payloads with both searchResultsDbId and non-empty data as sync', async () => {
      fetcher.mockResolvedValue(
        jsonResponse(envelope({ searchResultsDbId: 'abc', data: [{ ok: true }] })),
      );
      const ctx = createMockContext();

      const result = await client.postSearch(BASE_URL, 'studies', {}, ctx);
      expect(result.kind).toBe('sync');
    });

    it('sends Content-Type: application/json and serializes the body', async () => {
      fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] })));
      const ctx = createMockContext();

      await client.postSearch(BASE_URL, 'studies', { crop: 'Cassava' }, ctx);

      const init = fetcher.mock.calls[0]![3] as RequestInit;
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      expect(init.body).toBe(JSON.stringify({ crop: 'Cassava' }));
      expect(init.method).toBe('POST');
    });
  });

  describe('getSearchResults', () => {
    it('classifies an already cancelled poll without fetching', async () => {
      const controller = new AbortController();
      controller.abort();
      const ctx = createMockContext({ signal: controller.signal });
      await expect(
        client.getSearchResults(BASE_URL, 'observations', 'abc', ctx),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.RequestCancelled,
        data: { noun: 'observations', searchResultsDbId: 'abc' },
      });
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('cancels the wait between polls without another request', async () => {
      const controller = new AbortController();
      const listener = vi.spyOn(controller.signal, 'addEventListener');
      fetcher.mockResolvedValue(new Response('', { status: 202 }));
      const waitingClient = new BrapiClient(
        { ...baseConfig, searchPollIntervalMs: 10_000 },
        fetcher,
      );
      const pending = waitingClient.getSearchResults(
        BASE_URL,
        'observations',
        'abc',
        createMockContext({ signal: controller.signal }),
      );
      const assertion = expect(pending).rejects.toMatchObject({
        code: JsonRpcErrorCode.RequestCancelled,
      });
      await vi.waitFor(() =>
        expect(listener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true }),
      );
      controller.abort();
      await assertion;
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('returns the envelope on a 200 response', async () => {
      fetcher.mockResolvedValue(jsonResponse(envelope({ data: [{ observationDbId: 'o1' }] })));
      const ctx = createMockContext();

      const result = await client.getSearchResults<{
        data: { observationDbId: string }[];
      }>(BASE_URL, 'observations', 'abc123', ctx);

      expect(result.result.data[0]?.observationDbId).toBe('o1');
    });

    it('includes query params when polling paged async search results', async () => {
      fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] })));
      const ctx = createMockContext();

      await client.getSearchResults(BASE_URL, 'calls', 'abc123', ctx, {
        params: { page: 2, pageSize: 1000 },
      });

      const calledUrl = new URL(String(fetcher.mock.calls[0]![0]));
      expect(calledUrl.pathname).toBe('/brapi/v2/search/calls/abc123');
      expect(calledUrl.searchParams.get('page')).toBe('2');
      expect(calledUrl.searchParams.get('pageSize')).toBe('1000');
    });

    it('polls past 202 responses until 200', async () => {
      fetcher
        .mockResolvedValueOnce(
          new Response('', {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(
          new Response('', {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(jsonResponse(envelope({ data: [] })));
      const ctx = createMockContext();

      const result = await client.getSearchResults(BASE_URL, 'observations', 'abc123', ctx);

      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(result.result).toEqual({ data: [] });
    });

    it('times out after searchPollTimeoutMs on persistent 202', async () => {
      const shortTimeout = new BrapiClient(
        { ...baseConfig, searchPollTimeoutMs: 5, searchPollIntervalMs: 1 },
        fetcher,
      );
      fetcher.mockResolvedValue(new Response('', { status: 202 }));
      const ctx = createMockContext();

      await expect(
        shortTimeout.getSearchResults(BASE_URL, 'observations', 'abc', ctx),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.Timeout });
    });
  });

  // The v0.4.7 foundational fix: BrapiClient.get applies the dialect adapter
  // at the client edge so every call site benefits without each having to
  // remember to call dialect.adaptGetFilters by hand.
  describe('dialect awareness', () => {
    const fakeDialect: import('@/services/brapi-dialect/types.js').BrapiDialect = {
      id: 'fake-singularizing',
      adaptGetFilters: (endpoint, filters) => {
        if (endpoint !== 'trials') {
          return { filters: { ...filters }, dropped: [], warnings: [] };
        }
        const out: Record<string, unknown> = {};
        const warnings: string[] = [];
        const dropped: string[] = [];
        for (const [key, value] of Object.entries(filters)) {
          if (key === 'unsupportedFilter') {
            dropped.push(key);
            warnings.push(`fake dialect: dropped '${key}'`);
            continue;
          }
          if (key === 'trialDbIds' && Array.isArray(value)) {
            out.trialDbId = value[0];
            continue;
          }
          out[key] = value;
        }
        return { filters: out, dropped, warnings };
      },
    };

    it('translates plural ID filters to singular when a dialect is supplied', async () => {
      fetcher.mockResolvedValue(jsonResponse(envelope({ data: [{ trialDbId: '7526' }] })));
      const ctx = createMockContext();

      await client.get(BASE_URL, '/trials', ctx, {
        params: { trialDbIds: ['7526'], pageSize: 1 },
        dialect: fakeDialect,
      });

      const url = new URL(String(fetcher.mock.calls[0]?.[0]));
      expect(url.searchParams.getAll('trialDbId')).toEqual(['7526']);
      expect(url.searchParams.has('trialDbIds')).toBe(false);
    });

    it('appends dialect warnings to the supplied warnings sink', async () => {
      fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] })));
      const ctx = createMockContext();
      const warnings: string[] = [];

      await client.get(BASE_URL, '/trials', ctx, {
        params: { trialDbIds: ['7526'], unsupportedFilter: 'x' },
        dialect: fakeDialect,
        warnings,
      });

      expect(warnings.some((w) => /dropped 'unsupportedFilter'/.test(w))).toBe(true);
    });

    it('throws DIALECT_ALL_DROPPED when every supplied filter is dropped', async () => {
      const ctx = createMockContext();

      await expect(
        client.get(BASE_URL, '/trials', ctx, {
          params: { unsupportedFilter: 'x' },
          dialect: fakeDialect,
        }),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'dialect_all_filters_dropped', dialect: 'fake-singularizing' },
      });
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('passes filters through unchanged when no dialect is supplied (raw_get-style)', async () => {
      fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] })));
      const ctx = createMockContext();

      await client.get(BASE_URL, '/trials', ctx, {
        params: { trialDbIds: ['7526'] },
      });

      const url = new URL(String(fetcher.mock.calls[0]?.[0]));
      expect(url.searchParams.getAll('trialDbIds')).toEqual(['7526']);
    });
  });

  describe('request budget', () => {
    type BudgetOptions = {
      deadlineMs?: number;
      retryMaxAttempts?: number;
      retryOnTimeout?: boolean;
    };
    /** `get` and `postSearch` take the same per-request budget options. */
    const budgeted: Array<{
      name: string;
      call: (c: BrapiClient, options: BudgetOptions) => Promise<unknown>;
    }> = [
      {
        name: 'get',
        call: (c, options) => c.get(BASE_URL, '/observations', createMockContext(), options),
      },
      {
        name: 'postSearch',
        call: (c, options) => c.postSearch(BASE_URL, 'studies', {}, createMockContext(), options),
      },
    ];

    describe.each(budgeted)('$name', ({ call }) => {
      it('retryOnTimeout: false fails a timed-out attempt at once', async () => {
        const c = new BrapiClient({ ...baseConfig, retryMaxAttempts: 3 }, fetcher);
        fetcher.mockRejectedValue(timeout('Fetch timed out.', { errorSource: 'FetchTimeout' }));

        await expect(call(c, { retryOnTimeout: false })).rejects.toMatchObject({
          code: JsonRpcErrorCode.Timeout,
        });
        expect(fetcher).toHaveBeenCalledTimes(1);
      });

      it('honors a retryMaxAttempts override (companion-style: 0 retries)', async () => {
        const c = new BrapiClient({ ...baseConfig, retryMaxAttempts: 5 }, fetcher);
        fetcher.mockRejectedValue(httpError(503));

        await expect(call(c, { retryMaxAttempts: 0 })).rejects.toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
        });
        expect(fetcher).toHaveBeenCalledTimes(1);
      });

      it('deadlineMs aborts the attempt in flight and rejects with Timeout', async () => {
        const c = new BrapiClient({ ...baseConfig, requestTimeoutMs: 30_000 }, fetcher);
        let attemptSignal: AbortSignal | undefined;
        fetcher.mockImplementation(
          (_url: string, _timeoutMs: number, _ctx: unknown, options?: { signal?: AbortSignal }) =>
            new Promise<Response>((_, reject) => {
              attemptSignal = options?.signal;
              attemptSignal?.addEventListener('abort', () => reject(attemptSignal?.reason), {
                once: true,
              });
            }),
        );

        await expect(call(c, { deadlineMs: 50 })).rejects.toMatchObject({
          code: JsonRpcErrorCode.Timeout,
          data: { reason: 'retry_deadline_exceeded', deadlineMs: 50 },
        });
        expect(attemptSignal?.aborted).toBe(true);
      });
    });

    it('get retryOnTimeout: false still retries 5xx', async () => {
      const c = new BrapiClient({ ...baseConfig, retryMaxAttempts: 3 }, fetcher);
      fetcher
        .mockRejectedValueOnce(httpError(503))
        .mockRejectedValueOnce(httpError(502))
        .mockResolvedValueOnce(jsonResponse(envelope({ data: [] })));

      await expect(
        c.get(BASE_URL, '/observations', createMockContext(), { retryOnTimeout: false }),
      ).resolves.toMatchObject({ result: { data: [] } });
      expect(fetcher).toHaveBeenCalledTimes(3);
    });

    it('getSearchResults stops polling at a deadlineMs shorter than searchPollTimeoutMs', async () => {
      const c = new BrapiClient(
        { ...baseConfig, searchPollTimeoutMs: 5_000, searchPollIntervalMs: 5 },
        fetcher,
      );
      fetcher.mockResolvedValue(new Response('', { status: 202 }));
      const startedAt = Date.now();

      await expect(
        c.getSearchResults(BASE_URL, 'studies', 'abc', createMockContext(), { deadlineMs: 40 }),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'retry_deadline_exceeded', deadlineMs: 40 },
      });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    });

    it('getSearchResults names no deadline reason when its own poll budget ends first', async () => {
      const c = new BrapiClient(
        { ...baseConfig, searchPollTimeoutMs: 40, searchPollIntervalMs: 5 },
        fetcher,
      );
      fetcher.mockResolvedValue(new Response('', { status: 202 }));

      const err = await c
        .getSearchResults(BASE_URL, 'studies', 'abc', createMockContext(), { deadlineMs: 5_000 })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code: JsonRpcErrorCode.Timeout, data: { pollTimeoutMs: 40 } });
      expect((err as { data: { reason?: string } }).data.reason).toBeUndefined();
    });

    it('getSearchResults clips each poll timeout to what remains of deadlineMs', async () => {
      const c = new BrapiClient({ ...baseConfig, requestTimeoutMs: 30_000 }, fetcher);
      fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] })));

      await c.getSearchResults(BASE_URL, 'studies', 'abc', createMockContext(), {
        deadlineMs: 2_000,
      });
      expect(fetcher.mock.calls[0]![1]).toBeLessThanOrEqual(2_000);
    });

    it('getSearchResults keeps the configured poll timeout without a deadline', async () => {
      const c = new BrapiClient({ ...baseConfig, requestTimeoutMs: 30_000 }, fetcher);
      fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] })));

      await c.getSearchResults(BASE_URL, 'studies', 'abc', createMockContext(), {
        timeoutMs: 7_000,
      });
      expect(fetcher.mock.calls[0]![1]).toBe(7_000);
    });
  });

  describe('call deadline', () => {
    /** The call deadline is measured from `ctx.timestamp`, the moment the call started. */
    const callStartedAgo = (elapsedMs: number) => ({
      ...createMockContext(),
      timestamp: new Date(Date.now() - elapsedMs).toISOString(),
    });
    /** A context with `remainingMs` left of its call deadline. */
    const withRemaining = (remainingMs: number) => callStartedAgo(CALL_DEADLINE_MS - remainingMs);

    /**
     * A fetcher for a host that never answers: like `fetchWithTimeout`, it
     * rejects with `Timeout` at its `timeoutMs` (capped at `capMs`) or when its
     * signal aborts.
     */
    const stalled =
      (capMs = 3_000) =>
      (_url: string, timeoutMs: number, _ctx: unknown, options?: { signal?: AbortSignal }) =>
        new Promise<Response>((_, reject) => {
          const timer = setTimeout(
            () => reject(timeout('stub timed out', { errorSource: 'FetchTimeout' })),
            Math.min(capMs, timeoutMs),
          );
          options?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(options.signal?.reason);
            },
            { once: true },
          );
        });

    const expectCallDeadline = async (pending: Promise<unknown>) => {
      const error = await pending.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(McpError);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'call_deadline_exceeded', callDeadlineMs: CALL_DEADLINE_MS },
      });
      const { message, data } = error as McpError;
      expect(message).toContain(`${CALL_DEADLINE_MS / 1000} s deadline`);
      expect(message).not.toMatch(/retry deadline|\d+ms/);
      expect((data as { recovery?: { hint?: string } }).recovery?.hint).toMatch(/\w/);
      return error as McpError;
    };

    it('skips a timeout retry when the remaining budget cannot fit another attempt', async () => {
      const c = new BrapiClient(
        { ...baseConfig, requestTimeoutMs: 1_000, retryMaxAttempts: 3 },
        fetcher,
      );
      fetcher.mockRejectedValue(timeout('Fetch GET timed out.', { errorSource: 'FetchTimeout' }));

      const error = await c
        .get(BASE_URL, '/observations', withRemaining(900))
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code: JsonRpcErrorCode.Timeout });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('still retries a timeout while the budget fits another attempt', async () => {
      const c = new BrapiClient(
        { ...baseConfig, requestTimeoutMs: 1_000, retryMaxAttempts: 3 },
        fetcher,
      );
      fetcher.mockRejectedValue(timeout('Fetch GET timed out.', { errorSource: 'FetchTimeout' }));

      await expect(c.get(BASE_URL, '/observations', withRemaining(20_000))).rejects.toMatchObject({
        code: JsonRpcErrorCode.Timeout,
      });
      expect(fetcher).toHaveBeenCalledTimes(4);
    });

    it('gives an escaping per-request timeout a recovery hint', async () => {
      fetcher.mockRejectedValue(timeout('Fetch GET timed out.', { errorSource: 'FetchTimeout' }));

      const error = (await client
        .get(BASE_URL, '/observations', createMockContext())
        .catch((e: unknown) => e)) as McpError;
      expect(error).toMatchObject({ code: JsonRpcErrorCode.Timeout });
      expect((error.data as { recovery?: { hint?: string } }).recovery?.hint).toMatch(/\w/);
    });

    it('keeps the tighter caller deadline when it ends before the call deadline', async () => {
      const c = new BrapiClient({ ...baseConfig, requestTimeoutMs: 30_000 }, fetcher);
      fetcher.mockImplementation(stalled());

      await expect(
        c.get(BASE_URL, '/observations', withRemaining(20_000), { deadlineMs: 50 }),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'retry_deadline_exceeded', deadlineMs: 50 },
      });
    });

    it('clips a longer caller deadline to the call deadline', async () => {
      const c = new BrapiClient({ ...baseConfig, requestTimeoutMs: 30_000 }, fetcher);
      fetcher.mockImplementation(stalled());

      await expectCallDeadline(
        c.get(BASE_URL, '/observations', withRemaining(80), { deadlineMs: 20_000 }),
      );
    });

    const methods: Array<{
      name: string;
      call: (c: BrapiClient, ctx: ReturnType<typeof createMockContext>) => Promise<unknown>;
    }> = [
      { name: 'get', call: (c, ctx) => c.get(BASE_URL, '/studies', ctx) },
      {
        name: 'getBinary',
        call: (c, ctx) => c.getBinary(BASE_URL, '/images/i1/imagecontent', ctx),
      },
      {
        name: 'fetchBinaryUrl',
        call: (c, ctx) => c.fetchBinaryUrl('https://cdn.example.org/i1.jpg', ctx),
      },
      { name: 'postSearch', call: (c, ctx) => c.postSearch(BASE_URL, 'studies', {}, ctx) },
      {
        name: 'getSearchResults',
        call: (c, ctx) => c.getSearchResults(BASE_URL, 'studies', 'abc', ctx),
      },
      { name: 'post', call: (c, ctx) => c.post(BASE_URL, '/observations', [], ctx) },
      { name: 'put', call: (c, ctx) => c.put(BASE_URL, '/observations', {}, ctx) },
    ];

    for (const { name, call } of methods) {
      it(`${name} sends nothing once the call deadline has passed`, async () => {
        fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] })));
        const error = await expectCallDeadline(call(client, callStartedAgo(CALL_DEADLINE_MS + 1)));
        expect(error.message).toMatch(/not sent/);
        expect(fetcher).not.toHaveBeenCalled();
      });

      it(`${name} ends a stalled request at the call deadline, not after its retries`, async () => {
        const c = new BrapiClient(
          { ...baseConfig, requestTimeoutMs: 30_000, retryMaxAttempts: 3 },
          fetcher,
        );
        fetcher.mockImplementation(stalled());
        const startedAt = Date.now();
        await expectCallDeadline(call(c, withRemaining(120)));
        expect(Date.now() - startedAt).toBeLessThan(1_000);
        expect(fetcher).toHaveBeenCalledTimes(1);
      });
    }

    it('getSearchResults stops polling at the call deadline', async () => {
      const c = new BrapiClient(
        { ...baseConfig, searchPollTimeoutMs: 5_000, searchPollIntervalMs: 5 },
        fetcher,
      );
      fetcher.mockResolvedValue(new Response('', { status: 202 }));
      const startedAt = Date.now();

      await expectCallDeadline(c.getSearchResults(BASE_URL, 'studies', 'abc', withRemaining(60)));
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(fetcher.mock.calls.length).toBeGreaterThan(1);
    });

    describe('over a real socket that never answers', () => {
      let server: Server;
      let origin: string;
      let hits: number;

      beforeEach(async () => {
        hits = 0;
        server = createServer(() => {
          hits += 1;
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        vi.stubGlobal(
          'fetch',
          vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
            String(input instanceof Request ? input.url : input).startsWith(origin)
              ? realFetch(input, init)
              : Promise.reject(new Error(`Unmocked global fetch: ${String(input)}`)),
          ),
        );
      });

      afterEach(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });

      it('rejects with the call-deadline Timeout once the budget runs out', async () => {
        const realClient = new BrapiClient({
          ...baseConfig,
          allowPrivateIps: true,
          requestTimeoutMs: 30_000,
          retryMaxAttempts: 3,
        });
        const startedAt = Date.now();
        await expectCallDeadline(realClient.get(origin, '/brapi/v2/studies', withRemaining(300)));
        expect(Date.now() - startedAt).toBeLessThan(2_000);
        expect(hits).toBe(1);
      });
    });
  });
});
