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
    'Orientation envelope for the default BrAPI connection — identity, capabilities, content counts, notes. Same payload as the brapi_server_info tool.',
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
