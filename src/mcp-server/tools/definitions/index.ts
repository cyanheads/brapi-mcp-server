/**
 * @fileoverview Tool registration barrel. The write tool
 * (`brapi_submit_observations`) is exported separately so callers can decide
 * whether to register it based on the `BRAPI_ENABLE_WRITES` flag — keeping
 * this module free of eager config reads.
 * @module mcp-server/tools/definitions/index
 */

import { brapiConnect } from './brapi-connect.tool.js';
import { brapiDataframeDescribe } from './brapi-dataframe-describe.tool.js';
import { brapiDataframeDrop } from './brapi-dataframe-drop.tool.js';
import { brapiDataframeQuery } from './brapi-dataframe-query.tool.js';
import { brapiDescribeFilters } from './brapi-describe-filters.tool.js';
import { brapiFindGenotypeCalls } from './brapi-find-genotype-calls.tool.js';
import { brapiFindGermplasm } from './brapi-find-germplasm.tool.js';
import { brapiFindImages } from './brapi-find-images.tool.js';
import { brapiFindLocations } from './brapi-find-locations.tool.js';
import { brapiFindObservations } from './brapi-find-observations.tool.js';
import { brapiFindStudies } from './brapi-find-studies.tool.js';
import { brapiFindVariables } from './brapi-find-variables.tool.js';
import { brapiFindVariants } from './brapi-find-variants.tool.js';
import { brapiGetGermplasm } from './brapi-get-germplasm.tool.js';
import { brapiGetImage } from './brapi-get-image.tool.js';
import { brapiGetStudy } from './brapi-get-study.tool.js';
import { brapiManageDataset } from './brapi-manage-dataset.tool.js';
import { brapiRawGet } from './brapi-raw-get.tool.js';
import { brapiRawSearch } from './brapi-raw-search.tool.js';
import { brapiServerInfo } from './brapi-server-info.tool.js';
import { brapiSubmitObservations } from './brapi-submit-observations.tool.js';
import { brapiWalkPedigree } from './brapi-walk-pedigree.tool.js';

/** Read-only tools registered unconditionally on every server. */
export const readOnlyToolDefinitions = [
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
  brapiRawGet,
  brapiRawSearch,
];

/**
 * Dataframe tools — registered only when both the framework canvas service
 * and BRAPI_CANVAS_ENABLED are on. The dataframe surface is opt-in (Tier 3,
 * requires the optional `@duckdb/node-api` peer dep). Hidden from
 * `tools/list` when disabled so the agent doesn't see capabilities it can't
 * use.
 */
export const dataframeToolDefinitions = [
  brapiDataframeQuery,
  brapiDataframeDescribe,
  brapiDataframeDrop,
];

/** Write tools — registered only when `BRAPI_ENABLE_WRITES=true`. */
export const writeToolDefinitions = [brapiSubmitObservations];
