/**
 * @fileoverview Observation tool wiring and additive coverage contracts.
 * @module tests/tools/observation-coverage.test
 */
import { timeout } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, expect, it } from 'vitest';
import { brapiBuildPhenotypeMatrix as matrix } from '@/mcp-server/tools/definitions/brapi-build-phenotype-matrix.tool.js';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiFindObservations as find } from '@/mcp-server/tools/definitions/brapi-find-observations.tool.js';
import { brapiGermplasmPerformance as performance } from '@/mcp-server/tools/definitions/brapi-germplasm-performance.tool.js';
import {
  BASE_URL,
  envelope,
  initTestServices,
  jsonResponse,
  resetTestServices,
  TEST_CONFIG,
} from './_tool-test-helpers.js';

afterEach(resetTestServices);

async function setup(sgn = true) {
  const fetcher = initTestServices({ ...TEST_CONFIG, pageSize: 1 });
  const ctx = createMockContext({ tenantId: 'coverage' });
  fetcher.mockImplementation(async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/serverinfo'))
      return jsonResponse(
        envelope({
          serverName: sgn ? 'Breedbase' : 'Test',
          calls: ['observations', 'observationunits', 'germplasm', 'studies'].map((service) => ({
            service,
            methods: ['GET'],
            versions: ['2.1'],
          })),
        }),
      );
    return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
  });
  await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
  fetcher.mockReset();
  return { fetcher, ctx };
}

const child = (id: string, value = '0') => ({
  observationDbId: id,
  observationVariableDbId: 'v1',
  value,
});
const unit = (studyDbId: string, observations = [child(studyDbId)]) => ({
  studyDbId,
  germplasmDbId: 'g1',
  observationUnitDbId: `u-${studyDbId}`,
  observations,
});

it('finder includes zero-valued embedded measurements and renders inherited metadata', async () => {
  const { fetcher, ctx } = await setup();
  fetcher.mockImplementation(async (url: string) =>
    jsonResponse(
      envelope(
        { data: new URL(url).pathname.endsWith('/observationunits') ? [unit('s1')] : [] },
        { totalCount: 1 },
      ),
    ),
  );
  const run = await runToolContract(
    { ...find, handler: (input, c) => find.handler(input, { ...c, state: ctx.state }) },
    { studies: ['s1'] },
  );
  expect(run.isError).not.toBe(true);
  expect(run.structuredContent.results).toMatchObject([
    { observationDbId: 's1', value: '0', studyDbId: 's1', germplasmDbId: 'g1' },
  ]);
  expect(JSON.stringify(run.content)).toContain('studyDbId=s1');
});

it('finder preserves multi-value and field-level filters after flattening, with an accurate query echo', async () => {
  const { fetcher, ctx } = await setup();
  fetcher.mockImplementation(async () =>
    jsonResponse(
      envelope(
        {
          data: [
            {
              ...unit('s1'),
              programDbId: 'p1',
              trialDbId: 't1',
              seasonDbId: 'season1',
              locationDbId: 'loc',
              observationUnitPosition: { observationLevel: { levelName: 'plot' } },
              observations: [
                { ...child('keep'), observationTimeStamp: '2026-01-02T00:00:00Z' },
                {
                  ...child('keep2', '1'),
                  germplasmDbId: 'g2',
                  observationVariableDbId: 'v2',
                  observationTimeStamp: '2026-01-03T00:00:00Z',
                },
                { ...child('excluded'), observationTimeStamp: '2025-01-02T00:00:00Z' },
              ],
            },
          ],
        },
        { totalCount: 1 },
      ),
    ),
  );
  const run = await runToolContract(
    { ...find, handler: (input, c) => find.handler(input, { ...c, state: ctx.state }) },
    {
      studies: ['s1'],
      germplasm: ['g1', 'g2'],
      variables: ['v1', 'v2'],
      observations: ['keep', 'keep2'],
      observationUnits: ['u-s1'],
      programs: ['p1'],
      trials: ['t1'],
      seasons: ['season1'],
      observationLevels: ['plot'],
      timestampFrom: '2026-01-01T00:00:00Z',
      timestampTo: '2026-01-04T00:00:00Z',
      extraFilters: { locationDbId: 'loc' },
    },
  );
  expect(run.isError).not.toBe(true);
  expect(
    (run.structuredContent.results as { observationDbId: string }[]).map(
      (row) => row.observationDbId,
    ),
  ).toEqual(['keep', 'keep2']);
  expect(run.structuredContent.appliedFilters).toMatchObject({
    clientSide: {
      germplasmDbIds: ['g1', 'g2'],
      observationVariableDbIds: ['v1', 'v2'],
      observationDbIds: ['keep', 'keep2'],
    },
    upstreamRequests: [{ studyDbId: 's1', includeObservations: true, locationDbId: 'loc' }],
  });
  expect(JSON.stringify(run.content)).toContain('id=`keep2`');
});

