/**
 * @fileoverview Unit tests for the per-alias env-var resolver. Covers prefix
 * derivation, env-var reading, auth-mode derivation across all credential
 * families, intra-alias ambiguity errors, and the agent > alias > builtin >
 * default layering inside `resolveConnectInput`.
 *
 * @module tests/config/alias-credentials.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
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
  it('treats whole-value host placeholders as unset while preserving literal segments', () => {
    expect(
      readAliasCredentials('cassava', {
        BRAPI_CASSAVA_BASE_URL: `\${user_config.BRAPI_CASSAVA_BASE_URL}`,
        BRAPI_CASSAVA_API_KEY: `\${user_config.BRAPI_CASSAVA_API_KEY}`,
        BRAPI_CASSAVA_PASSWORD: `prefix-\${secret}-suffix`,
      }),
    ).toEqual({ password: `prefix-\${secret}-suffix` });
  });
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

  it('refuses an agent baseUrl that would carry the alias env credentials elsewhere', () => {
    expect(() =>
      resolveConnectInput('cassava', { baseUrl: 'https://agent.example/brapi/v2' }, ENV),
    ).toThrowError(
      expect.objectContaining({
        code: JsonRpcErrorCode.Forbidden,
        data: expect.objectContaining({ reason: 'auth_base_url_mismatch', retryable: false }),
      }),
    );
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

describe('resolveConnectInput credential/baseUrl pairing', () => {
  const CASSAVA_URL = 'https://cassavabase.org/brapi/v2';
  const DEFAULT_URL = 'https://test-server.brapi.org/brapi/v2';
  const SGN = { mode: 'sgn', username: 'cyanheads', password: 'secret' } as const;

  function refusal(fn: () => unknown): McpError {
    try {
      fn();
    } catch (err) {
      return err as McpError;
    }
    throw new Error('expected resolveConnectInput to refuse');
  }

  describe('per-alias env credentials', () => {
    const ENV = {
      ...NO_BUILTINS,
      BRAPI_DEFAULT_BASE_URL: DEFAULT_URL,
      BRAPI_CASSAVA_BASE_URL: CASSAVA_URL,
      BRAPI_CASSAVA_USERNAME: 'cyanheads',
      BRAPI_CASSAVA_PASSWORD: 'secret',
    };

    it('refuses a different caller baseUrl with a typed, non-retryable Forbidden', () => {
      const err = refusal(() =>
        resolveConnectInput('cassava', { baseUrl: 'https://evil.example/brapi/v2' }, ENV),
      );
      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.Forbidden);
      expect(err.data).toMatchObject({
        reason: 'auth_base_url_mismatch',
        alias: 'cassava',
        retryable: false,
        recovery: { hint: expect.stringContaining('Omit `baseUrl`') },
      });
      // Neither the credentials nor the configured URL leak into the error.
      const serialized = JSON.stringify({ message: err.message, data: err.data });
      expect(serialized).not.toContain('secret');
      expect(serialized).not.toContain('cyanheads');
      expect(serialized).not.toContain('cassavabase.org');
    });

    it.each([
      ['identical', CASSAVA_URL],
      ['trailing slash', `${CASSAVA_URL}/`],
      ['several trailing slashes', `${CASSAVA_URL}///`],
      ['host case', 'https://CassavaBase.ORG/brapi/v2'],
      ['explicit default port', 'https://cassavabase.org:443/brapi/v2'],
    ])('keeps the credentials when the caller baseUrl matches (%s)', (_label, baseUrl) => {
      expect(resolveConnectInput('cassava', { baseUrl }, ENV)).toEqual({ baseUrl, auth: SGN });
    });

    it.each([
      ['scheme', 'http://cassavabase.org/brapi/v2'],
      ['path', 'https://cassavabase.org/brapi/v1'],
      ['path case', 'https://cassavabase.org/BRAPI/v2'],
      ['port', 'https://cassavabase.org:8443/brapi/v2'],
      ['subdomain', 'https://evil.cassavabase.org/brapi/v2'],
      ['query', 'https://cassavabase.org/brapi/v2?x=1'],
      ['userinfo', 'https://someone@cassavabase.org/brapi/v2'],
    ])('refuses when only the %s differs', (_label, baseUrl) => {
      expect(refusal(() => resolveConnectInput('cassava', { baseUrl }, ENV)).data).toMatchObject({
        reason: 'auth_base_url_mismatch',
      });
    });

    it('leaves caller-supplied auth untouched, whatever the baseUrl', () => {
      const auth = { mode: 'bearer', token: 'agent-tok' } as const;
      expect(
        resolveConnectInput('cassava', { baseUrl: 'https://agent.example/brapi/v2', auth }, ENV),
      ).toEqual({ baseUrl: 'https://agent.example/brapi/v2', auth });
      expect(
        resolveConnectInput(
          'cassava',
          { baseUrl: 'https://agent.example/brapi/v2', auth: { mode: 'none' } },
          ENV,
        ),
      ).toEqual({ baseUrl: 'https://agent.example/brapi/v2', auth: { mode: 'none' } });
    });

    it('refuses for every env credential family, including oauth2 with a pinned token URL', () => {
      const families = [
        { BRAPI_X_BEARER_TOKEN: 't' },
        { BRAPI_X_API_KEY: 'k', BRAPI_X_API_KEY_HEADER: 'X-Key' },
        {
          BRAPI_X_OAUTH_CLIENT_ID: 'c',
          BRAPI_X_OAUTH_CLIENT_SECRET: 's',
          BRAPI_X_OAUTH_TOKEN_URL: 'https://idp.example/token',
        },
      ];
      for (const creds of families) {
        const env = { ...NO_BUILTINS, BRAPI_X_BASE_URL: 'https://x.example/brapi/v2', ...creds };
        expect(
          refusal(() => resolveConnectInput('x', { baseUrl: 'https://y.example/brapi/v2' }, env))
            .data,
        ).toMatchObject({ reason: 'auth_base_url_mismatch' });
      }
    });

    it('pairs builtin-alias credentials with the builtin URL when no env URL is set', () => {
      const env = { BRAPI_BTI_CASSAVA_BEARER_TOKEN: 'tok' };
      expect(resolveConnectInput('bti-cassava', { baseUrl: `${CASSAVA_URL}/` }, env)).toEqual({
        baseUrl: `${CASSAVA_URL}/`,
        auth: { mode: 'bearer', token: 'tok' },
      });
      expect(
        refusal(() =>
          resolveConnectInput('bti-cassava', { baseUrl: 'https://mirror.example/brapi/v2' }, env),
        ).data,
      ).toMatchObject({ reason: 'auth_base_url_mismatch' });
    });

    it.each(['bti_cassava', 'BTI_CASSAVA'])(
      'pairs builtin credentials with the builtin URL under the %s spelling, never the default URL',
      (alias) => {
        // `bti_cassava` reads the same BRAPI_BTI_CASSAVA_* credentials as `bti-cassava`.
        const env = {
          BRAPI_DEFAULT_BASE_URL: DEFAULT_URL,
          BRAPI_BTI_CASSAVA_USERNAME: 'cyanheads',
          BRAPI_BTI_CASSAVA_PASSWORD: 'secret',
        };
        expect(resolveConnectInput(alias, {}, env)).toEqual({ baseUrl: CASSAVA_URL, auth: SGN });
        expect(
          refusal(() => resolveConnectInput(alias, { baseUrl: DEFAULT_URL }, env)).data,
        ).toMatchObject({ reason: 'auth_base_url_mismatch' });
      },
    );

    it('pairs builtin-alias credentials with the env URL when one overrides the builtin', () => {
      const env = {
        BRAPI_BTI_CASSAVA_BASE_URL: 'https://staging.example/brapi/v2',
        BRAPI_BTI_CASSAVA_BEARER_TOKEN: 'tok',
      };
      expect(
        refusal(() => resolveConnectInput('bti-cassava', { baseUrl: CASSAVA_URL }, env)).data,
      ).toMatchObject({ reason: 'auth_base_url_mismatch' });
    });

    describe('credentials with no URL of their own', () => {
      const ORPHAN_ENV = {
        ...NO_BUILTINS,
        BRAPI_DEFAULT_BASE_URL: DEFAULT_URL,
        BRAPI_FOO_BEARER_TOKEN: 'orphan-tok',
      };

      it.each([
        ['omitted', undefined],
        ['BRAPI_DEFAULT_BASE_URL', DEFAULT_URL],
        ['another server', 'https://a.example/brapi/v2'],
      ])(
        'refuse with a configuration error whatever the caller baseUrl (%s)',
        (_label, baseUrl) => {
          const err = refusal(() => resolveConnectInput('foo', { baseUrl }, ORPHAN_ENV));
          expect(err).toBeInstanceOf(McpError);
          expect(err.code).toBe(JsonRpcErrorCode.ConfigurationError);
          expect(err.data).toMatchObject({
            reason: 'alias_base_url_unset',
            alias: 'foo',
            retryable: false,
            recovery: { hint: expect.stringContaining('BRAPI_FOO_BASE_URL') },
          });
          expect(JSON.stringify({ m: err.message, d: err.data })).not.toContain('orphan-tok');
        },
      );

      it('refuse even when no BRAPI_DEFAULT_BASE_URL is set', () => {
        const env = { ...NO_BUILTINS, BRAPI_LONELY_BEARER_TOKEN: 'tok' };
        expect(refusal(() => resolveConnectInput('lonely', {}, env)).data).toMatchObject({
          reason: 'alias_base_url_unset',
        });
      });

      it('refuse leftover credentials of a disabled builtin', () => {
        const env = {
          BRAPI_BUILTIN_ALIASES_DISABLED: 'bti-cassava',
          BRAPI_DEFAULT_BASE_URL: DEFAULT_URL,
          BRAPI_BTI_CASSAVA_USERNAME: 'cyanheads',
          BRAPI_BTI_CASSAVA_PASSWORD: 'secret',
        };
        expect(refusal(() => resolveConnectInput('bti-cassava', {}, env)).data).toMatchObject({
          reason: 'alias_base_url_unset',
        });
      });

      it('do not block caller-supplied auth', () => {
        const auth = { mode: 'bearer', token: 'agent-tok' } as const;
        expect(resolveConnectInput('foo', { auth }, ORPHAN_ENV)).toEqual({
          baseUrl: DEFAULT_URL,
          auth,
        });
      });
    });

    it('treats BRAPI_DEFAULT_* as the default alias own credentials and refuses a mismatch', () => {
      const env = {
        ...NO_BUILTINS,
        BRAPI_DEFAULT_BASE_URL: DEFAULT_URL,
        BRAPI_DEFAULT_API_KEY: 'k',
      };
      expect(
        refusal(() => resolveConnectInput('default', { baseUrl: 'https://other.example/v2' }, env))
          .data,
      ).toMatchObject({ reason: 'auth_base_url_mismatch', alias: 'default' });
      expect(resolveConnectInput('default', { baseUrl: `${DEFAULT_URL}/` }, env).auth).toEqual({
        mode: 'api_key',
        apiKey: 'k',
      });
    });

    it('normalizes a caller baseUrl in linear time', () => {
      for (const n of [5_000, 20_000, 80_000, 200_000]) {
        const baseUrl = `${CASSAVA_URL}${'/'.repeat(n)}`;
        const started = performance.now();
        expect(resolveConnectInput('cassava', { baseUrl }, ENV).auth).toEqual(SGN);
        expect(performance.now() - started).toBeLessThan(200);
      }
    });

    it('does not refuse an unparsable caller baseUrl and attaches no credentials to it', () => {
      expect(resolveConnectInput('cassava', { baseUrl: 'not a url' }, ENV)).toEqual({
        baseUrl: 'not a url',
        auth: { mode: 'none' },
      });
    });
  });

  describe('default-layer credentials', () => {
    const ENV = {
      ...NO_BUILTINS,
      BRAPI_DEFAULT_BASE_URL: DEFAULT_URL,
      BRAPI_DEFAULT_BEARER_TOKEN: 'd',
    };

    it('attach when the alias resolves to BRAPI_DEFAULT_BASE_URL', () => {
      expect(resolveConnectInput('other', {}, ENV)).toEqual({
        baseUrl: DEFAULT_URL,
        auth: { mode: 'bearer', token: 'd' },
      });
      expect(
        resolveConnectInput('other', { baseUrl: 'https://TEST-SERVER.brapi.org/brapi/v2/' }, ENV),
      ).toEqual({
        baseUrl: 'https://TEST-SERVER.brapi.org/brapi/v2/',
        auth: { mode: 'bearer', token: 'd' },
      });
    });

    it('are silently dropped for a caller baseUrl on another server', () => {
      expect(
        resolveConnectInput('other', { baseUrl: 'https://evil.example/brapi/v2' }, ENV),
      ).toEqual({ baseUrl: 'https://evil.example/brapi/v2', auth: { mode: 'none' } });
    });

    it('are not attached to an alias env URL that differs from the default URL', () => {
      const env = { ...ENV, BRAPI_MIRROR_BASE_URL: 'https://mirror.example/brapi/v2' };
      expect(resolveConnectInput('mirror', {}, env)).toEqual({
        baseUrl: 'https://mirror.example/brapi/v2',
        auth: { mode: 'none' },
      });
    });

    it('do not throw on an ambiguous default family when they would not be used', () => {
      const env = { BRAPI_DEFAULT_BEARER_TOKEN: 't', BRAPI_DEFAULT_API_KEY: 'k' };
      expect(resolveConnectInput('bti-cassava', {}, env)).toEqual({
        baseUrl: CASSAVA_URL,
        auth: { mode: 'none' },
      });
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
        { BRAPI_BUILTIN_ALIASES_DISABLED: ' BTI-Cassava , BTI-SweetPotato ' },
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
  it('does not advertise placeholders as configured aliases or shadow a builtin', () => {
    const env = {
      BRAPI_UNKNOWN_BASE_URL: `\${user_config.BRAPI_UNKNOWN_BASE_URL}`,
      BRAPI_BTI_CASSAVA_BASE_URL: `\${user_config.BRAPI_BTI_CASSAVA_BASE_URL}`,
      BRAPI_BTI_CASSAVA_API_KEY: `\${user_config.BRAPI_BTI_CASSAVA_API_KEY}`,
    };
    const aliases = discoverConfiguredAliases(env);
    expect(aliases.some((a) => a.alias === 'unknown')).toBe(false);
    expect(aliases.find((a) => a.alias === 'bti-cassava')).toEqual({
      alias: 'bti-cassava',
      authMode: 'none',
      origin: 'builtin',
      baseUrl: 'https://cassavabase.org/brapi/v2',
    });
    expect(resolveConnectInput('bti-cassava', {}, env)).toEqual({
      baseUrl: 'https://cassavabase.org/brapi/v2',
      auth: { mode: 'none' },
    });
  });
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
    expect(result.find((a) => a.alias === 'bti-breedbase-demo')?.origin).toBe('builtin');
    expect(result.map((a) => a.alias)).toEqual([
      'bti-breedbase-demo',
      'bti-cassava',
      'bti-sweetpotato',
    ]);
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

  it('reports the auth mode an argument-free connect would actually use', () => {
    const env = {
      ...NO_BUILTINS,
      BRAPI_DEFAULT_BASE_URL: 'https://test-server.brapi.org/brapi/v2',
      BRAPI_DEFAULT_BEARER_TOKEN: 'd',
      BRAPI_SAME_BASE_URL: 'https://TEST-SERVER.brapi.org/brapi/v2/',
      BRAPI_MIRROR_BASE_URL: 'https://mirror.example/brapi/v2',
      BRAPI_ORPHAN_BEARER_TOKEN: 'o',
    };
    const byAlias = Object.fromEntries(
      discoverConfiguredAliases(env).map((a) => [a.alias, a.authMode]),
    );
    // Default credentials follow BRAPI_DEFAULT_BASE_URL, not a per-alias URL.
    expect(byAlias).toEqual({ default: 'bearer', same: 'bearer', mirror: 'none' });
    for (const alias of ['default', 'same', 'mirror']) {
      expect(resolveConnectInput(alias, {}, env).auth.mode).toBe(byAlias[alias]);
    }
  });

  it('does not advertise credentials that have no URL to pair with', () => {
    const env = {
      BRAPI_BUILTIN_ALIASES_DISABLED: 'bti-cassava',
      BRAPI_DEFAULT_BASE_URL: 'https://test-server.brapi.org/brapi/v2',
      BRAPI_BTI_CASSAVA_BEARER_TOKEN: 'leftover',
      BRAPI_ORPHAN_API_KEY: 'k',
    };
    const aliases = discoverConfiguredAliases(env).map((a) => a.alias);
    expect(aliases).not.toContain('bti-cassava');
    expect(aliases).not.toContain('orphan');
  });

  it('respects BRAPI_BUILTIN_ALIASES_DISABLED', () => {
    const result = discoverConfiguredAliases({
      BRAPI_BUILTIN_ALIASES_DISABLED: 'bti-cassava,bti-breedbase-demo',
    });
    expect(result.find((a) => a.alias === 'bti-cassava')).toBeUndefined();
    expect(result.find((a) => a.alias === 'bti-breedbase-demo')).toBeUndefined();
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
        alias: 'bti-sweetpotato',
        authMode: 'none',
        baseUrl: 'https://sweetpotatobase.org/brapi/v2',
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
    expect(hint).toContain('`bti-sweetpotato`');
    expect(hint).toContain('Operator-configured');
    expect(hint).toContain('`prod`');
  });
});
