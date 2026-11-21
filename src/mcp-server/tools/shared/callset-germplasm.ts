/**
 * @fileoverview Call set → germplasm resolution for the genotype matrix export:
 * batch lookups through `GET /callsets` and `POST /search/samples`, degrading
 * to warnings when a route is missing or fails.
 *
 * @module mcp-server/tools/shared/callset-germplasm
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { requestCancelled } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import type { BrapiClient } from '@/services/brapi-client/index.js';
import type { BrapiDialect } from '@/services/brapi-dialect/index.js';
import { supportsMethod } from '@/services/capability-registry/supports-method.js';
import type { CallDescriptor } from '@/services/capability-registry/types.js';
import type { RegisteredServer } from '@/services/server-registry/index.js';
import {
  asString,
  type BrapiListResult,
  buildRequestOptions,
  companionRequestOptions,
  extractRows,
  firstRowKey,
} from './find-helpers.js';

/** Max call-set records scanned when resolving each call set's germplasm. */
const MAX_CALLSET_LOOKUP_ROWS = 50_000;

interface ResolveCallSetGermplasmArgs {
  /** Matrix rows; their `callSetDbId` values are the call sets to resolve. */
  callSets: readonly Record<string, unknown>[];
  client: BrapiClient;
  connection: RegisteredServer;
  ctx: Context;
  dialect: BrapiDialect;
  supported: Record<string, CallDescriptor>;
  variantSetDbId: string;
}

interface CallSetGermplasm {
  germplasmByCallSet: Map<string, string>;
  /** At most one: how many rows stayed unresolved, and why. */
  warnings: string[];
}

/**
 * Resolve each matrix row's germplasm. BrAPI's CallSet names a sample, and the
 * sample names the germplasm, so this pages `GET /callsets?variantSetDbId=` for
 * the call sets' samples (Breedbase rows carry the germplasm directly once the
 * dialect lifts it), then searches `POST /search/samples` by sample ID in
 * page-sized batches. Batch lookups only — never one request per call set or
 * sample.
 *
 * A companion, never the answer: each lookup — the `/callsets` walk, then the
 * sample search — finishes within one companion timeout, its requests sent with
 * no retries inside what is left of it and of the call deadline, on routes the
 * server advertises and the dialect allows. A missing route, timeout, or
 * upstream error leaves the affected rows' `germplasmDbId` null and is named in
 * one warning; caller cancellation rejects.
 */
