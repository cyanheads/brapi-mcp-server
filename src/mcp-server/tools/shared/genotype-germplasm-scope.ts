/**
 * @fileoverview Resolve verified germplasm membership before collecting genotype calls.
 * @module mcp-server/tools/shared/genotype-germplasm-scope
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, requestCancelled } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { type BrapiClient, callDeadlineAt } from '@/services/brapi-client/index.js';
import type { BrapiDialect } from '@/services/brapi-dialect/index.js';
import { supportsMethod } from '@/services/capability-registry/supports-method.js';
import type { CallDescriptor } from '@/services/capability-registry/types.js';
import type { RegisteredServer } from '@/services/server-registry/types.js';
import { asString, buildRequestOptions, extractListRows } from './find-helpers.js';

/** Error exposed by both genotype tools when a requested scope cannot be established. */
export const GERMPLASM_SCOPE_UNAVAILABLE = {
  code: JsonRpcErrorCode.ServiceUnavailable,
  when: 'The upstream does not expose a working lookup that can establish the requested germplasm-to-call-set membership completely',
} as const;

interface ScopeLookup {
  callSetDbIds?: readonly string[];
  client: BrapiClient;
  connection: RegisteredServer;
  ctx: Context;
  dialect: BrapiDialect;
  germplasmDbIds: readonly string[];
  supported: Record<string, CallDescriptor>;
  unavailable: (
    message: string,
    details: { germplasmDbIds: string[]; lookupFailures: string[] },
  ) => Error;
  variantSetDbIds?: readonly string[];
}

type LookupEntity = 'callsets' | 'samples';
type Row = Record<string, unknown>;
type Page = Awaited<ReturnType<BrapiClient['get']>>;

class IncompleteLookup extends Error {}

