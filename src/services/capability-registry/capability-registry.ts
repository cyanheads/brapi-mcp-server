/**
 * @fileoverview Capability profile loader + cache for BrAPI servers. Pulls
 * `/serverinfo`, `/calls`, and `/commoncropnames` on first use (or refresh),
 * normalizes the shape, and stores the result in tenant-scoped state. Tools
 * consult this before routing requests — if a required endpoint isn't in the
 * server's capability set, the service surfaces a clear `ValidationError`
 * instead of letting the call fail downstream.
 *
 * @module services/capability-registry/capability-registry
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import type { ServerConfig } from '@/config/server-config.js';
import {
  type BrapiClient,
  type BrapiEnvelope,
  type BrapiRequestOptions,
  getBrapiClient,
} from '@/services/brapi-client/index.js';
import type {
  CallDescriptor,
  CapabilityProfile,
  EndpointProbe,
  ServerIdentity,
  ServerInfoPayload,
} from './types.js';

export interface CapabilityLookupOptions extends Pick<BrapiRequestOptions, 'auth'> {
  /** Force a fresh fetch, bypassing the cached profile. */
  forceRefresh?: boolean;
}

const STATE_KEY_PREFIX = 'brapi:capability:';

export class CapabilityRegistry {
  constructor(
    private readonly serverConfig: ServerConfig,
    private readonly client: () => BrapiClient = getBrapiClient,
  ) {}

  /**
   * Load the capability profile for a base URL. Returns the cached profile
   * when present and not expired; otherwise fetches fresh and caches it.
   */
  async profile(
    baseUrl: string,
    ctx: Context,
    options: CapabilityLookupOptions = {},
  ): Promise<CapabilityProfile> {
    const key = this.cacheKey(baseUrl);
    if (!options.forceRefresh) {
      const cached = await ctx.state.get<CapabilityProfile>(key);
      if (cached) return cached;
    }
    const fresh = await this.fetchProfile(baseUrl, ctx, options);
    await ctx.state.set(key, fresh, {
      ttl: this.serverConfig.referenceCacheTtlSeconds,
    });
    return fresh;
  }

  /**
   * Throw a `ValidationError` if the requested endpoint (service + optional
   * HTTP method) is not in the server's capability set. Tools call this
   * before routing requests so missing-capability errors surface early with
   * a clear recovery hint.
   */
  async ensure(
    baseUrl: string,
    probe: EndpointProbe,
    ctx: Context,
    options: CapabilityLookupOptions = {},
  ): Promise<CallDescriptor> {
    const profile = await this.profile(baseUrl, ctx, options);
    const descriptor = profile.supported[probe.service];
    if (!descriptor) {
      throw validationError(
        `BrAPI server at ${baseUrl} does not advertise '${probe.service}' in /calls. Check brapi_server_info for the full capability list.`,
        {
          baseUrl,
          missingService: probe.service,
          supportedCount: Object.keys(profile.supported).length,
        },
      );
    }
    if (probe.method && descriptor.methods && !descriptor.methods.includes(probe.method)) {
      throw validationError(
        `BrAPI server at ${baseUrl} supports '${probe.service}' but not the ${probe.method} method.`,
        {
          baseUrl,
          service: probe.service,
          requestedMethod: probe.method,
          supportedMethods: descriptor.methods,
        },
      );
    }
    return descriptor;
  }

  /** Drop the cached profile for a base URL (e.g. on explicit reconnect). */
  async invalidate(baseUrl: string, ctx: Context): Promise<void> {
    await ctx.state.delete(this.cacheKey(baseUrl));
  }

  private async fetchProfile(
    baseUrl: string,
    ctx: Context,
    options: CapabilityLookupOptions,
  ): Promise<CapabilityProfile> {
    const client = this.client();
    const requestOptions = buildRequestOptions(options.auth);

    const serverInfoEnv = await client.get<ServerInfoPayload>(
      baseUrl,
      '/serverinfo',
      ctx,
      requestOptions,
    );

    const embeddedCalls = serverInfoEnv.result?.calls;
    const calls = embeddedCalls?.length
      ? embeddedCalls
      : await this.fetchCallsFallback(baseUrl, ctx, options.auth);

    const crops = await this.fetchCrops(baseUrl, ctx, options.auth);

    const supported = indexCalls(calls);
    const server = normalizeIdentity(serverInfoEnv.result, calls);

    return {
      baseUrl,
      server,
      supported,
      crops,
      fetchedAt: new Date().toISOString(),
    };
  }

