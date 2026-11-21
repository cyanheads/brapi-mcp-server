/**
 * @fileoverview Genotype matrix pivot for `brapi_export_genotype_matrix` — turns
 * flat call rows into a wide call set × variant matrix plus the ordered
 * structures the VCF/PLINK encoders consume, and the notes about calls the
 * pivot leaves out or the pull ended before reaching.
 *
 * @module mcp-server/tools/shared/genotype-matrix
 */

import { buildUniqueColumns } from './canvas-columns.js';
import { type CallFormatting, renderGenotypeString, type WireCallRow } from './genotype-calls.js';

/** Leading dataframe columns that identify a matrix row; no variant column may take one. */
export const IDENTITY_COLUMNS = ['callSetDbId', 'callSetName', 'germplasmDbId'] as const;

interface GenotypeCell {
  ambiguous: boolean;
  text: string;
}

/** The identity a call set's first call row carries. A name never stands in for the ID. */
interface CallSetIdentity {
  callSetDbId: string | null;
  callSetName: string | null;
}

export interface MatrixBuildResult {
  /** Row key → the call set's identity, in encounter order. */
  callSets: Map<string, CallSetIdentity>;
  /** Number of distinct variant columns (≤ the `maxColumns` cap). */
  columnCount: number;
  /** True when distinct variants exceeded `maxColumns` and net-new ones were dropped. */
  columnsTruncated: boolean;
  /** Row key → variantDbId → raw rendered genotype and encoding information. */
  genotypeAt: Map<string, Map<string, GenotypeCell>>;
  hasAmbiguousValues: boolean;
  /**
   * Wide rows registered as the canvas dataframe, one per call set: the
   * identity columns, then one column per kept variant. `germplasmDbId` is null
   * until `resolveCallSetGermplasm` fills it.
   */
  matrixRows: Record<string, unknown>[];
  /** Call-set row keys in encounter order. */
  sampleOrder: string[];
  /** Map of sanitized column name → original variantDbId. */
  variantColumnLegend: Record<string, string>;
  /** Distinct variantDbIds in encounter order. */
  variantIdOrder: string[];
}

/** Matrix row key: `callSetDbId` (preferred) or `callSetName`, else `'unknown'`. */
function callSetKey(row: WireCallRow): string {
  return row.callSetDbId ?? row.callSetName ?? 'unknown';
}

/** VCF sample / PLINK IID label: `callSetName`, else `callSetDbId`. */
export function sampleLabel(matrix: MatrixBuildResult, key: string): string {
  const identity = matrix.callSets.get(key);
  return identity?.callSetName ?? identity?.callSetDbId ?? key;
}

/**
 * Pivot the flat call rows into a wide call set × variant matrix and capture
 * the ordered structures the VCF/PLINK encoders consume.
 *
 * Row identity: {@link callSetKey}. Variant identity: `variantDbId`
 * (preferred) or `variantName`.
 *
 * `maxColumns` bounds the distinct-variant column count only — never the
 * call-set rows. Every call set seen in any row is registered as a matrix
 * row; the cap drops variant *columns*, not rows. The cap is enforced as rows
 * stream in: once `maxColumns` distinct variants have been seen, a row
 * introducing a *net-new* variant contributes no column and no stored genotype,
 * but its call set is still registered first. A call set whose calls all
 * reference beyond-cap variants therefore renders as an honest all-null row —
 * present, empty in the kept columns — never a vanished row. This stays a
 * resource bound: the over-wide legend and per-column genotype cells are never
 * built, not built-then-trimmed.
 */
