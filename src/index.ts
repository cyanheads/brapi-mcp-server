#!/usr/bin/env node
/**
 * @fileoverview brapi-mcp-server MCP server entry point. Registers the MCP
 * surface (tools/resources/prompts) and initializes domain services in
 * `setup()` before the transport starts.
 *
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';
import { initBrapiClient } from '@/services/brapi-client/index.js';
import { initBrapiDialectRegistry } from '@/services/brapi-dialect/index.js';
import { initCanvasBridge } from '@/services/canvas-bridge/index.js';
import { initCapabilityRegistry } from '@/services/capability-registry/index.js';
import { initDatasetStore } from '@/services/dataset-store/index.js';
import { initOntologyResolver } from '@/services/ontology-resolver/index.js';
import { initReferenceDataCache } from '@/services/reference-data-cache/index.js';
import { initServerRegistry } from '@/services/server-registry/index.js';
import { brapiEdaStudy } from './mcp-server/prompts/definitions/brapi-eda-study.prompt.js';
import { brapiMetaAnalysis } from './mcp-server/prompts/definitions/brapi-meta-analysis.prompt.js';
import { brapiCallsResource } from './mcp-server/resources/definitions/brapi-calls.resource.js';
import { brapiDatasetResource } from './mcp-server/resources/definitions/brapi-dataset.resource.js';
import { brapiFiltersResource } from './mcp-server/resources/definitions/brapi-filters.resource.js';
import { brapiGermplasmResource } from './mcp-server/resources/definitions/brapi-germplasm.resource.js';
import { brapiServerInfoResource } from './mcp-server/resources/definitions/brapi-server-info.resource.js';
import { brapiStudyResource } from './mcp-server/resources/definitions/brapi-study.resource.js';
import {
  dataframeToolDefinitions,
  readOnlyToolDefinitions,
  writeToolDefinitions,
} from './mcp-server/tools/definitions/index.js';

const serverConfig = getServerConfig();

const tools = [
  ...readOnlyToolDefinitions,
  // Dataframe surface gated by BRAPI_CANVAS_ENABLED. The framework canvas
  // itself is gated by CANVAS_PROVIDER_TYPE — when that's not `duckdb`, the
  // bridge returns `isEnabled() === false` and the tools fail with a typed
  // `dataframe_disabled` error directing the operator to set both env vars.
  ...(serverConfig.canvasEnabled ? dataframeToolDefinitions : []),
  ...(serverConfig.enableWrites ? writeToolDefinitions : []),
];

await createApp({
  tools,
  resources: [
    brapiServerInfoResource,
    brapiCallsResource,
    brapiStudyResource,
    brapiGermplasmResource,
    brapiDatasetResource,
    brapiFiltersResource,
  ],
  prompts: [brapiEdaStudy, brapiMetaAnalysis],
  setup(core) {
    const canvasBridge = initCanvasBridge(core.canvas, serverConfig);
    initBrapiClient(serverConfig);
    initCapabilityRegistry(serverConfig);
    initBrapiDialectRegistry();
    initReferenceDataCache(serverConfig);
    initDatasetStore(serverConfig, canvasBridge);
    initServerRegistry(serverConfig);
    initOntologyResolver();
  },
});
