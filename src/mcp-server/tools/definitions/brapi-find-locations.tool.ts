/**
 * @fileoverview `brapi_find_locations` — find research stations / field sites
 * by country, abbreviation, type, or free-text. Supports a client-side bbox
 * filter (minLat/maxLat/minLon/maxLon) applied to every scanned row, since
 * BrAPI doesn't define a spec-level bounding-box filter. On SGN servers,
 * country names also send ISO numeric and E.164 calling codes, and a row
 * matched only through one is checked against its own `countryName` before
 * the bbox. Standard find_* pattern: distributions + dataframe spillover.
 *
 * @module mcp-server/tools/definitions/brapi-find-locations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getBrapiClient } from '@/services/brapi-client/index.js';
import { resolveDialect } from '@/services/brapi-dialect/index.js';
import { getCanvasBridge } from '@/services/canvas-bridge/index.js';
import { DISCOVERY_NOT_FOUND_ERROR } from '@/services/capability-registry/capability-registry.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import { resolveCountryName } from '@/services/iso-country/index.js';
import {
  AliasInput,
  appliedFindFilters,
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
  InlineTrimEnrichment,
  LoadLimitInput,
  loadInitialFindPage,
  maybeSpill,
  mergeFilters,
  NonBlankString,
  renderAdvisoryTrailer,
  renderAppliedFiltersTrailer,
  renderDataframeHandle,
  renderDistributions,
  renderFindHeader,
  renderMoreRowsLine,
  renderWarningsTrailer,
  requireRegisteredConnection,
  resolveFindRoute,
} from '../shared/find-helpers.js';
import { literal } from '../shared/markdown-literals.js';

const LocationRowSchema = z
  .object({
    locationDbId: z.string().describe('Server-side identifier for the location.'),
    locationName: z.string().nullish().describe('Display name.'),
    abbreviation: z.string().nullish().describe('Short abbreviation.'),
    countryCode: z.string().nullish().describe('Country code as reported by the upstream.'),
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
      'Leading matched location rows, up to loadLimit and a 24,000-byte budget, whichever binds first. Bbox and country-name checks apply before the cut, across every page scanned.',
    ),
  hasMore: z.boolean().describe('True when more rows exist beyond the returned set.'),
  distributions: z
    .object({
      countryCode: z
        .record(z.string(), z.number())
        .describe('Country code as stored upstream → count of locations.'),
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
    'Find research stations / field sites by country, abbreviation, type, location ID, or free-text. Pass countryCodes directly or use English countryNames to resolve ISO codes. On SGN-family servers (CassavaBase, Sweetpotatobase, other Breedbase deployments), resolved names also search alpha-2, ISO numeric, and E.164 calling codes, and a row matched only by a numeric code is dropped when its countryName names another country. Optional bbox restricts rows to a latitude/longitude window. The BrAPI Community Test Server dialect reads GeoJSON Points in [lat, lon, alt] order; other dialects use [lon, lat, alt]. results[] holds the leading matches up to loadLimit and a 24,000-byte budget; when it holds fewer rows than matched, the matched set is materialized as a dataframe — read it with brapi_dataframe_describe and brapi_dataframe_query (SQL).',
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'upstream_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'An uncaught BrAPI data request answered HTTP 404',
      recovery:
        'Check brapi_server_info for supported endpoints and verify the requested identifiers before retrying brapi_find_locations.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'An uncaught BrAPI data request exhausted retries after HTTP 429',
      recovery:
        'Wait before retrying brapi_find_locations; reduce concurrent requests to this BrAPI server.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'missing_find_route',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither the GET list nor a usable POST search route is advertised',
      recovery: 'Check brapi_server_info and choose a connection advertising this finder endpoint.',
      thrownBy: 'service',
    },
    {
      reason: 'search_endpoint_disabled',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Only a POST search route marked unusable by the active dialect is advertised',
      recovery: 'Choose a connection with a supported GET route or a usable POST search endpoint.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_bbox',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A nonempty bbox is incomplete or has reversed latitude or longitude bounds',
      recovery:
        'Supply all four bbox bounds (minLat, maxLat, minLon, maxLon), with each minimum no greater than its maximum, or omit bbox.',
    },
    {
      reason: 'unresolved_country_names',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No countryNames resolve and no effective countryCodes restriction remains',
      recovery: 'Check countryNames spelling or supply countryCodes directly, then retry.',
    },
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
    DISCOVERY_NOT_FOUND_ERROR,
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
    countryCodes: z
      .array(NonBlankString)
      .optional()
      .describe(
        'Country codes sent as given: alphabetic codes are uppercased, numeric codes keep their spelling, and rows they match are never re-checked against countryName.',
      ),
    countryNames: z
      .array(NonBlankString)
      .optional()
      .describe(
        "English country names or aliases resolved to ISO alpha-3 codes (on SGN-family servers also alpha-2, ISO numeric, and the E.164 calling code) and merged into countryCodes. A row matched only by one of those numeric codes is kept when its countryName names the requested country, dropped when it names another, and kept with a warning when it doesn't resolve. Unresolved names warn when another effective country restriction remains; otherwise the call fails.",
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
        'Optional post-fetch bounding box. Nonempty boxes require all four bounds with minimum <= maximum; malformed boxes fail. An empty object is omitted.',
      ),
    loadLimit: LoadLimitInput,
    extraFilters: ExtraFiltersInput,
  }),
  inputAliases: {
    locationDbId: 'locations',
    locationDbIds: 'locations',
  },
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
        'Total rows reported by the server, else the rows scanned; after a bbox or country-name check, the rows kept.',
      ),
    returnedCount: z.number().int().nonnegative().describe('Length of results[].'),
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
      .describe('Advisory messages (unresolved country names, filter overrides, capability gaps).'),
  },

  enrichmentTrailer: {
    refinementHint: { render: renderAdvisoryTrailer },
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
    const bbox = normalizeBbox(input.bbox, () => {
      throw ctx.fail(
        'invalid_bbox',
        'Invalid bbox: provide all four bounds with minimum <= maximum.',
      );
    });

    const expandCodes = dialect.expandLocationCountryCodes === true;
    const resolvedCountries = resolveCountryCodes(
      input.countryCodes,
      input.countryNames,
      expandCodes,
      warnings,
    );
    // Codes the caller spelled are their own; only codes expanded from names are re-checked.
    const explicitCodes = new Set(
      [input.countryCodes, input.extraFilters?.countryCodes, input.extraFilters?.countryCode]
        .flat()
        .filter((code) => typeof code === 'string' || typeof code === 'number')
        .map((code) => String(code).toUpperCase()),
    );
    const countryCheck = numericCountryCheck(resolvedCountries.numericOwners, explicitCodes);

    const merged = mergeFilters(
      {
        locationDbIds: input.locations,
        locationNames: input.locationNames,
        countryCodes: resolvedCountries.codes,
        locationTypes: input.locationTypes,
        abbreviations: input.abbreviations,
      },
      input.extraFilters,
      warnings,
    );
    if (Array.isArray(merged.countryCodes)) {
      merged.countryCodes = merged.countryCodes.map((code) =>
        typeof code === 'string' ? code.toUpperCase() : code,
      );
    } else if (typeof merged.countryCodes === 'string') {
      merged.countryCodes = merged.countryCodes.toUpperCase();
    }
    const effectiveCodes = merged.countryCodes;
    const hasCountryRestriction = Array.isArray(effectiveCodes)
      ? effectiveCodes.some(
          (code) => typeof code === 'number' || (typeof code === 'string' && code.length > 0),
        )
      : typeof effectiveCodes === 'number' ||
        (typeof effectiveCodes === 'string' && effectiveCodes.length > 0);
    if (input.countryNames?.length && !hasCountryRestriction) {
      throw ctx.fail(
        'unresolved_country_names',
        `No effective country restriction remains for countryNames: ${input.countryNames.join(', ')}. ${
          expandCodes
            ? `Check the spelling, or supply ${EVERY_CODE_FORM}.`
            : 'Supply countryCodes or check the spelling.'
        }`,
      );
    }

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

    const coordinateAxisOrder = dialect.locationPointAxisOrder ?? 'spec';
    if (coordinateAxisOrder === 'swapped') {
      warnings.push(
        'The BrAPI Community Test Server dialect reads GeoJSON Points as [lat, lon, alt].',
      );
    }
    const bboxFilter = bbox
      ? (r: Record<string, unknown>) => insideBbox(r, bbox, coordinateAxisOrder)
      : undefined;
    // The country check runs first, so a row it drops never counts against the bbox.
    const rowFilter =
      countryCheck || bboxFilter
        ? (r: Record<string, unknown>) =>
            (countryCheck?.keep(r) ?? true) && (bboxFilter?.(r) ?? true)
        : undefined;

    const spillInput: Parameters<typeof maybeSpill<Record<string, unknown>>>[0] = {
      firstPage,
      client,
      connection,
      path: '/locations',
      filters,
      route,
      source: 'find_locations',
      renderInline: (rows, dataframe) =>
        renderLocationsRows({ results: rows as Output['results'], dataframe, coordinateAxisOrder }),
      loadLimit,
      ctx,
      bridge,
      warnings,
    };
    if (normalizeRow) spillInput.normalizeRow = normalizeRow;
    if (rowFilter) spillInput.rowFilter = rowFilter;
    const spill = await maybeSpill(spillInput);

    // fullRows is already post-check when a bbox or country check ran — the
    // dataframe and SQL surface see the same set, and results[] holds its
    // leading rows, not just the first upstream page's matches.
    const filteredFull = spill.fullRows;
    const filteredReturned = spill.results;

    // Counts describe the rows the scan examined; rows past an incomplete scan
    // were never checked against the bbox, so they are named apart.
    const { rowsScanned, scanComplete } = spill;
    const countryReport = countryCheck?.report();
    if (countryReport) warnings.push(...countryReport.warnings);
    const bboxScanned = rowsScanned - (countryReport?.dropped ?? 0);
    const upstreamTotal = firstPage.totalCount;
    const scope = scanComplete
      ? ''
      : ` scanned; ${upstreamTotal === undefined ? 'the rest were' : `the other ${upstreamTotal - rowsScanned} of ${upstreamTotal} were`} not checked`;
    if (bbox && bboxScanned > 0 && filteredFull.length === 0) {
      warnings.push(
        `bbox excluded all ${bboxScanned} upstream location(s)${scope}. Check or broaden the latitude/longitude bounds.`,
      );
    } else if (bbox && filteredFull.length < bboxScanned) {
      warnings.push(
        `bbox excluded ${bboxScanned - filteredFull.length} of ${bboxScanned} upstream location(s)${scope}.`,
      );
    }

    const distributions = {
      countryCode: computeDistribution(filteredFull, (r) => asString(r.countryCode)),
      locationType: computeDistribution(filteredFull, (r) => asString(r.locationType)),
    };

    const appliedFilters = appliedFindFilters(route);
    const sentCodes = appliedFilters.countryCodes ?? appliedFilters.countryCode;
    const requestedCountryCodes = (Array.isArray(sentCodes) ? sentCodes : [sentCodes]).filter(
      (code): code is string | number =>
        typeof code === 'number' || (typeof code === 'string' && code.length > 0),
    );
    const {
      countryCodes: _countryCodes,
      countryCode: _countryCode,
      ...otherExtraFilters
    } = input.extraFilters ?? {};
    checkFilterMatchRates(warnings, filteredFull.length, [
      {
        paramName: 'countryCodes',
        requestedValues: requestedCountryCodes,
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
      ...buildExtraFilterChecks(otherExtraFilters, filteredFull, warnings),
    ]);
    if (requestedCountryCodes.length > 0) {
      const known = Object.values(distributions.countryCode).reduce(
        (total, count) => total + count,
        0,
      );
      if (known < filteredFull.length) {
        warnings.push(
          `Could not verify the country filter for ${filteredFull.length - known} returned location(s) with no country code.`,
        );
      }
    }

    const totalCount =
      bbox || countryCheck ? filteredFull.length : (firstPage.totalCount ?? spill.rowsScanned);
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
    lines.push(renderLocationsRows(result));
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
  invalid: () => never,
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
    return invalid();
  }
  if (minLat > maxLat || minLon > maxLon) {
    return invalid();
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
 * Recovery for a name that did not resolve on an expanding dialect: explicit
 * countryCodes are sent as given, so alpha-3 alone misses sites stored under
 * the other forms.
 */
