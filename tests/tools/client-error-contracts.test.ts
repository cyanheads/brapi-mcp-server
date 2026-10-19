/**
 * @fileoverview Client failure contracts and preserved translation boundaries.
 * @module tests/tools/client-error-contracts
 */

import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brapiVariableResource } from '@/mcp-server/resources/definitions/brapi-variable.resource.js';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiFindGermplasm } from '@/mcp-server/tools/definitions/brapi-find-germplasm.tool.js';
import { brapiFindVariables } from '@/mcp-server/tools/definitions/brapi-find-variables.tool.js';
import { brapiGetGermplasm } from '@/mcp-server/tools/definitions/brapi-get-germplasm.tool.js';
import { brapiRawGet } from '@/mcp-server/tools/definitions/brapi-raw-get.tool.js';
import {
  readOnlyToolDefinitions,
  writeToolDefinitions,
} from '@/mcp-server/tools/definitions/index.js';
import { initOntologyResolver } from '@/services/ontology-resolver/index.js';
import { readResourceError } from '../resources/_resource-factory.js';
import {
  BASE_URL,
  envelope,
  initTestServices,
  jsonResponse,
  type MockFetcher,
  pathnameOf,
  resetTestServices,
} from './_tool-test-helpers.js';

describe('client error contracts', () => {
  let fetcher: MockFetcher;
  beforeEach(() => {
    fetcher = initTestServices();
    initOntologyResolver();
  });
  afterEach(resetTestServices);
  async function connect(serverName = 'Test', service = 'germplasm', methods = ['GET']) {
    fetcher.mockImplementation(async (url: string) =>
      pathnameOf(url).endsWith('/serverinfo')
        ? jsonResponse(envelope({ serverName, calls: [{ service, methods, versions: ['2.1'] }] }))
        : jsonResponse(envelope({ data: [] }, { totalCount: 0 })),
    );
    const ctx = createMockContext({ errors: brapiGetGermplasm.errors });
    await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
    fetcher.mockReset();
    return ctx;
  }
  it('characterizes singleton 404 translation and empty raw results', async () => {
    const ctx = await connect();
    fetcher.mockImplementation(async () => {
      throw serviceUnavailable('HTTP 404', { status: 404 });
    });
    await expect(
      brapiGetGermplasm.handler(brapiGetGermplasm.input.parse({ germplasmDbId: 'missing' }), ctx),
    ).rejects.toMatchObject({ data: { reason: 'germplasm_not_found' } });
    fetcher.mockImplementation(async () => jsonResponse(envelope({ data: [] }, { totalCount: 0 })));
    const result = await brapiRawGet.handler(brapiRawGet.input.parse({ path: '/germplasm' }), ctx);
    expect(result.result).toEqual({ data: [] });
    expect(brapiRawGet.format!(result)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'text' })]),
    );
  });
  for (const [status, reason] of [
    [404, 'upstream_not_found'],
    [429, 'upstream_rate_limited'],
  ] as const) {
    it(`enriches uncaught HTTP ${status} with declared recovery on both surfaces`, async () => {
      const ctx = await connect();
      fetcher.mockImplementation(async () => {
        throw serviceUnavailable(`HTTP ${status}`, { status });
      });
      const definition = {
        ...brapiRawGet,
        handler: (input, contractCtx) =>
          brapiRawGet.handler(input, { ...contractCtx, state: ctx.state }),
      } satisfies typeof brapiRawGet;
      const result = await runToolContract(definition, { path: '/germplasm' });
      expect(result.isError).toBe(true);
      const declared = definition.errors.find((e) => e.reason === reason);
      expect(declared).toBeDefined();
      expect(JSON.stringify(result.structuredContent)).toContain(reason);
      expect(JSON.stringify(result.structuredContent)).toContain(declared!.recovery);
      expect(JSON.stringify(result.content)).toContain(declared!.recovery);
    });
  }
  for (const [server, service, methods, reason] of [
    ['Test', 'other', ['GET'], 'missing_find_route'],
    ['CassavaBase', 'search/germplasm', ['POST'], 'search_endpoint_disabled'],
  ] as const) {
    it(`renders the reachable ${reason} recovery`, async () => {
      const ctx = await connect(server, service, [...methods]);
      const definition = {
        ...brapiFindGermplasm,
        handler: (input, contractCtx) =>
          brapiFindGermplasm.handler(input, { ...contractCtx, state: ctx.state }),
      } satisfies typeof brapiFindGermplasm;
      const result = await runToolContract(definition, {});
      const declared = definition.errors.find((e) => e.reason === reason)!;
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.structuredContent)).toContain(reason);
      expect(JSON.stringify(result.structuredContent)).toContain(declared.recovery);
      expect(JSON.stringify(result.content)).toContain(declared.recovery);
    });
  }
  it('adds singleton resource recovery and retains domain-specific 404 translation', async () => {
    const ctx = await connect();
    const resource = {
      ...brapiVariableResource,
      handler: (params, contractCtx) =>
        brapiVariableResource.handler(params, { ...contractCtx, state: ctx.state }),
    } satisfies typeof brapiVariableResource;
    fetcher.mockImplementation(async () => {
      throw serviceUnavailable('HTTP 429', { status: 429 });
    });
    const limited = await readResourceError(resource, 'brapi://variable/v');
    expect(limited?.data).toMatchObject({
      reason: 'upstream_rate_limited',
      recovery: {
        hint: resource.errors.find((e) => e.reason === 'upstream_rate_limited')!.recovery,
      },
    });
    fetcher.mockImplementation(async () => {
      throw serviceUnavailable('HTTP 404', { status: 404 });
    });
    expect((await readResourceError(resource, 'brapi://variable/v'))?.data).toMatchObject({
      reason: 'variable_not_found',
    });
  });
  for (const failedStudies of [['s2'], ['s1', 's2']]) {
    it(`preserves alias-to-union recovery when ${failedStudies.length} studies fail`, async () => {
      const ctx = await connect('Test', 'variables');
      fetcher.mockImplementation(async (url: string) => {
        const study = new URL(url).searchParams.get('studyDbId');
        if (study === null) throw new Error('Expected a scoped study request.');
        if (failedStudies.includes(study)) throw serviceUnavailable('HTTP 429', { status: 429 });
        return jsonResponse(
          envelope({ data: [{ observationVariableDbId: 'v1' }] }, { totalCount: 1 }),
        );
      });
      const definition = {
        ...brapiFindVariables,
        handler: (input, contractCtx) =>
          brapiFindVariables.handler(input, { ...contractCtx, state: ctx.state }),
      } satisfies typeof brapiFindVariables;
      const result = await runToolContract(definition, { studyDbIds: ['s1', 's2'] });
      const structured = JSON.stringify(result.structuredContent);
      const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
      expect(fetcher).toHaveBeenCalledTimes(2);
      if (failedStudies.length === 2) {
        expect(result.isError).toBe(true);
        const recovery = definition.errors.find(
          (error) => error.reason === 'upstream_rate_limited',
        )!.recovery;
        expect(structured).toContain('upstream_rate_limited');
        expect(structured).toContain(recovery);
        expect(text).toContain(recovery);
      } else {
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
          results: [{ observationVariableDbId: 'v1', studyDbIds: ['s1'] }],
          hasMore: true,
          studyCoverage: [
            { id: 's1', status: 'complete' },
            { id: 's2', status: 'failed', reason: 'upstream_rate_limited' },
          ],
        });
        expect(text).toContain('s2');
        expect(text).toContain('failed');
        expect(text).toContain('upstream_rate_limited');
        expect(result.structuredContent).not.toHaveProperty('error');
      }
    });
  }
  it('wires only escaping reasons across the catalog', () => {
    const with404 = new Set([
      'brapi_raw_get',
      'brapi_raw_search',
      'brapi_find_genotype_calls',
      'brapi_export_genotype_matrix',
      'brapi_build_phenotype_matrix',
      'brapi_germplasm_performance',
      'brapi_submit_observations',
      ...[
        'studies',
        'germplasm',
        'variables',
        'observations',
        'images',
        'locations',
        'variants',
      ].map((n) => `brapi_find_${n}`),
    ]);
    for (const definition of [...readOnlyToolDefinitions, ...writeToolDefinitions]) {
      const reasons = definition.errors?.map((e) => e.reason) ?? [];
      expect(reasons.includes('upstream_not_found'), definition.name).toBe(
        with404.has(definition.name),
      );
      expect(reasons.includes('upstream_rate_limited'), definition.name).toBe(
        with404.has(definition.name) ||
          ['brapi_get_study', 'brapi_get_germplasm'].includes(definition.name),
      );
    }
  });
});
