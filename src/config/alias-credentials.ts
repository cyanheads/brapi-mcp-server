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

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';
import { configurationError, forbidden, validationError } from '@cyanheads/mcp-ts-core/errors';
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

const AliasCredentialsSchema = z.object({
  baseUrl: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  apiKey: z.string().optional(),
  apiKeyHeader: z.string().optional(),
  bearerToken: z.string().optional(),
  oauthClientId: z.string().optional(),
  oauthClientSecret: z.string().optional(),
  oauthTokenUrl: z.string().optional(),
});

const DEFAULT_ALIAS = 'default';
const NONE_AUTH: ConnectAuth = { mode: 'none' };

/** Compute the env-var prefix for an alias. `my-server` → `BRAPI_MY_SERVER_`. */
export function aliasEnvPrefix(alias: string): string {
  return `BRAPI_${alias.replace(/-/g, '_').toUpperCase()}_`;
}

/** Read alias env vars; empty strings and whole-value host placeholders are unset. */
export function readAliasCredentials(
  alias: string,
  env: NodeJS.ProcessEnv = process.env,
): AliasCredentials {
  const prefix = aliasEnvPrefix(alias);
  const parsed = parseEnvConfig(
    AliasCredentialsSchema,
    Object.fromEntries(FIELD_SUFFIXES.map(([field, suffix]) => [field, `${prefix}${suffix}`])),
    env,
  );
  const result: AliasCredentials = {};
  for (const [field] of FIELD_SUFFIXES) {
    const value = parsed[field];
    if (value !== undefined) result[field] = value;
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

/** Recovery hint for the `auth_base_url_mismatch` refusal; shared with the `brapi_connect` contract. */
export const AUTH_BASE_URL_MISMATCH_RECOVERY =
  'Omit `baseUrl` to connect to the server configured for this alias, or register the other server under a different alias.';

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
 * Env credentials only travel to the server configured alongside them:
 * - Per-alias credentials pair with the alias's own URL: its env base URL,
 *   else its enabled builtin URL (for `default`, `BRAPI_DEFAULT_BASE_URL`).
 *   A caller `baseUrl` that differs from it is refused with
 *   `auth_base_url_mismatch`. Credentials with no URL of their own pair with
 *   nothing and are refused with `alias_base_url_unset` — they never fall
 *   back to `BRAPI_DEFAULT_BASE_URL`. Both refusals precede any request.
 * - Default credentials pair with `BRAPI_DEFAULT_BASE_URL` only. For another
 *   alias they attach when the resolved URL is that one and are otherwise
 *   left off, so auth falls through to `none`.
 *
 * URLs compare after normalization (host case, default port, trailing
 * slashes). Caller-supplied `auth` bypasses env credentials entirely.
 */
export function resolveConnectInput(
  alias: string,
  agent: { baseUrl?: string | undefined; auth?: ConnectAuth | undefined },
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConnectInput {
  const aliasCreds = readAliasCredentials(alias, env);
  const defaultCreds =
    alias === DEFAULT_ALIAS ? aliasCreds : readAliasCredentials(DEFAULT_ALIAS, env);

  const ownBaseUrl = aliasCreds.baseUrl ?? findBuiltinAlias(alias, env)?.baseUrl;
  const aliasAuth = agent.auth ? undefined : deriveAuthFromCredentials(aliasCreds, alias);
  if (aliasAuth && ownBaseUrl === undefined) {
    const envVar = `${aliasEnvPrefix(alias)}BASE_URL`;
    throw configurationError(
      `Alias '${alias}' has server-configured credentials but no base URL of its own, so they are not sent anywhere. Set ${envVar} on the server, or remove the alias's credential variables. No request was made.`,
      {
        reason: 'alias_base_url_unset',
        alias,
        envVar,
        retryable: false,
        recovery: {
          hint: `Set ${envVar} on the server for alias '${alias}', or remove its credential variables, before retrying.`,
        },
      },
    );
  }

  const baseUrl = agent.baseUrl ?? ownBaseUrl ?? defaultCreds.baseUrl;
  if (!baseUrl) {
    throw validationError(
      `No baseUrl provided. Pass \`baseUrl\` explicitly, or set ${aliasEnvPrefix(alias)}BASE_URL${alias === DEFAULT_ALIAS ? '' : ` or ${aliasEnvPrefix(DEFAULT_ALIAS)}BASE_URL`}.`,
      { alias },
    );
  }
  if (agent.auth) return { baseUrl, auth: agent.auth };

  if (aliasAuth) {
    if (agent.baseUrl === undefined || sameBaseUrl(agent.baseUrl, ownBaseUrl)) {
      return { baseUrl, auth: aliasAuth };
    }
    // An unparsable or userinfo-bearing caller URL fails baseUrl validation
    // downstream, which does not echo it; it just gets no credentials.
    if (comparableBaseUrl(agent.baseUrl) === undefined) return { baseUrl, auth: NONE_AUTH };
    throw forbidden(
      `Alias '${alias}' has server-configured credentials that are only sent to the server configured for it, and the supplied baseUrl points elsewhere. No request was made.`,
      {
        reason: 'auth_base_url_mismatch',
        alias,
        baseUrl: agent.baseUrl,
        retryable: false,
        recovery: { hint: AUTH_BASE_URL_MISMATCH_RECOVERY },
      },
    );
  }

  if (alias !== DEFAULT_ALIAS && sameBaseUrl(baseUrl, defaultCreds.baseUrl)) {
    const defaultAuth = deriveAuthFromCredentials(defaultCreds, DEFAULT_ALIAS);
    if (defaultAuth) return { baseUrl, auth: defaultAuth };
  }
  return { baseUrl, auth: NONE_AUTH };
}

/**
 * True when both URLs parse, carry no userinfo, and name the same BrAPI base:
 * scheme, host (case-insensitive), port (default port elided), path with
 * trailing slashes dropped, query, and fragment. A URL with userinfo never
 * matches — `brapi_connect` refuses it as a baseUrl.
 */
export function sameBaseUrl(a: string, b: string | undefined): boolean {
  if (b === undefined) return false;
  const left = comparableBaseUrl(a);
  return left !== undefined && left === comparableBaseUrl(b);
}

function comparableBaseUrl(value: string): string | undefined {
  if (!URL.canParse(value)) return;
  const url = new URL(value);
  if (url.username || url.password) return;
  // Read `pathname` once: the getter re-serializes on every access.
  const { pathname } = url;
  let end = pathname.length;
  while (end > 0 && pathname[end - 1] === '/') end--;
  const path = pathname.slice(0, end);
  return `${url.protocol}//${url.host}${path}${url.search}${url.hash}`;
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
 * resolver gives env precedence; their `origin` reflects that. `authMode` is
 * what an argument-free `brapi_connect` for the alias resolves to, so the
 * pairing rules apply: a builtin with `BRAPI_<ALIAS>_USERNAME` set reports
 * `sgn`, and default credentials count only on `BRAPI_DEFAULT_BASE_URL`.
 * Credentials with no URL of their own have nothing to connect to, so they
 * never surface an alias.
 *
 * Default-alias entries land first; the rest are alphabetical.
 */
export function discoverConfiguredAliases(env: NodeJS.ProcessEnv = process.env): DiscoveredAlias[] {
  const result: DiscoveredAlias[] = [];
  const seen = new Set<string>();
  const builtins = listBuiltinAliases(env);
  // Reverse-map for hyphen → underscore env-var translation: a builtin named
  // `bti-cassava` exposes BRAPI_BTI_CASSAVA_*, but the regex below only sees
  // the underscored form. Without this map, an env var that shadows a
  // hyphenated builtin would be reported as a separate `bti_cassava` alias.
  const builtinByUnderscoredName = new Map(builtins.map((b) => [b.alias.replace(/-/g, '_'), b]));

  for (const key of Object.keys(env)) {
    const match = key.match(ALIAS_BASE_URL_PATTERN);
    const captured = match?.[1];
    if (!captured) continue;
    const lowerCaptured = captured.toLowerCase();
    const alias = builtinByUnderscoredName.get(lowerCaptured)?.alias ?? lowerCaptured;
    const creds = readAliasCredentials(alias, env);
    if (!creds.baseUrl) continue;
    result.push({
      alias,
      authMode: deriveModeForDiscovery(alias, env),
      baseUrl: creds.baseUrl,
      origin: 'env',
    });
    seen.add(alias);
  }

  for (const builtin of builtins) {
    if (seen.has(builtin.alias)) continue;
    result.push({
      alias: builtin.alias,
      authMode: deriveModeForDiscovery(builtin.alias, env),
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

function deriveModeForDiscovery(alias: string, env: NodeJS.ProcessEnv): AuthMode {
  try {
    return resolveConnectInput(alias, {}, env).auth.mode;
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
