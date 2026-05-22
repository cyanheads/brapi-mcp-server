/**
 * @fileoverview `brapi://calls` — capability profile (raw `/calls` data) for
 * the default connection. Useful for clients that want the full descriptor
 * map without the orientation-envelope wrapping.
 *
 * @module mcp-server/resources/definitions/brapi-calls.resource
 */

import { type HandlerContext, resource } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { requireRegisteredConnection } from '@/mcp-server/tools/shared/find-helpers.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';

async function loadCallsProfile(ctx: HandlerContext<'unknown_alias'>) {
  const capabilities = getCapabilityRegistry();
  const connection = await requireRegisteredConnection(ctx, undefined);
  const lookup: { auth?: typeof connection.resolvedAuth } = {};
  if (connection.resolvedAuth) lookup.auth = connection.resolvedAuth;
  const profile = await capabilities.profile(connection.baseUrl, ctx, lookup);
  return {
    alias: connection.alias,
    baseUrl: connection.baseUrl,
    server: profile.server,
    crops: profile.crops,
    supported: profile.supported,
    fetchedAt: profile.fetchedAt,
  };
}

export const brapiCallsResource = resource('brapi://calls', {
  name: 'brapi-calls',
  title: 'BrAPI capability profile',
  description:
    'Capability profile for the default BrAPI connection — supported services, their HTTP methods, declared versions, and crops list. Mirrors what /serverinfo + /calls returned at the last load.',
  mimeType: 'application/json',
  errors: [
    {
      reason: 'unknown_alias',
      code: JsonRpcErrorCode.NotFound,
      when: 'No default BrAPI connection has been registered',
      recovery:
        'Call brapi_connect (without an alias, or with alias `default`) before reading this resource.',
    },
  ] as const,
  handler(_params, ctx) {
    return loadCallsProfile(ctx);
  },
  list: () => ({
    resources: [
      {
        uri: 'brapi://calls',
        name: 'BrAPI capability profile',
        mimeType: 'application/json',
      },
    ],
  }),
});
