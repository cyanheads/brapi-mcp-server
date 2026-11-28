/**
 * @fileoverview `brapi_export_genotype_matrix` — pull genotype calls for a
 * variant set and pivot them into a call set × variant matrix in the requested
 * format.
 *
 * A call set is one sample's calls, so rows are call sets, not germplasm. Each
 * row leads with `callSetDbId`, `callSetName`, and `germplasmDbId`; the
 * germplasm is resolved before a filtered pull, or after an unfiltered pull by batch lookups (paged `/callsets` for
 * the variant set, then `/search/samples` by sample ID) and stays null when a
 * lookup is unavailable or fails, so the matrix joins to
 * `brapi_build_phenotype_matrix` on `germplasmDbId`.
 *
 * Three output formats:
 *
 * - `matrix-json`: Wide call set × variant table registered as a canvas
 *   dataframe (`df_<uuid>`). One row per call set; one column per variant.
 *   Column names are sanitized for DuckDB (SQL-safe identifiers); a
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
 * shared via `src/mcp-server/tools/shared/canvas-columns.ts`. The matrix pivot,
 * text encoders, `/variants` metadata pull, and call-set germplasm lookup live
 * in `genotype-matrix.ts`, `genotype-text-formats.ts`, `variant-metadata.ts`,
 * and `callset-germplasm.ts` beside them.
 *
 * @module mcp-server/tools/definitions/brapi-export-genotype-matrix.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, requestCancelled } from '@cyanheads/mcp-ts-core/errors';
import {
  GENOTYPE_CALLS_MAX_PULL_CEILING,
  GENOTYPE_MATRIX_MAX_COLUMNS_CEILING,
  getServerConfig,
} from '@/config/server-config.js';
import { getBrapiClient } from '@/services/brapi-client/index.js';
import { resolveDialect } from '@/services/brapi-dialect/index.js';
import { getCanvasBridge, type RegisterDataframeInput } from '@/services/canvas-bridge/index.js';
import { DISCOVERY_NOT_FOUND_ERROR } from '@/services/capability-registry/capability-registry.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import { resolveCallSetGermplasm } from '../shared/callset-germplasm.js';
import {
  AliasInput,
  DataframeHandleSchema,
  NonBlankString,
  renderDataframeHandle,
  requireRegisteredConnection,
  stagedDataframeNotice,
  toDataframeHandle,
} from '../shared/find-helpers.js';
import {
  buildCallsSearchBody,
  collectCalls,
  NO_MATCHING_CALLS_NOTICE,
} from '../shared/genotype-calls.js';
import {
  GERMPLASM_SCOPE_UNAVAILABLE,
  resolveGenotypeGermplasmScope,
} from '../shared/genotype-germplasm-scope.js';
import {
  buildMatrix,
  IDENTITY_COLUMNS,
  keepRequestedVariants,
  pullEndNotice,
} from '../shared/genotype-matrix.js';
import { buildMapText, buildPedText, buildVcfText } from '../shared/genotype-text-formats.js';
import { fenced, literal } from '../shared/markdown-literals.js';
import { collectVariantMetadata, type VariantMeta } from '../shared/variant-metadata.js';

/** Lines of format text shown inline in content[] before the preview notice fires. */
const FORMAT_PREVIEW_LINES = 25;

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

