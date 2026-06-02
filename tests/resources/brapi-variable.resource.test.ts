/**
 * @fileoverview Tests for `brapi://variable/{observationVariableDbId}` — direct
 * `/variables/{id}` read on the default connection, single-record return, and
 * the typed error contract (unknown_alias, variable_not_found).
 *
 * @module tests/resources/brapi-variable.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brapiVariableResource } from '@/mcp-server/resources/definitions/brapi-variable.resource.js';
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
          calls: [{ service: 'variables', methods: ['GET'], versions: ['2.1'] }],
        }),
      );
    }
    if (path.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: [] }));
    return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
  });
  const ctx = createMockContext({ tenantId: 't1', errors: brapiVariableResource.errors });
  await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
  fetcher.mockReset();
  return ctx;
}

describe('brapi://variable/{observationVariableDbId} resource', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('returns the single /variables/{id} record for a valid id', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/variables/variable1')) {
        return jsonResponse(
          envelope({
            observationVariableDbId: 'variable1',
            observationVariableName: 'Corn Stalk Height',
            trait: { traitDbId: 't1', traitName: 'Stalk Height' },
            scale: { scaleDbId: 's1', dataType: 'Numerical' },
            method: { methodDbId: 'm1', methodName: 'Tape' },
          }),
        );
      }
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });

    const result = (await brapiVariableResource.handler(
      { observationVariableDbId: 'variable1' },
      ctx,
    )) as {
      observationVariableDbId: string;
      observationVariableName?: string;
      scale?: { dataType?: string };
    };

    expect(result.observationVariableDbId).toBe('variable1');
    expect(result.observationVariableName).toBe('Corn Stalk Height');
    expect(result.scale?.dataType).toBe('Numerical');
  });

  it('throws variable_not_found on a 404', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({}), 404));
    await expect(
      brapiVariableResource.handler({ observationVariableDbId: 'ghost' }, ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'variable_not_found' },
    });
  });

  it('throws variable_not_found when the record is empty', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({})));
    await expect(
      brapiVariableResource.handler({ observationVariableDbId: 'ghost' }, ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'variable_not_found' },
    });
  });

  it('throws unknown_alias when no default connection is registered', async () => {
    const ctx = createMockContext({ tenantId: 't2', errors: brapiVariableResource.errors });
    await expect(
      brapiVariableResource.handler({ observationVariableDbId: 'variable1' }, ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
  });
});
