/**
 * @fileoverview `brapi_build_phenotype_matrix` — pull observations across one or
 * more studies and pivot them into a germplasm × trait matrix materialized as a
 * canvas dataframe. Returns a dataframe handle plus a summary of dimensions,
 * aggregate method, and any warnings encountered during the pull.
 *
 * The per-study observation pull (with its `/observations` → `/observationunits`
 * fallback chain) lives in `../shared/observations.ts`, shared with
 * `brapi_germplasm_performance`.
 *
 * Column safety: wide-matrix column names are SQL-safe identifiers derived from
 * `observationVariableDbId` via `../shared/canvas-columns.ts` — BrAPI DbIds are
 * routinely numeric (Breedbase) or collide with reserved SQL words, both of
 * which the canvas identifier gate rejects. A `variableLegend` mapping safe
 * column → display name is returned so callers can resolve columns back.
 *
 * @module mcp-server/tools/definitions/brapi-build-phenotype-matrix.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getBrapiClient } from '@/services/brapi-client/index.js';
import { resolveDialect } from '@/services/brapi-dialect/index.js';
import { getCanvasBridge } from '@/services/canvas-bridge/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import { buildUniqueColumns } from '../shared/canvas-columns.js';
import {
  AliasInput,
  buildExtraFilterChecks,
  checkFilterMatchRates,
  DataframeHandleSchema,
  ExtraFiltersInput,
  LoadLimitInput,
  NonBlankString,
  renderDataframeHandle,
  requireRegisteredConnection,
  stagedDataframeNotice,
} from '../shared/find-helpers.js';
import {
  describeError,
  describeTruncation,
  type NormObs,
  ObservationCoverageSchema,
  pullObservationsForStudies,
  type RawObservationRow,
  renderObservationCoverage,
  type StudyObservationOutcome,
  studyCoverage,
} from '../shared/observations.js';

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

const OutputSchema = z.object({
  alias: z.string().describe('Connection alias the call used.'),
  studies: z
    .array(z.string())
    .describe('Requested studyDbIds; coverage records collection outcomes.'),
  coverage: ObservationCoverageSchema,
  shape: z
    .enum(['wide', 'long'])
    .describe(
      'Matrix shape — wide (one row per germplasm, one column per variable) or long (one row per observation).',
    ),
  aggregate: z
    .enum(['mean', 'median', 'first', 'all'])
    .describe(
      'Aggregation applied to replicate observations (wide shape only). `all` keeps one row per replicate.',
    ),
  observationCount: z
    .number()
    .int()
    .nonnegative()
    .describe('Total raw observations collected before pivoting.'),
  germplasmCount: z
    .number()
    .int()
    .nonnegative()
    .describe('Number of distinct germplasm in the matrix.'),
  variableCount: z
    .number()
    .int()
    .nonnegative()
    .describe('Number of distinct observation variables in the matrix.'),
  variableLegend: z
    .record(z.string(), z.string())
    .describe(
      'Wide-matrix column name (SQL-safe, derived from observationVariableDbId) → observationVariableName.',
    ),
  dataframe: DataframeHandleSchema.optional().describe(
    'The matrix, staged; absent when no observations were found. Long-form columns: germplasmDbId, observationVariableDbId, studyDbId, value, replicateIndex. Wide-form columns: germplasmDbId, germplasmName, then one per variable (see variableLegend).',
  ),
  warnings: z
    .array(z.string())
    .describe(
      'Advisory messages (empty or failed studies, partial study scans, extraFilters the rows contradict or cannot verify, non-numeric aggregation skips, fallback paths).',
    ),
});

type Output = z.infer<typeof OutputSchema>;

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const brapiBuildPhenotypeMatrix = tool('brapi_build_phenotype_matrix', {
  description:
    'Pull observations across one or more studies and pivot them into a germplasm × trait matrix materialized as a canvas dataframe. Returns a dataframe handle (read it with brapi_dataframe_describe and brapi_dataframe_query) plus a summary of dimensions and aggregate method. Long-form output is suitable for downstream GROUP BY analysis by study, germplasm, or variable. A study whose pull fails is named in warnings and the rest still build the matrix; the call fails only when every study failed.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'unknown_alias',
      code: JsonRpcErrorCode.NotFound,
      when: 'No connection is registered under the requested alias, and the server has no base URL configured for it to connect on first use',
      recovery:
        'Run brapi_connect with this alias and a `baseUrl`, or pass an alias the brapi_connect description lists as built-in or operator-configured, before calling brapi_build_phenotype_matrix.',
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
        'The BrAPI server is slow or unreachable right now. Retry brapi_build_phenotype_matrix in a minute; if it keeps failing, the server may be down.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unauthorized',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'The BrAPI server answered HTTP 401: it requires credentials, or rejected the ones sent',
      recovery:
        'Run brapi_connect with credentials in `auth`, or ask the operator to set server-side credentials for this alias, then retry brapi_build_phenotype_matrix.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The BrAPI server answered HTTP 403: the credentials sent, or their absence, lack access',
      recovery:
        'Run brapi_connect with credentials that have access, or ask the operator to set server-side credentials for this alias that do, then retry brapi_build_phenotype_matrix.',
      thrownBy: 'service',
    },
    {
      reason: 'alias_base_url_invalid',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'The base URL configured on the server for this alias is not an absolute http(s) URL, or carries credentials',
      recovery:
        'Ask the operator to set the base URL configured for this alias to an absolute http(s) URL, then retry brapi_build_phenotype_matrix.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'private_address_blocked',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The base URL configured for this alias, or its token URL, is on a private or reserved address this server may not reach',
      recovery:
        'Ask the operator to point this alias at a publicly routable host, or to allow private addresses on this server, then retry brapi_build_phenotype_matrix.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'dialect_all_filters_dropped',
      code: JsonRpcErrorCode.ValidationError,
      when: 'For every requested study, the active dialect dropped the study filter on /observationunits, so the pull would have widened to unfiltered rows',
      recovery:
        'This server cannot scope observation units by study; use brapi_find_observations with germplasm or variable filters instead.',
      thrownBy: 'service',
    },
    {
      reason: 'no_observation_path',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Neither /observations nor /observationunits returned data for any requested study after probing both paths',
      recovery:
        'Verify the studyDbIds exist and the BrAPI server exposes /observations or /observationunits. Use brapi_server_info to inspect the capability list.',
    },
  ] as const,
  input: z.object({
    alias: AliasInput,
    studies: z
      .array(NonBlankString)
      .min(1)
      .describe(
        'studyDbIds to include in the matrix. At least one is required — the tool is study-anchored to avoid full-table scans.',
      ),
    variables: z
      .array(NonBlankString)
      .optional()
      .describe(
        'Optional subset of observationVariableDbIds to include. Omit to include all variables found in the queried studies.',
      ),
    germplasm: z
      .array(NonBlankString)
      .optional()
      .describe(
        'Optional subset of germplasmDbIds to include. Omit to include all germplasm found in the queried studies.',
      ),
    shape: z
      .enum(['wide', 'long'])
      .default('wide')
      .describe(
        'Matrix shape. `wide` — one row per germplasm, one column per variable, cell = aggregated value. `long` — one row per observation with columns: germplasmDbId, observationVariableDbId, studyDbId, value, replicateIndex. When `aggregate:"all"` is combined with `shape:"wide"`, the output falls back to long form with a replicateIndex column.',
      ),
    aggregate: z
      .enum(['mean', 'median', 'first', 'all'])
      .default('mean')
      .describe(
        'How to aggregate replicate observations (multiple readings of the same variable on the same germplasm). `mean` and `median` attempt numeric conversion and skip non-numeric values (e.g. categorical traits). `first` keeps the first value seen. `all` keeps every replicate as a separate row (produces long-form output even when shape is "wide"). Default: `mean`.',
      ),
    loadLimit: LoadLimitInput.describe(
      'Cap on matching observations collected per study. Omit for the deployment default. A study that stops at it is reported as truncated.',
    ),
    extraFilters: ExtraFiltersInput,
  }),
  output: OutputSchema,
  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when failed, truncated, or unprocessed studies leave matrix coverage incomplete.',
      ),
    shown: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Observations collected across all studies after filtering.'),
    cap: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Per-study cap on matching observations that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance for reaching the observations this call left out, then the matrix dataframe and the tools that read it.',
      ),
  },

  async handler(input, ctx) {
    const client = getBrapiClient();
    const bridge = getCanvasBridge();
    const config = getServerConfig();
    const capabilities = getCapabilityRegistry();

    const connection = await requireRegisteredConnection(ctx, input.alias);
    const capabilityLookup = connection.resolvedAuth ? { auth: connection.resolvedAuth } : {};

    const profile = await capabilities.profile(connection.baseUrl, ctx, capabilityLookup);
    const dialect = await resolveDialect(connection, ctx, capabilityLookup);
    const loadLimit = input.loadLimit ?? config.loadLimit;

    const warnings: string[] = [];
    // Each study's rows, already narrowed to germplasm / variables by the pull.
    const filteredObs: NormObs[] = [];

    // Collect observations across the studies with bounded concurrency,
    // reassembled in input order so the wide-matrix column/row layout (derived
    // from study encounter order below) stays deterministic across identical
    // runs. A study with no observation path aborts the call; a failed study is
    // a warning unless every study failed.
    const outcomes = await pullObservationsForStudies({
      studyDbIds: input.studies,
      input,
      client,
      connection,
      profile: profile.supported,
      dialect,
      config,
      loadLimit,
      failFast: true,
      ctx,
    });
    const failed: StudyObservationOutcome[] = [];
    const truncatedStudies: string[] = [];
    const rawRows: RawObservationRow[] = [];
    for (const outcome of outcomes) {
      warnings.push(...outcome.warnings);
      if (outcome.error !== undefined) {
        failed.push(outcome);
        warnings.push(
          `Study '${outcome.studyDbId}': observation pull failed (${describeError(outcome.error)}).`,
        );
        continue;
      }
      if (outcome.observations === null) {
        throw ctx.fail(
          'no_observation_path',
          `Neither /observations nor /observationunits returned a usable path for study '${outcome.studyDbId}'. Check brapi_server_info for the capability list.`,
          { studyDbId: outcome.studyDbId },
        );
      }
      if (outcome.truncation) {
        truncatedStudies.push(`${outcome.studyDbId} (${describeTruncation(outcome.truncation)})`);
      }
      filteredObs.push(...outcome.observations);
      rawRows.push(...outcome.rawRows);
    }
    if (failed.length === outcomes.length) throw everyStudyFailed(failed);

    // A server can ignore an extraFilters key and answer unfiltered: check the
    // keys against the rows the matrix is built from, as brapi_find_observations does.
    checkFilterMatchRates(
      warnings,
      rawRows.length,
      buildExtraFilterChecks(input.extraFilters, rawRows, warnings),
    );

    if (filteredObs.length === 0) {
      warnings.push(
        'No observations matched after collecting from the requested studies. The matrix will be empty.',
      );
    }

    // Build variable column plan: distinct variables in encounter order →
    // SQL-safe column names, plus a legend mapping safe column → display name.
    const varOrder: string[] = [];
    const varDisplay = new Map<string, string>();
    for (const o of filteredObs) {
      if (!varDisplay.has(o.observationVariableDbId)) {
        varDisplay.set(o.observationVariableDbId, o.observationVariableName);
        varOrder.push(o.observationVariableDbId);
      }
    }
    const { columns: variableColumns, toOriginal: columnToVariable } = buildUniqueColumns(varOrder);
    const variableLegend: Record<string, string> = {};
    for (const col of variableColumns) {
      const varId = columnToVariable[col];
      if (varId !== undefined) variableLegend[col] = varDisplay.get(varId) ?? varId;
    }

    // Determine effective shape — `all` replicates force long form
    const effectiveShape =
      input.shape === 'wide' && input.aggregate === 'all' ? 'long' : input.shape;
    if (input.shape === 'wide' && input.aggregate === 'all') {
      warnings.push(
        '`shape:"wide"` combined with `aggregate:"all"` produces long-form output with a replicateIndex column (no pivot possible when all replicates are kept).',
      );
    }

    // Build the matrix rows
    let matrixRows: Record<string, unknown>[];
    if (effectiveShape === 'long') {
      matrixRows = buildLongRows(filteredObs);
    } else {
      matrixRows = buildWideRows(
        filteredObs,
        input.aggregate,
        variableColumns,
        columnToVariable,
        warnings,
      );
    }

    // Distinct germplasm count (from filteredObs, not matrixRows)
    const germplasmSet = new Set(filteredObs.map((o) => o.germplasmDbId));

    const result: Output = {
      alias: connection.alias,
      studies: input.studies,
      coverage: studyCoverage(input.studies, outcomes),
      shape: input.shape,
      aggregate: input.aggregate,
      observationCount: filteredObs.length,
      germplasmCount: germplasmSet.size,
      variableCount: varOrder.length,
      variableLegend,
      warnings,
    };

    // Only materialize when there are actual rows — DuckDB rejects an empty
    // schema (no columns), and an empty dataframe handle is misleading.
    if (matrixRows.length > 0) {
      const dataframe = await bridge.registerDataframe(ctx, {
        source: 'build_phenotype_matrix',
        baseUrl: connection.baseUrl,
        query: {
          studies: input.studies,
          variables: input.variables,
          germplasm: input.germplasm,
          shape: input.shape,
          aggregate: input.aggregate,
        },
        rows: matrixRows,
      });
      result.dataframe = {
        tableName: dataframe.tableName,
        rowCount: dataframe.rowCount,
        columns: dataframe.columns,
        createdAt: dataframe.createdAt,
        expiresAt: dataframe.expiresAt,
      };
    }

    // One notice: the truncation guidance (when a scan stopped early), then the
    // pointer to the matrix dataframe.
    const pointer = result.dataframe ? stagedDataframeNotice([result.dataframe]) : undefined;
    if (result.coverage.partial) {
      const guidance =
        truncatedStudies.length > 0
          ? `Observation scans stopped early for ${truncatedStudies.join('; ')} — the matrix covers a partial set. Raise loadLimit, narrow with variables / germplasm / fewer studies, or retry when a page failed.${failed.length ? ` Failed studies: ${failed.map((o) => o.studyDbId).join(', ')}.` : ''}`
          : `Matrix coverage is partial: ${failed.map((o) => `${o.studyDbId} (failed)`).join('; ')}. Retry failed studies or select fewer studies.`;
      ctx.enrich.truncated({
        shown: filteredObs.length,
        cap: loadLimit,
        guidance: pointer ? `${guidance} ${pointer}` : guidance,
      });
    } else if (pointer) {
      ctx.enrich.notice(pointer);
    }

    return result;
  },

  format: (result) => {
    const lines: string[] = [];

    lines.push(
      `# Phenotype matrix — ${result.germplasmCount} germplasm × ${result.variableCount} variables — \`${result.alias}\``,
    );
    lines.push('');
    lines.push(
      `Shape: **${result.shape}** · Aggregate: **${result.aggregate}** · Observations collected: ${result.observationCount}`,
    );
    lines.push(`Studies requested: ${result.studies.join(', ')}`);
    lines.push(...renderObservationCoverage(result.coverage));
    lines.push('');

    // Variable legend
    const legendEntries = Object.entries(result.variableLegend);
    if (legendEntries.length > 0) {
      lines.push('## Variable legend');
      for (const [col, name] of legendEntries) {
        lines.push(`- \`${col}\` → ${name}`);
      }
      lines.push('');
    }

    // Dataframe handle
    if (result.dataframe) {
      lines.push('## Dataframe handle');
      lines.push(...renderDataframeHandle(result.dataframe));
      lines.push('');
    } else {
      lines.push('_No observations found — dataframe not materialized._');
      lines.push('');
    }

    if (result.warnings.length > 0) {
      lines.push('## Warnings');
      for (const w of result.warnings) {
        lines.push(`- ${w}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/**
 * The call's error when every requested study's pull failed: the first study's
 * error code, reason, and recovery hint, with a message naming each study and
 * its failure.
 */
