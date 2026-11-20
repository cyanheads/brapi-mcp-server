/**
 * @fileoverview Search multiple BrAPI connections and preserve source-qualified identities.
 * @module mcp-server/tools/definitions/brapi-federated-find.tool
 */

import { isDeepStrictEqual } from 'node:util';
import { type Context, createFail, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { callDeadlineAt, callDeadlineExceeded } from '@/services/brapi-client/index.js';
import { getCanvasBridge } from '@/services/canvas-bridge/index.js';
import {
  AliasInput,
  DataframeHandleSchema,
  type FinderCollection,
  inlineTrimNotice,
  LoadLimitInput,
  toDataframeHandle,
} from '../shared/find-helpers.js';
import { selectPreviewRows } from '../shared/inline-preview.js';
import { fenced } from '../shared/markdown-literals.js';
import { brapiFindGermplasm, findGermplasm } from './brapi-find-germplasm.tool.js';
import { brapiFindObservations, findObservations } from './brapi-find-observations.tool.js';
import { brapiFindStudies, findStudies } from './brapi-find-studies.tool.js';

const QuerySchema = z.discriminatedUnion('entity', [
  z
    .object({
      entity: z.literal('studies').describe('Search study records.'),
      filters: brapiFindStudies.input
        .omit({ alias: true, loadLimit: true })
        .strict()
        .describe('Filters accepted by brapi_find_studies.'),
    })
    .strict()
    .describe('Study query.'),
  z
    .object({
      entity: z.literal('germplasm').describe('Search germplasm records.'),
      filters: brapiFindGermplasm.input
        .omit({ alias: true, loadLimit: true })
        .strict()
        .describe('Filters accepted by brapi_find_germplasm.'),
    })
    .strict()
    .describe('Germplasm query.'),
  z
    .object({
      entity: z.literal('observations').describe('Search observation records.'),
      filters: brapiFindObservations.input
        .omit({ alias: true, loadLimit: true })
        .strict()
        .describe('Filters accepted by brapi_find_observations.'),
    })
    .strict()
    .describe('Observation query.'),
]);

const ErrorSchema = z.object({
  code: z.number().describe('JSON-RPC error code.'),
  reason: z.string().optional().describe('Machine-readable reason when available.'),
  message: z.string().describe('Description of the source failure.'),
  recovery: z.string().optional().describe('How to retry or correct the source failure.'),
});

const CoverageSchema = z
  .discriminatedUnion('status', [
    z
      .object({
        alias: z.string().describe('Source connection alias.'),
        status: z.enum(['complete', 'partial']).describe('Whether the source completed its scan.'),
        matchedCount: z
          .number()
          .int()
          .nonnegative()
          .describe('Collected source rows before merging.'),
        rowsScanned: z.number().int().nonnegative().describe('Rows the source examined.'),
        warnings: z.array(z.string()).describe('Filter and coverage warnings from the finder.'),
      })
      .describe('Source collection outcome.'),
    z
      .object({
        alias: z.string().describe('Source connection alias.'),
        status: z
          .enum(['failed', 'skipped'])
          .describe('Source failed, or the shared deadline prevented dispatch.'),
        error: ErrorSchema.describe('Source-specific error.'),
      })
      .describe('Unsuccessful source outcome.'),
  ])
  .describe('Outcome for one source.');

const SourceRowSchema = z
  .object({
    alias: z.string().describe('Connection alias qualifying the source record.'),
    dbId: z.string().nullable().describe('Source-local DbId, if present.'),
    record: z.record(z.string(), z.unknown()).describe('The finder record from this source.'),
  })
  .describe('Source-qualified finder row.');

const RowSchema = z
  .object({
    pui: z.string().nullable().describe('Reported germplasm PUI, if present.'),
    sources: z
      .array(SourceRowSchema)
      .describe('One source row or the members of an exact germplasm PUI group.'),
    conflicts: z
      .array(z.string())
      .describe('Fields reported with different non-null values by PUI group members.'),
  })
  .describe('One merged row and its source records.');

type Query = z.output<typeof QuerySchema>;
type Coverage = z.output<typeof CoverageSchema>;
type SourceRow = z.output<typeof SourceRowSchema>;
type Row = z.output<typeof RowSchema>;
type SourceResult = { coverage: Coverage; rows: SourceRow[] };

export const brapiFederatedFind = tool('brapi_federated_find', {
  description:
    'Find studies, germplasm, or observations across BrAPI connection aliases. Reuses each finder’s filters, dialect handling, and read limits. Rows retain their source alias and DbId. Only an unambiguous exact germplasm PUI can group records across aliases. Returns per-alias coverage and stages the merged collection when the inline limit is reached.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    aliases: z
      .array(AliasInput.unwrap())
      .min(1)
      .describe('Source aliases to query in the order given.'),
    query: QuerySchema.describe('Entity and its finder-specific filters.'),
    loadLimit: LoadLimitInput,
  }),
  output: z.object({
    entity: z
      .enum(['studies', 'germplasm', 'observations'])
      .describe('The requested BrAPI entity.'),
    results: z.array(RowSchema).describe('Leading merged rows with source provenance.'),
    collectedCount: z
      .number()
      .int()
      .nonnegative()
      .describe('Source rows collected before merging.'),
    mergedCount: z.number().int().nonnegative().describe('Merged rows, including staged rows.'),
    complete: z.boolean().describe('True when all source scans completed.'),
    coverage: z.array(CoverageSchema).describe('Collection coverage in alias input order.'),
    dataframe: DataframeHandleSchema.optional().describe('Merged table when the preview is cut.'),
  }),
  enrichment: {
    truncated: z.boolean().optional().describe('True when the merged inline preview was cut.'),
    shown: z.number().int().nonnegative().optional().describe('Merged rows delivered inline.'),
    cap: z.number().int().positive().optional().describe('Effective inline row limit.'),
    notice: z.string().optional().describe('Preview bound and pointer to the merged dataframe.'),
  },
  async handler(input, ctx) {
    const aliases = [...new Set(input.aliases)];
    const config = getServerConfig();
    const deadlineAt = callDeadlineAt(ctx, config.callDeadlineMs);
    const collected: SourceResult[] = [];
    let next = 0;

    async function collectSources(): Promise<void> {
      for (let index = next++; index < aliases.length; index = next++) {
        ctx.signal.throwIfAborted();
        const alias = aliases[index];
        if (alias === undefined) break;
        if (Date.now() >= deadlineAt) {
          const error = callDeadlineExceeded('Federated source read', config.callDeadlineMs, {
            sent: false,
          });
          collected[index] = failedSource(alias, 'skipped', error);
        } else {
          collected[index] = await collectSource(input.query, alias, ctx);
        }
      }
    }

    const workers = Array.from(
      { length: Math.min(config.maxConcurrentRequests, aliases.length) },
      collectSources,
    );
    const settled = await Promise.allSettled(workers);
    ctx.signal.throwIfAborted();
    for (const worker of settled) if (worker.status === 'rejected') throw worker.reason;

    const coverage = collected.map((source) => source.coverage);
    const sourceRows = collected.flatMap((source) => source.rows);
    const rows = mergeRows(input.query.entity, sourceRows);
    const loadLimit = input.loadLimit ?? config.loadLimit;
    const complete = coverage.every((source) => source.status === 'complete');
    const inline = selectPreviewRows(rows, loadLimit, renderJson);
    const dataframe = inline.bound
      ? toDataframeHandle(
          await getCanvasBridge().registerDataframe(ctx, {
            source: 'federated_find',
            baseUrl: '', // Federated tables have no single origin. Aliases and coverage are in query.
            query: { aliases, ...input.query, coverage },
            rows,
            truncated: !complete,
          }),
          rows.length,
        )
      : undefined;
    if (inline.bound && dataframe) {
      const shown = inline.rows.length;
      const bound = inlineTrimNotice(inline.bound, shown, loadLimit, undefined);
      ctx.enrich.truncated({
        shown,
        cap: loadLimit,
        guidance: `${bound} Read merged dataframe \`${dataframe.tableName}\` with brapi_dataframe_describe or brapi_dataframe_query.${complete ? '' : ' See coverage for each incomplete source.'}`,
      });
    }

    return {
      entity: input.query.entity,
      results: inline.rows,
      collectedCount: sourceRows.length,
      mergedCount: rows.length,
      complete,
      coverage,
      ...(dataframe ? { dataframe } : {}),
    };
  },
  format: ({ results, ...summary }) => [
    { type: 'text', text: `${renderJson(summary)}\n\n## Results\n\n${renderJson(results)}` },
  ],
});