  /**
   * `/calls` fallback — some servers don't embed calls in `/serverinfo` and
   * expect clients to hit the dedicated endpoint. Degrades to an empty list
   * if the server lacks this too; downstream `ensure()` will surface the
   * missing-capability error with a useful message.
   */
  private async fetchCallsFallback(
    baseUrl: string,
    ctx: Context,
    auth: CapabilityLookupOptions['auth'],
  ): Promise<CallDescriptor[]> {
    try {
      const env = await this.client().get<CallDescriptor[] | { data: CallDescriptor[] }>(
        baseUrl,
        '/calls',
        ctx,
        buildRequestOptions(auth, { pageSize: 1000 }),
      );
      return extractDataArray<CallDescriptor>(env) ?? [];
    } catch (err) {
      ctx.log.warning('Failed to fetch /calls fallback', {
        baseUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  private async fetchCrops(
    baseUrl: string,
    ctx: Context,
    auth: CapabilityLookupOptions['auth'],
  ): Promise<string[]> {
    try {
      const env = await this.client().get<string[] | { data: string[] }>(
        baseUrl,
        '/commoncropnames',
        ctx,
        buildRequestOptions(auth, { pageSize: 1000 }),
      );
      return extractDataArray<string>(env) ?? [];
    } catch (err) {
      ctx.log.warning('Failed to fetch /commoncropnames', {
        baseUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  private cacheKey(baseUrl: string): string {
    return `${STATE_KEY_PREFIX}${sanitizeKey(baseUrl)}`;
  }
}

function buildRequestOptions(
  auth: CapabilityLookupOptions['auth'],
  params?: BrapiRequestOptions['params'],
): BrapiRequestOptions {
  const options: BrapiRequestOptions = {};
  if (auth) options.auth = auth;
  if (params) options.params = params;
  return options;
}

function indexCalls(calls: CallDescriptor[]): Record<string, CallDescriptor> {
  const indexed: Record<string, CallDescriptor> = {};
  for (const call of calls) {
    if (!call?.service) continue;
    const existing = indexed[call.service];
    if (!existing) {
      indexed[call.service] = call;
      continue;
    }
    indexed[call.service] = mergeCallDescriptors(existing, call);
  }
  return indexed;
}

function mergeCallDescriptors(a: CallDescriptor, b: CallDescriptor): CallDescriptor {
  const merged: CallDescriptor = { service: a.service };
  const methods = unionArrays(a.methods, b.methods);
  if (methods) merged.methods = methods as NonNullable<CallDescriptor['methods']>;
  const dataTypes = unionArrays(a.dataTypes, b.dataTypes);
  if (dataTypes) merged.dataTypes = dataTypes;
  const versions = unionArrays(a.versions, b.versions);
  if (versions) merged.versions = versions;
  return merged;
}

function unionArrays<T>(a?: readonly T[], b?: readonly T[]): T[] | undefined {
  if (!a && !b) return;
  return Array.from(new Set([...(a ?? []), ...(b ?? [])]));
}

function normalizeIdentity(
  info: ServerInfoPayload | undefined,
  calls: CallDescriptor[],
): ServerIdentity {
  const brapiVersion = highestVersion(calls);
  const identity: ServerIdentity = {};
  if (info?.serverName) identity.name = info.serverName;
  if (info?.serverDescription) identity.description = info.serverDescription;
  if (info?.organizationName) identity.organizationName = info.organizationName;
  if (info?.organizationURL) identity.organizationURL = info.organizationURL;
  if (info?.documentationURL) identity.documentationURL = info.documentationURL;
  if (info?.contactEmail) identity.contactEmail = info.contactEmail;
  if (brapiVersion) identity.brapiVersion = brapiVersion;
  return identity;
}

function highestVersion(calls: CallDescriptor[]): string | undefined {
  let best: string | undefined;
  for (const call of calls) {
    for (const version of call.versions ?? []) {
      if (!best || compareSemver(version, best) > 0) best = version;
    }
  }
  return best;
}

/** Loose semver compare — treats missing segments as zero. */
function compareSemver(a: string, b: string): number {
  const parse = (s: string) => s.split('.').map((p) => Number.parseInt(p, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * BrAPI envelopes wrap list payloads as either `result: T[]` or
 * `result: { data: T[] }` depending on the endpoint and server. Handle both.
 */
function extractDataArray<T>(envelope: BrapiEnvelope<T[] | { data: T[] }>): T[] | undefined {
  const result = envelope.result;
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object' && 'data' in result && Array.isArray(result.data)) {
    return result.data;
  }
  return;
}

function sanitizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, '-');
}

let _registry: CapabilityRegistry | undefined;

export function initCapabilityRegistry(serverConfig: ServerConfig): void {
  _registry = new CapabilityRegistry(serverConfig);
}

export function getCapabilityRegistry(): CapabilityRegistry {
  if (!_registry) {
    throw new Error(
      'CapabilityRegistry not initialized — call initCapabilityRegistry() in setup()',
    );
  }
  return _registry;
}

export function resetCapabilityRegistry(): void {
  _registry = undefined;
}
