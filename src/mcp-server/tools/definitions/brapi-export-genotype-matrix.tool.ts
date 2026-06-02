/**
 * @fileoverview `brapi_export_genotype_matrix` — pull genotype calls for a
 * germplasm × variant set and pivot them into a matrix in the requested format.
 *
 * Three output formats:
 *
 * - `matrix-json`: Wide germplasm × variant table registered as a canvas
 *   dataframe (`df_<uuid>`). One row per call-set (germplasm); one column per
 *   variant. Column names are sanitized for DuckDB (SQL-safe identifiers); a
 *   `variantColumnLegend` maps sanitized name → original variant ID.
 *
 * - `vcf-lite`: Standard VCF-subset text (`#CHROM POS ID REF ALT <sample…>`),
 *   one row per variant, returned in the `vcf` output field. CHROM/POS/REF/ALT
 *   come from a `/variants` metadata pull; `.` when the server doesn't provide
 *   them (common — the BrAPI test server leaves them null). The wide matrix is
 *   also registered as a dataframe for SQL follow-up.
 *
 * - `plink`: `.ped` and `.map` text returned in the `ped` / `map` output fields.
 *   `.map` carries chromosome + base-pair position from the variant pull; `.ped`
 *   carries biallelic genotype pairs split from each call's genotype string.
 *   Alleles are passed through verbatim (numeric 0/1 codings are not recoded to
 *   nucleotides). The wide matrix is also registered as a dataframe.
 *
 * The genotype-call pull infrastructure is shared with `brapi_find_genotype_calls`
 * via `src/mcp-server/tools/shared/genotype-calls.ts`; column sanitization is
 * shared via `src/mcp-server/tools/shared/canvas-columns.ts`.
 *
 * @module mcp-server/tools/definitions/brapi-export-genotype-matrix.tool
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { type BrapiClient, getBrapiClient } from '@/services/brapi-client/index.js';
import { type BrapiDialect, resolveDialect } from '@/services/brapi-dialect/index.js';
import { getCanvasBridge, type RegisterDataframeInput } from '@/services/canvas-bridge/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import type { RegisteredServer } from '@/services/server-registry/index.js';
import { buildUniqueColumns } from '../shared/canvas-columns.js';
import {
  AliasInput,
  asString,
  type BrapiListResult,
  buildRequestOptions,
  DataframeHandleSchema,
  extractRows,
  renderDataframeHandle,
  requireRegisteredConnection,
  toDataframeHandle,
} from '../shared/find-helpers.js';
import {
  buildCallsSearchBody,
  type CallFormatting,
  type CallRow,
  collectCalls,
  renderGenotypeString,
} from '../shared/genotype-calls.js';

/** Per-variant coordinate metadata used to populate VCF/PLINK position columns. */
interface VariantMeta {
  alt?: string;
  chrom?: string;
  pos?: string;
  ref?: string;
}

/** Max variant records scanned when pulling coordinate metadata for vcf/plink. */
const MAX_VARIANT_METADATA_ROWS = 50_000;
const VARIANT_METADATA_PAGE_SIZE = 1_000;

/** Lines of format text shown inline in content[]; full text lives in structuredContent. */
const FORMAT_PREVIEW_LINES = 25;

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