function everyStudyFailed(failed: StudyObservationOutcome[]): McpError {
  const first = failed[0]?.error;
  const studyDbIds = failed.map((o) => o.studyDbId);
  const message = `Observation pull failed for every requested study: ${failed
    .map((o) => `'${o.studyDbId}' (${describeError(o.error)})`)
    .join('; ')}.`;
  if (!(first instanceof McpError))
    return serviceUnavailable(message, { studyDbIds }, { cause: first });
  const { reason, recovery } = first.data ?? {};
  return new McpError(
    first.code,
    message,
    {
      ...(reason !== undefined && { reason }),
      ...(recovery !== undefined && { recovery }),
      studyDbIds,
    },
    { cause: first },
  );
}

// ---------------------------------------------------------------------------
// Long-form row builder
// ---------------------------------------------------------------------------

function buildLongRows(obs: NormObs[]): Record<string, unknown>[] {
  // Group by (germplasmDbId, observationVariableDbId, studyDbId) to assign replicate index
  const replicateCounts = new Map<string, number>();
  return obs.map((o) => {
    const key = `${o.germplasmDbId}|${o.observationVariableDbId}|${o.studyDbId}`;
    const idx = replicateCounts.get(key) ?? 0;
    replicateCounts.set(key, idx + 1);
    return {
      germplasmDbId: o.germplasmDbId,
      observationVariableDbId: o.observationVariableDbId,
      studyDbId: o.studyDbId,
      value: o.value,
      replicateIndex: idx,
    };
  });
}