const OutputSchema = z.object({
  alias: z.string().describe('Connection alias the call used.'),
  format: z
    .enum(['plink', 'vcf-lite', 'matrix-json'])
    .describe('The output format that was produced.'),
  rowCount: z.number().int().nonnegative().describe('Number of call-set rows in the matrix.'),
  columnCount: z
    .number()
    .int()
    .nonnegative()
    .describe('Number of variant columns in the matrix (excluding the identity columns).'),
  variantColumnLegend: z
    .record(z.string(), z.string())
    .describe('SQL-safe dataframe column name → original variantDbId.'),
  callFormatting: z
    .object({
      expandHomozygotes: z.boolean().nullish().describe('Homozygous allele expansion flag.'),
      unknownString: z.string().nullish().describe('String used for unknown/missing calls.'),
      sepPhased: z.string().nullish().describe('Phased allele separator.'),
      sepUnphased: z.string().nullish().describe('Unphased allele separator.'),
    })
    .describe('Genotype-encoding hints echoed by the server.'),
  dataframe: DataframeHandleSchema.describe(
    'The wide call set × variant matrix with raw genotype values, staged for every format. brapi_dataframe_export writes it to a file where that tool is listed.',
  ),
  vcf: z
    .string()
    .optional()
    .describe(
      'VCF-lite text — header `#CHROM POS ID REF ALT` plus genotype columns. One-based POS is BrAPI start + 1; missing/invalid coordinates use ".". Present for format="vcf-lite".',
    ),
  ped: z
    .string()
    .optional()
    .describe(
      'PLINK .ped text — FID IID PAT MAT SEX PHENO placeholders followed by allele pairs per variant. Indexed alleles use REF/ALT labels when available or positive numeric labels when metadata is missing. Missing calls use 0 0. Present for format="plink".',
    ),
  map: z
    .string()
    .optional()
    .describe(
      'PLINK .map text — chromosome, variant ID, genetic-distance placeholder 0, and one-based position (BrAPI start + 1). Missing/invalid coordinates use `0`. Present for format="plink".',
    ),
  truncated: z
    .boolean()
    .describe(
      'True when the matrix is not the complete upstream result: the call pull reached the effective maxCalls cap or ran out of time before the last page, or more distinct variants came back than the effective maxColumns cap. `warnings` names which.',
    ),
  warnings: z.array(z.string()).describe('Advisory messages (truncation, missing fields, etc.).'),
});

