/**
 * @fileoverview Unit tests for the built-in known-server registry. Exercises
 * lookup behavior, opt-out via `BRAPI_BUILTIN_ALIASES_DISABLED`, and registry
 * invariants (frozen entries, valid URLs, attribution metadata present).
 *
 * @module tests/config/builtin-aliases.test
 */

import { describe, expect, it } from 'vitest';
import { BUILTIN_ALIASES, findBuiltinAlias, listBuiltinAliases } from '@/config/builtin-aliases.js';

describe('BUILTIN_ALIASES registry', () => {
  it('ships at least cassava, sweetpotato, wheat, breedbase', () => {
    const aliases = BUILTIN_ALIASES.map((b) => b.alias);
    expect(aliases).toEqual(
      expect.arrayContaining(['cassava', 'sweetpotato', 'wheat', 'breedbase']),
    );
  });

  it('every entry is frozen', () => {
    for (const entry of BUILTIN_ALIASES) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });

  it('every entry has a valid https BrAPI v2 base URL', () => {
    for (const entry of BUILTIN_ALIASES) {
      const url = new URL(entry.baseUrl);
      expect(url.protocol).toBe('https:');
      expect(entry.baseUrl).toMatch(/\/brapi\/v\d+$/);
    }
  });

  it('every entry carries CC-BY attribution metadata', () => {
    for (const entry of BUILTIN_ALIASES) {
      expect(entry.license).toBe('CC-BY');
      expect(entry.citation.length).toBeGreaterThan(0);
      expect(entry.homepage).toMatch(/^https:\/\//);
      expect(entry.organizationName.length).toBeGreaterThan(0);
    }
  });

  it('only the breedbase entry is flagged as demo', () => {
    const demos = BUILTIN_ALIASES.filter((b) => b.isDemo);
    expect(demos.map((b) => b.alias)).toEqual(['breedbase']);
  });
});

describe('findBuiltinAlias', () => {
  it('returns the entry for a known alias', () => {
    const entry = findBuiltinAlias('cassava', {});
    expect(entry?.baseUrl).toBe('https://cassavabase.org/brapi/v2');
    expect(entry?.cropFocus).toBe('Cassava');
  });

  it('is case-insensitive', () => {
    expect(findBuiltinAlias('CASSAVA', {})?.alias).toBe('cassava');
    expect(findBuiltinAlias('Wheat', {})?.alias).toBe('wheat');
  });

  it('returns undefined for unknown aliases', () => {
    expect(findBuiltinAlias('does-not-exist', {})).toBeUndefined();
  });

  it('returns undefined when alias is on BRAPI_BUILTIN_ALIASES_DISABLED', () => {
    const env = { BRAPI_BUILTIN_ALIASES_DISABLED: 'cassava' };
    expect(findBuiltinAlias('cassava', env)).toBeUndefined();
    // Other entries unaffected.
    expect(findBuiltinAlias('wheat', env)?.alias).toBe('wheat');
  });

  it('disabled list ignores casing and surrounding whitespace', () => {
    const env = { BRAPI_BUILTIN_ALIASES_DISABLED: ' Cassava , Wheat ' };
    expect(findBuiltinAlias('cassava', env)).toBeUndefined();
    expect(findBuiltinAlias('wheat', env)).toBeUndefined();
    expect(findBuiltinAlias('sweetpotato', env)?.alias).toBe('sweetpotato');
  });
});

describe('listBuiltinAliases', () => {
  it('returns the full registry by default', () => {
    expect(listBuiltinAliases({}).length).toBe(BUILTIN_ALIASES.length);
  });

  it('filters out aliases on the disabled list', () => {
    const result = listBuiltinAliases({
      BRAPI_BUILTIN_ALIASES_DISABLED: 'cassava,wheat',
    });
    const aliases = result.map((b) => b.alias);
    expect(aliases).not.toContain('cassava');
    expect(aliases).not.toContain('wheat');
    expect(aliases).toContain('sweetpotato');
    expect(aliases).toContain('breedbase');
  });

  it('returns the same registry instance when nothing is disabled', () => {
    expect(listBuiltinAliases({})).toBe(BUILTIN_ALIASES);
  });
});
