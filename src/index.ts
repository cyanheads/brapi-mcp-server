#!/usr/bin/env node
/**
 * @fileoverview brapi-mcp-server MCP server entry point. Registers the MCP
 * surface (tools/resources/prompts) and initializes domain services in
 * `setup()` before the transport starts.
 *
 * @module index
 */

// Default the framework canvas provider to DuckDB. The framework defaults
// `CANVAS_PROVIDER_TYPE` to `'none'`; this server requires a live canvas
// for spillover, so we override the default before `createApp` reads
// config. Operator-set values (including `'none'` for diagnostic runs)
// pass through untouched.
//
// ESM hoists the import below ahead of this statement, but the framework's
// `config` is a lazy Proxy — importing it only declares the Proxy, the
// underlying `parseConfig()` runs on first property access (which happens
// inside `createApp`). So this line lands in the window between
// import-time evaluation and `createApp`'s config read.
process.env.CANVAS_PROVIDER_TYPE ??= 'duckdb';

// Bridge `BRAPI_EXPORT_DIR` → `CANVAS_EXPORT_PATH` so the framework's canvas
// path-traversal sandbox uses the operator-set export root. `??=` so an
// explicit `CANVAS_EXPORT_PATH` wins (operators who configure the framework
// directly retain control). When `BRAPI_EXPORT_DIR` is unset, neither is
// set — the export tool's registration gate fails closed and the canvas
// runs without an export root (any export call would hit the framework's
// sandbox check).
if (process.env.BRAPI_EXPORT_DIR) {
  process.env.CANVAS_EXPORT_PATH ??= process.env.BRAPI_EXPORT_DIR;
}

import { createApp } from '@cyanheads/mcp-ts-core';
import { configurationError } from '@cyanheads/mcp-ts-core/errors';
import { disabledTool } from '@cyanheads/mcp-ts-core/tools';
import { getServerConfig } from '@/config/server-config.js';
import { initBrapiClient } from '@/services/brapi-client/index.js';
import { initBrapiDialectRegistry } from '@/services/brapi-dialect/index.js';
import { initCanvasBridge } from '@/services/canvas-bridge/index.js';
import { initCapabilityRegistry } from '@/services/capability-registry/index.js';
import { initOntologyResolver } from '@/services/ontology-resolver/index.js';
import { initReferenceDataCache } from '@/services/reference-data-cache/index.js';
import { initServerRegistry } from '@/services/server-registry/index.js';
import { brapiEdaStudy } from './mcp-server/prompts/definitions/brapi-eda-study.prompt.js';
import { brapiMetaAnalysis } from './mcp-server/prompts/definitions/brapi-meta-analysis.prompt.js';
import { brapiCallsResource } from './mcp-server/resources/definitions/brapi-calls.resource.js';
import { brapiFiltersResource } from './mcp-server/resources/definitions/brapi-filters.resource.js';
import { brapiGermplasmResource } from './mcp-server/resources/definitions/brapi-germplasm.resource.js';
import { brapiServerInfoResource } from './mcp-server/resources/definitions/brapi-server-info.resource.js';
import { brapiStudyResource } from './mcp-server/resources/definitions/brapi-study.resource.js';
import {
  dropToolDefinitions,
  exportToolDefinitions,
  readOnlyToolDefinitions,
  writeToolDefinitions,
} from './mcp-server/tools/definitions/index.js';

const serverConfig = getServerConfig();

/**
 * Operator-facing metadata for the dataframe-drop gate. Surfaces in
 * /.well-known/mcp.json and the HTML landing page so operators see the
 * gated tool with reason + hint.
 */
const dropDisabled = {
  reason: 'Dataframe drop is gated off (BRAPI_CANVAS_DROP_ENABLED=false).',
  hint: 'Set BRAPI_CANVAS_DROP_ENABLED=true to enable explicit drop. Dataframes also expire via TTL when left unmanaged.',
};

const writesDisabled = {
  reason: 'Writes are disabled (BRAPI_ENABLE_WRITES=false).',
  hint: 'Set BRAPI_ENABLE_WRITES=true to enable observation submission.',
};

/**
 * Resolve the dataframe-export gate. Two reasons it can be off:
 * (1) running under HTTP transport — file paths only make sense when the
 *     server lives on the user's machine,
 * (2) `BRAPI_EXPORT_DIR` unset — setting it is the opt-in (no separate
 *     enable flag).
 * Returns `null` when the tool should register, otherwise the operator
 * metadata to wrap the disabled tool with.
 */
function resolveExportGate(): { reason: string; hint: string } | null {
  const transportMode = process.env.MCP_TRANSPORT_TYPE ?? 'stdio';
  if (transportMode !== 'stdio') {
    return {
      reason: 'Dataframe export requires stdio transport.',
      hint: 'File paths must resolve on the same machine as the user — run the server with MCP_TRANSPORT_TYPE=stdio to enable.',
    };
  }
  if (!serverConfig.exportDir) {
    return {
      reason: 'Dataframe export is unconfigured (BRAPI_EXPORT_DIR unset).',
      hint: 'Set BRAPI_EXPORT_DIR to a writable directory on the server host to enable file export.',
    };
  }
  return null;
}

const exportDisabled = resolveExportGate();

const tools = [
  ...readOnlyToolDefinitions,
  ...dropToolDefinitions.map((d) =>
    serverConfig.canvasDropEnabled ? d : disabledTool(d, dropDisabled),
  ),
  ...exportToolDefinitions.map((d) => (exportDisabled ? disabledTool(d, exportDisabled) : d)),
  ...writeToolDefinitions.map((d) =>
    serverConfig.enableWrites ? d : disabledTool(d, writesDisabled),
  ),
];

await createApp({
  tools,
  resources: [
    brapiServerInfoResource,
    brapiCallsResource,
    brapiStudyResource,
    brapiGermplasmResource,
    brapiFiltersResource,
  ],
  prompts: [brapiEdaStudy, brapiMetaAnalysis],
  setup(core) {
    if (!core.canvas) {
      throw configurationError(
        'brapi-mcp-server requires the framework canvas service (DuckDB) for dataframe spillover. Set CANVAS_PROVIDER_TYPE=duckdb (the default) and ensure @duckdb/node-api is installed.',
        { canvasProviderType: process.env.CANVAS_PROVIDER_TYPE ?? 'duckdb' },
      );
    }
    initCanvasBridge(core.canvas, serverConfig);
    initBrapiClient(serverConfig);
    initCapabilityRegistry(serverConfig);
    initBrapiDialectRegistry();
    initReferenceDataCache(serverConfig);
    initServerRegistry(serverConfig);
    initOntologyResolver();
  },
});
