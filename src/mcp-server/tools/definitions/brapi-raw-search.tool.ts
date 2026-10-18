/**
 * @fileoverview `brapi_raw_search` — last-resort passthrough to any BrAPI
 * `POST /search/{noun}` endpoint with async-search polling handled
 * transparently. Returns the raw upstream envelope once the search completes,
 * with list previews bounded by rows and bytes. Omitted fetched rows stay
 * staged; explicit paging stages only the requested page. Emits a nudge when a curated
 * tool covers the noun.
 *
 * @module mcp-server/tools/definitions/brapi-raw-search.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import {
  type BrapiPagination,
  type BrapiRequestOptions,
  getBrapiClient,
} from '@/services/brapi-client/index.js';
import { resolveDialect } from '@/services/brapi-dialect/index.js';
import { getCanvasBridge } from '@/services/canvas-bridge/index.js';
import {
  AliasInput,
  buildRequestOptions,
  DataframeHandleSchema,
  LoadLimitInput,
  renderDataframeHandle,
  renderWarningsTrailer,
  requireRegisteredConnection,
} from '../shared/find-helpers.js';
import { previewRawResult } from '../shared/raw-preview.js';
import { suggestForSearch } from '../shared/raw-routing-hints.js';

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
  noun: z.string().describe('The `/search/{noun}` segment the body was posted to.'),
  kind: z
    .enum(['sync', 'async'])
    .describe('Whether the server returned inline results or we polled an async search.'),
  searchResultsDbId: z
    .string()
    .optional()
    .describe('Populated when the server returned an async searchResultsDbId.'),
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
      'Emitted when a curated goal-shaped tool covers this search, or takes the IDs it lists.',
    ),
  dataframe: DataframeHandleSchema.optional().describe(
    'Every fetched row of a list result, staged when the inline preview omits rows. Explicit paging stages only the requested page.',
  ),
});

type Output = z.infer<typeof OutputSchema>;

export const brapiRawSearch = tool('brapi_raw_search', {
  description:
    'Passthrough to BrAPI POST /search/{noun}, polling async search IDs. Sends loadLimit as the initial pageSize unless body.page/pageSize drives explicit paging. List previews fit loadLimit and a 24,000-byte budget on each serialized row representation; an oversized first row returns no inline rows. Every fetched row omitted inline stays in a dataframe readable with brapi_dataframe_describe and brapi_dataframe_query. Explicit paging fetches only the requested page, staging it if trimmed. Non-list results and envelope siblings are preserved; no distributions or foreign-key resolution.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'unknown_alias',
      code: JsonRpcErrorCode.NotFound,
      when: 'No connection is registered under the requested alias, and the server has no base URL configured for it to connect on first use',
      recovery:
        'Run brapi_connect with this alias and a `baseUrl`, or pass an alias the brapi_connect description lists as built-in or operator-configured, before calling brapi_raw_search.',
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
        'The BrAPI server is slow or unreachable right now. Retry brapi_raw_search in a minute; if it keeps failing, the server may be down.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unauthorized',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'The BrAPI server answered HTTP 401: it requires credentials, or rejected the ones sent',
      recovery:
        'Run brapi_connect with credentials in `auth`, or ask the operator to set server-side credentials for this alias, then retry brapi_raw_search.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The BrAPI server answered HTTP 403: the credentials sent, or their absence, lack access',
      recovery:
        'Run brapi_connect with credentials that have access, or ask the operator to set server-side credentials for this alias that do, then retry brapi_raw_search.',
      thrownBy: 'service',
    },
    {
      reason: 'alias_base_url_invalid',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'The base URL configured on the server for this alias is not an absolute http(s) URL, or carries credentials',
      recovery:
        'Ask the operator to set the base URL configured for this alias to an absolute http(s) URL, then retry brapi_raw_search.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'private_address_blocked',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The base URL configured for this alias, or its token URL, is on a private or reserved address this server may not reach',
      recovery:
        'Ask the operator to point this alias at a publicly routable host, or to allow private addresses on this server, then retry brapi_raw_search.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'search_endpoint_disabled',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The active dialect declares this POST /search/{noun} route as known-dead on this server',
      recovery:
        'Use the curated brapi_find_* tool for this noun when one exists — it routes through GET filters instead and avoids the dead search route; otherwise call brapi_raw_get on GET /{noun} with query parameters.',
    },
  ] as const,
  input: z.object({
    alias: AliasInput,
    noun: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .describe('Search noun — e.g. "observations", "calls", "germplasm".'),
    body: z
      .record(z.string(), z.unknown())
      .describe('Filter body passed verbatim to POST /search/{noun}.'),
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

    const requestOptions: BrapiRequestOptions = {};
    if (connection.resolvedAuth) requestOptions.auth = connection.resolvedAuth;

    const dialect = await resolveDialect(connection, ctx, requestOptions);
    if (dialect.disabledSearchEndpoints?.has(input.noun)) {
      const nudge = suggestForSearch(input.noun);
      throw ctx.fail(
        'search_endpoint_disabled',
        `Dialect '${dialect.id}' marks POST /search/${input.noun} as known-dead on this server (advertised in /calls but unresponsive in practice).${nudge ? ` ${nudge}` : ''}`,
        { dialectId: dialect.id, noun: input.noun },
      );
    }

    const loadLimit = input.loadLimit ?? config.loadLimit;
    const userControlsPaging = input.body.page !== undefined || input.body.pageSize !== undefined;
    const body = userControlsPaging ? input.body : { ...input.body, pageSize: loadLimit };

    const response = await client.postSearch<unknown>(
      connection.baseUrl,
      input.noun,
      body,
      ctx,
      requestOptions,
    );

    let envelope: Awaited<ReturnType<typeof client.get<unknown>>>;
    let kind: 'sync' | 'async';
    let searchResultsDbId: string | undefined;

    if (response.kind === 'sync') {
      envelope = response.envelope;
      kind = 'sync';
    } else {
      searchResultsDbId = response.searchResultsDbId;
      envelope = await client.getSearchResults<unknown>(
        connection.baseUrl,
        input.noun,
        response.searchResultsDbId,
        ctx,
        buildRequestOptions(connection, {
          page: body.page,
          pageSize: body.pageSize,
        } as NonNullable<BrapiRequestOptions['params']>),
      );
      kind = 'async';
    }

    const result: Output = {
      alias: connection.alias,
      noun: input.noun,
      kind,
      metadata: buildMetadata(envelope.metadata),
      result: envelope.result,
    };
    if (searchResultsDbId !== undefined) result.searchResultsDbId = searchResultsDbId;
    const suggestion = suggestForSearch(input.noun);
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
        path: `/search/${input.noun}`,
        filters: input.body as Record<string, unknown>,
        source: 'raw_search',
        route: {
          kind: 'search',
          noun: input.noun,
          service: `search/${input.noun}`,
          searchBody: input.body,
        },
      },
      userControlsPaging,
    );
    result.result = preview.result;
    if (preview.dataframe) result.dataframe = preview.dataframe;
    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`# POST /search/${result.noun} (${result.kind}) — \`${result.alias}\``);
    if (result.searchResultsDbId) {
      lines.push('');
      lines.push(`**searchResultsDbId:** \`${result.searchResultsDbId}\``);
    }
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

function buildMetadata(metadata: { pagination?: BrapiPagination } | undefined): Output['metadata'] {
  const { pagination, ...rest } = metadata ?? {};
  if (pagination) {
    return { ...rest, pagination: { ...pagination } };
  }
  return rest;
}
