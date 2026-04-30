/**
 * @fileoverview End-to-end tests for `brapi_find_variables` — capability
 * gate, free-text ranking via OntologyResolver, ontology-endpoint capability
 * gap warning, multi-study warning, distribution computation across nested
 * trait/scale objects.
 *
 * @module tests/tools/brapi-find-variables.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiFindVariables } from '@/mcp-server/tools/definitions/brapi-find-variables.tool.js';
import { initOntologyResolver } from '@/services/ontology-resolver/index.js';
import {
  BASE_URL,
  envelope,
  initTestServices,
  jsonResponse,
  type MockFetcher,
  pathnameOf,
  resetTestServices,
} from './_tool-test-helpers.js';

function varRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    observationVariableDbId: 'var-1',
    observationVariableName: 'Dry Matter %',
    observationVariablePUI: 'CO_334:0000013',
    ontologyDbId: 'CO_334',
    ontologyName: 'Cassava',
    trait: { traitDbId: 'trait-1', traitName: 'Dry matter content', traitClass: 'Agronomic' },
    scale: { scaleDbId: 'scale-1', scaleName: 'Percent', dataType: 'Numerical' },
    method: { methodDbId: 'method-1', methodName: 'Gravimetric' },
    ...extra,
  };
}

async function connect(fetcher: MockFetcher, calls: string[] = ['variables', 'ontologies']) {
  fetcher.mockImplementation(async (url: string) => {
    const path = pathnameOf(url);
    if (path.endsWith('/serverinfo')) {
      return jsonResponse(
        envelope({
          serverName: 'Test',
          calls: calls.map((service) => ({ service, methods: ['GET'], versions: ['2.1'] })),
        }),
      );
    }
    if (path.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: [] }));
    return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
  });
  const ctx = createMockContext({ tenantId: 't1' });
  await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
  fetcher.mockReset();
  return ctx;
}

describe('brapi_find_variables tool', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
    initOntologyResolver();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('returns rows + nested-field distributions for trait class and scale', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      varRow(),
      varRow({
        observationVariableDbId: 'var-2',
        ontologyDbId: 'CO_334',
        trait: { traitName: 'Plant height', traitClass: 'Morphological' },
        scale: { scaleName: 'Centimeters', dataType: 'Numerical' },
      }),
      varRow({
        observationVariableDbId: 'var-3',
        ontologyDbId: 'CO_338',
        trait: { traitClass: 'Agronomic' },
        scale: { scaleName: 'Percent', dataType: 'Numerical' },
      }),
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiFindVariables.handler(
      brapiFindVariables.input.parse({ ontologies: ['CO_334'] }),
      ctx,
    );

    expect(result.returnedCount).toBe(3);
    expect(result.distributions.ontologyDbId).toEqual({ CO_334: 2, CO_338: 1 });
    expect(result.distributions.traitClass).toEqual({ Agronomic: 2, Morphological: 1 });
    expect(result.distributions.scaleName).toEqual({ Percent: 2, Centimeters: 1 });
  });

  it('ranks free-text matches via OntologyResolver and promotes them to the top', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      varRow({
        observationVariableDbId: 'var-other',
        observationVariableName: 'Plant height',
        observationVariablePUI: 'CO_334:0000010',
        trait: { traitName: 'Plant height' },
      }),
      varRow(), // dry matter — should be promoted
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiFindVariables.handler(
      brapiFindVariables.input.parse({ text: 'dry matter' }),
      ctx,
    );

    expect(result.ontologyCandidates.length).toBeGreaterThan(0);
    // First result should be the dry-matter variable (promoted via PUI match in candidates).
    expect(result.results[0]?.observationVariableDbId).toBe('var-1');
  });

  it('promotes free-text matches by observationVariableDbId when PUI is missing (CassavaBase)', async () => {
    const ctx = await connect(fetcher);
    // Real CassavaBase variables don't carry observationVariablePUI; promotion
    // must fall back to observationVariableDbId, which is always populated.
    const rows = [
      {
        observationVariableDbId: 'var-other',
        observationVariableName: 'Plant height',
        trait: { traitName: 'Plant height' },
      },
      {
        observationVariableDbId: 'var-dm',
        observationVariableName: 'Dry matter percent',
        trait: { traitName: 'Dry matter content' },
      },
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiFindVariables.handler(
      brapiFindVariables.input.parse({ text: 'dry matter' }),
      ctx,
    );

    expect(result.ontologyCandidates.length).toBeGreaterThan(0);
    expect(result.ontologyCandidates[0]?.observationVariableDbId).toBe('var-dm');
    expect(result.results[0]?.observationVariableDbId).toBe('var-dm');
  });

  it('warns when more than one studyDbId is supplied (BrAPI accepts only one)', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));

    const result = await brapiFindVariables.handler(
      brapiFindVariables.input.parse({ studies: ['s-1', 's-2'] }),
      ctx,
    );

    expect(result.warnings.join('\n')).toContain('only one studyDbId');
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.get('studyDbId')).toBe('s-1');
  });

  it('warns when free-text is supplied but /ontologies is unavailable', async () => {
    const ctx = await connect(fetcher, ['variables']); // no ontologies in calls
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [varRow()] }, { totalCount: 1 })));

    const result = await brapiFindVariables.handler(
      brapiFindVariables.input.parse({ text: 'dry matter' }),
      ctx,
    );
    expect(result.warnings.join('\n')).toContain('does not expose /ontologies');
  });

  it('throws ValidationError when /variables is not advertised', async () => {
    const ctx = await connect(fetcher, ['studies']);
    await expect(
      brapiFindVariables.handler(brapiFindVariables.input.parse({}), ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
  });

  it('tolerates null values on nested trait/scale/method fields (Cassavabase shape)', async () => {
    const ctx = await connect(fetcher);
    const sparseRow = {
      observationVariableDbId: 'var-cb-1',
      observationVariableName: 'Cassava trait',
      // Cassavabase nulls in the wild on nested objects:
      trait: {
        traitDbId: 'trait-1',
        traitName: 'Some trait',
        traitClass: null,
        description: null,
      },
      scale: { scaleDbId: 'scale-1', scaleName: null, dataType: null },
      method: { methodDbId: null, methodName: null },
    };
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [sparseRow] }, { totalCount: 1 })));
    const result = await brapiFindVariables.handler(brapiFindVariables.input.parse({}), ctx);
    expect(result.returnedCount).toBe(1);
    expect(result.results[0]?.trait?.traitClass).toBeNull();
    expect(result.results[0]?.scale?.scaleName).toBeNull();
  });
});
