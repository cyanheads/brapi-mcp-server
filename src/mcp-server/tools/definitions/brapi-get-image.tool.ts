/**
 * @fileoverview `brapi_get_image` — fetch image bytes for up to 5 imageDbIds
 * and return them inline as `type: image` content blocks. Tries the BrAPI
 * `/images/{id}/imagecontent` endpoint when the server advertises it;
 * otherwise falls back to the `imageURL` field from the image metadata.
 * Hard cap of 5 images per call to prevent context explosion.
 *
 * @module mcp-server/tools/definitions/brapi-get-image.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { type BrapiClient, getBrapiClient } from '@/services/brapi-client/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import { DEFAULT_ALIAS, getServerRegistry } from '@/services/server-registry/index.js';
import type { RegisteredServer } from '@/services/server-registry/types.js';
import { AliasInput, buildRequestOptions } from '../shared/find-helpers.js';

const MAX_IMAGES_PER_CALL = 5;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB

const ImageMetadataSchema = z
  .object({
    imageDbId: z.string().describe('Server-side identifier for the image.'),
    imageName: z.string().optional().describe('Display name.'),
    imageFileName: z.string().optional().describe('Original uploaded filename.'),
    imageHeight: z.number().optional().describe('Pixel height.'),
    imageWidth: z.number().optional().describe('Pixel width.'),
    mimeType: z.string().optional().describe('MIME type (e.g. "image/jpeg").'),
    imageURL: z.string().optional().describe('URL where the bytes live.'),
    observationUnitDbId: z
      .string()
      .optional()
      .describe('FK to the observation unit this image depicts.'),
    observationUnitName: z.string().optional().describe('Display name of the observation unit.'),
    studyDbId: z.string().optional().describe('FK to the study the image belongs to.'),
    studyName: z.string().optional().describe('Display name of the study.'),
    imageTimeStamp: z.string().optional().describe('ISO 8601 capture timestamp.'),
    copyright: z.string().optional().describe('Copyright or rights notice.'),
    description: z.string().optional().describe('Free-text description.'),
  })
  .passthrough();

const ImagePayloadSchema = z
  .object({
    imageDbId: z.string().describe('Server-side identifier for the image.'),
    mimeType: z.string().describe('Actual MIME type of the returned bytes.'),
    sizeBytes: z.number().int().nonnegative().describe('Size of the returned byte payload.'),
    source: z.enum(['imagecontent', 'imageURL']).describe('How the bytes were fetched.'),
    data: z.string().describe('Base64-encoded image bytes.'),
    metadata: ImageMetadataSchema.describe('Upstream metadata for this image.'),
  })
  .describe('Successfully loaded image payload.');

const ImageErrorSchema = z
  .object({
    imageDbId: z.string().describe('Image identifier the error applies to.'),
    error: z.string().describe('Reason the image could not be loaded.'),
  })
  .describe('Per-image error entry returned when a fetch fails.');

const OutputSchema = z.object({
  alias: z.string().describe('Alias of the registered BrAPI connection the call used.'),
  images: z.array(ImagePayloadSchema).describe('Successfully loaded images.'),
  errors: z.array(ImageErrorSchema).describe('Images that could not be loaded, one entry per id.'),
});

type Output = z.infer<typeof OutputSchema>;

export const brapiGetImage = tool('brapi_get_image', {
  description: `Fetch image bytes for up to ${MAX_IMAGES_PER_CALL} imageDbIds and return them inline as \`type: image\` content blocks. Prefers the BrAPI \`/images/{id}/imagecontent\` endpoint; falls back to the \`imageURL\` field when the server doesn't implement imagecontent. Companion: brapi_find_images locates candidate imageDbIds. No filesystem side-effects.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'images_unsupported',
      code: JsonRpcErrorCode.NotFound,
      when: 'BrAPI server does not advertise /images in /serverinfo',
      recovery:
        'Confirm the upstream server exposes BrAPI image endpoints; otherwise no images can be fetched.',
    },
  ] as const,
  input: z.object({
    imageDbIds: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_IMAGES_PER_CALL)
      .describe(`1–${MAX_IMAGES_PER_CALL} image identifiers.`),
    alias: AliasInput,
  }),
  output: OutputSchema,

  async handler(input, ctx) {
    const registry = getServerRegistry();
    const capabilities = getCapabilityRegistry();
    const client = getBrapiClient();

    const connection = await registry.get(ctx, input.alias ?? DEFAULT_ALIAS);

    const capabilityLookup: { auth?: typeof connection.resolvedAuth } = {};
    if (connection.resolvedAuth) capabilityLookup.auth = connection.resolvedAuth;
    const profile = await capabilities.profile(connection.baseUrl, ctx, capabilityLookup);
    if (!profile.supported.images) {
      throw ctx.fail(
        'images_unsupported',
        `BrAPI server at ${connection.baseUrl} does not advertise '/images'. Cannot fetch image bytes.`,
        { baseUrl: connection.baseUrl, ...ctx.recoveryFor('images_unsupported') },
      );
    }
    const hasImageContent = Boolean(profile.supported['images/{imageDbId}/imagecontent']);

    const loaded = await Promise.all(
      input.imageDbIds.map((id) => fetchOne(id, hasImageContent, connection, client, ctx)),
    );

    const images: z.infer<typeof ImagePayloadSchema>[] = [];
    const errors: z.infer<typeof ImageErrorSchema>[] = [];
    for (const entry of loaded) {
      if (entry.kind === 'ok') images.push(entry.payload);
      else errors.push(entry);
    }

    const result: Output = {
      alias: connection.alias,
      images,
      errors,
    };
    return result;
  },

  format: (result) => {
    const blocks: (
      | { type: 'text'; text: string }
      | { type: 'image'; data: string; mimeType: string }
    )[] = [];
    const header: string[] = [];
    header.push(`# ${result.images.length} image(s) loaded — \`${result.alias}\``);
    if (result.errors.length > 0) {
      header.push(`⚠ ${result.errors.length} failed — see below.`);
    }
    blocks.push({ type: 'text', text: header.join('\n') });

    for (const img of result.images) {
      const meta = img.metadata;
      const lines: string[] = [];
      const label = meta.imageName ?? meta.imageFileName ?? img.imageDbId;
      lines.push(`## ${label}`);
      lines.push(`- imageDbId: \`${img.imageDbId}\``);
      lines.push(`- mimeType: ${img.mimeType}`);
      lines.push(`- sizeBytes: ${img.sizeBytes}`);
      lines.push(`- source: ${img.source}`);
      lines.push(`- metadata.imageDbId: \`${meta.imageDbId}\``);
      if (meta.mimeType) lines.push(`- metadata.mimeType: ${meta.mimeType}`);
      if (meta.imageFileName) lines.push(`- imageFileName: ${meta.imageFileName}`);
      if (meta.imageWidth && meta.imageHeight) {
        lines.push(`- dimensions: ${meta.imageWidth}×${meta.imageHeight}`);
      }
      if (meta.observationUnitName)
        lines.push(`- observationUnitName: ${meta.observationUnitName}`);
      if (meta.observationUnitDbId)
        lines.push(`- observationUnitDbId: ${meta.observationUnitDbId}`);
      if (meta.studyName) lines.push(`- studyName: ${meta.studyName}`);
      if (meta.studyDbId) lines.push(`- studyDbId: ${meta.studyDbId}`);
      if (meta.imageTimeStamp) lines.push(`- imageTimeStamp: ${meta.imageTimeStamp}`);
      if (meta.imageURL) lines.push(`- imageURL: ${meta.imageURL}`);
      if (meta.copyright) lines.push(`- copyright: ${meta.copyright}`);
      if (meta.description) lines.push(`- description: ${meta.description}`);
      blocks.push({ type: 'text', text: lines.join('\n') });
      blocks.push({
        type: 'image',
        data: img.data,
        mimeType: img.mimeType,
      });
    }
    for (const err of result.errors) {
      blocks.push({ type: 'text', text: `### ${err.imageDbId} — failed\n- error: ${err.error}` });
    }
    return blocks;
  },
});

type FetchResult =
  | { kind: 'ok'; payload: z.infer<typeof ImagePayloadSchema> }
  | { kind: 'error'; imageDbId: string; error: string };

async function fetchOne(
  imageDbId: string,
  hasImageContent: boolean,
  connection: RegisteredServer,
  client: BrapiClient,
  ctx: Parameters<typeof client.get>[2],
): Promise<FetchResult> {
  try {
    const id = encodeURIComponent(imageDbId);
    const metaEnv = await client.get<Record<string, unknown>>(
      connection.baseUrl,
      `/images/${id}`,
      ctx,
      buildRequestOptions(connection),
    );
    const metadata = metaEnv.result;
    if (!metadata || typeof metadata !== 'object' || !metadata.imageDbId) {
      return { kind: 'error', imageDbId, error: 'Image metadata missing or malformed.' };
    }

    const fetched = await fetchBytes({
      client,
      connection,
      ctx,
      imageDbId: id,
      hasImageContent,
      imageUrl: typeof metadata.imageURL === 'string' ? metadata.imageURL : undefined,
    });
    if (!fetched) {
      return {
        kind: 'error',
        imageDbId,
        error: 'Server does not expose /images/{id}/imagecontent and no imageURL was returned.',
      };
    }
    if (fetched.bytes.byteLength > MAX_IMAGE_BYTES) {
      return {
        kind: 'error',
        imageDbId,
        error: `Image exceeds ${MAX_IMAGE_BYTES} byte cap (actual: ${fetched.bytes.byteLength}).`,
      };
    }

    const mimeType =
      fetched.mimeType ??
      (typeof metadata.mimeType === 'string' ? metadata.mimeType : 'application/octet-stream');

    return {
      kind: 'ok',
      payload: {
        imageDbId,
        mimeType,
        sizeBytes: fetched.bytes.byteLength,
        source: fetched.source,
        data: toBase64(fetched.bytes),
        metadata: metadata as z.infer<typeof ImageMetadataSchema>,
      },
    };
  } catch (err) {
    return {
      kind: 'error',
      imageDbId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface FetchBytesInput {
  client: BrapiClient;
  connection: RegisteredServer;
  ctx: Parameters<BrapiClient['get']>[2];
  hasImageContent: boolean;
  imageDbId: string;
  imageUrl: string | undefined;
}

async function fetchBytes(
  input: FetchBytesInput,
): Promise<
  { bytes: Uint8Array; mimeType?: string; source: 'imagecontent' | 'imageURL' } | undefined
> {
  if (input.hasImageContent) {
    try {
      const binary = await input.client.getBinary(
        input.connection.baseUrl,
        `/images/${input.imageDbId}/imagecontent`,
        input.ctx,
        buildRequestOptions(input.connection),
      );
      return {
        bytes: binary.bytes,
        mimeType: binary.contentType,
        source: 'imagecontent',
      };
    } catch (err) {
      input.ctx.log.warning('imagecontent endpoint failed, falling back to imageURL', {
        imageDbId: input.imageDbId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (!input.imageUrl) return;
  const resolved = resolveImageUrl(input.connection.baseUrl, input.imageUrl);
  const binary = await input.client.fetchBinaryUrl(resolved, input.ctx);
  return {
    bytes: binary.bytes,
    mimeType: binary.contentType,
    source: 'imageURL',
  };
}

function resolveImageUrl(baseUrl: string, imageUrl: string): string {
  if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) return imageUrl;
  const trimmed = baseUrl.replace(/\/$/, '');
  const prefixed = imageUrl.startsWith('/') ? imageUrl : `/${imageUrl}`;
  return `${trimmed}${prefixed}`;
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