type Output = z.infer<typeof OutputSchema>;

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const brapiExportGenotypeMatrix = tool('brapi_export_genotype_matrix', {
  description:
    "Pull genotype calls for a variant set and pivot them into a call set × variant matrix. Each row is one call set (one sample's calls), led by callSetDbId, callSetName, and germplasmDbId — the germplasm resolved through the call set's sample, null when unresolved. Join to brapi_build_phenotype_matrix on germplasmDbId; a germplasm with several call sets joins once per call set. `variantDbIds` restricts the pull to chosen variants, such as a region's from brapi_find_variants. `matrix-json` registers a wide canvas dataframe; `vcf-lite` adds VCF-subset text in `vcf`; `plink` adds .ped/.map text in `ped`/`map`. Text formats pull /variants metadata and convert zero-based BrAPI start to one-based positions; missing/invalid positions use `.`/`0`. Read the dataframe with brapi_dataframe_describe and brapi_dataframe_query (SQL). `variantColumnLegend` maps SQL-safe columns to original variant IDs.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'upstream_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'An uncaught BrAPI data request answered HTTP 404',
      recovery:
        'Check brapi_server_info for supported endpoints and verify the requested identifiers before retrying brapi_export_genotype_matrix.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'An uncaught BrAPI data request exhausted retries after HTTP 429',
      recovery:
        'Wait before retrying brapi_export_genotype_matrix; reduce concurrent requests to this BrAPI server.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'unknown_alias',
      code: JsonRpcErrorCode.NotFound,
      when: 'No connection is registered under the requested alias, and the server has no base URL configured for it to connect on first use',
      recovery:
        'Run brapi_connect with this alias and a `baseUrl`, or pass an alias the brapi_connect description lists as built-in or operator-configured, before calling brapi_export_genotype_matrix.',
      thrownBy: 'service',
    },
    {
      reason: 'auth_token_exchange_failed',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Connecting the alias on first use, the SGN or OAuth token exchange against the BrAPI /token endpoint failed',
      recovery:
        'Ask the operator to check the credentials configured for this alias and that the server exposes /token, or run brapi_connect with credentials in `auth`.',
      thrownBy: 'service',
    },
    {
      reason: 'auth_no_access_token',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Connecting the alias on first use, the token endpoint answered without returning an access token',
      recovery:
        'Ask the operator to check that the credentials configured for this alias are valid and that the upstream IdP issues access tokens for this grant.',
      thrownBy: 'service',
    },
    DISCOVERY_NOT_FOUND_ERROR,
    {
      reason: 'capability_discovery_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Neither /serverinfo nor /calls listed any call, and at least one of them timed out, was unreachable, or answered 429 or a 5xx other than 501, so nothing was cached',
      recovery:
        'The BrAPI server is slow or unreachable right now. Retry brapi_export_genotype_matrix in a minute; if it keeps failing, the server may be down.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unauthorized',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'The BrAPI server answered HTTP 401: it requires credentials, or rejected the ones sent',
      recovery:
        'Run brapi_connect with credentials in `auth`, or ask the operator to set server-side credentials for this alias, then retry brapi_export_genotype_matrix.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The BrAPI server answered HTTP 403: the credentials sent, or their absence, lack access',
      recovery:
        'Run brapi_connect with credentials that have access, or ask the operator to set server-side credentials for this alias that do, then retry brapi_export_genotype_matrix.',
      thrownBy: 'service',
    },
    {
      reason: 'alias_base_url_invalid',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'The base URL configured on the server for this alias is not an absolute http(s) URL, or carries credentials',
      recovery:
        'Ask the operator to set the base URL configured for this alias to an absolute http(s) URL, then retry brapi_export_genotype_matrix.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'private_address_blocked',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The base URL configured for this alias, or its token URL, is on a private or reserved address this server may not reach',
      recovery:
        'Ask the operator to point this alias at a publicly routable host, or to allow private addresses on this server, then retry brapi_export_genotype_matrix.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'no_filters',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No variantSetDbId was provided',
      recovery:
        'Provide variantSetDbId before retrying — unfiltered genotype-call pulls are too expensive.',
    },
    {
      reason: 'germplasm_scope_unavailable',
      ...GERMPLASM_SCOPE_UNAVAILABLE,
      recovery:
        'Use a BrAPI server that can resolve germplasm membership, or use explicit callSetDbIds with brapi_find_genotype_calls for scoped rows.',
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
      .array(NonBlankString)
      .optional()
      .describe(
        'Resolve these germplasm IDs to call sets before pulling calls. Omit to include all call sets in the variant set.',
      ),
    variantSetDbId: NonBlankString.describe(
      'Variant set to pull calls for. Required. List variant sets with brapi_raw_get({ path: "/variantsets" }) — add params.studyDbId to narrow to one study or genotyping project — and read variantSetDbId from the rows.',
    ),
    variantDbIds: z
      .array(NonBlankString)
      .optional()
      .describe(
        'Restrict the matrix to these variants — e.g. the variantDbIds brapi_find_variants returns for a region. Calls the server returns for other variants are left out. Export a large variant set in batches of at most maxColumns variants.',
      ),
    format: z
      .enum(['plink', 'vcf-lite', 'matrix-json'])
      .describe(
        'Output format. `matrix-json` registers a wide canvas dataframe only. `vcf-lite` returns VCF-subset text and registers the dataframe. `plink` returns .ped/.map text and registers the dataframe.',
      ),
    maxCalls: z
      .number()
      .int()
      .positive()
      .max(GENOTYPE_CALLS_MAX_PULL_CEILING)
      .optional()
      .describe(
        'Lower the pull cap for this call. Omit to use the deployment ceiling. Cannot raise it: a value above the deployment ceiling is clamped down to it and the effective cap is reported in `warnings`.',
      ),
    maxColumns: z
      .number()
      .int()
      .positive()
      .max(GENOTYPE_MATRIX_MAX_COLUMNS_CEILING)
      .optional()
      .describe(
        'Lower the distinct-variant column cap for this call. Omit to use the deployment ceiling. Cannot raise it: a value above the deployment ceiling is clamped down to it. When the variant set resolves more distinct variants than the effective cap, the matrix keeps that many variant columns (listed in `variantColumnLegend`), `truncated` is set, and the effective cap is reported in `warnings`; pass the other variants as `variantDbIds` to export them. Independent of `maxCalls`, which bounds the row (call) pull.',
      ),
  }),
  inputAliases: {
    germplasmDbId: 'germplasmDbIds',
    variantDbId: 'variantDbIds',
  },
  output: OutputSchema,
  enrichment: {
    notice: z.string().optional().describe('The matrix dataframe and the tools that read it.'),
  },

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
    // Read before the pull so the germplasm lookup after it never refetches.
    const { supported } = await capabilities.profile(connection.baseUrl, ctx, capabilityLookup);

    const dialect = await resolveDialect(connection, ctx, capabilityLookup);
    if (dialect.disabledSearchEndpoints?.has('calls')) {
      throw ctx.fail(
        'search_endpoint_disabled',
        `Dialect '${dialect.id}' marks POST /search/calls as known-dead on this server. Genotype-call workflows are not viable here.`,
        { dialectId: dialect.id },
      );
    }

    const config = getServerConfig();
    const warnings: string[] = [];

    // The deployment ceiling wins: `maxCalls` may lower the pull for this call
    // but never raise it past what the operator configured. `maxCalls` is the
    // only bound on the generated matrix — and therefore on the vcf/ped/map
    // text and the canvas table — so an unclamped override would let a single
    // call page far past the operator's limit and generate an artifact sized
    // to match.
    const requestedMaxCalls = input.maxCalls ?? config.genotypeCallsMaxPull;
    const maxCalls = Math.min(requestedMaxCalls, config.genotypeCallsMaxPull);
    if (maxCalls < requestedMaxCalls) {
      warnings.push(
        `maxCalls=${requestedMaxCalls} exceeds this deployment's genotype-call ceiling (${config.genotypeCallsMaxPull}); the pull was capped at ${maxCalls} calls. Results may be truncated — see \`truncated\`.`,
      );
    }

    // Same deployment-ceiling-wins shape as `maxCalls`, on the orthogonal axis:
    // `maxCalls` bounds the rows pulled, `maxColumns` bounds the distinct-variant
    // columns those rows pivot into. Nothing constrains the call-set-to-variant
    // ratio, so a schema-legal skew (one call set × `maxCalls` variants) would
    // otherwise drive `columnCount` — and the variantColumnLegend, the wide
    // dataframe, and the vcf/ped/map text with it — to the full call budget.
    const requestedMaxColumns = input.maxColumns ?? config.genotypeMatrixMaxColumns;
    const maxColumns = Math.min(requestedMaxColumns, config.genotypeMatrixMaxColumns);
    if (maxColumns < requestedMaxColumns) {
      warnings.push(
        `maxColumns=${requestedMaxColumns} exceeds this deployment's genotype-matrix column ceiling (${config.genotypeMatrixMaxColumns}); the matrix is capped at ${maxColumns} variant columns. See \`truncated\`.`,
      );
    }

    const searchBody = buildCallsSearchBody({
      variantSetDbId: input.variantSetDbId,
      variantDbIds: input.variantDbIds,
    });

    if (!searchBody.variantSetDbIds) {
      throw ctx.fail(
        'no_filters',
        'variantSetDbId is required — unfiltered genotype-call pulls are prohibitively expensive.',
      );
    }

    const germplasmDbIds = input.germplasmDbIds ?? [];
    const germplasmScope =
      germplasmDbIds.length > 0
        ? await resolveGenotypeGermplasmScope({
            client,
            connection,
            ctx,
            dialect,
            supported,
            germplasmDbIds,
            unavailable: (message, details) =>
              ctx.fail('germplasm_scope_unavailable', message, details),
            variantSetDbIds: searchBody.variantSetDbIds,
          })
        : undefined;
    const collected = await collectCalls({
      client,
      connection,
      ctx,
      body: searchBody,
      germplasmScope,
      maxCalls,
      warnings,
    });
    const callRows = keepRequestedVariants(collected.rows, input.variantDbIds, warnings);

    // Build the pivot matrix plus the structured data the text encoders need.
    // The column cap is applied *inside* the pivot loop (net-new variants past
    // `maxColumns` are skipped as rows stream in), so the over-wide legend and
    // matrix are never materialized then trimmed — a true resource bound, not
    // post-hoc waste.
    const matrix = buildMatrix(callRows, collected.callFormatting, maxColumns);
    if (matrix.columnsTruncated) {
      warnings.push(
        `The variant set resolved more than ${maxColumns} distinct variants; the matrix keeps ${maxColumns} variant columns, listed in variantColumnLegend, and dropped the rest. Every call set is still present — one whose calls all fall in the dropped variants appears as an all-null row. To export the rest, pass variants missing from variantColumnLegend as variantDbIds (brapi_find_variants lists a variant set's or a region's variants), at most ${maxColumns} per call.`,
      );
    }
    if (collected.truncated || collected.stopReason !== undefined) {
      warnings.push(pullEndNotice(matrix, callRows.at(-1)));
    }

    // Germplasm resolution and the text formats' /variants pull are independent
    // companions: run them together, each degrading to its own warnings, and
    // append those in a fixed order.
    const textFormat = input.format === 'vcf-lite' || input.format === 'plink';
    const metadataWarnings: string[] = [];
    const [germplasm, variantMeta] = await Promise.all([
      germplasmScope
        ? { germplasmByCallSet: germplasmScope, warnings: [] }
        : resolveCallSetGermplasm({
            client,
            connection,
            ctx,
            dialect,
            callSets: matrix.matrixRows,
            supported,
            variantSetDbId: input.variantSetDbId,
          }),
      textFormat && matrix.columnCount > 0
        ? collectVariantMetadata({
            client,
            connection,
            dialect,
            variantSetDbId: input.variantSetDbId,
            neededIds: new Set(matrix.variantIdOrder),
            ctx,
            warnings: metadataWarnings,
          })
        : new Map<string, VariantMeta>(),
    ]);
    for (const row of matrix.matrixRows) {
      if (typeof row.callSetDbId === 'string') {
        row.germplasmDbId = germplasm.germplasmByCallSet.get(row.callSetDbId) ?? null;
      }
    }
    warnings.push(...germplasm.warnings, ...metadataWarnings);

    let vcf: string | undefined;
    let ped: string | undefined;
    let map: string | undefined;
    if (textFormat) {
      if (matrix.hasAmbiguousValues) {
        warnings.push(
          'Bare numeric genotype values can represent dosage or a single allele index. Text export marks those calls missing. Query the staged matrix with brapi_dataframe_query to retrieve the original values.',
        );
      }
      if (input.format === 'vcf-lite') {
        vcf = buildVcfText(matrix, variantMeta, collected.callFormatting);
      } else {
        ped = buildPedText(matrix, variantMeta, collected.callFormatting, warnings);
        map = buildMapText(matrix, variantMeta);
      }
    }
    if (ctx.signal.aborted)
      throw requestCancelled('Genotype matrix export cancelled by the caller.');

    // Register the wide matrix as a canvas dataframe (used by all three formats).
    const registerInput: RegisterDataframeInput = {
      source: 'export_genotype_matrix',
      baseUrl: connection.baseUrl,
      query: germplasmScope ? { ...searchBody, germplasmDbIds } : searchBody,
      rows: matrix.matrixRows,
    };
    if (matrix.matrixRows.length === 0) {
      registerInput.emptySchema = IDENTITY_COLUMNS.map((name) => ({
        name,
        type: 'VARCHAR' as const,
        nullable: true,
      }));
    }
    // A column cap leaves the dataframe incomplete too — flag it so a reader who
    // inspects the handle without reading `warnings` doesn't take the matrix as
    // whole. `maxRows` stays row-scoped: it's set only when the call pull hit the
    // row ceiling, never for a pure column cap (which doesn't reduce row count).
    // A pull the call deadline ended early is incomplete too.
    const incomplete =
      collected.truncated || collected.stopReason !== undefined || matrix.columnsTruncated;
    if (incomplete) {
      registerInput.truncated = true;
    }
    if (collected.truncated) {
      registerInput.maxRows = maxCalls;
    }
    const dfResult = await bridge.registerDataframe(ctx, registerInput);
    const dataframeHandle = toDataframeHandle(dfResult);
    const stagedNotice = stagedDataframeNotice([dataframeHandle]);
    ctx.enrich.notice(
      matrix.matrixRows.length === 0 ? `${NO_MATCHING_CALLS_NOTICE} ${stagedNotice}` : stagedNotice,
    );

    const result: Output = {
      alias: connection.alias,
      format: input.format,
      rowCount: matrix.matrixRows.length,
      columnCount: matrix.columnCount,
      variantColumnLegend: matrix.variantColumnLegend,
      callFormatting: collected.callFormatting,
      dataframe: dataframeHandle,
      truncated: incomplete,
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
      literal`# Genotype matrix — ${result.format} — ${result.rowCount} call sets × ${result.columnCount} variants — \`${result.alias}\``,
    );
    if (result.truncated) lines.push('> **Truncated.** See `warnings` for why.');
    lines.push('');

    lines.push('## Dataframe');
    lines.push(...renderDataframeHandle(result.dataframe));
    lines.push('');

    lines.push('## Call formatting');
    const f = result.callFormatting;
    lines.push(`- expandHomozygotes: ${f.expandHomozygotes ?? '—'}`);
    lines.push(literal`- unknownString: ${f.unknownString ?? '—'}`);
    lines.push(literal`- sepPhased: ${f.sepPhased ?? '—'}`);
    lines.push(literal`- sepUnphased: ${f.sepUnphased ?? '—'}`);
    lines.push('');

    const legendEntries = Object.entries(result.variantColumnLegend);
    if (legendEntries.length > 0) {
      const remapped = legendEntries.filter(([col, orig]) => col !== orig);
      if (remapped.length > 0) {
        // Rendered in full: this legend is the only thing that decodes the
        // sanitized column names back to variant IDs, and it has no dataframe
        // or re-call path to fall back on — a cap here silently drops the
        // decoding for columns the `## Dataframe` section above already names.
        lines.push('## Column name remappings (sanitized → original)');
        for (const [col, orig] of remapped) {
          lines.push(literal`- \`${col}\` → \`${orig}\``);
        }
        lines.push('');
      }
    }

    // Independent `if`s, never an if/else chain on `format`: the parity linter
    // populates every output field at once, so an untaken branch would render
    // nothing and fail the check. Render on field presence.
    const tableName = result.dataframe.tableName;
    if (result.vcf !== undefined) {
      lines.push(
        ...renderTextPreview({ label: 'VCF-lite', field: 'vcf', text: result.vcf, tableName }),
      );
    }
    if (result.map !== undefined) {
      lines.push(
        ...renderTextPreview({ label: 'PLINK .map', field: 'map', text: result.map, tableName }),
      );
    }
    if (result.ped !== undefined) {
      lines.push(
        ...renderTextPreview({ label: 'PLINK .ped', field: 'ped', text: result.ped, tableName }),
      );
    }

    if (result.warnings.length > 0) {
      lines.push('## Warnings');
      for (const w of result.warnings) lines.push(literal`- ${w}`);
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});

