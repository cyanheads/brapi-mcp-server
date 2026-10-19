/**
 * @fileoverview `brapi_find_germplasm` — search germplasm by name, synonym,
 * accession, attribute, or free text. Matches BrAPI's registered-synonym
 * semantics. Returns distributions for crop / genus / species / collection
 * and spills to a dataframe when results[] holds fewer rows than matched.
 *
 * @module mcp-server/tools/definitions/brapi-find-germplasm.tool
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
  checkFilterMatchRates,
  collectPassthroughParts,
  computeDistribution,
  DataframeHandleSchema,
  dedupSynonymsByIdentity,
  dialectRowMapper,
  discloseInlineTrim,
  ExtraFiltersInput,
  FreeTextInput,
  InlineTrimEnrichment,
  LoadLimitInput,
  loadInitialFindPage,
  type MaybeSpillInput,
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
  spillWalkCeiling,
} from '../shared/find-helpers.js';
import { literal } from '../shared/markdown-literals.js';

const GermplasmRowSchema = z
  .object({
    germplasmDbId: z.string().describe('Server-side identifier for the germplasm.'),
    germplasmName: z.string().nullish().describe('Display name.'),
    germplasmPUI: z.string().nullish().describe('Persistent unique identifier (URI).'),
    commonCropName: z.string().nullish().describe('Common crop name (e.g. "Maize", "Wheat").'),
    accessionNumber: z.string().nullish().describe('Gene-bank catalog number.'),
    genus: z.string().nullish().describe('Botanical genus.'),
    species: z.string().nullish().describe('Botanical species.'),
    subtaxa: z.string().nullish().describe('Botanical subtaxa (subspecies, variety, etc.).'),
    defaultDisplayName: z.string().nullish().describe('Preferred display label.'),
    pedigree: z.string().nullish().describe('Pedigree as a free-text string (e.g. "A/B//C").'),
    biologicalStatusOfAccessionDescription: z
      .string()
      .nullish()
      .describe('MCPD biological-status label (wild / landrace / breeding / cultivar, etc.).'),
    germplasmOrigin: z
      .array(
        z
          .object({})
          .passthrough()
          .describe('One origin record (collection coordinates and uncertainty per BrAPI v2).'),
      )
      .nullish()
      .describe('Origin records — array of collection-site objects per BrAPI v2.'),
    countryOfOriginCode: z.string().nullish().describe('ISO 3166-1 alpha-3 country code.'),
    collection: z.string().nullish().describe('Collection name this accession belongs to.'),
    instituteCode: z
      .string()
      .nullish()
      .describe('FAO WIEWS institute code of the holding institute.'),
    instituteName: z.string().nullish().describe('Display name of the holding institute.'),
    synonyms: z
      .array(
        z
          .object({
            synonym: z.string().nullish().describe('Synonym value.'),
            type: z.string().nullish().describe('Synonym type (e.g. "COMMON", "SYNONYM").'),
          })
          .passthrough()
          .describe('Registered synonym for this germplasm.'),
      )
      .nullish()
      .describe('All registered synonyms (alternative names).'),
  })
  .passthrough()
  .describe('One BrAPI germplasm record.');

const OutputSchema = z.object({
  alias: z.string().describe('Connection alias the call used.'),
  results: z
    .array(GermplasmRowSchema)
    .describe(
      'Leading matched germplasm rows, up to loadLimit and a 24,000-byte budget, whichever binds first.',
    ),
  hasMore: z.boolean().describe('True when more rows exist beyond the returned set.'),
  distributions: z
    .object({
      commonCropName: z
        .record(z.string(), z.number())
        .describe('Common crop name → count of rows for that crop.'),
      genus: z.record(z.string(), z.number()).describe('Genus → count of rows with that genus.'),
      species: z
        .record(z.string(), z.number())
        .describe('Species → count of rows with that species.'),
      collection: z
        .record(z.string(), z.number())
        .describe('Collection name → count of rows in that collection.'),
      countryOfOriginCode: z
        .record(z.string(), z.number())
        .describe('ISO country code → count of rows from that country.'),
    })
    .describe('Value frequency per field across every matched row fetched.'),
  dataframe: DataframeHandleSchema.optional().describe(
    'The matched rows, staged as a dataframe when results[] holds fewer.',
  ),
});

type Output = z.infer<typeof OutputSchema>;

const SERVER_TO_USER: Record<string, string> = {
  // Plurals — BrAPI v2.1 spec, used by the `spec` dialect.
  germplasmNames: 'names',
  germplasmDbIds: 'germplasmDbIds',
  germplasmPUIs: 'germplasmPUIs',
  accessionNumbers: 'accessionNumbers',
  commonCropNames: 'crops',
  synonyms: 'synonyms',
  collections: 'collections',
  // Singulars — emitted by SGN-family dialects (cassavabase, etc.).
  germplasmName: 'names',
  germplasmDbId: 'germplasmDbIds',
  germplasmPUI: 'germplasmPUIs',
  accessionNumber: 'accessionNumbers',
  commonCropName: 'crops',
  synonym: 'synonyms',
  collection: 'collections',
  // Scalars — same on the wire either way.
  genus: 'genus',
  species: 'species',
};

export const brapiFindGermplasm = tool('brapi_find_germplasm', {
  description:
    'Find germplasm by name, synonym, accession number, PUI, crop, or free-text query. Matches across registered synonyms. results[] holds the leading matches up to loadLimit and a 24,000-byte budget; when it holds fewer rows than matched, the matched set is materialized as a dataframe — read it with brapi_dataframe_describe and brapi_dataframe_query (SQL) instead of paging row-by-row.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'upstream_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'An uncaught BrAPI data request answered HTTP 404',
      recovery:
        'Check brapi_server_info for supported endpoints and verify the requested identifiers before retrying brapi_find_germplasm.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'An uncaught BrAPI data request exhausted retries after HTTP 429',
      recovery:
        'Wait before retrying brapi_find_germplasm; reduce concurrent requests to this BrAPI server.',
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
      reason: 'unknown_alias',
      code: JsonRpcErrorCode.NotFound,
      when: 'No connection is registered under the requested alias, and the server has no base URL configured for it to connect on first use',
      recovery:
        'Run brapi_connect with this alias and a `baseUrl`, or pass an alias the brapi_connect description lists as built-in or operator-configured, before calling brapi_find_germplasm.',
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
        'The BrAPI server is slow or unreachable right now. Retry brapi_find_germplasm in a minute; if it keeps failing, the server may be down.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unauthorized',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'The BrAPI server answered HTTP 401: it requires credentials, or rejected the ones sent',
      recovery:
        'Run brapi_connect with credentials in `auth`, or ask the operator to set server-side credentials for this alias, then retry brapi_find_germplasm.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The BrAPI server answered HTTP 403: the credentials sent, or their absence, lack access',
      recovery:
        'Run brapi_connect with credentials that have access, or ask the operator to set server-side credentials for this alias that do, then retry brapi_find_germplasm.',
      thrownBy: 'service',
    },
    {
      reason: 'alias_base_url_invalid',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'The base URL configured on the server for this alias is not an absolute http(s) URL, or carries credentials',
      recovery:
        'Ask the operator to set the base URL configured for this alias to an absolute http(s) URL, then retry brapi_find_germplasm.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'private_address_blocked',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The base URL configured for this alias, or its token URL, is on a private or reserved address this server may not reach',
      recovery:
        'Ask the operator to point this alias at a publicly routable host, or to allow private addresses on this server, then retry brapi_find_germplasm.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'all_filters_dropped',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The active dialect dropped every filter the agent supplied — the upstream server does not honor any of the requested scope filters on this endpoint, so the call would silently widen to the unfiltered baseline.',
      recovery:
        'Drop the unsupported filters and rescope by names, germplasmDbIds, germplasmPUIs, accessionNumbers, crops, synonyms, genus, or species — these filter paths are honored on the active dialect.',
      thrownBy: 'service',
    },
  ] as const,
  input: z.object({
    alias: AliasInput,
    names: z.array(NonBlankString).optional().describe('Filter by germplasm display names.'),
    germplasmDbIds: z.array(NonBlankString).optional().describe('Filter by DbIds.'),
    germplasmPUIs: z.array(NonBlankString).optional().describe('Persistent unique identifiers.'),
    accessionNumbers: z
      .array(NonBlankString)
      .optional()
      .describe('Filter by accession numbers (gene-bank catalog codes).'),
    crops: z.array(NonBlankString).optional().describe('Filter by common crop names.'),
    synonyms: z.array(NonBlankString).optional().describe('Match registered synonyms.'),
    collections: z
      .array(NonBlankString)
      .optional()
      .describe('Filter by germplasm collection names.'),
    genus: NonBlankString.optional().describe('Botanical genus.'),
    species: NonBlankString.optional().describe('Botanical species.'),
    text: FreeTextInput.optional().describe(
      'Free-text query. Applied client-side as a case-insensitive substring match on germplasmName, germplasmPUI, accessionNumber, defaultDisplayName, and registered synonyms — no BrAPI server reliably supports a server-side free-text filter. Every upstream row is scanned when the filtered set fits one dataframe walk; above that, a miss on the first page stops the scan, and the warnings report how many rows were checked. Combine with `crops` / `genus` / etc. to narrow the upstream pull first.',
    ),
    loadLimit: LoadLimitInput,
    extraFilters: ExtraFiltersInput,
  }),
  inputAliases: {
    germplasmDbId: 'germplasmDbIds',
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
      .describe('Total rows reported by the server, else the rows scanned.'),
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
      .describe('Advisory messages (filter overrides, partial data, capability gaps).'),
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
    const merged = mergeFilters(
      {
        germplasmNames: input.names,
        germplasmDbIds: input.germplasmDbIds,
        germplasmPUIs: input.germplasmPUIs,
        accessionNumbers: input.accessionNumbers,
        commonCropNames: input.crops,
        synonyms: input.synonyms,
        collections: input.collections,
        genus: input.genus,
        species: input.species,
      },
      input.extraFilters,
      warnings,
    );

    const adapted = applyDialectFiltersOrFail(ctx, dialect, 'germplasm', merged, warnings);
    const filters = adapted.filters;
    const route = resolveFindRoute({
      profile,
      dialect,
      endpoint: 'germplasm',
      filters,
      searchBody: merged,
      warnings,
      ...(adapted.requiresEscalation ? { requiresEscalation: true } : {}),
    });

    const loadLimit = input.loadLimit ?? config.loadLimit;
    const normalizeRow = dialectRowMapper<Record<string, unknown>>(dialect, 'germplasm');
    const firstPage = await loadInitialFindPage<Record<string, unknown>>(
      client,
      connection,
      route,
      loadLimit,
      ctx,
      {
        ...(normalizeRow ? { normalizeRow } : {}),
        ...(input.text ? { pageSize: config.pageSize } : {}),
      },
    );

    // Free-text matching is client-side. No BrAPI server reliably honors a
    // free-text query parameter on /germplasm — earlier versions of this tool
    // sent `searchText`, which CassavaBase and the Test Server both silently
    // ignore. Names cluster by naming scheme and arrive in DbId order, so a
    // first-page miss says little about the rest: when the upstream set fits
    // one spill walk, scan all of it (only matches are persisted). Above the
    // walk ceiling a full scan is impossible anyway, so a first-page miss
    // stops at the first page instead of walking 50 pages of a partial scan.
    // An upstream reporting no total is walked: its size is unknown.
    const text = input.text;
    const scanCeiling = spillWalkCeiling();
    const skipSpillForTextMiss = Boolean(
      text &&
        firstPage.hasMore &&
        (firstPage.totalCount ?? 0) > scanCeiling &&
        firstPage.rows.length > 0 &&
        !firstPage.rows.some((row) => rowMatchesText(row, text)),
    );

    const spillInput: MaybeSpillInput<Record<string, unknown>> = {
      firstPage: skipSpillForTextMiss
        ? // Scan the first page only — no further pages pulled; the total keeps hasMore honest.
          { ...firstPage, hasMore: false }
        : firstPage,
      client,
      connection,
      path: '/germplasm',
      filters,
      route,
      source: 'find_germplasm',
      renderInline: (rows, dataframe) =>
        renderGermplasmRows({ results: rows as Output['results'], dataframe }),
      loadLimit,
      ctx,
      bridge,
      warnings,
      // CassavaBase repeats every synonym entry 11× per record. Dedup at the
      // spillover layer so the in-context view and the dataframe see
      // the cleaned shape consistently.
      rowMapper: dedupSynonymsByIdentity,
    };
    if (normalizeRow) spillInput.normalizeRow = normalizeRow;
    if (text) spillInput.rowFilter = (row) => rowMatchesText(row, text);

    const spill = await maybeSpill(spillInput);
    const { fullRows, dataframe, rowsScanned, scanComplete, results, hasMore } = spill;

    const distributions = {
      commonCropName: computeDistribution(fullRows, (r) => asString(r.commonCropName)),
      genus: computeDistribution(fullRows, (r) => asString(r.genus)),
      species: computeDistribution(fullRows, (r) => asString(r.species)),
      collection: computeDistribution(fullRows, (r) => asString(r.collection)),
      countryOfOriginCode: computeDistribution(fullRows, (r) => asString(r.countryOfOriginCode)),
    };

    checkFilterMatchRates(warnings, fullRows.length, [
      {
        paramName: 'crops',
        requestedValues: input.crops,
        distribution: distributions.commonCropName,
        caseInsensitive: true,
      },
      {
        paramName: 'genus',
        requestedValues: input.genus !== undefined ? [input.genus] : undefined,
        distribution: distributions.genus,
        caseInsensitive: true,
      },
      {
        paramName: 'species',
        requestedValues: input.species !== undefined ? [input.species] : undefined,
        distribution: distributions.species,
        caseInsensitive: true,
      },
      {
        paramName: 'collections',
        requestedValues: input.collections,
        distribution: distributions.collection,
        caseInsensitive: true,
      },
      ...buildExtraFilterChecks(input.extraFilters, fullRows, warnings),
    ]);

    const totalCount = firstPage.totalCount ?? rowsScanned;
    const refinementHint = buildRefinementHint(spill, distributions, {
      availableFilters: [
        'names',
        'germplasmDbIds',
        'germplasmPUIs',
        'accessionNumbers',
        'crops',
        'synonyms',
        'collections',
        'genus',
        'species',
        'text',
      ],
    });

    if (text && rowsScanned > 0) {
      warnings.push(
        textScanWarning(text, fullRows.length, rowsScanned, {
          upstreamTotal: firstPage.totalCount,
          scanComplete,
          scanCeiling,
        }),
      );
    }

    const appliedFilters = route.kind === 'search' ? route.searchBody : filters;
    ctx.enrich({
      totalCount,
      returnedCount: results.length,
      appliedFilters,
      warnings,
      ...(refinementHint ? { refinementHint } : {}),
    });
    if (results.length === 0)
      ctx.enrich.notice(
        warnings.length > 0
          ? 'No rows returned. Check the warnings above for filter issues, or broaden your filters.'
          : 'No germplasm matched the applied filters. Try broadening names, crops, genus, species, or collections.',
      );
    discloseInlineTrim(ctx, spill, loadLimit);

    const result: Output = {
      alias: connection.alias,
      results: results as z.infer<typeof GermplasmRowSchema>[],
      hasMore,
      distributions,
    };
    if (dataframe) result.dataframe = dataframe;
    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(
      renderFindHeader({
        noun: 'germplasm',
        alias: result.alias,
        returnedCount: result.results.length,
        dataframe: result.dataframe,
      }),
    );
    lines.push('');
    const moreRows = renderMoreRowsLine(result);
    if (moreRows) lines.push(moreRows, '');
    lines.push('## Distributions');
    lines.push(
      renderDistributions(result.distributions, result.dataframe) || '_No values to summarize._',
    );
    lines.push('');
    lines.push(renderGermplasmRows(result));
    if (result.dataframe) {
      lines.push('');
      lines.push('## Dataframe handle');
      lines.push(...renderDataframeHandle(result.dataframe));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/**
 * Describe what a free-text scan examined: the full upstream set, or the first
 * N rows of it. Reports rows scanned, never the inline page size, so a miss
 * reads as "not found in these rows" rather than "not found".
 */
