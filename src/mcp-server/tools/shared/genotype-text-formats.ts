/**
 * @fileoverview VCF-lite and PLINK (`.ped` / `.map`) text encoders for the
 * genotype matrix export. Positions and allele labels come from the
 * `/variants` metadata pull; placeholders stand in where it has none.
 *
 * @module mcp-server/tools/shared/genotype-text-formats
 */

import type { CallFormatting } from './genotype-calls.js';
import { type MatrixBuildResult, sampleLabel } from './genotype-matrix.js';
import { indexedAlleleLabel, type VariantMeta } from './variant-metadata.js';

/** Tab-join a row of cells. */
function tsv(cells: readonly (string | number)[]): string {
  return cells.map(String).join('\t');
}

export function buildVcfText(
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
    ...matrix.sampleOrder.map((s) => sampleLabel(matrix, s)),
  ];
  const lines = [tsv(header)];
  for (const vid of matrix.variantIdOrder) {
    const m = variantMeta.get(vid) ?? {};
    const genotypes = matrix.sampleOrder.map((s) => {
      const cell = matrix.genotypeAt.get(s)?.get(vid);
      return cell?.ambiguous ? '.' : (cell?.text ?? missing);
    });
    lines.push(tsv([m.chrom ?? '.', m.pos ?? '.', vid, m.ref ?? '.', m.alt ?? '.', ...genotypes]));
  }
  return lines.join('\n');
}

export function buildMapText(
  matrix: MatrixBuildResult,
  variantMeta: Map<string, VariantMeta>,
): string {
  // chromosome, variant-id, genetic-distance (0 placeholder), base-pair position
  return matrix.variantIdOrder
    .map((vid) => {
      const m = variantMeta.get(vid) ?? {};
      return tsv([m.chrom ?? '0', vid, '0', m.pos ?? '0']);
    })
    .join('\n');
}

export function buildPedText(
  matrix: MatrixBuildResult,
  variantMeta: Map<string, VariantMeta>,
  callFormatting: CallFormatting,
  warnings: string[],
): string {
  const unknown = callFormatting.unknownString ?? '.';
  const separators = [callFormatting.sepPhased, callFormatting.sepUnphased, '/', '|', ','].filter(
    (sep): sep is string => Boolean(sep),
  );
  const literalMarkers = new Set<string>();
  const unmappedMarkers = new Set<string>();
  for (const calls of matrix.genotypeAt.values()) {
    for (const [variant, cell] of calls) {
      if (cell.ambiguous) continue;
      const pair = splitAlleles(cell.text, unknown, separators);
      if (!pair) continue;
      for (const allele of pair) {
        if (typeof allele === 'string') literalMarkers.add(variant);
        else if (!pedAlleleLabel(variantMeta.get(variant), allele)) unmappedMarkers.add(variant);
      }
    }
  }
  if ([...unmappedMarkers].some((variant) => !literalMarkers.has(variant))) {
    warnings.push(
      'PLINK uses positive numeric labels (allele index + 1) for markers whose allele metadata cannot resolve all indices.',
    );
  }
  if ([...unmappedMarkers].some((variant) => literalMarkers.has(variant))) {
    warnings.push(
      'PLINK marks indexed calls missing where marker metadata cannot relate them to literal allele labels. The original calls are in the staged matrix.',
    );
  }

  return matrix.sampleOrder
    .map((sample) => {
      const row = ['0', sampleLabel(matrix, sample), '0', '0', '0', '0'];
      const calls = matrix.genotypeAt.get(sample);
      for (const variant of matrix.variantIdOrder) {
        const cell = calls?.get(variant);
        const pair =
          cell && !cell.ambiguous ? splitAlleles(cell.text, unknown, separators) : undefined;
        const unmapped = unmappedMarkers.has(variant);
        if (
          !pair ||
          (unmapped &&
            literalMarkers.has(variant) &&
            pair.some((allele) => typeof allele === 'number'))
        ) {
          row.push('0', '0');
          continue;
        }
        const meta = variantMeta.get(variant);
        for (const allele of pair) {
          if (typeof allele === 'string') row.push(allele);
          else row.push(unmapped ? String(allele + 1) : (pedAlleleLabel(meta, allele) ?? '0'));
        }
      }
      return row.join('\t');
    })
    .join('\n');
}

function pedAlleleLabel(meta: VariantMeta | undefined, index: number): string | undefined {
  return index === 0 ? indexedAlleleLabel(meta?.ref) : meta?.altByIndex?.[index - 1];
}

/**
 * Decode the first two tokens for PED. A single known allele is duplicated;
 * a missing token makes the whole pair missing.
 */
function splitAlleles(
  gt: string,
  unknown: string,
  separators: string[],
): [string | number, string | number] | undefined {
  if (gt.trim() === unknown) return;
  const nextSeparator = (start: number) => {
    let position = gt.length;
    let width = 0;
    for (const sep of separators) {
      const found = gt.indexOf(sep, start);
      if (found !== -1 && found < position) {
        position = found;
        width = sep.length;
      }
    }
    return { position, width };
  };
  const first = nextSeparator(0);
  const a = gt.slice(0, first.position).trim();
  const start = first.position + first.width;
  const b = first.width ? gt.slice(start, nextSeparator(start).position).trim() : a;
  if (!a || !b || a === unknown || b === unknown || a === '.' || b === '.') return;
  const asAllele = (token: string): string | number => {
    const index = Number(token);
    return Number.isSafeInteger(index) &&
      index >= 0 &&
      index < Number.MAX_SAFE_INTEGER &&
      String(index) === token
      ? index
      : token;
  };
  return [asAllele(a), asAllele(b)];
}
