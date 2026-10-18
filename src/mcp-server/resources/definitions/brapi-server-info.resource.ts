/**
 * @fileoverview `brapi://server/info` — orientation envelope for the default
 * connection. Mirror of `brapi_server_info` for clients that prefer the
 * resource surface. Reads the cached capability profile.
 *
 * @module mcp-server/resources/definitions/brapi-server-info.resource
 */

import { resource } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { brapiServerInfo } from '@/mcp-server/tools/definitions/brapi-server-info.tool.js';

export const brapiServerInfoResource = resource('brapi://server/info', {
  name: 'brapi-server-info',
  title: 'BrAPI server orientation envelope',
  description:
    'Orientation envelope for the default BrAPI connection — identity, capabilities, content counts, suggested finders, notes. Same payload as the brapi_server_info tool.',
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
  ] as const,
  async handler(_params, ctx) {
    return await brapiServerInfo.handler(brapiServerInfo.input.parse({}), ctx);
  },
  list: async () => ({
    resources: [
      {
        uri: 'brapi://server/info',
        name: 'BrAPI server orientation envelope',
        mimeType: 'application/json',
      },
    ],
  }),
});
