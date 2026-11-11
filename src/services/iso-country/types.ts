/**
 * @fileoverview Types for the static ISO 3166-1 country table used by
 * `resolveCountryName` to look up ISO country codes.
 *
 * @module services/iso-country/types
 */

/** One ISO 3166-1 country entry. */
export interface IsoCountry {
  /**
   * Common informal English names / abbreviations that should resolve to this
   * country (e.g. `USA`, `United States`, `America` → `USA`). Empty when the
   * ISO short name is the only spelling agents are likely to use.
   */
  aliases: string[];
  /** ISO 3166-1 alpha-2 code — two uppercase letters (e.g. `UG`). */
  alpha2: string;
  /** ISO 3166-1 alpha-3 code — three uppercase letters (e.g. `UGA`). */
  alpha3: string;
  /** ISO 3166-1 English short name (e.g. `Uganda`). */
  name: string;
  /** ISO 3166-1 three-digit code, including any leading zeros (e.g. `008`). */
  numeric: string;
}
