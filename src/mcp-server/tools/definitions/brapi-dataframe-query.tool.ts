/**
 * @fileoverview `brapi_dataframe_query` — execute SQL across in-memory
 * dataframes. Dataframes auto-populate when find_* tools spill (each becomes
 * `df_<uuid>`). SQL is the primary paging idiom — use `LIMIT/OFFSET` to walk
 * a large dataframe, projection (`SELECT col1, col2`) to trim rows, and
 * aggregation (`COUNT`, `GROUP BY`, `AVG`) to summarize without materializing
 * every row in the LLM context. Use `registerAs` to materialize a result as
 * a new dataframe — the response carries a bounded `preview` slice plus the
 * full `rowCount`. Read-only enforcement is the framework's five-layer SQL
 * gate (file-function deny-list → single statement → SELECT only → parse-tree
 * check → plan-walk allowlist) over a DuckDB instance with file access off.
 *
 * Every query runs under a `registerAs` so DuckDB's describe is the
 * authoritative type source for the response columns. When the caller
 * doesn't supply `registerAs`, the handler generates an internal
 * `_brapi_probe_<uuid>` name, describes the materialized table for types,
 * then drops it before returning — so types stay consistent with what
 * `brapi_dataframe_describe` would report. Error messages are rewritten so
 * DuckDB's line excerpt quotes the caller's SQL, never that wrapping
 * `CREATE TABLE … AS` statement, and a statement that wrapper cannot take
 * (DESCRIBE, SUMMARIZE, SHOW) is rejected as `sql_rejected`.
 *
 * Defaults to the session's (else the tenant's) workspace; the agent never passes a
 * canvasId. The bridge resolves it via `ctx.state` so multiple calls in the
 * same session reuse the same workspace.
 *
 * @module mcp-server/tools/definitions/brapi-dataframe-query.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import {
  DUCKDB_ERROR_REASONS,
  inferSchemaFromRows,
  type QueryResult,
  quoteIdentifier,
  SQL_GATE_REASONS,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  type CanvasBridge,
  getCanvasBridge,
  SYSTEM_CATALOG_ACCESS_REASON,
} from '@/services/canvas-bridge/index.js';

/**
 * Refusals that reach the caller as the typed `sql_rejected` contract reason,
 * with the granular reason kept on `data.gateReason`: the framework's SQL gate,
 * the engine's read-only refusal (`sql_read_only` — a write, or a file or URL
 * named as a table), and the server-local system-catalog deny
 * ({@link SYSTEM_CATALOG_ACCESS_REASON}).
 */
const REFUSAL_REASONS: ReadonlySet<string> = new Set<string>([
  ...Object.values(SQL_GATE_REASONS),
  DUCKDB_ERROR_REASONS.sqlReadOnly,
  SYSTEM_CATALOG_ACCESS_REASON,
]);

/**
 * DuckDB's parser class, as `@duckdb/node-api` reports it (behind `Failed to
 * extract statements:`). The gate parses the caller's SQL on its own and admits
 * DESCRIBE, SUMMARIZE, and SHOW as SELECTs, but every query here runs as
 * `CREATE TABLE … AS <sql>`, which takes only a query, so those fail to parse
 * there. The framework's canvas classifies that parser error by a class prefix
 * anchored at the start, so it arrives as an untyped `DatabaseError`; a
 * classified one carries `sql_parse_error`.
 */
const ENGINE_PARSER_ERROR = /^(?:Failed to extract statements: )?Parser Error\b/;

const NOT_A_QUERY_MESSAGE =
  'Canvas SQL rejected: the statement does not run as a query here. brapi_dataframe_query takes a SELECT (FROM-first and VALUES forms included); DESCRIBE, SUMMARIZE, and SHOW are not accepted. List a dataframe’s columns and types with brapi_dataframe_describe, or compute summary statistics with a SELECT over COUNT, AVG, MIN, and MAX.';

