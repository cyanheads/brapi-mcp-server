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
import {
  discoverConfiguredAliases,
  formatConfiguredAliasesHint,
  resolveConnectInput,
} from '@/config/alias-credentials.js';
import { getBrapiClient } from '@/services/brapi-client/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import { getServerRegistry } from '@/services/server-registry/index.js';
import { ConnectAuthSchema } from '../shared/connect-auth-schema.js';
import {
  buildOrientationEnvelope,
  formatOrientationEnvelope,
  OrientationEnvelopeSchema,
} from '../shared/orientation-envelope.js';

const BASE_DESCRIPTION =
  'Open a connection to a BrAPI v2 server, authenticate, and return the full orientation envelope (server identity, capability profile, content summary). Required handshake before other BrAPI tools. Supports multiple concurrent connections via named aliases. Credentials can be configured server-side and omitted from this call.';

const CONFIGURED_ALIASES_HINT = formatConfiguredAliasesHint(discoverConfiguredAliases());

export const brapiConnect = tool('brapi_connect', {
  description: CONFIGURED_ALIASES_HINT
    ? `${BASE_DESCRIPTION} ${CONFIGURED_ALIASES_HINT}`
    : BASE_DESCRIPTION,
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

    if (isMultiTenantHttpDeployment() && connection.authMode !== 'none') {
      ctx.log.notice(
        'Connection credentials persisted under shared `default` tenant — set MCP_AUTH_MODE=jwt|oauth for per-client isolation.',
        {
          alias: connection.alias,
          baseUrl: connection.baseUrl,
          authMode: connection.authMode,
          mcpTransport: process.env.MCP_TRANSPORT_TYPE,
          mcpAuthMode: process.env.MCP_AUTH_MODE ?? 'none',
        },
      );
    }

    // Force a fresh capability load on connect — the agent expects current state.
    await capabilities.invalidate(connection.baseUrl, ctx);
    return buildOrientationEnvelope(ctx, connection, {
      registry: capabilities,
      client,
    });
  },

  format: (result) => [{ type: 'text', text: formatOrientationEnvelope(result) }],
});

/**
 * True when the server is running over HTTP without per-client auth, in which
 * case `ctx.state` collapses every caller into the shared `default` tenant —
 * including the bearer token resolved by SGN/OAuth at connection time.
 */
function isMultiTenantHttpDeployment(): boolean {
  const transport = (process.env.MCP_TRANSPORT_TYPE ?? 'stdio').toLowerCase();
  if (transport !== 'http') return false;
  const authMode = (process.env.MCP_AUTH_MODE ?? 'none').toLowerCase();
  return authMode !== 'jwt' && authMode !== 'oauth';
}