export function buildMatrix(
  rows: WireCallRow[],
  callFormatting: CallFormatting,
  maxColumns: number,
): MatrixBuildResult {
  const variantSeen = new Set<string>();
  const variantIdOrder: string[] = [];
  const callSets = new Map<string, CallSetIdentity>();
  const genotypeAt = new Map<string, Map<string, GenotypeCell>>();
  let columnsTruncated = false;

  for (const row of rows) {
    const vid = row.variantDbId ?? row.variantName ?? 'unknown_variant';
    // Register the call set on its first appearance, BEFORE the variant-cap
    // check below. Gating registration on a kept variant would drop the entire
    // row of any call set whose calls all reference beyond-cap variants —
    // silent row loss under call-set-major, disjoint coverage (the common
    // Breedbase /search/calls shape). It must still appear, empty in the kept
    // columns.
    const sampleKey = callSetKey(row);
    if (!callSets.has(sampleKey)) {
      callSets.set(sampleKey, {
        callSetDbId: row.callSetDbId ?? null,
        callSetName: row.callSetName ?? null,
      });
    }
    if (!variantSeen.has(vid)) {
      if (variantIdOrder.length >= maxColumns) {
        columnsTruncated = true;
        continue;
      }
      variantSeen.add(vid);
      variantIdOrder.push(vid);
    }
    const text = renderGenotypeString(row, callFormatting);
    const ambiguous =
      typeof row.genotype?.values === 'string' &&
      text !== callFormatting.unknownString &&
      isBareNumeric(text);
    let byVariant = genotypeAt.get(sampleKey);
    if (!byVariant) {
      byVariant = new Map();
      genotypeAt.set(sampleKey, byVariant);
    }
    byVariant.set(vid, { text, ambiguous });
  }

  const { columns: sanitizedCols, toOriginal: variantColumnLegend } = buildUniqueColumns(
    variantIdOrder,
    IDENTITY_COLUMNS,
  );

  let hasAmbiguousValues = false;
  const sampleOrder = [...callSets.keys()];
  const matrixRows: Record<string, unknown>[] = sampleOrder.map((sampleKey) => {
    const identity = callSets.get(sampleKey);
    const row: Record<string, unknown> = {
      callSetDbId: identity?.callSetDbId ?? null,
      callSetName: identity?.callSetName ?? null,
      germplasmDbId: null,
    };
    const byVariant = genotypeAt.get(sampleKey);
    variantIdOrder.forEach((vid, i) => {
      const col = sanitizedCols[i] ?? `v_${i}`;
      const cell = byVariant?.get(vid);
      if (cell?.ambiguous) hasAmbiguousValues = true;
      row[col] = cell?.text ?? null;
    });
    return row;
  });

  return {
    matrixRows,
    variantColumnLegend,
    columnCount: variantIdOrder.length,
    columnsTruncated,
    variantIdOrder,
    sampleOrder,
    callSets,
    genotypeAt,
    hasAmbiguousValues,
  };
}

/**
 * Leave out calls for variants the caller did not request. An upstream that
 * ignores `variantDbIds` returns every variant; without this the matrix would
 * hold the same leading columns for every batch a caller requests.
 */
export function keepRequestedVariants(
  rows: WireCallRow[],
  variantDbIds: readonly string[] | undefined,
  warnings: string[],
): WireCallRow[] {
  if (!variantDbIds?.length) return rows;
  const requested = new Set(variantDbIds);
  const kept = rows.filter((row) => row.variantDbId != null && requested.has(row.variantDbId));
  const dropped = rows.length - kept.length;
  if (dropped > 0) {
    warnings.push(
      `${dropped} returned call${dropped === 1 ? '' : 's'} referenced variants outside variantDbIds and were left out of the matrix: the server did not apply the variantDbIds filter.`,
    );
  }
  return kept;
}

/**
 * The export's own note after a pull the call cap or the call deadline ended:
 * which call set the pull ended at when it holds only part of the kept
 * variants (on call-set-major upstreams the cap cuts the last call set
 * mid-way), and `variantDbIds` as the filter that shrinks the pull. The shared
 * collector's warning stays generic because `brapi_find_genotype_calls` has
 * other filters to narrow.
 */
export function pullEndNotice(matrix: MatrixBuildResult, lastRow: WireCallRow | undefined): string {
  const pointer =
    "To reach the rest, export the variants in batches with variantDbIds (brapi_find_variants lists a variant set's or a region's variants): fewer variants per call set lets the pull cover more call sets.";
  if (!lastRow || matrix.columnCount === 0) return pointer;
  const key = callSetKey(lastRow);
  const carried = matrix.genotypeAt.get(key)?.size ?? 0;
  if (carried >= matrix.columnCount) return pointer;
  const identity = matrix.callSets.get(key);
  const named = identity?.callSetDbId
    ? `\`${identity.callSetDbId}\`${identity.callSetName ? ` (${identity.callSetName})` : ''}`
    : `\`${identity?.callSetName ?? key}\` (no callSetDbId)`;
  return `The pull ended at call set ${named}, which carries ${carried} of the ${matrix.columnCount} kept variants; its other cells are null in the dataframe and missing in VCF/PLINK text. ${pointer}`;
}

function isBareNumeric(text: string): boolean {
  const token = text.trim();
  return (
    token !== '' &&
    !['0x', '0o', '0b'].includes(token.slice(0, 2).toLowerCase()) &&
    Number.isFinite(Number(token))
  );
}
