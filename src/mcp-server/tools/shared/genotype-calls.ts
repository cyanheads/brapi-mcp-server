/**
 * @fileoverview Shared genotype-call pull logic — the async-search machinery
 * (`POST /search/calls` → poll → page-walk) and the `CallRow` schema extracted
 * from `brapi-find-genotype-calls.tool.ts` so that `brapi_export_genotype_matrix`
 * can reuse the same pull infrastructure without duplicating it.
 *
 * This module owns: the `CallRowSchema`, `CallFormatting` type, and the
 * `collectCalls` / `consumePage` helpers. It does NOT contain `spillCalls` or
 * any tool-level concerns — those stay in the consuming tool files.
 *
 * @module mcp-server/tools/shared/genotype-calls
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, requestCancelled } from '@cyanheads/mcp-ts-core/errors';
import {
  type BrapiClient,
  CALL_DEADLINE_MS,
  CALL_DEADLINE_REASON,
  callDeadlineAt,
} from '@/services/brapi-client/index.js';
import type { RegisteredServer } from '@/services/server-registry/types.js';
import { buildRequestOptions } from './find-helpers.js';

const PAGE_SIZE = 10_000;

export const CallRowSchema = z
  .object({
    callSetDbId: z
      .string()
      .nullish()
      .describe('FK to the call set (one germplasm × one variant set = one call set).'),
    callSetName: z.string().nullish().describe('Display name of the call set.'),
    variantDbId: z.string().nullish().describe('FK to the variant being called.'),
    variantName: z.string().nullish().describe('Display name / alias of the variant.'),
    variantSetDbId: z.string().nullish().describe('FK to the variant set the call belongs to.'),
    genotype: z
      .object({
        values: z
          .array(z.string().describe('Per-allele value string.'))
          .nullish()
          .describe('Encoded allele values — interpret using top-level `callFormatting`.'),
      })
      .passthrough()
      .nullish()
      .describe(
        'Structured genotype payload (array of allele values plus server-specific fields).',
      ),
    genotypeValue: z
      .string()
      .nullish()
      .describe(
        'Legacy flat string form of the call (provided by some servers instead of `genotype`).',
      ),
    phaseSet: z
      .string()
      .nullish()
      .describe('Phase-set identifier linking calls that share a haplotype phase.'),
  })
  .passthrough()
  .describe('One genotype call row.');

export type CallRow = z.infer<typeof CallRowSchema>;

export interface CallFormatting {
  expandHomozygotes?: boolean | null;
  sepPhased?: string | null;
  sepUnphased?: string | null;
  unknownString?: string | null;
}

export interface CollectCallsInput {
  body: Record<string, unknown>;
  client: BrapiClient;
  connection: RegisteredServer;
  ctx: Context;
  maxCalls: number;
  warnings: string[];
}

export interface CollectCallsResult {
  callFormatting: CallFormatting;
  rows: CallRow[];
  /**
   * Why the page walk ended before the last page: this call's deadline for
   * upstream requests. The calls collected up to then are kept in `rows`.
   */
  stopReason?: string;
  /** The pull limit (`maxCalls`) cut the pull short. */
  truncated: boolean;
}

/**
 * Build the POST /search/calls body from named filter params. Handles both the
 * singular `variantSetDbId` convenience and the plural `variantSetDbIds` array,
 * merging and deduplicating them.
 */
export function buildCallsSearchBody(input: {
  variantSetDbId?: string | undefined;
  variantSetDbIds?: string[] | undefined;
  germplasmDbIds?: string[] | undefined;
  callSetDbIds?: string[] | undefined;
  variantDbIds?: string[] | undefined;
  callFormat?: string | undefined;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.variantSetDbId) body.variantSetDbIds = [input.variantSetDbId];
  if (input.variantSetDbIds?.length) {
    body.variantSetDbIds = Array.from(
      new Set([...((body.variantSetDbIds as string[]) ?? []), ...input.variantSetDbIds]),
    );
  }
  if (input.germplasmDbIds?.length) body.germplasmDbIds = input.germplasmDbIds;
  if (input.callSetDbIds?.length) body.callSetDbIds = input.callSetDbIds;
  if (input.variantDbIds?.length) body.variantDbIds = input.variantDbIds;
  if (input.callFormat) body.callFormat = input.callFormat;
  body.pageSize = PAGE_SIZE;
  return body;
}

/**
 * Pull all genotype call pages for a given search body, capping at `maxCalls`.
 * Uses BrAPI's async-search pattern: `POST /search/calls` → `GET /search/calls/{id}`
 * with 202-retry. Pages are collected until all results are fetched or `maxCalls`
 * is reached. When this call's deadline for upstream requests ends the walk
 * after the first page, the calls collected so far are returned with a
 * `stopReason` and a warning; on the first page it fails the call. Caller
 * cancellation rejects.
 */
