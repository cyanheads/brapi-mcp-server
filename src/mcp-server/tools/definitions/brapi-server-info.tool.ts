/**
 * @fileoverview `brapi_server_info` — on-demand orientation envelope for the
 * active (or aliased) connection. Returns the same shape that `brapi_connect`
 * inlines. Useful for refreshing capability data after a long session or
 * when switching between registered aliases.
 *
 * @module mcp-server/tools/definitions/brapi-server-info.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getBrapiClient } from '@/services/brapi-client/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import { DEFAULT_ALIAS, getServerRegistry } from '@/services/server-registry/index.js';
import {
  buildOrientationEnvelope,
  formatOrientationEnvelope,
  OrientationEnvelopeSchema,
} from '../shared/orientation-envelope.js';

export const brapiServerInfo = tool('brapi_server_info', {
  description:
    'Return the full orientation envelope for a registered BrAPI connection — server identity, capabilities, content counts, and notes. Use after `brapi_connect` to refresh capability data or when switching between registered aliases.',
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    alias: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional()
      .describe(
        'Connection alias. Omit to use the default connection from the most recent `brapi_connect` call.',
      ),
    forceRefresh: z
      .boolean()
      .default(false)
      .describe('Bypass the cached capability profile and refetch from the server.'),
  }),
  output: OrientationEnvelopeSchema,

  async handler(input, ctx) {
    const registry = getServerRegistry();
    const capabilities = getCapabilityRegistry();
    const client = getBrapiClient();

    const connection = await registry.get(ctx, input.alias ?? DEFAULT_ALIAS);

    if (input.forceRefresh) {
      await capabilities.invalidate(connection.baseUrl, ctx);
    }

    return buildOrientationEnvelope(ctx, connection, { registry: capabilities, client });
  },

  format: (result) => [{ type: 'text', text: formatOrientationEnvelope(result) }],
});
