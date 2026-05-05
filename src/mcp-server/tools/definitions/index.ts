/**
 * @fileoverview Tool registration barrel. Splits definitions into four groups
 * the entry point composes based on operator gates: read-only tools register
 * unconditionally, `brapi_dataframe_drop` registers only when
 * `BRAPI_CANVAS_DROP_ENABLED=true`, `brapi_dataframe_export` registers only
 * when `BRAPI_EXPORT_DIR` is set AND `MCP_TRANSPORT_TYPE=stdio`, and
 * `brapi_submit_observations` registers only when `BRAPI_ENABLE_WRITES=true`.
 * Keeping the gating in `src/index.ts` keeps this module free of eager
 * config reads.
 *
 * @module mcp-server/tools/definitions/index
 */

import { brapiConnect } from './brapi-connect.tool.js';
import { brapiDataframeDescribe } from './brapi-dataframe-describe.tool.js';
import { brapiDataframeDrop } from './brapi-dataframe-drop.tool.js';
import { brapiDataframeExport } from './brapi-dataframe-export.tool.js';
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
import { brapiRawGet } from './brapi-raw-get.tool.js';
import { brapiRawSearch } from './brapi-raw-search.tool.js';
import { brapiServerInfo } from './brapi-server-info.tool.js';
import { brapiSubmitObservations } from './brapi-submit-observations.tool.js';
import { brapiWalkPedigree } from './brapi-walk-pedigree.tool.js';

/**
 * Read-only tools registered unconditionally on every server. Includes
 * `brapi_dataframe_describe` and `brapi_dataframe_query` — canvas is
 * mandatory, so the discovery + read surface always registers.
 */
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
  brapiDataframeDescribe,
  brapiDataframeQuery,
  brapiRawGet,
  brapiRawSearch,
];

/**
 * Drop tool — opt-in via `BRAPI_CANVAS_DROP_ENABLED`. Off by default; the
 * underlying canvas tables expire via TTL when left unmanaged, so explicit
 * drop is only needed when the operator wants to free workspace memory
 * immediately.
 */
export const dropToolDefinitions = [brapiDataframeDrop];

/**
 * Export tool — gated by `BRAPI_EXPORT_DIR` (the opt-in) AND
 * `MCP_TRANSPORT_TYPE=stdio` (path output is meaningful only when the server
 * runs on the user's machine). Both checks live in `src/index.ts`.
 */
export const exportToolDefinitions = [brapiDataframeExport];

/** Write tools — registered only when `BRAPI_ENABLE_WRITES=true`. */
export const writeToolDefinitions = [brapiSubmitObservations];
