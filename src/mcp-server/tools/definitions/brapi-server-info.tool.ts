/**
 * @fileoverview `brapi_server_info` — on-demand orientation envelope for the
 * active (or aliased) connection. Returns the same shape that `brapi_connect`
 * inlines. Useful for refreshing capability data after a long session or
 * when switching between registered aliases.
 *
 * @module mcp-server/tools/definitions/brapi-server-info.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getBrapiClient } from '@/services/brapi-client/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import { requireRegisteredConnection } from '../shared/find-helpers.js';
import {
  buildOrientationEnvelope,
  formatOrientationEnvelope,
  OrientationEnvelopeSchema,
} from '../shared/orientation-envelope.js';

export const brapiServerInfo = tool('brapi_server_info', {
  description:
    'Return the full orientation envelope for a registered BrAPI connection — server identity, capabilities, content counts, and notes. Re-running refreshes the cached capability scan; pass an alias to read a non-default connection.',
  annotations: { readOnlyHint: true, idempotentHint: true },
  errors: [
    {
      reason: 'unknown_alias',
      code: JsonRpcErrorCode.NotFound,
      when: 'No connection has been registered under the requested alias',
      recovery:
        'Run brapi_connect with this alias (or omit `alias` to use the default connection) before calling brapi_server_info.',
    },
  ] as const,
  input: z.object({
    alias: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional()
      .describe(
        'Connection alias. Omit to read the connection registered under alias `default` — i.e. a prior `brapi_connect` call that did not specify an alias. Calls that used a non-default alias must pass that same alias here.',
      ),
    forceRefresh: z
      .boolean()
      .default(false)
      .describe('Bypass the cached capability profile and refetch from the server.'),
  }),
  output: OrientationEnvelopeSchema,

  async handler(input, ctx) {
    const capabilities = getCapabilityRegistry();
    const client = getBrapiClient();

    const connection = await requireRegisteredConnection(ctx, input.alias);

    if (input.forceRefresh) {
      await capabilities.invalidate(connection.baseUrl, ctx);
    }

    return buildOrientationEnvelope(ctx, connection, { registry: capabilities, client });
  },

  format: (result) => [{ type: 'text', text: formatOrientationEnvelope(result) }],
});