function textScanWarning(
  text: string,
  matched: number,
  scanned: number,
  scan: { scanCeiling: number; scanComplete: boolean; upstreamTotal: number | undefined },
): string {
  const { scanCeiling, upstreamTotal } = scan;
  const fullScan = scan.scanComplete;
  const parts = [
    fullScan
      ? `Free-text '${text}' matched ${matched} of ${scanned} row(s) scanned (the full upstream set).`
      : upstreamTotal === undefined
        ? `Free-text '${text}' matched ${matched} of the first ${scanned} row(s) scanned; the upstream reported no total, and rows past them were not scanned.`
        : `Free-text '${text}' matched ${matched} of the first ${scanned} row(s) scanned out of ${upstreamTotal} upstream; the remaining rows were not scanned.`,
  ];
  if (!fullScan && (upstreamTotal === undefined || upstreamTotal > scanCeiling)) {
    parts.push(
      `Narrow with server-side filters (crops, genus, species, collections) to bring the set under the ${scanCeiling}-row scan ceiling.`,
    );
  }
  if (matched === 0) {
    parts.push(
      `For an exact name, accession number, or DbId, use names, accessionNumbers, or germplasmDbIds${fullScan ? '; otherwise check spelling' : ''}.`,
    );
  }
  return parts.join(' ');
}

