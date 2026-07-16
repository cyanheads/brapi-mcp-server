/**
 * @fileoverview `resolveCountryName` — map a free-form English country name,
 * alias, or ISO code to its ISO 3166-1 alpha-3 code. Case-, diacritic-, and
 * punctuation-insensitive. Backs the `countryNames` input on
 * `brapi_find_locations`, since BrAPI `/locations` filters countries only by
 * alpha-3 code, not by name.
 *
 * @module services/iso-country/resolve-country
 */

import { ISO_3166_1_COUNTRIES } from './iso-3166-data.js';

/** Inclusive code-point bounds of the combining diacritical marks block. */
const COMBINING_MARK_LOW = 0x0300;
const COMBINING_MARK_HIGH = 0x036f;

/**
 * Normalize a country string for lookup: trim, lowercase, NFD-decompose and
 * drop combining diacritics, then collapse any run of non-alphanumeric
 * characters to a single space — so "Côte d'Ivoire", "cote d ivoire", and
 * "COTE-D'IVOIRE" all resolve alike.
 */
function normalize(value: string): string {
  const decomposed = value.trim().toLowerCase().normalize('NFD');
  let stripped = '';
  for (const ch of decomposed) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < COMBINING_MARK_LOW || cp > COMBINING_MARK_HIGH) stripped += ch;
  }
  return stripped.replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Lazily-built lookup index: normalized name / alias / alpha-3 / alpha-2 →
 * alpha-3 code. Populated in priority passes so a real country name or alpha-3
 * code always wins over an alpha-2 code that happens to normalize the same.
 */
let index: Map<string, string> | undefined;

function buildIndex(): Map<string, string> {
  const map = new Map<string, string>();
  const add = (key: string, alpha3: string): void => {
    const norm = normalize(key);
    if (norm && !map.has(norm)) map.set(norm, alpha3);
  };
  for (const c of ISO_3166_1_COUNTRIES) add(c.name, c.alpha3);
  for (const c of ISO_3166_1_COUNTRIES) for (const alias of c.aliases) add(alias, c.alpha3);
  for (const c of ISO_3166_1_COUNTRIES) add(c.alpha3, c.alpha3);
  for (const c of ISO_3166_1_COUNTRIES) add(c.alpha2, c.alpha3);
  return map;
}

/**
 * Resolve a free-form country name, alias, or ISO 3166-1 alpha-2 / alpha-3
 * code to its alpha-3 code. Returns `undefined` when nothing matches.
 */
export function resolveCountryName(name: string): string | undefined {
  const norm = normalize(name);
  if (!norm) return;
  index ??= buildIndex();
  return index.get(norm);
}
