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
    expect(resolveCountryName('Uganda')?.alpha3).toBe('UGA');
    expect(resolveCountryName('Nigeria')?.alpha3).toBe('NGA');
  });

  it('resolves case-insensitively and trims surrounding whitespace', () => {
    expect(resolveCountryName('uganda')?.alpha3).toBe('UGA');
    expect(resolveCountryName('  PERU  ')?.alpha3).toBe('PER');
  });

  it('resolves common informal aliases', () => {
    expect(resolveCountryName('USA')?.alpha3).toBe('USA');
    expect(resolveCountryName('United States')?.alpha3).toBe('USA');
    expect(resolveCountryName('America')?.alpha3).toBe('USA');
    expect(resolveCountryName('UK')?.alpha3).toBe('GBR');
    expect(resolveCountryName('South Korea')?.alpha3).toBe('KOR');
    expect(resolveCountryName('Ivory Coast')?.alpha3).toBe('CIV');
  });

  it('is diacritic-insensitive', () => {
    expect(resolveCountryName("Côte d'Ivoire")?.alpha3).toBe('CIV');
    expect(resolveCountryName("cote d'ivoire")?.alpha3).toBe('CIV');
    expect(resolveCountryName('Aland Islands')?.alpha3).toBe('ALA');
  });

  it('accepts ISO alpha-3 and alpha-2 codes as input', () => {
    expect(resolveCountryName('UGA')?.alpha3).toBe('UGA');
    expect(resolveCountryName('ng')?.alpha3).toBe('NGA');
  });

  it('returns undefined for unrecognized or empty input', () => {
    expect(resolveCountryName('Atlantis')).toBeUndefined();
    expect(resolveCountryName('')).toBeUndefined();
    expect(resolveCountryName('   ')).toBeUndefined();
  });

  it('disambiguates the two Congos', () => {
    expect(resolveCountryName('Congo')?.alpha3).toBe('COG');
    expect(resolveCountryName('DR Congo')?.alpha3).toBe('COD');
    expect(resolveCountryName('Democratic Republic of the Congo')?.alpha3).toBe('COD');
  });

  it('resolves numeric assignments as zero-padded strings', () => {
    expect(resolveCountryName('Albania')).toMatchObject({
      alpha2: 'AL',
      alpha3: 'ALB',
      numeric: '008',
    });
    expect(resolveCountryName('Zambia')).toMatchObject({
      alpha2: 'ZM',
      alpha3: 'ZMB',
      numeric: '894',
    });
  });

  it('carries the E.164 calling code, shared codes included', () => {
    expect(resolveCountryName('Uganda')?.callingCode).toBe('256');
    expect(resolveCountryName('Zambia')?.callingCode).toBe('260');
    expect(resolveCountryName('DR Congo')?.callingCode).toBe('243');
    expect(resolveCountryName('Mozambique')?.callingCode).toBe('258');
    expect(resolveCountryName('Albania')?.callingCode).toBe('355');
    expect(resolveCountryName('United States')?.callingCode).toBe('1');
    expect(resolveCountryName('Jamaica')?.callingCode).toBe('1');
    expect(resolveCountryName('Saint Pierre and Miquelon')?.callingCode).toBe('508');
  });

  it('assigns a calling code to every ISO entry except the seven with no E.164 assignment', () => {
    const without = ISO_3166_1_COUNTRIES.filter((c) => c.callingCode === undefined).map(
      (c) => c.alpha2,
    );
    expect(without.sort()).toEqual(['AQ', 'BV', 'GS', 'HM', 'PN', 'TF', 'UM']);
    for (const c of ISO_3166_1_COUNTRIES) {
      if (c.callingCode !== undefined) expect(c.callingCode).toMatch(/^[1-9]\d{0,2}$/);
    }
  });

  it('ships the full ISO 3166-1 table with unique, well-formed codes', () => {
    expect(ISO_3166_1_COUNTRIES.length).toBeGreaterThanOrEqual(249);
    const alpha3 = new Set<string>();
    const alpha2 = new Set<string>();
    const numeric = new Set<string>();
    for (const c of ISO_3166_1_COUNTRIES) {
      expect(c.alpha3).toMatch(/^[A-Z]{3}$/);
      expect(c.alpha2).toMatch(/^[A-Z]{2}$/);
      expect(alpha3.has(c.alpha3)).toBe(false);
      expect(alpha2.has(c.alpha2)).toBe(false);
      expect(c.numeric).toMatch(/^\d{3}$/);
      expect(numeric.has(c.numeric)).toBe(false);
      alpha3.add(c.alpha3);
      alpha2.add(c.alpha2);
      numeric.add(c.numeric);
    }
  });
});
