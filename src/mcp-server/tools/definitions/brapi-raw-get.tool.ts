/**
 * @fileoverview `brapi_raw_get` — last-resort passthrough to any BrAPI GET
 * endpoint the goal-shaped tools don't cover (e.g. `/samples`, `/methods`,
 * `/scales`, `/crosses`). Returns the raw upstream envelope plus a routing
 * nudge when the target endpoint is covered by a curated tool. Its preview fits
 * loadLimit and a strict byte budget. Omitted fetched rows
 * stay in a canvas dataframe. Explicit paging stages only the requested page.
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
import {
  AliasInput,
  DataframeHandleSchema,
  LoadLimitInput,
  NonBlankString,
  renderDataframeHandle,
  renderWarningsTrailer,
  requireRegisteredConnection,
} from '../shared/find-helpers.js';
import { previewRawResult } from '../shared/raw-preview.js';
import { suggestForGet } from '../shared/raw-routing-hints.js';

const PaginationSchema = z
  .object({
    currentPage: z.number().optional().describe('0-indexed page number, when reported.'),
    pageSize: z.number().optional().describe('Rows per page, when reported.'),
    totalCount: z.number().optional().describe('Total matching rows, when reported.'),
    totalPages: z.number().optional().describe('Total pages, when reported.'),
  })
  .passthrough()
  .optional()
  .describe('BrAPI pagination block. Absent when the endpoint does not paginate.');

const OutputSchema = z.object({
  alias: z.string().describe('Connection alias the call used.'),
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
    .describe(
      'Emitted when a curated goal-shaped tool covers this endpoint, or takes the IDs it lists.',
    ),
  dataframe: DataframeHandleSchema.optional().describe(
    'Every fetched row of a list result, staged when the inline preview omits rows. Explicit paging stages only the requested page.',
  ),
});

type Output = z.infer<typeof OutputSchema>;

export const brapiRawGet = tool('brapi_raw_get', {
  description:
    'Passthrough to BrAPI GET /{path} without foreign-key resolution. List results (result array or result.data) return a leading preview within loadLimit and a 24,000-byte budget on each serialized row representation; an oversized first row returns no inline rows. Omitted fetched rows remain in a dataframe readable with brapi_dataframe_describe and brapi_dataframe_query. Explicit params.page/pageSize fetches only that upstream page, staging it if trimmed. Non-list results and envelope siblings are preserved. Emits a suggestion when a curated tool covers the endpoint.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'unknown_alias',
      code: JsonRpcErrorCode.NotFound,
      when: 'No connection is registered under the requested alias, and the server has no base URL configured for it to connect on first use',
      recovery:
        'Run brapi_connect with this alias and a `baseUrl`, or pass an alias the brapi_connect description lists as built-in or operator-configured, before calling brapi_raw_get.',
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
        'The BrAPI server is slow or unreachable right now. Retry brapi_raw_get in a minute; if it keeps failing, the server may be down.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unauthorized',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'The BrAPI server answered HTTP 401: it requires credentials, or rejected the ones sent',
      recovery:
        'Run brapi_connect with credentials in `auth`, or ask the operator to set server-side credentials for this alias, then retry brapi_raw_get.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The BrAPI server answered HTTP 403: the credentials sent, or their absence, lack access',
      recovery:
        'Run brapi_connect with credentials that have access, or ask the operator to set server-side credentials for this alias that do, then retry brapi_raw_get.',
      thrownBy: 'service',
    },
    {
      reason: 'alias_base_url_invalid',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'The base URL configured on the server for this alias is not an absolute http(s) URL, or carries credentials',
      recovery:
        'Ask the operator to set the base URL configured for this alias to an absolute http(s) URL, then retry brapi_raw_get.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'private_address_blocked',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The base URL configured for this alias, or its token URL, is on a private or reserved address this server may not reach',
      recovery:
        'Ask the operator to point this alias at a publicly routable host, or to allow private addresses on this server, then retry brapi_raw_get.',
      retryable: false,
      thrownBy: 'service',
    },
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
    path: NonBlankString.describe(
      'Endpoint path — e.g. "/samples", "/methods". Leading "/" is optional.',
    ),
    params: z
      .record(
        z.string(),
        z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]),
      )
      .optional()
      .describe('Query parameters to append. Arrays are repeated per BrAPI convention.'),
    loadLimit: LoadLimitInput.describe(
      'Cap on rows returned inline. Omit for the deployment default. Rows beyond the cap land in a dataframe; query with brapi_dataframe_query (SQL) instead of paging row-by-row.',
    ),
  }),
  output: OutputSchema,

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe('True when the inline list leaves fetched or matching rows out.'),
    shown: z.number().int().nonnegative().optional().describe('Actual list rows returned inline.'),
    cap: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Effective loadLimit row ceiling, even when the byte budget binds first.'),
    warnings: z
      .array(z.string())
      .optional()
      .describe(
        'Advisory messages — present when the dataframe walk stopped before the upstream total.',
      ),
    notice: z
      .string()
      .optional()
      .describe('When a dataframe was staged, its name and the tools that read it.'),
  },

  enrichmentTrailer: {
    warnings: { render: renderWarningsTrailer },
  },

  async handler(input, ctx) {
    const client = getBrapiClient();
    const bridge = getCanvasBridge();
    const config = getServerConfig();

    const connection = await requireRegisteredConnection(ctx, input.alias);
    // The path is appended to the registered baseUrl; if the caller smuggles a
    // full URL (http://evil/...) `new URL()` would silently hijack the request.
    if (/^https?:\/\//i.test(input.path)) {
      throw ctx.fail('cross_origin_path', 'path must be a relative BrAPI route, not a full URL.', {
        path: input.path,
      });
    }
    const path = normalizePath(input.path);
    const loadLimit = input.loadLimit ?? config.loadLimit;
    // When the caller drives paging themselves, treat the call as a single
    // explicit page fetch. Otherwise align the first call
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

    const preview = await previewRawResult(
      envelope.result,
      {
        bridge,
        client,
        connection,
        ctx,
        totalCount: envelope.metadata?.pagination?.totalCount,
        loadLimit,
        path,
        filters: (input.params ?? {}) as Record<string, unknown>,
        source: 'raw_get',
      },
      userControlsPaging,
    );
    result.result = preview.result;
    if (preview.dataframe) result.dataframe = preview.dataframe;
    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`# GET ${result.path} — \`${result.alias}\``);
    lines.push('');
    lines.push(`URL: ${result.url}`);
    const pagination = result.metadata.pagination;
    if (pagination) {
      const parts = [
        pagination.currentPage === undefined ? undefined : `page ${pagination.currentPage}`,
        pagination.totalPages === undefined ? undefined : `totalPages=${pagination.totalPages}`,
        pagination.pageSize === undefined ? undefined : `pageSize=${pagination.pageSize}`,
        pagination.totalCount === undefined ? undefined : `totalCount=${pagination.totalCount}`,
      ].filter((part) => part !== undefined);
      if (parts.length > 0) lines.push('', `**Pagination:** ${parts.join(', ')}`);
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
  const { pagination, ...rest } = metadata ?? {};
  if (pagination) {
    return { ...rest, pagination: { ...pagination } };
  }
  return rest;
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
