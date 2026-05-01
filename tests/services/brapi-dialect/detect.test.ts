/**
 * @fileoverview Tests for dialect detection — env override precedence, name
 * pattern matching across SGN-family servers, fall-through to spec.
 *
 * @module tests/services/brapi-dialect/detect.test
 */

import { describe, expect, it } from 'vitest';
import {
  detectDialectFromName,
  detectDialectId,
  dialectEnvVar,
  readDialectOverride,
} from '@/services/brapi-dialect/detect.js';
import type { CapabilityProfile } from '@/services/capability-registry/types.js';

function profile(name: string | undefined, organizationName?: string): CapabilityProfile {
  return {
    baseUrl: 'https://example.org/brapi/v2',
    server: { ...(name ? { name } : {}), ...(organizationName ? { organizationName } : {}) },
    supported: {},
    crops: [],
    fetchedAt: '2026-04-30T00:00:00Z',
  };
}

describe('dialectEnvVar', () => {
  it('uppercases and underscores the alias', () => {
    expect(dialectEnvVar('default')).toBe('BRAPI_DEFAULT_DIALECT');
    expect(dialectEnvVar('cassava')).toBe('BRAPI_CASSAVA_DIALECT');
    expect(dialectEnvVar('my-server')).toBe('BRAPI_MY_SERVER_DIALECT');
  });
});

describe('readDialectOverride', () => {
  it('returns the env value when set', () => {
    expect(readDialectOverride('cassava', { BRAPI_CASSAVA_DIALECT: 'cassavabase' })).toBe(
      'cassavabase',
    );
  });

  it('trims whitespace', () => {
    expect(readDialectOverride('cassava', { BRAPI_CASSAVA_DIALECT: '  spec  ' })).toBe('spec');
  });

  it('returns undefined when unset', () => {
    expect(readDialectOverride('cassava', {})).toBeUndefined();
  });

  it('returns undefined when empty', () => {
    expect(readDialectOverride('cassava', { BRAPI_CASSAVA_DIALECT: '' })).toBeUndefined();
  });

  it('treats `auto` as defer-to-detection (case-insensitive)', () => {
    expect(readDialectOverride('cassava', { BRAPI_CASSAVA_DIALECT: 'auto' })).toBeUndefined();
    expect(readDialectOverride('cassava', { BRAPI_CASSAVA_DIALECT: 'AUTO' })).toBeUndefined();
  });
});

describe('detectDialectFromName', () => {
  it('detects CassavaBase from server name with source=server-name', () => {
    expect(detectDialectFromName('CassavaBase')).toEqual({
      id: 'cassavabase',
      source: 'server-name',
    });
    expect(detectDialectFromName('cassavabase')).toEqual({
      id: 'cassavabase',
      source: 'server-name',
    });
  });

  it('detects sister SGN deployments', () => {
    expect(detectDialectFromName('Sweetpotatobase').id).toBe('breedbase');
    expect(detectDialectFromName('Yambase').id).toBe('breedbase');
    expect(detectDialectFromName('Musabase').id).toBe('breedbase');
    expect(detectDialectFromName('BananaBase').id).toBe('breedbase');
    expect(detectDialectFromName('Breedbase Demo').id).toBe('breedbase');
  });

  it('detects via organizationName when serverName is generic with source=organization-name', () => {
    expect(detectDialectFromName('BrAPI Server', 'Boyce Thompson Institute')).toEqual({
      id: 'breedbase',
      source: 'organization-name',
    });
  });

  it('detects the BrAPI Community Test Server', () => {
    expect(detectDialectFromName('BrAPI Test Server')).toEqual({
      id: 'brapi-test',
      source: 'server-name',
    });
  });

  it('falls back to spec for unknown names with source=fallback', () => {
    expect(detectDialectFromName('BMS')).toEqual({ id: 'spec', source: 'fallback' });
    expect(detectDialectFromName('GnpIS').id).toBe('spec');
    expect(detectDialectFromName('Totally Unknown Server').id).toBe('spec');
  });

  it('falls back to spec when both fields are empty', () => {
    expect(detectDialectFromName(undefined)).toEqual({ id: 'spec', source: 'fallback' });
    expect(detectDialectFromName(undefined, '').id).toBe('spec');
  });
});

describe('detectDialectId', () => {
  it('env override beats profile inference with source=env-override', () => {
    const result = detectDialectId('cassava', profile('CassavaBase'), {
      BRAPI_CASSAVA_DIALECT: 'spec',
    });
    expect(result).toEqual({ id: 'spec', source: 'env-override' });
  });

  it('falls through to detection when override is `auto`', () => {
    const result = detectDialectId('cassava', profile('CassavaBase'), {
      BRAPI_CASSAVA_DIALECT: 'auto',
    });
    expect(result.id).toBe('cassavabase');
    expect(result.source).toBe('server-name');
  });

  it('returns spec when no profile and no override', () => {
    expect(detectDialectId('default', undefined, {})).toEqual({ id: 'spec', source: 'fallback' });
  });

  it('detects from profile when no override is set', () => {
    expect(detectDialectId('cassava', profile('CassavaBase'), {}).id).toBe('cassavabase');
    expect(detectDialectId('default', profile('BrAPI Test Server'), {}).id).toBe('brapi-test');
  });
});
