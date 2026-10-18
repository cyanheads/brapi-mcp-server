/**
 * @fileoverview Pins the env-derived defaults that the README references —
 * notably `datasetTtlSeconds` ("24h TTL caps blast radius") and the canvas
 * query budgets — so a silent default change has to update the tests
 * alongside the prose. Validates the schema directly so the assertion is
 * independent of host-environment env vars.
 *
 * @module tests/config/server-config.test
 */

import { config as frameworkConfig, resetConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertCanvasMaxRowsWithinCanvasLimit,
  getServerConfig,
  resetServerConfig,
  ServerConfigSchema,
} from '@/config/server-config.js';

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

  it('defaults pageSize to 1000 and accepts an override', () => {
    const config = ServerConfigSchema.parse({});
    expect(config.pageSize).toBe(1_000);
    expect(ServerConfigSchema.parse({ pageSize: '500' }).pageSize).toBe(500);
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

  it('defaults genotypeMatrixMaxColumns to 10000 with a 500000 ceiling', () => {
    const config = ServerConfigSchema.parse({});
    expect(config.genotypeMatrixMaxColumns).toBe(10_000);
    expect(() => ServerConfigSchema.parse({ genotypeMatrixMaxColumns: 500_001 })).toThrow();
    expect(
      ServerConfigSchema.parse({ genotypeMatrixMaxColumns: 500_000 }).genotypeMatrixMaxColumns,
    ).toBe(500_000);
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

describe('server environment configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetServerConfig();
  });

  it.each(['', `\${user_config.BRAPI_DEFAULT_BASE_URL}`])('treats %j as unset', (value) => {
    vi.stubEnv('BRAPI_DEFAULT_BASE_URL', value);
    vi.stubEnv('BRAPI_LOAD_LIMIT', value);
    vi.stubEnv('BRAPI_ENABLE_WRITES', value);
    expect(getServerConfig()).toMatchObject({
      defaultBaseUrl: undefined,
      loadLimit: 1_000,
      enableWrites: false,
    });
  });

  it('rejects a malformed URL that starts with a placeholder', () => {
    vi.stubEnv('BRAPI_DEFAULT_BASE_URL', `\${user_config.BRAPI_DEFAULT_BASE_URL}/brapi/v2`);
    expect(() => getServerConfig()).toThrow(/BRAPI_DEFAULT_BASE_URL/);
  });

  it('preserves a valid URL containing a literal placeholder segment', () => {
    const url = `https://example.org/\${instance}/brapi/v2`;
    vi.stubEnv('BRAPI_DEFAULT_BASE_URL', url);
    expect(getServerConfig().defaultBaseUrl).toBe(url);
  });
});

describe('BRAPI_CANVAS_MAX_ROWS against the framework canvas row limit', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetServerConfig();
    resetConfig();
  });

  it('accepts the defaults, which sit exactly at the framework limit', () => {
    const limit = frameworkConfig.canvas.defaultRowLimit;
    expect(limit).toBe(10_000);
    expect(() => assertCanvasMaxRowsWithinCanvasLimit(getServerConfig(), limit)).not.toThrow();
  });

  it('accepts a cap below the limit', () => {
    vi.stubEnv('BRAPI_CANVAS_MAX_ROWS', '500');
    expect(() =>
      assertCanvasMaxRowsWithinCanvasLimit(
        getServerConfig(),
        frameworkConfig.canvas.defaultRowLimit,
      ),
    ).not.toThrow();
  });

  it('fails as a ConfigurationError naming both variables when the cap exceeds the limit', () => {
    vi.stubEnv('BRAPI_CANVAS_MAX_ROWS', '20000');
    expect(() =>
      assertCanvasMaxRowsWithinCanvasLimit(
        getServerConfig(),
        frameworkConfig.canvas.defaultRowLimit,
      ),
    ).toThrow(
      expect.objectContaining({
        code: JsonRpcErrorCode.ConfigurationError,
        message: expect.stringMatching(
          /BRAPI_CANVAS_MAX_ROWS \(20000\) exceeds .*CANVAS_DEFAULT_ROW_LIMIT \(10000\)/,
        ),
      }),
    );
  });

  it('follows a lowered framework limit rather than a fixed 10,000', () => {
    vi.stubEnv('CANVAS_DEFAULT_ROW_LIMIT', '2000');
    resetConfig();
    expect(frameworkConfig.canvas.defaultRowLimit).toBe(2000);
    expect(() =>
      assertCanvasMaxRowsWithinCanvasLimit(
        getServerConfig(),
        frameworkConfig.canvas.defaultRowLimit,
      ),
    ).toThrow(/CANVAS_DEFAULT_ROW_LIMIT \(2000\)/);
  });
});
