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
      when: 'No default BrAPI connection is registered, and the server has no default base URL configured to connect on first use',
      recovery:
        'Call brapi_connect with a `baseUrl` (without an alias, or with alias `default`) before reading this resource.',
      thrownBy: 'service',
    },
    {
      reason: 'auth_token_exchange_failed',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Connecting the default alias on first use, the SGN or OAuth token exchange against the BrAPI /token endpoint failed',
      recovery:
        'Ask the operator to check the credentials configured for the default alias and that the server exposes /token, or run brapi_connect with credentials in `auth`.',
      thrownBy: 'service',
    },
    {
      reason: 'auth_no_access_token',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Connecting the default alias on first use, the token endpoint answered without returning an access token',
      recovery:
        'Ask the operator to check that the credentials configured for the default alias are valid and that the upstream IdP issues access tokens for this grant.',
      thrownBy: 'service',
    },
    {
      reason: 'capability_discovery_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Neither /serverinfo nor /calls listed any call, and at least one of them timed out, was unreachable, or answered 429 or a 5xx other than 501, so nothing was cached',
      recovery:
        'The BrAPI server is slow or unreachable right now. Read this resource again in a minute; if it keeps failing, the server may be down.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unauthorized',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'The BrAPI server answered HTTP 401: it requires credentials, or rejected the ones sent',
      recovery:
        'Run brapi_connect with credentials in `auth`, or ask the operator to set server-side credentials for the default alias, then read this resource again.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The BrAPI server answered HTTP 403: the credentials sent, or their absence, lack access',
      recovery:
        'Run brapi_connect with credentials that have access, or ask the operator to set server-side credentials for the default alias that do, then read this resource again.',
      thrownBy: 'service',
    },
    {
      reason: 'alias_base_url_invalid',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'The default base URL configured on the server is not an absolute http(s) URL, or carries credentials',
      recovery:
        'Ask the operator to set the default base URL to an absolute http(s) URL, then read this resource again.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'private_address_blocked',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The default base URL configured on the server, or its token URL, is on a private or reserved address this server may not reach',
      recovery:
        'Ask the operator to point the default base URL at a publicly routable host, or to allow private addresses on this server, then read this resource again.',
      retryable: false,
      thrownBy: 'service',
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
          { observationVariableDbId: params.observationVariableDbId, baseUrl: connection.baseUrl },
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
        { observationVariableDbId: params.observationVariableDbId, baseUrl: connection.baseUrl },
      );
    }
    return variable;
  },
  list: async () => ({
    resources: [],
  }),
});
