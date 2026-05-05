/**
 * @fileoverview Routing nudges emitted by `brapi_raw_get` / `brapi_raw_search`
 * when the target endpoint is already covered by a curated goal-shaped tool.
 * Keeps the raw surface honest about its role as a last-resort escape hatch.
 *
 * @module mcp-server/tools/shared/raw-routing-hints
 */

/**
 * Map from a normalized path segment (no leading slash, no query) to the
 * goal-shaped tool that enriches it. Only endpoints that a curated tool
 * strictly supersedes should appear here; niche endpoints stay quiet.
 */
const GET_NUDGES: Record<string, string> = {
  studies:
    'This endpoint is also served by `brapi_find_studies` which enriches with program/trial/location FKs and returns distributions in one call.',
  germplasm:
    'This endpoint is also served by `brapi_find_germplasm` which adds distributions and dataframe spillover.',
  observations:
    'This endpoint is also served by `brapi_find_observations` which adds distributions and dataframe spillover.',
  variables:
    'This endpoint is also served by `brapi_find_variables` which adds free-text ranking against ontology terms.',
  images:
    'This endpoint is also served by `brapi_find_images`; use `brapi_get_image` to pull bytes inline.',
  variants:
    'This endpoint is also served by `brapi_find_variants` which handles distributions and dataframe spillover.',
  locations:
    'This endpoint is also served by `brapi_find_locations` which adds distributions and optional bounding-box filtering.',
  serverinfo:
    'For a full orientation envelope, call `brapi_server_info` (which uses the cached capability profile).',
  calls: 'The `brapi_server_info` envelope already surfaces the supported call set.',
  commoncropnames: 'Crop names are included in `brapi_server_info.content.crops`.',
};

const SEARCH_NUDGES: Record<string, string> = {
  studies: 'Consider `brapi_find_studies` — handles async polling + FK resolution automatically.',
  germplasm: 'Consider `brapi_find_germplasm` — handles distributions + dataframe spillover.',
  observations:
    'Consider `brapi_find_observations` — handles dataframe spillover and distributions.',
  variables:
    'Consider `brapi_find_variables` — ranks results client-side against ontology terms when text is provided.',
  calls:
    'Consider `brapi_find_genotype_calls` — handles async-search polling, deployment-side pull limit, and dataframe spillover automatically.',
  images: 'Consider `brapi_find_images`.',
  variants: 'Consider `brapi_find_variants`.',
  locations: 'Consider `brapi_find_locations`.',
};

/** Normalize "/images/123/imagecontent" → "images". */
function rootSegment(path: string): string {
  return path.replace(/^\/+/, '').split('/')[0] ?? '';
}

export function suggestForGet(path: string): string | undefined {
  const seg = rootSegment(path);
  return GET_NUDGES[seg];
}

export function suggestForSearch(noun: string): string | undefined {
  return SEARCH_NUDGES[noun.replace(/^\/+/, '')];
}