/** Resolve a complete, verified call-set scope. An empty map is a proven no-match. */
export async function resolveGenotypeGermplasmScope(
  args: ScopeLookup,
): Promise<Map<string, string>> {
  const { client, connection, ctx, dialect, supported } = args;
  const { pageSize, callDeadlineMs, companionTimeoutMs } = getServerConfig();
  const callEndsAt = callDeadlineAt(ctx, callDeadlineMs);
  const wanted = new Set(args.germplasmDbIds);
  const explicit = new Set(args.callSetDbIds);
  const variantSets = args.variantSetDbIds ?? [];
  const variantFilter = variantSets.length > 0 ? { variantSetDbIds: variantSets } : {};
  const unavailable: string[] = [];

  function remaining(endsAt: number): number {
    if (ctx.signal.aborted)
      throw requestCancelled('Genotype germplasm lookup cancelled by the caller.');
    const left = Math.min(endsAt, callEndsAt) - Date.now();
    if (left <= 0) throw new IncompleteLookup('the lookup deadline expired');
    return left;
  }

  const supportsSearch = (entity: LookupEntity) =>
    supportsMethod(supported[`search/${entity}`], 'POST') &&
    !dialect.disabledSearchEndpoints?.has(entity);
  const supportsList = (entity: LookupEntity) => supportsMethod(supported[entity], 'GET');

  async function* readPages(
    entity: LookupEntity,
    method: 'GET' | 'POST',
    filters: Record<string, string | readonly string[]>,
    endsAt: number,
  ): AsyncGenerator<{ id: string; row: Row }> {
    let searchId: string | undefined;
    let count = 0;
    let knownTotal: number | undefined;
    let knownPages: number | undefined;
    let effectivePageSize: number | undefined;
    const seen = new Set<string>();
    const route = method === 'POST' ? `POST /search/${entity}` : `GET /${entity}`;
    const idKey = entity === 'callsets' ? 'callSetDbId' : 'sampleDbId';
    const adapted = method === 'GET' ? dialect.adaptGetFilters(entity, filters) : undefined;
    if (adapted?.dropped.length || adapted?.requiresEscalation) {
      throw new IncompleteLookup(`${route} cannot apply the lookup filters`);
    }
    function getResults(id: string, page: number): Promise<Page> {
      if (!supportsMethod(supported[`search/${entity}/{searchResultsDbId}`], 'GET')) {
        throw new IncompleteLookup(`the upstream does not advertise async results for ${route}`);
      }
      return client.getSearchResults(
        connection.baseUrl,
        entity,
        id,
        ctx,
        buildRequestOptions(
          connection,
          { page, pageSize },
          { deadlineMs: remaining(endsAt), retryMaxAttempts: 0 },
        ),
      );
    }
    for (let page = 0; ; page++) {
      const options = buildRequestOptions(connection, undefined, {
        deadlineMs: remaining(endsAt),
        retryMaxAttempts: 0,
      });
      let response: Page;
      if (searchId) {
        response = await getResults(searchId, page);
      } else if (adapted) {
        response = await client.get(connection.baseUrl, `/${entity}`, ctx, {
          ...options,
          params: { ...adapted.filters, page, pageSize } as NonNullable<typeof options.params>,
        });
      } else {
        const search = await client.postSearch(
          connection.baseUrl,
          entity,
          { ...filters, page, pageSize },
          ctx,
          options,
        );
        if (search.kind === 'async') {
          searchId = search.searchResultsDbId;
          response = await getResults(searchId, page);
        } else {
          response = search.envelope;
        }
      }
      remaining(endsAt);
      const rows = extractListRows(response.result);
      if (!rows) throw new IncompleteLookup(`${route} did not return a row list`);
      const pagination = response.metadata?.pagination;
      if (pagination?.currentPage !== undefined && pagination.currentPage !== page) {
        throw new IncompleteLookup(`${route} returned the wrong page`);
      }
      const reportedSize = pagination?.pageSize;
      if (reportedSize && reportedSize !== effectivePageSize) {
        // A new size would change the offset for this and earlier pages.
        if (page > 0 && (effectivePageSize !== undefined || count !== page * reportedSize)) {
          throw new IncompleteLookup(`${route} changed its effective page size`);
        }
        effectivePageSize = reportedSize;
      }
      const { totalCount, totalPages } = pagination ?? {};
      if (
        (totalCount !== undefined && knownTotal !== undefined && totalCount < knownTotal) ||
        (totalPages !== undefined && knownPages !== undefined && totalPages < knownPages)
      ) {
        throw new IncompleteLookup(`${route} decreased its declared pagination bounds`);
      }
      knownTotal = totalCount ?? knownTotal;
      knownPages = totalPages ?? knownPages;
      for (const row of rows) {
        const normalized = dialect.normalizeRow?.(entity, row) ?? row;
        const id = asString(normalized[idKey]);
        if (!id) throw new IncompleteLookup(`${route} returned a row with no ${idKey}`);
        if (seen.has(id)) throw new IncompleteLookup(`${route} repeated a ${idKey} while paging`);
        seen.add(id);
        yield { id, row: normalized };
      }
      count += rows.length;
      const last =
        knownPages !== undefined
          ? page + 1 >= knownPages
          : knownTotal !== undefined
            ? count >= knownTotal
            : rows.length < (effectivePageSize ?? pageSize);
      if (last && (knownTotal === undefined || knownTotal === count)) return;
      if (rows.length === 0 || last)
        throw new IncompleteLookup(`${route} returned an incomplete page walk`);
    }
  }

  async function attempt<T>(label: string, lookup: () => Promise<T>): Promise<T | undefined> {
    try {
      return await lookup();
    } catch (err) {
      if (ctx.signal.aborted)
        throw requestCancelled('Genotype germplasm lookup cancelled by the caller.');
      if (err instanceof IncompleteLookup) unavailable.push(`${label}: ${err.message}`);
      else if (err instanceof McpError) {
        if (err.code === JsonRpcErrorCode.Unauthorized || err.code === JsonRpcErrorCode.Forbidden)
          throw err;
        unavailable.push(
          `${label}: ${err.code === JsonRpcErrorCode.Timeout ? 'the upstream request timed out' : 'the upstream request failed'}`,
        );
      } else throw err;
      return undefined;
    }
  }

  async function collectMembership(
    observed: Map<string, string>,
    rows: ReturnType<typeof readPages>,
    sampleGermplasm?: ReadonlyMap<string, string>,
  ) {
    for await (const { id, row } of rows) {
      if (explicit.size && !explicit.has(id)) continue;
      const sampleId = asString(row.sampleDbId);
      const direct = asString(row.germplasmDbId);
      const throughSample = sampleId ? sampleGermplasm?.get(sampleId) : undefined;
      if (throughSample && direct && direct !== throughSample) {
        throw new IncompleteLookup('a call set disagrees with its sample on germplasm identity');
      }
      const germplasm = direct ?? throughSample;
      if (!germplasm && sampleGermplasm && sampleId) continue;
      if (!germplasm)
        throw new IncompleteLookup('a call set lacks verifiable germplasm membership');
      recordMembership(observed, 'callSetDbId', id, germplasm);
    }
    return observed;
  }

  // Keep out-of-scope observations until all walks agree on each identity.
  function keepRequested(observed: ReadonlyMap<string, string>): Map<string, string> {
    return new Map([...observed].filter(([, germplasm]) => wanted.has(germplasm)));
  }

  // A short direct attempt leaves time for the standard sample-based route.
  if (supportsSearch('callsets')) {
    const direct = await attempt('direct call-set search', () =>
      collectMembership(
        new Map(),
        readPages(
          'callsets',
          'POST',
          { ...variantFilter, germplasmDbIds: [...wanted] },
          Date.now() + companionTimeoutMs,
        ),
      ),
    );
    if (direct) return keepRequested(direct);
  }
  if (supportsList('callsets')) {
    const direct = await attempt('direct call-set list', async () => {
      const endsAt = Date.now() + companionTimeoutMs;
      const matched = new Map<string, string>();
      for (const germplasmDbId of wanted) {
        for (const variantSetDbId of variantSets.length ? variantSets : [undefined]) {
          const filters = { germplasmDbId, ...(variantSetDbId && { variantSetDbId }) };
          await collectMembership(matched, readPages('callsets', 'GET', filters, endsAt));
        }
      }
      return matched;
    });
    if (direct) return keepRequested(direct);
  }

  async function collectSamples(method: 'POST' | 'GET') {
    const sampleGermplasm = new Map<string, string>();
    const filtersForMethod =
      method === 'POST'
        ? [{ germplasmDbIds: [...wanted] }]
        : [...wanted].map((germplasmDbId) => ({ germplasmDbId }));
    for (const filters of filtersForMethod) {
      for await (const { id, row } of readPages('samples', method, filters, callEndsAt)) {
        const germplasm = asString(row.germplasmDbId);
        if (!germplasm)
          throw new IncompleteLookup('a sample lacks verifiable germplasm membership');
        recordMembership(sampleGermplasm, 'sampleDbId', id, germplasm);
      }
    }
    return sampleGermplasm;
  }
  const viaSamples = await attempt('sample-based call-set lookup', async () => {
    const sampleGermplasm =
      (supportsSearch('samples')
        ? await attempt('sample search', () => collectSamples('POST'))
        : undefined) ??
      (supportsList('samples')
        ? await attempt('sample list', () => collectSamples('GET'))
        : undefined);
    if (!sampleGermplasm) {
      throw new IncompleteLookup('the upstream does not advertise a working sample lookup');
    }
    const sampleIds = [...keepRequested(sampleGermplasm).keys()];
    if (sampleIds.length === 0) return new Map<string, string>();

    if (supportsSearch('callsets')) {
      const searched = await attempt('call-set search by sample', async () => {
        const matched = new Map<string, string>();
        for (let offset = 0; offset < sampleIds.length; offset += pageSize) {
          const filters = {
            ...variantFilter,
            sampleDbIds: sampleIds.slice(offset, offset + pageSize),
          };
          await collectMembership(
            matched,
            readPages('callsets', 'POST', filters, callEndsAt),
            sampleGermplasm,
          );
        }
        return matched;
      });
      if (searched) return searched;
    }
    if (!supportsList('callsets'))
      throw new IncompleteLookup('the upstream does not advertise a working call-set lookup');
    const matched = new Map<string, string>();
    const filtersForList = variantSets.length
      ? variantSets.map((variantSetDbId) => ({ variantSetDbId }))
      : sampleIds.map((sampleDbId) => ({ sampleDbId }));
    for (const filters of filtersForList) {
      await collectMembership(
        matched,
        readPages('callsets', 'GET', filters, callEndsAt),
        sampleGermplasm,
      );
    }
    return matched;
  });
  if (viaSamples) return keepRequested(viaSamples);

  throw args.unavailable(
    `Could not resolve the requested germplasm to call sets. No genotype calls were requested. ${unavailable.join('. ')}.`,
    { germplasmDbIds: [...wanted], lookupFailures: unavailable },
  );
}

function recordMembership(
  observed: Map<string, string>,
  idKey: 'sampleDbId' | 'callSetDbId',
  id: string,
  germplasm: string,
): void {
  const previous = observed.get(id);
  if (previous !== undefined && previous !== germplasm) {
    throw new IncompleteLookup(
      `the upstream returned conflicting germplasm identities for the same ${idKey}`,
    );
  }
  observed.set(id, germplasm);
}
