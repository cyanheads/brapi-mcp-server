/**
 * @fileoverview Public API barrel for the ISO 3166-1 country resolver — turns
 * free-form country names into alpha-3 codes for BrAPI `/locations` filters.
 *
 * @module services/iso-country
 */

export { ISO_3166_1_COUNTRIES } from './iso-3166-data.js';
export { resolveCountryName } from './resolve-country.js';
export type { IsoCountry } from './types.js';
