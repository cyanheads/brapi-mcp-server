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
import { brapiConnect } from './mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiDescribeFilters } from './mcp-server/tools/definitions/brapi-describe-filters.tool.js';
import { brapiFindGenotypeCalls } from './mcp-server/tools/definitions/brapi-find-genotype-calls.tool.js';
import { brapiFindGermplasm } from './mcp-server/tools/definitions/brapi-find-germplasm.tool.js';
import { brapiFindImages } from './mcp-server/tools/definitions/brapi-find-images.tool.js';
import { brapiFindLocations } from './mcp-server/tools/definitions/brapi-find-locations.tool.js';
import { brapiFindObservations } from './mcp-server/tools/definitions/brapi-find-observations.tool.js';
import { brapiFindStudies } from './mcp-server/tools/definitions/brapi-find-studies.tool.js';
import { brapiFindVariables } from './mcp-server/tools/definitions/brapi-find-variables.tool.js';
import { brapiFindVariants } from './mcp-server/tools/definitions/brapi-find-variants.tool.js';
import { brapiGetGermplasm } from './mcp-server/tools/definitions/brapi-get-germplasm.tool.js';
import { brapiGetImage } from './mcp-server/tools/definitions/brapi-get-image.tool.js';
import { brapiGetStudy } from './mcp-server/tools/definitions/brapi-get-study.tool.js';
import { brapiManageDataset } from './mcp-server/tools/definitions/brapi-manage-dataset.tool.js';
import { brapiRawGet } from './mcp-server/tools/definitions/brapi-raw-get.tool.js';
import { brapiRawSearch } from './mcp-server/tools/definitions/brapi-raw-search.tool.js';
import { brapiServerInfo } from './mcp-server/tools/definitions/brapi-server-info.tool.js';
import { brapiSubmitObservations } from './mcp-server/tools/definitions/brapi-submit-observations.tool.js';
import { brapiWalkPedigree } from './mcp-server/tools/definitions/brapi-walk-pedigree.tool.js';

await createApp({
  tools: [
    brapiConnect,
    brapiServerInfo,
    brapiDescribeFilters,
    brapiFindStudies,
    brapiGetStudy,
    brapiFindGermplasm,
    brapiGetGermplasm,
    brapiWalkPedigree,
    brapiFindVariables,
    brapiFindObservations,
    brapiFindImages,
    brapiGetImage,
    brapiFindLocations,
    brapiFindVariants,
    brapiFindGenotypeCalls,
    brapiManageDataset,
    brapiSubmitObservations,
    brapiRawGet,
    brapiRawSearch,
  ],
  resources: [
    brapiServerInfoResource,
    brapiCallsResource,
    brapiStudyResource,
    brapiGermplasmResource,
    brapiDatasetResource,
    brapiFiltersResource,
  ],
  prompts: [brapiEdaStudy, brapiMetaAnalysis],
  setup() {
    const serverConfig = getServerConfig();
    initBrapiClient(serverConfig);
    initCapabilityRegistry(serverConfig);
    initReferenceDataCache(serverConfig);
    initDatasetStore(serverConfig);
    initServerRegistry(serverConfig);
    initOntologyResolver();
  },
});
