/**
 * @fileoverview `brapi_manage_dataset` — consolidated lifecycle tool for
 * datasets created by `find_*` spillovers. Four modes discriminated by
 * `mode`: list (enumerate with provenance), summary (metadata only), load
 * (paged rows with optional column projection), delete (drop metadata +
 * payload). Export (CSV/Parquet) is deferred until storage backends for the
 * write path are wired up.
 *
 * @module mcp-server/tools/definitions/brapi-manage-dataset.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getDatasetStore } from '@/services/dataset-store/index.js';

const DatasetMetadataSchema = z.object({
  datasetId: z.string().describe('Server-assigned dataset identifier.'),
  source: z.string().describe('Tool/operation that produced the dataset (e.g. "find_studies").'),
  baseUrl: z.string().describe('BrAPI base URL the dataset was pulled from.'),
  query: z.unknown().describe('Original filter map — provenance for reproducibility.'),
  rowCount: z.number().int().nonnegative().describe('Number of rows persisted in the dataset.'),
  columns: z
    .array(z.string().describe('Column name from the persisted rows.'))
    .describe('Full column list of the persisted rows.'),
  sizeBytes: z.number().int().nonnegative().describe('Serialized size of the dataset in bytes.'),
  createdAt: z.string().describe('ISO 8601 timestamp the dataset was created.'),
  expiresAt: z.string().describe('ISO 8601 timestamp after which the dataset will be purged.'),
  truncated: z
    .boolean()
    .optional()
    .describe('True when the dataset hit the spillover row/page cap before exhausting upstream.'),
  maxRows: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Cap that was applied at create time, when truncation occurred.'),
  dataframe: z
    .string()
    .optional()
    .describe(
      'Dataframe name when this dataset was auto-registered as a SQL-queryable dataframe. Use with brapi_dataframe_query to run SQL across the rows.',
    ),
});

const ListResultSchema = z
  .object({
    mode: z.literal('list').describe('Discriminator — `list` mode enumerates datasets.'),
    datasets: z
      .array(DatasetMetadataSchema.describe('Dataset metadata entry.'))
      .describe('Datasets visible to this tenant, in creation order.'),
    cursor: z.string().optional().describe('Opaque cursor when more datasets exist.'),
  })
  .describe('Enumeration of datasets visible to the current tenant.');

const SummaryResultSchema = z
  .object({
    mode: z.literal('summary').describe('Discriminator — `summary` mode returns one dataset.'),
    dataset: DatasetMetadataSchema.describe('Metadata and provenance for the requested dataset.'),
  })
  .describe('Metadata + provenance for a single dataset.');

const LoadResultSchema = z
  .object({
    mode: z.literal('load').describe('Discriminator — `load` mode returns a page of rows.'),
    datasetId: z.string().describe('Dataset the rows came from.'),
    page: z.number().int().positive().describe('1-indexed page number that was served.'),
    pageSize: z.number().int().positive().describe('Max rows per page (capped at 1000).'),
    totalRows: z.number().int().nonnegative().describe('Total rows in the dataset.'),
    totalPages: z.number().int().positive().describe('Total pages at the current pageSize.'),
    rows: z
      .array(
        z
          .record(z.string(), z.unknown())
          .describe('One persisted row, with optional column projection applied.'),
      )
      .describe('Rows for this page.'),
  })
  .describe('Paged rows from a persisted dataset.');

const DeleteResultSchema = z
  .object({
    mode: z.literal('delete').describe('Discriminator — `delete` mode confirms removal.'),
    datasetId: z.string().describe('Dataset that was deleted.'),
    deleted: z.literal(true).describe('Always `true` when the call succeeded.'),
  })
  .describe('Confirmation that a dataset was deleted.');

const OutputSchema = z.object({
  result: z
    .discriminatedUnion('mode', [
      ListResultSchema,
      SummaryResultSchema,
      LoadResultSchema,
      DeleteResultSchema,
    ])
    .describe(
      'Mode-specific result — discriminated by `mode`: list (dataset enumeration), summary (metadata+provenance), load (paged rows), delete (drop confirmation).',
    ),
});

type Result = z.infer<typeof OutputSchema>['result'];

const InputSchema = z.object({
  mode: z
    .enum(['list', 'summary', 'load', 'delete'])
    .describe(
      'Operation: list (enumerate datasets), summary (metadata+provenance), load (page rows), delete (drop payload).',
    ),
  datasetId: z
    .string()
    .min(1)
    .optional()
    .describe('Required for mode=summary | load | delete. Ignored for mode=list.'),
  cursor: z.string().optional().describe('mode=list: resume a previous call.'),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe('mode=list: max datasets to return (default 50, capped at 200).'),
  page: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('mode=load: 1-indexed page number (default 1).'),
  pageSize: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('mode=load: rows per page (default 100, max 1000).'),
  columns: z
    .array(z.string().min(1))
    .optional()
    .describe('mode=load: subset of columns to return. Omit for all columns.'),
});

export const brapiManageDataset = tool('brapi_manage_dataset', {
  description:
    'Dataset lifecycle — list (enumerate), summary (metadata+provenance), load (page rows with column projection), delete (drop payload). Datasets are produced by find_* tools when the upstream total exceeds loadLimit. Export (CSV/Parquet) is not yet implemented.',
  annotations: { readOnlyHint: false, idempotentHint: false },
  errors: [
    {
      reason: 'datasetid_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Mode summary, load, or delete was selected without a datasetId',
      recovery: 'Call mode=list first to discover available dataset IDs, then retry with one.',
    },
    {
      reason: 'dataset_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Requested dataset is not present in the store (never existed or already expired)',
      recovery:
        'Run mode=list to confirm available datasets, or rerun the find_* tool that produced it.',
    },
    {
      reason: 'dataset_rows_missing',
      code: JsonRpcErrorCode.NotFound,
      when: 'Dataset metadata is present but the row payload was lost or partially expired',
      recovery:
        'Delete the stale dataset via mode=delete and rerun the find_* tool that produced it.',
    },
  ] as const,
  input: InputSchema,
  output: OutputSchema,

  async handler(input, ctx) {
    const store = getDatasetStore();

    const requireDatasetId = (): string => {
      if (!input.datasetId) {
        throw ctx.fail('datasetid_required', `mode='${input.mode}' requires datasetId.`, {
          mode: input.mode,
          ...ctx.recoveryFor('datasetid_required'),
        });
      }
      return input.datasetId;
    };

    switch (input.mode) {
      case 'list': {
        const listOptions: { cursor?: string; limit?: number } = {};
        if (input.cursor !== undefined) listOptions.cursor = input.cursor;
        if (input.limit !== undefined) listOptions.limit = input.limit;
        const page = await store.list(ctx, listOptions);
        const branch: z.infer<typeof ListResultSchema> = {
          mode: 'list',
          datasets: page.datasets,
        };
        if (page.cursor !== undefined) branch.cursor = page.cursor;
        return { result: branch };
      }
      case 'summary': {
        const datasetId = requireDatasetId();
        const dataset = await store.summary(ctx, datasetId);
        const branch: z.infer<typeof SummaryResultSchema> = { mode: 'summary', dataset };
        return { result: branch };
      }
      case 'load': {
        const datasetId = requireDatasetId();
        const loadOptions: { page?: number; pageSize?: number; columns?: string[] } = {};
        if (input.page !== undefined) loadOptions.page = input.page;
        if (input.pageSize !== undefined) loadOptions.pageSize = input.pageSize;
        if (input.columns !== undefined) loadOptions.columns = input.columns;
        const pageResult = await store.load(ctx, datasetId, loadOptions);
        const branch: z.infer<typeof LoadResultSchema> = {
          mode: 'load',
          datasetId: pageResult.datasetId,
          page: pageResult.page,
          pageSize: pageResult.pageSize,
          totalRows: pageResult.totalRows,
          totalPages: pageResult.totalPages,
          rows: pageResult.rows,
        };
        return { result: branch };
      }
      case 'delete': {
        const datasetId = requireDatasetId();
        await store.delete(ctx, datasetId);
        const branch: z.infer<typeof DeleteResultSchema> = {
          mode: 'delete',
          datasetId,
          deleted: true,
        };
        return { result: branch };
      }
    }
  },

  format: (result) => {
    const branch = result.result;
    switch (branch.mode) {
      case 'list':
        return [{ type: 'text', text: renderList(branch) }];
      case 'summary':
        return [{ type: 'text', text: renderSummary(branch.dataset) }];
      case 'load':
        return [{ type: 'text', text: renderLoad(branch) }];
      case 'delete':
        return [
          {
            type: 'text',
            text: `# Dataset deleted\n- datasetId: \`${branch.datasetId}\`\n- deleted: ${branch.deleted}\n- mode: ${branch.mode}`,
          },
        ];
    }
  },
});

function renderList(result: Extract<Result, { mode: 'list' }>): string {
  const lines: string[] = [];
  lines.push(`# ${result.datasets.length} dataset(s) · mode=${result.mode}`);
  if (result.cursor)
    lines.push(`**Cursor:** \`${result.cursor}\` — pass to list again for next page.`);
  if (result.datasets.length === 0) {
    lines.push('');
    lines.push('_No datasets. Run a find_* tool to produce one._');
    return lines.join('\n');
  }
  lines.push('');
  lines.push('| datasetId | source | rows | sizeBytes | createdAt | expiresAt | truncated |');
  lines.push('|:----------|:-------|-----:|----------:|:----------|:----------|:----------|');
  for (const ds of result.datasets) {
    const truncated = ds.truncated ? `yes (cap=${ds.maxRows ?? '?'})` : 'no';
    lines.push(
      `| \`${ds.datasetId}\` | ${ds.source} | ${ds.rowCount} | ${ds.sizeBytes} | ${ds.createdAt} | ${ds.expiresAt} | ${truncated} |`,
    );
  }
  for (const ds of result.datasets) {
    lines.push('');
    lines.push(`### \`${ds.datasetId}\``);
    lines.push(`- baseUrl: ${ds.baseUrl}`);
    lines.push(`- columns: ${ds.columns.join(', ')}`);
    lines.push(`- query: \`${JSON.stringify(ds.query)}\``);
    if (ds.dataframe) {
      lines.push(`- dataframe: \`${ds.dataframe}\` (queryable via brapi_dataframe_query)`);
    }
  }
  return lines.join('\n');
}

function renderSummary(dataset: z.infer<typeof DatasetMetadataSchema>): string {
  const lines: string[] = [];
  lines.push(`# Dataset \`${dataset.datasetId}\``);
  lines.push('');
  lines.push(`- source: ${dataset.source}`);
  lines.push(`- baseUrl: ${dataset.baseUrl}`);
  lines.push(`- rowCount: ${dataset.rowCount}`);
  lines.push(`- sizeBytes: ${dataset.sizeBytes}`);
  lines.push(`- createdAt: ${dataset.createdAt}`);
  lines.push(`- expiresAt: ${dataset.expiresAt}`);
  if (dataset.truncated) {
    lines.push(`- truncated: true (cap=${dataset.maxRows ?? '?'} rows)`);
  }
  if (dataset.dataframe) {
    lines.push(`- dataframe: \`${dataset.dataframe}\` (queryable via brapi_dataframe_query)`);
  }
  lines.push(`- columns: ${dataset.columns.join(', ')}`);
  lines.push(`- query: \`${JSON.stringify(dataset.query)}\``);
  return lines.join('\n');
}

function renderLoad(result: Extract<Result, { mode: 'load' }>): string {
  const lines: string[] = [];
  lines.push(
    `# Dataset \`${result.datasetId}\` — page ${result.page} of ${result.totalPages} (${result.rows.length}/${result.totalRows} rows) · mode=${result.mode}`,
  );
  lines.push('');
  lines.push(`- pageSize: ${result.pageSize}`);
  lines.push('');
  if (result.rows.length === 0) {
    lines.push('_No rows on this page._');
    return lines.join('\n');
  }
  const columns = Object.keys(result.rows[0] ?? {});
  lines.push('## Rows');
  for (const [i, row] of result.rows.entries()) {
    lines.push('');
    lines.push(`### Row ${(result.page - 1) * result.pageSize + i + 1}`);
    for (const col of columns) {
      const value = row[col];
      if (value === undefined || value === null) continue;
      const rendered = typeof value === 'object' ? JSON.stringify(value) : String(value);
      lines.push(`- **${col}:** ${rendered}`);
    }
  }
  return lines.join('\n');
}
