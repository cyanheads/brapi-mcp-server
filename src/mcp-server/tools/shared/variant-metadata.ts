/**
 * @fileoverview Variant coordinate metadata for the genotype matrix text
 * formats — the `/variants` pull that supplies CHROM/POS/REF/ALT (VCF-lite) and
 * the `.map` coordinates plus allele labels (PLINK), and the field extraction
 * and position conversion behind it.
 *
 * @module mcp-server/tools/shared/variant-metadata
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { requestCancelled } from '@cyanheads/mcp-ts-core/errors';
import type { BrapiClient } from '@/services/brapi-client/index.js';
import type { BrapiDialect } from '@/services/brapi-dialect/index.js';
import type { RegisteredServer } from '@/services/server-registry/index.js';
import {
  asString,
  type BrapiListResult,
  buildRequestOptions,
  extractRows,
} from './find-helpers.js';

/** Per-variant coordinate metadata used to populate VCF/PLINK position columns. */
export interface VariantMeta {
  alt?: string;
  altByIndex?: (string | undefined)[];
  chrom?: string;
  pos?: string;
  ref?: string;
}

/** Max variant records scanned when pulling coordinate metadata for vcf/plink. */
const MAX_VARIANT_METADATA_ROWS = 50_000;
const VARIANT_METADATA_PAGE_SIZE = 1_000;

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
export async function collectVariantMetadata(
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
    while (page < totalPages && !ctx.signal.aborted) {
      if (scanned >= MAX_VARIANT_METADATA_ROWS) {
        // Placeholders for unscanned variants look like coordinates the server
        // lacks, so say how many the cap left uncovered.
        warnings.push(
          `The /variants metadata scan stopped at its ${MAX_VARIANT_METADATA_ROWS.toLocaleString('en-US')}-row cap with ${neededIds.size - meta.size} of the ${neededIds.size} matrix variants uncovered: their CHROM/POS/REF/ALT are placeholders ("." in VCF, "0" in PLINK) because the scan never reached them.`,
        );
        break;
      }
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
        if (!vid || !neededIds.has(vid)) continue;
        meta.set(vid, extractVariantMeta(r));
      }
      totalPages = envelope.metadata?.pagination?.totalPages ?? page + 1;
      page++;
      if (meta.size === neededIds.size) break;
      if (rows.length < VARIANT_METADATA_PAGE_SIZE) break;
    }
  } catch {
    if (ctx.signal.aborted)
      throw requestCancelled('Genotype matrix export cancelled by the caller.');
    warnings.push(
      'Variant metadata could not be fully retrieved. Coordinates and allele labels use fallbacks where metadata is missing.',
    );
  }
  return meta;
}

function extractVariantMeta(r: Record<string, unknown>): VariantMeta {
  const meta: VariantMeta = {};
  const chrom = asString(r.referenceName);
  if (chrom) meta.chrom = chrom;
  const position = exportPosition(r.start);
  if (position !== undefined) meta.pos = String(position);
  const ref = asString(r.referenceBases);
  if (ref) meta.ref = ref;
  const altRaw = r.alternateBases;
  if (Array.isArray(altRaw)) {
    const alts = altRaw.filter((a): a is string => typeof a === 'string' && a.length > 0);
    if (alts.length > 0) meta.alt = alts.join(',');
    meta.altByIndex = altRaw.map(indexedAlleleLabel);
  } else {
    const alt = asString(altRaw);
    if (alt) {
      meta.alt = alt;
      meta.altByIndex = alt.split(',').map(indexedAlleleLabel);
    }
  }
  return meta;
}

/** An allele label usable for a genotype index: trimmed, never blank, `0`, or `.`. */
export function indexedAlleleLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const label = value.trim();
  if (label && label !== '0' && label !== '.') {
    return label;
  }
  return;
}

/** BrAPI Variant.start is zero-based; VCF POS and PLINK base-pair positions are one-based. */
function exportPosition(start: unknown): number | undefined {
  let value = start;
  if (typeof start === 'string') {
    const text = start.trim();
    if (!text || ['0x', '0o', '0b'].includes(text.slice(0, 2).toLowerCase())) return;
    value = Number(text);
  }
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= Number.MAX_SAFE_INTEGER
  )
    return;
  return value + 1;
}
