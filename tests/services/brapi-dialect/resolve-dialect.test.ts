/**
 * @fileoverview Tests for `resolveDialect` — the async helper that consults
 * the env override first, then the cached `CapabilityProfile`. Pre-seeds
 * `ctx.state` with the profile to avoid touching the fetcher; covers env
 * override beating profile inference, profile-driven detection, and the
 * spec fallback when no profile is cached.
 *
 * @module tests/services/brapi-dialect/resolve-dialect.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { initBrapiClient, resetBrapiClient } from '@/services/brapi-client/index.js';
import {
  initBrapiDialectRegistry,
  resetBrapiDialectRegistry,
  resolveDialect,
} from '@/services/brapi-dialect/index.js';
import {
  initCapabilityRegistry,
  resetCapabilityRegistry,
} from '@/services/capability-registry/index.js';
import type { CapabilityProfile } from '@/services/capability-registry/types.js';
import type { RegisteredServer } from '@/services/server-registry/index.js';

const BASE_URL = 'https://brapi.example.org/brapi/v2';
const CACHE_KEY = `brapi/capability/${BASE_URL.replace(/[^a-zA-Z0-9]/g, '-')}`;

const TEST_CONFIG: ServerConfig = {
  defaultApiKeyHeader: 'Authorization',
  datasetTtlSeconds: 86_400,
  loadLimit: 10,
  maxConcurrentRequests: 4,
  retryMaxAttempts: 0,
  retryBaseDelayMs: 1,
  referenceCacheTtlSeconds: 3_600,
  requestTimeoutMs: 1_000,
  searchPollTimeoutMs: 5_000,
  searchPollIntervalMs: 1,
  allowPrivateIps: false,
  enableWrites: false,
};

function profile(name: string | undefined, organizationName?: string): CapabilityProfile {
  return {
    baseUrl: BASE_URL,
    server: { ...(name ? { name } : {}), ...(organizationName ? { organizationName } : {}) },
    supported: {},
    crops: [],
    fetchedAt: '2026-04-30T00:00:00Z',
  };
}

function connection(alias: string): RegisteredServer {
  return {
    alias,
    authMode: 'none',
    baseUrl: BASE_URL,
    registeredAt: '2026-04-30T00:00:00Z',
  };
}

describe('resolveDialect', () => {
  beforeEach(() => {
    initBrapiClient(TEST_CONFIG, vi.fn() as never);
    initCapabilityRegistry(TEST_CONFIG);
    initBrapiDialectRegistry();
  });

  afterEach(() => {
    resetBrapiClient();
    resetCapabilityRegistry();
    resetBrapiDialectRegistry();
    vi.unstubAllEnvs();
  });

  it('returns the cassavabase dialect when the cached profile names CassavaBase', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    await ctx.state.set(CACHE_KEY, profile('CassavaBase'));
    const dialect = await resolveDialect(connection('default'), ctx);
    expect(dialect.id).toBe('cassavabase');
  });

  it('returns the spec dialect for an unknown server name', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    await ctx.state.set(CACHE_KEY, profile('GnpIS'));
    const dialect = await resolveDialect(connection('default'), ctx);
    expect(dialect.id).toBe('spec');
  });

  it('env override beats profile inference', async () => {
    vi.stubEnv('BRAPI_DEFAULT_DIALECT', 'spec');
    const ctx = createMockContext({ tenantId: 't1' });
    await ctx.state.set(CACHE_KEY, profile('CassavaBase'));
    const dialect = await resolveDialect(connection('default'), ctx);
    expect(dialect.id).toBe('spec');
  });

  it('falls back to spec when override names a registered-but-unknown id', async () => {
    vi.stubEnv('BRAPI_DEFAULT_DIALECT', 'not-a-real-dialect');
    const ctx = createMockContext({ tenantId: 't1' });
    await ctx.state.set(CACHE_KEY, profile('CassavaBase'));
    const dialect = await resolveDialect(connection('default'), ctx);
    expect(dialect.id).toBe('spec');
  });

  it('detects via organizationName when serverName is generic', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    await ctx.state.set(CACHE_KEY, profile('BrAPI Server', 'Boyce Thompson Institute'));
    const dialect = await resolveDialect(connection('default'), ctx);
    expect(dialect.id).toBe('cassavabase');
  });

  it('uses the per-alias env var (BRAPI_<ALIAS>_DIALECT)', async () => {
    vi.stubEnv('BRAPI_CASSAVA_DIALECT', 'spec');
    const ctx = createMockContext({ tenantId: 't1' });
    await ctx.state.set(CACHE_KEY, profile('CassavaBase'));
    const dialect = await resolveDialect(connection('cassava'), ctx);
    expect(dialect.id).toBe('spec');
    // The default alias env var should not leak into the `cassava` lookup.
    vi.stubEnv('BRAPI_DEFAULT_DIALECT', 'cassavabase');
    const fallback = await resolveDialect(connection('cassava'), ctx);
    expect(fallback.id).toBe('spec');
  });
});