export async function resolveCallSetGermplasm(
  args: ResolveCallSetGermplasmArgs,
): Promise<CallSetGermplasm> {
  const { client, connection, ctx, dialect, supported, variantSetDbId } = args;
  const germplasmByCallSet = new Map<string, string>();
  const warnings: string[] = [];
  const total = args.callSets.length;
  if (total === 0) return { germplasmByCallSet, warnings };

  const config = getServerConfig();
  const pageSize = config.pageSize;
  const gaps: string[] = [];
  const cancelled = () => requestCancelled('Genotype matrix export cancelled by the caller.');
  const outOfTime = (lookup: string) =>
    `the ${lookup} did not finish within the ${config.companionTimeoutMs / 1000} s companion timeout`;

  const needed = new Set<string>();
  for (const row of args.callSets) {
    if (typeof row.callSetDbId === 'string') needed.add(row.callSetDbId);
  }
  const withoutId = total - needed.size;
  if (withoutId > 0) gaps.push(`${withoutId} carry no callSetDbId to look up`);

  /** callSetDbId → sampleDbId, for listed call sets without a germplasm of their own. */
  const sampleByCallSet = new Map<string, string>();
  const listed = new Set<string>();
  if (needed.size > 0 && !supportsMethod(supported.callsets, 'GET')) {
    gaps.push('this server does not advertise GET /callsets');
  } else if (needed.size > 0) {
    let walkStopped = false;
    const walkEndsAt = Date.now() + config.companionTimeoutMs;
    try {
      let previousFirstRow: string | undefined;
      let scanned = 0;
      for (let page = 0; listed.size < needed.size; page++) {
        if (scanned >= MAX_CALLSET_LOOKUP_ROWS) {
          gaps.push(
            `the GET /callsets scan stopped at its ${MAX_CALLSET_LOOKUP_ROWS.toLocaleString('en-US')}-row cap`,
          );
          walkStopped = true;
          break;
        }
        const walkRemainingMs = walkEndsAt - Date.now();
        if (walkRemainingMs <= 0) {
          gaps.push(outOfTime('GET /callsets walk'));
          walkStopped = true;
          break;
        }
        const envelope = await client.get<
          BrapiListResult<Record<string, unknown>> | Record<string, unknown>[]
        >(connection.baseUrl, '/callsets', ctx, {
          ...companionRequestOptions(connection, dialect, config, warnings, {
            variantSetDbId,
            pageSize,
            page,
          }),
          deadlineMs: walkRemainingMs,
        });
        const rows = extractRows<Record<string, unknown>>(envelope.result).map(
          (row) => dialect.normalizeRow?.('callsets', row) ?? row,
        );
        if (rows.length === 0) break;
        const firstRow = firstRowKey(rows);
        if (firstRow === previousFirstRow) {
          gaps.push(`GET /callsets page ${page} repeated page ${page - 1}, so it is not paging`);
          walkStopped = true;
          break;
        }
        previousFirstRow = firstRow;
        scanned += rows.length;
        for (const row of rows) {
          const callSetDbId = asString(row.callSetDbId);
          if (!callSetDbId || !needed.has(callSetDbId) || listed.has(callSetDbId)) continue;
          listed.add(callSetDbId);
          const germplasmDbId = asString(row.germplasmDbId);
          const sampleDbId = asString(row.sampleDbId);
          if (germplasmDbId) germplasmByCallSet.set(callSetDbId, germplasmDbId);
          else if (sampleDbId) sampleByCallSet.set(callSetDbId, sampleDbId);
        }
        const totalPages = envelope.metadata?.pagination?.totalPages;
        if (totalPages === undefined ? rows.length < pageSize : page + 1 >= totalPages) break;
      }
    } catch {
      if (ctx.signal.aborted) throw cancelled();
      gaps.push('the GET /callsets lookup failed or timed out');
      walkStopped = true;
    }
    const unlisted = needed.size - listed.size;
    if (unlisted > 0 && !walkStopped) {
      gaps.push(`${unlisted} are not listed by GET /callsets for this variant set`);
    }
    const bare = listed.size - germplasmByCallSet.size - sampleByCallSet.size;
    if (bare > 0) gaps.push(`${bare} list neither a germplasmDbId nor a sampleDbId`);
  }

  const sampleDbIds = [...new Set(sampleByCallSet.values())];
  if (sampleDbIds.length > 0) {
    if (!supportsMethod(supported['search/samples'], 'POST')) {
      gaps.push('this server does not advertise POST /search/samples to resolve their samples');
    } else if (dialect.disabledSearchEndpoints?.has('samples')) {
      gaps.push(`the '${dialect.id}' dialect marks POST /search/samples as unavailable`);
    } else {
      const germplasmBySample = new Map<string, string>();
      let searchFailed = false;
      const searchEndsAt = Date.now() + config.companionTimeoutMs;
      // Each request, async poll included, gets what the search has left.
      const companion = () => ({
        timeoutMs: config.companionTimeoutMs,
        retryMaxAttempts: 0,
        deadlineMs: Math.max(0, searchEndsAt - Date.now()),
      });
      try {
        for (let start = 0; start < sampleDbIds.length; start += pageSize) {
          if (Date.now() >= searchEndsAt) {
            gaps.push(outOfTime('POST /search/samples lookup'));
            searchFailed = true;
            break;
          }
          const batch = sampleDbIds.slice(start, start + pageSize);
          const first = await client.postSearch<
            BrapiListResult<Record<string, unknown>> | Record<string, unknown>[]
          >(
            connection.baseUrl,
            'samples',
            { sampleDbIds: batch, pageSize, page: 0 },
            ctx,
            buildRequestOptions(connection, undefined, companion()),
          );
          const envelope =
            first.kind === 'sync'
              ? first.envelope
              : await client.getSearchResults<
                  BrapiListResult<Record<string, unknown>> | Record<string, unknown>[]
                >(
                  connection.baseUrl,
                  'samples',
                  first.searchResultsDbId,
                  ctx,
                  buildRequestOptions(connection, { page: 0, pageSize }, companion()),
                );
          for (const row of extractRows<Record<string, unknown>>(envelope.result)) {
            const sampleDbId = asString(row.sampleDbId);
            const germplasmDbId = asString(row.germplasmDbId);
            if (sampleDbId && germplasmDbId) germplasmBySample.set(sampleDbId, germplasmDbId);
          }
        }
      } catch {
        if (ctx.signal.aborted) throw cancelled();
        gaps.push('the POST /search/samples lookup failed or timed out');
        searchFailed = true;
      }
      let missing = 0;
      for (const [callSetDbId, sampleDbId] of sampleByCallSet) {
        const germplasmDbId = germplasmBySample.get(sampleDbId);
        if (germplasmDbId) germplasmByCallSet.set(callSetDbId, germplasmDbId);
        else missing++;
      }
      if (missing > 0 && !searchFailed) {
        gaps.push(`POST /search/samples returned no germplasmDbId for ${missing} of their samples`);
      }
    }
  }

  const unresolved = total - germplasmByCallSet.size;
  if (unresolved > 0) {
    warnings.push(
      `germplasmDbId is null for ${unresolved} of ${total} call sets: ${gaps.join('; ')}. Those rows cannot be joined to phenotype data on germplasmDbId.`,
    );
  }
  return { germplasmByCallSet, warnings };
}
