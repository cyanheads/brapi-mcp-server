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
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { resolveConnectInput } from '@/config/alias-credentials.js';
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
    'Connect to a BrAPI v2 server, authenticate, cache the capability profile, and return the full orientation envelope inline. Required handshake before other BrAPI tools. Supports multiple concurrent connections via named aliases. baseUrl + auth fall back to BRAPI_<ALIAS>_* then BRAPI_DEFAULT_* env vars when omitted, so credentials stay out of tool inputs.',
  annotations: {
    openWorldHint: true,
    readOnlyHint: false,
    idempotentHint: true,
  },
  errors: [
    {
      reason: 'auth_token_exchange_failed',
      code: JsonRpcErrorCode.Forbidden,
      when: 'SGN or OAuth token exchange against the BrAPI /token endpoint failed',
      recovery: 'Verify the credentials and that the server exposes /token before retrying.',
    },
    {
      reason: 'auth_no_access_token',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Token endpoint responded but did not return an access_token',
      recovery:
        'Confirm the credentials are valid and the upstream IdP issues access tokens for this grant.',
    },
  ] as const,
  input: z.object({
    baseUrl: z
      .string()
      .url()
      .optional()
      .describe(
        'BrAPI v2 base URL including any path prefix — e.g. https://test-server.brapi.org/brapi/v2. Falls back to BRAPI_<ALIAS>_BASE_URL, then BRAPI_DEFAULT_BASE_URL.',
      ),
    auth: ConnectAuthSchema.optional().describe(
      'Auth payload. When omitted, derived from BRAPI_<ALIAS>_* env vars (USERNAME+PASSWORD → sgn; BEARER_TOKEN → bearer; API_KEY → api_key; OAUTH_CLIENT_ID+OAUTH_CLIENT_SECRET → oauth2), then BRAPI_DEFAULT_*, then no auth.',
    ),
    alias: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .default('default')
      .describe(
        'Alias for this connection. Use distinct aliases to register multiple BrAPI servers in one session. Drives env-var lookup: alias `cassava` reads `BRAPI_CASSAVA_*`.',
      ),
  }),
  output: OrientationEnvelopeSchema,

  async handler(input, ctx) {
    const registry = getServerRegistry();
    const capabilities = getCapabilityRegistry();
    const client = getBrapiClient();

    const resolved = resolveConnectInput(input.alias, {
      baseUrl: input.baseUrl,
      auth: input.auth,
    });

    const connection = await registry.register(ctx, {
      alias: input.alias,
      baseUrl: resolved.baseUrl,
      auth: resolved.auth,
    });

    ctx.log.info('BrAPI connection registered', {
      alias: connection.alias,
      baseUrl: connection.baseUrl,
      authMode: connection.authMode,
      authSource: input.auth ? 'agent' : 'env',
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
