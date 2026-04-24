/**
 * @fileoverview `brapi_raw_search` — last-resort passthrough to any BrAPI
 * `POST /search/{noun}` endpoint with async-search polling handled
 * transparently. Returns the raw upstream envelope once the search completes.
 * Emits a routing nudge when a curated goal-shaped tool covers the noun.
 *
 * @module mcp-server/tools/definitions/brapi-raw-search.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  type BrapiPagination,
  type BrapiRequestOptions,
  getBrapiClient,
} from '@/services/brapi-client/index.js';
import { DEFAULT_ALIAS, getServerRegistry } from '@/services/server-registry/index.js';
import { AliasInput, buildRequestOptions } from '../shared/find-helpers.js';
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
});

type Output = z.infer<typeof OutputSchema>;

export const brapiRawSearch = tool('brapi_raw_search', {
  description:
    'Passthrough to any BrAPI POST /search/{noun} endpoint. Handles async polling transparently. Prefer brapi_find_* tools when applicable — they layer distributions, FK resolution, and dataset spillover on top.',
  annotations: { readOnlyHint: true, openWorldHint: true },
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
  }),
  output: OutputSchema,

  async handler(input, ctx) {
    const registry = getServerRegistry();
    const client = getBrapiClient();

    const connection = await registry.get(ctx, input.alias ?? DEFAULT_ALIAS);

    const requestOptions: BrapiRequestOptions = {};
    if (connection.resolvedAuth) requestOptions.auth = connection.resolvedAuth;

    const response = await client.postSearch<unknown>(
      connection.baseUrl,
      input.noun,
      input.body,
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
