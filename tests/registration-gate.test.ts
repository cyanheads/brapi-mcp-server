/**
 * @fileoverview Registration-gate tests — verifies that the write tool
 * (`brapi_submit_observations`) and the drop tool (`brapi_dataframe_drop`)
 * are split out of the read-only definitions barrel and that their env-var
 * gates feed the entry-point composition (which wraps gated tools in
 * `disabledTool()` so they stay visible in the operator manifest but hidden
 * from `tools/list`).
 *
 * @module tests/registration-gate.test
 */

import { disabledTool } from '@cyanheads/mcp-ts-core/tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig, resetServerConfig } from '@/config/server-config.js';
import { brapiDataframeDrop } from '@/mcp-server/tools/definitions/brapi-dataframe-drop.tool.js';
import { brapiDataframeExport } from '@/mcp-server/tools/definitions/brapi-dataframe-export.tool.js';
import { brapiSubmitObservations } from '@/mcp-server/tools/definitions/brapi-submit-observations.tool.js';
import {
  dropToolDefinitions,
  exportToolDefinitions,
  readOnlyToolDefinitions,
  writeToolDefinitions,
} from '@/mcp-server/tools/definitions/index.js';

const DISABLED_KEY = '__mcpDisabled';

describe('tool definition barrels', () => {
  it('readOnlyToolDefinitions excludes gated tools', () => {
    const names = readOnlyToolDefinitions.map((t) => t.name);
    expect(names).not.toContain('brapi_submit_observations');
    expect(names).not.toContain('brapi_dataframe_drop');
    expect(names).not.toContain('brapi_dataframe_export');
  });

  it('writeToolDefinitions contains exactly brapi_submit_observations', () => {
    expect(writeToolDefinitions).toEqual([brapiSubmitObservations]);
  });

  it('dropToolDefinitions contains exactly brapi_dataframe_drop', () => {
    expect(dropToolDefinitions).toEqual([brapiDataframeDrop]);
  });

  it('exportToolDefinitions contains exactly brapi_dataframe_export', () => {
    expect(exportToolDefinitions).toEqual([brapiDataframeExport]);
  });

  it('readOnlyToolDefinitions includes the dataframe discovery + query tools', () => {
    const names = readOnlyToolDefinitions.map((t) => t.name);
    expect(names).toContain('brapi_dataframe_describe');
    expect(names).toContain('brapi_dataframe_query');
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

describe('canvasDropEnabled config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetServerConfig();
  });

  it('defaults to false when BRAPI_CANVAS_DROP_ENABLED is unset', () => {
    vi.stubEnv('BRAPI_CANVAS_DROP_ENABLED', undefined as unknown as string);
    expect(getServerConfig().canvasDropEnabled).toBe(false);
  });

  it('parses BRAPI_CANVAS_DROP_ENABLED=true as true', () => {
    vi.stubEnv('BRAPI_CANVAS_DROP_ENABLED', 'true');
    expect(getServerConfig().canvasDropEnabled).toBe(true);
  });
});

describe('exportDir config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetServerConfig();
  });

  it('is undefined when BRAPI_EXPORT_DIR is unset', () => {
    vi.stubEnv('BRAPI_EXPORT_DIR', undefined as unknown as string);
    expect(getServerConfig().exportDir).toBeUndefined();
  });

  it('reflects BRAPI_EXPORT_DIR when set', () => {
    vi.stubEnv('BRAPI_EXPORT_DIR', '/srv/exports');
    expect(getServerConfig().exportDir).toBe('/srv/exports');
  });
});

