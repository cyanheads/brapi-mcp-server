/**
 * @fileoverview Tests for `brapi://server/info` — wraps the server-info tool;
 * exercises the same orientation envelope through the resource surface.
 *
 * @module tests/resources/brapi-server-info.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { brapiServerInfoResource } from '@/mcp-server/resources/definitions/brapi-server-info.resource.js';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import {
  BASE_URL,
  envelope,
  initTestServices,
  jsonResponse,
  type MockFetcher,
  pathnameOf,
  resetTestServices,
} from '../tools/_tool-test-helpers.js';

async function connect(fetcher: MockFetcher) {
  fetcher.mockImplementation(async (url: string) => {
    const path = pathnameOf(url);
    if (path.endsWith('/serverinfo')) {
      return jsonResponse(
        envelope({
          serverName: 'Test BrAPI',
          calls: [{ service: 'studies', methods: ['GET'], versions: ['2.1'] }],
        }),
      );
    }
    if (path.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: ['Cassava'] }));
    return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
  });
  const ctx = createMockContext({ tenantId: 't1' });
  const connected = await brapiConnect.handler(
    brapiConnect.input.parse({ baseUrl: BASE_URL }),
    ctx,
  );
  rejectUnmocked(fetcher);
  return { ctx, connected };
}

function rejectUnmocked(fetcher: MockFetcher) {
  fetcher.mockReset();
  fetcher.mockImplementation(async (url: string) => {
    throw new Error(`Unmocked fetcher call: ${url}`);
  });
}

describe('brapi://server/info resource', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
    rejectUnmocked(fetcher);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        throw new Error(`Unmocked global fetch: ${String(input)}`);
      }),
    );
  });

  afterEach(() => {
    resetTestServices();
    vi.unstubAllGlobals();
  });

  it('carries the same nextToolSuggestions as brapi_connect', async () => {
    const { ctx, connected } = await connect(fetcher);
    const result = (await brapiServerInfoResource.handler({}, ctx)) as {
      nextToolSuggestions: unknown;
    };
    expect(connected.nextToolSuggestions).toEqual([
      {
        toolName: 'brapi_find_studies',
        reason: 'The server exposes studies; start here to find study DbIds.',
        args: { alias: 'default' },
      },
    ]);
    expect(result.nextToolSuggestions).toEqual(connected.nextToolSuggestions);
    // The resource's content is the JSON serialization of this same object.
    expect(JSON.stringify(result)).toContain('"toolName":"brapi_find_studies"');
  });

  it('returns the orientation envelope for the default connection', async () => {
    const { ctx } = await connect(fetcher);
    const result = (await brapiServerInfoResource.handler({}, ctx)) as {
      alias: string;
      baseUrl: string;
    };
    expect(result.alias).toBe('default');
    expect(result.baseUrl).toBe(BASE_URL);
  });

  it('throws NotFound with unknown_alias recovery hint when no connection is registered', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: brapiServerInfoResource.errors });
    await expect(brapiServerInfoResource.handler({}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'unknown_alias',
        recovery: { hint: expect.stringContaining('brapi_connect') },
      },
    });
  });

  it('list() advertises the resource for discovery', async () => {
    const listing = await brapiServerInfoResource.list!({} as never);
    expect(listing.resources.length).toBe(1);
    expect(listing.resources[0]?.uri).toBe('brapi://server/info');
  });
});