function rowMatchesText(row: Record<string, unknown>, text: string): boolean {
  const needle = text.toLowerCase();
  const containsNeedle = (value: unknown): boolean =>
    typeof value === 'string' && value.toLowerCase().includes(needle);
  if (
    containsNeedle(row.germplasmName) ||
    containsNeedle(row.germplasmPUI) ||
    containsNeedle(row.accessionNumber) ||
    containsNeedle(row.defaultDisplayName)
  ) {
    return true;
  }
  if (Array.isArray(row.synonyms)) {
    for (const entry of row.synonyms) {
      if (
        entry &&
        typeof entry === 'object' &&
        containsNeedle((entry as Record<string, unknown>).synonym)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Render the exact row section used by both formatting and preview sizing. */
function renderGermplasmRows(result: Pick<Output, 'results' | 'dataframe'>): string {
  const lines: string[] = [];
  lines.push('## Germplasm');
  if (result.results.length === 0) {
    lines.push('_No rows returned._');
  } else {
    const RENDERED = new Set([
      'germplasmName',
      'defaultDisplayName',
      'germplasmDbId',
      'germplasmPUI',
      'accessionNumber',
      'commonCropName',
      'genus',
      'species',
      'subtaxa',
      'countryOfOriginCode',
      'collection',
      'instituteCode',
      'instituteName',
      'germplasmOrigin',
      'biologicalStatusOfAccessionDescription',
      'pedigree',
      'synonyms',
    ]);
    for (const g of result.results) {
      const parts: string[] = [
        literal`**${g.germplasmName ?? g.defaultDisplayName ?? g.germplasmDbId}**`,
      ];
      parts.push(literal`id=\`${g.germplasmDbId}\``);
      if (g.germplasmPUI) parts.push(literal`pui=${g.germplasmPUI}`);
      if (g.accessionNumber) parts.push(literal`accession=${g.accessionNumber}`);
      if (g.commonCropName) parts.push(literal`crop=${g.commonCropName}`);
      if (g.genus) parts.push(literal`genus=${g.genus}`);
      if (g.species) parts.push(literal`species=${g.species}`);
      if (g.subtaxa) parts.push(literal`subtaxa=${g.subtaxa}`);
      if (g.countryOfOriginCode) parts.push(literal`country=${g.countryOfOriginCode}`);
      if (g.collection) parts.push(literal`collection=${g.collection}`);
      if (g.instituteCode) parts.push(literal`institute=${g.instituteCode}`);
      if (g.instituteName) parts.push(literal`instituteName=${g.instituteName}`);
      if (g.germplasmOrigin?.length)
        parts.push(literal`germplasmOrigin=${JSON.stringify(g.germplasmOrigin)}`);
      if (g.biologicalStatusOfAccessionDescription)
        parts.push(literal`status=${g.biologicalStatusOfAccessionDescription}`);
      if (g.pedigree) parts.push(literal`pedigree=${g.pedigree}`);
      if (g.defaultDisplayName) parts.push(literal`displayName=${g.defaultDisplayName}`);
      if (g.synonyms?.length) {
        const synStr = g.synonyms
          .map((s) => `${s.synonym ?? '?'}${s.type ? ` (${s.type})` : ''}`)
          .join(',');
        parts.push(literal`synonyms=${synStr}`);
      }
      parts.push(
        ...collectPassthroughParts(g as Record<string, unknown>, RENDERED, result.dataframe),
      );
      lines.push(`- ${parts.join(' · ')}`);
    }
  }
  return lines.join('\n');
}
