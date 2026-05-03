/**
 * @fileoverview `brapi_dataframe_describe` — list dataframes (or describe one)
 * with column schema, row count, and originating-dataset provenance.
 * Auto-registered dataset dataframes (`ds_<datasetId>`) carry full source
 * metadata (originating tool, baseUrl, query, expiry); user-derived dataframes
 * created via `brapi_dataframe_query({ registerAs })` only show structural info.
 *
 * @module mcp-server/tools/definitions/brapi-dataframe-describe.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge } from '@/services/canvas-bridge/index.js';

const ColumnSchema = z.object({
  name: z.string().describe('Column name.'),
  type: z.string().describe('SQL column type (VARCHAR, INTEGER, DOUBLE, BOOLEAN, etc.).'),
  nullable: z.boolean().optional().describe('True when NULL values are allowed.'),
});

const ProvenanceSchema = z.object({
  datasetId: z
    .string()
    .describe(
      'Originating dataset ID — pass to brapi_manage_dataset to operate on the underlying rows.',
    ),
  source: z.string().describe('Tool/operation that produced the dataset (e.g. find_observations).'),
  baseUrl: z.string().describe('BrAPI base URL the dataset was pulled from.'),
  query: z.unknown().describe('Original filter map / search body.'),
  createdAt: z.string().describe('ISO 8601 dataset creation time.'),
  expiresAt: z.string().describe('ISO 8601 expiry — when the dataframe will be evicted.'),
});

const DescribedTableSchema = z.object({
  name: z.string().describe('Dataframe name. Use this in SQL queries.'),
  rowCount: z.number().int().nonnegative().describe('Rows currently registered.'),
  columns: z
    .array(ColumnSchema.describe('Column declaration.'))
    .describe('Schema in declaration order.'),
  approxSizeBytes: z.number().int().nonnegative().optional().describe('Approximate size in bytes.'),
  provenance: ProvenanceSchema.optional().describe(
    'Originating dataset provenance — present only for auto-registered dataframes (`ds_*`).',
  ),
});

const OutputSchema = z.object({
  tables: z
    .array(DescribedTableSchema.describe('Dataframe description.'))
    .describe('All described dataframes.'),
});

const InputSchema = z.object({
  dataframe: z
    .string()
    .min(1)
    .optional()
    .describe('When set, return only the named dataframe. Omit to list all dataframes.'),
});

export const brapiDataframeDescribe = tool('brapi_dataframe_describe', {
  description:
    'List dataframes (or describe one) with columns, row counts, and originating-dataset provenance. Use this to discover what dataframes are available before writing a brapi_dataframe_query.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  errors: [
    {
      reason: 'dataframe_disabled',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Dataframe surface is gated off by env (CANVAS_PROVIDER_TYPE != duckdb or BRAPI_CANVAS_ENABLED=false)',
      recovery:
        'Set CANVAS_PROVIDER_TYPE=duckdb and BRAPI_CANVAS_ENABLED=true on the deployment, or use brapi_manage_dataset to enumerate datasets directly.',
    },
  ] as const,
  input: InputSchema,
  output: OutputSchema,

  async handler(input, ctx) {
    const bridge = getCanvasBridge();
    if (!bridge.isEnabled()) {
      throw ctx.fail(
        'dataframe_disabled',
        'brapi_dataframe_describe is unavailable — dataframes are not enabled on this deployment.',
        { ...ctx.recoveryFor('dataframe_disabled') },
      );
    }
    const describeOpts: { tableName?: string } = {};
    if (input.dataframe !== undefined) describeOpts.tableName = input.dataframe;
    const tables = await bridge.describe(ctx, describeOpts);
    return { tables };
  },

  format: (result) => [{ type: 'text', text: renderDescribe(result.tables) }],
});

function renderDescribe(tables: z.infer<typeof DescribedTableSchema>[]): string {
  const lines: string[] = [];
  lines.push(`# ${tables.length} dataframe(s)`);
  if (tables.length === 0) {
    lines.push('');
    lines.push(
      '_No dataframes. Run a find_* tool that spills to a dataset, or use brapi_dataframe_query with `registerAs` to materialize one._',
    );
    return lines.join('\n');
  }
  for (const table of tables) {
    lines.push('');
    lines.push(`## \`${table.name}\``);
    lines.push(`- rowCount: ${table.rowCount}`);
    if (table.approxSizeBytes !== undefined) {
      lines.push(`- approxSizeBytes: ${table.approxSizeBytes}`);
    }
    lines.push(`- columns: ${table.columns.length}`);
    for (const col of table.columns) {
      const nullable = col.nullable === undefined ? '' : ` (nullable: ${col.nullable})`;
      lines.push(`  - ${col.name}: ${col.type}${nullable}`);
    }
    if (table.provenance) {
      lines.push('- provenance:');
      lines.push(`  - datasetId: \`${table.provenance.datasetId}\``);
      lines.push(`  - source: ${table.provenance.source}`);
      lines.push(`  - baseUrl: ${table.provenance.baseUrl}`);
      lines.push(`  - createdAt: ${table.provenance.createdAt}`);
      lines.push(`  - expiresAt: ${table.provenance.expiresAt}`);
      lines.push(`  - query: \`${JSON.stringify(table.provenance.query)}\``);
    }
  }
  return lines.join('\n');
}
