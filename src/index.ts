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
import { initCapabilityRegistry } from '@/services/capability-registry/index.js';
import { initDatasetStore } from '@/services/dataset-store/index.js';
import { initReferenceDataCache } from '@/services/reference-data-cache/index.js';
import { initServerRegistry } from '@/services/server-registry/index.js';
import { brapiConnect } from './mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiDescribeFilters } from './mcp-server/tools/definitions/brapi-describe-filters.tool.js';
import { brapiFindGermplasm } from './mcp-server/tools/definitions/brapi-find-germplasm.tool.js';
import { brapiFindStudies } from './mcp-server/tools/definitions/brapi-find-studies.tool.js';
import { brapiGetGermplasm } from './mcp-server/tools/definitions/brapi-get-germplasm.tool.js';
import { brapiGetStudy } from './mcp-server/tools/definitions/brapi-get-study.tool.js';
import { brapiServerInfo } from './mcp-server/tools/definitions/brapi-server-info.tool.js';

await createApp({
  tools: [
    brapiConnect,
    brapiServerInfo,
    brapiDescribeFilters,
    brapiFindStudies,
    brapiGetStudy,
    brapiFindGermplasm,
    brapiGetGermplasm,
  ],
  resources: [],
  prompts: [],
  setup() {
    const serverConfig = getServerConfig();
    initBrapiClient(serverConfig);
    initCapabilityRegistry(serverConfig);
    initReferenceDataCache(serverConfig);
    initDatasetStore(serverConfig);
    initServerRegistry(serverConfig);
  },
});
