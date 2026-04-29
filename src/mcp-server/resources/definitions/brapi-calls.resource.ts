/**
 * @fileoverview `brapi://calls` — capability profile (raw `/calls` data) for
 * the default connection. Useful for clients that want the full descriptor
 * map without the orientation-envelope wrapping.
 *
 * @module mcp-server/resources/definitions/brapi-calls.resource
 */

import { type Context, resource } from '@cyanheads/mcp-ts-core';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import { DEFAULT_ALIAS, getServerRegistry } from '@/services/server-registry/index.js';

async function loadCallsProfile(ctx: Context) {
  const registry = getServerRegistry();
  const capabilities = getCapabilityRegistry();
  const connection = await registry.get(ctx, DEFAULT_ALIAS);
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
