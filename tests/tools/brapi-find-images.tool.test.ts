/**
 * @fileoverview End-to-end tests for `brapi_find_images` — capability gate,
 * filter forwarding, distribution computation across MIME / study / unit /
 * ontology terms, dataset spillover, sparse upstream rows.
 *
 * @module tests/tools/brapi-find-images.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiFindImages } from '@/mcp-server/tools/definitions/brapi-find-images.tool.js';
import {
  BASE_URL,
  envelope,
  initTestServices,
  jsonResponse,
  type MockFetcher,
  pathnameOf,
  resetTestServices,
} from './_tool-test-helpers.js';

function imgRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    imageDbId: 'img-1',
    imageName: 'plot-001',
    imageFileName: 'plot-001.jpg',
    mimeType: 'image/jpeg',
    studyDbId: 's-1',
    studyName: 'Cassava 2022',
    observationUnitDbId: 'ou-1',
    observationUnitName: 'plot-001',
    descriptiveOntologyTerms: ['CO_334:plot'],
    imageWidth: 1024,
    imageHeight: 768,
    ...extra,
  };
}

async function connect(fetcher: MockFetcher, calls = ['images']) {
  fetcher.mockImplementation(async (url: string) => {
    const path = pathnameOf(url);
    if (path.endsWith('/serverinfo')) {
      return jsonResponse(
        envelope({
          serverName: 'Test',
          calls: calls.map((service) => ({ service, methods: ['GET'], versions: ['2.1'] })),
        }),
      );
    }
    if (path.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: [] }));
    return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
  });
  const ctx = createMockContext({ tenantId: 't1' });
  await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
  fetcher.mockReset();
  return ctx;
}

describe('brapi_find_images tool', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('returns rows with distributions across MIME, study, ontology, unit', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      imgRow(),
      imgRow({ imageDbId: 'img-2', mimeType: 'image/png' }),
      imgRow({
        imageDbId: 'img-3',
        descriptiveOntologyTerms: ['CO_334:plot', 'CO_334:canopy'],
      }),
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiFindImages.handler(
      brapiFindImages.input.parse({ studies: ['s-1'], mimeTypes: ['image/jpeg', 'image/png'] }),
      ctx,
    );

    expect(result.returnedCount).toBe(3);
    expect(result.distributions.mimeType).toEqual({ 'image/jpeg': 2, 'image/png': 1 });
    expect(result.distributions.descriptiveOntologyTerms).toEqual({
      'CO_334:plot': 3,
      'CO_334:canopy': 1,
    });

    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.getAll('studyDbIds')).toEqual(['s-1']);
    expect(url.searchParams.getAll('mimeTypes')).toEqual(['image/jpeg', 'image/png']);
  });

  it('throws ValidationError when /images is not advertised', async () => {
    const ctx = await connect(fetcher, ['studies']);
    await expect(
      brapiFindImages.handler(brapiFindImages.input.parse({}), ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
  });

  it('handles sparse rows with no descriptiveOntologyTerms field', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(
      jsonResponse(envelope({ data: [{ imageDbId: 'img-only-id' }] }, { totalCount: 1 })),
    );
    const result = await brapiFindImages.handler(brapiFindImages.input.parse({}), ctx);
    expect(result.returnedCount).toBe(1);
    expect(Object.keys(result.distributions.descriptiveOntologyTerms)).toHaveLength(0);
  });

  it('format() renders image metadata including mime, dims, study', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [imgRow()] }, { totalCount: 1 })));
    const result = await brapiFindImages.handler(brapiFindImages.input.parse({}), ctx);
    const text = (brapiFindImages.format!(result)[0] as { text: string }).text;
    expect(text).toContain('img-1');
    expect(text).toContain('image/jpeg');
    expect(text).toContain('1024×768');
    expect(text).toContain('Cassava 2022');
  });
});
