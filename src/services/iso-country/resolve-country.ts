/**
 * @fileoverview `resolveCountryName` — map a free-form English country name,
 * alias, or ISO alphabetic code to its ISO 3166-1 entry. Case-, diacritic-,
 * and punctuation-insensitive. Backs the `countryNames` input on
 * `brapi_find_locations`.
 *
 * @module services/iso-country/resolve-country
 */

import { ISO_3166_1_COUNTRIES } from './iso-3166-data.js';
import type { IsoCountry } from './types.js';

/**
 * Normalize a country string for lookup: trim, lowercase, NFD-decompose and
 * drop combining diacritics, then collapse any run of non-alphanumeric
 * characters to a single space — so "Côte d'Ivoire", "cote d ivoire", and
 * "COTE-D'IVOIRE" all resolve alike.
 */
function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Lazily-built lookup index: normalized name / alias / alpha-3 / alpha-2 →
 * ISO entry. Populated in priority passes so a real country name or alpha-3
 * code always wins over an alpha-2 code that happens to normalize the same.
 */
let index: Map<string, IsoCountry> | undefined;

function buildIndex(): Map<string, IsoCountry> {
  const map = new Map<string, IsoCountry>();
  const add = (key: string, country: IsoCountry): void => {
    const norm = normalize(key);
    if (norm && !map.has(norm)) map.set(norm, country);
  };
  for (const c of ISO_3166_1_COUNTRIES) add(c.name, c);
  for (const c of ISO_3166_1_COUNTRIES) for (const alias of c.aliases) add(alias, c);
  for (const c of ISO_3166_1_COUNTRIES) add(c.alpha3, c);
  for (const c of ISO_3166_1_COUNTRIES) add(c.alpha2, c);
  return map;
}

/**
 * Resolve a free-form country name, alias, or ISO 3166-1 alpha-2 / alpha-3
 * code to its assigned codes. Returns `undefined` when nothing matches.
 */
export function resolveCountryName(name: string): IsoCountry | undefined {
  const norm = normalize(name);
  if (!norm) return;
  index ??= buildIndex();
  return index.get(norm);
}
