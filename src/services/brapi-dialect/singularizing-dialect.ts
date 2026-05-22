/**
 * @fileoverview Generic factory for dialects that translate BrAPI v2.1 plural
 * filter keys (`studyDbIds`, `germplasmDbIds`, …) to the v2.0 singular forms
 * the upstream actually honors. Used by both the SGN/Breedbase family
 * (`cassavabase-dialect`) and the BrAPI Community Test Server
 * (`brapi-test-dialect`) — the two share an identical translation engine but
 * carry different per-endpoint mappings, drop lists, and search-route flags,
 * so the data lives in each dialect module while the engine lives here.
 *
 * @module services/brapi-dialect/singularizing-dialect
 */

import type { BrapiDialect, DialectAdaptation } from './types.js';

/**
 * One entry in the plural→singular translation table. Carries the target
 * filter name plus a `verified` flag that's `true` when the mapping was
 * empirically narrowed against a live server, `false` when it's inferred from
 * the v2.0/v2.1 naming pattern but hasn't been independently checked.
 *
 * The flag drives two things: the warning the dialect emits on downcast
 * (softer wording for inferred mappings, since the mapping might also be
 * wrong); and the verified-mapping summary on the orientation envelope so
 * agents can see the dialect's confidence floor without inspecting source.
 */
export interface DialectFilterMapping {
  target: string;
  verified: boolean;
}

/** Compact shorthand: `'singular'` expands to `{ target: 'singular', verified: false }`. */
export type DialectFilterMappingInput = string | DialectFilterMapping;

export interface SingularizingDialectConfig {
  /**
   * POST `/search/{noun}` routes the dialect knows are dead — advertised in
   * `/calls` but unresponsive in practice. Forwarded onto `BrapiDialect`
   * verbatim. Omit when search routes work normally.
   */
  disabledSearchEndpoints?: ReadonlySet<string>;
  /**
   * Per-endpoint set of filter keys to drop entirely — the server silently
   * ignores them in both plural and singular form. Drops surface a warning so
   * the agent stops trusting the response as if the filter were honored.
   */
  droppedFilters?: Readonly<Record<string, ReadonlySet<string>>>;
  /** Stable dialect id surfaced in logs and the orientation envelope. */
  id: string;
  /** Human-readable label used in warning text (e.g. `CassavaBase`). */
  label: string;
  /**
   * Optional row-normalizer. Receives the endpoint segment and one upstream
   * row pre-schema. Forwarded onto `BrapiDialect.normalizeRow` verbatim — see
   * that interface for semantics. Omit on dialects with no shape quirks.
   */
  normalizeRow?: (endpoint: string, row: Record<string, unknown>) => Record<string, unknown>;
  /** Compatibility notes surfaced in brapi_connect / brapi_server_info. */
  notes?: readonly string[];
  /**
   * Per-endpoint mapping from the v2.1 plural filter key to its singular form.
   * Keyed by bare resource segment (`studies`, no slash). Values may be a
   * bare string (treated as `{target, verified: false}`) or an explicit
   * `DialectFilterMapping` so authors can mark live-verified mappings
   * distinctly from inferred ones. Endpoints not listed pass through with no
   * translation.
   */
  pluralToSingular: Readonly<Record<string, Readonly<Record<string, DialectFilterMappingInput>>>>;
}

const EMPTY_DROP_SET: ReadonlySet<string> = new Set();

/**
 * Build a `BrapiDialect` whose `adaptGetFilters` translates plural v2.1 filter
 * names to the configured singulars, drops blacklisted keys, and downcasts
 * multi-value arrays to the first element with a loud warning (the v2.0 GET
 * surface can't express multi-value filters; the agent should re-call per
 * value or use a curated tool that paginates).
 */
export function createSingularizingDialect(config: SingularizingDialectConfig): BrapiDialect {
  const normalizedMappings = normalizeMappings(config.pluralToSingular);

  const adaptGetFilters = (
    endpoint: string,
    filters: Readonly<Record<string, unknown>>,
  ): DialectAdaptation => {
    const mapping = normalizedMappings[endpoint] ?? {};
    const droppedSet = config.droppedFilters?.[endpoint] ?? EMPTY_DROP_SET;
    const out: Record<string, unknown> = {};
    const warnings: string[] = [];
    const dropped: string[] = [];
    let requiresEscalation = false;

    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined) continue;
      if (droppedSet.has(key)) {
        dropped.push(key);
        warnings.push(
          `${config.label} dialect: dropped filter '${key}' — this server does not honor it. Adjust the query or omit the filter.`,
        );
        continue;
      }
      const entry = mapping[key];
      if (!entry) {
        out[key] = value;
        continue;
      }
      const target = entry.target;
      const verifiedSuffix = entry.verified
        ? ''
        : ` (mapping inferred — narrowing not verified against this server; check the result distributions)`;
      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        out[target] = value[0];
        if (value.length > 1) {
          requiresEscalation = true;
          warnings.push(
            `${config.label} dialect: '${key}' downcast to '${target}'; only the first value (${JSON.stringify(value[0])}) was sent — this server's GET /${endpoint} accepts a single value per filter, not arrays. Run separate calls for the other values, or use a curated tool that paginates over them.${verifiedSuffix}`,
          );
        }
      } else {
        out[target] = value;
      }
    }

    const adaptation: DialectAdaptation = { filters: out, dropped, warnings };
    if (requiresEscalation) adaptation.requiresEscalation = true;
    return adaptation;
  };

  const mappingSummary = summarizeMappings(config.pluralToSingular);

  return {
    id: config.id,
    adaptGetFilters,
    mappingSummary,
    ...(config.disabledSearchEndpoints !== undefined && {
      disabledSearchEndpoints: config.disabledSearchEndpoints,
    }),
    ...(config.notes !== undefined && { notes: config.notes }),
    ...(config.normalizeRow !== undefined && { normalizeRow: config.normalizeRow }),
  };
}

/**
 * Coerce the mapping table from author-friendly mixed shape (string shorthand
 * or `{target, verified}`) into the canonical `DialectFilterMapping` shape
 * the adapter loop uses. Done once at construction so the hot path stays
 * branch-light.
 */
function normalizeMappings(
  raw: Readonly<Record<string, Readonly<Record<string, DialectFilterMappingInput>>>>,
): Record<string, Record<string, DialectFilterMapping>> {
  const out: Record<string, Record<string, DialectFilterMapping>> = {};
  for (const [endpoint, mapping] of Object.entries(raw)) {
    const endpointOut: Record<string, DialectFilterMapping> = {};
    for (const [key, entry] of Object.entries(mapping)) {
      endpointOut[key] =
        typeof entry === 'string' ? { target: entry, verified: false } : { ...entry };
    }
    out[endpoint] = endpointOut;
  }
  return out;
}

/**
 * Summarize the verified-vs-inferred breakdown across this dialect's full
 * mapping table. Surfaced on the orientation envelope so agents can see the
 * dialect's confidence floor without inspecting source. Counts each
 * (endpoint, plural-key) pair as one mapping. Returns `{verified: 0,
 * inferred: 0}` for dialects without `pluralToSingular` data (spec, …).
 */
function summarizeMappings(
  raw: Readonly<Record<string, Readonly<Record<string, DialectFilterMappingInput>>>>,
): { verified: number; inferred: number } {
  let verified = 0;
  let inferred = 0;
  for (const endpointMap of Object.values(raw)) {
    for (const entry of Object.values(endpointMap)) {
      const isVerified = typeof entry === 'object' && entry.verified;
      if (isVerified) verified++;
      else inferred++;
    }
  }
  return { verified, inferred };
}
