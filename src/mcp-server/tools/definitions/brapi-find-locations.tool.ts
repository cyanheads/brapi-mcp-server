/**
 * @fileoverview `brapi_find_locations` — find research stations / field sites
 * by country, abbreviation, type, or free-text. Supports a client-side bbox
 * filter (minLat/maxLat/minLon/maxLon) applied after the initial page load,
 * since BrAPI doesn't define a spec-level bounding-box filter. Standard
 * find_* pattern: distributions + dataframe spillover.
 *
 * @module mcp-server/tools/definitions/brapi-find-locations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getBrapiClient } from '@/services/brapi-client/index.js';
import { resolveDialect } from '@/services/brapi-dialect/index.js';
import { getCanvasBridge } from '@/services/canvas-bridge/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import { DEFAULT_ALIAS, getServerRegistry } from '@/services/server-registry/index.js';
import {
  AliasInput,
  applyDialectFiltersOrFail,
  asString,
  buildRefinementHint,
  type CoordinateAxisOrder,
  checkFilterMatchRates,
  collectPassthroughParts,
  computeDistribution,
  DataframeHandleSchema,
  ExtraFiltersInput,
  extractCoordinates,
  hasPointGeometry,
  LoadLimitInput,
  loadInitialFindPage,
  maybeSpill,
  mergeFilters,
  renderAppliedFilters,
  renderDataframeHandle,
  renderDistributions,
  renderFindHeader,
  resolveFindRoute,
} from '../shared/find-helpers.js';

const LocationRowSchema = z
  .object({
    locationDbId: z.string().describe('Server-side identifier for the location.'),
    locationName: z.string().nullish().describe('Display name.'),
    abbreviation: z.string().nullish().describe('Short abbreviation.'),
    countryCode: z.string().nullish().describe('ISO 3166-1 alpha-3 country code.'),
    countryName: z.string().nullish().describe('Display name of the country.'),
    locationType: z
      .string()
      .nullish()
      .describe('Type of location (e.g. "Research Station", "Field", "Greenhouse").'),
    latitude: z
      .number()
      .nullish()
      .describe(
        'WGS84 latitude in decimal degrees (legacy field; modern servers use coordinates).',
      ),
    longitude: z
      .number()
      .nullish()
      .describe(
        'WGS84 longitude in decimal degrees (legacy field; modern servers use coordinates).',
      ),
    altitude: z.number().nullish().describe('Altitude in meters above sea level.'),
    coordinates: z
      .object({})
      .passthrough()
      .nullish()
      .describe('BrAPI v2 GeoJSON Feature carrying [lon, lat, alt?] in geometry.coordinates.'),
    instituteName: z.string().nullish().describe('Owning institute display name.'),
    instituteAddress: z.string().nullish().describe('Postal address of the institute.'),
    documentationURL: z.string().nullish().describe('URL pointing at extra documentation.'),
  })
  .passthrough()
  .describe('One BrAPI location record.');

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
      countryCode: z
        .record(z.string(), z.number())
        .describe('ISO country code → count of locations in that country.'),
      locationType: z
        .record(z.string(), z.number())
        .describe('Location type → count of locations of that type.'),
    })
    .describe('Value frequency per field across the full result set.'),
  refinementHint: z
    .string()
    .optional()
    .describe('Suggested next-step query refinement when the result set is large.'),
  dataframe: DataframeHandleSchema.optional().describe(
    'Dataframe handle when the full result set was materialized as a dataframe. Query it with brapi_dataframe_query (SQL).',
  ),
  warnings: z
    .array(z.string())
    .describe('Advisory messages (bbox malformed, filter overrides, capability gaps, etc.).'),
  appliedFilters: z
    .record(z.string(), z.unknown())
    .describe('The final filter map sent to the server (named + extraFilters).'),
  coordinateAxisOrder: z
    .enum(['spec', 'swapped'])
    .describe(
      'Axis interpretation used when reading GeoJSON Point coordinates. "spec" follows the GeoJSON RFC 7946 [lon, lat, alt?] convention. "swapped" indicates the upstream server stores [lat, lon, alt?] (non-conformant) and bbox + rendered coordinates were interpreted accordingly.',
    ),
});

type Output = z.infer<typeof OutputSchema>;

const SERVER_TO_USER: Record<string, string> = {
  // Plurals — BrAPI v2.1 spec.
  locationDbIds: 'locations',
  locationNames: 'locationNames',
  countryCodes: 'countryCodes',
  locationTypes: 'locationTypes',
  abbreviations: 'abbreviations',
  // Singulars — SGN-family dialects.
  locationDbId: 'locations',
  locationName: 'locationNames',
  countryCode: 'countryCodes',
  locationType: 'locationTypes',
  abbreviation: 'abbreviations',
};

export const brapiFindLocations = tool('brapi_find_locations', {
  description:
    'Find research stations / field sites by country, abbreviation, type, location ID, or free-text. Optional bbox parameter restricts rows to a latitude/longitude window. When the spec-correct GeoJSON [lon, lat, alt] reading produces zero matches and at least one row carries a Point geometry, the bbox filter retries once with axes swapped (handles non-conformant servers that store [lat, lon, alt]) and surfaces a warning + `coordinateAxisOrder: "swapped"`. When the upstream total exceeds loadLimit, the full result set is materialized as a dataframe — query it with brapi_dataframe_query (SQL).',
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'all_filters_dropped',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The active dialect dropped every filter the agent supplied — the upstream server does not honor any of the requested scope filters on this endpoint, so the call would silently widen to the unfiltered baseline.',
      recovery:
        'Drop the unsupported filters and rescope by locations, locationNames, countryCodes, locationTypes, abbreviations, or bbox — these filter paths are honored on the active dialect.',
    },
  ] as const,
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
        minLat: z
          .number()
          .min(-90)
          .max(90)
          .optional()
          .describe('Minimum latitude in WGS84 decimal degrees.'),
        maxLat: z
          .number()
          .min(-90)
          .max(90)
          .optional()
          .describe('Maximum latitude in WGS84 decimal degrees.'),
        minLon: z
          .number()
          .min(-180)
          .max(180)
          .optional()
          .describe('Minimum longitude in WGS84 decimal degrees.'),
        maxLon: z
          .number()
          .min(-180)
          .max(180)
          .optional()
          .describe('Maximum longitude in WGS84 decimal degrees.'),
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
    const bridge = getCanvasBridge();
    const config = getServerConfig();

    const connection = await registry.get(ctx, input.alias ?? DEFAULT_ALIAS);

    const capabilityLookup: { auth?: typeof connection.resolvedAuth } = {};
    if (connection.resolvedAuth) capabilityLookup.auth = connection.resolvedAuth;
    const profile = await capabilities.profile(connection.baseUrl, ctx, capabilityLookup);

    const dialect = await resolveDialect(connection, ctx, capabilityLookup);

    const warnings: string[] = [];
    const merged = mergeFilters(
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

    const filters = applyDialectFiltersOrFail(ctx, dialect, 'locations', merged, warnings);
    const route = resolveFindRoute({
      profile,
      dialect,
      endpoint: 'locations',
      filters,
      searchBody: merged,
      warnings,
    });

    const loadLimit = input.loadLimit ?? config.loadLimit;
    const firstPage = await loadInitialFindPage<Record<string, unknown>>(
      client,
      connection,
      route,
      loadLimit,
      ctx,
    );

    const { fullRows, dataframe } = await maybeSpill({
      firstPage,
      client,
      connection,
      path: '/locations',
      filters,
      route,
      source: 'find_locations',
      loadLimit,
      ctx,
      bridge,
    });

    const bbox = normalizeBbox(input.bbox, warnings);
    let coordinateAxisOrder: CoordinateAxisOrder = 'spec';
    let filteredFull = bbox ? fullRows.filter((r) => insideBbox(r, bbox, 'spec')) : fullRows;
    let filteredReturned = bbox
      ? firstPage.rows.filter((r) => insideBbox(r, bbox, 'spec'))
      : firstPage.rows;
    if (bbox && fullRows.length > 0 && filteredFull.length === 0) {
      // Spec pass excluded everything. If at least one row carries a Point
      // geometry, the server may store coordinates as [lat, lon, alt] rather
      // than the GeoJSON-standard [lon, lat, alt] (the BrAPI Community Test
      // Server is a known offender). Retry once with axes swapped — the
      // retry is in-memory over already-fetched rows. If the swap recovers
      // matches, surface a loud warning so operators can chase the upstream
      // quirk; if it still produces zero, fall through to the existing
      // verify-coordinate-convention warning.
      const swappedFull = fullRows.some(hasPointGeometry)
        ? fullRows.filter((r) => insideBbox(r, bbox, 'swapped'))
        : [];
      if (swappedFull.length > 0) {
        coordinateAxisOrder = 'swapped';
        filteredFull = swappedFull;
        filteredReturned = firstPage.rows.filter((r) => insideBbox(r, bbox, 'swapped'));
        warnings.push(
          `Server appears to store GeoJSON coordinates as [lat, lon, alt] rather than the spec-required [lon, lat, alt]. Bbox matches returned under the swapped interpretation; the upstream coordinate convention is non-conformant and should be flagged.`,
        );
      } else {
        warnings.push(
          `bbox excluded all ${fullRows.length} upstream location(s). Verify the latitude/longitude window matches the server's coordinate convention.`,
        );
      }
    } else if (bbox && filteredFull.length < fullRows.length) {
      warnings.push(
        `bbox excluded ${fullRows.length - filteredFull.length} of ${fullRows.length} upstream location(s).`,
      );
    }

    const distributions = {
      countryCode: computeDistribution(filteredFull, (r) => asString(r.countryCode)),
      locationType: computeDistribution(filteredFull, (r) => asString(r.locationType)),
    };

    checkFilterMatchRates(warnings, filteredFull.length, [
      {
        paramName: 'countryCodes',
        requestedValues: input.countryCodes,
        distribution: distributions.countryCode,
        caseInsensitive: true,
        requireEveryRowMatch: true,
      },
      {
        paramName: 'locationTypes',
        requestedValues: input.locationTypes,
        distribution: distributions.locationType,
        caseInsensitive: true,
        requireEveryRowMatch: true,
      },
    ]);

    const totalCount = bbox ? filteredFull.length : (firstPage.totalCount ?? firstPage.rows.length);
    const refinementHint = buildRefinementHint(totalCount, loadLimit, distributions, {
      availableFilters: [
        'locations',
        'locationNames',
        'countryCodes',
        'locationTypes',
        'abbreviations',
        'bbox',
      ],
    });

    const result: Output = {
      alias: connection.alias,
      results: filteredReturned as z.infer<typeof LocationRowSchema>[],
      returnedCount: filteredReturned.length,
      totalCount,
      hasMore: firstPage.hasMore,
      distributions,
      warnings,
      appliedFilters: route.kind === 'search' ? route.searchBody : filters,
      coordinateAxisOrder,
    };
    if (refinementHint) result.refinementHint = refinementHint;
    if (dataframe) result.dataframe = dataframe;
    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(
      renderFindHeader({
        noun: 'locations',
        alias: result.alias,
        returnedCount: result.returnedCount,
        totalCount: result.totalCount,
        dataframe: result.dataframe,
      }),
    );
    lines.push(`**Coordinate axis order:** ${result.coordinateAxisOrder}`);
    lines.push('');
    if (result.hasMore) {
      lines.push(
        `⚠ More rows exist beyond the returned set. ${result.dataframe ? `Full set materialized as dataframe \`${result.dataframe.tableName}\` — query with brapi_dataframe_query.` : 'Narrow filters or raise loadLimit.'}`,
      );
      lines.push('');
    }
    if (result.refinementHint) {
      lines.push(`**Refinement hint:** ${result.refinementHint}`);
      lines.push('');
    }
    lines.push(renderAppliedFilters(result.appliedFilters, SERVER_TO_USER));
    lines.push('');
    lines.push('## Distributions');
    lines.push(renderDistributions(result.distributions) || '_No values to summarize._');
    lines.push('');
    lines.push('## Locations');
    if (result.results.length === 0) {
      lines.push('_No rows returned._');
    } else {
      // `coordinates` intentionally excluded: passthrough helper renders the full
      // GeoJSON object so text-only clients see it alongside the extracted lat/lon.
      const RENDERED = new Set([
        'locationName',
        'locationDbId',
        'abbreviation',
        'locationType',
        'countryCode',
        'countryName',
        'latitude',
        'longitude',
        'altitude',
        'instituteName',
        'instituteAddress',
        'documentationURL',
      ]);
      for (const loc of result.results) {
        const parts: string[] = [`**${loc.locationName ?? loc.locationDbId}**`];
        parts.push(`id=\`${loc.locationDbId}\``);
        if (loc.abbreviation) parts.push(`abbr=${loc.abbreviation}`);
        if (loc.locationType) parts.push(`type=${loc.locationType}`);
        if (loc.countryCode) parts.push(`country=${loc.countryCode}`);
        if (loc.countryName) parts.push(`countryName=${loc.countryName}`);
        const coords = extractCoordinates(loc, result.coordinateAxisOrder);
        if (coords) {
          parts.push(`lat=${coords.latitude}`);
          parts.push(`lon=${coords.longitude}`);
          if (coords.altitude != null) parts.push(`alt=${coords.altitude}`);
        } else if (loc.altitude != null) {
          parts.push(`alt=${loc.altitude}`);
        }
        if (loc.instituteName) parts.push(`institute=${loc.instituteName}`);
        if (loc.instituteAddress) parts.push(`addr=${loc.instituteAddress}`);
        if (loc.documentationURL) parts.push(`docs=${loc.documentationURL}`);
        parts.push(...collectPassthroughParts(loc as Record<string, unknown>, RENDERED));
        lines.push(`- ${parts.join(' · ')}`);
      }
    }
    if (result.dataframe) {
      lines.push('');
      lines.push('## Dataframe handle');
      lines.push(...renderDataframeHandle(result.dataframe));
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

function insideBbox(
  row: Record<string, unknown>,
  bbox: Bbox,
  axisOrder: CoordinateAxisOrder,
): boolean {
  const coords = extractCoordinates(row, axisOrder);
  if (!coords) return false;
  const { latitude: lat, longitude: lon } = coords;
  return lat >= bbox.minLat && lat <= bbox.maxLat && lon >= bbox.minLon && lon <= bbox.maxLon;
}
