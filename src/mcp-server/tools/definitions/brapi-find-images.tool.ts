/**
 * @fileoverview `brapi_find_images` — filter images by observation unit,
 * study, observation, descriptive ontology, file name, or MIME type. Returns
 * metadata only; pull bytes via `brapi_get_image`. Materializes the matched
 * set as a dataframe when results[] holds fewer rows than matched.
 *
 * @module mcp-server/tools/definitions/brapi-find-images.tool
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
  dialectRowMapper,
  discloseInlineTrim,
  ExtraFiltersInput,
  fkMatchCheck,
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

const ImageRowSchema = z
  .object({
    imageDbId: z.string().describe('Server-side identifier for the image.'),
    imageName: z.string().nullish().describe('Display name.'),
    imageFileName: z.string().nullish().describe('Original uploaded filename.'),
    imageFileSize: z.coerce
      .number()
      .nullish()
      .describe(
        'File size in bytes. Coerced from string when the upstream emits a numeric string.',
      ),
    imageHeight: z.coerce
      .number()
      .nullish()
      .describe('Pixel height. Coerced from string when the upstream emits a numeric string.'),
    imageWidth: z.coerce
      .number()
      .nullish()
      .describe('Pixel width. Coerced from string when the upstream emits a numeric string.'),
    mimeType: z.string().nullish().describe('MIME type (e.g. "image/jpeg").'),
    imageTimeStamp: z.string().nullish().describe('ISO 8601 capture timestamp.'),
    imageURL: z
      .string()
      .nullish()
      .describe('URL where the bytes live (may be relative to baseUrl or absolute).'),
    observationUnitDbId: z
      .string()
      .nullish()
      .describe('FK to the observation unit this image depicts.'),
    observationUnitName: z.string().nullish().describe('Display name of the observation unit.'),
    observationDbIds: z
      .array(z.string().describe('Observation identifier.'))
      .nullish()
      .describe('FKs to observations this image is evidence for.'),
    studyDbId: z.string().nullish().describe('FK to the study the image belongs to.'),
    studyName: z.string().nullish().describe('Display name of the study.'),
    descriptiveOntologyTerms: z
      .array(z.string().describe('Ontology term ID or label.'))
      .nullish()
      .describe('Descriptive ontology tags (e.g. "CO_334:plot").'),
    copyright: z.string().nullish().describe('Copyright or rights notice.'),
    description: z.string().nullish().describe('Free-text description.'),
  })
  .passthrough()
  .describe('One BrAPI image metadata record.');

const OutputSchema = z.object({
  alias: z.string().describe('Connection alias the call used.'),
  results: z
    .array(ImageRowSchema)
    .describe(
      'Leading matched image metadata rows, up to loadLimit and a 24,000-byte budget, whichever binds first.',
    ),
  hasMore: z.boolean().describe('True when more rows exist beyond the returned set.'),
  distributions: z
    .object({
      mimeType: z
        .record(z.string(), z.number())
        .describe('MIME type → count of images with that type.'),
      studyName: z
        .record(z.string(), z.number())
        .describe('Study name → count of images in that study.'),
      observationUnitName: z
        .record(z.string(), z.number())
        .describe('Observation unit name → count of images tied to that unit.'),
      descriptiveOntologyTerms: z
        .record(z.string(), z.number())
        .describe('Ontology term → count of images tagged with that term.'),
    })
    .describe('Value frequency per field across every matched row fetched.'),
  dataframe: DataframeHandleSchema.optional().describe(
    'The matched rows, staged as a dataframe when results[] holds fewer.',
  ),
});

type Output = z.infer<typeof OutputSchema>;

const SERVER_TO_USER: Record<string, string> = {
  // Plurals — BrAPI v2.1 spec.
  imageDbIds: 'images',
  observationUnitDbIds: 'observationUnits',
  observationDbIds: 'observations',
  studyDbIds: 'studies',
  imageFileNames: 'imageFileNames',
  mimeTypes: 'mimeTypes',
  descriptiveOntologyTerms: 'descriptiveOntologyTerms',
  // Singulars — SGN-family dialects.
  imageDbId: 'images',
  observationUnitDbId: 'observationUnits',
  observationDbId: 'observations',
  studyDbId: 'studies',
  imageFileName: 'imageFileNames',
  mimeType: 'mimeTypes',
  descriptiveOntologyTerm: 'descriptiveOntologyTerms',
};

export const brapiFindImages = tool('brapi_find_images', {
  description:
    'Filter images by observation unit, observation, study, descriptive ontology term, file name, or MIME type. Returns metadata only — use brapi_get_image to fetch bytes inline. results[] holds the leading matches up to loadLimit and a 24,000-byte budget; when it holds fewer rows than matched, the matched set is materialized as a dataframe — read it with brapi_dataframe_describe and brapi_dataframe_query (SQL).',
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'upstream_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'An uncaught BrAPI data request answered HTTP 404',
      recovery:
        'Check brapi_server_info for supported endpoints and verify the requested identifiers before retrying brapi_find_images.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'An uncaught BrAPI data request exhausted retries after HTTP 429',
      recovery:
        'Wait before retrying brapi_find_images; reduce concurrent requests to this BrAPI server.',
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
        'Run brapi_connect with this alias and a `baseUrl`, or pass an alias the brapi_connect description lists as built-in or operator-configured, before calling brapi_find_images.',
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
        'The BrAPI server is slow or unreachable right now. Retry brapi_find_images in a minute; if it keeps failing, the server may be down.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unauthorized',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'The BrAPI server answered HTTP 401: it requires credentials, or rejected the ones sent',
      recovery:
        'Run brapi_connect with credentials in `auth`, or ask the operator to set server-side credentials for this alias, then retry brapi_find_images.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The BrAPI server answered HTTP 403: the credentials sent, or their absence, lack access',
      recovery:
        'Run brapi_connect with credentials that have access, or ask the operator to set server-side credentials for this alias that do, then retry brapi_find_images.',
      thrownBy: 'service',
    },
    {
      reason: 'alias_base_url_invalid',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'The base URL configured on the server for this alias is not an absolute http(s) URL, or carries credentials',
      recovery:
        'Ask the operator to set the base URL configured for this alias to an absolute http(s) URL, then retry brapi_find_images.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'private_address_blocked',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The base URL configured for this alias, or its token URL, is on a private or reserved address this server may not reach',
      recovery:
        'Ask the operator to point this alias at a publicly routable host, or to allow private addresses on this server, then retry brapi_find_images.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'all_filters_dropped',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The active dialect dropped every filter the agent supplied — the upstream server does not honor any of the requested scope filters on this endpoint, so the call would silently widen to the unfiltered baseline.',
      recovery:
        'Drop the unsupported filters and rescope by images, observationUnits, observations, studies, descriptiveOntologyTerms, imageFileNames, or mimeTypes — these filter paths are honored on the active dialect.',
      thrownBy: 'service',
    },
  ] as const,
  input: z.object({
    alias: AliasInput,
    images: z.array(NonBlankString).optional().describe('Filter by imageDbIds.'),
    observationUnits: z
      .array(NonBlankString)
      .optional()
      .describe('Filter by observationUnitDbIds.'),
    observations: z.array(NonBlankString).optional().describe('Filter by observationDbIds.'),
    studies: z.array(NonBlankString).optional().describe('Filter by studyDbIds.'),
    imageFileNames: z.array(NonBlankString).optional().describe('Filter by uploaded file name.'),
    mimeTypes: z
      .array(NonBlankString)
      .optional()
      .describe('Filter by MIME type — e.g. "image/jpeg", "image/png".'),
    descriptiveOntologyTerms: z
      .array(NonBlankString)
      .optional()
      .describe('Filter by ontology tags (e.g. "CO_334:plot").'),
    loadLimit: LoadLimitInput,
    extraFilters: ExtraFiltersInput,
  }),
  inputAliases: {
    imageDbId: 'images',
    imageDbIds: 'images',
    studyDbId: 'studies',
    studyDbIds: 'studies',
    observationUnitDbId: 'observationUnits',
    observationUnitDbIds: 'observationUnits',
    observationDbId: 'observations',
    observationDbIds: 'observations',
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
        imageDbIds: input.images,
        observationUnitDbIds: input.observationUnits,
        observationDbIds: input.observations,
        studyDbIds: input.studies,
        imageFileNames: input.imageFileNames,
        mimeTypes: input.mimeTypes,
        descriptiveOntologyTerms: input.descriptiveOntologyTerms,
      },
      input.extraFilters,
      warnings,
    );

    const adapted = applyDialectFiltersOrFail(ctx, dialect, 'images', merged, warnings);
    const filters = adapted.filters;
    const route = resolveFindRoute({
      profile,
      dialect,
      endpoint: 'images',
      filters,
      searchBody: merged,
      warnings,
      ...(adapted.requiresEscalation ? { requiresEscalation: true } : {}),
    });

    const loadLimit = input.loadLimit ?? config.loadLimit;
    const normalizeRow = dialectRowMapper<Record<string, unknown>>(dialect, 'images');
    const firstPage = await loadInitialFindPage<Record<string, unknown>>(
      client,
      connection,
      route,
      loadLimit,
      ctx,
      normalizeRow ? { normalizeRow } : {},
    );

    const spill = await maybeSpill({
      firstPage,
      client,
      connection,
      path: '/images',
      filters,
      route,
      source: 'find_images',
      renderInline: (rows, dataframe) =>
        renderImagesRows({ results: rows as Output['results'], dataframe }),
      loadLimit,
      ctx,
      bridge,
      warnings,
      ...(normalizeRow ? { normalizeRow } : {}),
    });
    const { fullRows, dataframe, results, hasMore, rowsScanned } = spill;

    const distributions = {
      mimeType: computeDistribution(fullRows, (r) => asString(r.mimeType)),
      studyName: computeDistribution(fullRows, (r) => asString(r.studyName)),
      observationUnitName: computeDistribution(fullRows, (r) => asString(r.observationUnitName)),
      descriptiveOntologyTerms: computeDistribution(fullRows, (r) => {
        const terms = r.descriptiveOntologyTerms;
        if (!Array.isArray(terms)) return;
        return terms.filter((t): t is string => typeof t === 'string' && t.length > 0);
      }),
    };

    checkFilterMatchRates(warnings, fullRows.length, [
      {
        paramName: 'mimeTypes',
        requestedValues: input.mimeTypes,
        distribution: distributions.mimeType,
        caseInsensitive: true,
      },
      {
        paramName: 'descriptiveOntologyTerms',
        requestedValues: input.descriptiveOntologyTerms,
        distribution: distributions.descriptiveOntologyTerms,
      },
      fkMatchCheck('studies', input.studies, fullRows, 'studyDbId'),
      fkMatchCheck('observationUnits', input.observationUnits, fullRows, 'observationUnitDbId'),
      ...buildExtraFilterChecks(input.extraFilters, fullRows, warnings),
    ]);

    const totalCount = firstPage.totalCount ?? rowsScanned;
    const refinementHint = buildRefinementHint(spill, distributions, {
      availableFilters: [
        'images',
        'observationUnits',
        'observations',
        'studies',
        'imageFileNames',
        'mimeTypes',
        'descriptiveOntologyTerms',
      ],
    });

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
          : 'No images matched the applied filters. Try broadening observationUnits, studies, mimeTypes, or descriptiveOntologyTerms.',
      );
    discloseInlineTrim(ctx, spill, loadLimit);

    const result: Output = {
      alias: connection.alias,
      results: results as z.infer<typeof ImageRowSchema>[],
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
        noun: 'images',
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
    lines.push(renderImagesRows(result));
    if (result.dataframe) {
      lines.push('');
      lines.push('## Dataframe handle');
      lines.push(...renderDataframeHandle(result.dataframe));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/** Render the exact row section used by both formatting and preview sizing. */
