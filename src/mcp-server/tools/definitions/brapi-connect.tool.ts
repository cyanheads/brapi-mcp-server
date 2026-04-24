/**
 * @fileoverview `brapi_connect` — session-bootstrap tool. Authenticates to a
 * BrAPI v2 server, registers the connection under a named alias, loads the
 * capability profile (via CapabilityRegistry), and returns the full
 * orientation envelope inline. One call fully orients the agent — the same
 * envelope is available on-demand via `brapi_server_info`.
 *
 * @module mcp-server/tools/definitions/brapi-connect.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getBrapiClient } from '@/services/brapi-client/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import { getServerRegistry } from '@/services/server-registry/index.js';
import { ConnectAuthSchema } from '../shared/connect-auth-schema.js';
import {
  buildOrientationEnvelope,
  formatOrientationEnvelope,
  OrientationEnvelopeSchema,
} from '../shared/orientation-envelope.js';

export const brapiConnect = tool('brapi_connect', {
  description:
    'Connect to a BrAPI v2 server, authenticate, cache the capability profile, and return the full orientation envelope inline. Must be called before any other BrAPI tool. Supports multiple concurrent connections via named aliases.',
  annotations: {
    openWorldHint: true,
    readOnlyHint: false,
    idempotentHint: true,
  },
  input: z.object({
    baseUrl: z
      .string()
      .url()
      .describe(
        'BrAPI v2 base URL including any path prefix — e.g. https://test-server.brapi.org/brapi/v2',
      ),
    auth: ConnectAuthSchema.default({ mode: 'none' }),
    alias: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .default('default')
      .describe(
        'Alias for this connection. Use distinct aliases to register multiple BrAPI servers in one session.',
      ),
  }),
  output: OrientationEnvelopeSchema,

  async handler(input, ctx) {
    const registry = getServerRegistry();
    const capabilities = getCapabilityRegistry();
    const client = getBrapiClient();

    const connection = await registry.register(ctx, {
      alias: input.alias,
      baseUrl: input.baseUrl,
      auth: input.auth,
    });

    ctx.log.info('BrAPI connection registered', {
      alias: connection.alias,
      baseUrl: connection.baseUrl,
      authMode: connection.authMode,
    });

    // Force a fresh capability load on connect — the agent expects current state.
    await capabilities.invalidate(connection.baseUrl, ctx);
    return buildOrientationEnvelope(ctx, connection, {
      registry: capabilities,
      client,
    });
  },

  format: (result) => [{ type: 'text', text: formatOrientationEnvelope(result) }],
});
