/**
 * @fileoverview Built-in known-server registry. Curated list of public BrAPI v2
 * endpoints that ship as default connection aliases — operators can call
 * `brapi_connect({ alias: 'bti-cassava' })` (or any other entry) without setting
 * `BRAPI_<ALIAS>_BASE_URL`. Each entry carries CC-BY attribution metadata so
 * the orientation envelope can surface license + citation alongside the data.
 *
 * Override behavior: env-set `BRAPI_<ALIAS>_BASE_URL` always wins over the
 * builtin URL — the builtin is a fallback, not a lock. Per-alias credentials
 * (`BRAPI_<ALIAS>_USERNAME` / `_PASSWORD` / etc.) layer on top of any selected
 * baseUrl, so write workflows still need a separate registration on each
 * upstream instance.
 *
 * Opt-out: comma-separated alias names in `BRAPI_BUILTIN_ALIASES_DISABLED`
 * remove specific builtins from resolution and discovery (matched
 * case-insensitively).
 *
 * @module config/builtin-aliases
 */

const BREEDBASE_CITATION =
  'Morales et al. 2022. "Breedbase: a digital ecosystem for modern plant breeding." G3 12(7): jkac078. https://doi.org/10.1093/g3journal/jkac078';

export interface BuiltinAlias {
  readonly alias: string;
  readonly baseUrl: string;
  readonly citation: string;
  readonly cropFocus: string;
  readonly homepage: string;
  readonly isDemo?: boolean;
  readonly license: 'CC-BY';
  readonly organizationName: string;
}

/**
 * Frozen registry of known public BrAPI v2 servers. Each entry was verified
 * against the live upstream surface — anonymous reads return real data and
 * the standard `/studies`, `/germplasm`, `/variables` endpoints respond with
 * non-trivial totals. Servers that flipped to an auth wall (musabase,
 * solgenomics) are intentionally absent.
 */
export const BUILTIN_ALIASES: ReadonlyArray<BuiltinAlias> = Object.freeze([
  Object.freeze({
    alias: 'bti-cassava',
    baseUrl: 'https://cassavabase.org/brapi/v2',
    homepage: 'https://cassavabase.org/',
    organizationName: 'Boyce Thompson Institute',
    cropFocus: 'Cassava',
    license: 'CC-BY',
    citation: BREEDBASE_CITATION,
  }),
  Object.freeze({
    alias: 'bti-sweetpotato',
    baseUrl: 'https://sweetpotatobase.org/brapi/v2',
    homepage: 'https://sweetpotatobase.org/',
    organizationName: 'Boyce Thompson Institute',
    cropFocus: 'SweetPotato',
    license: 'CC-BY',
    citation: BREEDBASE_CITATION,
  }),
  Object.freeze({
    alias: 't3-wheat',
    baseUrl: 'https://wheat.triticeaetoolbox.org/brapi/v2',
    homepage: 'https://wheat.triticeaetoolbox.org/',
    organizationName: 'Triticeae Toolbox (T3)',
    cropFocus: 'Wheat',
    license: 'CC-BY',
    citation: BREEDBASE_CITATION,
  }),
  Object.freeze({
    alias: 't3-oat',
    baseUrl: 'https://oat.triticeaetoolbox.org/brapi/v2',
    homepage: 'https://oat.triticeaetoolbox.org/',
    organizationName: 'Triticeae Toolbox (T3)',
    cropFocus: 'Oat',
    license: 'CC-BY',
    citation: BREEDBASE_CITATION,
  }),
  Object.freeze({
    alias: 't3-barley',
    baseUrl: 'https://barley.triticeaetoolbox.org/brapi/v2',
    homepage: 'https://barley.triticeaetoolbox.org/',
    organizationName: 'Triticeae Toolbox (T3)',
    cropFocus: 'Barley',
    license: 'CC-BY',
    citation: BREEDBASE_CITATION,
  }),
  Object.freeze({
    alias: 'bti-breedbase-demo',
    baseUrl: 'https://breedbase.org/brapi/v2',
    homepage: 'https://breedbase.org/',
    organizationName: 'Boyce Thompson Institute',
    cropFocus: 'Demo (sample data)',
    license: 'CC-BY',
    citation: BREEDBASE_CITATION,
    isDemo: true,
  }),
]);

const DISABLED_ENV_VAR = 'BRAPI_BUILTIN_ALIASES_DISABLED';

/**
 * Parse the comma-separated disabled list from env. Whitespace tolerant,
 * case-insensitive — entries are lowercased to match alias keys.
 */
function readDisabledSet(env: NodeJS.ProcessEnv): Set<string> {
  const raw = env[DISABLED_ENV_VAR];
  if (!raw) return new Set();
  const out = new Set<string>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim().toLowerCase();
    if (trimmed) out.add(trimmed);
  }
  return out;
}

/**
 * Resolve a builtin entry by alias. Case-insensitive lookup; respects the
 * `BRAPI_BUILTIN_ALIASES_DISABLED` opt-out list. Returns `undefined` when the
 * alias is unknown or disabled — callers fall through to the next baseUrl
 * source (default env, then a thrown ValidationError).
 */
export function findBuiltinAlias(
  alias: string,
  env: NodeJS.ProcessEnv = process.env,
): BuiltinAlias | undefined {
  const key = alias.toLowerCase();
  const disabled = readDisabledSet(env);
  if (disabled.has(key)) return;
  return BUILTIN_ALIASES.find((entry) => entry.alias === key);
}

/**
 * Active builtins — the registry minus any aliases listed in
 * `BRAPI_BUILTIN_ALIASES_DISABLED`. Used by alias discovery so the connect
 * tool description can advertise what's available out-of-the-box.
 */
export function listBuiltinAliases(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyArray<BuiltinAlias> {
  const disabled = readDisabledSet(env);
  if (disabled.size === 0) return BUILTIN_ALIASES;
  return BUILTIN_ALIASES.filter((entry) => !disabled.has(entry.alias));
}
