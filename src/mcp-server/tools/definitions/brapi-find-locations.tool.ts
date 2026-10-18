/**
 * @fileoverview `brapi_find_locations` — find research stations / field sites
 * by country, abbreviation, type, or free-text. Supports a client-side bbox
 * filter (minLat/maxLat/minLon/maxLon) applied to every scanned row, since
 * BrAPI doesn't define a spec-level bounding-box filter. Standard
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
import { resolveCountryName } from '@/services/iso-country/index.js';
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
  discloseInlineTrim,
  ExtraFiltersInput,
  extractCoordinates,
  hasPointGeometry,
  InlineTrimEnrichment,
  LoadLimitInput,
  loadInitialFindPage,
  maybeSpill,
  mergeFilters,
  NonBlankString,
  renderAppliedFiltersTrailer,
  renderDataframeHandle,
  renderDistributions,
  renderFindHeader,
  renderMoreRowsLine,
  renderWarningsTrailer,
  requireRegisteredConnection,
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
  alias: z.string().describe('Connection alias the call used.'),
  results: z
    .array(LocationRowSchema)
    .describe(
      'Leading matched location rows, up to loadLimit and a 24,000-byte budget, whichever binds first. A bbox filter applies before the cut, across every page scanned.',
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
    .describe('Value frequency per field across every matched row fetched.'),
  dataframe: DataframeHandleSchema.optional().describe(
    'The matched rows, staged as a dataframe when results[] holds fewer.',
  ),
  coordinateAxisOrder: z
    .enum(['spec', 'swapped'])
    .describe(
      'Axis order used to read GeoJSON Point coordinates: "spec" is RFC 7946 [lon, lat, alt?]; "swapped" means the upstream stores [lat, lon, alt?] and bbox and rendered coordinates used that order.',
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
  // Singulars — emitted by dialects that singularize /locations (BMS, BrAPI Test Server).
  locationDbId: 'locations',
  locationName: 'locationNames',
  countryCode: 'countryCodes',
  locationType: 'locationTypes',
  abbreviation: 'abbreviations',
};

export const brapiFindLocations = tool('brapi_find_locations', {
  description:
    'Find research stations / field sites by country, abbreviation, type, location ID, or free-text. Countries filter by ISO 3166-1 alpha-3 code via countryCodes, or by free-form English country name via countryNames (resolved client-side to alpha-3 — "Uganda" → "UGA"). Optional bbox parameter restricts rows to a latitude/longitude window. When no first-page row falls inside it under the spec GeoJSON [lon, lat, alt] reading and a row carries a Point geometry, bbox is retried with axes swapped; if that matches, the swapped reading is used (non-conformant servers store [lat, lon, alt]) with a warning and `coordinateAxisOrder: "swapped"`. results[] holds the leading matches up to loadLimit and a 24,000-byte budget; when it holds fewer rows than matched, the matched set is materialized as a dataframe — read it with brapi_dataframe_describe and brapi_dataframe_query (SQL).',
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'unknown_alias',
      code: JsonRpcErrorCode.NotFound,
      when: 'No connection is registered under the requested alias, and the server has no base URL configured for it to connect on first use',
      recovery:
        'Run brapi_connect with this alias and a `baseUrl`, or pass an alias the brapi_connect description lists as built-in or operator-configured, before calling brapi_find_locations.',
      thrownBy: 'service',
    },
    {
      reason: 'auth_token_exchange_failed',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Connecting the alias on first use, the SGN or OAuth token exchange against the BrAPI /token endpoint failed',
      recovery:
        'Ask the operator to check the credentials configured for this alias and that the server exposes /token, or run brapi_connect with credentials in `auth`.',
      thrownBy: 'service',
    },
    {
      reason: 'auth_no_access_token',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Connecting the alias on first use, the token endpoint answered without returning an access token',
      recovery:
        'Ask the operator to check that the credentials configured for this alias are valid and that the upstream IdP issues access tokens for this grant.',
      thrownBy: 'service',
    },
    {
      reason: 'capability_discovery_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Neither /serverinfo nor /calls listed any call, and at least one of them timed out, was unreachable, or answered 429 or a 5xx other than 501, so nothing was cached',
      recovery:
        'The BrAPI server is slow or unreachable right now. Retry brapi_find_locations in a minute; if it keeps failing, the server may be down.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unauthorized',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'The BrAPI server answered HTTP 401: it requires credentials, or rejected the ones sent',
      recovery:
        'Run brapi_connect with credentials in `auth`, or ask the operator to set server-side credentials for this alias, then retry brapi_find_locations.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The BrAPI server answered HTTP 403: the credentials sent, or their absence, lack access',
      recovery:
        'Run brapi_connect with credentials that have access, or ask the operator to set server-side credentials for this alias that do, then retry brapi_find_locations.',
      thrownBy: 'service',
    },
    {
      reason: 'alias_base_url_invalid',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'The base URL configured on the server for this alias is not an absolute http(s) URL, or carries credentials',
      recovery:
        'Ask the operator to set the base URL configured for this alias to an absolute http(s) URL, then retry brapi_find_locations.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'private_address_blocked',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The base URL configured for this alias, or its token URL, is on a private or reserved address this server may not reach',
      recovery:
        'Ask the operator to point this alias at a publicly routable host, or to allow private addresses on this server, then retry brapi_find_locations.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'all_filters_dropped',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The active dialect dropped every filter the agent supplied — the upstream server does not honor any of the requested scope filters on this endpoint, so the call would silently widen to the unfiltered baseline.',
      recovery:
        'Drop the unsupported filters and rescope by locations, locationNames, countryCodes, locationTypes, abbreviations, or bbox — these filter paths are honored on the active dialect.',
      thrownBy: 'service',
    },
  ] as const,
  input: z.object({
    alias: AliasInput,
    locations: z.array(NonBlankString).optional().describe('Filter by locationDbIds.'),
    locationNames: z.array(NonBlankString).optional().describe('Filter by display name.'),
    countryCodes: z.array(NonBlankString).optional().describe('ISO 3166-1 alpha-3 country codes.'),
    countryNames: z
      .array(NonBlankString)
      .optional()
      .describe(
        'Free-form English country names or aliases (e.g. "Uganda", "United States", "USA") resolved client-side to ISO 3166-1 alpha-3 codes and merged into countryCodes. Names that do not resolve surface as a warning. Prefer countryCodes when you already have alpha-3 codes.',
      ),
    locationTypes: z
      .array(NonBlankString)
      .optional()
      .describe('Location type — e.g. "Research Station", "Field".'),
    abbreviations: z.array(NonBlankString).optional().describe('Short location abbreviations.'),
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
        'Total rows reported by the server, else the rows scanned; with an active bbox, the scanned rows inside it.',
      ),
    returnedCount: z
      .number()
      .int()
      .nonnegative()
      .describe('Length of results[] after any bbox filtering.'),
    appliedFilters: z
      .record(z.string(), z.unknown())
      .describe('Filter map sent upstream (named filters plus extraFilters).'),
    refinementHint: z
      .string()
      .optional()
      .describe('Suggested refinement when the result set is large.'),
    ...InlineTrimEnrichment,
    warnings: z
      .array(z.string())
      .describe('Advisory messages (bbox malformed, filter overrides, capability gaps).'),
  },

  enrichmentTrailer: {
    appliedFilters: { render: renderAppliedFiltersTrailer(SERVER_TO_USER) },
    warnings: { render: renderWarningsTrailer },
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

    // Resolve free-form country names to ISO 3166-1 alpha-3 codes and union
    // them into the countryCodes filter slot before mergeFilters runs, so
    // dialect adaptation, routing, and filter-match checks all see one set.
    const combinedCountryCodes = resolveCountryCodes(
      input.countryCodes,
      input.countryNames,
      warnings,
    );

    const merged = mergeFilters(
      {
        locationDbIds: input.locations,
        locationNames: input.locationNames,
        countryCodes: combinedCountryCodes,
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
      warnings,
    };
    if (normalizeRow) spillInput.normalizeRow = normalizeRow;
    if (bboxFilter) spillInput.rowFilter = bboxFilter;
    const spill = await maybeSpill(spillInput);

    // fullRows is already post-bbox when a bbox filter was supplied — the
    // dataframe and SQL surface see the same set, and results[] holds its
    // leading rows, not just the first upstream page's matches.
    const filteredFull = spill.fullRows;
    const filteredReturned = spill.results;

    // Counts describe the rows the scan examined; rows past an incomplete scan
    // were never checked against the bbox, so they are named apart.
    const { rowsScanned, scanComplete } = spill;
    const upstreamTotal = firstPage.totalCount;
    const scope = scanComplete
      ? ''
      : ` scanned; ${upstreamTotal === undefined ? 'the rest were' : `the other ${upstreamTotal - rowsScanned} of ${upstreamTotal} were`} not checked`;
    if (bbox && rowsScanned > 0 && filteredFull.length === 0) {
      warnings.push(
        `bbox excluded all ${rowsScanned} upstream location(s)${scope}. Verify the latitude/longitude window matches the server's coordinate convention.`,
      );
    } else if (bbox && filteredFull.length < rowsScanned) {
      warnings.push(
        `bbox excluded ${rowsScanned - filteredFull.length} of ${rowsScanned} upstream location(s)${scope}.`,
      );
    }

    const distributions = {
      countryCode: computeDistribution(filteredFull, (r) => asString(r.countryCode)),
      locationType: computeDistribution(filteredFull, (r) => asString(r.locationType)),
    };

    checkFilterMatchRates(warnings, filteredFull.length, [
      {
        paramName: 'countryCodes',
        requestedValues: combinedCountryCodes,
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

    const totalCount = bbox ? filteredFull.length : (firstPage.totalCount ?? spill.rowsScanned);
    const refinementHint = buildRefinementHint(spill, distributions, {
      availableFilters: [
        'locations',
        'locationNames',
        'countryCodes',
        'countryNames',
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
    discloseInlineTrim(ctx, spill, loadLimit);

    const result: Output = {
      alias: connection.alias,
      results: filteredReturned as z.infer<typeof LocationRowSchema>[],
      hasMore: spill.hasMore,
      distributions,
      coordinateAxisOrder,
    };
    if (spill.dataframe) result.dataframe = spill.dataframe;
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
    const moreRows = renderMoreRowsLine(result);
    if (moreRows) lines.push(moreRows, '');
    lines.push('## Distributions');
    lines.push(
      renderDistributions(result.distributions, result.dataframe) || '_No values to summarize._',
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
        parts.push(
          ...collectPassthroughParts(loc as Record<string, unknown>, RENDERED, result.dataframe),
        );
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

/**
 * Resolve free-form `countryNames` to ISO 3166-1 alpha-3 codes and union them
 * with any explicit `countryCodes`. Pushes a resolution advisory for names
 * that mapped and a warning for names that did not. Returns the combined,
 * de-duplicated code list, or `undefined` when neither input carried a value
 * (so the upstream call stays unfiltered rather than sending an empty array).
 */
function resolveCountryCodes(
  countryCodes: string[] | undefined,
  countryNames: string[] | undefined,
  warnings: string[],
): string[] | undefined {
  const resolved: Array<{ input: string; code: string }> = [];
  const unresolved: string[] = [];
  for (const name of countryNames ?? []) {
    const code = resolveCountryName(name);
    if (code) resolved.push({ input: name, code });
    else unresolved.push(name);
  }
  if (resolved.length > 0) {
    warnings.push(
      `Resolved country name(s) to ISO 3166-1 alpha-3: ${resolved
        .map((p) => `"${p.input}" → ${p.code}`)
        .join(', ')}.`,
    );
  }
  if (unresolved.length > 0) {
    warnings.push(
      `Could not resolve country name(s) to an ISO 3166-1 alpha-3 code: ${unresolved
        .map((n) => `"${n}"`)
        .join(', ')}. Pass the alpha-3 code directly via countryCodes, or check the spelling.`,
    );
  }
  const resolvedCodes = resolved.map((p) => p.code);
  if (!countryCodes && resolvedCodes.length === 0) return;
  return [...new Set([...(countryCodes ?? []), ...resolvedCodes])];
}
