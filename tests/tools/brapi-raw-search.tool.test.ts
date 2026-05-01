/**
 * @fileoverview Tests for `brapi_raw_search` — sync POST passthrough, async
 * polling, suggestion surfacing, body forwarding.
 *
 * @module tests/tools/brapi-raw-search.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiRawSearch } from '@/mcp-server/tools/definitions/brapi-raw-search.tool.js';
import {
  BASE_URL,
  envelope,
  initTestServices,
  jsonResponse,
  type MockFetcher,
  pathnameOf,
  resetTestServices,
} from './_tool-test-helpers.js';

async function connect(fetcher: MockFetcher, serverName = 'Test') {
  fetcher.mockImplementation(async (url: string) => {
    const path = pathnameOf(url);
    if (path.endsWith('/serverinfo')) {
      return jsonResponse(envelope({ serverName, calls: [] }));
    }
    if (path.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: [] }));
    return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
  });
  const ctx = createMockContext({ tenantId: 't1', errors: brapiRawSearch.errors });
  await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
  fetcher.mockReset();
  return ctx;
}

describe('brapi_raw_search tool', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('returns sync results when the server inlines the response', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [{ studyDbId: 's-1' }] })));

    const result = await brapiRawSearch.handler(
      brapiRawSearch.input.parse({ noun: 'studies', body: { commonCropNames: ['Cassava'] } }),
      ctx,
    );

    expect(result.kind).toBe('sync');
    expect(result.searchResultsDbId).toBeUndefined();
    expect(result.suggestion).toContain('brapi_find_studies');

    const init = fetcher.mock.calls[0]![3] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ commonCropNames: ['Cassava'] });
  });

  it('polls when the server returns an async searchResultsDbId', async () => {
    const ctx = await connect(fetcher);
    fetcher
      .mockResolvedValueOnce(jsonResponse(envelope({ searchResultsDbId: 'abc-123' })))
      .mockResolvedValueOnce(jsonResponse(envelope({ data: [{ ok: true }] })));

    const result = await brapiRawSearch.handler(
      brapiRawSearch.input.parse({ noun: 'observations', body: {} }),
      ctx,
    );

    expect(result.kind).toBe('async');
    expect(result.searchResultsDbId).toBe('abc-123');
    expect(result.suggestion).toContain('brapi_find_observations');
  });

  it('rejects nouns containing path separators at parse time', () => {
    expect(() => brapiRawSearch.input.parse({ noun: 'studies/sub', body: {} })).toThrow();
  });

  it('throws ValidationError when the dialect disables this search noun', async () => {
    const ctx = await connect(fetcher, 'CassavaBase');
    // CassavaBase dialect declares /search/germplasm as known-dead.
    await expect(
      brapiRawSearch.handler(
        brapiRawSearch.input.parse({ noun: 'germplasm', body: { commonCropNames: ['Cassava'] } }),
        ctx,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'search_endpoint_disabled', dialectId: 'cassavabase', noun: 'germplasm' },
    });
    // Should NOT have hit the upstream — disable check runs before the POST.
    expect(fetcher.mock.calls.length).toBe(0);
  });

  it('routes through normally when the dialect does not disable the noun (calls on cassavabase)', async () => {
    const ctx = await connect(fetcher, 'CassavaBase');
    // `calls` is intentionally NOT in the cassavabase disabled set.
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] })));
    const result = await brapiRawSearch.handler(
      brapiRawSearch.input.parse({ noun: 'calls', body: { variantSetDbIds: ['vset-1'] } }),
      ctx,
    );
    expect(result.kind).toBe('sync');
  });

  it('format() includes the noun and async ID when present', async () => {
    const ctx = await connect(fetcher);
    fetcher
      .mockResolvedValueOnce(jsonResponse(envelope({ searchResultsDbId: 'rid-1' })))
      .mockResolvedValueOnce(jsonResponse(envelope({ data: [] })));
    const result = await brapiRawSearch.handler(
      brapiRawSearch.input.parse({ noun: 'observations', body: {} }),
      ctx,
    );
    const text = (brapiRawSearch.format!(result)[0] as { text: string }).text;
    expect(text).toContain('/search/observations');
    expect(text).toContain('rid-1');
    expect(text).toContain('async');
  });
});