export async function collectCalls(input: CollectCallsInput): Promise<CollectCallsResult> {
  const rows: CallRow[] = [];
  let callFormatting: CallFormatting = {};
  let truncated = false;
  let stopReason: string | undefined;
  const deadlineLabel = `this call's ${CALL_DEADLINE_MS / 1000} s deadline for upstream requests`;

  const firstBody = { ...input.body, page: 0 };
  const first = await input.client.postSearch<Record<string, unknown>>(
    input.connection.baseUrl,
    'calls',
    firstBody,
    input.ctx,
    buildRequestOptions(input.connection),
  );

  let envelope: Awaited<ReturnType<BrapiClient['get']>>;
  let searchResultsDbId: string | undefined;
  if (first.kind === 'sync') {
    envelope = first.envelope;
  } else {
    searchResultsDbId = first.searchResultsDbId;
    envelope = await input.client.getSearchResults<Record<string, unknown>>(
      input.connection.baseUrl,
      'calls',
      first.searchResultsDbId,
      input.ctx,
      buildRequestOptions(input.connection),
    );
  }

  consumePage(envelope, rows, (cf) => {
    callFormatting = cf;
  });
  const totalPages = envelope.metadata?.pagination?.totalPages;

  const fetchPage = async (page: number): Promise<Awaited<ReturnType<BrapiClient['get']>>> => {
    if (searchResultsDbId) {
      return await input.client.getSearchResults<Record<string, unknown>>(
        input.connection.baseUrl,
        'calls',
        searchResultsDbId,
        input.ctx,
        buildRequestOptions(input.connection, { page, pageSize: PAGE_SIZE }),
      );
    }
    const nextSearch = await input.client.postSearch<Record<string, unknown>>(
      input.connection.baseUrl,
      'calls',
      { ...input.body, page },
      input.ctx,
      buildRequestOptions(input.connection),
    );
    if (nextSearch.kind === 'sync') return nextSearch.envelope;
    return await input.client.getSearchResults<Record<string, unknown>>(
      input.connection.baseUrl,
      'calls',
      nextSearch.searchResultsDbId,
      input.ctx,
      buildRequestOptions(input.connection),
    );
  };

  for (let page = 1; page < (totalPages ?? 1); page++) {
    if (rows.length >= input.maxCalls) {
      truncated = true;
      break;
    }
    if (input.ctx.signal.aborted) {
      throw requestCancelled('Genotype-call pull cancelled by the caller.');
    }
    if (Date.now() >= callDeadlineAt(input.ctx)) {
      stopReason = `${deadlineLabel} ran out before page ${page}`;
      break;
    }
    let pageEnvelope: Awaited<ReturnType<BrapiClient['get']>>;
    try {
      pageEnvelope = await fetchPage(page);
    } catch (err) {
      if (input.ctx.signal.aborted || !isCallDeadline(err)) throw err;
      stopReason = `${deadlineLabel} ran out during page ${page}`;
      break;
    }
    consumePage(pageEnvelope, rows, (cf) => {
      callFormatting = cf;
    });
  }

  if (rows.length > input.maxCalls) {
    rows.length = input.maxCalls;
    truncated = true;
  }
  // Whether a dataframe holds the kept calls is the calling tool's to say.
  if (truncated) {
    input.warnings.push(
      `Truncated at the pull limit (${input.maxCalls} calls): the calls collected up to it are kept. Narrow the filters and re-pull to reach the rest.`,
    );
  }
  if (stopReason) {
    input.ctx.log.warning('Genotype-call pull stopped before the last page', {
      callsCollected: rows.length,
      totalPages,
      stopReason,
    });
    input.warnings.push(
      `Genotype-call pull stopped after ${rows.length} call(s): ${stopReason}. More calls may exist upstream; narrow the filters so the pull needs fewer pages, or retry the call.`,
    );
  }

  const result: CollectCallsResult = { rows, callFormatting, truncated };
  if (stopReason) result.stopReason = stopReason;
  return result;
}

/** A `Timeout` this call's deadline for upstream requests caused. */
function isCallDeadline(err: unknown): boolean {
  return (
    err instanceof McpError &&
    err.code === JsonRpcErrorCode.Timeout &&
    err.data?.reason === CALL_DEADLINE_REASON
  );
}

/**
 * Extract call rows and `callFormatting` hints from one BrAPI envelope page.
 * Mutates `rows` in-place; invokes `setCallFormatting` when formatting hints
 * are present so the caller can merge across pages.
 */
export function consumePage(
  envelope: Awaited<ReturnType<BrapiClient['get']>>,
  rows: CallRow[],
  setCallFormatting: (f: CallFormatting) => void,
): void {
  const result = envelope.result;
  if (!result || typeof result !== 'object') return;
  const record = result as Record<string, unknown>;
  const cf: CallFormatting = {};
  if (typeof record.expandHomozygotes === 'boolean')
    cf.expandHomozygotes = record.expandHomozygotes;
  if (typeof record.unknownString === 'string') cf.unknownString = record.unknownString;
  if (typeof record.sepPhased === 'string') cf.sepPhased = record.sepPhased;
  if (typeof record.sepUnphased === 'string') cf.sepUnphased = record.sepUnphased;
  setCallFormatting(cf);

  const data = record.data;
  if (!Array.isArray(data)) return;
  for (const entry of data) {
    if (typeof entry === 'object' && entry !== null) {
      rows.push(entry as CallRow);
    }
  }
}

/**
 * Render the genotype string for one call row given the server's callFormatting
 * hints. Prefers `genotype.values` joined with the appropriate separator;
 * falls back to `genotypeValue`; returns the `unknownString` (or ".") when
 * no data is available.
 */
export function renderGenotypeString(
  row: CallRow,
  callFormatting: CallFormatting,
  phased?: boolean,
): string {
  const unknown = callFormatting.unknownString ?? '.';
  const values = row.genotype?.values;
  if (values && values.length > 0) {
    const sep = phased ? (callFormatting.sepPhased ?? '|') : (callFormatting.sepUnphased ?? '/');
    return values.join(sep);
  }
  if (row.genotypeValue) return row.genotypeValue;
  return unknown;
}
