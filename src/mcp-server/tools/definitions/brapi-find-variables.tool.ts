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
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getBrapiClient } from '@/services/brapi-client/index.js';
import { resolveDialect } from '@/services/brapi-dialect/index.js';
import { getCanvasBridge } from '@/services/canvas-bridge/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import {
  getOntologyResolver,
  type OntologyCandidate,
  type VariableLike,
} from '@/services/ontology-resolver/index.js';
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
  FreeTextInput,
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
    observationVariableDbId: z
      .string()
      .optional()
      .describe('Server-side variable DbId of the source row, when present.'),
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
  alias: z.string().describe('Connection alias the call used.'),
  results: z
    .array(VariableRowSchema)
    .describe(
      'Leading observation variable rows, up to loadLimit and a 24,000-byte budget, whichever binds first. Rows matching `text` are promoted to the top when the free-text query produces candidates; nested objects with no non-empty field are omitted.',
    ),
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
    .describe('Value frequency per field across every matched row fetched.'),
  ontologyCandidates: z
    .array(CandidateSchema)
    .describe(
      'Top ranked candidates from the free-text query (if any). Empty when `text` was not supplied.',
    ),
  dataframe: DataframeHandleSchema.optional().describe(
    'The matched rows, staged as a dataframe when results[] holds fewer.',
  ),
});

type Output = z.infer<typeof OutputSchema>;

const SERVER_TO_USER: Record<string, string> = {
  // Plurals — BrAPI v2.1 spec.
  observationVariableDbIds: 'variables',
  observationVariableNames: 'variableNames',
  observationVariablePUIs: 'variablePUIs',
  traitClasses: 'traitClasses',
  ontologyDbIds: 'ontologies',
  methodDbIds: 'methods',
  scaleDbIds: 'scales',
  // Singulars — SGN-family dialects + BrAPI's already-singular variable filters.
  observationVariableDbId: 'variables',
  observationVariableName: 'variableNames',
  observationVariablePUI: 'variablePUIs',
  traitClass: 'traitClasses',
  ontologyDbId: 'ontologies',
  methodDbId: 'methods',
  scaleDbId: 'scales',
  // Already-singular per BrAPI spec — same on the wire either way.
  studyDbId: 'studies',
  commonCropName: 'crop',
};

