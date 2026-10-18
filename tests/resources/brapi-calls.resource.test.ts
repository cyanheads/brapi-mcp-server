/**
 * @fileoverview Tests for `brapi://calls` — direct read against the
 * CapabilityRegistry profile for the default connection.
 *
 * @module tests/resources/brapi-calls.resource.test
 */

import { JsonRpcErrorCode, serviceUnavailable, unauthorized } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { readResourceError } from './_resource-factory.js';

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
    // A developer-set default server would connect `default` on first use.
    vi.stubEnv('BRAPI_DEFAULT_BASE_URL', '');
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

  it('connects the configured default server on first read, with no brapi_connect', async () => {
    vi.stubEnv('BRAPI_DEFAULT_BASE_URL', BASE_URL);
    fetcher.mockImplementation(async (url: string) => {
      const { hostname, pathname } = new URL(String(url));
      if (hostname !== new URL(BASE_URL).hostname) throw new Error(`Unmocked fetcher call: ${url}`);
      if (pathname.endsWith('/serverinfo')) {
        return jsonResponse(
          envelope({ calls: [{ service: 'studies', methods: ['GET'], versions: ['2.1'] }] }),
        );
      }
      if (pathname.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: ['Yam'] }));
      throw new Error(`Unexpected path: ${url}`);
    });
    const ctx = createMockContext({ tenantId: 't1', errors: brapiCallsResource.errors });

    const result = (await brapiCallsResource.handler({}, ctx)) as {
      alias: string;
      baseUrl: string;
      supported: Record<string, unknown>;
    };

    expect(result).toMatchObject({ alias: 'default', baseUrl: BASE_URL });
    expect(Object.keys(result.supported)).toEqual(['studies']);
    expect(await ctx.state.get('brapi/conn/default')).toMatchObject({ baseUrl: BASE_URL });
  });

  /*
   * First-use registration itself is tabled at its seam (find-helpers'
   * requireRegisteredConnection tests); these pin the hint this resource's
   * own contract fills for each failure.
   */
  it.each([
    {
      reason: 'unknown_alias',
      defaultBaseUrl: '',
      upstream: undefined,
      code: JsonRpcErrorCode.NotFound,
      hint: 'brapi_connect',
    },
    {
      reason: 'capability_discovery_unavailable',
      defaultBaseUrl: BASE_URL,
      upstream: () => serviceUnavailable('Fetch failed. Status: 503', { status: 503 }),
      code: JsonRpcErrorCode.ServiceUnavailable,
      hint: 'Read this resource again in a minute',
    },
    {
      reason: 'upstream_unauthorized',
      defaultBaseUrl: BASE_URL,
      upstream: () => unauthorized('Fetch failed. Status: 401', { status: 401 }),
      code: JsonRpcErrorCode.Unauthorized,
      hint: 'then read this resource again',
    },
    {
      reason: 'alias_base_url_invalid',
      defaultBaseUrl: 'ftp://brapi.example/v2',
      upstream: undefined,
      code: JsonRpcErrorCode.ConfigurationError,
      hint: 'BRAPI_DEFAULT_BASE_URL',
    },
  ])('fills the $reason recovery hint on the wire', async (c) => {
    vi.stubEnv('BRAPI_DEFAULT_BASE_URL', c.defaultBaseUrl);
    fetcher.mockImplementation(async (url: string) => {
      if (!c.upstream || new URL(String(url)).hostname !== new URL(BASE_URL).hostname) {
        throw new Error(`Unmocked fetcher call: ${url}`);
      }
      throw c.upstream();
    });

    await expect(readResourceError(brapiCallsResource, 'brapi://calls')).resolves.toMatchObject({
      code: c.code,
      data: { reason: c.reason, recovery: { hint: expect.stringContaining(c.hint) } },
    });
    // Without an upstream failure to reach, the read fails before any request.
    if (!c.upstream) expect(fetcher).not.toHaveBeenCalled();
  });

  it('list() advertises the resource for discovery', async () => {
    const listing = await brapiCallsResource.list!({} as never);
    expect(listing.resources[0]?.uri).toBe('brapi://calls');
  });
});
