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
  it('ships the BTI Breedbase family and the T3 small-grains servers', () => {
    const aliases = BUILTIN_ALIASES.map((b) => b.alias);
    expect(aliases).toEqual(
      expect.arrayContaining([
        'bti-cassava',
        'bti-sweetpotato',
        'bti-breedbase-demo',
        't3-wheat',
        't3-oat',
        't3-barley',
      ]),
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

  it('only the breedbase demo entry is flagged as demo', () => {
    const demos = BUILTIN_ALIASES.filter((b) => b.isDemo);
    expect(demos.map((b) => b.alias)).toEqual(['bti-breedbase-demo']);
  });
});

describe('findBuiltinAlias', () => {
  it('returns the entry for a known alias', () => {
    const entry = findBuiltinAlias('bti-cassava', {});
    expect(entry?.baseUrl).toBe('https://cassavabase.org/brapi/v2');
    expect(entry?.cropFocus).toBe('Cassava');
  });

  it('is case-insensitive', () => {
    expect(findBuiltinAlias('BTI-CASSAVA', {})?.alias).toBe('bti-cassava');
    expect(findBuiltinAlias('T3-Wheat', {})?.alias).toBe('t3-wheat');
  });

  it('returns undefined for unknown aliases', () => {
    expect(findBuiltinAlias('does-not-exist', {})).toBeUndefined();
  });

  it('returns undefined when alias is on BRAPI_BUILTIN_ALIASES_DISABLED', () => {
    const env = { BRAPI_BUILTIN_ALIASES_DISABLED: 'bti-cassava' };
    expect(findBuiltinAlias('bti-cassava', env)).toBeUndefined();
    // Other entries unaffected.
    expect(findBuiltinAlias('t3-wheat', env)?.alias).toBe('t3-wheat');
  });

  it('disabled list ignores casing and surrounding whitespace', () => {
    const env = { BRAPI_BUILTIN_ALIASES_DISABLED: ' BTI-Cassava , T3-Wheat ' };
    expect(findBuiltinAlias('bti-cassava', env)).toBeUndefined();
    expect(findBuiltinAlias('t3-wheat', env)).toBeUndefined();
    expect(findBuiltinAlias('bti-sweetpotato', env)?.alias).toBe('bti-sweetpotato');
  });
});

describe('listBuiltinAliases', () => {
  it('returns the full registry by default', () => {
    expect(listBuiltinAliases({}).length).toBe(BUILTIN_ALIASES.length);
  });

  it('filters out aliases on the disabled list', () => {
    const result = listBuiltinAliases({
      BRAPI_BUILTIN_ALIASES_DISABLED: 'bti-cassava,t3-wheat',
    });
    const aliases = result.map((b) => b.alias);
    expect(aliases).not.toContain('bti-cassava');
    expect(aliases).not.toContain('t3-wheat');
    expect(aliases).toContain('bti-sweetpotato');
    expect(aliases).toContain('bti-breedbase-demo');
    expect(aliases).toContain('t3-oat');
    expect(aliases).toContain('t3-barley');
  });

  it('returns the same registry instance when nothing is disabled', () => {
    expect(listBuiltinAliases({})).toBe(BUILTIN_ALIASES);
  });
});
