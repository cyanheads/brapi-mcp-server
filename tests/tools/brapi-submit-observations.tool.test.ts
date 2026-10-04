/**
 * @fileoverview End-to-end tests for `brapi_submit_observations` —
 * preview/apply mode, POST/PUT routing, the confirmation round trip, force
 * flag, capability gating, per-row warnings.
 *
 * @module tests/tools/brapi-submit-observations.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, expectInputRequired } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    if (path.endsWith('/variables')) {
      const data = (options.variables ?? ['var-1', 'var-2']).map((id) => ({
        observationVariableDbId: id,
      }));
      return jsonResponse(envelope({ data }, { totalCount: data.length }));
    }
    if (path.endsWith('/studies/study-1') && (init?.method ?? 'GET') === 'GET') {
      return jsonResponse(envelope({ studyDbId: 'study-1', studyName: options.studyName ?? 'S' }));
    }
    if (
      path.endsWith('/observations') &&
      (init?.method ?? 'GET') === 'GET' &&
      u.searchParams.get('pageSize') === '1'
    ) {
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

/** HTTP methods of every write the fetcher was asked to issue. */
function writeMethods(fetcher: MockFetcher): string[] {
  return fetcher.mock.calls
    .map((c) => (c[3] as RequestInit | undefined)?.method)
    .filter((m): m is string => m === 'POST' || m === 'PUT');
}

/** `ctx.state` key of a consent record minted by the confirmation round. */
const consentKey = (id: string) => `brapi/consent/${id}`;

const ACCEPT = { confirm: { action: 'accept', content: { confirm: true } } };