describe('entry-point composition', () => {
  const writesDisabled = {
    reason: 'Writes are disabled (BRAPI_ENABLE_WRITES=false).',
    hint: 'Set BRAPI_ENABLE_WRITES=true to enable observation submission.',
  };
  const dropDisabled = {
    reason: 'Dataframe drop is gated off (BRAPI_CANVAS_DROP_ENABLED=false).',
    hint: 'Set BRAPI_CANVAS_DROP_ENABLED=true to enable explicit drop. Dataframes also expire via TTL when left unmanaged.',
  };
  const exportTransportDisabled = {
    reason: 'Dataframe export requires stdio transport.',
    hint: 'File paths must resolve on the same machine as the user — run the server with MCP_TRANSPORT_TYPE=stdio to enable.',
  };
  const exportDirDisabled = {
    reason: 'Dataframe export is unconfigured (BRAPI_EXPORT_DIR unset).',
    hint: 'Set BRAPI_EXPORT_DIR to a writable directory on the server host to enable file export.',
  };

  function resolveExportDisabledFor(opts: {
    transportMode: 'stdio' | 'http';
    exportDirSet: boolean;
  }) {
    if (opts.transportMode !== 'stdio') return exportTransportDisabled;
    if (!opts.exportDirSet) return exportDirDisabled;
    return null;
  }

  function composeRegisteredTools(opts: {
    enableWrites: boolean;
    canvasDropEnabled: boolean;
    transportMode: 'stdio' | 'http';
    exportDirSet: boolean;
  }) {
    const exportDisabled = resolveExportDisabledFor(opts);
    return [
      ...readOnlyToolDefinitions,
      ...dropToolDefinitions.map((d) =>
        opts.canvasDropEnabled ? d : disabledTool(d, dropDisabled),
      ),
      ...exportToolDefinitions.map((d) => (exportDisabled ? disabledTool(d, exportDisabled) : d)),
      ...writeToolDefinitions.map((d) => (opts.enableWrites ? d : disabledTool(d, writesDisabled))),
    ];
  }

  const baseOpts = {
    enableWrites: false,
    canvasDropEnabled: false,
    transportMode: 'stdio' as const,
    exportDirSet: true,
  };

  it('marks brapi_submit_observations as disabled when enableWrites is false', () => {
    const tools = composeRegisteredTools({ ...baseOpts, canvasDropEnabled: true });
    const submit = tools.find((t) => t.name === 'brapi_submit_observations');
    expect(submit).toBeDefined();
    expect((submit as Record<string, unknown>)[DISABLED_KEY]).toEqual(writesDisabled);
  });

  it('leaves brapi_submit_observations unwrapped when enableWrites is true', () => {
    const tools = composeRegisteredTools({
      ...baseOpts,
      enableWrites: true,
      canvasDropEnabled: true,
    });
    const submit = tools.find((t) => t.name === 'brapi_submit_observations');
    expect(submit).toBeDefined();
    expect((submit as Record<string, unknown>)[DISABLED_KEY]).toBeUndefined();
  });

  it('marks brapi_dataframe_drop as disabled when canvasDropEnabled is false', () => {
    const tools = composeRegisteredTools(baseOpts);
    const drop = tools.find((t) => t.name === 'brapi_dataframe_drop');
    expect(drop).toBeDefined();
    expect((drop as Record<string, unknown>)[DISABLED_KEY]).toEqual(dropDisabled);
  });

  it('leaves brapi_dataframe_drop unwrapped when canvasDropEnabled is true', () => {
    const tools = composeRegisteredTools({ ...baseOpts, canvasDropEnabled: true });
    const drop = tools.find((t) => t.name === 'brapi_dataframe_drop');
    expect(drop).toBeDefined();
    expect((drop as Record<string, unknown>)[DISABLED_KEY]).toBeUndefined();
  });

  it('leaves brapi_dataframe_export unwrapped under stdio + export-dir-set', () => {
    const tools = composeRegisteredTools(baseOpts);
    const exp = tools.find((t) => t.name === 'brapi_dataframe_export');
    expect(exp).toBeDefined();
    expect((exp as Record<string, unknown>)[DISABLED_KEY]).toBeUndefined();
  });

  it('marks brapi_dataframe_export as transport-disabled under HTTP', () => {
    const tools = composeRegisteredTools({ ...baseOpts, transportMode: 'http' });
    const exp = tools.find((t) => t.name === 'brapi_dataframe_export');
    expect((exp as Record<string, unknown>)[DISABLED_KEY]).toEqual(exportTransportDisabled);
  });

  it('marks brapi_dataframe_export as dir-disabled when exportDir is unset under stdio', () => {
    const tools = composeRegisteredTools({ ...baseOpts, exportDirSet: false });
    const exp = tools.find((t) => t.name === 'brapi_dataframe_export');
    expect((exp as Record<string, unknown>)[DISABLED_KEY]).toEqual(exportDirDisabled);
  });

  it('transport gate wins over the dir gate when both are off', () => {
    const tools = composeRegisteredTools({
      ...baseOpts,
      transportMode: 'http',
      exportDirSet: false,
    });
    const exp = tools.find((t) => t.name === 'brapi_dataframe_export');
    expect((exp as Record<string, unknown>)[DISABLED_KEY]).toEqual(exportTransportDisabled);
  });
});
