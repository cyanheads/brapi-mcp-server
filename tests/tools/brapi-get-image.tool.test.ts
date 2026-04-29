/**
 * @fileoverview End-to-end tests for `brapi_get_image` — capability gate,
 * imagecontent fetch path, imageURL fallback, missing-image error rows,
 * input cap of 5 images per call.
 *
 * @module tests/tools/brapi-get-image.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiGetImage } from '@/mcp-server/tools/definitions/brapi-get-image.tool.js';
import {
  BASE_URL,
  envelope,
  initTestServices,
  jsonResponse,
  type MockFetcher,
  pathnameOf,
  resetTestServices,
} from './_tool-test-helpers.js';

function pngResponse(): Response {
  // Tiny 1×1 transparent PNG bytes
  const bytes = new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0,
    0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5, 0, 1, 13, 10,
    45, 180, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
  ]);
  return new Response(bytes, {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  });
}

async function connect(
  fetcher: MockFetcher,
  calls = ['images', 'images/{imageDbId}/imagecontent'],
) {
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

describe('brapi_get_image tool', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('fetches image bytes via /imagecontent when the server advertises it', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/images/img-1')) {
        return jsonResponse(
          envelope({ imageDbId: 'img-1', imageName: 'plot-1', mimeType: 'image/png' }),
        );
      }
      if (path.endsWith('/images/img-1/imagecontent')) return pngResponse();
      throw new Error(`Unexpected path: ${path}`);
    });

    const result = await brapiGetImage.handler(
      brapiGetImage.input.parse({ imageDbIds: ['img-1'] }),
      ctx,
    );

    expect(result.images).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
    expect(result.images[0]?.mimeType).toBe('image/png');
    expect(result.images[0]?.source).toBe('imagecontent');
    expect(result.images[0]?.data.length).toBeGreaterThan(0);
  });

  it('falls back to imageURL when /imagecontent is unavailable', async () => {
    const ctx = await connect(fetcher, ['images']); // no imagecontent capability
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/images/img-2')) {
        return jsonResponse(
          envelope({
            imageDbId: 'img-2',
            imageURL: 'https://cdn.example.org/plot-2.png',
            mimeType: 'image/png',
          }),
        );
      }
      // The CDN fetch goes through fetchBinaryUrl
      if (String(url).startsWith('https://cdn.example.org/')) return pngResponse();
      throw new Error(`Unexpected path: ${url}`);
    });

    const result = await brapiGetImage.handler(
      brapiGetImage.input.parse({ imageDbIds: ['img-2'] }),
      ctx,
    );
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.source).toBe('imageURL');
  });

  it('records an error row when no image bytes can be obtained', async () => {
    const ctx = await connect(fetcher, ['images']); // no imagecontent
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/images/img-3')) {
        return jsonResponse(envelope({ imageDbId: 'img-3' })); // no imageURL either
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const result = await brapiGetImage.handler(
      brapiGetImage.input.parse({ imageDbIds: ['img-3'] }),
      ctx,
    );
    expect(result.images).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain('imagecontent');
  });

  it('throws NotFound when the server does not advertise /images at all', async () => {
    const ctx = await connect(fetcher, ['studies']); // no images capability
    await expect(
      brapiGetImage.handler(brapiGetImage.input.parse({ imageDbIds: ['img-1'] }), ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
  });

  it('rejects more than 5 imageDbIds at input parse time', () => {
    expect(() =>
      brapiGetImage.input.parse({ imageDbIds: ['1', '2', '3', '4', '5', '6'] }),
    ).toThrow();
  });

  it('format() emits text + image content blocks', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/images/img-1')) {
        return jsonResponse(envelope({ imageDbId: 'img-1', mimeType: 'image/png' }));
      }
      if (path.endsWith('/images/img-1/imagecontent')) return pngResponse();
      throw new Error(`Unexpected path: ${path}`);
    });
    const result = await brapiGetImage.handler(
      brapiGetImage.input.parse({ imageDbIds: ['img-1'] }),
      ctx,
    );
    const blocks = brapiGetImage.format!(result);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    expect(blocks.some((b) => b.type === 'image')).toBe(true);
  });
});
