/**
 * @fileoverview Unit tests for the per-alias env-var resolver. Covers prefix
 * derivation, env-var reading, auth-mode derivation across all credential
 * families, intra-alias ambiguity errors, and the agent > alias > default
 * layering inside `resolveConnectInput`.
 *
 * @module tests/config/alias-credentials.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import {
  aliasEnvPrefix,
  deriveAuthFromCredentials,
  discoverConfiguredAliases,
  formatConfiguredAliasesHint,
  readAliasCredentials,
  resolveConnectInput,
} from '@/config/alias-credentials.js';

describe('aliasEnvPrefix', () => {
  it('uppercases plain aliases', () => {
    expect(aliasEnvPrefix('cassava')).toBe('BRAPI_CASSAVA_');
    expect(aliasEnvPrefix('default')).toBe('BRAPI_DEFAULT_');
  });

  it('replaces hyphens with underscores', () => {
    expect(aliasEnvPrefix('my-server')).toBe('BRAPI_MY_SERVER_');
    expect(aliasEnvPrefix('t3-wheat-test')).toBe('BRAPI_T3_WHEAT_TEST_');
  });

  it('preserves underscores and digits', () => {
    expect(aliasEnvPrefix('test_v2')).toBe('BRAPI_TEST_V2_');
  });
});

describe('readAliasCredentials', () => {
  it('reads all known fields from env', () => {
    const env = {
      BRAPI_CASSAVA_BASE_URL: 'https://cassavabase.org/brapi/v2',
      BRAPI_CASSAVA_USERNAME: 'user',
      BRAPI_CASSAVA_PASSWORD: 'pass',
      BRAPI_CASSAVA_API_KEY: 'k',
      BRAPI_CASSAVA_API_KEY_HEADER: 'X-Key',
      BRAPI_CASSAVA_BEARER_TOKEN: 'tok',
      BRAPI_CASSAVA_OAUTH_CLIENT_ID: 'cid',
      BRAPI_CASSAVA_OAUTH_CLIENT_SECRET: 'csec',
      BRAPI_CASSAVA_OAUTH_TOKEN_URL: 'https://auth.example/token',
    };
    expect(readAliasCredentials('cassava', env)).toEqual({
      baseUrl: 'https://cassavabase.org/brapi/v2',
      username: 'user',
      password: 'pass',
      apiKey: 'k',
      apiKeyHeader: 'X-Key',
      bearerToken: 'tok',
      oauthClientId: 'cid',
      oauthClientSecret: 'csec',
      oauthTokenUrl: 'https://auth.example/token',
    });
  });

  it('treats empty strings as unset', () => {
    const env = {
      BRAPI_CASSAVA_BASE_URL: 'https://cassavabase.org/brapi/v2',
      BRAPI_CASSAVA_USERNAME: '',
      BRAPI_CASSAVA_PASSWORD: '',
    };
    expect(readAliasCredentials('cassava', env)).toEqual({
      baseUrl: 'https://cassavabase.org/brapi/v2',
    });
  });

  it('returns empty bundle when no relevant vars are set', () => {
    expect(readAliasCredentials('cassava', { OTHER_VAR: 'x' })).toEqual({});
  });

  it('honors hyphen-to-underscore alias mapping', () => {
    const env = { BRAPI_MY_SERVER_BASE_URL: 'https://x.example/brapi/v2' };
    expect(readAliasCredentials('my-server', env)).toEqual({
      baseUrl: 'https://x.example/brapi/v2',
    });
  });
});

describe('deriveAuthFromCredentials', () => {
  it('returns undefined when no credentials are present', () => {
    expect(deriveAuthFromCredentials({ baseUrl: 'x' }, 'a')).toBeUndefined();
  });

  it('picks sgn from username + password', () => {
    expect(deriveAuthFromCredentials({ username: 'u', password: 'p' }, 'a')).toEqual({
      mode: 'sgn',
      username: 'u',
      password: 'p',
    });
  });

  it('picks bearer from bearerToken', () => {
    expect(deriveAuthFromCredentials({ bearerToken: 't' }, 'a')).toEqual({
      mode: 'bearer',
      token: 't',
    });
  });

  it('picks api_key with default header behavior', () => {
    expect(deriveAuthFromCredentials({ apiKey: 'k' }, 'a')).toEqual({
      mode: 'api_key',
      apiKey: 'k',
    });
  });

  it('picks api_key with custom header when provided', () => {
    expect(deriveAuthFromCredentials({ apiKey: 'k', apiKeyHeader: 'X-Key' }, 'a')).toEqual({
      mode: 'api_key',
      apiKey: 'k',
      headerName: 'X-Key',
    });
  });

  it('picks oauth2 from client id + secret', () => {
    expect(deriveAuthFromCredentials({ oauthClientId: 'c', oauthClientSecret: 's' }, 'a')).toEqual({
      mode: 'oauth2',
      clientId: 'c',
      clientSecret: 's',
    });
  });

  it('passes through oauth tokenUrl when set', () => {
    expect(
      deriveAuthFromCredentials(
        { oauthClientId: 'c', oauthClientSecret: 's', oauthTokenUrl: 'https://t' },
        'a',
      ),
    ).toEqual({
      mode: 'oauth2',
      clientId: 'c',
      clientSecret: 's',
      tokenUrl: 'https://t',
    });
  });

  it('throws on intra-alias ambiguity (sgn + api_key)', () => {
    expect(() =>
      deriveAuthFromCredentials({ username: 'u', password: 'p', apiKey: 'k' }, 'cassava'),
    ).toThrowError(/Ambiguous auth config for alias 'cassava'/);
  });

  it('throws with ValidationError code', () => {
    try {
      deriveAuthFromCredentials({ bearerToken: 't', apiKey: 'k' }, 'x');
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as { code: number }).code).toBe(JsonRpcErrorCode.ValidationError);
    }
  });

  it('treats partial sgn (username only) as no auth', () => {
    expect(deriveAuthFromCredentials({ username: 'u' }, 'a')).toBeUndefined();
  });

  it('treats partial oauth2 as no auth', () => {
    expect(deriveAuthFromCredentials({ oauthClientId: 'c' }, 'a')).toBeUndefined();
  });
});

describe('resolveConnectInput', () => {
  const ENV = {
    BRAPI_DEFAULT_BASE_URL: 'https://test-server.brapi.org/brapi/v2',
    BRAPI_CASSAVA_BASE_URL: 'https://cassavabase.org/brapi/v2',
    BRAPI_CASSAVA_USERNAME: 'cyanheads',
    BRAPI_CASSAVA_PASSWORD: 'secret',
  };

  it('uses default env when alias is "default" and agent provides nothing', () => {
    expect(resolveConnectInput('default', {}, ENV)).toEqual({
      baseUrl: 'https://test-server.brapi.org/brapi/v2',
      auth: { mode: 'none' },
    });
  });

  it('uses alias env when alias matches', () => {
    expect(resolveConnectInput('cassava', {}, ENV)).toEqual({
      baseUrl: 'https://cassavabase.org/brapi/v2',
      auth: { mode: 'sgn', username: 'cyanheads', password: 'secret' },
    });
  });

  it('falls back to default env when alias env is missing baseUrl', () => {
    const env = { BRAPI_DEFAULT_BASE_URL: 'https://fallback.example/brapi/v2' };
    expect(resolveConnectInput('cassava', {}, env)).toEqual({
      baseUrl: 'https://fallback.example/brapi/v2',
      auth: { mode: 'none' },
    });
  });

  it('agent baseUrl wins over env', () => {
    const result = resolveConnectInput(
      'cassava',
      { baseUrl: 'https://agent.example/brapi/v2' },
      ENV,
    );
    expect(result.baseUrl).toBe('https://agent.example/brapi/v2');
    // Auth still derived from env
    expect(result.auth).toEqual({ mode: 'sgn', username: 'cyanheads', password: 'secret' });
  });

  it('agent auth wins over env', () => {
    const result = resolveConnectInput(
      'cassava',
      { auth: { mode: 'bearer', token: 'agent-tok' } },
      ENV,
    );
    expect(result.auth).toEqual({ mode: 'bearer', token: 'agent-tok' });
    expect(result.baseUrl).toBe('https://cassavabase.org/brapi/v2');
  });

  it('throws when no baseUrl is resolvable', () => {
    expect(() => resolveConnectInput('cassava', {}, {})).toThrowError(/No baseUrl provided/);
  });

  it('error message names the alias-specific env var', () => {
    expect(() => resolveConnectInput('myserver', {}, {})).toThrowError(/BRAPI_MYSERVER_BASE_URL/);
  });

  it('error message also mentions the default env var when alias is not default', () => {
    expect(() => resolveConnectInput('cassava', {}, {})).toThrowError(/BRAPI_DEFAULT_BASE_URL/);
  });

  it('does not mention default env var when alias is "default"', () => {
    try {
      resolveConnectInput('default', {}, {});
      expect.fail('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('BRAPI_DEFAULT_BASE_URL');
      // Should not duplicate "or BRAPI_DEFAULT_BASE_URL" suffix
      expect(message.match(/BRAPI_DEFAULT_BASE_URL/g)?.length).toBe(1);
    }
  });

  it('falls through to no-auth when no credentials anywhere', () => {
    const env = { BRAPI_DEFAULT_BASE_URL: 'https://x.example/brapi/v2' };
    expect(resolveConnectInput('default', {}, env)).toEqual({
      baseUrl: 'https://x.example/brapi/v2',
      auth: { mode: 'none' },
    });
  });
});

describe('discoverConfiguredAliases', () => {
  it('returns empty when no BRAPI_*_BASE_URL keys are set', () => {
    expect(discoverConfiguredAliases({ BRAPI_LOAD_LIMIT: '500' })).toEqual([]);
  });

  it('discovers aliases and derives auth modes from sibling vars', () => {
    const env = {
      BRAPI_DEFAULT_BASE_URL: 'https://test-server.brapi.org/brapi/v2',
      BRAPI_CASSAVA_BASE_URL: 'https://cassavabase.org/brapi/v2',
      BRAPI_CASSAVA_USERNAME: 'u',
      BRAPI_CASSAVA_PASSWORD: 'p',
      BRAPI_PROD_BASE_URL: 'https://my-brapi.example.com/brapi/v2',
      BRAPI_PROD_API_KEY: 'k',
      BRAPI_LOAD_LIMIT: '500',
    };
    expect(discoverConfiguredAliases(env)).toEqual([
      { alias: 'default', authMode: 'none', baseUrl: 'https://test-server.brapi.org/brapi/v2' },
      { alias: 'cassava', authMode: 'sgn', baseUrl: 'https://cassavabase.org/brapi/v2' },
      { alias: 'prod', authMode: 'api_key', baseUrl: 'https://my-brapi.example.com/brapi/v2' },
    ]);
  });

  it('skips aliases with empty BASE_URL values', () => {
    const env = {
      BRAPI_CASSAVA_BASE_URL: '',
      BRAPI_T3_BASE_URL: 'https://t3.example/brapi/v2',
    };
    expect(discoverConfiguredAliases(env)).toEqual([
      { alias: 't3', authMode: 'none', baseUrl: 'https://t3.example/brapi/v2' },
    ]);
  });

  it('reports authMode "none" when credential families collide (still surfaces alias)', () => {
    const env = {
      BRAPI_BAD_BASE_URL: 'https://bad.example/brapi/v2',
      BRAPI_BAD_USERNAME: 'u',
      BRAPI_BAD_PASSWORD: 'p',
      BRAPI_BAD_API_KEY: 'k',
    };
    expect(discoverConfiguredAliases(env)).toEqual([
      { alias: 'bad', authMode: 'none', baseUrl: 'https://bad.example/brapi/v2' },
    ]);
  });

  it('does not match unrelated BRAPI_* env vars', () => {
    const env = {
      BRAPI_RETRY_BASE_DELAY_MS: '500',
      BRAPI_DATASET_TTL_SECONDS: '86400',
      BRAPI_MAX_CONCURRENT_REQUESTS: '4',
    };
    expect(discoverConfiguredAliases(env)).toEqual([]);
  });
});

describe('formatConfiguredAliasesHint', () => {
  it('returns empty string when nothing is configured', () => {
    expect(formatConfiguredAliasesHint([])).toBe('');
  });

  it('lists aliases and emphasizes that other servers stay reachable', () => {
    const hint = formatConfiguredAliasesHint([
      { alias: 'default', authMode: 'none', baseUrl: 'https://test-server.brapi.org/brapi/v2' },
      { alias: 'cassava', authMode: 'sgn', baseUrl: 'https://cassavabase.org/brapi/v2' },
    ]);
    expect(hint).toContain('`default`');
    expect(hint).toContain('`cassava`');
    expect(hint).toContain('shortcuts only');
    expect(hint).toMatch(/any other BrAPI v2 server is reachable/i);
    expect(hint).toContain('`baseUrl`');
  });
});
