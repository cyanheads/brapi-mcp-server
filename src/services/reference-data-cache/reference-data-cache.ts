/**
 * @fileoverview Per-connection batch cache for BrAPI reference nouns —
 * programs, trials, locations. Used by tools (e.g. `find_studies`) to
 * resolve foreign keys in a single upstream call per noun instead of N+1
 * per-row lookups. Cache keys are tenant-scoped via `ctx.state` with TTL
 * from `BRAPI_REFERENCE_CACHE_TTL_SECONDS`.
 *
 * @module services/reference-data-cache/reference-data-cache
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { ServerConfig } from '@/config/server-config.js';
import {
  type BrapiClient,
  type BrapiEnvelope,
  type BrapiRequestOptions,
  getBrapiClient,
} from '@/services/brapi-client/index.js';
import type { Location, Program, Trial } from './types.js';

export type ReferenceLookupOptions = Pick<BrapiRequestOptions, 'auth'>;

interface BatchResolveConfig<T> {
  cachePrefix: string;
  endpoint: string;
  idField: keyof T;
  idFilter: string;
}

const PROGRAM_CFG: BatchResolveConfig<Program> = {
  endpoint: '/programs',
  idFilter: 'programDbIds',
  idField: 'programDbId',
  cachePrefix: 'program',
};

const TRIAL_CFG: BatchResolveConfig<Trial> = {
  endpoint: '/trials',
  idFilter: 'trialDbIds',
  idField: 'trialDbId',
  cachePrefix: 'trial',
};

const LOCATION_CFG: BatchResolveConfig<Location> = {
  endpoint: '/locations',
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

  /** Drop every cached entry for a base URL across all reference nouns. */
  async invalidate(baseUrl: string, ctx: Context): Promise<void> {
    const serverSlug = sanitizeKey(baseUrl);
    await Promise.all([
      this.deletePrefix(ctx, `brapi:ref:${PROGRAM_CFG.cachePrefix}:${serverSlug}:`),
      this.deletePrefix(ctx, `brapi:ref:${TRIAL_CFG.cachePrefix}:${serverSlug}:`),
      this.deletePrefix(ctx, `brapi:ref:${LOCATION_CFG.cachePrefix}:${serverSlug}:`),
    ]);
  }

  private async batchResolve<T extends object>(
    cfg: BatchResolveConfig<T>,
    baseUrl: string,
    ids: readonly string[],
    ctx: Context,
    options: ReferenceLookupOptions = {},
  ): Promise<Map<string, T>> {
    if (ids.length === 0) return new Map();

    const uniqueIds = Array.from(new Set(ids));
    const serverSlug = sanitizeKey(baseUrl);
    const keyFor = (id: string) => `brapi:ref:${cfg.cachePrefix}:${serverSlug}:${id}`;

    const cached = await ctx.state.getMany<T>(uniqueIds.map(keyFor));

    const results = new Map<string, T>();
    const missing: string[] = [];
    for (const id of uniqueIds) {
      const hit = cached.get(keyFor(id));
      if (hit) results.set(id, hit);
      else missing.push(id);
    }

    if (missing.length === 0) return results;

    const fetched = await this.fetchBatch(cfg, baseUrl, missing, ctx, options);
    const ttl = this.serverConfig.referenceCacheTtlSeconds;
    await Promise.all(
      fetched.map(async (item) => {
        const id = String((item as Record<string, unknown>)[cfg.idField as string] ?? '');
        if (!id) return;
        await ctx.state.set(keyFor(id), item, { ttl });
        results.set(id, item);
      }),
    );
    return results;
  }

  private async fetchBatch<T extends object>(
    cfg: BatchResolveConfig<T>,
    baseUrl: string,
    ids: string[],
    ctx: Context,
    options: ReferenceLookupOptions,
  ): Promise<T[]> {
    const requestOptions: BrapiRequestOptions = {
      params: { [cfg.idFilter]: ids, pageSize: ids.length },
    };
    if (options.auth) requestOptions.auth = options.auth;
    const env = await this.client().get<T[] | { data: T[] }>(
      baseUrl,
      cfg.endpoint,
      ctx,
      requestOptions,
    );
    return extractDataArray<T>(env);
  }

  private async deletePrefix(ctx: Context, prefix: string): Promise<void> {
    let cursor: string | undefined;
    do {
      const listOpts: { cursor?: string; limit: number } = { limit: 100 };
      if (cursor !== undefined) listOpts.cursor = cursor;
      const page = await ctx.state.list(prefix, listOpts);
      if (page.items.length > 0) {
        await ctx.state.deleteMany(page.items.map((item) => item.key));
      }
      cursor = page.cursor;
    } while (cursor);
  }
}

function extractDataArray<T>(envelope: BrapiEnvelope<T[] | { data: T[] }>): T[] {
  const result = envelope.result;
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object' && 'data' in result && Array.isArray(result.data)) {
    return result.data;
  }
  return [];
}

function sanitizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, '-');
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
