/**
 * @fileoverview `brapi://variable/{observationVariableDbId}` — single
 * observation-variable record on the default connection. The single-record,
 * URI-addressable counterpart to `brapi_find_variables` (which returns a list
 * envelope). Fills the resource gap alongside `brapi://study/{id}` and
 * `brapi://germplasm/{id}`.
 *
 * Fetches the canonical `/variables/{observationVariableDbId}` payload directly
 * (trait, scale, method, ontology) and returns it verbatim — mirroring how
 * `brapi_get_germplasm` reads `/germplasm/{id}`. A 404 (or an empty record)
 * surfaces as the typed `variable_not_found` error.
 *
 * @module mcp-server/resources/definitions/brapi-variable.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  buildRequestOptions,
  isUpstreamNotFound,
  requireRegisteredConnection,
} from '@/mcp-server/tools/shared/find-helpers.js';
import { getBrapiClient } from '@/services/brapi-client/index.js';

export const brapiVariableResource = resource('brapi://variable/{observationVariableDbId}', {
  name: 'brapi-variable',
  title: 'BrAPI observation variable record',
  description:
    'Single observation-variable resource on the default BrAPI connection — the canonical /variables/{id} record (trait, scale, method, ontology), addressable by URI. The single-record equivalent of brapi_find_variables.',
  mimeType: 'application/json',
  errors: [
    {
      reason: 'unknown_alias',
      code: JsonRpcErrorCode.NotFound,
      when: 'No default BrAPI connection has been registered',
      recovery:
        'Call brapi_connect (without an alias, or with alias `default`) before reading this resource.',
    },
    {
      reason: 'variable_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Upstream returned no observation variable record for the requested DbId',
      recovery:
        'Verify the observationVariableDbId on the target server, or run brapi_find_variables to discover valid IDs.',
    },
  ] as const,
  params: z.object({
    observationVariableDbId: z
      .string()
      .min(1)
      .describe('Observation variable identifier on the default connection.'),
  }),
  async handler(params, ctx) {
    const client = getBrapiClient();
    const connection = await requireRegisteredConnection(ctx, undefined);
    const id = encodeURIComponent(params.observationVariableDbId);

    let env: Awaited<ReturnType<typeof client.get<Record<string, unknown>>>>;
    try {
      env = await client.get<Record<string, unknown>>(
        connection.baseUrl,
        `/variables/${id}`,
        ctx,
        buildRequestOptions(connection, undefined, { singleton: true }),
      );
    } catch (err) {
      if (isUpstreamNotFound(err)) {
        throw ctx.fail(
          'variable_not_found',
          `Observation variable '${params.observationVariableDbId}' not found on ${connection.baseUrl}.`,
          {
            observationVariableDbId: params.observationVariableDbId,
            baseUrl: connection.baseUrl,
            ...ctx.recoveryFor('variable_not_found'),
          },
          { cause: err },
        );
      }
      throw err;
    }

    const variable = env.result;
    if (
      !variable ||
      typeof variable !== 'object' ||
      !(variable as Record<string, unknown>).observationVariableDbId
    ) {
      throw ctx.fail(
        'variable_not_found',
        `Observation variable '${params.observationVariableDbId}' not found on ${connection.baseUrl}.`,
        {
          observationVariableDbId: params.observationVariableDbId,
          baseUrl: connection.baseUrl,
          ...ctx.recoveryFor('variable_not_found'),
        },
      );
    }
    return variable;
  },
  list: async () => ({
    resources: [],
  }),
});
