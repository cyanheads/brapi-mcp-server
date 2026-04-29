/**
 * @fileoverview Tests for `brapi://server/info` — wraps the server-info tool;
 * exercises the same orientation envelope through the resource surface.
 *
 * @module tests/resources/brapi-server-info.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
  fetcher.mockReset();
  return ctx;
}

describe('brapi://server/info resource', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('returns the orientation envelope for the default connection', async () => {
    const ctx = await connect(fetcher);
    const result = (await brapiServerInfoResource.handler({}, ctx)) as {
      alias: string;
      baseUrl: string;
    };
    expect(result.alias).toBe('default');
    expect(result.baseUrl).toBe(BASE_URL);
  });

  it('throws NotFound when no connection is registered', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    await expect(brapiServerInfoResource.handler({}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('list() advertises the resource for discovery', async () => {
    const listing = await brapiServerInfoResource.list!({} as never);
    expect(listing.resources.length).toBe(1);
    expect(listing.resources[0]?.uri).toBe('brapi://server/info');
  });
});
