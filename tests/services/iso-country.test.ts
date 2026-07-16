/**
 * @fileoverview Tests for `resolveCountryName` and the static ISO 3166-1
 * table backing `brapi_find_locations`' `countryNames` input.
 *
 * @module tests/services/iso-country.test
 */

import { describe, expect, it } from 'vitest';
import { ISO_3166_1_COUNTRIES, resolveCountryName } from '@/services/iso-country/index.js';

describe('resolveCountryName', () => {
  it('resolves an exact ISO short name to its alpha-3 code', () => {
    expect(resolveCountryName('Uganda')).toBe('UGA');
    expect(resolveCountryName('Nigeria')).toBe('NGA');
  });

  it('resolves case-insensitively and trims surrounding whitespace', () => {
    expect(resolveCountryName('uganda')).toBe('UGA');
    expect(resolveCountryName('  PERU  ')).toBe('PER');
  });

  it('resolves common informal aliases', () => {
    expect(resolveCountryName('USA')).toBe('USA');
    expect(resolveCountryName('United States')).toBe('USA');
    expect(resolveCountryName('America')).toBe('USA');
    expect(resolveCountryName('UK')).toBe('GBR');
    expect(resolveCountryName('South Korea')).toBe('KOR');
    expect(resolveCountryName('Ivory Coast')).toBe('CIV');
  });

  it('is diacritic-insensitive', () => {
    expect(resolveCountryName("Côte d'Ivoire")).toBe('CIV');
    expect(resolveCountryName("cote d'ivoire")).toBe('CIV');
    expect(resolveCountryName('Aland Islands')).toBe('ALA');
  });

  it('accepts ISO alpha-3 and alpha-2 codes as input', () => {
    expect(resolveCountryName('UGA')).toBe('UGA');
    expect(resolveCountryName('ng')).toBe('NGA');
  });

  it('returns undefined for unrecognized or empty input', () => {
    expect(resolveCountryName('Atlantis')).toBeUndefined();
    expect(resolveCountryName('')).toBeUndefined();
    expect(resolveCountryName('   ')).toBeUndefined();
  });

  it('disambiguates the two Congos', () => {
    expect(resolveCountryName('Congo')).toBe('COG');
    expect(resolveCountryName('DR Congo')).toBe('COD');
    expect(resolveCountryName('Democratic Republic of the Congo')).toBe('COD');
  });

  it('ships the full ISO 3166-1 table with unique, well-formed codes', () => {
    expect(ISO_3166_1_COUNTRIES.length).toBeGreaterThanOrEqual(249);
    const alpha3 = new Set<string>();
    const alpha2 = new Set<string>();
    for (const c of ISO_3166_1_COUNTRIES) {
      expect(c.alpha3).toMatch(/^[A-Z]{3}$/);
      expect(c.alpha2).toMatch(/^[A-Z]{2}$/);
      expect(alpha3.has(c.alpha3)).toBe(false);
      expect(alpha2.has(c.alpha2)).toBe(false);
      alpha3.add(c.alpha3);
      alpha2.add(c.alpha2);
    }
  });
});
