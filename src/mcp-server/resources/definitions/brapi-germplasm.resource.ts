/**
 * @fileoverview `brapi://germplasm/{germplasmDbId}` — single-germplasm record
 * on the default connection, with attributes, parents, and companion counts.
 * Mirror of `brapi_get_germplasm`.
 *
 * @module mcp-server/resources/definitions/brapi-germplasm.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { brapiGetGermplasm } from '@/mcp-server/tools/definitions/brapi-get-germplasm.tool.js';

export const brapiGermplasmResource = resource('brapi://germplasm/{germplasmDbId}', {
  name: 'brapi-germplasm',
  title: 'BrAPI germplasm record',
  description:
    'Single-germplasm resource on the default BrAPI connection — same payload as the brapi_get_germplasm tool, addressable by URI.',
  mimeType: 'application/json',
  errors: [
    {
      reason: 'germplasm_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Upstream returned no germplasm record for the requested DbId',
      recovery:
        'Verify the germplasmDbId on the target server, or run brapi_find_germplasm to discover valid IDs.',
    },
  ] as const,
  params: z.object({
    germplasmDbId: z.string().min(1).describe('Germplasm identifier on the default connection.'),
  }),
  async handler(params, ctx) {
    return await brapiGetGermplasm.handler(
      brapiGetGermplasm.input.parse({ germplasmDbId: params.germplasmDbId }),
      ctx,
    );
  },
  list: async () => ({
    resources: [],
  }),
});