/** Apply-mode input: one new row and one update row against `study-1`. */
function applyInput(overrides: { value?: string } = {}) {
  return brapiSubmitObservations.input.parse({
    studyDbId: 'study-1',
    mode: 'apply',
    observations: [
      {
        observationUnitDbId: 'ou-1',
        observationVariableDbId: 'var-1',
        value: overrides.value ?? '12.3',
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
  });
}

/** Concatenated text of the tool's `content[]` surface. */
function renderText(result: Parameters<NonNullable<typeof brapiSubmitObservations.format>>[0]) {
  return (brapiSubmitObservations.format?.(result) ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
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

  it('apply without a prior answer asks for confirmation and writes nothing', async () => {
    const ctx = await connect(fetcher);
    setupReadCalls(fetcher);

    const asked = await expectInputRequired(() =>
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
    );

    expect(asked.inputRequests?.confirm).toMatchObject({ method: 'elicitation/create' });
    expect(writeMethods(fetcher)).toEqual([]);
  });

  /**
   * Round one of the confirmation flow: asks, and returns the `requestState`
   * plus the consent record round one stored under it.
   */
  async function askForConsent(input: ReturnType<typeof applyInput>) {
    const first = await connect(fetcher);
    setupReadCalls(fetcher);
    const asked = await expectInputRequired(() => brapiSubmitObservations.handler(input, first));
    expect(writeMethods(fetcher)).toEqual([]);
    const requestState = asked.requestState as string;
    expect(typeof requestState).toBe('string');
    const record = await first.state.get<Record<string, unknown>>(consentKey(requestState));
    expect(record).not.toBeNull();
    return { requestState, record: record as Record<string, unknown> };
  }

  /**
   * Round-two context: each mock context has its own storage, so the record
   * round one stored is copied in (or omitted, to model an unasked answer).
   */
  async function answeringContext(
    requestState: string | undefined,
    record: Record<string, unknown> | undefined,
    inputResponses: Record<string, unknown> = ACCEPT,
    readOptions: Parameters<typeof setupReadCalls>[1] = {},
  ) {
    const ctx = await connect(fetcher, {
      ctxOptions: {
        tenantId: 't1',
        inputResponses,
        ...(requestState !== undefined ? { requestState } : {}),
      },
    });
    if (requestState !== undefined && record) await ctx.state.set(consentKey(requestState), record);
    setupReadCalls(fetcher, readOptions);
    return ctx;
  }

  it('apply with a confirmed consent record POSTs new and PUTs existing rows in parallel', async () => {
    const { requestState, record } = await askForConsent(applyInput());
    const ctx = await answeringContext(requestState, record, ACCEPT, {
      studyName: 'Cassava 2022',
      studyObservationCount: 412,
    });

    const result = await brapiSubmitObservations.handler(applyInput(), ctx);

    expect(result.result.mode).toBe('apply');
    if (result.result.mode === 'apply') {
      expect(result.result.posted).toHaveLength(1);
      expect(result.result.updated).toHaveLength(1);
      expect(result.result.updated[0]?.observationDbId).toBe('obs-existing');
      expect(result.result.studyObservationCount).toBe(412);
      expect(result.result.latestObservationTimestamp).toBe('2026-04-02T10:00:00Z');
      expect(result.result.studyName).toBe('Cassava 2022');
    }
    expect(writeMethods(fetcher).sort()).toEqual(['POST', 'PUT']);

    const text = renderText(result);
    expect(text).toContain('Cassava 2022');
    expect(text).toContain('- posted: 1');
    expect(text).toContain('- updated: 1');
    expect(text).toContain('obs-existing');
    expect(text).toContain('- studyObservationCount: 412');
    expect(text).toContain('- latestObservationTimestamp: 2026-04-02T10:00:00Z');
  });

  it.each([
    ['confirm: false', { action: 'accept', content: { confirm: false } }],
    ['a declined prompt', { action: 'decline' }],
    ['a cancelled prompt', { action: 'cancel' }],
    ['an unparseable answer', { action: 'accept', content: { confirm: 'yes' } }],
  ])('apply fails with user_declined on %s and writes nothing', async (_label, response) => {
    const { requestState, record } = await askForConsent(applyInput());
    const ctx = await answeringContext(requestState, record, { confirm: response });

    await expect(brapiSubmitObservations.handler(applyInput(), ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: { reason: 'user_declined', studyDbId: 'study-1' },
    });
    expect(writeMethods(fetcher)).toEqual([]);
  });

  describe('consent gate', () => {
    it('re-asks when a pre-answered confirm has no redeemable record', async () => {
      const ctx = await answeringContext(undefined, undefined);

      const asked = await expectInputRequired(() =>
        brapiSubmitObservations.handler(applyInput(), ctx),
      );

      expect(asked.inputRequests?.confirm).toMatchObject({ method: 'elicitation/create' });
      expect(writeMethods(fetcher)).toEqual([]);
    });

    it('re-asks when the requestState names no stored record', async () => {
      const ctx = await answeringContext('00000000-0000-4000-8000-000000000000', undefined);

      await expectInputRequired(() => brapiSubmitObservations.handler(applyInput(), ctx));
      expect(writeMethods(fetcher)).toEqual([]);
    });

    it('re-asks when the rows differ from the ones the user confirmed', async () => {
      const { requestState, record } = await askForConsent(applyInput());
      const ctx = await answeringContext(requestState, record);

      await expectInputRequired(() =>
        brapiSubmitObservations.handler(applyInput({ value: '99.9' }), ctx),
      );
      expect(writeMethods(fetcher)).toEqual([]);
    });

    it.each([
      ['target', { target: 'https://other.example/brapi/v2#study-1' }],
      ['contentHash', { contentHash: 'not-the-confirmed-rows' }],
      ['operation', { operation: 'some_other_tool' }],
      ['clientId', { clientId: 'another-client' }],
      ['subject', { subject: 'another-user' }],
    ])('re-asks when the record names a different %s', async (_field, mutation) => {
      const { requestState, record } = await askForConsent(applyInput());
      const ctx = await answeringContext(requestState, { ...record, ...mutation });

      await expectInputRequired(() => brapiSubmitObservations.handler(applyInput(), ctx));
      expect(writeMethods(fetcher)).toEqual([]);
    });

    it('spends the record: replaying the same requestState asks again', async () => {
      const { requestState, record } = await askForConsent(applyInput());
      const ctx = await answeringContext(requestState, record);

      await brapiSubmitObservations.handler(applyInput(), ctx);
      expect(writeMethods(fetcher).sort()).toEqual(['POST', 'PUT']);
      expect(await ctx.state.get(consentKey(requestState))).toBeNull();

      fetcher.mockClear();
      await expectInputRequired(() => brapiSubmitObservations.handler(applyInput(), ctx));
      expect(writeMethods(fetcher)).toEqual([]);
    });

    it('preview mode ignores a pre-answered confirm and writes nothing', async () => {
      const ctx = await answeringContext(undefined, undefined);

      const result = await brapiSubmitObservations.handler(
        brapiSubmitObservations.input.parse({ ...applyInput(), mode: 'preview' }),
        ctx,
      );

      expect(result.result.mode).toBe('preview');
      expect(writeMethods(fetcher)).toEqual([]);
    });
  });

  it('apply with force=true writes without a confirmation round', async () => {
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
    expect(writeMethods(fetcher)).toEqual(['POST']);
    expect(renderText(result)).toContain('- posted: 1');
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
