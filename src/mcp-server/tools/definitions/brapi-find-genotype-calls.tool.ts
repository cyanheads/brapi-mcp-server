/**
 * @fileoverview `brapi_find_genotype_calls` — pull allele calls across a
 * germplasm × variant set. Uses BrAPI's async-search pattern
 * (`POST /search/calls` → `GET /search/calls/{id}` with 202-retry) under
 * the hood. Enforces a default 100k cap on total calls returned; rows beyond
 * the cap spill into DatasetStore for export.
 *
 * @module mcp-server/tools/definitions/brapi-find-genotype-calls.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { type BrapiClient, getBrapiClient } from '@/services/brapi-client/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import { type DatasetStore, getDatasetStore } from '@/services/dataset-store/index.js';
import { DEFAULT_ALIAS, getServerRegistry } from '@/services/server-registry/index.js';
import type { RegisteredServer } from '@/services/server-registry/types.js';
import {
  AliasInput,
  asString,
  buildRequestOptions,
  computeDistribution,
  DatasetHandleSchema,
  renderDistributions,
  toDatasetHandle,
} from '../shared/find-helpers.js';

const DEFAULT_MAX_CALLS = 100_000;
const HARD_MAX_CALLS = 500_000;
const PAGE_SIZE = 10_000;

const CallRowSchema = z
  .object({
    callSetDbId: z.string().optional(),
    callSetName: z.string().optional(),
    variantDbId: z.string().optional(),
    variantName: z.string().optional(),
    variantSetDbId: z.string().optional(),
    genotype: z
      .object({
        values: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    genotypeValue: z.string().optional(),
    phaseSet: z.string().optional(),
  })
  .passthrough();

const OutputSchema = z.object({
  alias: z.string(),
  results: z.array(CallRowSchema).describe('Call rows returned in-context (up to loadLimit).'),
  returnedCount: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  callFormatting: z
    .object({
      expandHomozygotes: z.boolean().optional(),
      unknownString: z.string().optional(),
      sepPhased: z.string().optional(),
      sepUnphased: z.string().optional(),
    })
    .describe('Genotype-encoding hints echoed by the server.'),
  distributions: z.object({
    callSetName: z.record(z.string(), z.number()),
    variantName: z.record(z.string(), z.number()),
    variantSetDbId: z.record(z.string(), z.number()),
  }),
  dataset: DatasetHandleSchema.optional(),
  truncated: z
    .boolean()
    .describe('True when `maxCalls` was reached and more calls exist upstream.'),
  warnings: z.array(z.string()),
  searchBody: z.record(z.string(), z.unknown()).describe('The body sent to /search/calls.'),
});

type Output = z.infer<typeof OutputSchema>;

export const brapiFindGenotypeCalls = tool('brapi_find_genotype_calls', {
  description: `Pull genotype calls for a germplasm × variant set. Handles BrAPI's async-search pattern transparently. Default cap of ${DEFAULT_MAX_CALLS} calls; override via maxCalls (hard cap ${HARD_MAX_CALLS}). Rows beyond the in-context loadLimit spill to DatasetStore for export via brapi_manage_dataset.`,
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    alias: AliasInput,
    variantSetDbId: z
      .string()
      .min(1)
      .optional()
      .describe('Scope calls to a single variant set. Strongly recommended.'),
    variantSetDbIds: z
      .array(z.string())
      .optional()
      .describe('Alternative: multiple variant sets at once.'),
    germplasmDbIds: z
      .array(z.string())
      .optional()
      .describe('Restrict to these germplasm (call sets).'),
    callSetDbIds: z.array(z.string()).optional().describe('Restrict to these call sets directly.'),
    variantDbIds: z.array(z.string()).optional().describe('Restrict to specific variants.'),
    callFormat: z
      .enum(['VCF', 'FLAPJACK', 'DARTSEQ', 'JSON'])
      .optional()
      .describe('Requested call-encoding format, when the server honors it.'),
    maxCalls: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`Max calls to pull (default ${DEFAULT_MAX_CALLS}, hard cap ${HARD_MAX_CALLS}).`),
    loadLimit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'In-context row cap. Rows beyond the cap spill to DatasetStore (if maxCalls > loadLimit).',
      ),
  }),
  output: OutputSchema,

  async handler(input, ctx) {
    const registry = getServerRegistry();
    const capabilities = getCapabilityRegistry();
    const client = getBrapiClient();
    const datasetStore = getDatasetStore();

    const connection = await registry.get(ctx, input.alias ?? DEFAULT_ALIAS);

    const capabilityLookup: { auth?: typeof connection.resolvedAuth } = {};
    if (connection.resolvedAuth) capabilityLookup.auth = connection.resolvedAuth;
    await capabilities.ensure(
      connection.baseUrl,
      { service: 'search/calls', method: 'POST' },
      ctx,
      capabilityLookup,
    );

    const maxCalls = Math.min(input.maxCalls ?? DEFAULT_MAX_CALLS, HARD_MAX_CALLS);
    const loadLimit = input.loadLimit ?? 200;

    const searchBody = buildSearchBody(input);
    if (
      !searchBody.variantSetDbIds &&
      !searchBody.variantSetDbId &&
      !searchBody.germplasmDbIds &&
      !searchBody.callSetDbIds &&
      !searchBody.variantDbIds
    ) {
      throw validationError(
        'Provide at least one filter (variantSetDbId, variantSetDbIds, germplasmDbIds, callSetDbIds, or variantDbIds) — unfiltered genotype-call pulls are prohibitively expensive.',
        { filters: searchBody },
      );
    }

    const warnings: string[] = [];
    const collected = await collectCalls({
      client,
      connection,
      ctx,
      body: searchBody,
      maxCalls,
      warnings,
    });

    const inContext = collected.rows.slice(0, loadLimit);
    const distributions = {
      callSetName: computeDistribution(collected.rows, (r) => asString(r.callSetName)),
      variantName: computeDistribution(collected.rows, (r) => asString(r.variantName)),
      variantSetDbId: computeDistribution(collected.rows, (r) => asString(r.variantSetDbId)),
    };

    const shouldSpill = collected.rows.length > loadLimit;
    let datasetMeta: z.infer<typeof DatasetHandleSchema> | undefined;
    if (shouldSpill) {
      datasetMeta = await spillCalls({
        store: datasetStore,
        ctx,
        connection,
        body: searchBody,
        rows: collected.rows,
      });
    }

    const result: Output = {
      alias: connection.alias,
      results: inContext,
      returnedCount: inContext.length,
      totalCount: collected.rows.length,
      hasMore: collected.truncated,
      callFormatting: collected.callFormatting,
      distributions,
      truncated: collected.truncated,
      warnings,
      searchBody,
    };
    if (datasetMeta) result.dataset = datasetMeta;
    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(
      `# ${result.returnedCount} of ${result.totalCount} calls — \`${result.alias}\`${result.truncated ? ' (truncated at maxCalls)' : ''}`,
    );
    lines.push('');
    lines.push(`Search body: \`${JSON.stringify(result.searchBody)}\``);
    lines.push('');
    lines.push('## Call formatting');
    const f = result.callFormatting;
    lines.push(`- expandHomozygotes: ${f.expandHomozygotes ?? '—'}`);
    lines.push(`- unknownString: ${f.unknownString ?? '—'}`);
    lines.push(`- sepPhased: ${f.sepPhased ?? '—'}`);
    lines.push(`- sepUnphased: ${f.sepUnphased ?? '—'}`);
    lines.push('');
    lines.push('## Distributions');
    lines.push(renderDistributions(result.distributions) || '_No values to summarize._');
    lines.push('');
    lines.push('## Calls');
    if (result.results.length === 0) {
      lines.push('_No calls returned._');
    } else {
      for (const call of result.results) {
        const parts: string[] = [];
        parts.push(`**${call.callSetName ?? call.callSetDbId ?? '?'}**`);
        if (call.callSetDbId) parts.push(`callSetDbId=${call.callSetDbId}`);
        parts.push(`variant=${call.variantName ?? call.variantDbId ?? '?'}`);
        if (call.variantDbId) parts.push(`variantDbId=${call.variantDbId}`);
        if (call.variantSetDbId) parts.push(`set=${call.variantSetDbId}`);
        if (call.genotype?.values?.length) parts.push(`genotype=${call.genotype.values.join('|')}`);
        if (call.genotypeValue) parts.push(`genotypeValue=${call.genotypeValue}`);
        if (call.phaseSet) parts.push(`phaseSet=${call.phaseSet}`);
        lines.push(`- ${parts.join(' · ')}`);
      }
    }
    if (result.dataset) {
      lines.push('');
      lines.push('## Dataset handle');
      lines.push(`- datasetId: \`${result.dataset.datasetId}\``);
      lines.push(`- rowCount: ${result.dataset.rowCount}`);
      lines.push(`- sizeBytes: ${result.dataset.sizeBytes}`);
      lines.push(`- columns: ${result.dataset.columns.join(', ')}`);
      lines.push(`- createdAt: ${result.dataset.createdAt}`);
      lines.push(`- expiresAt: ${result.dataset.expiresAt}`);
    }
    if (result.warnings.length > 0) {
      lines.push('');
      lines.push('## Warnings');
      for (const w of result.warnings) lines.push(`- ${w}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

function buildSearchBody(
  input: Parameters<typeof brapiFindGenotypeCalls.handler>[0],
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.variantSetDbId) body.variantSetDbIds = [input.variantSetDbId];
  if (input.variantSetDbIds?.length) {
    body.variantSetDbIds = Array.from(
      new Set([...((body.variantSetDbIds as string[]) ?? []), ...input.variantSetDbIds]),
    );
  }
  if (input.germplasmDbIds?.length) body.germplasmDbIds = input.germplasmDbIds;
  if (input.callSetDbIds?.length) body.callSetDbIds = input.callSetDbIds;
  if (input.variantDbIds?.length) body.variantDbIds = input.variantDbIds;
  if (input.callFormat) body.callFormat = input.callFormat;
  body.pageSize = PAGE_SIZE;
  return body;
}

interface CollectInput {
  body: Record<string, unknown>;
  client: BrapiClient;
  connection: RegisteredServer;
  ctx: Context;
  maxCalls: number;
  warnings: string[];
}

interface CollectResult {
  callFormatting: Output['callFormatting'];
  rows: z.infer<typeof CallRowSchema>[];
  truncated: boolean;
}

async function collectCalls(input: CollectInput): Promise<CollectResult> {
  const rows: z.infer<typeof CallRowSchema>[] = [];
  let callFormatting: Output['callFormatting'] = {};
  let truncated = false;

  const firstBody = { ...input.body, page: 0 };
  const first = await input.client.postSearch<Record<string, unknown>>(
    input.connection.baseUrl,
    'calls',
    firstBody,
    input.ctx,
    buildRequestOptions(input.connection),
  );

  let envelope: Awaited<ReturnType<BrapiClient['get']>>;
  let searchResultsDbId: string | undefined;
  if (first.kind === 'sync') {
    envelope = first.envelope;
  } else {
    searchResultsDbId = first.searchResultsDbId;
    envelope = await input.client.getSearchResults<Record<string, unknown>>(
      input.connection.baseUrl,
      'calls',
      first.searchResultsDbId,
      input.ctx,
      buildRequestOptions(input.connection),
    );
  }

  consumePage(envelope, rows, (cf) => {
    callFormatting = cf;
  });
  const totalPages = envelope.metadata?.pagination?.totalPages;

  for (let page = 1; page < (totalPages ?? 1); page++) {
    if (rows.length >= input.maxCalls) {
      truncated = true;
      break;
    }
    if (input.ctx.signal.aborted) break;
    let pageEnvelope: Awaited<ReturnType<BrapiClient['get']>>;
    if (searchResultsDbId) {
      pageEnvelope = await input.client.getSearchResults<Record<string, unknown>>(
        input.connection.baseUrl,
        'calls',
        searchResultsDbId,
        input.ctx,
        buildRequestOptions(input.connection, { page, pageSize: PAGE_SIZE }),
      );
    } else {
      const nextSearch = await input.client.postSearch<Record<string, unknown>>(
        input.connection.baseUrl,
        'calls',
        { ...input.body, page },
        input.ctx,
        buildRequestOptions(input.connection),
      );
      if (nextSearch.kind === 'sync') {
        pageEnvelope = nextSearch.envelope;
      } else {
        pageEnvelope = await input.client.getSearchResults<Record<string, unknown>>(
          input.connection.baseUrl,
          'calls',
          nextSearch.searchResultsDbId,
          input.ctx,
          buildRequestOptions(input.connection),
        );
      }
    }
    consumePage(pageEnvelope, rows, (cf) => {
      callFormatting = cf;
    });
  }

  if (rows.length > input.maxCalls) {
    rows.length = input.maxCalls;
    truncated = true;
    input.warnings.push(
      `Truncated at maxCalls=${input.maxCalls}. Increase maxCalls or narrow filters.`,
    );
  }

  return { rows, callFormatting, truncated };
}

function consumePage(
  envelope: Awaited<ReturnType<BrapiClient['get']>>,
  rows: z.infer<typeof CallRowSchema>[],
  setCallFormatting: (f: Output['callFormatting']) => void,
): void {
  const result = envelope.result;
  if (!result || typeof result !== 'object') return;
  const record = result as Record<string, unknown>;
  const cf: Output['callFormatting'] = {};
  if (typeof record.expandHomozygotes === 'boolean')
    cf.expandHomozygotes = record.expandHomozygotes;
  if (typeof record.unknownString === 'string') cf.unknownString = record.unknownString;
  if (typeof record.sepPhased === 'string') cf.sepPhased = record.sepPhased;
  if (typeof record.sepUnphased === 'string') cf.sepUnphased = record.sepUnphased;
  setCallFormatting(cf);

  const data = record.data;
  if (!Array.isArray(data)) return;
  for (const entry of data) {
    if (typeof entry === 'object' && entry !== null) {
      rows.push(entry as z.infer<typeof CallRowSchema>);
    }
  }
}

interface SpillCallsInput {
  body: Record<string, unknown>;
  connection: RegisteredServer;
  ctx: Context;
  rows: z.infer<typeof CallRowSchema>[];
  store: DatasetStore;
}

async function spillCalls(input: SpillCallsInput): Promise<z.infer<typeof DatasetHandleSchema>> {
  const metadata = await input.store.create(input.ctx, {
    source: 'find_genotype_calls',
    baseUrl: input.connection.baseUrl,
    query: input.body,
    rows: input.rows as Record<string, unknown>[],
  });
  return toDatasetHandle(metadata);
}
