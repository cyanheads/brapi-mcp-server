/**
 * @fileoverview Capability profile loader + cache for BrAPI servers. Pulls
 * `/serverinfo`, `/calls`, and `/commoncropnames` on first use (or refresh),
 * normalizes the shape, and stores the result in tenant-scoped state. Tools
 * consult this before routing requests — if a required endpoint isn't in the
 * server's capability set, the service surfaces a clear `ValidationError`
 * instead of letting the call fail downstream. Discovery degrades softly on
 * missing or broken endpoints, but four failures propagate uncached: an HTTP
 * 401/403 on `/serverinfo` or `/calls` (an auth wall needs credentials, not
 * an empty profile), a base URL the fetch guard refuses as a private or
 * reserved address (`private_address_blocked`), no call list because those
 * endpoints were slow, unreachable, or failing (a retryable
 * `ServiceUnavailable`, so an outage is never cached as a server with no
 * services), and the caller cancelling mid-discovery (`RequestCancelled`).
 *
 * @module services/capability-registry/capability-registry
 */

import { createHash } from 'node:crypto';
import type { Context } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  requestCancelled,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { defaultIsTransient } from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
import {
  type BrapiClient,
  type BrapiEnvelope,
  type BrapiRequestOptions,
  getBrapiClient,
  isPrivateAddressBlocked,
  PRIVATE_ADDRESS_BLOCKED_REASON,
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

const STATE_KEY_PREFIX = 'brapi/capability/';

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
        `BrAPI server at ${baseUrl} does not advertise '${probe.service}' in /serverinfo or /calls. Check brapi_server_info for the full capability list.`,
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
    const warnings: string[] = [];
    const failures: DiscoveryFailure[] = [];

    let serverInfo: ServerInfoPayload | undefined;
    try {
      const serverInfoEnv = await client.get<ServerInfoPayload>(
        baseUrl,
        '/serverinfo',
        ctx,
        requestOptions,
      );
      serverInfo = serverInfoEnv.result;
    } catch (err) {
      throwIfAuthRejected(err, baseUrl, '/serverinfo', options.auth !== undefined);
      throwIfPrivateAddress(err, baseUrl);
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ endpoint: '/serverinfo', message, transient: isTransientFailure(err) });
      ctx.log.warning('Failed to fetch /serverinfo; falling back to /calls-only profile', {
        baseUrl,
        error: message,
      });
      warnings.push(
        `/serverinfo was unavailable or malformed (${message}); capability discovery fell back to /calls.`,
      );
    }

    const embeddedCalls = serverInfo?.calls;
    const calls = embeddedCalls?.length
      ? embeddedCalls
      : await this.fetchCallsFallback(baseUrl, ctx, options.auth, warnings, failures);

    if (calls.length === 0 && failures.some((f) => f.transient)) {
      throw discoveryUnavailable(baseUrl, failures);
    }

    const crops = await this.fetchCrops(baseUrl, ctx, options.auth, warnings);

    // The soft-degradation paths above read a cancelled request as a missing
    // endpoint; the profile they produced must not be cached for other callers.
    if (ctx.signal.aborted) {
      throw requestCancelled(
        'Capability discovery was cancelled by the caller; nothing was cached.',
        {
          baseUrl,
        },
      );
    }

    const supported = indexCalls(calls);
    const server = normalizeIdentity(serverInfo, calls);

    const profile: CapabilityProfile = {
      baseUrl,
      server,
      supported,
      crops,
      fetchedAt: new Date().toISOString(),
    };
    if (warnings.length > 0) profile.warnings = warnings;
    return profile;
  }

  /**
   * `/calls` fallback — some servers don't embed calls in `/serverinfo` and
   * expect clients to hit the dedicated endpoint. Degrades to an empty list
   * if the server lacks this too; downstream `ensure()` will surface the
   * missing-capability error with a useful message. A failure is recorded in
   * `failures` so a transient one keeps the empty list from being cached.
   */
  private async fetchCallsFallback(
    baseUrl: string,
    ctx: Context,
    auth: CapabilityLookupOptions['auth'],
    warnings: string[],
    failures: DiscoveryFailure[],
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
      throwIfAuthRejected(err, baseUrl, '/calls', auth !== undefined);
      throwIfPrivateAddress(err, baseUrl);
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ endpoint: '/calls', message, transient: isTransientFailure(err) });
      ctx.log.warning('Failed to fetch /calls fallback', {
        baseUrl,
        error: message,
      });
      warnings.push(
        `/calls was unavailable or malformed (${message}); no capability list is known.`,
      );
      return [];
    }
  }

  private async fetchCrops(
    baseUrl: string,
    ctx: Context,
    auth: CapabilityLookupOptions['auth'],
    warnings: string[],
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
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.warning('Failed to fetch /commoncropnames', {
        baseUrl,
        error: message,
      });
      warnings.push(
        `/commoncropnames was unavailable or malformed (${message}); crop list omitted.`,
      );
      return [];
    }
  }

  /**
   * State keys admit only `[A-Za-z0-9._/-]`, so the URL is hashed rather than
   * character-mapped: a lossy mapping lets distinct servers share a profile.
   */
  private cacheKey(baseUrl: string): string {
    return `${STATE_KEY_PREFIX}${createHash('sha256').update(baseUrl).digest('hex')}`;
  }
}