// ---------------------------------------------------------------------------
// Wide-form row builder
// ---------------------------------------------------------------------------

function buildWideRows(
  obs: NormObs[],
  aggregate: 'mean' | 'median' | 'first' | 'all',
  variableColumns: string[],
  columnToVariable: Record<string, string>,
  warnings: string[],
): Record<string, unknown>[] {
  if (aggregate === 'all') {
    // Caller already redirected to long for 'all' + 'wide' — this branch should
    // not be reached, but guard defensively.
    return buildLongRows(obs);
  }

  // Group observations: germplasmDbId → variableDbId → values[]
  const groups = new Map<string, Map<string, string[]>>();
  // Collect germplasm names (first observation per germplasm)
  const germplasmNames = new Map<string, string>();

  for (const o of obs) {
    if (!germplasmNames.has(o.germplasmDbId)) {
      germplasmNames.set(o.germplasmDbId, o.germplasmName);
    }
    let byVar = groups.get(o.germplasmDbId);
    if (!byVar) {
      byVar = new Map();
      groups.set(o.germplasmDbId, byVar);
    }
    const vals = byVar.get(o.observationVariableDbId) ?? [];
    vals.push(o.value);
    byVar.set(o.observationVariableDbId, vals);
  }

  const nonNumericWarned = new Set<string>();
  const rows: Record<string, unknown>[] = [];

  for (const [germplasmDbId, byVar] of groups) {
    const row: Record<string, unknown> = {
      germplasmDbId,
      germplasmName: germplasmNames.get(germplasmDbId) ?? germplasmDbId,
    };

    for (const col of variableColumns) {
      const varId = columnToVariable[col];
      const vals = varId ? byVar.get(varId) : undefined;
      if (!vals || vals.length === 0) {
        row[col] = null;
        continue;
      }
      row[col] = aggregateValues(vals, aggregate, varId as string, nonNumericWarned, warnings);
    }

    rows.push(row);
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function aggregateValues(
  values: string[],
  aggregate: 'mean' | 'median' | 'first',
  varId: string,
  nonNumericWarned: Set<string>,
  warnings: string[],
): string | number | null {
  if (aggregate === 'first') {
    return values[0] ?? null;
  }

  // numeric aggregation
  const nums = values.map((v) => Number(v)).filter((n) => !Number.isNaN(n));
  if (nums.length === 0) {
    if (!nonNumericWarned.has(varId)) {
      nonNumericWarned.add(varId);
      warnings.push(
        `Variable '${varId}': all values are non-numeric — cannot compute ${aggregate}. Cell set to null. Use aggregate:"first" or "all" for categorical traits.`,
      );
    }
    return null;
  }

  if (aggregate === 'mean') {
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  }

  // median (nums is non-empty here — guarded above)
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid];
  if (hi === undefined) return null;
  if (sorted.length % 2 !== 0) return hi;
  const lo = sorted[mid - 1];
  return lo === undefined ? hi : (lo + hi) / 2;
}
