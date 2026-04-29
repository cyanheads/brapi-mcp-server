/**
 * @fileoverview Tests for `brapi_raw_get` — passthrough behavior, suggestion
 * surfacing for endpoints covered by curated tools, cross-origin path
 * rejection.
 *
 * @module tests/tools/brapi-raw-get.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiRawGet } from '@/mcp-server/tools/definitions/brapi-raw-get.tool.js';
import {
  BASE_URL,
  envelope,
  initTestServices,
  jsonResponse,
  type MockFetcher,
  pathnameOf,
  resetTestServices,
} from './_tool-test-helpers.js';

async function connect(fetcher: MockFetcher) {
  fetcher.mockImplementation(async (url: string) => {
    const path = pathnameOf(url);
    if (path.endsWith('/serverinfo')) {
      return jsonResponse(
        envelope({
          serverName: 'Test',
          calls: [{ service: 'studies', methods: ['GET'], versions: ['2.1'] }],
        }),
      );
    }
    if (path.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: [] }));
    return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
  });
  const ctx = createMockContext({ tenantId: 't1' });
  await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
  fetcher.mockReset();
  return ctx;
}

describe('brapi_raw_get tool', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('passes through to the upstream and returns the raw envelope', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(
      jsonResponse(
        envelope({ data: [{ sampleDbId: 'sample-1' }] }, { totalCount: 1 } as unknown as {
          totalCount: number;
        }),
      ),
    );

    const result = await brapiRawGet.handler(
      brapiRawGet.input.parse({ path: '/samples', params: { studyDbIds: ['s-1'] } }),
      ctx,
    );

    expect(result.path).toBe('/samples');
    expect(result.url).toContain('/samples');
    expect(result.url).toContain('studyDbIds=s-1');
    expect(result.metadata.pagination?.totalCount).toBe(1);
    expect(result.suggestion).toBeUndefined();
  });

  it('emits a suggestion when the path is covered by a curated tool', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));

    const result = await brapiRawGet.handler(brapiRawGet.input.parse({ path: '/studies' }), ctx);
    expect(result.suggestion).toBeDefined();
    expect(result.suggestion).toContain('brapi_find_studies');
  });

  it('normalizes a path missing the leading slash', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] })));
    const result = await brapiRawGet.handler(brapiRawGet.input.parse({ path: 'methods' }), ctx);
    expect(result.path).toBe('/methods');
  });

  it('rejects a fully-qualified URL as path (cross-origin smuggling guard)', async () => {
    const ctx = await connect(fetcher);
    await expect(
      brapiRawGet.handler(brapiRawGet.input.parse({ path: 'https://evil.example.com/leak' }), ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
  });

  it('format() includes the URL and pagination block when present', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(
      jsonResponse(
        envelope(
          { data: [{ a: 1 }] },
          // include a richer pagination block to exercise format()
          { totalCount: 12 } as unknown as { totalCount: number },
        ),
      ),
    );
    const result = await brapiRawGet.handler(brapiRawGet.input.parse({ path: '/samples' }), ctx);
    const text = (brapiRawGet.format!(result)[0] as { text: string }).text;
    expect(text).toContain('/samples');
    expect(text).toContain('totalCount=12');
  });
});
