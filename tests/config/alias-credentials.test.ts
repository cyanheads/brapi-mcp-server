/**
 * @fileoverview Unit tests for the per-alias env-var resolver. Covers prefix
 * derivation, env-var reading, auth-mode derivation across all credential
 * families, intra-alias ambiguity errors, and the agent > alias > builtin >
 * default layering inside `resolveConnectInput`.
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
import { BUILTIN_ALIASES } from '@/config/builtin-aliases.js';

/**
 * Disable every shipped builtin so tests focused on env-driven layering
 * aren't perturbed when new builtins are added to the registry. Tests that
 * specifically exercise builtin behavior opt-out of this fixture.
 */
const NO_BUILTINS = {
  BRAPI_BUILTIN_ALIASES_DISABLED: BUILTIN_ALIASES.map((b) => b.alias).join(','),
};

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
    ...NO_BUILTINS,
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

  it('falls back to default env when alias has no env or builtin entry', () => {
    const env = { ...NO_BUILTINS, BRAPI_DEFAULT_BASE_URL: 'https://fallback.example/brapi/v2' };
    expect(resolveConnectInput('myserver', {}, env)).toEqual({
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
    expect(() => resolveConnectInput('myserver', {}, NO_BUILTINS)).toThrowError(
      /No baseUrl provided/,
    );
  });

  it('error message names the alias-specific env var', () => {
    expect(() => resolveConnectInput('myserver', {}, NO_BUILTINS)).toThrowError(
      /BRAPI_MYSERVER_BASE_URL/,
    );
  });

  it('error message also mentions the default env var when alias is not default', () => {
    expect(() => resolveConnectInput('myserver', {}, NO_BUILTINS)).toThrowError(
      /BRAPI_DEFAULT_BASE_URL/,
    );
  });

  it('does not mention default env var when alias is "default"', () => {
    try {
      resolveConnectInput('default', {}, NO_BUILTINS);
      expect.fail('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('BRAPI_DEFAULT_BASE_URL');
      // Should not duplicate "or BRAPI_DEFAULT_BASE_URL" suffix
      expect(message.match(/BRAPI_DEFAULT_BASE_URL/g)?.length).toBe(1);
    }
  });

  it('falls through to no-auth when no credentials anywhere', () => {
    const env = { ...NO_BUILTINS, BRAPI_DEFAULT_BASE_URL: 'https://x.example/brapi/v2' };
    expect(resolveConnectInput('default', {}, env)).toEqual({
      baseUrl: 'https://x.example/brapi/v2',
      auth: { mode: 'none' },
    });
  });
});

describe('resolveConnectInput with builtin registry', () => {
  it('uses the builtin baseUrl when no env entry shadows it', () => {
    expect(resolveConnectInput('bti-cassava', {}, {})).toEqual({
      baseUrl: 'https://cassavabase.org/brapi/v2',
      auth: { mode: 'none' },
    });
  });

  it('env BASE_URL overrides the builtin baseUrl', () => {
    const env = { BRAPI_BTI_CASSAVA_BASE_URL: 'https://staging.example/brapi/v2' };
    expect(resolveConnectInput('bti-cassava', {}, env)).toEqual({
      baseUrl: 'https://staging.example/brapi/v2',
      auth: { mode: 'none' },
    });
  });

  it('agent baseUrl overrides the builtin baseUrl', () => {
    expect(
      resolveConnectInput('bti-cassava', { baseUrl: 'https://agent.example/brapi/v2' }, {}),
    ).toEqual({
      baseUrl: 'https://agent.example/brapi/v2',
      auth: { mode: 'none' },
    });
  });

  it('per-alias env credentials layer auth on top of the builtin URL', () => {
    const env = {
      BRAPI_BTI_CASSAVA_USERNAME: 'cyanheads',
      BRAPI_BTI_CASSAVA_PASSWORD: 'secret',
    };
    expect(resolveConnectInput('bti-cassava', {}, env)).toEqual({
      baseUrl: 'https://cassavabase.org/brapi/v2',
      auth: { mode: 'sgn', username: 'cyanheads', password: 'secret' },
    });
  });

  it('does not borrow default-env credentials when the builtin URL is in use', () => {
    // BRAPI_DEFAULT_* belongs to the default server; it must not auth against
    // an unrelated builtin URL that the operator never paired with creds.
    const env = {
      BRAPI_DEFAULT_BASE_URL: 'https://test-server.brapi.org/brapi/v2',
      BRAPI_DEFAULT_BEARER_TOKEN: 'default-tok',
    };
    expect(resolveConnectInput('bti-cassava', {}, env)).toEqual({
      baseUrl: 'https://cassavabase.org/brapi/v2',
      auth: { mode: 'none' },
    });
  });

  it('disabled builtin is not selectable — resolver falls through and throws', () => {
    expect(() =>
      resolveConnectInput('bti-cassava', {}, { BRAPI_BUILTIN_ALIASES_DISABLED: 'bti-cassava' }),
    ).toThrowError(/No baseUrl provided/);
  });

  it('disabled list is case-insensitive and tolerates whitespace', () => {
    expect(() =>
      resolveConnectInput(
        'bti-cassava',
        {},
        { BRAPI_BUILTIN_ALIASES_DISABLED: ' BTI-Cassava , T3-Wheat ' },
      ),
    ).toThrowError(/No baseUrl provided/);
  });

  it('builtin is matched case-insensitively against the requested alias', () => {
    expect(resolveConnectInput('BTI-CASSAVA', {}, {})).toEqual({
      baseUrl: 'https://cassavabase.org/brapi/v2',
      auth: { mode: 'none' },
    });
  });
});

describe('discoverConfiguredAliases', () => {
  it('returns empty when no BRAPI_*_BASE_URL keys are set and builtins are disabled', () => {
    expect(discoverConfiguredAliases({ ...NO_BUILTINS, BRAPI_LOAD_LIMIT: '500' })).toEqual([]);
  });

  it('discovers aliases and derives auth modes from sibling vars', () => {
    const env = {
      ...NO_BUILTINS,
      BRAPI_DEFAULT_BASE_URL: 'https://test-server.brapi.org/brapi/v2',
      BRAPI_CASSAVA_BASE_URL: 'https://cassavabase.org/brapi/v2',
      BRAPI_CASSAVA_USERNAME: 'u',
      BRAPI_CASSAVA_PASSWORD: 'p',
      BRAPI_PROD_BASE_URL: 'https://my-brapi.example.com/brapi/v2',
      BRAPI_PROD_API_KEY: 'k',
      BRAPI_LOAD_LIMIT: '500',
    };
    expect(discoverConfiguredAliases(env)).toEqual([
      {
        alias: 'default',
        authMode: 'none',
        baseUrl: 'https://test-server.brapi.org/brapi/v2',
        origin: 'env',
      },
      {
        alias: 'cassava',
        authMode: 'sgn',
        baseUrl: 'https://cassavabase.org/brapi/v2',
        origin: 'env',
      },
      {
        alias: 'prod',
        authMode: 'api_key',
        baseUrl: 'https://my-brapi.example.com/brapi/v2',
        origin: 'env',
      },
    ]);
  });

  it('skips aliases with empty BASE_URL values', () => {
    const env = {
      ...NO_BUILTINS,
      BRAPI_CASSAVA_BASE_URL: '',
      BRAPI_T3_BASE_URL: 'https://t3.example/brapi/v2',
    };
    expect(discoverConfiguredAliases(env)).toEqual([
      { alias: 't3', authMode: 'none', baseUrl: 'https://t3.example/brapi/v2', origin: 'env' },
    ]);
  });

  it('reports authMode "none" when credential families collide (still surfaces alias)', () => {
    const env = {
      ...NO_BUILTINS,
      BRAPI_BAD_BASE_URL: 'https://bad.example/brapi/v2',
      BRAPI_BAD_USERNAME: 'u',
      BRAPI_BAD_PASSWORD: 'p',
      BRAPI_BAD_API_KEY: 'k',
    };
    expect(discoverConfiguredAliases(env)).toEqual([
      { alias: 'bad', authMode: 'none', baseUrl: 'https://bad.example/brapi/v2', origin: 'env' },
    ]);
  });

  it('does not match unrelated BRAPI_* env vars', () => {
    const env = {
      ...NO_BUILTINS,
      BRAPI_RETRY_BASE_DELAY_MS: '500',
      BRAPI_DATASET_TTL_SECONDS: '86400',
      BRAPI_MAX_CONCURRENT_REQUESTS: '4',
    };
    expect(discoverConfiguredAliases(env)).toEqual([]);
  });

  it('surfaces builtins with origin "builtin" when no env entry shadows them', () => {
    const result = discoverConfiguredAliases({});
    expect(result.find((a) => a.alias === 'bti-cassava')).toEqual({
      alias: 'bti-cassava',
      authMode: 'none',
      baseUrl: 'https://cassavabase.org/brapi/v2',
      origin: 'builtin',
    });
    expect(result.find((a) => a.alias === 'bti-sweetpotato')?.origin).toBe('builtin');
    expect(result.find((a) => a.alias === 't3-wheat')?.origin).toBe('builtin');
    expect(result.find((a) => a.alias === 't3-oat')?.origin).toBe('builtin');
    expect(result.find((a) => a.alias === 't3-barley')?.origin).toBe('builtin');
    expect(result.find((a) => a.alias === 'bti-breedbase-demo')?.origin).toBe('builtin');
  });

  it('env BASE_URL shadows the builtin and reports origin "env"', () => {
    const env = { BRAPI_BTI_CASSAVA_BASE_URL: 'https://staging.example/brapi/v2' };
    const result = discoverConfiguredAliases(env);
    const cassava = result.find((a) => a.alias === 'bti-cassava');
    expect(cassava).toEqual({
      alias: 'bti-cassava',
      authMode: 'none',
      baseUrl: 'https://staging.example/brapi/v2',
      origin: 'env',
    });
  });

  it('builtin alias picks up env-set credentials with the right authMode', () => {
    const env = {
      BRAPI_BTI_CASSAVA_USERNAME: 'u',
      BRAPI_BTI_CASSAVA_PASSWORD: 'p',
    };
    const result = discoverConfiguredAliases(env);
    expect(result.find((a) => a.alias === 'bti-cassava')).toEqual({
      alias: 'bti-cassava',
      authMode: 'sgn',
      baseUrl: 'https://cassavabase.org/brapi/v2',
      origin: 'builtin',
    });
  });

  it('respects BRAPI_BUILTIN_ALIASES_DISABLED', () => {
    const result = discoverConfiguredAliases({
      BRAPI_BUILTIN_ALIASES_DISABLED: 'bti-cassava,t3-wheat',
    });
    expect(result.find((a) => a.alias === 'bti-cassava')).toBeUndefined();
    expect(result.find((a) => a.alias === 't3-wheat')).toBeUndefined();
    expect(result.find((a) => a.alias === 'bti-sweetpotato')?.origin).toBe('builtin');
  });
});

describe('formatConfiguredAliasesHint', () => {
  it('returns empty string when nothing is configured', () => {
    expect(formatConfiguredAliasesHint([])).toBe('');
  });

  it('lists env-only aliases and notes that other servers stay reachable', () => {
    const hint = formatConfiguredAliasesHint([
      {
        alias: 'default',
        authMode: 'none',
        baseUrl: 'https://test-server.brapi.org/brapi/v2',
        origin: 'env',
      },
      {
        alias: 'cassava',
        authMode: 'sgn',
        baseUrl: 'https://cassavabase.org/brapi/v2',
        origin: 'env',
      },
    ]);
    expect(hint).toContain('`default`');
    expect(hint).toContain('`cassava`');
    expect(hint).toContain('Operator-configured');
    expect(hint).toContain('shortcuts only');
    expect(hint).toMatch(/any other BrAPI v2 server is reachable/i);
    expect(hint).toContain('`baseUrl`');
  });

  it('splits builtins and env aliases into separate sentences', () => {
    const hint = formatConfiguredAliasesHint([
      {
        alias: 'bti-cassava',
        authMode: 'none',
        baseUrl: 'https://cassavabase.org/brapi/v2',
        origin: 'builtin',
      },
      {
        alias: 't3-wheat',
        authMode: 'none',
        baseUrl: 'https://wheat.triticeaetoolbox.org/brapi/v2',
        origin: 'builtin',
      },
      {
        alias: 'prod',
        authMode: 'api_key',
        baseUrl: 'https://my-brapi.example.com/brapi/v2',
        origin: 'env',
      },
    ]);
    expect(hint).toContain('Built-in known servers');
    expect(hint).toContain('`bti-cassava`');
    expect(hint).toContain('`t3-wheat`');
    expect(hint).toContain('Operator-configured');
    expect(hint).toContain('`prod`');
  });
});
