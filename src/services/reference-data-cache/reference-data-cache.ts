/**
 * @fileoverview Per-connection cache for BrAPI reference nouns — programs,
 * trials, locations — used by `brapi_get_study` (and the `brapi://study`
 * resource) to resolve a study's foreign keys. A noun whose detail route
 * (`GET /{noun}/{id}`) the capability profile advertises resolves one
 * singleton request per ID; otherwise one list request filters by the IDs.
 * Every request runs on the companion budget. A requested ID the lookup
 * doesn't return yields a warning and stays uncached. Cache keys are
 * tenant-scoped via `ctx.state` with TTL from
 * `BRAPI_REFERENCE_CACHE_TTL_SECONDS`.
 *
 * @module services/reference-data-cache/reference-data-cache
 */

import { createHash } from 'node:crypto';
import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { ServerConfig } from '@/config/server-config.js';
import {
  type BrapiClient,
  type BrapiEnvelope,
  type BrapiRequestOptions,
  getBrapiClient,
} from '@/services/brapi-client/index.js';
import type { BrapiDialect } from '@/services/brapi-dialect/index.js';
import { supportsMethod } from '@/services/capability-registry/supports-method.js';
import type { CapabilityProfile } from '@/services/capability-registry/types.js';
import type { Location, Program, Trial } from './types.js';

export interface ReferenceLookupOptions {
  auth?: BrapiRequestOptions['auth'];
  /**
   * Active dialect for the connection, used on the list route so the v2.1
   * plural ID filter (`trialDbIds`, `programDbIds`, …) reaches the wire in
   * the form the server honors.
   */
  dialect?: BrapiDialect;
  /**
   * Capability profile of the connection. A noun whose detail route it lists
   * with GET (or with no methods) resolves through `GET /{noun}/{id}`, and
   * that answer is final; without the profile or the route, the list filter
   * runs.
   */
  profile?: CapabilityProfile;
  /** Receives dialect-translation warnings and one warning per requested ID not returned. */
  warnings?: string[];
}

interface NounConfig<T> {
  /** Cache key segment, also the noun named in miss warnings. */
  cachePrefix: string;
  /** Capability key of the detail route. */
  detailService: string;
  endpoint: string;
  idField: keyof T & string;
  idFilter: string;
}

const PROGRAM_CFG: NounConfig<Program> = {
  endpoint: '/programs',
  detailService: 'programs/{programDbId}',
  idFilter: 'programDbIds',
  idField: 'programDbId',
  cachePrefix: 'program',
};

const TRIAL_CFG: NounConfig<Trial> = {
  endpoint: '/trials',
  detailService: 'trials/{trialDbId}',
  idFilter: 'trialDbIds',
  idField: 'trialDbId',
  cachePrefix: 'trial',
};

const LOCATION_CFG: NounConfig<Location> = {
  endpoint: '/locations',
  detailService: 'locations/{locationDbId}',
  idFilter: 'locationDbIds',
  idField: 'locationDbId',
  cachePrefix: 'location',
};

export class ReferenceDataCache {
  constructor(
    private readonly serverConfig: ServerConfig,
    private readonly client: () => BrapiClient = getBrapiClient,
  ) {}

  getPrograms(
    baseUrl: string,
    programDbIds: readonly string[],
    ctx: Context,
    options?: ReferenceLookupOptions,
  ): Promise<Map<string, Program>> {
    return this.batchResolve(PROGRAM_CFG, baseUrl, programDbIds, ctx, options);
  }

  getTrials(
    baseUrl: string,
    trialDbIds: readonly string[],
    ctx: Context,
    options?: ReferenceLookupOptions,
  ): Promise<Map<string, Trial>> {
    return this.batchResolve(TRIAL_CFG, baseUrl, trialDbIds, ctx, options);
  }

  getLocations(
    baseUrl: string,
    locationDbIds: readonly string[],
    ctx: Context,
    options?: ReferenceLookupOptions,
  ): Promise<Map<string, Location>> {
    return this.batchResolve(LOCATION_CFG, baseUrl, locationDbIds, ctx, options);
  }

  private async batchResolve<T extends object>(
    cfg: NounConfig<T>,
    baseUrl: string,
    ids: readonly string[],
    ctx: Context,
    options: ReferenceLookupOptions = {},
  ): Promise<Map<string, T>> {
    if (ids.length === 0) return new Map();

    const uniqueIds = Array.from(new Set(ids));
    const serverSlug = serverKey(baseUrl);
    const keyFor = (id: string) => `brapi/ref/${cfg.cachePrefix}/${serverSlug}/${id}`;

    const cached = await ctx.state.getMany<T>(uniqueIds.map(keyFor));

    const results = new Map<string, T>();
    const missing: string[] = [];
    for (const id of uniqueIds) {
      const hit = cached.get(keyFor(id));
      if (hit) results.set(id, hit);
      else missing.push(id);
    }

    if (missing.length === 0) return results;

    const detail = supportsMethod(options.profile?.supported[cfg.detailService], 'GET');
    const fetched = detail
      ? await this.fetchDetails(cfg, baseUrl, missing, ctx, options)
      : await this.fetchList(cfg, baseUrl, missing, ctx, options);
    const ttl = this.serverConfig.referenceCacheTtlSeconds;
    await Promise.all(
      missing.map(async (id) => {
        const item = fetched.get(id);
        if (!item) {
          options.warnings?.push(
            `${cfg.cachePrefix} '${id}' not found: ${
              detail
                ? `GET ${cfg.endpoint}/${encodeURIComponent(id)} returned no matching record`
                : `GET ${cfg.endpoint} filtered by ID did not return it`
            }.`,
          );
          return;
        }
        await ctx.state.set(keyFor(id), item, { ttl });
        results.set(id, item);
      }),
    );
    return results;
  }

