/**
 * @fileoverview `brapi://study/{studyDbId}` — single-study record on the
 * default connection, with program / trial / location resolved and
 * companion counts attached. Mirror of `brapi_get_study`.
 *
 * @module mcp-server/resources/definitions/brapi-study.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { brapiGetStudy } from '@/mcp-server/tools/definitions/brapi-get-study.tool.js';

export const brapiStudyResource = resource('brapi://study/{studyDbId}', {
  name: 'brapi-study',
  title: 'BrAPI study record',
  description:
    'Single-study resource on the default BrAPI connection — same payload as the brapi_get_study tool, addressable by URI.',
  mimeType: 'application/json',
  errors: [
    {
      reason: 'study_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Upstream returned no study record for the requested DbId',
      recovery:
        'Verify the studyDbId on the target server, or run brapi_find_studies to discover valid IDs.',
    },
  ] as const,
  params: z.object({
    studyDbId: z.string().min(1).describe('Study identifier on the default connection.'),
  }),
  async handler(params, ctx) {
    return await brapiGetStudy.handler(
      brapiGetStudy.input.parse({ studyDbId: params.studyDbId }),
      ctx,
    );
  },
  list: async () => ({
    resources: [],
  }),
});
