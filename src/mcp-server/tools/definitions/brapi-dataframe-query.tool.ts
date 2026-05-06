/**
 * @fileoverview `brapi_dataframe_query` — execute SQL across in-memory
 * dataframes. Dataframes auto-populate when find_* tools spill (each becomes
 * `df_<uuid>`). SQL is the primary paging idiom — use `LIMIT/OFFSET` to walk
 * a large dataframe, projection (`SELECT col1, col2`) to trim rows, and
 * aggregation (`COUNT`, `GROUP BY`, `AVG`) to summarize without materializing
 * every row in the LLM context. Use `registerAs` to materialize a result as
 * a new dataframe — the response carries a bounded `preview` slice plus the
 * full `rowCount`. Read-only enforcement is the framework's three-layer SQL
 * gate (single statement → SELECT only → plan-walk allowlist).
 *
 * Every query runs under a `registerAs` so DuckDB's describe is the
 * authoritative type source for the response columns. When the caller
 * doesn't supply `registerAs`, the handler generates an internal
 * `_brapi_probe_<uuid>` name, describes the materialized table for types,
 * then drops it before returning — so types stay consistent with what
 * `brapi_dataframe_describe` would report.
 *
 * Defaults to a fresh per-tenant default workspace; the agent never passes a
 * canvasId. The bridge resolves it via `ctx.state` so multiple calls in the
 * same session reuse the same workspace.
 *
 * @module mcp-server/tools/definitions/brapi-dataframe-query.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import {
  inferSchemaFromRows,
  type QueryResult,
  SQL_GATE_REASONS,
  type SqlGateReason,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  type CanvasBridge,
  getCanvasBridge,
  SYSTEM_CATALOG_ACCESS_REASON,
} from '@/services/canvas-bridge/index.js';

/**
 * Recognized gate reasons spanning the framework's SQL gate plus the
 * server-local system-catalog deny ({@link SYSTEM_CATALOG_ACCESS_REASON}).
 * When `bridge.query()` rethrows a `validationError`, the handler translates
 * it into the typed `sql_rejected` contract reason while preserving the
 * granular gate reason on `data.gateReason`.
 */
type LocalGateReason = SqlGateReason | typeof SYSTEM_CATALOG_ACCESS_REASON;
const KNOWN_GATE_REASONS: ReadonlySet<LocalGateReason> = new Set<LocalGateReason>([
  ...Object.values(SQL_GATE_REASONS),
  SYSTEM_CATALOG_ACCESS_REASON,
]);

function extractSqlGateReason(err: unknown): LocalGateReason | undefined {
  if (!(err instanceof McpError)) return;
  if (err.code !== JsonRpcErrorCode.ValidationError) return;
  const reason = (err.data as { reason?: unknown } | undefined)?.reason;
  return typeof reason === 'string' && (KNOWN_GATE_REASONS as ReadonlySet<string>).has(reason)
    ? (reason as LocalGateReason)
    : undefined;
}

/**
 * Forward the gate's structured context (e.g. `catalog` for system_catalog_access,
 * `operators` for plan_operator_not_allowed, `statementType` for non_select_statement)
 * so structured-only consumers see which specific element matched without parsing
 * the message text. `reason` becomes `gateReason` upstream; `recovery` is
 * overridden by the contract recovery hint.
 */
function extractGateContext(err: unknown): Record<string, unknown> {
  if (!(err instanceof McpError) || err.data === null || typeof err.data !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(err.data)) {
    if (k !== 'reason' && k !== 'recovery') out[k] = v;
  }
  return out;
}

const InputSchema = z.object({
  sql: z
    .string()
    .min(1)
    .describe(
      'SELECT statement against dataframes. Single statement only — writes, DDL, file reads, and exports are rejected. Use brapi_dataframe_describe to discover available dataframes. SQL is the primary paging idiom: use `LIMIT/OFFSET` to walk a large dataframe, projection to trim columns, and aggregation (`COUNT`, `GROUP BY`, `AVG`) to summarize without materializing every row.',
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
      'Cap the number of rows returned in this response (1–1000). When omitted, the deployment-wide response cap applies. Lower this with `registerAs` when you only need a sample to verify the query.',
    ),
  rowLimit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Hard cap on rows materialized into the response, bounded by the deployment-wide response cap. For larger result sets, use `registerAs` to keep the full result queryable instead of raising this.',
    ),
});

const ColumnInfoSchema = z.object({
  name: z.string().describe('Column name in projection order.'),
  type: z
    .string()
    .describe(
      'SQL/DuckDB column type (e.g. VARCHAR, BIGINT, DOUBLE, BOOLEAN, JSON) sourced from DuckDB schema metadata. The same type appears whether or not `registerAs` was supplied — without it, the handler runs an internal probe to recover authoritative types that would otherwise be lost when DuckDB BigInts serialize to JSON strings.',
    ),
});