/** True for a parser error the gate let through — see {@link ENGINE_PARSER_ERROR}. */
function isParserFailure(err: McpError, reason: string | undefined): boolean {
  if (reason === DUCKDB_ERROR_REASONS.sqlParseError) return true;
  return (
    reason === undefined &&
    err.code === JsonRpcErrorCode.DatabaseError &&
    ENGINE_PARSER_ERROR.test(err.message)
  );
}

function reasonOf(err: McpError): string | undefined {
  const reason = (err.data as { reason?: unknown } | undefined)?.reason;
  return typeof reason === 'string' ? reason : undefined;
}

/**
 * Forward the canvas error's structured context (e.g. `catalog` for
 * system_catalog_access, `operators` for plan_operator_not_allowed,
 * `tableName` for missing_table) so structured-only consumers see which
 * element matched without parsing the message text. `reason` is replaced by
 * the contract reason (and kept as `gateReason` for refusals); `recovery` is
 * replaced by the contract recovery hint.
 */
function extractGateContext(err: McpError): Record<string, unknown> {
  if (err.data === null || typeof err.data !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(err.data)) {
    if (k !== 'reason' && k !== 'recovery') out[k] = v;
  }
  return out;
}

const EXCERPT_INDICATOR = 'LINE 1: ';
const LINE_ONE_EXCERPT = /\n\nLINE 1: (\.\.\.)?(.*)\n( *)\^/;

/**
 * DuckDB renders the failing line of a statement under its message (`LINE n:`
 * plus a caret under the failing token). Every query here runs as the
 * framework's `CREATE TABLE "<registerAs>" AS <sql>` — the caller's
 * `registerAs` or the internal type-probe name — so a line-1 excerpt can show
 * that wrapper, which the caller never sent. Cut the wrapper out of the
 * excerpt and move the caret with it, so the excerpt quotes only the caller's
 * SQL; drop the excerpt when the failing token sits inside the wrapper itself.
 * An excerpt that is not of the wrapped statement (a prepare-time error quotes
 * the caller's SQL alone) is left as DuckDB wrote it.
 */
function quoteCallerSql(message: string, sql: string, tableName: string): string {
  const match = LINE_ONE_EXCERPT.exec(message);
  if (!match) return message;
  const [block, lead = '', body = '', pad = ''] = match;
  const wrapper = `CREATE TABLE ${quoteIdentifier(tableName)} AS `;
  const searchable = body.endsWith('...') ? body.slice(0, -3) : body;
  const wrapped = wrapper + sql;
  const offset = lead ? wrapped.indexOf(searchable) : wrapped.startsWith(searchable) ? 0 : -1;
  if (offset < 0 || offset >= wrapper.length) return message;
  const cut = wrapper.length - offset;
  const caretColumn = pad.length - lead.length - cut;
  const excerpt =
    caretColumn < EXCERPT_INDICATOR.length
      ? ''
      : `\n\n${EXCERPT_INDICATOR}${body.slice(cut)}\n${' '.repeat(caretColumn)}^`;
  return message.slice(0, match.index) + excerpt + message.slice(match.index + block.length);
}

