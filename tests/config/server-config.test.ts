/**
 * @fileoverview Pins the env-derived defaults that the README references —
 * notably `datasetTtlSeconds` ("24h TTL caps blast radius") and the canvas
 * query budgets — so a silent default change has to update the tests
 * alongside the prose. Validates the schema directly so the assertion is
 * independent of host-environment env vars.
 *
 * @module tests/config/server-config.test
 */

import { describe, expect, it } from 'vitest';
import { ServerConfigSchema } from '@/config/server-config.js';

describe('ServerConfigSchema defaults', () => {
  it('parses an empty input by populating every default', () => {
    const config = ServerConfigSchema.parse({});
    expect(config).toBeDefined();
  });

  it('defaults datasetTtlSeconds to 86400 (24 hours)', () => {
    const config = ServerConfigSchema.parse({});
    expect(config.datasetTtlSeconds).toBe(86_400);
  });

  it('defaults loadLimit to 1000', () => {
    const config = ServerConfigSchema.parse({});
    expect(config.loadLimit).toBe(1_000);
  });

  it('defaults canvasMaxRows to 10000 and canvasQueryTimeoutMs to 30000', () => {
    const config = ServerConfigSchema.parse({});
    expect(config.canvasMaxRows).toBe(10_000);
    expect(config.canvasQueryTimeoutMs).toBe(30_000);
  });

  it('defaults genotypeCallsMaxPull to 100000 with a 500000 ceiling', () => {
    const config = ServerConfigSchema.parse({});
    expect(config.genotypeCallsMaxPull).toBe(100_000);
    expect(() => ServerConfigSchema.parse({ genotypeCallsMaxPull: 500_001 })).toThrow();
    expect(ServerConfigSchema.parse({ genotypeCallsMaxPull: 500_000 }).genotypeCallsMaxPull).toBe(
      500_000,
    );
  });

  it('defaults the gated tools off (canvasDropEnabled, enableWrites)', () => {
    const config = ServerConfigSchema.parse({});
    expect(config.canvasDropEnabled).toBe(false);
    expect(config.enableWrites).toBe(false);
  });

  it('coerces stringly-typed env values into numbers', () => {
    const config = ServerConfigSchema.parse({ datasetTtlSeconds: '3600', loadLimit: '50' });
    expect(config.datasetTtlSeconds).toBe(3_600);
    expect(config.loadLimit).toBe(50);
  });
});
