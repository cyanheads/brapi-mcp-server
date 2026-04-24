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

await createApp({
  tools: [],
  resources: [],
  prompts: [],
  setup() {
    const serverConfig = getServerConfig();
    initBrapiClient(serverConfig);
    initCapabilityRegistry(serverConfig);
    initReferenceDataCache(serverConfig);
    initDatasetStore(serverConfig);
  },
});
