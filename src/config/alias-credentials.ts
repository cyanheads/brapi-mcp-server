/**
 * @fileoverview Per-alias env-var resolution for `brapi_connect`.
 *
 * Aliases map to env-var prefixes via `BRAPI_<ALIAS>_*` (uppercased, hyphens →
 * underscores). Each alias can carry baseUrl + one credential family; the
 * connect handler layers agent input over alias env over default env over the
 * no-auth fallback. Credentials live in env, never in the LLM context.
 *
 * @module config/alias-credentials
 */

import { validationError } from '@cyanheads/mcp-ts-core/errors';
import type { ConnectAuth } from '@/services/server-registry/index.js';

/**
 * Per-alias credential bundle read from env vars. All fields optional —
 * presence is what determines which auth mode is derived.
 */
export interface AliasCredentials {
  apiKey?: string;
  apiKeyHeader?: string;
  baseUrl?: string;
  bearerToken?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthTokenUrl?: string;
  password?: string;
  username?: string;
}

const FIELD_SUFFIXES: ReadonlyArray<readonly [keyof AliasCredentials, string]> = [
  ['baseUrl', 'BASE_URL'],
  ['username', 'USERNAME'],
  ['password', 'PASSWORD'],
  ['apiKey', 'API_KEY'],
  ['apiKeyHeader', 'API_KEY_HEADER'],
  ['bearerToken', 'BEARER_TOKEN'],
  ['oauthClientId', 'OAUTH_CLIENT_ID'],
  ['oauthClientSecret', 'OAUTH_CLIENT_SECRET'],
  ['oauthTokenUrl', 'OAUTH_TOKEN_URL'],
];

const DEFAULT_ALIAS = 'default';

/** Compute the env-var prefix for an alias. `my-server` → `BRAPI_MY_SERVER_`. */
export function aliasEnvPrefix(alias: string): string {
  return `BRAPI_${alias.replace(/-/g, '_').toUpperCase()}_`;
}

/** Read all `BRAPI_<ALIAS>_*` vars for an alias. Empty strings treated as unset. */
export function readAliasCredentials(
  alias: string,
  env: NodeJS.ProcessEnv = process.env,
): AliasCredentials {
  const prefix = aliasEnvPrefix(alias);
  const result: AliasCredentials = {};
  for (const [field, suffix] of FIELD_SUFFIXES) {
    const value = env[`${prefix}${suffix}`];
    if (value !== undefined && value !== '') result[field] = value;
  }
  return result;
}

/**
 * Pick a `ConnectAuth` from the credential bundle. Returns `undefined` when no
 * credentials are present so callers can fall through to the next layer.
 * Throws on intra-alias ambiguity (multiple credential families set).
 */
export function deriveAuthFromCredentials(
  creds: AliasCredentials,
  alias: string,
): ConnectAuth | undefined {
  const families: Array<{ name: string; present: boolean }> = [
    { name: 'sgn (username+password)', present: !!(creds.username && creds.password) },
    { name: 'bearer (bearerToken)', present: !!creds.bearerToken },
    { name: 'api_key (apiKey)', present: !!creds.apiKey },
    {
      name: 'oauth2 (oauthClientId+oauthClientSecret)',
      present: !!(creds.oauthClientId && creds.oauthClientSecret),
    },
  ];
  const present = families.filter((f) => f.present).map((f) => f.name);
  if (present.length === 0) return;
  if (present.length > 1) {
    throw validationError(
      `Ambiguous auth config for alias '${alias}': multiple credential families set (${present.join(', ')}). Pick one — clear the env vars for the others.`,
      { alias, present },
    );
  }
  if (creds.username && creds.password) {
    return { mode: 'sgn', username: creds.username, password: creds.password };
  }
  if (creds.bearerToken) {
    return { mode: 'bearer', token: creds.bearerToken };
  }
  if (creds.apiKey) {
    return creds.apiKeyHeader
      ? { mode: 'api_key', apiKey: creds.apiKey, headerName: creds.apiKeyHeader }
      : { mode: 'api_key', apiKey: creds.apiKey };
  }
  if (creds.oauthClientId && creds.oauthClientSecret) {
    return creds.oauthTokenUrl
      ? {
          mode: 'oauth2',
          clientId: creds.oauthClientId,
          clientSecret: creds.oauthClientSecret,
          tokenUrl: creds.oauthTokenUrl,
        }
      : { mode: 'oauth2', clientId: creds.oauthClientId, clientSecret: creds.oauthClientSecret };
  }
  return;
}

export interface ResolvedConnectInput {
  auth: ConnectAuth;
  baseUrl: string;
}

/**
 * Layer agent input over alias env over default env. Returns the resolved
 * baseUrl + auth. Throws when no baseUrl is resolvable from any layer.
 *
 * Precedence:
 *   1. Explicit agent input (`baseUrl`, `auth`) wins.
 *   2. Per-alias env vars (`BRAPI_<ALIAS>_*`).
 *   3. Default env vars (`BRAPI_DEFAULT_*`) — only when alias differs.
 *   4. `auth` falls through to `{ mode: 'none' }`; `baseUrl` has no fallback.
 */
export function resolveConnectInput(
  alias: string,
  agent: { baseUrl?: string | undefined; auth?: ConnectAuth | undefined },
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConnectInput {
  const aliasCreds = readAliasCredentials(alias, env);
  const defaultCreds =
    alias === DEFAULT_ALIAS ? aliasCreds : readAliasCredentials(DEFAULT_ALIAS, env);

  const baseUrl = agent.baseUrl ?? aliasCreds.baseUrl ?? defaultCreds.baseUrl;
  if (!baseUrl) {
    throw validationError(
      `No baseUrl provided. Pass \`baseUrl\` explicitly, or set ${aliasEnvPrefix(alias)}BASE_URL${alias === DEFAULT_ALIAS ? '' : ` or ${aliasEnvPrefix(DEFAULT_ALIAS)}BASE_URL`}.`,
      { alias },
    );
  }

  const auth =
    agent.auth ??
    deriveAuthFromCredentials(aliasCreds, alias) ??
    (alias === DEFAULT_ALIAS
      ? undefined
      : deriveAuthFromCredentials(defaultCreds, DEFAULT_ALIAS)) ??
    ({ mode: 'none' } as ConnectAuth);

  return { baseUrl, auth };
}
