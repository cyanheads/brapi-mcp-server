/**
 * @fileoverview `brapi_raw_get` — last-resort passthrough to any BrAPI GET
 * endpoint the goal-shaped tools don't cover (e.g. `/samples`, `/methods`,
 * `/scales`, `/crosses`). Returns the raw upstream envelope plus a routing
 * nudge when the target endpoint is covered by a curated tool, and spills
 * to a canvas dataframe when the upstream advertises more rows than fit
 * in `loadLimit` AND the result is a list shape (`result` array or BrAPI
 * `result.data` envelope). Spillover is skipped when the caller drives
 * paging via `params.page` / `params.pageSize` — they're explicitly walking
 * the result themselves and we don't second-guess.
 *
 * @module mcp-server/tools/definitions/brapi-raw-get.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import {
  type BrapiPagination,
  type BrapiRequestOptions,
  getBrapiClient,
} from '@/services/brapi-client/index.js';
import { getCanvasBridge } from '@/services/canvas-bridge/index.js';
import { DEFAULT_ALIAS, getServerRegistry } from '@/services/server-registry/index.js';
import {
  AliasInput,
  DataframeHandleSchema,
  extractListRows,
  LoadLimitInput,
  renderDataframeHandle,
  spillToCanvas,
  toDataframeHandle,
} from '../shared/find-helpers.js';
import { suggestForGet } from '../shared/raw-routing-hints.js';

const PaginationSchema = z
  .object({
    currentPage: z.number().describe('0-indexed page number the server returned.'),
    pageSize: z.number().describe('Rows per page.'),
    totalCount: z.number().describe('Total rows matching the query across all pages.'),
    totalPages: z.number().describe('Total pages at the current pageSize.'),
  })
  .passthrough()
  .optional()
  .describe('BrAPI pagination block. Absent when the endpoint does not paginate.');

const OutputSchema = z.object({
  alias: z.string().describe('Alias of the registered BrAPI connection the call used.'),
  url: z.string().describe('Fully resolved URL that was fetched (baseUrl + path + query string).'),
  path: z
    .string()
    .describe('Normalized path (leading `/` preserved) that was appended to the baseUrl.'),
  metadata: z
    .object({
      pagination: PaginationSchema,
    })
    .passthrough()
    .describe('BrAPI envelope metadata (pagination and any additional upstream fields).'),
  result: z.unknown().describe('Raw BrAPI `result` value — whatever shape the endpoint returns.'),
  suggestion: z
    .string()
    .optional()
    .describe('Emitted when a curated goal-shaped tool covers this endpoint.'),
  dataframe: DataframeHandleSchema.optional().describe(
    'Present when the upstream advertised more rows than `loadLimit` AND the result is a list shape. The inline `result` is unchanged; the dataframe carries the full union of pages — query with brapi_dataframe_query.',
  ),
});

type Output = z.infer<typeof OutputSchema>;

export const brapiRawGet = tool('brapi_raw_get', {
  description:
    'Passthrough to any BrAPI GET /{path} endpoint. Returns the raw upstream envelope without enrichment or foreign-key resolution. Emits a `suggestion` field when a curated tool exists for the same data. Spills to a canvas dataframe when the upstream advertises more rows than `loadLimit` AND the result is a list shape (`result` array or `result.data` envelope); inline `result` is unchanged. Skips spillover when the caller drives paging via `params.page` / `params.pageSize`.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'cross_origin_path',
      code: JsonRpcErrorCode.ValidationError,
      when: 'path argument was a full URL instead of a relative BrAPI route',
      recovery:
        'Pass a path like "/samples" or "/methods" — the connection alias supplies the baseUrl.',
    },
  ] as const,
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
    loadLimit: LoadLimitInput,
  }),
  output: OutputSchema,

  async handler(input, ctx) {
    const registry = getServerRegistry();
    const client = getBrapiClient();
    const bridge = getCanvasBridge();
    const config = getServerConfig();

    const connection = await registry.get(ctx, input.alias ?? DEFAULT_ALIAS);
    // The path is appended to the registered baseUrl; if the caller smuggles a
    // full URL (http://evil/...) `new URL()` would silently hijack the request.
    if (/^https?:\/\//i.test(input.path)) {
      throw ctx.fail('cross_origin_path', 'path must be a relative BrAPI route, not a full URL.', {
        path: input.path,
        ...ctx.recoveryFor('cross_origin_path'),
      });
    }
    const path = normalizePath(input.path);
    const loadLimit = input.loadLimit ?? config.loadLimit;
    // When the caller drives paging themselves, treat the call as a single
    // explicit page fetch and skip spillover. Otherwise align the first call
    // with `loadLimit` so the dataframe walk continues at the same pageSize.
    const userControlsPaging =
      input.params?.page !== undefined || input.params?.pageSize !== undefined;
    const params: Record<string, unknown> = { ...(input.params ?? {}) };
    if (!userControlsPaging) params.pageSize = loadLimit;

    const requestOptions: BrapiRequestOptions = {};
    if (connection.resolvedAuth) requestOptions.auth = connection.resolvedAuth;
    requestOptions.params = params as NonNullable<BrapiRequestOptions['params']>;
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

    if (!userControlsPaging) {
      const totalCount = envelope.metadata?.pagination?.totalCount;
      const rows = extractListRows(envelope.result);
      if (
        rows !== null &&
        rows.length > 0 &&
        typeof totalCount === 'number' &&
        totalCount > loadLimit
      ) {
        const spill = await spillToCanvas({
          bridge,
          client,
          connection,
          ctx,
          firstPage: rows,
          totalCount,
          loadLimit,
          path,
          filters: (input.params ?? {}) as Record<string, unknown>,
          source: 'raw_get',
        });
        result.dataframe = toDataframeHandle(spill.dataframe);
      }
    }
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
    if (result.dataframe) {
      lines.push('');
      lines.push('## Dataframe');
      lines.push(...renderDataframeHandle(result.dataframe));
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
