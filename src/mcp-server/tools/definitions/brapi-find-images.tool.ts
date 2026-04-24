/**
 * @fileoverview `brapi_find_images` — filter images by observation unit,
 * study, observation, descriptive ontology, file name, or MIME type. Returns
 * metadata only; pull bytes via `brapi_get_image`. Spills the full set to
 * DatasetStore when the upstream total exceeds loadLimit.
 *
 * @module mcp-server/tools/definitions/brapi-find-images.tool
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

const ImageRowSchema = z
  .object({
    imageDbId: z.string().describe('Server-side identifier for the image.'),
    imageName: z.string().optional().describe('Display name.'),
    imageFileName: z.string().optional().describe('Original uploaded filename.'),
    imageFileSize: z.number().optional().describe('File size in bytes.'),
    imageHeight: z.number().optional().describe('Pixel height.'),
    imageWidth: z.number().optional().describe('Pixel width.'),
    mimeType: z.string().optional().describe('MIME type (e.g. "image/jpeg").'),
    imageTimeStamp: z.string().optional().describe('ISO 8601 capture timestamp.'),
    imageURL: z
      .string()
      .optional()
      .describe('URL where the bytes live (may be relative to baseUrl or absolute).'),
    observationUnitDbId: z
      .string()
      .optional()
      .describe('FK to the observation unit this image depicts.'),
    observationUnitName: z.string().optional().describe('Display name of the observation unit.'),
    observationDbIds: z
      .array(z.string().describe('Observation identifier.'))
      .optional()
      .describe('FKs to observations this image is evidence for.'),
    studyDbId: z.string().optional().describe('FK to the study the image belongs to.'),
    studyName: z.string().optional().describe('Display name of the study.'),
    descriptiveOntologyTerms: z
      .array(z.string().describe('Ontology term ID or label.'))
      .optional()
      .describe('Descriptive ontology tags (e.g. "CO_334:plot").'),
    copyright: z.string().optional().describe('Copyright or rights notice.'),
    description: z.string().optional().describe('Free-text description.'),
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
  dataset: DatasetHandleSchema.optional().describe(
    'Dataset handle when the full result set was persisted to DatasetStore.',
  ),
  warnings: z
    .array(z.string())
    .describe('Advisory messages (filter overrides, partial data, capability gaps, etc.).'),
  appliedFilters: z
    .record(z.string(), z.unknown())
    .describe('The final filter map sent to the server (named + extraFilters).'),
});

type Output = z.infer<typeof OutputSchema>;

export const brapiFindImages = tool('brapi_find_images', {
  description:
    'Filter images by observation unit, observation, study, descriptive ontology term, file name, or MIME type. Returns metadata only — use brapi_get_image to fetch bytes inline. Returns a dataset handle when the upstream total exceeds loadLimit.',
  annotations: { readOnlyHint: true, openWorldHint: true },
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
    const datasetStore = getDatasetStore();
    const config = getServerConfig();

    const connection = await registry.get(ctx, input.alias ?? DEFAULT_ALIAS);

    const capabilityLookup: { auth?: typeof connection.resolvedAuth } = {};
    if (connection.resolvedAuth) capabilityLookup.auth = connection.resolvedAuth;
    await capabilities.ensure(
      connection.baseUrl,
      { service: 'images', method: 'GET' },
      ctx,
      capabilityLookup,
    );

    const warnings: string[] = [];
    const filters = mergeFilters(
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

    const loadLimit = input.loadLimit ?? config.loadLimit;
    const firstPage = await loadInitialPage<Record<string, unknown>>(
      client,
      connection,
      '/images',
      filters,
      loadLimit,
      ctx,
    );

    const { fullRows, dataset: datasetMeta } = await maybeSpill({
      firstPage,
      client,
      connection,
      path: '/images',
      filters,
      source: 'find_images',
      loadLimit,
      ctx,
      store: datasetStore,
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

    const totalCount = firstPage.totalCount ?? firstPage.rows.length;
    const refinementHint = buildRefinementHint(totalCount, loadLimit, distributions);

    const result: Output = {
      alias: connection.alias,
      results: firstPage.rows as z.infer<typeof ImageRowSchema>[],
      returnedCount: firstPage.rows.length,
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
    lines.push(`# ${result.returnedCount} of ${result.totalCount} images — \`${result.alias}\``);
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
    lines.push('## Images');
    if (result.results.length === 0) {
      lines.push('_No rows returned._');
    } else {
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
