/**
 * @fileoverview End-to-end tests for `brapi_get_image` — capability gate,
 * imagecontent fetch path, imageURL fallback, missing-image error rows,
 * input cap of 5 images per call.
 *
 * @module tests/tools/brapi-get-image.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
  const ctx = createMockContext({ tenantId: 't1', errors: brapiGetImage.errors });
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

  it('characterizes mixed metadata failures without discarding valid siblings', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(async (url: string) => {
      if (pathnameOf(url).endsWith('/imagecontent')) return pngResponse();
      return jsonResponse(
        envelope(
          pathnameOf(url).endsWith('/good') ? { imageDbId: 'good', mimeType: 'image/png' } : null,
        ),
      );
    });
    const result = await brapiGetImage.handler(
      brapiGetImage.input.parse({ imageDbIds: ['bad', 'good'] }),
      ctx,
    );
    expect(result.images.map((image) => image.imageDbId)).toEqual(['good']);
    expect(result.errors).toMatchObject([
      { imageDbId: 'bad', error: 'Image metadata missing or malformed.' },
    ]);
  });

  it.each([true, false])(
    'rejects non-image MIME and emits valid media once (dedicated=%s)',
    async (dedicated) => {
      const ctx = await connect(
        fetcher,
        dedicated ? ['images', 'images/{imageDbId}/imagecontent'] : ['images'],
      );
      fetcher.mockImplementation(async (url: string) => {
        const path = pathnameOf(url);
        if (!path.endsWith('/imagecontent') && !path.startsWith('/bytes/')) {
          const id = path.split('/').at(-1)!;
          return jsonResponse(
            envelope({
              imageDbId: id,
              imageURL: `https://cdn.example.org/bytes/${id}`,
              mimeType: 'image/jpeg',
            }),
          );
        }
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: {
            'Content-Type': path.includes('bad')
              ? 'Text/HTML; charset=utf-8'
              : 'IMAGE/PNG; charset=binary',
          },
        });
      });
      const definition = {
        ...brapiGetImage,
        handler: (input, contractCtx) =>
          brapiGetImage.handler(input, { ...contractCtx, state: ctx.state }),
      } satisfies typeof brapiGetImage;
      const result = await runToolContract(
        definition,
        { imageDbIds: ['bad', 'good'] },
        { context: { tenantId: 't1' } },
      );
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        images: [{ imageDbId: 'good', mimeType: 'image/png', sizeBytes: 3 }],
        errors: [{ imageDbId: 'bad', error: expect.stringContaining('text/html') }],
      });
      expect((result.structuredContent as { images: unknown[] }).images).toHaveLength(1);
      expect(JSON.stringify(result.structuredContent)).not.toContain('AQID');
      expect(result.content.filter((block) => block.type === 'image')).toEqual([
        { type: 'image', data: 'AQID', mimeType: 'image/png' },
      ]);
      expect(JSON.stringify(result.content)).toContain('text/html');
      const allFailed = await runToolContract(
        definition,
        { imageDbIds: ['bad'] },
        { context: { tenantId: 't1' } },
      );
      expect(allFailed.isError).not.toBe(true);
      expect(allFailed.structuredContent).toMatchObject({
        images: [],
        errors: [{ imageDbId: 'bad', error: expect.stringContaining('text/html') }],
      });
      expect(allFailed.content.filter((block) => block.type === 'image')).toEqual([]);
      expect(JSON.stringify(allFailed.content)).toContain('text/html');
    },
  );

  it.each([true, false])(
    'uses metadata MIME when the byte response has no MIME (dedicated=%s)',
    async (dedicated) => {
      const ctx = await connect(
        fetcher,
        dedicated ? ['images', 'images/{imageDbId}/imagecontent'] : ['images'],
      );
      fetcher.mockImplementation(async (url: string) => {
        const path = pathnameOf(url);
        if (path.endsWith('/images/fallback'))
          return jsonResponse(
            envelope({
              imageDbId: 'fallback',
              mimeType: 'IMAGE/JPEG; quality=90',
              imageURL: 'https://cdn.example.org/fallback',
            }),
          );
        return new Response(new Uint8Array([1, 2, 3]));
      });
      const result = await brapiGetImage.handler(
        brapiGetImage.input.parse({ imageDbIds: ['fallback'] }),
        ctx,
      );
      expect(result.images[0]?.mimeType).toBe('image/jpeg');
      expect(result.errors).toEqual([]);
    },
  );

  it('keeps the five-image boundary and rejects empty input and oversize bytes', async () => {
    expect(brapiGetImage.input.safeParse({ imageDbIds: [] }).success).toBe(false);
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(async (url: string) =>
      pathnameOf(url).endsWith('/imagecontent')
        ? pngResponse()
        : jsonResponse(envelope({ imageDbId: pathnameOf(url).split('/').at(-1) })),
    );
    const result = await brapiGetImage.handler(
      brapiGetImage.input.parse({ imageDbIds: ['1', '2', '3', '4', '5'] }),
      ctx,
    );
    expect(result.images).toHaveLength(5);
    fetcher.mockImplementation(async (url: string) =>
      pathnameOf(url).endsWith('/imagecontent')
        ? new Response(new Uint8Array(20 * 1024 * 1024 + 1), {
            headers: { 'Content-Type': 'image/png' },
          })
        : jsonResponse(envelope({ imageDbId: 'large' })),
    );
    const oversized = await brapiGetImage.handler(
      brapiGetImage.input.parse({ imageDbIds: ['large'] }),
      ctx,
    );
    expect(oversized.images).toEqual([]);
    expect(oversized.errors[0]?.error).toContain('cap');
  });

  it('propagates cancellation rather than treating it as a per-image error', async () => {
    const ctx = await connect(fetcher);
    const controller = new AbortController();
    fetcher.mockImplementation(async (url: string) => {
      if (pathnameOf(url).endsWith('/imagecontent')) {
        controller.abort();
        throw controller.signal.reason;
      }
      return jsonResponse(
        envelope({ imageDbId: 'cancel', imageURL: 'https://cdn.example.org/cancel' }),
      );
    });
    await expect(
      brapiGetImage.handler(brapiGetImage.input.parse({ imageDbIds: ['cancel'] }), {
        ...ctx,
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();
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
    expect(result.images[0]?.sizeBytes).toBeGreaterThan(0);
    expect(result.images[0]).not.toHaveProperty('data');
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

  it('returns a per-image error when the imageURL fallback returns non-image bytes', async () => {
    const ctx = await connect(fetcher, ['images']); // no imagecontent
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/images/img-html')) {
        return jsonResponse(
          envelope({
            imageDbId: 'img-html',
            imageURL: 'https://broken.example.org/missing.jpg',
          }),
        );
      }
      // The CDN URL serves an HTML error page rather than image bytes.
      if (String(url).startsWith('https://broken.example.org/')) {
        return new Response('<html>404 not found</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      throw new Error(`Unexpected path: ${url}`);
    });

    const result = await brapiGetImage.handler(
      brapiGetImage.input.parse({ imageDbIds: ['img-html'] }),
      ctx,
    );
    expect(result.images).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.imageDbId).toBe('img-html');
    expect(result.errors[0]?.error).toContain('text/html');
  });

  it('prefixes https:// when imageURL is schemeless but domain-shaped', async () => {
    const ctx = await connect(fetcher, ['images']); // no imagecontent
    let fetchedUrl = '';
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/images/img-bare')) {
        return jsonResponse(
          envelope({
            imageDbId: 'img-bare',
            // Real Breedbase shape: schemeless host + absolute path on that host.
            imageURL: 'breedbase.org/data/images/abc/medium.jpg',
            mimeType: 'image/jpeg',
          }),
        );
      }
      fetchedUrl = String(url);
      if (fetchedUrl.startsWith('https://breedbase.org/')) return pngResponse();
      throw new Error(`Unexpected path: ${url}`);
    });

    const result = await brapiGetImage.handler(
      brapiGetImage.input.parse({ imageDbIds: ['img-bare'] }),
      ctx,
    );
    expect(result.images).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
    // The fallback must have rewritten the schemeless domain to https://, not
    // concatenated it under the baseUrl.
    expect(fetchedUrl).toBe('https://breedbase.org/data/images/abc/medium.jpg');
  });

  it('prefixes https: when imageURL is protocol-relative (//host/path)', async () => {
    const ctx = await connect(fetcher, ['images']);
    let fetchedUrl = '';
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/images/img-protorel')) {
        return jsonResponse(
          envelope({
            imageDbId: 'img-protorel',
            imageURL: '//cdn.example.org/plot.jpg',
            mimeType: 'image/jpeg',
          }),
        );
      }
      fetchedUrl = String(url);
      if (fetchedUrl.startsWith('https://cdn.example.org/')) return pngResponse();
      throw new Error(`Unexpected path: ${url}`);
    });

    const result = await brapiGetImage.handler(
      brapiGetImage.input.parse({ imageDbIds: ['img-protorel'] }),
      ctx,
    );
    expect(result.images).toHaveLength(1);
    expect(fetchedUrl).toBe('https://cdn.example.org/plot.jpg');
  });

  it('collapses double slashes in the resolved imageURL pathname', async () => {
    const ctx = await connect(fetcher, ['images']);
    let fetchedUrl = '';
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/images/img-dbl')) {
        return jsonResponse(
          envelope({
            imageDbId: 'img-dbl',
            // T3 ships absolute URLs with a stray double slash between host
            // and path — verbatim fetch 404s; the resolver normalizes them.
            imageURL: 'https://wheat.triticeaetoolbox.org//data/images/abc.jpg',
            mimeType: 'image/jpeg',
          }),
        );
      }
      fetchedUrl = String(url);
      if (fetchedUrl.startsWith('https://wheat.triticeaetoolbox.org/')) return pngResponse();
      throw new Error(`Unexpected path: ${url}`);
    });

    const result = await brapiGetImage.handler(
      brapiGetImage.input.parse({ imageDbIds: ['img-dbl'] }),
      ctx,
    );
    expect(result.images).toHaveLength(1);
    expect(fetchedUrl).toBe('https://wheat.triticeaetoolbox.org/data/images/abc.jpg');
  });

  it('strips null metadata fields on SGN-family dialects before output validation', async () => {
    // Server-name matches the CassavaBase dialect; the normalizer must run
    // on the singleton /images/{id} response so `description: null` doesn't
    // reach z.string().optional() and trigger output-schema rejection.
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/serverinfo')) {
        return jsonResponse(
          envelope({
            serverName: 'CassavaBase',
            calls: [
              { service: 'images', methods: ['GET'], versions: ['2.1'] },
              {
                service: 'images/{imageDbId}/imagecontent',
                methods: ['GET'],
                versions: ['2.1'],
              },
            ],
          }),
        );
      }
      if (path.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: [] }));
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });
    const ctx = createMockContext({ tenantId: 't1', errors: brapiGetImage.errors });
    await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
    fetcher.mockReset();

    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/images/img-sparse')) {
        return jsonResponse(
          envelope({
            imageDbId: 'img-sparse',
            imageName: 'plot-7',
            description: null,
            copyright: null,
            mimeType: 'image/png',
          }),
        );
      }
      if (path.endsWith('/images/img-sparse/imagecontent')) return pngResponse();
      throw new Error(`Unexpected path: ${path}`);
    });

    const result = await brapiGetImage.handler(
      brapiGetImage.input.parse({ imageDbIds: ['img-sparse'] }),
      ctx,
    );
    expect(result.images).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
    expect(result.images[0]?.metadata.description).toBeUndefined();
    expect(result.images[0]?.metadata.copyright).toBeUndefined();
  });

  it('coerces numeric-string imageHeight/imageWidth into numbers', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/images/img-coerce')) {
        return jsonResponse(
          envelope({
            imageDbId: 'img-coerce',
            // T3 / Breedbase commonly serialize these as strings; the schema
            // coerces so output validation doesn't reject the payload.
            imageHeight: '480',
            imageWidth: '640',
            mimeType: 'image/png',
          }),
        );
      }
      if (path.endsWith('/images/img-coerce/imagecontent')) return pngResponse();
      throw new Error(`Unexpected path: ${path}`);
    });

    const result = await brapiGetImage.handler(
      brapiGetImage.input.parse({ imageDbIds: ['img-coerce'] }),
      ctx,
    );
    // The framework parses output at the boundary; verify the schema does the
    // coercion so a string-typed upstream doesn't fail output validation.
    const parsed = brapiGetImage.output.parse(result);
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.metadata.imageHeight).toBe(480);
    expect(parsed.images[0]?.metadata.imageWidth).toBe(640);
  });

  it('concatenates baseUrl when imageURL is a root-relative path', async () => {
    const ctx = await connect(fetcher, ['images']);
    let fetchedUrl = '';
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/images/img-rel')) {
        return jsonResponse(
          envelope({
            imageDbId: 'img-rel',
            imageURL: '/files/plot.jpg',
            mimeType: 'image/jpeg',
          }),
        );
      }
      fetchedUrl = String(url);
      if (fetchedUrl.endsWith('/files/plot.jpg')) return pngResponse();
      throw new Error(`Unexpected path: ${url}`);
    });

    const result = await brapiGetImage.handler(
      brapiGetImage.input.parse({ imageDbIds: ['img-rel'] }),
      ctx,
    );
    expect(result.images).toHaveLength(1);
    expect(fetchedUrl).toBe(`${BASE_URL}/files/plot.jpg`);
  });

  it('format() emits metadata text without repeating media', async () => {
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
    expect(blocks.every((b) => b.type === 'text')).toBe(true);
  });
});
