/**
 * @fileoverview `brapi_raw_get` — last-resort passthrough to any BrAPI GET
 * endpoint the goal-shaped tools don't cover (e.g. `/samples`, `/methods`,
 * `/scales`, `/crosses`). Returns the raw upstream envelope, plus a routing
 * nudge when the target endpoint is actually covered by a curated tool.
 *
 * @module mcp-server/tools/definitions/brapi-raw-get.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import {
  type BrapiPagination,
  type BrapiRequestOptions,
  getBrapiClient,
} from '@/services/brapi-client/index.js';
import { DEFAULT_ALIAS, getServerRegistry } from '@/services/server-registry/index.js';
import { AliasInput } from '../shared/find-helpers.js';
import { suggestForGet } from '../shared/raw-routing-hints.js';

const PaginationSchema = z
  .object({
    currentPage: z.number(),
    pageSize: z.number(),
    totalCount: z.number(),
    totalPages: z.number(),
  })
  .passthrough()
  .optional();

const OutputSchema = z.object({
  alias: z.string(),
  url: z.string(),
  path: z.string(),
  metadata: z
    .object({
      pagination: PaginationSchema,
    })
    .passthrough(),
  result: z.unknown().describe('Raw BrAPI `result` value — whatever shape the endpoint returns.'),
  suggestion: z
    .string()
    .optional()
    .describe('Emitted when a curated goal-shaped tool covers this endpoint.'),
});

type Output = z.infer<typeof OutputSchema>;

export const brapiRawGet = tool('brapi_raw_get', {
  description:
    'Passthrough to any BrAPI GET /{path} endpoint the goal-shaped tools do not cover. Returns the raw upstream envelope. Prefer brapi_find_*/brapi_get_* tools when applicable — they enrich results and resolve foreign keys; this tool does not. Emits a `suggestion` field when a curated tool covers the endpoint.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    alias: AliasInput,
    path: z
      .string()
      .min(1)
      .describe('Endpoint path — e.g. "/samples", "/methods". Leading "/" is optional.'),
    params: z
      .record(
        z.string(),
        z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]),
      )
      .optional()
      .describe('Query parameters to append. Arrays are repeated per BrAPI convention.'),
  }),
  output: OutputSchema,

  async handler(input, ctx) {
    const registry = getServerRegistry();
    const client = getBrapiClient();

    const connection = await registry.get(ctx, input.alias ?? DEFAULT_ALIAS);
    const path = normalizePath(input.path);
    rejectCrossOrigin(path);

    const requestOptions: BrapiRequestOptions = {};
    if (connection.resolvedAuth) requestOptions.auth = connection.resolvedAuth;
    if (input.params) {
      requestOptions.params = input.params as NonNullable<BrapiRequestOptions['params']>;
    }
    const envelope = await client.get<unknown>(connection.baseUrl, path, ctx, requestOptions);

    const url = buildDisplayUrl(connection.baseUrl, path, input.params);
    const result: Output = {
      alias: connection.alias,
      url,
      path,
      metadata: buildMetadata(envelope.metadata),
      result: envelope.result,
    };
    const suggestion = suggestForGet(path);
    if (suggestion) result.suggestion = suggestion;
    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`# GET ${result.path} — \`${result.alias}\``);
    lines.push('');
    lines.push(`URL: ${result.url}`);
    const pagination = result.metadata.pagination;
    if (pagination) {
      lines.push('');
      lines.push(
        `**Pagination:** page ${pagination.currentPage} of ${pagination.totalPages}, pageSize=${pagination.pageSize}, totalCount=${pagination.totalCount}`,
      );
    }
    if (result.suggestion) {
      lines.push('');
      lines.push(`**Suggestion:** ${result.suggestion}`);
    }
    lines.push('');
    lines.push('## Raw result');
    lines.push('```json');
    lines.push(JSON.stringify(result.result, null, 2));
    lines.push('```');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

function normalizePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

function buildMetadata(metadata: { pagination?: BrapiPagination } | undefined): Output['metadata'] {
  const pagination = metadata?.pagination;
  if (pagination) {
    return { pagination: { ...pagination } };
  }
  return {};
}

function buildDisplayUrl(baseUrl: string, path: string, params?: Record<string, unknown>): string {
  const url = new URL(`${baseUrl.replace(/\/$/, '')}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(key, String(v));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

function rejectCrossOrigin(path: string): void {
  // The path is appended to the registered baseUrl; if the caller smuggles a
  // full URL (http://evil/...) `new URL()` would silently hijack the request.
  if (/^https?:\/\//i.test(path)) {
    throw validationError('path must be a relative BrAPI route, not a full URL.', { path });
  }
}