/** `data.reason` when discovery could not obtain a call list for a transient reason. */
const DISCOVERY_UNAVAILABLE_REASON = 'capability_discovery_unavailable';

/** A `/serverinfo` or `/calls` request that failed during discovery. */
interface DiscoveryFailure {
  endpoint: '/serverinfo' | '/calls';
  message: string;
  /** Slow, unreachable, or 5xx — a later attempt can succeed. */
  transient: boolean;
}

/**
 * A failure a later attempt can succeed past: a timeout, a network error, a
 * 429, or a retryable 5xx — the framework's retry predicate. A response that
 * arrived but would not parse is an answer, not an outage.
 */
function isTransientFailure(err: unknown): boolean {
  if (err instanceof McpError) {
    const httpStatus = err.data?.httpStatus;
    if (typeof httpStatus === 'number' && httpStatus < 500) return false;
    if (err.code === JsonRpcErrorCode.Timeout) return true;
  }
  return defaultIsTransient(err);
}

/**
 * Discovery produced no call list because `/serverinfo` and `/calls` were
 * slow, unreachable, or failing. Thrown instead of caching an empty profile
 * that would read as a server with no services until the cache expired. The
 * recovery hint comes from the calling tool's contract, since which call to
 * retry depends on the tool.
 */
function discoveryUnavailable(baseUrl: string, failures: DiscoveryFailure[]): McpError {
  const detail = failures.map((f) => `${f.endpoint} (${f.message})`).join('; ');
  return serviceUnavailable(
    `Capability discovery for ${baseUrl} failed: ${detail}. Nothing was cached.`,
    {
      reason: DISCOVERY_UNAVAILABLE_REASON,
      retryable: true,
      baseUrl,
      failedEndpoints: failures.map((f) => f.endpoint),
    },
  );
}

const AUTH_REJECTION_REASONS = new Set(['upstream_unauthorized', 'upstream_forbidden']);

/**
 * Let an HTTP 401/403 from a capability-discovery endpoint escape the soft
 * degradation path. An auth wall is not a sparse server: folding it into an
 * empty profile would cache a "connected, zero services" result and hide the
 * fix (credentials) from the caller. The `reason` survives, so the framework
 * fills the calling tool's contract recovery hint when it declares one.
 */
function throwIfAuthRejected(
  err: unknown,
  baseUrl: string,
  endpoint: string,
  authSent: boolean,
): void {
  if (!(err instanceof McpError)) return;
  const data: Record<string, unknown> = err.data ?? {};
  const reason = data.reason;
  if (typeof reason !== 'string' || !AUTH_REJECTION_REASONS.has(reason)) return;
  const verdict =
    reason === 'upstream_unauthorized'
      ? authSent
        ? 'rejected the supplied credentials'
        : 'requires authentication'
      : authSent
        ? 'refused access with the supplied credentials'
        : 'refused anonymous access';
  throw new McpError(
    err.code,
    `BrAPI server at ${baseUrl} ${verdict} (HTTP ${String(data.status)} on ${endpoint}), so its capabilities cannot be discovered.`,
    { ...data, baseUrl, endpoint },
    { cause: err },
  );
}

/**
 * Let the fetch guard's refusal of a private or reserved address escape the
 * soft degradation path: it is a configuration refusal, and folding it into an
 * empty profile would cache a server that advertises nothing. The guard's own
 * hint is dropped, so the calling tool's contract supplies one for its caller.
 */
function throwIfPrivateAddress(err: unknown, baseUrl: string): void {
  if (!isPrivateAddressBlocked(err)) return;
  throw new McpError(
    err.code,
    `BrAPI server at ${baseUrl} is on a private or reserved address, which this server is not allowed to reach. Nothing was cached.`,
    { reason: PRIVATE_ADDRESS_BLOCKED_REASON, baseUrl },
    { cause: err },
  );
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
