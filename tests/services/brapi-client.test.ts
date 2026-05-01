/**
 * @fileoverview Unit tests for BrapiClient. Uses dependency-injected mock
 * fetcher to exercise URL construction, header assembly, envelope parsing,
 * HTTP error reclassification, and the async-search poll loop.
 *
 * @module tests/services/brapi-client.test
 */

import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { BrapiClient, type Fetcher, type ResolvedAuth } from '@/services/brapi-client/index.js';

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

function httpError(status: number, responseBody = 'error'): McpError {
  return serviceUnavailable(`Fetch failed. Status: ${status}`, {
    statusCode: status,
    statusText: 'Error',
    responseBody,
  });
}

function envelope<T>(result: T) {
  return { metadata: { pagination: undefined }, result };
}

describe('BrapiClient', () => {
  let fetcher: Fetcher & ReturnType<typeof vi.fn>;
  let client: BrapiClient;

  beforeEach(() => {
    fetcher = vi.fn() as unknown as Fetcher & ReturnType<typeof vi.fn>;
    client = new BrapiClient(baseConfig, fetcher);
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
        responseBody: 'Unknown filter: bogusFilter',
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
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    });
  });
});
