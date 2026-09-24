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
import { config } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  AUTH_BASE_URL_MISMATCH_RECOVERY,
  discoverConfiguredAliases,
  formatConfiguredAliasesHint,
  resolveConnectInput,
} from '@/config/alias-credentials.js';
import { getBrapiClient } from '@/services/brapi-client/index.js';
import {
  type CapabilityLookupOptions,
  getCapabilityRegistry,
} from '@/services/capability-registry/index.js';
import { getServerRegistry } from '@/services/server-registry/index.js';
import { ConnectAuthSchema } from '../shared/connect-auth-schema.js';
import {
  buildOrientationEnvelope,
  formatOrientationEnvelope,
  OrientationEnvelopeSchema,
} from '../shared/orientation-envelope.js';

const BASE_DESCRIPTION =
  'Open a connection to a BrAPI v2 server, authenticate, and return the full orientation envelope (server identity, capability profile, content summary, suggested next tools). Required handshake before other BrAPI tools. Supports multiple concurrent connections via named aliases. Credentials can be configured server-side and omitted from this call. When a request carries no MCP session on a deployment without per-user auth, aliases live in one namespace shared by every such caller: re-registering an alias re-points their later calls to it.';

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
      reason: 'auth_session_required',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Caller-supplied credentials on an HTTP deployment without per-user auth, from a request that carries no MCP session',
      recovery:
        'Connect from a client that keeps an MCP session (2025-era Streamable HTTP) or over stdio, use a deployment with MCP_AUTH_MODE=jwt or oauth, or omit `auth` to use server-configured credentials or none.',
      retryable: false,
    },
    {
      reason: 'auth_base_url_mismatch',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The alias has server-configured credentials and the supplied baseUrl differs from the server configured for it',
      recovery: AUTH_BASE_URL_MISMATCH_RECOVERY,
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'alias_base_url_unset',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'The alias has server-configured credentials but no base URL of its own (no BRAPI_<ALIAS>_BASE_URL and no enabled built-in), so they pair with no server',
      recovery:
        'Set BRAPI_<ALIAS>_BASE_URL on the server for this alias, or remove its credential variables, before retrying.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'auth_token_exchange_failed',
      code: JsonRpcErrorCode.Forbidden,
      when: 'SGN or OAuth token exchange against the BrAPI /token endpoint failed',
      recovery: 'Verify the credentials and that the server exposes /token before retrying.',
      thrownBy: 'service',
    },
    {
      reason: 'auth_no_access_token',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Token endpoint responded but did not return an access_token',
      recovery:
        'Confirm the credentials are valid and the upstream IdP issues access tokens for this grant.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unauthorized',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'The server answered HTTP 401 on /serverinfo or /calls — it requires login for capability discovery',
      recovery:
        'Retry brapi_connect with credentials in `auth` (sgn, bearer, api_key, or oauth2), or ask the operator to configure credentials for this alias server-side.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The server answered HTTP 403 on /serverinfo or /calls — the request (anonymous or credentialed) lacks read access',
      recovery:
        'Retry brapi_connect with credentials that have read access to this server, or ask the operator to configure such credentials for this alias server-side.',
      thrownBy: 'service',
    },
  ] as const,
  input: z.object({
    baseUrl: z
      .string()
      .optional()
      .describe(
        'BrAPI v2 base URL (absolute URL) including any path prefix — e.g. https://test-server.brapi.org/brapi/v2. Omit to use the configured default for this alias.',
      ),
    auth: ConnectAuthSchema.optional().describe(
      'Auth payload. Omit to use credentials configured server-side for this alias (or no auth when none are configured).',
    ),
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

    // Credentialed state fails closed: without a session or per-user auth the
    // exchanged header would sit where every other session-less caller reads it.
    if (
      input.auth &&
      input.auth.mode !== 'none' &&
      isSharedTenantHttp() &&
      registry.isolationFallsBackToShared(ctx)
    ) {
      throw ctx.fail(
        'auth_session_required',
        'Caller-supplied credentials are refused: this HTTP deployment has no per-user auth and the request carries no MCP session, so the connection would be shared with every other session-less caller.',
        { ...ctx.recoveryFor('auth_session_required') },
      );
    }

    const resolved = resolveConnectInput(input.alias, {
      baseUrl: input.baseUrl,
      auth: input.auth,
    });

    // Nothing persists until the connection has proven itself: token exchange
    // and a fresh capability fetch run first, so any failure leaves the previous
    // registration under this alias (and its cached profile) as it was.
    const connection = await registry.resolve(ctx, {
      alias: input.alias,
      baseUrl: resolved.baseUrl,
      auth: resolved.auth,
    });
    const profileLookup: CapabilityLookupOptions = { forceRefresh: true };
    if (connection.resolvedAuth) profileLookup.auth = connection.resolvedAuth;
    await capabilities.profile(connection.baseUrl, ctx, profileLookup);
    await registry.save(ctx, connection);

    ctx.log.info('BrAPI connection registered', {
      alias: connection.alias,
      baseUrl: connection.baseUrl,
      authMode: connection.authMode,
      authSource: input.auth ? 'agent' : 'env',
    });

    if (isSharedTenantHttp() && connection.authMode !== 'none') {
      ctx.log.notice(
        'Connection credentials persisted under shared `default` tenant — set MCP_AUTH_MODE=jwt|oauth for per-client isolation.',
        {
          alias: connection.alias,
          baseUrl: connection.baseUrl,
          authMode: connection.authMode,
          mcpTransport: config.mcpTransportType,
          mcpAuthMode: config.mcpAuthMode,
        },
      );
    }

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
function isSharedTenantHttp(): boolean {
  return config.mcpTransportType === 'http' && config.mcpAuthMode === 'none';
}