export const brapiFindVariables = tool('brapi_find_variables', {
  description:
    'Find observation variables (traits) by name, trait class, ontology term, or free-text query. Free-text queries are ranked against every fetched row by PUI, name, synonym, and trait text; a candidate carries the ontology PUI of its row as termId when the row has one. results[] holds the leading rows up to loadLimit and a 24,000-byte budget; when it holds fewer rows than matched, the matched set is materialized as a dataframe — read it with brapi_dataframe_describe and brapi_dataframe_query (SQL).',
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'unknown_alias',
      code: JsonRpcErrorCode.NotFound,
      when: 'No connection is registered under the requested alias, and the server has no base URL configured for it to connect on first use',
      recovery:
        'Run brapi_connect with this alias and a `baseUrl`, or pass an alias the brapi_connect description lists as built-in or operator-configured, before calling brapi_find_variables.',
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
        'The BrAPI server is slow or unreachable right now. Retry brapi_find_variables in a minute; if it keeps failing, the server may be down.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unauthorized',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'The BrAPI server answered HTTP 401: it requires credentials, or rejected the ones sent',
      recovery:
        'Run brapi_connect with credentials in `auth`, or ask the operator to set server-side credentials for this alias, then retry brapi_find_variables.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The BrAPI server answered HTTP 403: the credentials sent, or their absence, lack access',
      recovery:
        'Run brapi_connect with credentials that have access, or ask the operator to set server-side credentials for this alias that do, then retry brapi_find_variables.',
      thrownBy: 'service',
    },
    {
      reason: 'alias_base_url_invalid',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'The base URL configured on the server for this alias is not an absolute http(s) URL, or carries credentials',
      recovery:
        'Ask the operator to set the base URL configured for this alias to an absolute http(s) URL, then retry brapi_find_variables.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'private_address_blocked',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The base URL configured for this alias, or its token URL, is on a private or reserved address this server may not reach',
      recovery:
        'Ask the operator to point this alias at a publicly routable host, or to allow private addresses on this server, then retry brapi_find_variables.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'all_filters_dropped',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The active dialect dropped every filter the agent supplied — the upstream server does not honor any of the requested scope filters on this endpoint, so the call would silently widen to the unfiltered baseline.',
      recovery:
        'Drop the unsupported filters and rescope by variables, traitClasses, ontologyDbIds, methodDbIds, scaleDbIds, or text — these filter paths are honored on the active dialect.',
      thrownBy: 'service',
    },
  ] as const,
  input: z.object({
    alias: AliasInput,
    variables: z.array(NonBlankString).optional().describe('Filter by observationVariableDbIds.'),
    variableNames: z
      .array(NonBlankString)
      .optional()
      .describe('Filter by exact observationVariableNames.'),
    variablePUIs: z
      .array(NonBlankString)
      .optional()
      .describe('Filter by persistent ontology URIs.'),
    traitClasses: z.array(NonBlankString).optional().describe('Filter by trait class.'),
    ontologies: z.array(NonBlankString).optional().describe('Filter by ontologyDbIds.'),
    studies: z
      .array(NonBlankString)
      .optional()
      .describe('Filter by studyDbId. /variables takes one, so only the first value is sent.'),
    methods: z.array(NonBlankString).optional().describe('Filter by methodDbIds.'),
    scales: z.array(NonBlankString).optional().describe('Filter by scaleDbIds.'),
    crop: NonBlankString.optional().describe('Filter by common crop name (single value).'),
    text: FreeTextInput.optional().describe(
      'Free-text query. Ranks **every row the call fetched** (the whole dataframe walk, not just the first page) via the ontology resolver, then fills results[] — up to loadLimit and the 24,000-byte budget — with matches first and unmatched rows for context. Use exact filters (`variables`, `variableNames`, `variablePUIs`, `traitClasses`, `ontologies`) to actually narrow the upstream pull. Differs from `brapi_find_germplasm.text`, which drops unmatched rows.',
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
    appliedFilters: { render: renderAppliedFiltersTrailer(SERVER_TO_USER) },
    warnings: { render: renderWarningsTrailer },
  },

  async handler(input, ctx) {
    const capabilities = getCapabilityRegistry();
    const client = getBrapiClient();
    const bridge = getCanvasBridge();
    const resolver = getOntologyResolver();
    const config = getServerConfig();

    const connection = await requireRegisteredConnection(ctx, input.alias);

    const capabilityLookup: { auth?: typeof connection.resolvedAuth } = {};
    if (connection.resolvedAuth) capabilityLookup.auth = connection.resolvedAuth;
    const profile = await capabilities.profile(connection.baseUrl, ctx, capabilityLookup);
    const hasOntologyEndpoint = Boolean(profile.supported.ontologies);

    const dialect = await resolveDialect(connection, ctx, capabilityLookup);

    const warnings: string[] = [];
    const merged = mergeFilters(
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

    const adapted = applyDialectFiltersOrFail(ctx, dialect, 'variables', merged, warnings);
    const filters = adapted.filters;
    const route = resolveFindRoute({
      profile,
      dialect,
      endpoint: 'variables',
      filters,
      searchBody: merged,
      warnings,
      ...(adapted.requiresEscalation ? { requiresEscalation: true } : {}),
    });

    if ((input.studies?.length ?? 0) > 1) {
      warnings.push(
        'BrAPI /variables accepts only one studyDbId per call; using the first value from `studies`.',
      );
    }
    if (input.text && !hasOntologyEndpoint) {
      warnings.push(
        'Server does not expose /ontologies — free-text matching uses substring + synonym matching on the fetched rows.',
      );
    }

    const loadLimit = input.loadLimit ?? config.loadLimit;
    const normalizeRow = dialectRowMapper<Record<string, unknown>>(dialect, 'variables');
    const firstPage = await loadInitialFindPage<Record<string, unknown>>(
      client,
      connection,
      route,
      loadLimit,
      ctx,
      normalizeRow ? { normalizeRow } : {},
    );

    const text = input.text;
    let candidates: OntologyCandidate[] = [];
    const spill = await maybeSpill({
      firstPage,
      client,
      connection,
      path: '/variables',
      filters,
      route,
      source: 'find_variables',
      loadLimit,
      ctx,
      bridge,
      warnings,
      ...(normalizeRow ? { normalizeRow } : {}),
      /**
       * results[] carries free-text matches first, with empty nested containers
       * stripped (CassavaBase emits `method: {}` on every variable); the inline
       * bounds measure those rows. The dataframe keeps the raw upstream shape.
       */
      inlineView: (rows) => {
        candidates = text ? resolver.match(text, rows as VariableLike[], { limit: 10 }) : [];
        return promoteCandidates(rows, candidates).map(pruneEmptyNestedObjects);
      },
    });
    const { fullRows, dataframe, results, hasMore, rowsScanned } = spill;

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

    checkFilterMatchRates(warnings, fullRows.length, [
      {
        paramName: 'traitClasses',
        requestedValues: input.traitClasses,
        distribution: distributions.traitClass,
        caseInsensitive: true,
      },
      {
        paramName: 'ontologies',
        requestedValues: input.ontologies,
        distribution: distributions.ontologyDbId,
      },
      ...buildExtraFilterChecks(input.extraFilters, fullRows, warnings),
    ]);

    const totalCount = firstPage.totalCount ?? rowsScanned;
    const refinementHint = buildRefinementHint(spill, distributions, {
      availableFilters: [
        'variables',
        'variableNames',
        'variablePUIs',
        'traitClasses',
        'ontologies',
        'studies',
        'methods',
        'scales',
        'crop',
        'text',
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
          : 'No variables matched the applied filters. Try broadening variableNames, traitClasses, ontologies, or using the text parameter.',
      );
    discloseInlineTrim(ctx, spill, loadLimit);

    const result: Output = {
      alias: connection.alias,
      results: results as z.infer<typeof VariableRowSchema>[],
      hasMore,
      distributions,
      ontologyCandidates: candidates,
    };
    if (dataframe) result.dataframe = dataframe;
    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(
      renderFindHeader({
        noun: 'variables',
        alias: result.alias,
        returnedCount: result.results.length,
        dataframe: result.dataframe,
      }),
    );
    lines.push('');
    const moreRows = renderMoreRowsLine(result);
    if (moreRows) lines.push(moreRows, '');
    if (result.ontologyCandidates.length > 0) {
      lines.push('## Ontology candidates (ranked)');
      for (const c of result.ontologyCandidates) {
        const parts: string[] = [];
        if (c.name) parts.push(`**${c.name}**`);
        if (c.observationVariableDbId)
          parts.push(`observationVariableDbId=\`${c.observationVariableDbId}\``);
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
    lines.push(
      renderDistributions(result.distributions, result.dataframe) || '_No values to summarize._',
    );
    lines.push('');
    lines.push('## Variables');
    if (result.results.length === 0) {
      lines.push('_No rows returned._');
    } else {
      const RENDERED = new Set([
        'observationVariableName',
        'observationVariableDbId',
        'observationVariablePUI',
        'ontologyDbId',
        'ontologyName',
        'commonCropName',
        'trait',
        'scale',
        'method',
      ]);
      for (const v of result.results) {
        const parts: string[] = [`**${v.observationVariableName ?? v.observationVariableDbId}**`];
        parts.push(`id=\`${v.observationVariableDbId}\``);
        if (v.observationVariablePUI) parts.push(`pui=${v.observationVariablePUI}`);
        if (v.ontologyDbId) parts.push(`ontology=${v.ontologyDbId}`);
        if (v.ontologyName) parts.push(`ontologyName=${v.ontologyName}`);
        if (v.commonCropName) parts.push(`crop=${v.commonCropName}`);
        if (v.trait) parts.push(`trait=${JSON.stringify(v.trait)}`);
        if (v.scale) parts.push(`scale=${JSON.stringify(v.scale)}`);
        if (v.method) parts.push(`method=${JSON.stringify(v.method)}`);
        parts.push(
          ...collectPassthroughParts(v as Record<string, unknown>, RENDERED, result.dataframe),
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

/**
 * Reorder `rows` so those the ontology candidates name come first, each group
 * keeping upstream order. Matches by observationVariableDbId — always present —
 * and falls back to the PUI, which is sparse on real servers (CassavaBase
 * leaves it unset). Runs over the full matched set, not the first page: a
 * match routinely sits far past the inline window ("dry matter content" is row
 * ~700 of 750 in alphabetical order on CassavaBase).
 */
function promoteCandidates(
  rows: Record<string, unknown>[],
  candidates: OntologyCandidate[],
): Record<string, unknown>[] {
  if (candidates.length === 0) return rows;
  const matchedDbIds = new Set(
    candidates.map((c) => c.observationVariableDbId).filter((v): v is string => Boolean(v)),
  );
  const matchedPuis = new Set(
    candidates.map((c) => c.termId).filter((v): v is string => Boolean(v)),
  );
  const matched: Record<string, unknown>[] = [];
  const rest: Record<string, unknown>[] = [];
  for (const row of rows) {
    const dbId = row.observationVariableDbId;
    const pui = row.observationVariablePUI;
    const isMatch =
      (typeof dbId === 'string' && matchedDbIds.has(dbId)) ||
      (typeof pui === 'string' && matchedPuis.has(pui));
    (isMatch ? matched : rest).push(row);
  }
  return [...matched, ...rest];
}

/**
 * Drop top-level keys whose value is a non-array object with no meaningful
 * content. Used to suppress bloat-only containers like `method: {}` that
 * some Breedbase deployments attach to every variable record. An object is
 * considered meaningful iff at least one of its values is non-null,
 * non-undefined, and non-empty-string. Arrays (including empty arrays) are
 * always preserved — `[]` carries the semantic "no entries" rather than
 * "container exists but empty".
 */
function pruneEmptyNestedObjects(row: Record<string, unknown>): Record<string, unknown> {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const inner = value as Record<string, unknown>;
      const meaningful = Object.values(inner).some(
        (v) => v !== null && v !== undefined && v !== '',
      );
      if (!meaningful) {
        changed = true;
        continue;
      }
    }
    out[key] = value;
  }
  return changed ? out : row;
}
