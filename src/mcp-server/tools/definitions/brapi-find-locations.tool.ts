/**
 * @fileoverview `brapi_find_locations` — find research stations / field sites
 * by country, abbreviation, type, or free-text. Supports a client-side bbox
 * filter (minLat/maxLat/minLon/maxLon) applied after the initial page load,
 * since BrAPI doesn't define a spec-level bounding-box filter. Standard
 * find_* pattern: distributions + dataset spillover.
 *
 * @module mcp-server/tools/definitions/brapi-find-locations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';
import { getBrapiClient } from '@/services/brapi-client/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import { getDatasetStore } from '@/services/dataset-store/index.js';
import { DEFAULT_ALIAS, getServerRegistry } from '@/services/server-registry/index.js';
import {
  AliasInput,
  asString,
  buildRefinementHint,
  computeDistribution,
  DatasetHandleSchema,
  ExtraFiltersInput,
  LoadLimitInput,
  loadInitialPage,
  maybeSpill,
  mergeFilters,
  renderDistributions,
} from '../shared/find-helpers.js';

const LocationRowSchema = z
  .object({
    locationDbId: z.string(),
    locationName: z.string().optional(),
    abbreviation: z.string().optional(),
    countryCode: z.string().optional(),
    countryName: z.string().optional(),
    locationType: z.string().optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    altitude: z.number().optional(),
    instituteName: z.string().optional(),
    instituteAddress: z.string().optional(),
    documentationURL: z.string().optional(),
  })
  .passthrough();

const OutputSchema = z.object({
  alias: z.string().describe('Alias of the registered BrAPI connection the call used.'),
  results: z
    .array(LocationRowSchema)
    .describe(
      'Location rows returned in-context (up to loadLimit). Bbox filter is applied after the upstream fetch.',
    ),
  returnedCount: z
    .number()
    .int()
    .nonnegative()
    .describe('Length of `results[]` after any bbox filtering.'),
  totalCount: z
    .number()
    .int()
    .nonnegative()
    .describe(
      'Total rows reported by the server (or the post-bbox count when a bbox filter is active).',
    ),
  hasMore: z.boolean().describe('True when more rows exist beyond the returned set.'),
  distributions: z
    .object({
      countryCode: z.record(z.string(), z.number()),
      locationType: z.record(z.string(), z.number()),
    })
    .describe('Value frequency per field across the full result set.'),
  refinementHint: z
    .string()
    .optional()
    .describe('Suggested next-step query refinement when the result set is large.'),
  dataset: DatasetHandleSchema.optional().describe(
    'Dataset handle when the full result set was persisted to DatasetStore.',
  ),
  warnings: z
    .array(z.string())
    .describe('Advisory messages (bbox malformed, filter overrides, capability gaps, etc.).'),
  appliedFilters: z
    .record(z.string(), z.unknown())
    .describe('The final filter map sent to the server (named + extraFilters).'),
});

type Output = z.infer<typeof OutputSchema>;

export const brapiFindLocations = tool('brapi_find_locations', {
  description:
    'Find research stations / field sites by country, abbreviation, type, location ID, or free-text. Optional client-side bounding-box filter (bbox) restricts rows by latitude/longitude ranges after the upstream fetch. Returns a dataset handle when the upstream total exceeds loadLimit.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    alias: AliasInput,
    locations: z.array(z.string()).optional().describe('Filter by locationDbIds.'),
    locationNames: z.array(z.string()).optional().describe('Filter by display name.'),
    countryCodes: z.array(z.string()).optional().describe('ISO 3166-1 alpha-3 country codes.'),
    locationTypes: z
      .array(z.string())
      .optional()
      .describe('Location type — e.g. "Research Station", "Field".'),
    abbreviations: z.array(z.string()).optional().describe('Short location abbreviations.'),
    bbox: z
      .object({
        minLat: z.number().min(-90).max(90).optional(),
        maxLat: z.number().min(-90).max(90).optional(),
        minLon: z.number().min(-180).max(180).optional(),
        maxLon: z.number().min(-180).max(180).optional(),
      })
      .optional()
      .describe(
        'Optional post-fetch bounding box. All four corners must be set to activate the filter.',
      ),
    loadLimit: LoadLimitInput,
    extraFilters: ExtraFiltersInput,
  }),
  output: OutputSchema,

  async handler(input, ctx) {
    const registry = getServerRegistry();
    const capabilities = getCapabilityRegistry();
    const client = getBrapiClient();
    const datasetStore = getDatasetStore();
    const config = getServerConfig();

    const connection = await registry.get(ctx, input.alias ?? DEFAULT_ALIAS);

    const capabilityLookup: { auth?: typeof connection.resolvedAuth } = {};
    if (connection.resolvedAuth) capabilityLookup.auth = connection.resolvedAuth;
    await capabilities.ensure(
      connection.baseUrl,
      { service: 'locations', method: 'GET' },
      ctx,
      capabilityLookup,
    );

    const warnings: string[] = [];
    const filters = mergeFilters(
      {
        locationDbIds: input.locations,
        locationNames: input.locationNames,
        countryCodes: input.countryCodes,
        locationTypes: input.locationTypes,
        abbreviations: input.abbreviations,
      },
      input.extraFilters,
      warnings,
    );

    const loadLimit = input.loadLimit ?? config.loadLimit;
    const firstPage = await loadInitialPage<Record<string, unknown>>(
      client,
      connection,
      '/locations',
      filters,
      loadLimit,
      ctx,
    );

    const { fullRows, dataset: datasetMeta } = await maybeSpill({
      firstPage,
      client,
      connection,
      path: '/locations',
      filters,
      source: 'find_locations',
      loadLimit,
      ctx,
      store: datasetStore,
    });

    const bbox = normalizeBbox(input.bbox, warnings);
    const filteredFull = bbox ? fullRows.filter((r) => insideBbox(r, bbox)) : fullRows;
    const filteredReturned = bbox
      ? firstPage.rows.filter((r) => insideBbox(r, bbox))
      : firstPage.rows;

    const distributions = {
      countryCode: computeDistribution(filteredFull, (r) => asString(r.countryCode)),
      locationType: computeDistribution(filteredFull, (r) => asString(r.locationType)),
    };

    const totalCount = bbox ? filteredFull.length : (firstPage.totalCount ?? firstPage.rows.length);
    const refinementHint = buildRefinementHint(totalCount, loadLimit, distributions);

    const result: Output = {
      alias: connection.alias,
      results: filteredReturned as z.infer<typeof LocationRowSchema>[],
      returnedCount: filteredReturned.length,
      totalCount,
      hasMore: firstPage.hasMore,
      distributions,
      warnings,
      appliedFilters: filters,
    };
    if (refinementHint) result.refinementHint = refinementHint;
    if (datasetMeta) result.dataset = datasetMeta;
    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`# ${result.returnedCount} of ${result.totalCount} locations — \`${result.alias}\``);
    lines.push('');
    if (result.hasMore) {
      lines.push(
        `⚠ More rows exist beyond the returned set. ${result.dataset ? `Full set persisted as dataset \`${result.dataset.datasetId}\`.` : 'Narrow filters or raise loadLimit.'}`,
      );
      lines.push('');
    }
    if (result.refinementHint) {
      lines.push(`**Refinement hint:** ${result.refinementHint}`);
      lines.push('');
    }
    lines.push(`Applied filters: \`${JSON.stringify(result.appliedFilters)}\``);
    lines.push('');
    lines.push('## Distributions');
    lines.push(renderDistributions(result.distributions) || '_No values to summarize._');
    lines.push('');
    lines.push('## Locations');
    if (result.results.length === 0) {
      lines.push('_No rows returned._');
    } else {
      for (const loc of result.results) {
        const parts: string[] = [`**${loc.locationName ?? loc.locationDbId}**`];
        parts.push(`id=\`${loc.locationDbId}\``);
        if (loc.abbreviation) parts.push(`abbr=${loc.abbreviation}`);
        if (loc.locationType) parts.push(`type=${loc.locationType}`);
        if (loc.countryCode) parts.push(`country=${loc.countryCode}`);
        if (loc.countryName) parts.push(`countryName=${loc.countryName}`);
        if (loc.latitude !== undefined && loc.longitude !== undefined) {
          parts.push(`lat=${loc.latitude}`);
          parts.push(`lon=${loc.longitude}`);
        }
        if (loc.altitude !== undefined) parts.push(`alt=${loc.altitude}`);
        if (loc.instituteName) parts.push(`institute=${loc.instituteName}`);
        if (loc.instituteAddress) parts.push(`addr=${loc.instituteAddress}`);
        if (loc.documentationURL) parts.push(`docs=${loc.documentationURL}`);
        lines.push(`- ${parts.join(' · ')}`);
      }
    }
    if (result.dataset) {
      lines.push('');
      lines.push('## Dataset handle');
      lines.push(`- datasetId: \`${result.dataset.datasetId}\``);
      lines.push(`- rowCount: ${result.dataset.rowCount}`);
      lines.push(`- sizeBytes: ${result.dataset.sizeBytes}`);
      lines.push(`- columns: ${result.dataset.columns.join(', ')}`);
      lines.push(`- createdAt: ${result.dataset.createdAt}`);
      lines.push(`- expiresAt: ${result.dataset.expiresAt}`);
    }
    if (result.warnings.length > 0) {
      lines.push('');
      lines.push('## Warnings');
      for (const w of result.warnings) lines.push(`- ${w}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

interface Bbox {
  maxLat: number;
  maxLon: number;
  minLat: number;
  minLon: number;
}

function normalizeBbox(
  bbox:
    | {
        minLat?: number | undefined;
        maxLat?: number | undefined;
        minLon?: number | undefined;
        maxLon?: number | undefined;
      }
    | undefined,
  warnings: string[],
): Bbox | undefined {
  if (!bbox) return;
  const { minLat, maxLat, minLon, maxLon } = bbox;
  if (
    minLat === undefined &&
    maxLat === undefined &&
    minLon === undefined &&
    maxLon === undefined
  ) {
    return;
  }
  if (
    minLat === undefined ||
    maxLat === undefined ||
    minLon === undefined ||
    maxLon === undefined
  ) {
    warnings.push('bbox ignored: all four corners (minLat, maxLat, minLon, maxLon) are required.');
    return;
  }
  if (minLat > maxLat || minLon > maxLon) {
    warnings.push('bbox ignored: min value exceeds max value on latitude or longitude.');
    return;
  }
  return { minLat, maxLat, minLon, maxLon };
}

function insideBbox(row: Record<string, unknown>, bbox: Bbox): boolean {
  const lat = row.latitude;
  const lon = row.longitude;
  if (typeof lat !== 'number' || typeof lon !== 'number') return false;
  return lat >= bbox.minLat && lat <= bbox.maxLat && lon >= bbox.minLon && lon <= bbox.maxLon;
}
