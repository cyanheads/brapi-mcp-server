/**
 * @fileoverview `brapi_dataframe_query` — execute SQL across in-memory
 * dataframes. Dataframes auto-populate when find_* tools spill to DatasetStore
 * (each becomes `ds_<datasetId>`). Use `registerAs` to materialize a result
 * as a new dataframe — the response carries a bounded `preview` slice plus
 * the full `rowCount`. Read-only enforcement is the framework's three-layer
 * SQL gate (single statement → SELECT only → plan-walk allowlist).
 *
 * Defaults to a fresh per-tenant default workspace; the agent never passes a
 * canvasId. The bridge resolves it via `ctx.state` so multiple calls in the
 * same session reuse the same workspace.
 *
 * @module mcp-server/tools/definitions/brapi-dataframe-query.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import type { QueryResult } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge } from '@/services/canvas-bridge/index.js';

/**
 * Reasons the framework's `assertReadOnlyQuery` (and identifier validator)
 * attaches to its `validationError` throws — see
 * `@cyanheads/mcp-ts-core/dist/services/canvas/core/sqlGate.js`. When the
 * bridge's `query()` rethrows one of these, the handler translates it into
 * the typed `sql_rejected` contract reason while preserving the granular
 * gate reason on `data.gateReason`.
 */
const SQL_GATE_REASONS: ReadonlySet<string> = new Set([
  'multi_statement',
  'non_select_statement',
  'plan_operator_not_allowed',
  'identifier_empty',
  'identifier_shape',
  'identifier_reserved',
]);

function extractSqlGateReason(err: unknown): string | undefined {
  if (!(err instanceof McpError)) return;
  if (err.code !== JsonRpcErrorCode.ValidationError) return;
  const reason = (err.data as { reason?: unknown } | undefined)?.reason;
  return typeof reason === 'string' && SQL_GATE_REASONS.has(reason) ? reason : undefined;
}

const InputSchema = z.object({
  sql: z
    .string()
    .min(1)
    .describe(
      'SELECT statement against dataframes. Single statement only — writes, DDL, file reads, and exports are rejected. Use brapi_dataframe_describe to discover available dataframes.',
    ),
  registerAs: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/)
    .optional()
    .describe(
      'Persist the result as a new dataframe under this name. The response still returns at most `preview` rows; the full result remains queryable as a new dataframe. Conflicts with an existing dataframe name fail — drop first via brapi_dataframe_drop. Identifier rules: letters, digits, and underscores; must start with a letter or underscore; max 63 characters.',
    ),
  preview: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe(
      'Cap the number of rows returned in this response (1–1000). When omitted, the deployment-wide response cap applies (typically 10,000). Lower this with `registerAs` when you only need a sample to verify the query.',
    ),
  rowLimit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Hard cap on rows materialized into the response. Capped to the deployment-wide response cap (typically 10,000). For larger result sets, use `registerAs` to keep the full result queryable instead of raising this.',
    ),
});

const OutputSchema = z.object({
  rowCount: z
    .number()
    .int()
    .nonnegative()
    .describe('Total rows the query produced (may exceed `rows.length` when capped).'),
  columns: z
    .array(z.string().describe('Column name in projection order.'))
    .describe('Column names in projection order.'),
  rows: z
    .array(z.record(z.string(), z.unknown()).describe('One result row.'))
    .describe('Materialized rows, bounded by preview/rowLimit.'),
  dataframe: z
    .string()
    .optional()
    .describe(
      'Name of the dataframe holding the full result, populated when `registerAs` was supplied. Reference this name in follow-up queries.',
    ),
});

export const brapiDataframeQuery = tool('brapi_dataframe_query', {
  description:
    'Run SQL across in-memory dataframes. Dataframes auto-populate when find_* tools spill (named `ds_<datasetId>`); list them via brapi_dataframe_describe. SELECT only — writes/DDL/COPY/PRAGMA/ATTACH/file-reads are rejected. Use `registerAs` to chain — the result lands as a new dataframe.',
  annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  errors: [
    {
      reason: 'dataframe_disabled',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Dataframe surface is gated off by env (CANVAS_PROVIDER_TYPE != duckdb or BRAPI_CANVAS_ENABLED=false)',
      recovery:
        'Set CANVAS_PROVIDER_TYPE=duckdb and BRAPI_CANVAS_ENABLED=true on the deployment, or use brapi_manage_dataset for the underlying dataset.',
    },
    {
      reason: 'sql_rejected',
      code: JsonRpcErrorCode.ValidationError,
      when: 'SQL violated read-only rules (multi-statement, non-SELECT, or disallowed operation)',
      recovery:
        'Submit a single SELECT statement using only registered dataframes. For changes, use `registerAs` in this tool to materialize a result, or brapi_dataframe_drop to remove a dataframe.',
    },
  ] as const,
  input: InputSchema,
  output: OutputSchema,

  async handler(input, ctx) {
    const bridge = getCanvasBridge();
    if (!bridge.isEnabled()) {
      throw ctx.fail(
        'dataframe_disabled',
        'brapi_dataframe_query is unavailable — dataframes are not enabled on this deployment.',
        { ...ctx.recoveryFor('dataframe_disabled') },
      );
    }
    const queryOpts: { preview?: number; registerAs?: string; rowLimit?: number } = {};
    if (input.preview !== undefined) queryOpts.preview = input.preview;
    if (input.registerAs !== undefined) queryOpts.registerAs = input.registerAs;
    if (input.rowLimit !== undefined) queryOpts.rowLimit = input.rowLimit;

    let result: QueryResult;
    try {
      result = await bridge.query(ctx, input.sql, queryOpts);
    } catch (err) {
      const gateReason = extractSqlGateReason(err);
      if (gateReason === undefined) throw err;
      const message = err instanceof Error ? err.message : 'Query rejected.';
      throw ctx.fail(
        'sql_rejected',
        message,
        { gateReason, ...ctx.recoveryFor('sql_rejected') },
        { cause: err },
      );
    }
    const out: z.infer<typeof OutputSchema> = {
      rowCount: result.rowCount,
      columns: result.columns,
      rows: result.rows,
    };
    if (result.tableName !== undefined) out.dataframe = result.tableName;
    return out;
  },

  format: (result) => [{ type: 'text', text: renderQuery(result) }],
});

function renderQuery(result: z.infer<typeof OutputSchema>): string {
  const lines: string[] = [];
  const tableHint = result.dataframe ? ` · registered as \`${result.dataframe}\`` : '';
  lines.push(`# ${result.rowCount} row(s)${tableHint}`);
  lines.push(`- columns: ${result.columns.join(', ')}`);
  lines.push(`- returned: ${result.rows.length}`);
  if (result.rows.length === 0) {
    lines.push('');
    lines.push('_No rows._');
    return lines.join('\n');
  }
  lines.push('');
  lines.push('## Rows');
  for (const [i, row] of result.rows.entries()) {
    lines.push('');
    lines.push(`### Row ${i + 1}`);
    for (const col of result.columns) {
      const value = row[col];
      if (value === undefined || value === null) continue;
      const rendered = typeof value === 'object' ? JSON.stringify(value) : String(value);
      lines.push(`- **${col}:** ${rendered}`);
    }
  }
  return lines.join('\n');
}