// ---------------------------------------------------------------------------
// content[] text preview
// ---------------------------------------------------------------------------

/**
 * Render a format text field as a capped preview plus a notice naming where the
 * rest can actually be read.
 *
 * The text is not rendered complete on purpose: `maxCalls` bounds
 * `rowCount × columnCount`, but nothing constrains the call-set-to-variant
 * ratio, so a schema-legal skew (one call set × `maxCalls` variants) drives a
 * single `vcf` or `map` string to ~16MB at the 500,000 ceiling — and
 * `content[]` would carry it a second time on top of `structuredContent`.
 *
 * The notice names the dataframe rather than only `structuredContent`, which
 * content-only clients cannot read. It is registered for every format, so it
 * always exists by the time this runs. The coordinate caveat is not hedging:
 * the dataframe holds `{callSetDbId, callSetName, germplasmDbId, <variant
 * columns>: genotype}` and none of the CHROM/POS/REF/ALT metadata pulled
 * separately from `/variants`, so presenting it as a complete substitute for
 * the text would be false.
 */
function renderTextPreview(opts: {
  /** Section heading, e.g. `PLINK .map`. */
  label: string;
  /** Output-schema field carrying the complete text, e.g. `map`. */
  field: string;
  /** Dataframe holding the genotypes behind this serialization. */
  tableName: string;
  text: string;
}): string[] {
  const allLines = opts.text.split('\n');
  const preview = allLines.slice(0, FORMAT_PREVIEW_LINES);
  const out = [`## ${opts.label}`, fenced(preview.join('\n'))];
  if (allLines.length > FORMAT_PREVIEW_LINES) {
    out.push(
      `… ${allLines.length - FORMAT_PREVIEW_LINES} more line(s) not shown. Complete text: \`structuredContent.${opts.field}\`. Every call set × variant genotype is also in dataframe \`${opts.tableName}\` — query it with brapi_dataframe_query; it carries genotypes only, not the CHROM/POS/REF/ALT coordinates shown above.`,
    );
  }
  out.push('');
  return out;
}
