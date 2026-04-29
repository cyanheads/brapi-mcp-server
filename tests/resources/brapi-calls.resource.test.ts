/**
 * @fileoverview Tests for `brapi://calls` — direct read against the
 * CapabilityRegistry profile for the default connection.
 *
 * @module tests/resources/brapi-calls.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brapiCallsResource } from '@/mcp-server/resources/definitions/brapi-calls.resource.js';
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
          serverName: 'Test',
          calls: [
            { service: 'studies', methods: ['GET'], versions: ['2.1'] },
            { service: 'germplasm', methods: ['GET'], versions: ['2.1'] },
          ],
        }),
      );
    }
    if (path.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: ['Yam'] }));
    return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
  });
  const ctx = createMockContext({ tenantId: 't1' });
  await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
  fetcher.mockReset();
  return ctx;
}

describe('brapi://calls resource', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('returns the cached capability profile', async () => {
    const ctx = await connect(fetcher);
    const result = (await brapiCallsResource.handler({}, ctx)) as {
      alias: string;
      baseUrl: string;
      crops: string[];
      supported: Record<string, unknown>;
    };
    expect(result.alias).toBe('default');
    expect(result.baseUrl).toBe(BASE_URL);
    expect(result.crops).toEqual(['Yam']);
    expect(result.supported.studies).toBeDefined();
    expect(result.supported.germplasm).toBeDefined();
  });

  it('throws NotFound when no connection is registered', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    await expect(brapiCallsResource.handler({}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('list() advertises the resource for discovery', async () => {
    const listing = await brapiCallsResource.list!({} as never);
    expect(listing.resources[0]?.uri).toBe('brapi://calls');
  });
});
