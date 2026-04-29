/**
 * @fileoverview End-to-end tests for `brapi_submit_observations` —
 * preview/apply mode, POST/PUT routing, elicit gate, force flag, capability
 * gating, per-row warnings.
 *
 * @module tests/tools/brapi-submit-observations.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiSubmitObservations } from '@/mcp-server/tools/definitions/brapi-submit-observations.tool.js';
import {
  BASE_URL,
  envelope,
  initTestServices,
  jsonResponse,
  type MockFetcher,
  pathnameOf,
  resetTestServices,
} from './_tool-test-helpers.js';

interface ConnectOptions {
  ctxOptions?: Parameters<typeof createMockContext>[0];
  methods?: ('GET' | 'POST' | 'PUT')[];
}

async function connect(fetcher: MockFetcher, options: ConnectOptions = {}) {
  const methods = options.methods ?? ['GET', 'POST', 'PUT'];
  fetcher.mockImplementation(async (url: string) => {
    const path = pathnameOf(url);
    if (path.endsWith('/serverinfo')) {
      return jsonResponse(
        envelope({
          serverName: 'Test',
          calls: [
            { service: 'observations', methods, versions: ['2.1'] },
            { service: 'studies', methods: ['GET'], versions: ['2.1'] },
          ],
        }),
      );
    }
    if (path.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: [] }));
    return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
  });
  const ctx = createMockContext({
    tenantId: 't1',
    errors: brapiSubmitObservations.errors,
    ...(options.ctxOptions ?? {}),
  });
  await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
  fetcher.mockReset();
  return ctx;
}

function setupReadCalls(
  fetcher: MockFetcher,
  options: { variables?: string[]; studyName?: string; studyObservationCount?: number } = {},
) {
  fetcher.mockImplementation(async (url: string, _t, _c, init: RequestInit) => {
    const path = pathnameOf(url);
    const u = new URL(String(url));
    if (path.endsWith('/observationvariables')) {
      const data = (options.variables ?? ['var-1', 'var-2']).map((id) => ({
        observationVariableDbId: id,
      }));
      return jsonResponse(envelope({ data }, { totalCount: data.length }));
    }
    if (path.endsWith('/studies/study-1') && (init?.method ?? 'GET') === 'GET') {
      return jsonResponse(envelope({ studyDbId: 'study-1', studyName: options.studyName ?? 'S' }));
    }
    if (path.endsWith('/studies/study-1/observations') && u.searchParams.get('pageSize') === '0') {
      return jsonResponse(
        envelope({ data: [] }, { totalCount: options.studyObservationCount ?? 99 }),
      );
    }
    if (path.endsWith('/observations') && (init?.method ?? 'GET') === 'POST') {
      const body = JSON.parse(init.body as string) as Array<Record<string, unknown>>;
      return jsonResponse(
        envelope({
          data: body.map((row, i) => ({
            ...row,
            observationDbId: `new-${i + 1}`,
          })),
        }),
      );
    }
    if (path.endsWith('/observations') && (init?.method ?? 'GET') === 'PUT') {
      const body = JSON.parse(init.body as string) as Record<string, Record<string, unknown>>;
      return jsonResponse(
        envelope({
          data: Object.entries(body).map(([id, row]) => ({ ...row, observationDbId: id })),
        }),
      );
    }
    throw new Error(`Unexpected path: ${path} (${init?.method ?? 'GET'})`);
  });
}

describe('brapi_submit_observations tool', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('preview returns valid/invalid counts and POST/PUT routing without writing', async () => {
    const ctx = await connect(fetcher);
    setupReadCalls(fetcher);

    const result = await brapiSubmitObservations.handler(
      brapiSubmitObservations.input.parse({
        studyDbId: 'study-1',
        observations: [
          { observationUnitDbId: 'ou-1', observationVariableDbId: 'var-1', value: '12.3' },
          {
            observationDbId: 'obs-existing',
            observationUnitDbId: 'ou-1',
            observationVariableDbId: 'var-2',
            value: '14.1',
          },
        ],
      }),
      ctx,
    );

    expect(result.result.mode).toBe('preview');
    if (result.result.mode === 'preview') {
      expect(result.result.valid).toBe(2);
      expect(result.result.invalid).toBe(0);
      expect(result.result.routing).toEqual({ postCount: 1, putCount: 1 });
      expect(result.result.knownVariableCount).toBe(2);
    }
    // No POST/PUT issued in preview mode.
    expect(
      fetcher.mock.calls.some((c) => {
        const init = c[3] as RequestInit | undefined;
        return init?.method === 'POST' || init?.method === 'PUT';
      }),
    ).toBe(false);
  });

  it('preview emits a per-row warning when a variable is not exposed by the study', async () => {
    const ctx = await connect(fetcher);
    setupReadCalls(fetcher, { variables: ['var-1'] });

    const result = await brapiSubmitObservations.handler(
      brapiSubmitObservations.input.parse({
        studyDbId: 'study-1',
        observations: [
          { observationUnitDbId: 'ou-1', observationVariableDbId: 'var-unknown', value: '1' },
        ],
      }),
      ctx,
    );

    expect(result.result.mode).toBe('preview');
    if (result.result.mode === 'preview') {
      expect(result.result.perRowWarnings.some((w) => w.warning.includes('var-unknown'))).toBe(
        true,
      );
    }
  });

  it('apply with elicit confirmation POSTs new and PUTs existing rows in parallel', async () => {
    const elicit = vi.fn(async () => ({ action: 'accept' as const, data: { confirm: true } }));
    const ctx = await connect(fetcher, { ctxOptions: { tenantId: 't1', elicit } });
    setupReadCalls(fetcher, { studyName: 'Cassava 2022', studyObservationCount: 412 });

    const result = await brapiSubmitObservations.handler(
      brapiSubmitObservations.input.parse({
        studyDbId: 'study-1',
        mode: 'apply',
        observations: [
          {
            observationUnitDbId: 'ou-1',
            observationVariableDbId: 'var-1',
            value: '12.3',
            observationTimeStamp: '2026-04-01T10:00:00Z',
          },
          {
            observationDbId: 'obs-existing',
            observationUnitDbId: 'ou-1',
            observationVariableDbId: 'var-2',
            value: '14.1',
            observationTimeStamp: '2026-04-02T10:00:00Z',
          },
        ],
      }),
      ctx,
    );

    expect(elicit).toHaveBeenCalledTimes(1);
    expect(result.result.mode).toBe('apply');
    if (result.result.mode === 'apply') {
      expect(result.result.posted).toHaveLength(1);
      expect(result.result.updated).toHaveLength(1);
      expect(result.result.updated[0]?.observationDbId).toBe('obs-existing');
      expect(result.result.studyObservationCount).toBe(412);
      expect(result.result.latestObservationTimestamp).toBe('2026-04-02T10:00:00Z');
      expect(result.result.studyName).toBe('Cassava 2022');
    }
  });

  it('apply throws Forbidden when the user rejects the elicit prompt', async () => {
    const elicit = vi.fn(async () => ({ action: 'decline' as const }));
    const ctx = await connect(fetcher, { ctxOptions: { tenantId: 't1', elicit } });
    setupReadCalls(fetcher);

    await expect(
      brapiSubmitObservations.handler(
        brapiSubmitObservations.input.parse({
          studyDbId: 'study-1',
          mode: 'apply',
          observations: [
            { observationUnitDbId: 'ou-1', observationVariableDbId: 'var-1', value: '1' },
          ],
        }),
        ctx,
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.Forbidden });
  });

  it('apply without elicit support and without force flag throws Forbidden', async () => {
    // ctx with no elicit callback at all
    const ctx = await connect(fetcher);
    setupReadCalls(fetcher);

    await expect(
      brapiSubmitObservations.handler(
        brapiSubmitObservations.input.parse({
          studyDbId: 'study-1',
          mode: 'apply',
          observations: [
            { observationUnitDbId: 'ou-1', observationVariableDbId: 'var-1', value: '1' },
          ],
        }),
        ctx,
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.Forbidden });
  });

  it('apply with force=true writes when ctx.elicit is unavailable', async () => {
    const ctx = await connect(fetcher);
    setupReadCalls(fetcher);

    const result = await brapiSubmitObservations.handler(
      brapiSubmitObservations.input.parse({
        studyDbId: 'study-1',
        mode: 'apply',
        force: true,
        observations: [
          { observationUnitDbId: 'ou-1', observationVariableDbId: 'var-1', value: '1' },
        ],
      }),
      ctx,
    );

    expect(result.result.mode).toBe('apply');
    if (result.result.mode === 'apply') {
      expect(result.result.posted).toHaveLength(1);
    }
  });

  it('apply throws ValidationError when POST is needed but server lacks the method', async () => {
    const ctx = await connect(fetcher, { methods: ['GET', 'PUT'] });
    setupReadCalls(fetcher);

    await expect(
      brapiSubmitObservations.handler(
        brapiSubmitObservations.input.parse({
          studyDbId: 'study-1',
          mode: 'apply',
          force: true,
          observations: [
            { observationUnitDbId: 'ou-1', observationVariableDbId: 'var-1', value: '1' },
          ],
        }),
        ctx,
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
  });

  it('throws ValidationError when /observations is not advertised at all', async () => {
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
    const ctx = createMockContext({ tenantId: 't1', errors: brapiSubmitObservations.errors });
    await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
    fetcher.mockReset();

    await expect(
      brapiSubmitObservations.handler(
        brapiSubmitObservations.input.parse({
          studyDbId: 'study-1',
          observations: [
            { observationUnitDbId: 'ou-1', observationVariableDbId: 'var-1', value: '1' },
          ],
        }),
        ctx,
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
  });

  it('format() renders preview / apply branches with their key fields', async () => {
    const ctx = await connect(fetcher);
    setupReadCalls(fetcher);
    const previewResult = await brapiSubmitObservations.handler(
      brapiSubmitObservations.input.parse({
        studyDbId: 'study-1',
        observations: [
          { observationUnitDbId: 'ou-1', observationVariableDbId: 'var-1', value: '12.3' },
        ],
      }),
      ctx,
    );
    const previewText = (brapiSubmitObservations.format!(previewResult)[0] as { text: string })
      .text;
    expect(previewText).toContain('Preview');
    expect(previewText).toContain('study-1');
    expect(previewText).toContain('valid: 1');
  });
});
