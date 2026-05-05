/**
 * @fileoverview `brapi_raw_search` — last-resort passthrough to any BrAPI
 * `POST /search/{noun}` endpoint with async-search polling handled
 * transparently. Returns the raw upstream envelope once the search completes,
 * and spills to a canvas dataframe when the upstream advertises more rows
 * than `loadLimit` AND the result is a list shape. Spillover is skipped
 * when the caller drives paging via `body.page` / `body.pageSize` — they're
 * walking pages explicitly. Emits a routing nudge when a curated goal-shaped
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
import { DEFAULT_ALIAS, getServerRegistry } from '@/services/server-registry/index.js';
import {
  AliasInput,
  buildRequestOptions,
  DataframeHandleSchema,
  extractListRows,
  LoadLimitInput,
  renderDataframeHandle,
  spillToCanvas,
  toDataframeHandle,
} from '../shared/find-helpers.js';
import { suggestForSearch } from '../shared/raw-routing-hints.js';

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
    .describe('Emitted when a curated goal-shaped tool covers this search.'),
  dataframe: DataframeHandleSchema.optional().describe(
    'Present when the upstream advertised more rows than `loadLimit` AND the result is a list shape. The inline `result` is unchanged; the dataframe carries the full union of pages — query with brapi_dataframe_query.',
  ),
});

type Output = z.infer<typeof OutputSchema>;

export const brapiRawSearch = tool('brapi_raw_search', {
  description:
    'Passthrough to any BrAPI POST /search/{noun} endpoint, returning the resolved envelope (async polling resolved upstream). Spills to a canvas dataframe when the upstream advertises more rows than `loadLimit` AND the result is a list shape; inline `result` is unchanged. Skips spillover when the caller drives paging via `body.page` / `body.pageSize`. No distributions or foreign-key resolution applied.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'search_endpoint_disabled',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The active dialect declares this POST /search/{noun} route as known-dead on this server',
      recovery:
        'Use the curated find_* tool for this noun — it routes through GET filters instead and avoids the dead search route.',
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
    loadLimit: LoadLimitInput,
  }),
  output: OutputSchema,

  async handler(input, ctx) {
    const registry = getServerRegistry();
    const client = getBrapiClient();
    const bridge = getCanvasBridge();
    const config = getServerConfig();

    const connection = await registry.get(ctx, input.alias ?? DEFAULT_ALIAS);

    const requestOptions: BrapiRequestOptions = {};
    if (connection.resolvedAuth) requestOptions.auth = connection.resolvedAuth;

    const dialect = await resolveDialect(connection, ctx, requestOptions);
    if (dialect.disabledSearchEndpoints?.has(input.noun)) {
      const nudge = suggestForSearch(input.noun);
      throw ctx.fail(
        'search_endpoint_disabled',
        `Dialect '${dialect.id}' marks POST /search/${input.noun} as known-dead on this server (advertised in /calls but unresponsive in practice).${nudge ? ` ${nudge}` : ''}`,
        {
          dialectId: dialect.id,
          noun: input.noun,
          ...ctx.recoveryFor('search_endpoint_disabled'),
        },
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
        buildRequestOptions(connection),
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
          path: `/search/${input.noun}`,
          filters: input.body as Record<string, unknown>,
          source: 'raw_search',
          route: {
            kind: 'search',
            noun: input.noun,
            service: `search/${input.noun}`,
            searchBody: input.body,
          },
        });
        result.dataframe = toDataframeHandle(spill.dataframe);
      }
    }
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

function buildMetadata(metadata: { pagination?: BrapiPagination } | undefined): Output['metadata'] {
  const pagination = metadata?.pagination;
  if (pagination) {
    return { pagination: { ...pagination } };
  }
  return {};
}