function renderImagesRows(result: Pick<Output, 'results' | 'dataframe'>): string {
  const lines: string[] = [];
  lines.push('## Images');
  if (result.results.length === 0) {
    lines.push('_No rows returned._');
  } else {
    const RENDERED = new Set([
      'imageName',
      'imageFileName',
      'imageDbId',
      'mimeType',
      'imageWidth',
      'imageHeight',
      'imageFileSize',
      'observationUnitName',
      'observationUnitDbId',
      'observationDbIds',
      'studyName',
      'studyDbId',
      'descriptiveOntologyTerms',
      'imageTimeStamp',
      'imageURL',
      'copyright',
      'description',
    ]);
    for (const img of result.results) {
      const parts: string[] = [literal`**${img.imageName ?? img.imageFileName ?? img.imageDbId}**`];
      parts.push(literal`id=\`${img.imageDbId}\``);
      if (img.imageFileName) parts.push(literal`file=${img.imageFileName}`);
      if (img.mimeType) parts.push(literal`mime=${img.mimeType}`);
      if (img.imageWidth && img.imageHeight) {
        parts.push(`${img.imageWidth}×${img.imageHeight}`);
      }
      if (img.imageFileSize) parts.push(`size=${img.imageFileSize}B`);
      if (img.observationUnitName) parts.push(literal`unit=${img.observationUnitName}`);
      if (img.observationUnitDbId) parts.push(literal`unitDbId=${img.observationUnitDbId}`);
      if (img.observationDbIds?.length) parts.push(literal`obs=${img.observationDbIds.join(',')}`);
      if (img.studyName) parts.push(literal`study=${img.studyName}`);
      if (img.studyDbId) parts.push(literal`studyDbId=${img.studyDbId}`);
      if (img.descriptiveOntologyTerms?.length) {
        parts.push(literal`terms=${img.descriptiveOntologyTerms.join(',')}`);
      }
      if (img.imageTimeStamp) parts.push(literal`time=${img.imageTimeStamp}`);
      if (img.imageURL) parts.push(literal`url=${img.imageURL}`);
      if (img.copyright) parts.push(literal`©${img.copyright}`);
      if (img.description) parts.push(literal`desc=${img.description}`);
      parts.push(
        ...collectPassthroughParts(img as Record<string, unknown>, RENDERED, result.dataframe),
      );
      lines.push(`- ${parts.join(' · ')}`);
    }
  }
  return lines.join('\n');
}
