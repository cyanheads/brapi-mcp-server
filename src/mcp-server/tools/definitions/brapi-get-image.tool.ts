/**
 * @fileoverview `brapi_get_image` — fetch image bytes for up to 5 imageDbIds
 * and return them inline as `type: image` content blocks. Tries the BrAPI
 * `/images/{id}/imagecontent` endpoint when the server advertises it for GET;
 * otherwise, or when that request fails, falls back to the `imageURL` field
 * from the image metadata.
 * Hard cap of 5 images per call to prevent context explosion.
 *
 * @module mcp-server/tools/definitions/brapi-get-image.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { type BrapiClient, getBrapiClient } from '@/services/brapi-client/index.js';
import { type BrapiDialect, resolveDialect } from '@/services/brapi-dialect/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import type { RegisteredServer } from '@/services/server-registry/types.js';
import {
  AliasInput,
  appendPassthroughLines,
  buildRequestOptions,
  NonBlankString,
  requireRegisteredConnection,
} from '../shared/find-helpers.js';
import { literal } from '../shared/markdown-literals.js';

const MAX_IMAGES_PER_CALL = 5;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB

const ImageMetadataSchema = z
  .object({
    imageDbId: z.string().describe('Server-side identifier for the image.'),
    imageName: z.string().optional().describe('Display name.'),
    imageFileName: z.string().optional().describe('Original uploaded filename.'),
    imageHeight: z.coerce
      .number()
      .optional()
      .describe('Pixel height. Coerced from string when the upstream emits a numeric string.'),
    imageWidth: z.coerce
      .number()
      .optional()
      .describe('Pixel width. Coerced from string when the upstream emits a numeric string.'),
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
    mimeType: z
      .string()
      .describe(
        'Validated image MIME from the response header, or metadata when absent; lowercase without parameters.',
      ),
    sizeBytes: z.number().int().nonnegative().describe('Size of the returned byte payload.'),
    source: z.enum(['imagecontent', 'imageURL']).describe('How the bytes were fetched.'),
    metadata: ImageMetadataSchema.describe('Upstream metadata for this image.'),
  })
  .describe(
    'Metadata for a successfully loaded image; bytes appear once in content[] image blocks.',
  );

const ImageErrorSchema = z
  .object({
    imageDbId: z.string().describe('Image identifier the error applies to.'),
    error: z.string().describe('Reason the image could not be loaded.'),
  })
  .describe('Per-image error entry returned when a fetch fails.');

const ImageWarningSchema = z
  .object({
    imageDbId: z.string().describe('Image identifier the warning applies to.'),
    warning: z.string().describe('Advisory — bytes loaded but something is suspect.'),
  })
  .describe('Per-image advisory for successfully loaded images.');

const OutputSchema = z.object({
  alias: z.string().describe('Connection alias the call used.'),
  images: z.array(ImagePayloadSchema).describe('Successfully loaded images.'),
  errors: z.array(ImageErrorSchema).describe('Images that could not be loaded, one entry per id.'),
  warnings: z
    .array(ImageWarningSchema)
    .describe('Per-image advisories; non-image MIME responses are errors, not successful images.'),
});

type Output = z.infer<typeof OutputSchema>;

export const brapiGetImage = tool('brapi_get_image', {
  description: `Fetch image bytes for up to ${MAX_IMAGES_PER_CALL} imageDbIds and return them inline as \`type: image\` content blocks. Falls back to the metadata \`imageURL\` when the server lacks dedicated image-content delivery or that request fails. No filesystem side-effects.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'unknown_alias',
      code: JsonRpcErrorCode.NotFound,
      when: 'No connection is registered under the requested alias, and the server has no base URL configured for it to connect on first use',
      recovery:
        'Run brapi_connect with this alias and a `baseUrl`, or pass an alias the brapi_connect description lists as built-in or operator-configured, before calling brapi_get_image.',
      thrownBy: 'service',
    },
    {
      reason: 'auth_token_exchange_failed',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Connecting the alias on first use, the SGN or OAuth token exchange against the BrAPI /token endpoint failed',
      recovery:
        'Ask the operator to check the credentials configured for this alias and that the server exposes /token, or run brapi_connect with credentials in `auth`.',
      thrownBy: 'service',
    },
    {
      reason: 'auth_no_access_token',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Connecting the alias on first use, the token endpoint answered without returning an access token',
      recovery:
        'Ask the operator to check that the credentials configured for this alias are valid and that the upstream IdP issues access tokens for this grant.',
      thrownBy: 'service',
    },
    {
      reason: 'capability_discovery_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Neither /serverinfo nor /calls listed any call, and at least one of them timed out, was unreachable, or answered 429 or a 5xx other than 501, so nothing was cached',
      recovery:
        'The BrAPI server is slow or unreachable right now. Retry brapi_get_image in a minute; if it keeps failing, the server may be down.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unauthorized',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'The BrAPI server answered HTTP 401: it requires credentials, or rejected the ones sent',
      recovery:
        'Run brapi_connect with credentials in `auth`, or ask the operator to set server-side credentials for this alias, then retry brapi_get_image.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The BrAPI server answered HTTP 403: the credentials sent, or their absence, lack access',
      recovery:
        'Run brapi_connect with credentials that have access, or ask the operator to set server-side credentials for this alias that do, then retry brapi_get_image.',
      thrownBy: 'service',
    },
    {
      reason: 'alias_base_url_invalid',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'The base URL configured on the server for this alias is not an absolute http(s) URL, or carries credentials',
      recovery:
        'Ask the operator to set the base URL configured for this alias to an absolute http(s) URL, then retry brapi_get_image.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'private_address_blocked',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The base URL configured for this alias, or its token URL, is on a private or reserved address this server may not reach',
      recovery:
        'Ask the operator to point this alias at a publicly routable host, or to allow private addresses on this server, then retry brapi_get_image.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'images_unsupported',
      code: JsonRpcErrorCode.NotFound,
      when: 'The BrAPI server does not advertise /images',
      recovery:
        'Run brapi_server_info to inspect the advertised endpoints, or call brapi_connect with a different alias for a server that exposes /images.',
    },
  ] as const,
  input: z.object({
    imageDbIds: z
      .array(NonBlankString)
      .min(1)
      .max(MAX_IMAGES_PER_CALL)
      .describe(`1–${MAX_IMAGES_PER_CALL} image identifiers.`),
    alias: AliasInput,
  }),
  inputAliases: {
    imageDbId: 'imageDbIds',
  },
  output: OutputSchema,

  async handler(input, ctx) {
    const capabilities = getCapabilityRegistry();
    const client = getBrapiClient();

    const connection = await requireRegisteredConnection(ctx, input.alias);

    const capabilityLookup: { auth?: typeof connection.resolvedAuth } = {};
    if (connection.resolvedAuth) capabilityLookup.auth = connection.resolvedAuth;
    const profile = await capabilities.profile(connection.baseUrl, ctx, capabilityLookup);
    if (!profile.supported.images) {
      throw ctx.fail(
        'images_unsupported',
        `BrAPI server at ${connection.baseUrl} does not advertise '/images'. Cannot fetch image bytes.`,
        { baseUrl: connection.baseUrl },
      );
    }
    // /imagecontent must declare GET — many servers expose it for PUT-only upload.
    const imagecontentDescriptor = profile.supported['images/{imageDbId}/imagecontent'];
    const hasImageContent = Boolean(
      imagecontentDescriptor &&
        (imagecontentDescriptor.methods === undefined ||
          imagecontentDescriptor.methods.includes('GET')),
    );

    const dialect = await resolveDialect(connection, ctx, capabilityLookup);

    const loaded = await Promise.all(
      input.imageDbIds.map((id) => fetchOne(id, hasImageContent, connection, dialect, client, ctx)),
    );

    const images: z.infer<typeof ImagePayloadSchema>[] = [];
    const errors: z.infer<typeof ImageErrorSchema>[] = [];
    const warnings: z.infer<typeof ImageWarningSchema>[] = [];
    for (const entry of loaded) {
      if (entry.kind === 'ok') {
        images.push(entry.payload);
        ctx.content.image(entry.data, entry.payload.mimeType);
      } else errors.push(entry);
    }

    const result: Output = {
      alias: connection.alias,
      images,
      errors,
      warnings,
    };
    return result;
  },

  format: (result) => {
    const blocks: { type: 'text'; text: string }[] = [];
    const header: string[] = [];
    header.push(literal`# ${result.images.length} image(s) loaded — \`${result.alias}\``);
    if (result.errors.length > 0) {
      header.push(literal`⚠ ${result.errors.length} failed — see below.`);
    }
    if (result.warnings.length > 0) {
      header.push(literal`⚠ ${result.warnings.length} suspect — see warnings below.`);
    }
    blocks.push({ type: 'text', text: header.join('\n') });

    const META_RENDERED = new Set([
      'imageDbId',
      'imageName',
      'imageFileName',
      'imageWidth',
      'imageHeight',
      'mimeType',
      'imageURL',
      'observationUnitDbId',
      'observationUnitName',
      'studyDbId',
      'studyName',
      'imageTimeStamp',
      'copyright',
      'description',
    ]);
    for (const img of result.images) {
      const meta = img.metadata;
      const lines: string[] = [];
      const label = meta.imageName ?? meta.imageFileName ?? img.imageDbId;
      lines.push(literal`## ${label}`);
      lines.push(literal`- imageDbId: \`${img.imageDbId}\``);
      lines.push(literal`- mimeType: ${img.mimeType}`);
      lines.push(literal`- sizeBytes: ${img.sizeBytes}`);
      lines.push(literal`- source: ${img.source}`);
      lines.push(literal`- metadata.imageDbId: \`${meta.imageDbId}\``);
      if (meta.mimeType) lines.push(literal`- metadata.mimeType: ${meta.mimeType}`);
      if (meta.imageFileName) lines.push(literal`- imageFileName: ${meta.imageFileName}`);
      if (meta.imageWidth && meta.imageHeight) {
        lines.push(literal`- dimensions: ${meta.imageWidth}×${meta.imageHeight}`);
      }
      if (meta.observationUnitName)
        lines.push(literal`- observationUnitName: ${meta.observationUnitName}`);
      if (meta.observationUnitDbId)
        lines.push(literal`- observationUnitDbId: ${meta.observationUnitDbId}`);
      if (meta.studyName) lines.push(literal`- studyName: ${meta.studyName}`);
      if (meta.studyDbId) lines.push(literal`- studyDbId: ${meta.studyDbId}`);
      if (meta.imageTimeStamp) lines.push(literal`- imageTimeStamp: ${meta.imageTimeStamp}`);
      if (meta.imageURL) lines.push(literal`- imageURL: ${meta.imageURL}`);
      if (meta.copyright) lines.push(literal`- copyright: ${meta.copyright}`);
      if (meta.description) lines.push(literal`- description: ${meta.description}`);
      appendPassthroughLines(lines, meta as Record<string, unknown>, META_RENDERED);
      blocks.push({ type: 'text', text: lines.join('\n') });
    }
    for (const err of result.errors) {
      blocks.push({
        type: 'text',
        text: literal`\n### ${err.imageDbId} — failed\n- error: ${err.error}`,
      });
    }
    for (const w of result.warnings) {
      blocks.push({
        type: 'text',
        text: literal`\n### ${w.imageDbId} — warning\n- ${w.warning}`,
      });
    }
    return blocks;
  },
});

type FetchResult =
  | { kind: 'ok'; payload: z.infer<typeof ImagePayloadSchema>; data: string }
  | { kind: 'error'; imageDbId: string; error: string };

async function fetchOne(
  imageDbId: string,
  hasImageContent: boolean,
  connection: RegisteredServer,
  dialect: BrapiDialect,
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
    const rawMetadata = metaEnv.result;
    if (!rawMetadata || typeof rawMetadata !== 'object' || !rawMetadata.imageDbId) {
      return { kind: 'error', imageDbId, error: 'Image metadata missing or malformed.' };
    }
    const metadata = dialect.normalizeRow
      ? dialect.normalizeRow('images', rawMetadata)
      : rawMetadata;

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

    const rawMimeType =
      fetched.mimeType ??
      (typeof metadata.mimeType === 'string' ? metadata.mimeType : 'application/octet-stream');
    const separator = rawMimeType.indexOf(';');
    const mimeType = rawMimeType
      .slice(0, separator < 0 ? undefined : separator)
      .trim()
      .toLowerCase();
    if (!mimeType.startsWith('image/') || mimeType.length === 'image/'.length) {
      return {
        kind: 'error',
        imageDbId,
        error: `Byte response has non-image MIME type '${mimeType}'. Check the image metadata URL or choose another imageDbId.`,
      };
    }

    return {
      kind: 'ok',
      data: toBase64(fetched.bytes),
      payload: {
        imageDbId,
        mimeType,
        sizeBytes: fetched.bytes.byteLength,
        source: fetched.source,
        metadata: metadata as z.infer<typeof ImageMetadataSchema>,
      },
    };
  } catch (err) {
    ctx.signal?.throwIfAborted();
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
  | { bytes: Uint8Array; mimeType: string | undefined; source: 'imagecontent' | 'imageURL' }
  | undefined
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
      input.ctx.signal?.throwIfAborted();
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

/**
 * Resolve an `imageURL` metadata value to an absolute fetchable URL.
 * Four input shapes are handled:
 *   1. Absolute URL (`https://host/path`, `http://host/path`) — returned as-is.
 *   2. Schemeless protocol-relative (`//host/path`) — prefixed with `https:`.
 *   3. Schemeless domain-shaped (`host.tld/path`, e.g. Breedbase's
 *      `breedbase.org/data/images/.../medium.jpg`) — prefixed with `https://`.
 *   4. Root-relative or relative path (`/path` or `path`) — concatenated with
 *      the BrAPI baseUrl. This is the legitimate "image is hosted on the same
 *      BrAPI server" case.
 *
 * After resolution, multiple consecutive slashes in the pathname are
 * collapsed to a single slash. Several upstreams (T3 family) emit
 * `imageURL` values with stray double slashes (`host//data/...`) that
 * 404 verbatim; the cleanup keeps query string and fragment intact.
 */
function resolveImageUrl(baseUrl: string, imageUrl: string): string {
  let resolved: string;
  if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) resolved = imageUrl;
  else if (imageUrl.startsWith('//')) resolved = `https:${imageUrl}`;
  else if (SCHEMELESS_DOMAIN.test(imageUrl)) resolved = `https://${imageUrl}`;
  else {
    const trimmed = baseUrl.replace(/\/$/, '');
    const prefixed = imageUrl.startsWith('/') ? imageUrl : `/${imageUrl}`;
    resolved = `${trimmed}${prefixed}`;
  }
  try {
    const url = new URL(resolved);
    url.pathname = url.pathname.replace(/\/{2,}/g, '/');
    return url.toString();
  } catch {
    return resolved;
  }
}

/**
 * Matches values that look like `domain.tld/path` or just `domain.tld` — a
 * leading character that isn't `/`, followed by at least one DNS-style label
 * with a TLD of two-plus letters. Excludes leading slashes (path) and IPv4
 * dotted-quads (rare in `imageURL`, and the surrounding flow treats them as
 * paths under baseUrl just fine).
 */
const SCHEMELESS_DOMAIN =
  /^(?!\/)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[/:?#]|$)/i;

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