function renderJson(value: unknown): string {
  return fenced(JSON.stringify(value), 'json');
}

async function collectSource(query: Query, alias: string, ctx: Context): Promise<SourceResult> {
  const errors =
    (query.entity === 'studies'
      ? brapiFindStudies.errors
      : query.entity === 'germplasm'
        ? brapiFindGermplasm.errors
        : brapiFindObservations.errors) ?? [];
  const sourceCtx = {
    ...ctx,
    fail: createFail(errors),
    recoveryFor(reason: string) {
      const entry = errors.find((candidate) => candidate.reason === reason);
      if (!entry) throw new Error(`Unknown finder error reason: ${reason}`);
      return { recovery: { hint: entry.recovery } };
    },
  };
  let collection: FinderCollection;
  try {
    switch (query.entity) {
      case 'studies':
        collection = await findStudies({ alias, ...query.filters }, sourceCtx, true);
        break;
      case 'germplasm':
        collection = await findGermplasm({ alias, ...query.filters }, sourceCtx, true);
        break;
      case 'observations':
        collection = await findObservations({ alias, ...query.filters }, sourceCtx, true);
        break;
    }
  } catch (error) {
    ctx.signal.throwIfAborted();
    if (!(error instanceof McpError) || error.code === JsonRpcErrorCode.InternalError) throw error;
    const reason = typeof error.data?.reason === 'string' ? error.data.reason : undefined;
    const contractHint = errors.find((entry) => entry.reason === reason)?.recovery;
    return failedSource(alias, 'failed', error, contractHint);
  }
  const idKey =
    query.entity === 'studies'
      ? 'studyDbId'
      : query.entity === 'germplasm'
        ? 'germplasmDbId'
        : 'observationDbId';
  return {
    coverage: {
      alias,
      status: collection.scanComplete ? 'complete' : 'partial',
      matchedCount: collection.rows.length,
      rowsScanned: collection.rowsScanned,
      warnings: collection.warnings,
    },
    rows: collection.rows.map((record) => ({ alias, dbId: nonBlank(record[idKey]), record })),
  };
}