const OutputSchema = z.object({
  rowCount: z
    .number()
    .int()
    .nonnegative()
    .describe('Total rows the query produced (may exceed `rows.length` when capped).'),
  columns: z
    .array(ColumnInfoSchema.describe('One column descriptor — name and SQL/DuckDB type.'))
    .describe(
      'Column metadata in projection order — name and SQL type. Use this to write follow-up queries without round-tripping through brapi_dataframe_describe.',
    ),
  rows: z
    .array(
      z
        .record(z.string(), z.unknown())
        .describe(
          'One result row. Columns are projected from the SQL SELECT clause; call brapi_dataframe_describe to inspect source dataframe schemas.',
        ),
    )
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
    'Run SQL across in-memory dataframes. Dataframes auto-populate when find_* tools spill (named `df_<uuid>`) — the dataframe name appears inline on every find_* response that spilled (`result.dataframe.tableName`), so the typical flow is find_* → read the name → query here. Use brapi_dataframe_describe to inspect schema and provenance for a known name. SELECT only — writes/DDL/COPY/PRAGMA/ATTACH/file-reads are rejected. Use SQL as the paging idiom: `LIMIT/OFFSET` to walk results, projection to trim columns, aggregation to summarize. Use `registerAs` to chain — the result lands as a new dataframe.',
  annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  errors: [
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
    const userRegisterAs = input.registerAs;
    const probeName = userRegisterAs ?? `_brapi_probe_${crypto.randomUUID().replace(/-/g, '_')}`;
    const queryOpts: { preview?: number; registerAs: string; rowLimit?: number } = {
      registerAs: probeName,
    };
    if (input.preview !== undefined) queryOpts.preview = input.preview;
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
        { gateReason, ...extractGateContext(err), ...ctx.recoveryFor('sql_rejected') },
        { cause: err },
      );
    }

    let typedColumns: { name: string; type: string }[];
    try {
      typedColumns = await resolveTypedColumns(bridge, ctx, result, probeName);
    } finally {
      if (userRegisterAs === undefined) {
        try {
          await bridge.drop(ctx, probeName);
        } catch (err) {
          ctx.log.warning('Failed to drop ephemeral type-probe table', {
            tableName: probeName,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    const out: z.infer<typeof OutputSchema> = {
      rowCount: result.rowCount,
      columns: typedColumns,
      rows: result.rows,
    };
    if (userRegisterAs !== undefined) out.dataframe = userRegisterAs;
    return out;
  },

  format: (result) => [{ type: 'text', text: renderQuery(result) }],
});

/**
 * Build typed column metadata for the response. The handler always runs the
 * query under a `registerAs` (caller-supplied or an internal `_brapi_probe_*`
 * temp name), so DuckDB's `describe()` is the authoritative type source —
 * it preserves BIGINT, DOUBLE, TIMESTAMP, and DECIMAL through the round-trip
 * that JSON serialization would otherwise flatten to VARCHAR. Falls through
 * to row inference only when describe can't see the table (test fakes that
 * don't honor `registerAs`) and finally to UNKNOWN for empty results.
 */
async function resolveTypedColumns(
  bridge: CanvasBridge,
  ctx: Context,
  result: QueryResult,
  tableName: string,
): Promise<{ name: string; type: string }[]> {
  const tables = await bridge.describe(ctx, { tableName });
  const described = tables[0];
  if (described && described.columns.length > 0) {
    return described.columns.map((c) => ({ name: c.name, type: c.type }));
  }
  if (result.rows.length > 0) {
    const inferred = inferSchemaFromRows(result.rows);
    const byName = new Map(inferred.map((c) => [c.name, c.type]));
    return result.columns.map((name) => ({
      name,
      type: byName.get(name) ?? 'VARCHAR',
    }));
  }
  return result.columns.map((name) => ({ name, type: 'UNKNOWN' }));
}

function renderQuery(result: z.infer<typeof OutputSchema>): string {
  const lines: string[] = [];
  const tableHint = result.dataframe ? ` · registered as \`${result.dataframe}\`` : '';
  lines.push(`# ${result.rowCount} row(s)${tableHint}`);
  const columnList = result.columns.map((c) => `${c.name} (${c.type})`).join(', ');
  lines.push(`- columns: ${columnList}`);
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
      const value = row[col.name];
      if (value === undefined || value === null) continue;
      const rendered = typeof value === 'object' ? JSON.stringify(value) : String(value);
      lines.push(`- **${col.name}:** ${rendered}`);
    }
  }
  return lines.join('\n');
}
