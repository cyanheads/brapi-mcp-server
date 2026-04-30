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
import type { AuthMode, ConnectAuth } from '@/services/server-registry/index.js';

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

/**
 * Summary of an alias discovered from env vars — what the operator pre-wired
 * for this deployment. Surfaced to the LLM via the connect tool description so
 * agents can pick a shortcut without the human having to enumerate them.
 */
export interface DiscoveredAlias {
  alias: string;
  authMode: AuthMode;
  baseUrl: string;
}

const ALIAS_BASE_URL_PATTERN = /^BRAPI_([A-Z0-9_]+)_BASE_URL$/;

/**
 * Scan env for `BRAPI_<X>_BASE_URL` keys and derive the alias inventory the
 * operator has pre-configured. Each alias resolves its credential family via
 * the same logic `resolveConnectInput` uses; ambiguous families fall back to
 * `none` so the alias is still surfaced (the connect call will then raise the
 * same `ValidationError` the agent would have hit anyway).
 *
 * Default-alias entries land first; the rest are alphabetical.
 */
export function discoverConfiguredAliases(env: NodeJS.ProcessEnv = process.env): DiscoveredAlias[] {
  const result: DiscoveredAlias[] = [];
  for (const [key, value] of Object.entries(env)) {
    const match = key.match(ALIAS_BASE_URL_PATTERN);
    const captured = match?.[1];
    if (!captured || !value) continue;
    const alias = captured.toLowerCase();
    const creds = readAliasCredentials(alias, env);
    let authMode: AuthMode = 'none';
    try {
      const auth = deriveAuthFromCredentials(creds, alias);
      if (auth) authMode = auth.mode;
    } catch {
      // Ambiguous credential family — surface the alias anyway.
    }
    result.push({ alias, authMode, baseUrl: value });
  }
  result.sort((a, b) => {
    if (a.alias === DEFAULT_ALIAS) return -1;
    if (b.alias === DEFAULT_ALIAS) return 1;
    return a.alias.localeCompare(b.alias);
  });
  return result;
}

/**
 * Render the discovered alias list as a sentence appended to the connect
 * tool's description. Empty when nothing is pre-configured — the original
 * description stands alone in that case. Phrased so that absent aliases are
 * never read as restricted servers: any BrAPI v2 URL stays connectable.
 */
export function formatConfiguredAliasesHint(aliases: DiscoveredAlias[]): string {
  if (aliases.length === 0) return '';
  const names = aliases.map((a) => `\`${a.alias}\``).join(', ');
  return `Pre-configured aliases on this deployment (callable without \`baseUrl\` or \`auth\` — credentials are read from server env vars): ${names}. Aliases are shortcuts only; any other BrAPI v2 server is reachable by passing \`baseUrl\` directly.`;
}