const InputSchema = z.object({
  sql: z
    .string()
    .min(1)
    .describe(
      'SELECT statement against dataframes. Single statement only — writes, DDL, DESCRIBE / SUMMARIZE, file reads, and exports are rejected. Use brapi_dataframe_describe to discover available dataframes. SQL is the primary paging idiom: use `LIMIT/OFFSET` to walk a large dataframe, projection to trim columns, and aggregation (`COUNT`, `GROUP BY`, `AVG`) to summarize without materializing every row.',
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
    .optional()
    .describe(
      'Cap the number of rows returned in this response. A value above `rowLimit` (or, when `rowLimit` is omitted, above the deployment-wide response cap) returns rows up to that ceiling. When omitted, the ceiling applies. Lower this with `registerAs` when you only need a sample to verify the query.',
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
      'DuckDB column type (e.g. VARCHAR, BIGINT, DOUBLE, BOOLEAN, JSON), the same with or without `registerAs`.',
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
    .describe('Column names and types in projection order, enough to write a follow-up query.'),
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
      when: 'SQL broke the read-only rules: more than one statement, a non-SELECT, a disallowed operation or function, a file or URL named as a table, a system-catalog read, or a DESCRIBE, SUMMARIZE, or SHOW statement',
      recovery:
        'Submit a single SELECT statement using only registered dataframes. For changes, use `registerAs` in this tool to materialize a result, or brapi_dataframe_drop to remove a dataframe.',
    },
    {
      reason: 'sql_execution_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SELECT passed the read-only rules but failed while running on the staged data, such as a cast of a value that does not convert',
      recovery:
        'Fix the expression the message points at: use TRY_CAST for conversions, or filter out the rows that fail, then resubmit the query.',
    },
    {
      reason: 'missing_table',
      code: JsonRpcErrorCode.NotFound,
      when: 'The SQL names a dataframe this workspace does not hold, because it expired, was dropped, or the name is mistyped',
      recovery:
        'Re-run the tool that produced it to stage a fresh copy, or check the exact name with brapi_dataframe_describe.',
    },
    {
      reason: 'register_as_clash',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The registerAs name is already taken by a dataframe in this workspace',
      recovery:
        'Choose a different `registerAs` name, or remove the existing dataframe with brapi_dataframe_drop where this deployment enables it.',
    },
  ] as const,
  input: InputSchema,
  output: OutputSchema,
  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe('True when the response carries fewer rows than the query produced.'),
    shown: z.number().int().nonnegative().optional().describe('Rows materialized into `rows`.'),
    cap: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Row ceiling that bound the response: the smallest of preview, rowLimit, and the deployment-wide response cap.',
      ),
    notice: z
      .string()
      .optional()
      .describe('Guidance for reaching the rows this response left out.'),
  },

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
      if (!(err instanceof McpError)) throw err;
      const reason = reasonOf(err);
      if (isParserFailure(err, reason)) {
        throw ctx.fail(
          'sql_rejected',
          NOT_A_QUERY_MESSAGE,
          { gateReason: DUCKDB_ERROR_REASONS.sqlParseError },
          { cause: err },
        );
      }
      const message = quoteCallerSql(err.message, input.sql, probeName);
      const context = extractGateContext(err);
      if (
        reason !== undefined &&
        REFUSAL_REASONS.has(reason) &&
        err.code === JsonRpcErrorCode.ValidationError
      ) {
        throw ctx.fail('sql_rejected', message, { gateReason: reason, ...context }, { cause: err });
      }
      if (reason === 'sql_execution_error') {
        throw ctx.fail('sql_execution_error', message, context, { cause: err });
      }
      if (reason === 'missing_table') {
        throw ctx.fail('missing_table', message, context, { cause: err });
      }
      if (reason === 'register_as_clash') {
        throw ctx.fail('register_as_clash', message, context, { cause: err });
      }
      if (message === err.message) throw err;
      throw new McpError(err.code, message, err.data, { cause: err });
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

    if (out.rows.length < out.rowCount) {
      // Three ceilings can bind here — `preview`, the caller's `rowLimit`, and
      // the deployment-wide cap the bridge clamps both to — and the rows that
      // came back are exactly the one that did, so report that count as the
      // cap and name the lever that produced it.
      const shown = out.rows.length;
      const lever =
        input.preview !== undefined && shown === input.preview
          ? '`preview`'
          : input.rowLimit !== undefined && shown === input.rowLimit
            ? '`rowLimit`'
            : 'The deployment-wide response cap';
      ctx.enrich.truncated({
        shown,
        cap: shown,
        guidance: `${lever} bound the response at ${shown} of ${out.rowCount} rows. ${
          userRegisterAs
            ? `Query \`${userRegisterAs}\` with LIMIT/OFFSET to walk the remainder, or aggregate instead of materializing it.`
            : 'Re-run with `registerAs` to keep the full result queryable, then page it with LIMIT/OFFSET.'
        }`,
      });
    }
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
