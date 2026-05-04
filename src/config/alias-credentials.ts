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
import { findBuiltinAlias, listBuiltinAliases } from '@/config/builtin-aliases.js';
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
const NONE_AUTH: ConnectAuth = { mode: 'none' };

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
 * Layer agent input over alias env over the builtin registry over default env.
 * Returns the resolved baseUrl + auth. Throws when no baseUrl is resolvable
 * from any layer.
 *
 * Precedence:
 *   1. Explicit agent input (`baseUrl`, `auth`) wins.
 *   2. Per-alias env vars (`BRAPI_<ALIAS>_*`).
 *   3. Built-in known-server registry — see `config/builtin-aliases.ts`.
 *   4. Default env vars (`BRAPI_DEFAULT_*`) — only when alias differs.
 *   5. `auth` falls through to `{ mode: 'none' }`; `baseUrl` has no fallback.
 *
 * When the baseUrl is satisfied by a builtin, default-env auth is NOT used —
 * default credentials belong to the default server, not whatever upstream the
 * builtin happens to point at. Per-alias creds still apply, since those were
 * explicitly set for this alias.
 */
export function resolveConnectInput(
  alias: string,
  agent: { baseUrl?: string | undefined; auth?: ConnectAuth | undefined },
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConnectInput {
  const aliasCreds = readAliasCredentials(alias, env);
  const defaultCreds =
    alias === DEFAULT_ALIAS ? aliasCreds : readAliasCredentials(DEFAULT_ALIAS, env);

  const builtin = !agent.baseUrl && !aliasCreds.baseUrl ? findBuiltinAlias(alias, env) : undefined;
  const baseUrl = agent.baseUrl ?? aliasCreds.baseUrl ?? builtin?.baseUrl ?? defaultCreds.baseUrl;
  if (!baseUrl) {
    throw validationError(
      `No baseUrl provided. Pass \`baseUrl\` explicitly, or set ${aliasEnvPrefix(alias)}BASE_URL${alias === DEFAULT_ALIAS ? '' : ` or ${aliasEnvPrefix(DEFAULT_ALIAS)}BASE_URL`}.`,
      { alias },
    );
  }

  const allowDefaultAuthFallback = !builtin && alias !== DEFAULT_ALIAS;
  const auth =
    agent.auth ??
    deriveAuthFromCredentials(aliasCreds, alias) ??
    (allowDefaultAuthFallback
      ? deriveAuthFromCredentials(defaultCreds, DEFAULT_ALIAS)
      : undefined) ??
    NONE_AUTH;

  return { baseUrl, auth };
}

/**
 * Summary of an alias the agent can call out-of-the-box. Either pre-wired by
 * the operator via `BRAPI_<ALIAS>_BASE_URL` (`origin: 'env'`) or shipped in the
 * built-in known-server registry (`origin: 'builtin'`). Surfaced to the LLM
 * via the connect tool description so agents can pick a shortcut without the
 * human having to enumerate them.
 */
export interface DiscoveredAlias {
  alias: string;
  authMode: AuthMode;
  baseUrl: string;
  origin: 'env' | 'builtin';
}

const ALIAS_BASE_URL_PATTERN = /^BRAPI_([A-Z0-9_]+)_BASE_URL$/;

/**
 * Inventory of aliases the agent can call without specifying a baseUrl. Merges
 * env-driven entries (operator-set `BRAPI_<X>_BASE_URL`) with the built-in
 * known-server registry. Env-set aliases win when both are present, since the
 * resolver gives env precedence; their `origin` reflects that. Per-alias
 * credentials still derive auth in either case, so a builtin alias with
 * `BRAPI_<ALIAS>_USERNAME` set surfaces with the right `authMode`.
 *
 * Default-alias entries land first; the rest are alphabetical.
 */
export function discoverConfiguredAliases(env: NodeJS.ProcessEnv = process.env): DiscoveredAlias[] {
  const result: DiscoveredAlias[] = [];
  const seen = new Set<string>();

  for (const [key, value] of Object.entries(env)) {
    const match = key.match(ALIAS_BASE_URL_PATTERN);
    const captured = match?.[1];
    if (!captured || !value) continue;
    const alias = captured.toLowerCase();
    const creds = readAliasCredentials(alias, env);
    result.push({
      alias,
      authMode: deriveModeForDiscovery(creds, alias),
      baseUrl: value,
      origin: 'env',
    });
    seen.add(alias);
  }

  for (const builtin of listBuiltinAliases(env)) {
    if (seen.has(builtin.alias)) continue;
    const creds = readAliasCredentials(builtin.alias, env);
    result.push({
      alias: builtin.alias,
      authMode: deriveModeForDiscovery(creds, builtin.alias),
      baseUrl: builtin.baseUrl,
      origin: 'builtin',
    });
  }

  result.sort((a, b) => {
    if (a.alias === DEFAULT_ALIAS) return -1;
    if (b.alias === DEFAULT_ALIAS) return 1;
    return a.alias.localeCompare(b.alias);
  });
  return result;
}

function deriveModeForDiscovery(creds: AliasCredentials, alias: string): AuthMode {
  try {
    const auth = deriveAuthFromCredentials(creds, alias);
    return auth?.mode ?? 'none';
  } catch {
    // Ambiguous credential family — surface the alias as `none` so the agent
    // still sees it; the connect call will raise the same ValidationError.
    return 'none';
  }
}

/**
 * Render the discovered alias list as a sentence appended to the connect
 * tool's description. Empty when nothing is configured. Splits builtins from
 * env-driven aliases so the LLM understands which work out-of-the-box vs
 * which the operator pre-wired. Phrased so that absent aliases are never read
 * as restricted servers: any BrAPI v2 URL stays connectable.
 */
export function formatConfiguredAliasesHint(aliases: DiscoveredAlias[]): string {
  if (aliases.length === 0) return '';
  const builtin = aliases.filter((a) => a.origin === 'builtin').map((a) => `\`${a.alias}\``);
  const env = aliases.filter((a) => a.origin === 'env').map((a) => `\`${a.alias}\``);
  const parts: string[] = [];
  if (builtin.length > 0) {
    parts.push(
      `Built-in known servers (callable with no \`baseUrl\` or \`auth\` — public BrAPI v2 endpoints): ${builtin.join(', ')}.`,
    );
  }
  if (env.length > 0) {
    parts.push(
      `Operator-configured aliases on this deployment (credentials and/or baseUrl read from server env vars): ${env.join(', ')}.`,
    );
  }
  parts.push(
    'Aliases are shortcuts only; any other BrAPI v2 server is reachable by passing `baseUrl` directly.',
  );
  return parts.join(' ');
}
