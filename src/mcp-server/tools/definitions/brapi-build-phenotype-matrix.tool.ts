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
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getBrapiClient } from '@/services/brapi-client/index.js';
import { resolveDialect } from '@/services/brapi-dialect/index.js';
import { getCanvasBridge } from '@/services/canvas-bridge/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import { buildUniqueColumns } from '../shared/canvas-columns.js';
import {
  AliasInput,
  DataframeHandleSchema,
  ExtraFiltersInput,
  LoadLimitInput,
  renderDataframeHandle,
  requireRegisteredConnection,
} from '../shared/find-helpers.js';
import { type NormObs, pullStudyObservations } from '../shared/observations.js';

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

const OutputSchema = z.object({
  alias: z.string().describe('Alias of the registered BrAPI connection the call used.'),
  studies: z.array(z.string()).describe('studyDbIds that were queried to build the matrix.'),
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
      'Mapping of safe column identifier → observationVariableName. Wide-matrix column names are SQL-safe identifiers derived from observationVariableDbId (sanitized for DuckDB); consult this map to resolve a column back to its variable display name.',
    ),
  dataframe: DataframeHandleSchema.optional().describe(
    'Canvas dataframe handle for the materialized matrix. Omitted when no observations were found. Query with brapi_dataframe_query (SQL). Long-form columns: germplasmDbId, observationVariableDbId, studyDbId, value, replicateIndex. Wide-form columns: germplasmDbId, germplasmName, one column per variable (SQL-safe identifier derived from observationVariableDbId — see variableLegend).',
  ),
  warnings: z
    .array(z.string())
    .describe('Advisory messages (empty studies, non-numeric aggregation skips, fallback paths).'),
});

type Output = z.infer<typeof OutputSchema>;

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const brapiBuildPhenotypeMatrix = tool('brapi_build_phenotype_matrix', {
  description:
    'Pull observations across one or more studies and pivot them into a germplasm × trait matrix materialized as a canvas dataframe. Returns a dataframe handle (query with brapi_dataframe_query) plus a summary of dimensions and aggregate method. Long-form output is suitable for downstream GROUP BY analysis by study, germplasm, or variable.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'unknown_alias',
      code: JsonRpcErrorCode.NotFound,
      when: 'No connection has been registered under the requested alias',
      recovery:
        'Run brapi_connect with this alias (or omit `alias` to use the default connection) before calling brapi_build_phenotype_matrix.',
    },
    {
      reason: 'all_filters_dropped',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The active dialect dropped every filter supplied — the call would silently widen to the unfiltered baseline',
      recovery:
        'Drop unsupported filters or use studies / germplasm / variables to scope the query to supported filter paths on the active dialect.',
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
      .array(z.string())
      .min(1)
      .describe(
        'studyDbIds to include in the matrix. At least one is required — the tool is study-anchored to avoid full-table scans.',
      ),
    variables: z
      .array(z.string())
      .optional()
      .describe(
        'Optional subset of observationVariableDbIds to include. Omit to include all variables found in the queried studies.',
      ),
    germplasm: z
      .array(z.string())
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
    loadLimit: LoadLimitInput,
    extraFilters: ExtraFiltersInput,
  }),
  output: OutputSchema,

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
    const allObs: NormObs[] = [];

    // Collect observations study-by-study. Isolation per study avoids
    // unbounded queries and preserves studyDbId on each row.
    for (const studyDbId of input.studies) {
      const studyObs = await pullStudyObservations({
        studyDbId,
        input,
        client,
        connection,
        profile: profile.supported,
        dialect,
        config,
        loadLimit,
        warnings,
        ctx,
      });

      if (studyObs === null) {
        throw ctx.fail(
          'no_observation_path',
          `Neither /observations nor /observationunits returned a usable path for study '${studyDbId}'. Check brapi_server_info for the capability list.`,
          { ...ctx.recoveryFor('no_observation_path'), studyDbId },
        );
      }

      allObs.push(...studyObs);
    }

    // Apply variable and germplasm filters if requested
    const filteredObs = filterObservations(allObs, input.variables, input.germplasm);

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
    lines.push(`Studies queried: ${result.studies.join(', ')}`);
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

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

function filterObservations(obs: NormObs[], variables?: string[], germplasm?: string[]): NormObs[] {
  let result = obs;
  if (variables?.length) {
    const set = new Set(variables);
    result = result.filter((o) => set.has(o.observationVariableDbId));
  }
  if (germplasm?.length) {
    const set = new Set(germplasm);
    result = result.filter((o) => set.has(o.germplasmDbId));
  }
  return result;
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
