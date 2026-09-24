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
  it('ships exactly the anonymous-read BTI Breedbase family', () => {
    expect(BUILTIN_ALIASES.map((b) => b.alias)).toEqual([
      'bti-cassava',
      'bti-sweetpotato',
      'bti-breedbase-demo',
    ]);
  });

  it('carries no Triticeae Toolbox (T3) entry — those hosts require login', () => {
    for (const entry of BUILTIN_ALIASES) {
      expect(entry.alias).not.toMatch(/^t3-/);
      expect(entry.baseUrl).not.toContain('triticeaetoolbox.org');
    }
    expect(findBuiltinAlias('t3-wheat', {})).toBeUndefined();
    expect(findBuiltinAlias('t3-oat', {})).toBeUndefined();
    expect(findBuiltinAlias('t3-barley', {})).toBeUndefined();
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
    expect(findBuiltinAlias('Bti-SweetPotato', {})?.alias).toBe('bti-sweetpotato');
  });

  it('matches every spelling that shares the builtin env prefix', () => {
    expect(findBuiltinAlias('bti_cassava', {})?.alias).toBe('bti-cassava');
    expect(findBuiltinAlias('BTI_Breedbase-Demo', {})?.alias).toBe('bti-breedbase-demo');
    const env = { BRAPI_BUILTIN_ALIASES_DISABLED: 'bti_sweetpotato' };
    expect(findBuiltinAlias('bti-sweetpotato', env)).toBeUndefined();
    expect(listBuiltinAliases(env).map((b) => b.alias)).not.toContain('bti-sweetpotato');
  });

  it('returns undefined for unknown aliases', () => {
    expect(findBuiltinAlias('does-not-exist', {})).toBeUndefined();
  });

  it('returns undefined when alias is on BRAPI_BUILTIN_ALIASES_DISABLED', () => {
    const env = { BRAPI_BUILTIN_ALIASES_DISABLED: 'bti-cassava' };
    expect(findBuiltinAlias('bti-cassava', env)).toBeUndefined();
    // Other entries unaffected.
    expect(findBuiltinAlias('bti-sweetpotato', env)?.alias).toBe('bti-sweetpotato');
  });

  it('disabled list ignores casing and surrounding whitespace', () => {
    const env = { BRAPI_BUILTIN_ALIASES_DISABLED: ' BTI-Cassava , BTI-Breedbase-Demo ' };
    expect(findBuiltinAlias('bti-cassava', env)).toBeUndefined();
    expect(findBuiltinAlias('bti-breedbase-demo', env)).toBeUndefined();
    expect(findBuiltinAlias('bti-sweetpotato', env)?.alias).toBe('bti-sweetpotato');
  });
});

describe('listBuiltinAliases', () => {
  it('returns the full registry by default', () => {
    expect(listBuiltinAliases({}).length).toBe(BUILTIN_ALIASES.length);
  });

  it('filters out aliases on the disabled list', () => {
    const result = listBuiltinAliases({
      BRAPI_BUILTIN_ALIASES_DISABLED: 'bti-cassava,bti-breedbase-demo',
    });
    expect(result.map((b) => b.alias)).toEqual(['bti-sweetpotato']);
  });

  it('returns the same registry instance when nothing is disabled', () => {
    expect(listBuiltinAliases({})).toBe(BUILTIN_ALIASES);
  });
});
