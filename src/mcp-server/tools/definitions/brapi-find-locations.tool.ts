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
import {
  AliasInput,
  applyDialectFiltersOrFail,
  asString,
  buildExtraFilterChecks,
  buildRefinementHint,
  type CoordinateAxisOrder,
  checkFilterMatchRates,
  collectPassthroughParts,
  computeDistribution,
  DataframeHandleSchema,
  dialectRowMapper,
  ExtraFiltersInput,
  extractCoordinates,
  hasPointGeometry,
  LoadLimitInput,
  loadInitialFindPage,
  maybeSpill,
  mergeFilters,
  renderDataframeHandle,
  renderDistributions,
  renderFindHeader,
  requireRegisteredConnection,
  resolveFindRoute,
  truncationMeta,
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
  dataframe: DataframeHandleSchema.optional().describe(
    'Dataframe handle when the full result set was materialized as a dataframe. Query it with brapi_dataframe_query (SQL).',
  ),
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
      reason: 'unknown_alias',
      code: JsonRpcErrorCode.NotFound,
      when: 'No connection has been registered under the requested alias',
      recovery:
        'Run brapi_connect with this alias (or omit `alias` to use the default connection) before calling brapi_find_locations.',
    },
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

  // Agent-facing success-path context: pagination totals, the exact filter map
  // sent to the server, guidance when the result set is large, and empty-result
  // notices. Populated via ctx.enrich() so it reaches both structuredContent
  // and the content[] trailer without living in the domain return.
  enrichment: {
    totalCount: z
      .number()
      .int()
      .nonnegative()
      .describe(
        'Total rows reported by the server (or the post-bbox count when a bbox filter is active).',
      ),
    returnedCount: z
      .number()
      .int()
      .nonnegative()
      .describe('Length of results[] after any bbox filtering.'),
    appliedFilters: z
      .record(z.string(), z.unknown())
      .describe('The final filter map sent to the server (named + extraFilters).'),
    refinementHint: z
      .string()
      .optional()
      .describe('Suggested next-step query refinement when the result set is large.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when no rows were returned — how to broaden filters or retry.'),
    warnings: z
      .array(z.string())
      .describe('Advisory messages (bbox malformed, filter overrides, capability gaps).'),
  },

  enrichmentTrailer: {
    appliedFilters: {
      render: (filters) => {
        const entries = Object.entries(filters);
        if (entries.length === 0) return '**Applied Filters:** none';
        const lines = entries.map(([k, v]) => {
          const display = SERVER_TO_USER[k] ?? k;
          return `- **${display}:** ${Array.isArray(v) ? v.join(', ') : String(v)}`;
        });
        return `**Applied Filters:**\n${lines.join('\n')}`;
      },
    },
    warnings: {
      render: (ws) => (ws.length > 0 ? ws.map((w) => `- ${w}`).join('\n') : '_none_'),
      label: 'Warnings',
    },
  },

  async handler(input, ctx) {
    const capabilities = getCapabilityRegistry();
    const client = getBrapiClient();
    const bridge = getCanvasBridge();
    const config = getServerConfig();

    const connection = await requireRegisteredConnection(ctx, input.alias);

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

    const adapted = applyDialectFiltersOrFail(ctx, dialect, 'locations', merged, warnings);
    const filters = adapted.filters;
    const route = resolveFindRoute({
      profile,
      dialect,
      endpoint: 'locations',
      filters,
      searchBody: merged,
      warnings,
      ...(adapted.requiresEscalation ? { requiresEscalation: true } : {}),
    });

    const loadLimit = input.loadLimit ?? config.loadLimit;
    const normalizeRow = dialectRowMapper<Record<string, unknown>>(dialect, 'locations');
    const firstPage = await loadInitialFindPage<Record<string, unknown>>(
      client,
      connection,
      route,
      loadLimit,
      ctx,
      normalizeRow ? { normalizeRow } : {},
    );

    const bbox = normalizeBbox(input.bbox, warnings);
    /*
     * Axis-order pick runs before spillover so the rowFilter we hand to
     * `maybeSpill` materializes the dataframe under the right coordinate
     * interpretation from the start — historically this ran after spillover
     * and the dataframe held the pre-bbox upstream union, which made SQL on
     * the handle silently bypass the bbox (#28).
     *
     * Decision is made over already-fetched first-page rows: try `spec`
     * (RFC 7946 [lon, lat]); if that yields zero matches and at least one
     * row carries a Point geometry, retry under `swapped` ([lat, lon]) and
     * commit to it for the spill walk. If both produce zero we still go with
     * `spec` — the warning then says "bbox excluded everything" rather than
     * silently flipping the axis interpretation on no evidence.
     */
    let coordinateAxisOrder: CoordinateAxisOrder = 'spec';
    if (bbox && firstPage.rows.length > 0) {
      const specMatches = firstPage.rows.filter((r) => insideBbox(r, bbox, 'spec'));
      if (specMatches.length === 0 && firstPage.rows.some(hasPointGeometry)) {
        const swappedMatches = firstPage.rows.filter((r) => insideBbox(r, bbox, 'swapped'));
        if (swappedMatches.length > 0) {
          coordinateAxisOrder = 'swapped';
          warnings.push(
            `Server appears to store GeoJSON coordinates as [lat, lon, alt] rather than the spec-required [lon, lat, alt]. Bbox matches returned under the swapped interpretation; the upstream coordinate convention is non-conformant and should be flagged.`,
          );
        }
      }
    }
    const axisOrder = coordinateAxisOrder;
    const bboxFilter = bbox
      ? (r: Record<string, unknown>) => insideBbox(r, bbox, axisOrder)
      : undefined;

    const spillInput: Parameters<typeof maybeSpill<Record<string, unknown>>>[0] = {
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
    };
    if (normalizeRow) spillInput.normalizeRow = normalizeRow;
    if (bboxFilter) spillInput.rowFilter = bboxFilter;
    const { fullRows, dataframe } = await maybeSpill(spillInput);

    // fullRows is already post-bbox when a bbox filter was supplied — the
    // dataframe and SQL surface see the same set. Compute the returned slice
    // (first-page rows that passed bbox) the same way.
    const filteredFull = fullRows;
    const filteredReturned = bboxFilter ? firstPage.rows.filter(bboxFilter) : firstPage.rows;

    if (bbox && firstPage.rows.length > 0 && filteredFull.length === 0) {
      warnings.push(
        `bbox excluded all ${firstPage.rows.length} upstream location(s) returned on the first page. Verify the latitude/longitude window matches the server's coordinate convention.`,
      );
    } else if (
      bbox &&
      typeof firstPage.totalCount === 'number' &&
      filteredFull.length < firstPage.totalCount
    ) {
      const excluded = firstPage.totalCount - filteredFull.length;
      warnings.push(`bbox excluded ${excluded} of ${firstPage.totalCount} upstream location(s).`);
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
      ...buildExtraFilterChecks(input.extraFilters, filteredFull, warnings),
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

    const appliedFilters = route.kind === 'search' ? route.searchBody : filters;
    ctx.enrich({
      totalCount,
      returnedCount: filteredReturned.length,
      appliedFilters,
      warnings,
      ...(refinementHint ? { refinementHint } : {}),
    });
    if (filteredReturned.length === 0)
      ctx.enrich.notice(
        warnings.length > 0
          ? 'No rows returned. Check the warnings above for filter issues, or broaden your filters.'
          : 'No locations matched the applied filters. Try broadening locationNames, countryCodes, locationTypes, or bbox.',
      );

    const result: Output = {
      alias: connection.alias,
      results: filteredReturned as z.infer<typeof LocationRowSchema>[],
      hasMore: firstPage.hasMore,
      distributions,
      coordinateAxisOrder,
    };
    if (dataframe) result.dataframe = dataframe;
    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(
      renderFindHeader({
        noun: 'locations',
        alias: result.alias,
        returnedCount: result.results.length,
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
    lines.push('## Distributions');
    lines.push(
      renderDistributions(result.distributions, truncationMeta(result.dataframe)) ||
        '_No values to summarize._',
    );
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
