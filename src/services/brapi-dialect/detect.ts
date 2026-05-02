/**
 * @fileoverview Dialect detection — picks a dialect id for a connection from
 * the cached `CapabilityProfile` (server name / organization) plus an env
 * override (`BRAPI_<ALIAS>_DIALECT`). Pure functions; the async lookup that
 * pulls the profile lives in `index.ts → resolveDialect`.
 *
 * Supported override values match registered dialect ids: `spec`,
 * `brapi-test`, `breedbase`, `cassavabase`.
 * `auto` (or unset) triggers detection from the profile.
 *
 * @module services/brapi-dialect/detect
 */

import type { CapabilityProfile } from '@/services/capability-registry/types.js';

const ENV_PREFIX = 'BRAPI_';
const ENV_SUFFIX = '_DIALECT';
const CASSAVABASE_HOSTS = ['cassavabase.org'] as const;
const BREEDBASE_HOSTS = [
  'sweetpotatobase.org',
  'yambase.org',
  'musabase.org',
  'bananabase.org',
] as const;

/**
 * Where the resolved dialect id came from. Surfaced in the orientation
 * envelope so agents (and operators reading logs) can tell whether the
 * dialect was pinned, inferred from `/serverinfo`, or fell through to the
 * spec passthrough.
 *
 * - `env-override` — the operator pinned `BRAPI_<ALIAS>_DIALECT`.
 * - `url-pattern` — matched on the registered base URL host.
 * - `server-name` — matched on `serverInfo.serverName`.
 * - `organization-name` — matched on `serverInfo.organizationName` (used when
 *   the server name is generic but the host is a known SGN deployment).
 * - `fallback` — nothing matched; defaulted to the `spec` passthrough.
 */
export type DialectDetectionSource =
  | 'env-override'
  | 'url-pattern'
  | 'server-name'
  | 'organization-name'
  | 'fallback';

export interface DialectDetection {
  id: string;
  source: DialectDetectionSource;
}

/** Compute the env-var name for an alias. `my-server` → `BRAPI_MY_SERVER_DIALECT`. */
export function dialectEnvVar(alias: string): string {
  return `${ENV_PREFIX}${alias.replace(/-/g, '_').toUpperCase()}${ENV_SUFFIX}`;
}

/**
 * Read the per-alias dialect override. Returns `undefined` when unset, empty,
 * or `auto` (case-insensitive) — those all defer to detection.
 */
export function readDialectOverride(
  alias: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env[dialectEnvVar(alias)]?.trim();
  if (!raw) return;
  if (raw.toLowerCase() === 'auto') return;
  return raw;
}

/**
 * Pattern-match a server name (or organization name) to a registered dialect
 * id. Falls back to `spec` when nothing matches. Match is case-insensitive
 * and substring-based — `CassavaBase` keeps its historical `cassavabase`
 * dialect id, while sister SGN / Breedbase deployments resolve to the broader
 * `breedbase` dialect.
 *
 * Returns both the matched id and which field triggered the match so callers
 * can surface that provenance to the agent.
 */
export function detectDialectFromName(
  name: string | undefined,
  organizationName?: string | undefined,
): DialectDetection {
  const lowerName = (name ?? '').toLowerCase();
  const lowerOrg = (organizationName ?? '').toLowerCase();
  if (!lowerName.trim() && !lowerOrg.trim()) return { id: 'spec', source: 'fallback' };
  const isCassavaBase = (haystack: string) => haystack.includes('cassavabase');
  const isBreedbaseHost = (haystack: string) =>
    haystack.includes('sweetpotatobase') ||
    haystack.includes('yambase') ||
    haystack.includes('musabase') ||
    haystack.includes('bananabase') ||
    haystack.includes('breedbase') ||
    haystack.includes('sol genomics') ||
    haystack.includes('solgenomics') ||
    // Catches "BTI" / "Boyce Thompson Institute" hosts running the same SGN stack.
    haystack.includes('boyce thompson');
  const isBrapiTestHost = (haystack: string) =>
    haystack.includes('brapi test') || haystack.includes('community test server');
  if (isCassavaBase(lowerName)) return { id: 'cassavabase', source: 'server-name' };
  if (isCassavaBase(lowerOrg)) return { id: 'cassavabase', source: 'organization-name' };
  if (isBreedbaseHost(lowerName)) return { id: 'breedbase', source: 'server-name' };
  if (isBreedbaseHost(lowerOrg)) return { id: 'breedbase', source: 'organization-name' };
  if (isBrapiTestHost(lowerName)) return { id: 'brapi-test', source: 'server-name' };
  if (isBrapiTestHost(lowerOrg)) return { id: 'brapi-test', source: 'organization-name' };
  return { id: 'spec', source: 'fallback' };
}

/**
 * Pattern-match a registered base URL to a dialect. This catches SGN-family
 * deployments with generic or sparse `/serverinfo` identity fields.
 */
export function detectDialectFromBaseUrl(baseUrl: string | undefined): DialectDetection {
  if (!baseUrl) return { id: 'spec', source: 'fallback' };
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return { id: 'spec', source: 'fallback' };
  }

  if (hostMatches(host, CASSAVABASE_HOSTS)) return { id: 'cassavabase', source: 'url-pattern' };
  if (hostMatches(host, BREEDBASE_HOSTS)) return { id: 'breedbase', source: 'url-pattern' };
  if (host === 'test-server.brapi.org') return { id: 'brapi-test', source: 'url-pattern' };
  return { id: 'spec', source: 'fallback' };
}

function hostMatches(host: string, domains: readonly string[]): boolean {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * End-to-end detection: env override beats profile inference. Returns the
 * resolved dialect id and the source that produced it. Callers that only
 * need the id can read `.id`; the orientation envelope reads both.
 */
export function detectDialectId(
  alias: string,
  profile: CapabilityProfile | undefined,
  env: NodeJS.ProcessEnv = process.env,
): DialectDetection {
  const override = readDialectOverride(alias, env);
  if (override) return { id: override, source: 'env-override' };
  const fromUrl = detectDialectFromBaseUrl(profile?.baseUrl);
  if (fromUrl.source !== 'fallback') return fromUrl;
  return detectDialectFromName(profile?.server.name, profile?.server.organizationName);
}
