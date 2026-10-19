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
import { JsonRpcErrorCode, serializationError } from '@cyanheads/mcp-ts-core/errors';
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
  collectFindRoutes,
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

const VariableRowSchema = z
  .object({
    observationVariableDbId: z
      .string()
      .describe('Server-side identifier for the observation variable.'),
    observationVariableName: z.string().nullish().describe('Display name.'),
    studyDbIds: z
      .array(z.string().describe('Study ID.'))
      .nullish()
      .describe('Requested studies containing this union row.'),
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
  studyCoverage: z
    .array(
      z
        .object({
          id: z.string().describe('Requested study ID.'),
          status: z
            .enum(['complete', 'partial', 'failed', 'unprocessed'])
            .describe('Scan outcome.'),
          rowsScanned: z.number().int().nonnegative().describe('Rows examined.'),
          pagesFetched: z.number().int().nonnegative().describe('Successful pages.'),
          reason: z.string().optional().describe('Stop/failure reason.'),
        })
        .describe('One study.'),
    )
    .optional()
    .describe('Multi-study coverage; incomplete studies may omit variables.'),
  results: z
    .array(VariableRowSchema)
    .describe(
      'Leading variables, capped by loadLimit and 24,000 bytes. Text candidates lead; nested objects with no non-empty field are omitted.',
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
    .describe('Ranked free-text candidates; empty without text.'),
  dataframe: DataframeHandleSchema.optional().describe(
    'Matched rows, staged when results[] holds fewer.',
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
      reason: 'upstream_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'An uncaught BrAPI data request answered HTTP 404',
      recovery:
        'Check brapi_server_info for supported endpoints and verify the requested identifiers before retrying brapi_find_variables.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'An uncaught BrAPI data request exhausted retries after HTTP 429',
      recovery:
        'Wait before retrying brapi_find_variables; reduce concurrent requests to this BrAPI server.',
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
      .describe(
        'Filter by studyDbId. Multiple distinct studies are collected under shared page, row and time budgets and unioned by variable ID with studyDbIds provenance; studyCoverage reports incomplete studies.',
      ),
    methods: z.array(NonBlankString).optional().describe('Filter by methodDbIds.'),
    scales: z.array(NonBlankString).optional().describe('Filter by scaleDbIds.'),
    crop: NonBlankString.optional().describe('Filter by common crop name (single value).'),
    text: FreeTextInput.optional().describe(
      'Free-text query. Ranks **every row the call fetched** (the whole dataframe walk, not just the first page) via the ontology resolver, then fills results[] — up to loadLimit and the 24,000-byte budget — with matches first and unmatched rows for context. Use exact filters (`variables`, `variableNames`, `variablePUIs`, `traitClasses`, `ontologies`) to actually narrow the upstream pull. Differs from `brapi_find_germplasm.text`, which drops unmatched rows.',
    ),
    loadLimit: LoadLimitInput,
    extraFilters: ExtraFiltersInput,
  }),
  inputAliases: {
    observationVariableDbId: 'variables',
    observationVariableDbIds: 'variables',
    ontologyDbId: 'ontologies',
    ontologyDbIds: 'ontologies',
    studyDbId: 'studies',
    studyDbIds: 'studies',
    methodDbId: 'methods',
    methodDbIds: 'methods',
    scaleDbId: 'scales',
    scaleDbIds: 'scales',
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

    if (input.text && !hasOntologyEndpoint) {
      warnings.push(
        'Server does not expose /ontologies — free-text matching uses substring + synonym matching on the fetched rows.',
      );
    }

    const loadLimit = input.loadLimit ?? config.loadLimit;
    const normalizeRow = dialectRowMapper<Record<string, unknown>>(dialect, 'variables');
    const effectiveStudies = [...new Set(input.studies ?? [])];
    const union = new Map<string, Record<string, unknown>>();
    const studyCoverage =
      effectiveStudies.length > 1
        ? await collectFindRoutes<Record<string, unknown>>({
            client,
            connection,
            ctx,
            routes: effectiveStudies.map((id) => {
              const studyFilters = { ...merged, studyDbId: id };
              const studyAdapted = applyDialectFiltersOrFail(
                ctx,
                dialect,
                'variables',
                studyFilters,
                warnings,
              );
              return {
                id,
                route: resolveFindRoute({
                  profile,
                  dialect,
                  endpoint: 'variables',
                  filters: studyAdapted.filters,
                  searchBody: studyFilters,
                  warnings,
                  ...(studyAdapted.requiresEscalation ? { requiresEscalation: true } : {}),
                }),
              };
            }),
            ...(normalizeRow ? { normalizeRow } : {}),
            consume: (id, rows) => {
              for (const row of rows) {
                const variableId = row.observationVariableDbId;
                if (typeof variableId !== 'string' || !variableId)
                  throw serializationError(
                    'Upstream variable row is missing observationVariableDbId.',
                  );
                const existing = union.get(variableId);
                if (existing) {
                  const provenance = existing.studyDbIds as string[];
                  if (!provenance.includes(id)) provenance.push(id);
                } else union.set(variableId, { ...row, studyDbIds: [id] });
              }
            },
          })
        : undefined;
    const incomplete = studyCoverage?.some((item) => item.status !== 'complete');
    const firstPage = studyCoverage
      ? {
          rows: [...union.values()],
          hasMore: false,
          pagesFetched: studyCoverage.reduce((sum, item) => sum + item.pagesFetched, 0),
          totalCount: union.size,
        }
      : await loadInitialFindPage<Record<string, unknown>>(
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
      filters: studyCoverage ? { ...filters, studyDbId: effectiveStudies } : filters,
      route,
      source: 'find_variables',
      renderInline: (rows, dataframe) =>
        renderVariablesRows({ results: rows as Output['results'], dataframe }),
      loadLimit,
      ctx,
      bridge,
      warnings,
      ...(incomplete
        ? { preloadedStopReason: 'multi-study coverage incomplete; see studyCoverage' }
        : {}),
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

    const appliedFilters = studyCoverage
      ? { ...(route.kind === 'search' ? route.searchBody : filters), studyDbId: effectiveStudies }
      : route.kind === 'search'
        ? route.searchBody
        : filters;
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
    if (studyCoverage) result.studyCoverage = studyCoverage;
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
    if (result.studyCoverage) {
      lines.push('## Study coverage');
      for (const item of result.studyCoverage)
        lines.push(
          literal`- studyDbId=\`${item.id}\`: ${item.status}; ${item.rowsScanned} row(s), ${item.pagesFetched} page(s)${item.reason ? `; ${item.reason}` : ''}`,
        );
      lines.push('');
    }
    const moreRows = renderMoreRowsLine(result);
    if (moreRows) lines.push(moreRows, '');
    if (result.ontologyCandidates.length > 0) {
      lines.push('## Ontology candidates (ranked)');
      for (const c of result.ontologyCandidates) {
        const parts: string[] = [];
        if (c.name) parts.push(literal`**${c.name}**`);
        if (c.observationVariableDbId)
          parts.push(literal`observationVariableDbId=\`${c.observationVariableDbId}\``);
        if (c.termId) parts.push(literal`termId=\`${c.termId}\``);
        if (c.ontologyDbId) parts.push(literal`ontology=${c.ontologyDbId}`);
        parts.push(`source=${c.source}`);
        if (c.description) parts.push(literal`desc=${c.description}`);
        if (c.synonyms?.length) parts.push(literal`synonyms=${c.synonyms.join(',')}`);
        lines.push(`- ${parts.join(' · ')}`);
      }
      lines.push('');
    }
    lines.push('## Distributions');
    lines.push(
      renderDistributions(result.distributions, result.dataframe) || '_No values to summarize._',
    );
    lines.push('');
    lines.push(renderVariablesRows(result));
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

/** Render the exact row section used by both formatting and preview sizing. */
function renderVariablesRows(result: Pick<Output, 'results' | 'dataframe'>): string {
  const lines: string[] = [];
  lines.push('## Variables');
  if (result.results.length === 0) {
    lines.push('_No rows returned._');
  } else {
    const RENDERED = new Set([
      'observationVariableName',
      'studyDbIds',
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
      const parts: string[] = [
        literal`**${v.observationVariableName ?? v.observationVariableDbId}**`,
      ];
      parts.push(literal`id=\`${v.observationVariableDbId}\``);
      if (v.studyDbIds) parts.push(literal`studies=${v.studyDbIds.join(', ')}`);
      if (v.observationVariablePUI) parts.push(literal`pui=${v.observationVariablePUI}`);
      if (v.ontologyDbId) parts.push(literal`ontology=${v.ontologyDbId}`);
      if (v.ontologyName) parts.push(literal`ontologyName=${v.ontologyName}`);
      if (v.commonCropName) parts.push(literal`crop=${v.commonCropName}`);
      if (v.trait) parts.push(literal`trait=${JSON.stringify(v.trait)}`);
      if (v.scale) parts.push(literal`scale=${JSON.stringify(v.scale)}`);
      if (v.method) parts.push(literal`method=${JSON.stringify(v.method)}`);
      parts.push(
        ...collectPassthroughParts(v as Record<string, unknown>, RENDERED, result.dataframe),
      );
      lines.push(`- ${parts.join(' · ')}`);
    }
  }
  return lines.join('\n');
}
