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
  /** Compatibility notes surfaced in brapi_connect / brapi_server_info. */
  notes?: readonly string[];
  /**
   * Per-endpoint mapping from the v2.1 plural filter key to the singular form
   * the server honors. Keyed by bare resource segment (`studies`, no slash).
   * Endpoints not listed pass through with no translation.
   */
  pluralToSingular: Readonly<Record<string, Readonly<Record<string, string>>>>;
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
  const adaptGetFilters = (
    endpoint: string,
    filters: Readonly<Record<string, unknown>>,
  ): DialectAdaptation => {
    const mapping = config.pluralToSingular[endpoint] ?? {};
    const droppedSet = config.droppedFilters?.[endpoint] ?? EMPTY_DROP_SET;
    const out: Record<string, unknown> = {};
    const warnings: string[] = [];
    const dropped: string[] = [];

    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined) continue;
      if (droppedSet.has(key)) {
        dropped.push(key);
        warnings.push(
          `${config.label} dialect: dropped filter '${key}' — this server does not honor it. Adjust the query or omit the filter.`,
        );
        continue;
      }
      const target = mapping[key];
      if (!target) {
        out[key] = value;
        continue;
      }
      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        out[target] = value[0];
        if (value.length > 1) {
          warnings.push(
            `${config.label} dialect: '${key}' downcast to '${target}'; only the first value (${JSON.stringify(value[0])}) was sent — this server's GET /${endpoint} accepts a single value per filter, not arrays. Run separate calls for the other values, or use a curated tool that paginates over them.`,
          );
        }
      } else {
        out[target] = value;
      }
    }

    return { filters: out, dropped, warnings };
  };

  return {
    id: config.id,
    adaptGetFilters,
    ...(config.disabledSearchEndpoints !== undefined && {
      disabledSearchEndpoints: config.disabledSearchEndpoints,
    }),
    ...(config.notes !== undefined && { notes: config.notes }),
  };
}
