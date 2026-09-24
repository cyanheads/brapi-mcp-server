/**
 * @fileoverview Unit tests for BrapiClient. Uses dependency-injected mock
 * fetcher to exercise URL construction, header assembly, envelope parsing,
 * HTTP error reclassification, and the async-search poll loop.
 *
 * @module tests/services/brapi-client.test
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { BrapiClient, type Fetcher, type ResolvedAuth } from '@/services/brapi-client/index.js';

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

    it('maps HTTP 429 to upstream_rate_limited and still retries it', async () => {
      respond = (_req, res) => {
        res.writeHead(429).end('slow down');
      };
      await expect(
        productionClient(1).get(origin, '/brapi/v2/studies', createMockContext()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: { reason: 'upstream_rate_limited', status: 429 },
      });
      expect(hits).toHaveLength(2);
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

    it('exhausts the retry budget on a persistent 429', async () => {
      respond = (_req, res) => {
        res.writeHead(429).end('slow down');
      };
      await expect(
        productionClient(2).get(origin, '/brapi/v2/studies', createMockContext()),
      ).rejects.toMatchObject({ data: { reason: 'upstream_rate_limited' } });
      expect(hits).toHaveLength(3);
    });

    for (const status of [400, 401, 403, 404, 422]) {
      it(`does not retry HTTP ${status} even when the next attempt would succeed`, async () => {
        failThenSucceed(status, 1);
        await expect(
          productionClient(2).get(origin, '/brapi/v2/studies', createMockContext()),
        ).rejects.toMatchObject({ data: { status } });
        expect(hits).toHaveLength(1);
      });
    }

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

    it('maps a singleton HTTP 500 to NotFound over a real socket', async () => {
      respond = (_req, res) => {
        res.writeHead(500).end('unknown study');
      };
      await expect(
        productionClient().get(origin, '/brapi/v2/studies/missing', createMockContext(), {
          singleton: true,
        }),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'upstream_not_found', upstreamStatus: 500 },
      });
      expect(hits).toHaveLength(1);
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

    it('reclassifies 404 as NotFound', async () => {
      fetcher.mockRejectedValue(httpError(404, 'study not found'));
      const ctx = createMockContext();

      await expect(client.get(BASE_URL, '/studies/missing', ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
      });
    });

    it('reclassifies 401 as Unauthorized', async () => {
      fetcher.mockRejectedValue(httpError(401));
      const ctx = createMockContext();

      await expect(client.get(BASE_URL, '/studies', ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.Unauthorized,
      });
    });

    it('reclassifies 403 as Forbidden', async () => {
      fetcher.mockRejectedValue(httpError(403));
      const ctx = createMockContext();

      await expect(client.get(BASE_URL, '/studies', ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.Forbidden,
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

    it('reclassifies 429 as RateLimited (retryable)', async () => {
      fetcher.mockRejectedValue(httpError(429));
      const ctx = createMockContext();

      await expect(client.get(BASE_URL, '/studies', ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
      });
    });

    it('passes through 5xx as ServiceUnavailable', async () => {
      fetcher.mockRejectedValue(httpError(503));
      const ctx = createMockContext();

      await expect(client.get(BASE_URL, '/studies', ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
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

    it('still surfaces 5xx as ServiceUnavailable on non-singleton GETs', async () => {
      fetcher.mockRejectedValue(httpError(500));
      const ctx = createMockContext();

      await expect(client.get(BASE_URL, '/studies', ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
      });
    });

    it('rejects payloads that are not a BrAPI envelope', async () => {
      fetcher.mockResolvedValue(jsonResponse({ notAnEnvelope: true }));
      const ctx = createMockContext();

      await expect(client.get(BASE_URL, '/studies', ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
      });
    });

    it('rejects empty response bodies', async () => {
      fetcher.mockResolvedValue(new Response('', { status: 200 }));
      const ctx = createMockContext();

      await expect(client.get(BASE_URL, '/studies', ctx)).rejects.toMatchObject({
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

    it('respects retryMaxAttempts override (companion-style: 0 retries)', async () => {
      const c = new BrapiClient({ ...baseConfig, retryMaxAttempts: 5 }, fetcher);
      fetcher.mockRejectedValue(httpError(503));
      const ctx = createMockContext();

      await expect(c.get(BASE_URL, '/trials', ctx, { retryMaxAttempts: 0 })).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });
});
