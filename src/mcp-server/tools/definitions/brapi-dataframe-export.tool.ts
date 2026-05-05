/**
 * @fileoverview `brapi_dataframe_export` — write a dataframe to disk in a
 * researcher-friendly format (CSV, Parquet, JSON) and return the absolute
 * path. Hands off the file to the human; the agent doesn't read it back.
 *
 * Stdio-only and gated behind `BRAPI_EXPORT_DIR` — the entry point bridges
 * `BRAPI_EXPORT_DIR` → the framework's `CANVAS_EXPORT_PATH` so the canvas
 * provider's path-traversal sandbox stays in charge of resolution. Under
 * `MCP_TRANSPORT_TYPE=http` or with `BRAPI_EXPORT_DIR` unset, the tool is
 * omitted from `tools/list` entirely (operators see the gate reason on
 * `/.well-known/mcp.json`).
 *
 * Optional `columns` (thin projection) or `sql` (full SELECT) materialize a
 * temporary canvas table first, export it, then drop it. The dataframe input
 * always identifies the *source* dataframe — that's the name the paired-drop
 * cleanup keys off of when `brapi_dataframe_drop` later removes it.
 *
 * @module mcp-server/tools/definitions/brapi-dataframe-export.tool
 */

import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import type { ExportResult } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getCanvasBridge } from '@/services/canvas-bridge/index.js';

const ColumnNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/)
  .describe(
    'Column name to project — letters, digits, underscores; must start with a letter or underscore; max 63 chars.',
  );

const InputSchema = z.object({
  dataframe: z
    .string()
    .min(1)
    .describe(
      'Dataframe to export. Use brapi_dataframe_describe to discover names. Source identity for the export — paired-drop cleanup keys off this name when brapi_dataframe_drop later removes it.',
    ),
  format: z
    .enum(['csv', 'parquet', 'json'])
    .describe(
      'Output format. CSV opens in Excel / Tad; Parquet preserves typed columns and is small on disk; JSON is line-delimited.',
    ),
  filename: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional filename inside BRAPI_EXPORT_DIR. Path separators ("/", "\\") and ".." segments are rejected. Re-using a name overwrites the existing file. Omit to get a timestamp-suffixed default that never collides.',
    ),
  columns: z
    .array(ColumnNameSchema)
    .min(1)
    .optional()
    .describe(
      'Optional thin projection — exports only these columns. Mutually exclusive with `sql`. For filtering or aggregation, run brapi_dataframe_query with registerAs first, then export that derived dataframe.',
    ),
  sql: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional SELECT statement that defines what to export — same SQL gate as brapi_dataframe_query (SELECT only, single statement, plan-walk allowlist). Mutually exclusive with `columns`. The dataframe input still identifies the source for paired-drop cleanup.',
    ),
});

const ColumnInfoSchema = z.object({
  name: z.string().describe('Column name in projection order.'),
  type: z.string().describe('SQL/DuckDB column type (VARCHAR, BIGINT, DOUBLE, BOOLEAN, JSON, …).'),
});

const OutputSchema = z.object({
  dataframe: z.string().describe('Source dataframe the export was derived from.'),
  format: z.enum(['csv', 'parquet', 'json']).describe('Format that was written.'),
  path: z.string().describe('Absolute path to the export file on the host filesystem.'),
  filename: z.string().describe('Filename inside BRAPI_EXPORT_DIR (basename only).'),
  sizeBytes: z.number().int().nonnegative().describe('Bytes written.'),
  rowCount: z.number().int().nonnegative().describe('Rows written to the file.'),
  columns: z
    .array(ColumnInfoSchema.describe('One column descriptor — name and SQL/DuckDB type.'))
    .describe('Column metadata for the exported file in projection order.'),
  expiresAt: z
    .string()
    .describe(
      'ISO 8601 staleness hint — when the source dataframe will TTL out and any paired sweep will reap this file. The file itself persists on disk independently.',
    ),
});