const OutputSchema = z.object({
  alias: z.string().describe('Alias of the registered BrAPI connection used.'),
  format: z
    .enum(['plink', 'vcf-lite', 'matrix-json'])
    .describe('The output format that was produced.'),
  rowCount: z
    .number()
    .int()
    .nonnegative()
    .describe('Number of call-set (germplasm) rows in the matrix.'),
  columnCount: z
    .number()
    .int()
    .nonnegative()
    .describe('Number of variant columns in the matrix (excluding the germplasm ID column).'),
  variantColumnLegend: z
    .record(z.string(), z.string())
    .describe(
      'Map of sanitized column name → original variantDbId. Dataframe column names are SQL-safe identifiers; use this legend to correlate them back to the original variant IDs.',
    ),
  callFormatting: z
    .object({
      expandHomozygotes: z.boolean().nullish().describe('Homozygous allele expansion flag.'),
      unknownString: z.string().nullish().describe('String used for unknown/missing calls.'),
      sepPhased: z.string().nullish().describe('Phased allele separator.'),
      sepUnphased: z.string().nullish().describe('Unphased allele separator.'),
    })
    .describe('Genotype-encoding hints echoed by the server.'),
  dataframe: DataframeHandleSchema.describe(
    'Canvas dataframe handle for the wide germplasm × variant matrix (registered for every format). Query with brapi_dataframe_query (SQL); export with brapi_dataframe_export. The vcf/ped/map text fields are the format-specific serialization of the same data.',
  ),
  vcf: z
    .string()
    .optional()
    .describe(
      'VCF-lite text — header `#CHROM POS ID REF ALT` plus one genotype column per sample, one row per variant. Present only when format="vcf-lite". CHROM/POS/REF/ALT come from /variants metadata; "." when the server does not provide them.',
    ),
  ped: z
    .string()
    .optional()
    .describe(
      'PLINK .ped text — FID IID PAT MAT SEX PHENO placeholders (all 0) followed by biallelic genotype pairs per variant, one row per sample. Present only when format="plink". Alleles are passed through verbatim; PLINK missing is `0`.',
    ),
  map: z
    .string()
    .optional()
    .describe(
      'PLINK .map text — chromosome, variant-id, genetic-distance (0 placeholder), base-pair position, one row per variant. Present only when format="plink". Chromosome/position come from /variants metadata; `0` when absent.',
    ),
  truncated: z
    .boolean()
    .describe('True when the call pull was capped before exhausting upstream data.'),
  warnings: z.array(z.string()).describe('Advisory messages (truncation, missing fields, etc.).'),
});