  /** One list request filtered by the IDs; rows keyed by their own ID. */
  private async fetchList<T extends object>(
    cfg: NounConfig<T>,
    baseUrl: string,
    ids: string[],
    ctx: Context,
    options: ReferenceLookupOptions,
  ): Promise<Map<string, T>> {
    const requestOptions = this.companionOptions(options, {
      params: { [cfg.idFilter]: ids, pageSize: ids.length },
    });
    if (options.dialect) requestOptions.dialect = options.dialect;
    if (options.warnings) requestOptions.warnings = options.warnings;
    const env = await this.client().get<T[] | { data: T[] }>(
      baseUrl,
      cfg.endpoint,
      ctx,
      requestOptions,
    );
    return new Map(extractDataArray(env).map((item) => [String(item[cfg.idField] ?? ''), item]));
  }

  /**
   * One `GET /{noun}/{id}` per ID, at most `maxConcurrentRequests` at a time.
   * Every worker settles before a failure propagates, and the first failure
   * stops the queue.
   */
  private async fetchDetails<T extends object>(
    cfg: NounConfig<T>,
    baseUrl: string,
    ids: string[],
    ctx: Context,
    options: ReferenceLookupOptions,
  ): Promise<Map<string, T>> {
    const found = new Map<string, T>();
    const queue = [...ids];
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        try {
          const record = await this.fetchDetail(cfg, baseUrl, id, ctx, options);
          if (record) found.set(id, record);
        } catch (err) {
          queue.length = 0;
          throw err;
        }
      }
    };
    const workers = Math.min(this.serverConfig.maxConcurrentRequests, ids.length);
    const settled = await Promise.allSettled(Array.from({ length: workers }, worker));
    for (const outcome of settled) if (outcome.status === 'rejected') throw outcome.reason;
    return found;
  }

  /**
   * The record for `id`, or `undefined` when the server has none: HTTP 404,
   * the 5xx a singleton fetch reclassifies as not found (SGN answers unknown
   * IDs with HTTP 500), or a 200 whose `result` is not a record carrying `id`
   * (SGN answers some unknown IDs with `result: null`).
   */
  private async fetchDetail<T extends object>(
    cfg: NounConfig<T>,
    baseUrl: string,
    id: string,
    ctx: Context,
    options: ReferenceLookupOptions,
  ): Promise<T | undefined> {
    try {
      const env = await this.client().get<unknown>(
        baseUrl,
        `${cfg.endpoint}/${encodeURIComponent(id)}`,
        ctx,
        this.companionOptions(options, { singleton: true }),
      );
      const record = env.result;
      return isRecord(record) && String(record[cfg.idField] ?? '') === id
        ? (record as T)
        : undefined;
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) return;
      throw err;
    }
  }

  /** Companion budget: one attempt under the companion timeout, clipped to the call deadline. */
  private companionOptions(
    options: ReferenceLookupOptions,
    request: BrapiRequestOptions,
  ): BrapiRequestOptions {
    const out: BrapiRequestOptions = {
      ...request,
      timeoutMs: this.serverConfig.companionTimeoutMs,
      retryMaxAttempts: 0,
    };
    if (options.auth) out.auth = options.auth;
    return out;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractDataArray<T>(envelope: BrapiEnvelope<T[] | { data: T[] }>): T[] {
  const result = envelope.result;
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object' && 'data' in result && Array.isArray(result.data)) {
    return result.data;
  }
  return [];
}

/**
 * State keys admit only `[A-Za-z0-9._/-]`, so the base URL is hashed rather
 * than character-mapped: a lossy mapping lets distinct servers share entries.
 */
function serverKey(baseUrl: string): string {
  return createHash('sha256').update(baseUrl).digest('hex');
}

let _cache: ReferenceDataCache | undefined;

export function initReferenceDataCache(serverConfig: ServerConfig): void {
  _cache = new ReferenceDataCache(serverConfig);
}

export function getReferenceDataCache(): ReferenceDataCache {
  if (!_cache) {
    throw new Error(
      'ReferenceDataCache not initialized — call initReferenceDataCache() in setup()',
    );
  }
  return _cache;
}

export function resetReferenceDataCache(): void {
  _cache = undefined;
}
