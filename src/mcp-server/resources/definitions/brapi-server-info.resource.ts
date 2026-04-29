/**
 * @fileoverview `brapi://server/info` — orientation envelope for the default
 * connection. Mirror of `brapi_server_info` for clients that prefer the
 * resource surface. Reads the cached capability profile.
 *
 * @module mcp-server/resources/definitions/brapi-server-info.resource
 */

import { resource } from '@cyanheads/mcp-ts-core';
import { brapiServerInfo } from '@/mcp-server/tools/definitions/brapi-server-info.tool.js';

export const brapiServerInfoResource = resource('brapi://server/info', {
  name: 'brapi-server-info',
  title: 'BrAPI server orientation envelope',
  description:
    'Orientation envelope for the default BrAPI connection — identity, capabilities, content counts, notes. Same payload as the brapi_server_info tool.',
  mimeType: 'application/json',
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