it.each([
  ['lower offset', { timestampFrom: '2026-01-01T00:00:00Z' }, ['inside', 'upper', 'precise']],
  ['upper offset', { timestampTo: '2026-01-01T01:00:00Z' }, ['lower', 'inside', 'precise']],
  [
    'equal precision',
    { timestampFrom: '2026-01-01T00:00:00.000Z', timestampTo: '2026-01-01T00:00:00Z' },
    ['precise'],
  ],
] as const)('finder compares timestamp instants for %s', async (_name, bounds, expectedIds) => {
  const { fetcher, ctx } = await setup();
  fetcher.mockImplementation(async () =>
    jsonResponse(
      envelope(
        {
          data: [
            {
              ...unit('s1'),
              observations: [
                { ...child('lower'), observationTimeStamp: '2026-01-01T00:30:00+01:00' },
                { ...child('inside'), observationTimeStamp: '2026-01-01T00:30:00Z' },
                { ...child('upper'), observationTimeStamp: '2026-01-01T00:30:00-01:00' },
                { ...child('precise'), observationTimeStamp: '2026-01-01T00:00:00.000Z' },
              ],
            },
          ],
        },
        { totalCount: 1 },
      ),
    ),
  );
  const run = await runToolContract(
    { ...find, handler: (input, c) => find.handler(input, { ...c, state: ctx.state }) },
    { studies: ['s1'], ...bounds },
  );
  expect(run.isError).not.toBe(true);
  expect(
    (run.structuredContent.results as { observationDbId: string }[]).map(
      (row) => row.observationDbId,
    ),
  ).toEqual(expectedIds);
  expect(run.structuredContent.totalCount).toBe(expectedIds.length);
});

it('germplasm auto mode bypasses study discovery and preserves contributor fields', async () => {
  const { fetcher, ctx } = await setup();
  const requests: URL[] = [];
  fetcher.mockImplementation(async (url: string) => {
    const u = new URL(url);
    requests.push(u);
    if (u.pathname.includes('/germplasm/')) return jsonResponse(envelope({ germplasmDbId: 'g1' }));
    if (u.pathname.endsWith('/observationunits')) {
      const page = Number(u.searchParams.get('page') ?? 0);
      return jsonResponse(
        envelope(
          {
            data:
              page === 0
                ? [unit('beyond-200', [child('same'), child('replicate')])]
                : [unit('empty', [])],
          },
          { totalCount: 2 },
        ),
      );
    }
    return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
  });
  const run = await runToolContract(
    {
      ...performance,
      handler: (input, c) => performance.handler(input, { ...c, state: ctx.state }),
    },
    { germplasmDbId: 'g1' },
  );
  expect(run.isError).not.toBe(true);
  expect(run.structuredContent).toMatchObject({
    studyCount: 1,
    studyDbIds: ['beyond-200'],
    perVariable: [{ n: 2, mean: 0 }],
    coverage: {
      partial: false,
      studies: [
        { studyDbId: 'beyond-200', status: 'contributed' },
        { studyDbId: 'empty', status: 'empty' },
      ],
    },
  });
  expect(requests.filter((u) => u.pathname.endsWith('/studies'))).toHaveLength(0);
  expect(JSON.stringify(run.content)).toContain('empty');
});

it('matrix retains requested studies and exposes failed versus empty coverage on both surfaces', async () => {
  const { fetcher, ctx } = await setup(false);
  fetcher.mockImplementation(async (url: string) => {
    const u = new URL(url);
    const study = u.searchParams.get('studyDbIds');
    if (study === 'bad') throw timeout('bounded fake timeout');
    const data =
      study === 'good' ? [{ ...child('one'), studyDbId: 'good', germplasmDbId: 'g1' }] : [];
    return jsonResponse(envelope({ data }, { totalCount: data.length }));
  });
  const run = await runToolContract(
    { ...matrix, handler: (input, c) => matrix.handler(input, { ...c, state: ctx.state }) },
    { studies: ['good', 'bad', 'empty'], shape: 'long' },
  );
  expect(run.isError).not.toBe(true);
  expect(run.structuredContent).toMatchObject({
    studies: ['good', 'bad', 'empty'],
    coverage: {
      partial: true,
      studies: [
        { studyDbId: 'good', status: 'contributed', observationCount: 1 },
        { studyDbId: 'bad', status: 'failed', observationCount: 0 },
        { studyDbId: 'empty', status: 'empty', observationCount: 0 },
      ],
    },
  });
  expect(JSON.stringify(run.content)).toContain('bad: failed');
  expect(JSON.stringify(run.content)).toContain('empty: empty');
});
