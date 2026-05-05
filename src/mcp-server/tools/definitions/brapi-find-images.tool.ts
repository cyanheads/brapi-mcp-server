/**
 * @fileoverview `brapi_find_images` — filter images by observation unit,
 * study, observation, descriptive ontology, file name, or MIME type. Returns
 * metadata only; pull bytes via `brapi_get_image`. Materializes the full set
 * as a dataframe when the upstream total exceeds loadLimit.
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
import { DEFAULT_ALIAS, getServerRegistry } from '@/services/server-registry/index.js';
import {
  AliasInput,
  applyDialectFiltersOrFail,
  asString,
  buildRefinementHint,
  checkFilterMatchRates,
  collectPassthroughParts,
  computeDistribution,
  DataframeHandleSchema,
  ExtraFiltersInput,
  fkMatchCheck,
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

const ImageRowSchema = z
  .object({
    imageDbId: z.string().describe('Server-side identifier for the image.'),
    imageName: z.string().nullish().describe('Display name.'),
    imageFileName: z.string().nullish().describe('Original uploaded filename.'),
    imageFileSize: z.number().nullish().describe('File size in bytes.'),
    imageHeight: z.number().nullish().describe('Pixel height.'),
    imageWidth: z.number().nullish().describe('Pixel width.'),
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
  alias: z.string().describe('Alias of the registered BrAPI connection the call used.'),
  results: z
    .array(ImageRowSchema)
    .describe('Image metadata rows returned in-context (up to loadLimit).'),
  returnedCount: z.number().int().nonnegative().describe('Length of `results[]`.'),
  totalCount: z.number().int().nonnegative().describe('Total rows reported by the server.'),
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
    .describe('Advisory messages (filter overrides, partial data, capability gaps, etc.).'),
  appliedFilters: z
    .record(z.string(), z.unknown())
    .describe('The final filter map sent to the server (named + extraFilters).'),
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
    'Filter images by observation unit, observation, study, descriptive ontology term, file name, or MIME type. Returns metadata only — use brapi_get_image to fetch bytes inline. When the upstream total exceeds loadLimit, the full result set is materialized as a dataframe — query it with brapi_dataframe_query (SQL).',
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'all_filters_dropped',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The active dialect dropped every filter the agent supplied — the upstream server does not honor any of the requested scope filters on this endpoint, so the call would silently widen to the unfiltered baseline.',
      recovery:
        'Drop the unsupported filters and rescope by images, observationUnits, observations, studies, descriptiveOntologyTerms, imageFileNames, or mimeTypes — these filter paths are honored on the active dialect.',
    },
  ] as const,
  input: z.object({
    alias: AliasInput,
    images: z.array(z.string()).optional().describe('Filter by imageDbIds.'),
    observationUnits: z.array(z.string()).optional().describe('Filter by observationUnitDbIds.'),
    observations: z.array(z.string()).optional().describe('Filter by observationDbIds.'),
    studies: z.array(z.string()).optional().describe('Filter by studyDbIds.'),
    imageFileNames: z.array(z.string()).optional().describe('Filter by uploaded file name.'),
    mimeTypes: z
      .array(z.string())
      .optional()
      .describe('Filter by MIME type — e.g. "image/jpeg", "image/png".'),
    descriptiveOntologyTerms: z
      .array(z.string())
      .optional()
      .describe('Filter by ontology tags (e.g. "CO_334:plot").'),
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

    const filters = applyDialectFiltersOrFail(ctx, dialect, 'images', merged, warnings);
    const route = resolveFindRoute({
      profile,
      dialect,
      endpoint: 'images',
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
      path: '/images',
      filters,
      route,
      source: 'find_images',
      loadLimit,
      ctx,
      bridge,
    });

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
    ]);

    const totalCount = firstPage.totalCount ?? firstPage.rows.length;
    const refinementHint = buildRefinementHint(totalCount, loadLimit, distributions, {
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

    const result: Output = {
      alias: connection.alias,
      results: firstPage.rows as z.infer<typeof ImageRowSchema>[],
      returnedCount: firstPage.rows.length,
      totalCount,
      hasMore: firstPage.hasMore,
      distributions,
      warnings,
      appliedFilters: route.kind === 'search' ? route.searchBody : filters,
    };
    if (refinementHint) result.refinementHint = refinementHint;
    if (dataframe) result.dataframe = dataframe;
    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(
      renderFindHeader({
        noun: 'images',
        alias: result.alias,
        returnedCount: result.returnedCount,
        totalCount: result.totalCount,
        dataframe: result.dataframe,
      }),
    );
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
        const parts: string[] = [`**${img.imageName ?? img.imageFileName ?? img.imageDbId}**`];
        parts.push(`id=\`${img.imageDbId}\``);
        if (img.imageFileName) parts.push(`file=${img.imageFileName}`);
        if (img.mimeType) parts.push(`mime=${img.mimeType}`);
        if (img.imageWidth && img.imageHeight) {
          parts.push(`${img.imageWidth}×${img.imageHeight}`);
        }
        if (img.imageFileSize) parts.push(`size=${img.imageFileSize}B`);
        if (img.observationUnitName) parts.push(`unit=${img.observationUnitName}`);
        if (img.observationUnitDbId) parts.push(`unitDbId=${img.observationUnitDbId}`);
        if (img.observationDbIds?.length) parts.push(`obs=${img.observationDbIds.join(',')}`);
        if (img.studyName) parts.push(`study=${img.studyName}`);
        if (img.studyDbId) parts.push(`studyDbId=${img.studyDbId}`);
        if (img.descriptiveOntologyTerms?.length) {
          parts.push(`terms=${img.descriptiveOntologyTerms.join(',')}`);
        }
        if (img.imageTimeStamp) parts.push(`time=${img.imageTimeStamp}`);
        if (img.imageURL) parts.push(`url=${img.imageURL}`);
        if (img.copyright) parts.push(`©${img.copyright}`);
        if (img.description) parts.push(`desc=${img.description}`);
        parts.push(...collectPassthroughParts(img as Record<string, unknown>, RENDERED));
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