const EVERY_CODE_FORM =
  "the country's alpha-3, alpha-2, ISO numeric, and calling code as countryCodes (explicit codes are not expanded)";

interface ResolvedCountryCodes {
  /** Explicit codes (alphabetic ones uppercased), then each resolved name's codes, deduplicated. */
  codes: string[] | undefined;
  /** Each numeric code a resolved name expanded to → alpha-3 of every requested country sending it. */
  numericOwners: Map<string, Set<string>>;
}

/**
 * Resolve country names to the dialect's supported codes and union them with
 * explicit codes, keeping numeric strings and their leading zeros intact. On an
 * expanding dialect a name sends alpha-3, alpha-2, ISO numeric, and its E.164
 * calling code, and the warning labels each numeric code by its system.
 */
function resolveCountryCodes(
  countryCodes: string[] | undefined,
  countryNames: string[] | undefined,
  expandCodes: boolean,
  warnings: string[],
): ResolvedCountryCodes {
  const resolved: Array<{ input: string; codes: string[]; labels: string[] }> = [];
  const unresolved: string[] = [];
  const numericOwners = new Map<string, Set<string>>();
  for (const name of countryNames ?? []) {
    const country = resolveCountryName(name);
    if (!country) {
      unresolved.push(name);
    } else if (!expandCodes) {
      resolved.push({ input: name, codes: [country.alpha3], labels: [country.alpha3] });
    } else {
      const numeric = [
        { code: country.numeric, system: 'ISO numeric' },
        ...(country.callingCode ? [{ code: country.callingCode, system: 'calling code' }] : []),
      ];
      for (const { code } of numeric) {
        const owners = numericOwners.get(code) ?? new Set<string>();
        owners.add(country.alpha3);
        numericOwners.set(code, owners);
      }
      resolved.push({
        input: name,
        codes: [country.alpha3, country.alpha2, ...numeric.map((n) => n.code)],
        labels: [country.alpha3, country.alpha2, ...numeric.map((n) => `${n.code} (${n.system})`)],
      });
    }
  }
  if (resolved.length > 0) {
    warnings.push(
      `Resolved country name(s) to ${expandCodes ? 'ISO 3166-1 and E.164 calling codes' : 'ISO 3166-1 alpha-3'}: ${resolved
        .map((p) => `"${p.input}" → ${p.labels.join(', ')}`)
        .join('; ')}.`,
    );
  }
  if (unresolved.length > 0) {
    const names = unresolved.map((n) => `"${n}"`).join(', ');
    warnings.push(
      expandCodes
        ? `Could not resolve country name(s) to ISO 3166-1 codes: ${names}. Check the spelling, or pass ${EVERY_CODE_FORM}.`
        : `Could not resolve country name(s) to an ISO 3166-1 alpha-3 code: ${names}. Pass the alpha-3 code directly via countryCodes, or check the spelling.`,
    );
  }
  const resolvedCodes = resolved.flatMap((p) => p.codes);
  return {
    codes:
      !countryCodes && resolvedCodes.length === 0
        ? undefined
        : [
            ...new Set([
              ...(countryCodes ?? []).map((code) => code.toUpperCase()),
              ...resolvedCodes,
            ]),
          ],
    numericOwners,
  };
}

