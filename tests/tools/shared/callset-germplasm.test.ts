/**
 * @fileoverview Tests for `resolveCallSetGermplasm`, called directly: caller
 * cancellation inside the `/callsets` walk or the sample search rejects at
 * once instead of degrading to a warning, and stops the lookups that follow.
 *
 * @module tests/tools/shared/callset-germplasm.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveCallSetGermplasm } from '@/mcp-server/tools/shared/callset-germplasm.js';
import { getBrapiClient } from '@/services/brapi-client/index.js';
import { specDialect } from '@/services/brapi-dialect/index.js';
import type { RegisteredServer } from '@/services/server-registry/index.js';
import {
  BASE_URL,
  envelope,
  initTestServices,
  jsonResponse,
  type MockFetcher,
  pathnameOf,
  resetTestServices,
} from '../_tool-test-helpers.js';

const CONNECTION: RegisteredServer = {
  alias: 'default',
  authMode: 'none',
  baseUrl: BASE_URL,
  registeredAt: '2026-01-01T00:00:00.000Z',
};

/** Twelve sample-backed call sets: two `/callsets` pages at the test page size of 10. */
const CALL_SETS = Array.from({ length: 12 }, (_, i) => ({
  callSetDbId: `cs${i}`,
  sampleDbId: `s${i}`,
}));

describe('resolveCallSetGermplasm caller cancellation', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  const resolve = (signal: AbortSignal) =>
    resolveCallSetGermplasm({
      callSets: CALL_SETS,
      client: getBrapiClient(),
      connection: CONNECTION,
      ctx: createMockContext({ signal }),
      dialect: specDialect,
      supported: {
        callsets: { service: 'callsets', methods: ['GET'] },
        'search/samples': { service: 'search/samples', methods: ['POST'] },
      },
      variantSetDbId: 'vset-1',
    });

  const requestsTo = (suffix: string) =>
    fetcher.mock.calls.filter(([url]) => pathnameOf(url).endsWith(suffix));

  const callSetPage = (url: URL) => {
    const page = Number(url.searchParams.get('page'));
    return jsonResponse(envelope({ data: CALL_SETS.slice(page * 10, page * 10 + 10) }));
  };

  it('rejects when the caller aborts the /callsets walk, sending no sample search', async () => {
    const controller = new AbortController();
    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/callsets')) {
        // Page 0 lists ten sample-backed call sets; the caller aborts during page 1.
        if (u.searchParams.get('page') === '0') return callSetPage(u);
        controller.abort();
        throw controller.signal.reason;
      }
      return jsonResponse(envelope({ data: [] }));
    });

    await expect(resolve(controller.signal)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
    });
    expect(requestsTo('/callsets')).toHaveLength(2);
    expect(requestsTo('/search/samples')).toHaveLength(0);
  });

  it('rejects when the caller aborts the sample search', async () => {
    const controller = new AbortController();
    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/callsets')) return callSetPage(u);
      controller.abort();
      throw controller.signal.reason;
    });

    await expect(resolve(controller.signal)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
    });
    expect(requestsTo('/search/samples')).toHaveLength(1);
  });
});