function failedSource(
  alias: string,
  status: 'failed' | 'skipped',
  error: McpError,
  contractHint?: string,
): SourceResult {
  const reason = nonBlank(error.data?.reason);
  const recovery = z.object({ hint: z.string() }).safeParse(error.data?.recovery);
  const hint = recovery.success ? recovery.data.hint : contractHint;
  return {
    rows: [],
    coverage: {
      alias,
      status,
      error: {
        code: error.code,
        message: error.message,
        ...(reason ? { reason } : {}),
        ...(hint ? { recovery: hint } : {}),
      },
    },
  };
}

function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function mergeRows(entity: Query['entity'], sourceRows: SourceRow[]): Row[] {
  const puiGroups = new Map<string, SourceRow[]>();
  if (entity === 'germplasm') {
    for (const source of sourceRows) {
      const pui = nonBlank(source.record.germplasmPUI);
      if (!pui) continue;
      const group = puiGroups.get(pui);
      if (group) group.push(source);
      else puiGroups.set(pui, [source]);
    }
    for (const [pui, group] of puiGroups) {
      if (group.length < 2 || new Set(group.map(({ alias }) => alias)).size !== group.length)
        puiGroups.delete(pui);
    }
  }
  const rows: Row[] = [];
  const emitted = new Set<string>();
  for (const source of sourceRows) {
    const pui = entity === 'germplasm' ? nonBlank(source.record.germplasmPUI) : null;
    const group = pui ? puiGroups.get(pui) : undefined;
    if (pui && group) {
      if (emitted.has(pui)) continue;
      emitted.add(pui);
      rows.push({ pui, sources: group, conflicts: conflictingFields(group) });
    } else {
      rows.push({ pui, sources: [source], conflicts: [] });
    }
  }
  return rows;
}

function conflictingFields(sources: SourceRow[]): string[] {
  const values = new Map<string, unknown>();
  const conflicts = new Set<string>();
  for (const { record } of sources) {
    for (const [key, value] of Object.entries(record)) {
      if (value == null || key === 'germplasmDbId') continue;
      if (!values.has(key)) values.set(key, value);
      else if (!isDeepStrictEqual(values.get(key), value)) conflicts.add(key);
    }
  }
  return [...conflicts];
}