interface NumericCountryCheck {
  /** Row filter: false drops a row whose countryName names a country that did not send its code. */
  keep(row: Record<string, unknown>): boolean;
  /** Rows dropped so far, and one warning each for the dropped and the unverified rows. */
  report(): { dropped: number; warnings: string[] };
}

/**
 * Check rows matched only through a numeric code expanded from countryNames
 * against the row's own `countryName`: on SGN data a numeric code names no
 * single country (calling codes are shared, and many equal another country's
 * ISO numeric code). Keeps a row whose countryName resolves to a country that
 * sent the code, drops one naming another country, and keeps one whose
 * countryName is empty or unrecognized. Codes the caller passed explicitly are
 * never checked. Undefined when no expanded numeric code is left to check.
 */
function numericCountryCheck(
  numericOwners: ReadonlyMap<string, ReadonlySet<string>>,
  explicitCodes: ReadonlySet<string>,
): NumericCountryCheck | undefined {
  const checked = new Map([...numericOwners].filter(([code]) => !explicitCodes.has(code)));
  if (checked.size === 0) return;
  const dropped = new Map<string, Map<string, number>>();
  const unverified = new Map<string, number>();
  let droppedCount = 0;
  return {
    keep(row) {
      const code = asString(row.countryCode);
      const owners = code === undefined ? undefined : checked.get(code);
      if (code === undefined || owners === undefined) return true;
      const name = asString(row.countryName);
      const country = name === undefined ? undefined : resolveCountryName(name);
      if (!country) {
        unverified.set(code, (unverified.get(code) ?? 0) + 1);
        return true;
      }
      if (owners.has(country.alpha3)) return true;
      const named = dropped.get(code) ?? new Map<string, number>();
      named.set(country.name, (named.get(country.name) ?? 0) + 1);
      dropped.set(code, named);
      droppedCount++;
      return false;
    },
    report() {
      const warnings: string[] = [];
      if (droppedCount > 0) {
        const detail = [...dropped]
          .map(
            ([code, named]) =>
              `${code} → ${[...named].map(([country, n]) => `${country} (${n})`).join(', ')}`,
          )
          .join('; ');
        warnings.push(
          `Dropped ${droppedCount} location(s) matched only by a numeric code expanded from countryNames whose countryName names another country: ${detail}.`,
        );
      }
      if (unverified.size > 0) {
        const total = [...unverified.values()].reduce((sum, n) => sum + n, 0);
        const detail = [...unverified].map(([code, n]) => `${code} (${n})`).join(', ');
        warnings.push(
          `Kept ${total} location(s) matched only by a numeric code expanded from countryNames whose countryName is empty or unrecognized, so their country is unverified: ${detail}.`,
        );
      }
      return { dropped: droppedCount, warnings };
    },
  };
}

