/**
 * @fileoverview `brapi_find_variables` — find observation variables (traits)
 * by name, trait class, ontology term, or free-text query. When `text` is
 * supplied, results are re-ranked client-side via OntologyResolver; when
 * the server exposes ontology metadata, matches can resolve to ontology
 * URIs. Otherwise falls back to pure substring ordering.
 *
 * @module mcp-server/tools/definitions/brapi-find-variables.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';
import { getBrapiClient } from '@/services/brapi-client/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import { getDatasetStore } from '@/services/dataset-store/index.js';
import {
  getOntologyResolver,
  type OntologyCandidate,
  type VariableLike,
} from '@/services/ontology-resolver/index.js';
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
  renderDatasetHandle,
  renderDistributions,
} from '../shared/find-helpers.js';

const VariableRowSchema = z
  .object({
    observationVariableDbId: z
      .string()
      .describe('Server-side identifier for the observation variable.'),
    observationVariableName: z.string().nullish().describe('Display name.'),
    observationVariablePUI: z
      .string()
      .nullish()
      .describe('Persistent unique identifier — typically an ontology term URI.'),
    ontologyDbId: z.string().nullish().describe('FK to the owning ontology.'),
    ontologyName: z.string().nullish().describe('Display name of the owning ontology.'),
    commonCropName: z.string().nullish().describe('Common crop name this variable is scoped to.'),
    trait: z
      .object({
        traitDbId: z.string().nullish().describe('FK to the trait.'),
        traitName: z.string().nullish().describe('Display name of the trait.'),
        traitClass: z
          .string()
          .nullish()
          .describe('High-level trait grouping (e.g. "agronomic", "morphological").'),
        description: z.string().nullish().describe('Free-text trait description.'),
        synonyms: z
          .array(z.string().describe('Trait synonym value.'))
          .nullish()
          .describe('Registered trait synonyms.'),
      })
      .passthrough()
      .nullish()
      .describe('The biological trait this variable measures.'),
    scale: z
      .object({
        scaleDbId: z.string().nullish().describe('FK to the scale.'),
        scaleName: z.string().nullish().describe('Display name of the scale.'),
        dataType: z
          .string()
          .nullish()
          .describe('Scale data type (e.g. "Numerical", "Categorical", "Date", "Text").'),
      })
      .passthrough()
      .nullish()
      .describe('Scale used to record this variable (units / type / range).'),
    method: z
      .object({
        methodDbId: z.string().nullish().describe('FK to the method.'),
        methodName: z.string().nullish().describe('Display name of the method.'),
      })
      .passthrough()
      .nullish()
      .describe('Measurement method or protocol used to collect this variable.'),
  })
  .passthrough()
  .describe('One BrAPI observation variable record.');

const CandidateSchema = z
  .object({
    termId: z
      .string()
      .optional()
      .describe('Ontology term ID / PUI when available (e.g. "CO_334:0000013").'),
    name: z.string().optional().describe('Display name of the candidate.'),
    description: z.string().optional().describe('Trait description, when available.'),
    synonyms: z
      .array(z.string().describe('Registered synonym.'))
      .optional()
      .describe('Combined variable + trait synonyms.'),
    ontologyDbId: z.string().optional().describe('Owning ontology ID.'),
    source: z
      .enum(['puiMatch', 'nameMatch', 'synonymMatch', 'traitClassMatch'])
      .describe('How the candidate was ranked — PUI exact / name / synonym / trait-class.'),
  })
  .describe('One ranked ontology candidate from a free-text query.');

const OutputSchema = z.object({
  alias: z.string().describe('Alias of the registered BrAPI connection the call used.'),
  results: z
    .array(VariableRowSchema)
    .describe(
      'Observation variable rows returned in-context (up to loadLimit). Rows matching `text` are promoted to the top when the free-text query produces candidates.',
    ),
  returnedCount: z.number().int().nonnegative().describe('Length of `results[]`.'),
  totalCount: z.number().int().nonnegative().describe('Total rows reported by the server.'),
  hasMore: z.boolean().describe('True when more rows exist beyond the returned set.'),
  distributions: z
    .object({
      ontologyDbId: z
        .record(z.string(), z.number())
        .describe('Ontology ID → count of variables in that ontology.'),
      traitClass: z
        .record(z.string(), z.number())
        .describe('Trait class → count of variables in that class.'),
      scaleName: z
        .record(z.string(), z.number())
        .describe('Scale name → count of variables using that scale.'),
    })
    .describe('Value frequency per field across the full result set.'),
  ontologyCandidates: z
    .array(CandidateSchema)
    .describe(
      'Top ranked candidates from the free-text query (if any). Empty when `text` was not supplied.',
    ),
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

export const brapiFindVariables = tool('brapi_find_variables', {
  description:
    'Find observation variables (traits) by name, trait class, ontology term, or free-text query. Free-text queries are ranked against the returned set and may resolve to ontology URIs when the server advertises them. Returns a dataset handle when the upstream total exceeds loadLimit.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    alias: AliasInput,
    variables: z.array(z.string()).optional().describe('Filter by observationVariableDbIds.'),
    variableNames: z
      .array(z.string())
      .optional()
      .describe('Filter by exact observationVariableNames.'),
    variablePUIs: z.array(z.string()).optional().describe('Filter by persistent ontology URIs.'),
    traitClasses: z.array(z.string()).optional().describe('Filter by trait class.'),
    ontologies: z.array(z.string()).optional().describe('Filter by ontologyDbIds.'),
    studies: z.array(z.string()).optional().describe('Filter by studyDbIds.'),
    methods: z.array(z.string()).optional().describe('Filter by methodDbIds.'),
    scales: z.array(z.string()).optional().describe('Filter by scaleDbIds.'),
    crop: z.string().optional().describe('Filter by common crop name (single value).'),
    text: z
      .string()
      .optional()
      .describe(
        'Free-text query. Ranked client-side against variable names, synonyms, and descriptions.',
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
    const resolver = getOntologyResolver();
    const config = getServerConfig();

    const connection = await registry.get(ctx, input.alias ?? DEFAULT_ALIAS);

    const capabilityLookup: { auth?: typeof connection.resolvedAuth } = {};
    if (connection.resolvedAuth) capabilityLookup.auth = connection.resolvedAuth;
    await capabilities.ensure(
      connection.baseUrl,
      { service: 'variables', method: 'GET' },
      ctx,
      capabilityLookup,
    );

    const profile = await capabilities.profile(connection.baseUrl, ctx, capabilityLookup);
    const hasOntologyEndpoint = Boolean(profile.supported.ontologies);

    const warnings: string[] = [];
    const filters = mergeFilters(
      {
        observationVariableDbIds: input.variables,
        observationVariableNames: input.variableNames,
        observationVariablePUIs: input.variablePUIs,
        traitClasses: input.traitClasses,
        ontologyDbIds: input.ontologies,
        studyDbId: input.studies?.[0],
        methodDbIds: input.methods,
        scaleDbIds: input.scales,
        commonCropName: input.crop,
      },
      input.extraFilters,
      warnings,
    );

    if ((input.studies?.length ?? 0) > 1) {
      warnings.push(
        'BrAPI /variables accepts only one studyDbId per call; using the first value from `studies`.',
      );
    }
    if (input.text && !hasOntologyEndpoint) {
      warnings.push(
        'Server does not expose /ontologies — free-text matching falls back to local substring + synonym matching on the returned rows.',
      );
    }

    const loadLimit = input.loadLimit ?? config.loadLimit;
    const firstPage = await loadInitialPage<Record<string, unknown>>(
      client,
      connection,
      '/variables',
      filters,
      loadLimit,
      ctx,
    );

    const { fullRows, dataset: datasetMeta } = await maybeSpill({
      firstPage,
      client,
      connection,
      path: '/variables',
      filters,
      source: 'find_variables',
      loadLimit,
      ctx,
      store: datasetStore,
    });

    let rankedResults = firstPage.rows;
    let candidates: OntologyCandidate[] = [];
    if (input.text) {
      candidates = resolver.match(input.text, fullRows as VariableLike[], { limit: 10 });
      if (candidates.length > 0) {
        const orderedIds = new Set(candidates.map((c) => c.termId).filter(Boolean));
        // Promote matched rows to the top of the in-context set.
        const matched: Record<string, unknown>[] = [];
        const rest: Record<string, unknown>[] = [];
        for (const row of firstPage.rows) {
          const pui = row.observationVariablePUI;
          if (typeof pui === 'string' && orderedIds.has(pui)) matched.push(row);
          else rest.push(row);
        }
        rankedResults = [...matched, ...rest];
      }
    }

    const distributions = {
      ontologyDbId: computeDistribution(fullRows, (r) => asString(r.ontologyDbId)),
      traitClass: computeDistribution(fullRows, (r) => {
        const trait = r.trait;
        if (!trait || typeof trait !== 'object') return;
        return asString((trait as Record<string, unknown>).traitClass);
      }),
      scaleName: computeDistribution(fullRows, (r) => {
        const scale = r.scale;
        if (!scale || typeof scale !== 'object') return;
        return asString((scale as Record<string, unknown>).scaleName);
      }),
    };

    const totalCount = firstPage.totalCount ?? firstPage.rows.length;
    const refinementHint = buildRefinementHint(totalCount, loadLimit, distributions);

    const result: Output = {
      alias: connection.alias,
      results: rankedResults as z.infer<typeof VariableRowSchema>[],
      returnedCount: rankedResults.length,
      totalCount,
      hasMore: firstPage.hasMore,
      distributions,
      ontologyCandidates: candidates,
      warnings,
      appliedFilters: filters,
    };
    if (refinementHint) result.refinementHint = refinementHint;
    if (datasetMeta) result.dataset = datasetMeta;
    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`# ${result.returnedCount} of ${result.totalCount} variables — \`${result.alias}\``);
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
    if (result.ontologyCandidates.length > 0) {
      lines.push('## Ontology candidates (ranked)');
      for (const c of result.ontologyCandidates) {
        const parts: string[] = [];
        if (c.name) parts.push(`**${c.name}**`);
        if (c.termId) parts.push(`termId=\`${c.termId}\``);
        if (c.ontologyDbId) parts.push(`ontology=${c.ontologyDbId}`);
        parts.push(`source=${c.source}`);
        if (c.description) parts.push(`desc=${c.description}`);
        if (c.synonyms?.length) parts.push(`synonyms=${c.synonyms.join(',')}`);
        lines.push(`- ${parts.join(' · ')}`);
      }
      lines.push('');
    }
    lines.push('## Distributions');
    lines.push(renderDistributions(result.distributions) || '_No values to summarize._');
    lines.push('');
    lines.push('## Variables');
    if (result.results.length === 0) {
      lines.push('_No rows returned._');
    } else {
      for (const v of result.results) {
        const parts: string[] = [`**${v.observationVariableName ?? v.observationVariableDbId}**`];
        parts.push(`id=\`${v.observationVariableDbId}\``);
        if (v.observationVariablePUI) parts.push(`pui=${v.observationVariablePUI}`);
        if (v.ontologyDbId) parts.push(`ontology=${v.ontologyDbId}`);
        if (v.ontologyName) parts.push(`ontologyName=${v.ontologyName}`);
        if (v.commonCropName) parts.push(`crop=${v.commonCropName}`);
        if (v.trait?.traitName) parts.push(`trait=${v.trait.traitName}`);
        if (v.trait?.traitDbId) parts.push(`traitDbId=${v.trait.traitDbId}`);
        if (v.trait?.traitClass) parts.push(`class=${v.trait.traitClass}`);
        if (v.trait?.description) parts.push(`desc=${v.trait.description}`);
        if (v.trait?.synonyms?.length) parts.push(`synonyms=${v.trait.synonyms.join(',')}`);
        if (v.scale?.scaleName) parts.push(`scale=${v.scale.scaleName}`);
        if (v.scale?.scaleDbId) parts.push(`scaleDbId=${v.scale.scaleDbId}`);
        if (v.scale?.dataType) parts.push(`dataType=${v.scale.dataType}`);
        if (v.method?.methodName) parts.push(`method=${v.method.methodName}`);
        if (v.method?.methodDbId) parts.push(`methodDbId=${v.method.methodDbId}`);
        lines.push(`- ${parts.join(' · ')}`);
      }
    }
    if (result.dataset) {
      lines.push('');
      lines.push('## Dataset handle');
      lines.push(...renderDatasetHandle(result.dataset));
    }
    if (result.warnings.length > 0) {
      lines.push('');
      lines.push('## Warnings');
      for (const w of result.warnings) lines.push(`- ${w}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