export const brapiDataframeExport = tool('brapi_dataframe_export', {
  description:
    'Export a dataframe to disk (CSV, Parquet, or JSON) under BRAPI_EXPORT_DIR and return the absolute path of a file the human can open in Excel, Tad, DuckDB CLI, etc. Source dataframes are immutable after spillover, so re-exporting the same df_<uuid> is byte-stable. Use `columns` for thin projection or `sql` for filtering/aggregation; for repeated derived views, query with registerAs first then export the derived dataframe.',
  annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  errors: [
    {
      reason: 'export_dir_unset',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'BRAPI_EXPORT_DIR is not configured (defensive — the registration gate normally hides the tool when this happens)',
      recovery: 'Set BRAPI_EXPORT_DIR on the server before retrying.',
    },
    {
      reason: 'dataframe_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No dataframe with this name exists on the canvas (expired, dropped, or typo)',
      recovery: 'Call brapi_dataframe_describe to list available dataframes.',
    },
    {
      reason: 'invalid_filename',
      code: JsonRpcErrorCode.ValidationError,
      when: 'filename contains path separators or traversal segments',
      recovery:
        'Provide a filename without "/", "\\", or ".." — leave it unset to use the default.',
    },
    {
      reason: 'mutually_exclusive_projection',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both `columns` and `sql` were supplied',
      recovery:
        'Pass either `columns` for a thin projection or `sql` for filtering/aggregation, not both.',
    },
  ] as const,
  input: InputSchema,
  output: OutputSchema,

  async handler(input, ctx) {
    const config = getServerConfig();
    if (!config.exportDir) {
      throw ctx.fail('export_dir_unset', undefined, { ...ctx.recoveryFor('export_dir_unset') });
    }
    if (input.columns && input.sql) {
      throw ctx.fail('mutually_exclusive_projection', undefined, {
        ...ctx.recoveryFor('mutually_exclusive_projection'),
      });
    }

    const filename = resolveFilename(input, ctx);
    const bridge = getCanvasBridge();

    const sourceTables = await bridge.describe(ctx, { tableName: input.dataframe });
    if (sourceTables.length === 0) {
      throw ctx.fail('dataframe_not_found', `Dataframe "${input.dataframe}" not found.`, {
        ...ctx.recoveryFor('dataframe_not_found'),
      });
    }

    await sweepStaleExports(config.exportDir, config.datasetTtlSeconds, ctx);

    const projection = input.columns ?? input.sql;
    const derivedName =
      projection !== undefined
        ? `_brapi_export_${crypto.randomUUID().replace(/-/g, '_')}`
        : undefined;
    const tableToExport = derivedName ?? input.dataframe;

    if (derivedName !== undefined) {
      const sql = input.sql ?? buildProjectionSql(input.dataframe, input.columns ?? []);
      await bridge.query(ctx, sql, { registerAs: derivedName, preview: 1 });
    }

    let exportResult: ExportResult;
    let exportedColumns: { name: string; type: string }[];
    try {
      const exportTables = await bridge.describe(ctx, { tableName: tableToExport });
      exportedColumns = (exportTables[0]?.columns ?? []).map((c) => ({
        name: c.name,
        type: c.type,
      }));
      exportResult = await bridge.export(
        ctx,
        tableToExport,
        { format: input.format, path: filename },
        { signal: ctx.signal },
      );
      if (exportResult.path) {
        await bridge.trackExport(ctx, input.dataframe, exportResult.path);
      }
    } finally {
      if (derivedName !== undefined) {
        try {
          await bridge.drop(ctx, derivedName);
        } catch (err) {
          ctx.log.warning('Failed to drop derived export-projection table', {
            tableName: derivedName,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return {
      dataframe: input.dataframe,
      format: input.format,
      path: exportResult.path ?? '',
      filename,
      sizeBytes: exportResult.sizeBytes,
      rowCount: exportResult.rowCount,
      columns: exportedColumns,
      expiresAt:
        sourceTables[0]?.provenance?.expiresAt ?? expiresAtFromConfig(config.datasetTtlSeconds),
    };
  },

  format: (result) => [{ type: 'text', text: renderExport(result) }],
});

const FILENAME_REJECT = /[/\\]|^\.\.$|\.\.[/\\]|[/\\]\.\./;

type ExportContext = Parameters<typeof brapiDataframeExport.handler>[1];

function resolveFilename(input: z.infer<typeof InputSchema>, ctx: ExportContext): string {
  if (input.filename !== undefined) {
    if (FILENAME_REJECT.test(input.filename) || input.filename === '..') {
      throw ctx.fail('invalid_filename', `Filename "${input.filename}" is not allowed.`, {
        ...ctx.recoveryFor('invalid_filename'),
      });
    }
    return input.filename;
  }
  return defaultFilename(input.dataframe, input.format);
}

function defaultFilename(dataframe: string, format: 'csv' | 'parquet' | 'json'): string {
  const stamp = Math.floor(Date.now() / 1000);
  return `${dataframe}-${stamp}.${format}`;
}

function buildProjectionSql(dataframe: string, columns: string[]): string {
  return `SELECT ${columns.join(', ')} FROM ${dataframe}`;
}

function expiresAtFromConfig(ttlSeconds: number): string {
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

/**
 * Best-effort sweep of stale export files. Walks `BRAPI_EXPORT_DIR` and
 * unlinks any regular file with `mtime + ttlSeconds < now`. Errors are
 * swallowed (including a missing directory — DuckDB's `mkdir` will create
 * it on first export). Bounded work: typical export directories hold tens
 * of files at most.
 */
async function sweepStaleExports(dir: string, ttlSeconds: number, ctx: Context): Promise<void> {
  try {
    const entries = await readdir(dir);
    const cutoff = Date.now() - ttlSeconds * 1000;
    await Promise.allSettled(
      entries.map(async (name) => {
        const path = join(dir, name);
        try {
          const info = await stat(path);
          if (info.isFile() && info.mtimeMs < cutoff) await unlink(path);
        } catch {
          /* file vanished between stat and unlink — fine. */
        }
      }),
    );
  } catch (err) {
    ctx.log.debug('Export-dir sweep skipped', {
      dir,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function renderExport(result: z.infer<typeof OutputSchema>): string {
  const lines: string[] = [];
  lines.push(`# Exported \`${result.dataframe}\` → \`${result.filename}\``);
  lines.push(`- format: ${result.format}`);
  lines.push(`- path: ${result.path}`);
  lines.push(`- rows: ${result.rowCount}`);
  lines.push(`- bytes: ${result.sizeBytes}`);
  lines.push(`- columns: ${result.columns.map((c) => `${c.name} (${c.type})`).join(', ')}`);
  lines.push(`- expiresAt: ${result.expiresAt}`);
  return lines.join('\n');
}
