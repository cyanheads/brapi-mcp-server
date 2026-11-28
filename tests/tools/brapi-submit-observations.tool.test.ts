/**
 * @fileoverview End-to-end tests for `brapi_submit_observations` —
 * preview/apply mode, POST/PUT routing, the confirmation round trip, force
 * flag, capability gating, per-row warnings.
 *
 * @module tests/tools/brapi-submit-observations.tool.test
 */

import { JsonRpcErrorCode, McpError, timeout } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, expectInputRequired } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
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
  stalledResponse,
} from './_tool-test-helpers.js';

interface ConnectOptions {
  ctxOptions?: Parameters<typeof createMockContext>[0];
  methods?: ('GET' | 'POST' | 'PUT')[];
  /** `serverInfo.serverName`, which selects the dialect. Defaults to the `spec` passthrough. */
  serverName?: string;
  units?: boolean;
}

async function connect(fetcher: MockFetcher, options: ConnectOptions = {}) {
  const methods = options.methods ?? ['GET', 'POST', 'PUT'];
  fetcher.mockImplementation(async (url: string) => {
    const path = pathnameOf(url);
    if (path.endsWith('/serverinfo')) {
      return jsonResponse(
        envelope({
          serverName: options.serverName ?? 'Test',
          calls: [
            { service: 'observations', methods, versions: ['2.1'] },
            { service: 'studies', methods: ['GET'], versions: ['2.1'] },
            ...(options.units
              ? [{ service: 'observationunits', methods: ['GET'], versions: ['2.1'] }]
              : []),
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
      // The study-scoped count answers the study's total; the unfiltered
      // baseline answers a larger server-wide one.
      const scoped = u.searchParams.has('studyDbIds') || u.searchParams.has('studyDbId');
      return jsonResponse(
        envelope(
          { data: [] },
          { totalCount: scoped ? (options.studyObservationCount ?? 99) : 100_000 },
        ),
      );
    }
    if (path.endsWith('/observations') && (init?.method ?? 'GET') === 'GET') {
      return jsonResponse(
        envelope(
          { data: [{ observationDbId: 'obs-existing', studyDbId: 'study-1' }] },
          { totalCount: 1 },
        ),
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

  it.each([true, false])(
    'checks study membership only to the extent the source proves it (complete=%s)',
    async (complete) => {
      const ctx = await connect(fetcher, { units: true });
      const studyDbId = 'study-1';
      const variables = [
        {
          observationVariableDbId: 'yield',
          scale: { dataType: 'Numerical', validValues: { minimumValue: 0, maximumValue: 2 } },
        },
        {
          observationVariableDbId: 'class',
          scale: {
            dataType: 'Code',
            validValues: { categories: [{ value: 'A', label: 'A class' }] },
          },
        },
        { observationVariableDbId: 'date', scale: { dataType: 'Date', dateFormat: 'YYYY-MM-DD' } },
      ];
      fetcher.mockImplementation(async (url: string) => {
        const path = pathnameOf(url);
        if (path.endsWith('/studies/study-1')) return jsonResponse(envelope({ studyDbId }));
        if (path.endsWith('/variables'))
          return jsonResponse(envelope({ data: variables }, { totalCount: 3 }));
        const data = path.endsWith('/observationunits')
          ? [{ studyDbId, observationUnitDbId: 'plot' }]
          : [{ studyDbId, observationDbId: 'obs' }];
        return jsonResponse(envelope({ data }, { totalCount: complete ? 1 : 10 }));
      });
      const input = brapiSubmitObservations.input.parse({
        studyDbId,
        observations: [
          {
            observationUnitDbId: 'missing',
            observationVariableDbId: 'yield',
            value: '-1',
            observationDbId: 'unknown',
          },
          { observationUnitDbId: 'plot', observationVariableDbId: 'class', value: 'B' },
          { observationUnitDbId: 'plot', observationVariableDbId: 'date', value: '2026-02-30' },
          { observationUnitDbId: 'plot', observationVariableDbId: 'yield', value: '2' },
          { observationUnitDbId: 'plot', observationVariableDbId: 'yield', value: 'abc' },
        ],
      });
      const output = await brapiSubmitObservations.handler(input, ctx);
      expect(output.result).toMatchObject({ mode: 'preview', valid: 5, invalid: 0, flagged: 4 });
      expect(output.result.perRowWarnings.filter((w) => w.rowIndex === 0)).toHaveLength(
        complete ? 3 : 1,
      );
      expect(output.result.perRowWarnings.map((w) => w.rowIndex)).toContain(4);
      expect(renderText(output)).toContain('flagged: 4');
      if (!complete) expect(renderText(output)).toMatch(/incomplete|partial/i);
      const asked = await expectInputRequired(() =>
        brapiSubmitObservations.handler({ ...input, mode: 'apply' }, ctx),
      );
      expect(JSON.stringify(asked.inputRequests)).toContain('4 flagged');
      expect(writeMethods(fetcher)).toEqual([]);
    },
  );

  it.each([200, 400])(
    'keeps preview and confirmation available when the advisory variable GET returns %i without an envelope',
    async (status) => {
      const ctx = await connect(fetcher);
      fetcher.mockImplementation(async (url: string) => {
        if (pathnameOf(url).endsWith('/variables')) {
          if (status === 400)
            throw new McpError(JsonRpcErrorCode.ValidationError, 'HTTP 400', { status });
          return new Response(null, { status });
        }
        return jsonResponse(envelope({ studyDbId: 'study-1' }));
      });
      const input = brapiSubmitObservations.input.parse({
        studyDbId: 'study-1',
        observations: [
          { observationUnitDbId: 'plot', observationVariableDbId: 'yield', value: '42' },
        ],
      });
      const preview = await brapiSubmitObservations.handler(input, ctx);
      expect(preview.result).toMatchObject({
        mode: 'preview',
        valid: 1,
        flagged: 0,
        warnings: expect.arrayContaining([expect.stringContaining('/variables')]),
      });
      await expectInputRequired(() =>
        brapiSubmitObservations.handler({ ...input, mode: 'apply' }, ctx),
      );
      expect(writeMethods(fetcher)).toEqual([]);
    },
  );

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

describe('brapi_submit_observations study variable review (#122)', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  const STUDY_VARIABLES = ['var-1', 'var-2'];
  const SERVER_VARIABLES = ['var-1', 'var-2', 'var-other'];

  /**
   * GET /variables narrows to the study's variables only for the v2.1 GET key
   * `studyDbId`; any other query (the plural included) gets the server-wide
   * list, as SGN servers answer. Records every requested URL in `calls`.
   */
  function serveStudyScopedVariables(calls: URL[], honorsStudy = true) {
    fetcher.mockImplementation(async (url: string) => {
      const u = new URL(String(url));
      calls.push(u);
      if (u.pathname.endsWith('/studies/study-1'))
        return jsonResponse(envelope({ studyDbId: 'study-1' }));
      if (u.pathname.endsWith('/variables')) {
        const ids =
          honorsStudy && u.searchParams.get('studyDbId') === 'study-1'
            ? STUDY_VARIABLES
            : SERVER_VARIABLES;
        const data = ids.map((observationVariableDbId) => ({ observationVariableDbId }));
        return jsonResponse(envelope({ data }, { totalCount: data.length }));
      }
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });
  }

  function previewInput(variableIds: string[]) {
    return brapiSubmitObservations.input.parse({
      studyDbId: 'study-1',
      observations: variableIds.map((observationVariableDbId) => ({
        observationUnitDbId: 'ou-1',
        observationVariableDbId,
        value: '1',
      })),
    });
  }

  it("flags a variable outside the study and counts only the study's variables", async () => {
    const ctx = await connect(fetcher, { serverName: 'Breedbase' });
    serveStudyScopedVariables([]);

    const output = await brapiSubmitObservations.handler(previewInput(['var-1', 'var-other']), ctx);

    expect(output.result).toMatchObject({ mode: 'preview', flagged: 1, knownVariableCount: 2 });
    expect(output.result.perRowWarnings).toEqual([
      expect.objectContaining({
        rowIndex: 1,
        observationVariableDbId: 'var-other',
        warning: expect.stringContaining("'var-other' is not exposed by study 'study-1'"),
      }),
    ]);
    const text = renderText(output);
    expect(text).toContain('knownVariableCount: 2');
    expect(text).toContain('is not exposed by study');
  });

  it.each([
    ['spec', 'Test', 'studyDbIds'],
    ['cassavabase', 'Cassavabase', 'studyDbId'],
    ['breedbase', 'Breedbase', 'studyDbId'],
    ['bms', 'BMS', 'studyDbId'],
  ])(
    'scopes /variables by studyDbId under the %s dialect; /observationunits keeps the dialect key',
    async (_dialect, serverName, unitKey) => {
      const ctx = await connect(fetcher, { serverName, units: true });
      const calls: URL[] = [];
      serveStudyScopedVariables(calls);

      await brapiSubmitObservations.handler(previewInput(['var-1']), ctx);

      const variables = calls.filter((u) => u.pathname.endsWith('/variables'));
      expect(variables).toHaveLength(1);
      expect(variables[0]!.searchParams.getAll('studyDbId')).toEqual(['study-1']);
      expect(variables[0]!.searchParams.has('studyDbIds')).toBe(false);
      const units = calls.filter((u) => u.pathname.endsWith('/observationunits'));
      expect(units).toHaveLength(1);
      expect(units[0]!.searchParams.getAll(unitKey)).toEqual(['study-1']);
    },
  );

  it('keeps preview and confirmation usable when the /variables read outlasts the companion timeout', async () => {
    const ctx = await connect(fetcher, { serverName: 'Breedbase' });
    const variableTimeouts: number[] = [];
    fetcher.mockImplementation(async (url: string, timeoutMs: number) => {
      if (pathnameOf(url).endsWith('/variables')) {
        variableTimeouts.push(timeoutMs);
        // What the fetch layer raises when the upstream outlasts the attempt timeout.
        throw timeout(`Fetch timed out after ${timeoutMs}ms`, { errorSource: 'FetchTimeout' });
      }
      return jsonResponse(envelope({ studyDbId: 'study-1' }));
    });
    const input = previewInput(['var-other']);

    const preview = await brapiSubmitObservations.handler(input, ctx);
    expect(preview.result).toMatchObject({
      mode: 'preview',
      flagged: 0,
      knownVariableCount: 0,
      warnings: expect.arrayContaining([
        'The /variables check could not retrieve the study page. Membership is unverified.',
      ]),
    });
    const asked = await expectInputRequired(() =>
      brapiSubmitObservations.handler({ ...input, mode: 'apply' }, ctx),
    );
    expect(JSON.stringify(asked.inputRequests)).toContain('0 flagged');
    // One attempt per read on the companion budget: no retry stretches the preview.
    const { companionTimeoutMs } = getServerConfig();
    expect(variableTimeouts).toEqual([companionTimeoutMs, companionTimeoutMs]);
    expect(writeMethods(fetcher)).toEqual([]);
  });

  it('skips unverified variable membership in preview and pre-apply review', async () => {
    const ctx = await connect(fetcher, { serverName: 'BrAPI Community Test Server', units: true });
    serveStudyScopedVariables([], false);
    const input = previewInput(['var-other']);
    const preview = await brapiSubmitObservations.handler(input, ctx);
    const warnings = expect.arrayContaining([
      expect.stringMatching(/\/variables.*[Mm]embership is unverified/),
    ]);
    expect(preview.result).toMatchObject({
      mode: 'preview',
      flagged: 1,
      knownVariableCount: 0,
      warnings,
    });
    expect(preview.result.perRowWarnings).toEqual([
      expect.objectContaining({
        warning: expect.stringContaining("observationUnitDbId 'ou-1' is not in study"),
      }),
    ]);
    expect(renderText(preview)).toMatch(/\/variables.*[Mm]embership is unverified/);

    const asked = await expectInputRequired(() =>
      brapiSubmitObservations.handler({ ...input, mode: 'apply' }, ctx),
    );
    expect(JSON.stringify(asked.inputRequests)).toContain('1 flagged');
    const paths = fetcher.mock.calls.map((call) => pathnameOf(String(call[0])));
    expect(paths.filter((path) => path.endsWith('/variables'))).toEqual([]);
    expect(paths.filter((path) => path.endsWith('/observationunits'))).toHaveLength(2);
    expect(writeMethods(fetcher)).toEqual([]);
  });
});

describe('brapi_submit_observations apply studyObservationCount', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  const FORCED_POST = {
    studyDbId: 'study-1',
    mode: 'apply',
    force: true,
    observations: [{ observationUnitDbId: 'ou-1', observationVariableDbId: 'var-1', value: '1' }],
  };

  /**
   * Serves the study, its variables, and the POST echo; every GET /observations
   * count goes to `count`, which sees the request URL.
   */
  function serveApply(
    count: (u: URL, timeoutMs: number, signal?: AbortSignal) => Promise<Response>,
  ) {
    fetcher.mockImplementation(
      async (url: string, timeoutMs: number, _c: unknown, init?: RequestInit) => {
        const u = new URL(String(url));
        const method = init?.method ?? 'GET';
        if (u.pathname.endsWith('/studies/study-1'))
          return jsonResponse(envelope({ studyDbId: 'study-1' }));
        if (u.pathname.endsWith('/variables'))
          return jsonResponse(
            envelope({ data: [{ observationVariableDbId: 'var-1' }] }, { totalCount: 1 }),
          );
        if (u.pathname.endsWith('/observations') && method === 'POST')
          return jsonResponse(envelope({ data: [{ observationDbId: 'new-1' }] }));
        if (u.pathname.endsWith('/observations') && method === 'GET')
          return count(u, timeoutMs, init?.signal ?? undefined);
        throw new Error(`Unexpected path: ${u.pathname} (${method})`);
      },
    );
  }

  const countRequests = () =>
    fetcher.mock.calls
      .map((c) => new URL(String(c[0])))
      .filter(
        (u) => u.pathname.endsWith('/observations') && u.searchParams.get('pageSize') === '1',
      );

  it.each([7, 0, undefined])('retains verified SGN count %s from one request', async (total) => {
    const ctx = await connect(fetcher, { serverName: 'Breedbase' });
    serveApply(async () =>
      jsonResponse(envelope({ data: [] }, total === undefined ? undefined : { totalCount: total })),
    );
    const output = await brapiSubmitObservations.handler(
      brapiSubmitObservations.input.parse(FORCED_POST),
      ctx,
    );
    if (output.result.mode !== 'apply') throw new Error('expected apply');
    expect(countRequests().map((url) => Object.fromEntries(url.searchParams))).toEqual([
      { studyDbId: 'study-1', pageSize: '1' },
    ]);
    expect(output.result.studyObservationCount).toBe(total);
    expect(renderText(output)).toContain(`- studyObservationCount: ${total ?? '—'}`);
  });

  it('omits the count with a warning when the dialect drops the study filter, without probing', async () => {
    const ctx = await connect(fetcher, { serverName: 'BrAPI Community Test Server' });
    // The test server ignores the study scope on /observations: every count is the server-wide total.
    serveApply(async () => jsonResponse(envelope({ data: [] }, { totalCount: 4 })));

    const output = await brapiSubmitObservations.handler(
      brapiSubmitObservations.input.parse(FORCED_POST),
      ctx,
    );

    expect(output.result.mode).toBe('apply');
    if (output.result.mode !== 'apply') return;
    expect(output.result.studyObservationCount).toBeUndefined();
    expect(output.result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^studyObservationCount omitted: the 'brapi-test' dialect drops the study filter for \/observations/,
        ),
      ]),
    );
    expect(countRequests()).toEqual([]);
    const text = renderText(output);
    expect(text).toContain('- studyObservationCount: —');
    expect(text).toMatch(/studyObservationCount omitted: the 'brapi-test' dialect/);
  });

  it.each([
    ['Test', 'studyDbIds'],
    ['BMS', 'studyDbId'],
  ])(
    'omits the count for %s when the scoped total equals the unfiltered baseline',
    async (serverName, scopeKey) => {
      const ctx = await connect(fetcher, { serverName });
      serveApply(async () => jsonResponse(envelope({ data: [] }, { totalCount: 4 })));

      const output = await brapiSubmitObservations.handler(
        brapiSubmitObservations.input.parse(FORCED_POST),
        ctx,
      );

      if (output.result.mode !== 'apply') throw new Error('expected apply');
      expect(output.result.studyObservationCount).toBeUndefined();
      expect(output.result.warnings).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /^studyObservationCount omitted: \/observations returned the same total \(4\)/,
          ),
        ]),
      );
      // Equal totals also arise when the study holds every observation on the
      // server, so the warning must not assert the filter was ignored.
      const guard = output.result.warnings?.find((w) => w.includes('returned the same total'));
      expect(guard).toContain("so the study filter can't be confirmed");
      expect(guard).not.toContain('silently ignored');
      expect(countRequests().map((url) => Object.fromEntries(url.searchParams))).toEqual([
        { [scopeKey]: 'study-1', pageSize: '1' },
        { pageSize: '1' },
      ]);
    },
  );

  it('omits the count with a warning when the count probe fails, keeping the write result', async () => {
    const ctx = await connect(fetcher);
    serveApply(async (u, timeoutMs) => {
      if (u.searchParams.has('studyDbIds'))
        throw timeout(`Fetch timed out after ${timeoutMs}ms`, { errorSource: 'FetchTimeout' });
      return jsonResponse(envelope({ data: [] }, { totalCount: 100 }));
    });

    const output = await brapiSubmitObservations.handler(
      brapiSubmitObservations.input.parse(FORCED_POST),
      ctx,
    );

    if (output.result.mode !== 'apply') throw new Error('expected apply');
    expect(output.result.posted).toEqual([{ observationDbId: 'new-1' }]);
    expect(output.result.studyObservationCount).toBeUndefined();
    expect(output.result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^studyObservationCount probe failed: .*timed out/),
      ]),
    );
  });

  it.each([
    ['times out', (ms: number) => timeout(`Fetch timed out after ${ms}ms`)],
    [
      'answers HTTP 503',
      () =>
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Fetch failed. Status: 503', {
          status: 503,
        }),
    ],
  ])('keeps the scoped count when only the unfiltered baseline %s', async (_label, failure) => {
    const ctx = await connect(fetcher);
    serveApply(async (u, timeoutMs) => {
      if (u.searchParams.has('studyDbIds'))
        return jsonResponse(envelope({ data: [] }, { totalCount: 7 }));
      throw failure(timeoutMs);
    });

    const output = await brapiSubmitObservations.handler(
      brapiSubmitObservations.input.parse(FORCED_POST),
      ctx,
    );

    if (output.result.mode !== 'apply') throw new Error('expected apply');
    expect(output.result.studyObservationCount).toBe(7);
    expect(
      (output.result.warnings ?? []).filter((w) => w.startsWith('studyObservationCount')),
    ).toEqual([]);
    expect(countRequests()).toHaveLength(2);
  });

  it('propagates caller cancellation during the count probe', async () => {
    const controller = new AbortController();
    const ctx = await connect(fetcher, {
      ctxOptions: { tenantId: 't1', signal: controller.signal },
    });
    serveApply((_u, timeoutMs, signal) => {
      queueMicrotask(() => controller.abort());
      return stalledResponse(timeoutMs, signal);
    });

    await expect(
      brapiSubmitObservations.handler(brapiSubmitObservations.input.parse(FORCED_POST), ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
  });
});