/** Render the exact row section used by both formatting and preview sizing. */
function renderLocationsRows(
  result: Pick<Output, 'results' | 'dataframe' | 'coordinateAxisOrder'>,
): string {
  const lines: string[] = [];
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
      const parts: string[] = [literal`**${loc.locationName ?? loc.locationDbId}**`];
      parts.push(literal`id=\`${loc.locationDbId}\``);
      if (loc.abbreviation) parts.push(literal`abbr=${loc.abbreviation}`);
      if (loc.locationType) parts.push(literal`type=${loc.locationType}`);
      if (loc.countryCode) parts.push(literal`country=${loc.countryCode}`);
      if (loc.countryName) parts.push(literal`countryName=${loc.countryName}`);
      const coords = extractCoordinates(loc, result.coordinateAxisOrder);
      if (coords) {
        parts.push(`lat=${coords.latitude}`);
        parts.push(`lon=${coords.longitude}`);
        if (coords.altitude != null) parts.push(`alt=${coords.altitude}`);
      } else if (loc.altitude != null) {
        parts.push(`alt=${loc.altitude}`);
      }
      if (loc.instituteName) parts.push(literal`institute=${loc.instituteName}`);
      if (loc.instituteAddress) parts.push(literal`addr=${loc.instituteAddress}`);
      if (loc.documentationURL) parts.push(literal`docs=${loc.documentationURL}`);
      parts.push(
        ...collectPassthroughParts(loc as Record<string, unknown>, RENDERED, result.dataframe),
      );
      lines.push(`- ${parts.join(' · ')}`);
    }
  }
  return lines.join('\n');
}