type Output = z.infer<typeof OutputSchema>;

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const brapiExportGenotypeMatrix = tool('brapi_export_genotype_matrix', {
  description:
    'Pull genotype calls for a germplasm × variant set and pivot them into a matrix. `format` controls the output: `matrix-json` registers a wide germplasm × variant canvas dataframe for SQL analysis; `vcf-lite` returns VCF-subset text (in the `vcf` field) and also registers the dataframe; `plink` returns .ped/.map text (in the `ped`/`map` fields) and also registers the dataframe. vcf-lite/plink pull /variants metadata for CHROM/POS/REF/ALT (`.`/`0` when the server lacks them). Column names are SQL-safe identifiers; `variantColumnLegend` maps them back to original variant IDs.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'unknown_alias',
      code: JsonRpcErrorCode.NotFound,
      when: 'No connection has been registered under the requested alias',
      recovery:
        'Run brapi_connect with this alias (or omit `alias` to use the default connection) before calling brapi_export_genotype_matrix.',
    },
    {
      reason: 'no_filters',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No variantSetDbId was provided',
      recovery:
        'Provide variantSetDbId before retrying — unfiltered genotype-call pulls are too expensive.',
    },
    {
      reason: 'search_endpoint_disabled',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The active dialect declares POST /search/calls as known-dead on this server',
      recovery:
        'Connect to a different BrAPI server that exposes a working /search/calls route — genotype-call workflows are not viable here.',
    },
  ] as const,
  input: z.object({
    alias: AliasInput,
    germplasmDbIds: z
      .array(z.string())
      .optional()
      .describe(
        'Restrict to these germplasm. Omit to pull all germplasm in the variant set (use with caution on large sets).',
      ),
    variantSetDbId: z.string().min(1).describe('Variant set to pull calls for. Required.'),
    format: z
      .enum(['plink', 'vcf-lite', 'matrix-json'])
      .describe(
        'Output format. `matrix-json` registers a wide canvas dataframe only. `vcf-lite` returns VCF-subset text and registers the dataframe. `plink` returns .ped/.map text and registers the dataframe.',
      ),
    maxCalls: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Override the deployment-level pull cap (BRAPI_GENOTYPE_CALLS_MAX_PULL). Useful for large panels where the default is too low.',
      ),
  }),
  output: OutputSchema,

  async handler(input, ctx) {
    const capabilities = getCapabilityRegistry();
    const client = getBrapiClient();
    const bridge = getCanvasBridge();

    const connection = await requireRegisteredConnection(ctx, input.alias);

    const capabilityLookup: { auth?: typeof connection.resolvedAuth } = {};
    if (connection.resolvedAuth) capabilityLookup.auth = connection.resolvedAuth;
    await capabilities.ensure(
      connection.baseUrl,
      { service: 'search/calls', method: 'POST' },
      ctx,
      capabilityLookup,
    );

    const dialect = await resolveDialect(connection, ctx, capabilityLookup);
    if (dialect.disabledSearchEndpoints?.has('calls')) {
      throw ctx.fail(
        'search_endpoint_disabled',
        `Dialect '${dialect.id}' marks POST /search/calls as known-dead on this server. Genotype-call workflows are not viable here.`,
        { dialectId: dialect.id, ...ctx.recoveryFor('search_endpoint_disabled') },
      );
    }

    const config = getServerConfig();
    const maxCalls = input.maxCalls ?? config.genotypeCallsMaxPull;

    const searchOpts: Parameters<typeof buildCallsSearchBody>[0] = {
      variantSetDbId: input.variantSetDbId,
    };
    if (input.germplasmDbIds !== undefined) searchOpts.germplasmDbIds = input.germplasmDbIds;
    const searchBody = buildCallsSearchBody(searchOpts);

    if (!searchBody.variantSetDbIds) {
      throw ctx.fail(
        'no_filters',
        'variantSetDbId is required — unfiltered genotype-call pulls are prohibitively expensive.',
        { ...ctx.recoveryFor('no_filters') },
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

    // Build the pivot matrix plus the structured data the text encoders need.
    const matrix = buildMatrix(collected.rows, collected.callFormatting);

    // Register the wide matrix as a canvas dataframe (used by all three formats).
    const registerInput: RegisterDataframeInput = {
      source: 'export_genotype_matrix',
      baseUrl: connection.baseUrl,
      query: searchBody,
      rows: matrix.matrixRows,
    };
    if (collected.truncated) {
      registerInput.truncated = true;
      registerInput.maxRows = maxCalls;
    }
    const dfResult = await bridge.registerDataframe(ctx, registerInput);
    const dataframeHandle = toDataframeHandle(dfResult);

    // For text formats, pull variant coordinate metadata and render the text.
    let vcf: string | undefined;
    let ped: string | undefined;
    let map: string | undefined;
    if (input.format === 'vcf-lite' || input.format === 'plink') {
      const variantMeta = await collectVariantMetadata({
        client,
        connection,
        dialect,
        variantSetDbId: input.variantSetDbId,
        neededIds: new Set(matrix.variantIdOrder),
        ctx,
        warnings,
      });
      if (input.format === 'vcf-lite') {
        vcf = buildVcfText(matrix, variantMeta, collected.callFormatting);
      } else {
        ped = buildPedText(matrix, collected.callFormatting);
        map = buildMapText(matrix, variantMeta);
        warnings.push(
          'PLINK alleles are passed through verbatim from the genotype calls; numeric (0/1) codings are not recoded to nucleotides and `0` denotes PLINK missing. Supply letter-coded genotypes or recode downstream if a true biallelic .ped is required.',
        );
      }
    }

    const result: Output = {
      alias: connection.alias,
      format: input.format,
      rowCount: matrix.matrixRows.length,
      columnCount: matrix.columnCount,
      variantColumnLegend: matrix.variantColumnLegend,
      callFormatting: collected.callFormatting,
      dataframe: dataframeHandle,
      truncated: collected.truncated,
      warnings,
    };
    if (vcf !== undefined) result.vcf = vcf;
    if (ped !== undefined) result.ped = ped;
    if (map !== undefined) result.map = map;

    return result;
  },

  format: (result) => {
    const lines: string[] = [];

    lines.push(
      `# Genotype matrix — ${result.format} — ${result.rowCount} germplasm × ${result.columnCount} variants — \`${result.alias}\``,
    );
    if (result.truncated) lines.push('> **Truncated** at pull cap. See `warnings` for details.');
    lines.push('');

    lines.push('## Dataframe');
    lines.push(...renderDataframeHandle(result.dataframe));
    lines.push('');

    lines.push('## Call formatting');
    const f = result.callFormatting;
    lines.push(`- expandHomozygotes: ${f.expandHomozygotes ?? '—'}`);
    lines.push(`- unknownString: ${f.unknownString ?? '—'}`);
    lines.push(`- sepPhased: ${f.sepPhased ?? '—'}`);
    lines.push(`- sepUnphased: ${f.sepUnphased ?? '—'}`);
    lines.push('');

    const legendEntries = Object.entries(result.variantColumnLegend);
    if (legendEntries.length > 0) {
      const remapped = legendEntries.filter(([col, orig]) => col !== orig);
      if (remapped.length > 0) {
        lines.push('## Column name remappings (sanitized → original)');
        for (const [col, orig] of remapped.slice(0, 20)) {
          lines.push(`- \`${col}\` → \`${orig}\``);
        }
        if (remapped.length > 20) lines.push(`- …and ${remapped.length - 20} more`);
        lines.push('');
      }
    }

    // Render the format text (preview-capped; full text is in structuredContent).
    if (result.vcf !== undefined) {
      lines.push(...renderTextPreview('VCF-lite', 'vcf', result.vcf));
    }
    if (result.map !== undefined) {
      lines.push(...renderTextPreview('PLINK .map', 'map', result.map));
    }
    if (result.ped !== undefined) {
      lines.push(...renderTextPreview('PLINK .ped', 'ped', result.ped));
    }

    if (result.warnings.length > 0) {
      lines.push('## Warnings');
      for (const w of result.warnings) lines.push(`- ${w}`);
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});

// ---------------------------------------------------------------------------
// content[] text preview
// ---------------------------------------------------------------------------

function renderTextPreview(label: string, field: string, text: string): string[] {
  const allLines = text.split('\n');
  const preview = allLines.slice(0, FORMAT_PREVIEW_LINES);
  const out = [`## ${label}`, '```', ...preview];
  if (allLines.length > FORMAT_PREVIEW_LINES) {
    out.push(
      `… ${allLines.length - FORMAT_PREVIEW_LINES} more line(s) — full text in structuredContent.${field}`,
    );
  }
  out.push('```', '');
  return out;
}

// ---------------------------------------------------------------------------
// Matrix pivot
// ---------------------------------------------------------------------------

interface MatrixBuildResult {
  /** Number of distinct variant columns. */
  columnCount: number;
  /** sample → variantDbId → rendered genotype string. */
  genotypeAt: Map<string, Map<string, string>>;
  /** Wide rows registered as the canvas dataframe (one per sample). */
  matrixRows: Record<string, unknown>[];
  /** Row key → display label (callSetName when present). */
  sampleLabels: Record<string, string>;
  /** Sample (call-set) row keys in encounter order. */
  sampleOrder: string[];
  /** Map of sanitized column name → original variantDbId. */
  variantColumnLegend: Record<string, string>;
  /** Distinct variantDbIds in encounter order. */
  variantIdOrder: string[];
}

/**
 * Pivot the flat call rows into a wide germplasm × variant matrix and capture
 * the ordered structures the VCF/PLINK encoders consume.
 *
 * Row identity: `callSetDbId` (preferred) or `callSetName`, else `'unknown'`.
 * Variant identity: `variantDbId` (preferred) or `variantName`.
 */
function buildMatrix(rows: CallRow[], callFormatting: CallFormatting): MatrixBuildResult {
  const variantSeen = new Set<string>();
  const variantIdOrder: string[] = [];
  const sampleSeen = new Set<string>();
  const sampleOrder: string[] = [];
  const sampleLabels: Record<string, string> = {};
  const genotypeAt = new Map<string, Map<string, string>>();

  for (const row of rows) {
    const vid = row.variantDbId ?? row.variantName ?? 'unknown_variant';
    if (!variantSeen.has(vid)) {
      variantSeen.add(vid);
      variantIdOrder.push(vid);
    }
    const sampleKey = row.callSetDbId ?? row.callSetName ?? 'unknown';
    if (!sampleSeen.has(sampleKey)) {
      sampleSeen.add(sampleKey);
      sampleOrder.push(sampleKey);
      sampleLabels[sampleKey] = row.callSetName ?? sampleKey;
    }
    const gt = renderGenotypeString(row, callFormatting);
    let byVariant = genotypeAt.get(sampleKey);
    if (!byVariant) {
      byVariant = new Map();
      genotypeAt.set(sampleKey, byVariant);
    }
    byVariant.set(vid, gt);
  }

  const { columns: sanitizedCols, toOriginal: variantColumnLegend } =
    buildUniqueColumns(variantIdOrder);

  const matrixRows: Record<string, unknown>[] = sampleOrder.map((sampleKey) => {
    const row: Record<string, unknown> = { germplasmDbId: sampleKey };
    const byVariant = genotypeAt.get(sampleKey);
    variantIdOrder.forEach((vid, i) => {
      const col = sanitizedCols[i] ?? `v_${i}`;
      row[col] = byVariant?.get(vid) ?? null;
    });
    return row;
  });

  return {
    matrixRows,
    variantColumnLegend,
    columnCount: variantIdOrder.length,
    variantIdOrder,
    sampleOrder,
    sampleLabels,
    genotypeAt,
  };
}

// ---------------------------------------------------------------------------
// VCF-lite / PLINK text encoders
// ---------------------------------------------------------------------------

/** Tab-join a row of cells. */
function tsv(cells: readonly (string | number)[]): string {
  return cells.map(String).join('\t');
}

function buildVcfText(
  matrix: MatrixBuildResult,
  variantMeta: Map<string, VariantMeta>,
  callFormatting: CallFormatting,
): string {
  const missing = callFormatting.unknownString ?? '.';
  const header = [
    '#CHROM',
    'POS',
    'ID',
    'REF',
    'ALT',
    ...matrix.sampleOrder.map((s) => matrix.sampleLabels[s] ?? s),
  ];
  const lines = [tsv(header)];
  for (const vid of matrix.variantIdOrder) {
    const m = variantMeta.get(vid) ?? {};
    const genotypes = matrix.sampleOrder.map((s) => matrix.genotypeAt.get(s)?.get(vid) ?? missing);
    lines.push(tsv([m.chrom ?? '.', m.pos ?? '.', vid, m.ref ?? '.', m.alt ?? '.', ...genotypes]));
  }
  return lines.join('\n');
}

function buildMapText(matrix: MatrixBuildResult, variantMeta: Map<string, VariantMeta>): string {
  // chromosome, variant-id, genetic-distance (0 placeholder), base-pair position
  return matrix.variantIdOrder
    .map((vid) => {
      const m = variantMeta.get(vid) ?? {};
      return tsv([m.chrom ?? '0', vid, '0', m.pos ?? '0']);
    })
    .join('\n');
}

function buildPedText(matrix: MatrixBuildResult, callFormatting: CallFormatting): string {
  // FID IID PAT MAT SEX PHENO (all 0 placeholders) + biallelic genotype pairs.
  return matrix.sampleOrder
    .map((sampleKey) => {
      const fields: string[] = [
        '0',
        matrix.sampleLabels[sampleKey] ?? sampleKey,
        '0',
        '0',
        '0',
        '0',
      ];
      const byVariant = matrix.genotypeAt.get(sampleKey);
      for (const vid of matrix.variantIdOrder) {
        const [a1, a2] = splitAlleles(byVariant?.get(vid), callFormatting);
        fields.push(a1, a2);
      }
      return fields.join('\t');
    })
    .join('\n');
}

/**
 * Split a rendered genotype string into a biallelic pair for PLINK .ped. Splits
 * on `/` or `|`; a single allele is treated as homozygous; unknown/missing maps
 * to PLINK's `0` sentinel. Polyploid calls keep the first two alleles.
 */
function splitAlleles(gt: string | undefined, callFormatting: CallFormatting): [string, string] {
  const unknown = callFormatting.unknownString ?? '.';
  if (!gt || gt === unknown) return ['0', '0'];
  const norm = (t: string): string => (t === unknown || t === '.' ? '0' : t);
  const tokens = gt
    .split(/[/|]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return ['0', '0'];
  if (tokens.length === 1) {
    const a = norm(tokens[0] as string);
    return [a, a];
  }
  return [norm(tokens[0] as string), norm(tokens[1] as string)];
}

// ---------------------------------------------------------------------------
// Variant coordinate metadata pull (vcf-lite / plink only)
// ---------------------------------------------------------------------------

interface CollectVariantMetadataArgs {
  client: BrapiClient;
  connection: RegisteredServer;
  ctx: Context;
  dialect: BrapiDialect;
  neededIds: Set<string>;
  variantSetDbId: string;
  warnings: string[];
}

/**
 * Page `/variants?variantSetDbId=…` and build a `variantDbId → VariantMeta` map
 * (CHROM/POS/REF/ALT) for the variants in the matrix. Best-effort: a dropped
 * filter, missing endpoint, or fetch error degrades to placeholders plus a
 * warning rather than failing the export. Stops early once every needed variant
 * is covered.
 */
async function collectVariantMetadata(
  args: CollectVariantMetadataArgs,
): Promise<Map<string, VariantMeta>> {
  const { client, connection, dialect, variantSetDbId, neededIds, ctx, warnings } = args;
  const meta = new Map<string, VariantMeta>();
  try {
    const adapted = dialect.adaptGetFilters('variants', { variantSetDbIds: [variantSetDbId] });
    if (adapted.dropped.length > 0 && Object.keys(adapted.filters).length === 0) {
      warnings.push(
        `Variant metadata pull skipped: dialect '${dialect.id}' dropped the variantSetDbId filter on /variants. CHROM/POS/REF/ALT use placeholders.`,
      );
      return meta;
    }

    let page = 0;
    let totalPages = 1;
    let scanned = 0;
    while (page < totalPages && scanned < MAX_VARIANT_METADATA_ROWS && !ctx.signal.aborted) {
      const opts = buildRequestOptions(connection, {
        ...(adapted.filters as Record<
          string,
          string | number | boolean | readonly (string | number)[] | undefined
        >),
        pageSize: VARIANT_METADATA_PAGE_SIZE,
        page,
      });
      const envelope = await client.get<
        BrapiListResult<Record<string, unknown>> | Record<string, unknown>[]
      >(connection.baseUrl, '/variants', ctx, opts);
      const rows = extractRows<Record<string, unknown>>(envelope.result);
      for (const r of rows) {
        scanned++;
        const vid = asString(r.variantDbId);
        if (!vid) continue;
        meta.set(vid, extractVariantMeta(r));
      }
      totalPages = envelope.metadata?.pagination?.totalPages ?? page + 1;
      page++;
      if (neededIds.size > 0 && [...neededIds].every((id) => meta.has(id))) break;
      if (rows.length < VARIANT_METADATA_PAGE_SIZE) break;
    }
  } catch (err) {
    warnings.push(
      `Variant metadata pull failed (${err instanceof Error ? err.message : String(err)}). CHROM/POS/REF/ALT use placeholders.`,
    );
  }
  return meta;
}

function extractVariantMeta(r: Record<string, unknown>): VariantMeta {
  const meta: VariantMeta = {};
  const chrom = asString(r.referenceName);
  if (chrom) meta.chrom = chrom;
  const start = r.start;
  if (typeof start === 'number') meta.pos = String(start);
  else {
    const startStr = asString(start);
    if (startStr) meta.pos = startStr;
  }
  const ref = asString(r.referenceBases);
  if (ref) meta.ref = ref;
  const altRaw = r.alternateBases;
  if (Array.isArray(altRaw)) {
    const alts = altRaw.filter((a): a is string => typeof a === 'string' && a.length > 0);
    if (alts.length > 0) meta.alt = alts.join(',');
  } else {
    const alt = asString(altRaw);
    if (alt) meta.alt = alt;
  }
  return meta;
}
