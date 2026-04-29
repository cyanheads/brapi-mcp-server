/**
 * @fileoverview `brapi://study/{studyDbId}` — single-study record on the
 * default connection, with program / trial / location resolved and
 * companion counts attached. Mirror of `brapi_get_study`.
 *
 * @module mcp-server/resources/definitions/brapi-study.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { brapiGetStudy } from '@/mcp-server/tools/definitions/brapi-get-study.tool.js';

export const brapiStudyResource = resource('brapi://study/{studyDbId}', {
  name: 'brapi-study',
  title: 'BrAPI study record',
  description:
    'Single-study resource on the default BrAPI connection — same payload as the brapi_get_study tool, addressable by URI.',
  mimeType: 'application/json',
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
