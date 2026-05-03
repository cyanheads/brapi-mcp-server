/**
 * @fileoverview Registration-gate tests — verifies that the write tool
 * (`brapi_submit_observations`) is split out of the read-only definitions
 * barrel and that the `BRAPI_ENABLE_WRITES` env var feeds `enableWrites` so
 * the entry-point composition wraps the tool in `disabledTool()` (keeping it
 * visible in the operator manifest but hidden from `tools/list`) when the
 * flag is off.
 *
 * @module tests/registration-gate.test
 */

import { disabledTool } from '@cyanheads/mcp-ts-core/tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig, resetServerConfig } from '@/config/server-config.js';
import { brapiSubmitObservations } from '@/mcp-server/tools/definitions/brapi-submit-observations.tool.js';
import {
  readOnlyToolDefinitions,
  writeToolDefinitions,
} from '@/mcp-server/tools/definitions/index.js';

const DISABLED_KEY = '__mcpDisabled';

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
  const writesDisabled = {
    reason: 'Writes are disabled (BRAPI_ENABLE_WRITES=false).',
    hint: 'Set BRAPI_ENABLE_WRITES=true to enable observation submission.',
  };

  function composeRegisteredTools(enableWrites: boolean) {
    return [
      ...readOnlyToolDefinitions,
      ...writeToolDefinitions.map((d) => (enableWrites ? d : disabledTool(d, writesDisabled))),
    ];
  }

  it('marks brapi_submit_observations as disabled when enableWrites is false', () => {
    const tools = composeRegisteredTools(false);
    const submit = tools.find((t) => t.name === 'brapi_submit_observations');
    expect(submit).toBeDefined();
    expect((submit as Record<string, unknown>)[DISABLED_KEY]).toEqual(writesDisabled);
  });

  it('leaves brapi_submit_observations unwrapped when enableWrites is true', () => {
    const tools = composeRegisteredTools(true);
    const submit = tools.find((t) => t.name === 'brapi_submit_observations');
    expect(submit).toBeDefined();
    expect((submit as Record<string, unknown>)[DISABLED_KEY]).toBeUndefined();
  });
});
