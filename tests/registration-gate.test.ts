/**
 * @fileoverview Registration-gate tests — verifies that the write tool
 * (`brapi_submit_observations`) is split out of the read-only definitions
 * barrel and that the `BRAPI_ENABLE_WRITES` env var feeds `enableWrites` so
 * the entry-point conditional spread keeps the tool out of `tools/list` by
 * default.
 *
 * @module tests/registration-gate.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig, resetServerConfig } from '@/config/server-config.js';
import { brapiSubmitObservations } from '@/mcp-server/tools/definitions/brapi-submit-observations.tool.js';
import {
  readOnlyToolDefinitions,
  writeToolDefinitions,
} from '@/mcp-server/tools/definitions/index.js';

describe('tool definition barrels', () => {
  it('readOnlyToolDefinitions excludes brapi_submit_observations', () => {
    const names = readOnlyToolDefinitions.map((t) => t.name);
    expect(names).not.toContain('brapi_submit_observations');
  });

  it('writeToolDefinitions contains exactly brapi_submit_observations', () => {
    expect(writeToolDefinitions).toEqual([brapiSubmitObservations]);
  });

  it('readOnlyToolDefinitions has unique tool names', () => {
    const names = readOnlyToolDefinitions.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('enableWrites config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetServerConfig();
  });

  it('defaults to false when BRAPI_ENABLE_WRITES is unset', () => {
    vi.stubEnv('BRAPI_ENABLE_WRITES', undefined as unknown as string);
    expect(getServerConfig().enableWrites).toBe(false);
  });

  it('parses BRAPI_ENABLE_WRITES=true as true', () => {
    vi.stubEnv('BRAPI_ENABLE_WRITES', 'true');
    expect(getServerConfig().enableWrites).toBe(true);
  });

  it('parses BRAPI_ENABLE_WRITES=false as false', () => {
    vi.stubEnv('BRAPI_ENABLE_WRITES', 'false');
    expect(getServerConfig().enableWrites).toBe(false);
  });
});

describe('entry-point composition', () => {
  function composeRegisteredTools(enableWrites: boolean) {
    return enableWrites
      ? [...readOnlyToolDefinitions, ...writeToolDefinitions]
      : readOnlyToolDefinitions;
  }

  it('omits brapi_submit_observations when enableWrites is false', () => {
    const names = composeRegisteredTools(false).map((t) => t.name);
    expect(names).not.toContain('brapi_submit_observations');
  });

  it('includes brapi_submit_observations when enableWrites is true', () => {
    const names = composeRegisteredTools(true).map((t) => t.name);
    expect(names).toContain('brapi_submit_observations');
  });
});
