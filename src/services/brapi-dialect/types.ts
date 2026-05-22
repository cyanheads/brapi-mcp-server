/**
 * @fileoverview Types for BrAPI dialects — per-server adapters that translate
 * spec-shape filters / payloads into whatever the upstream actually honors.
 * BrAPI v2.1 normalized filter names to plural forms, but real implementations
 * lag the spec by years. CassavaBase, BMS, GERMINATE, T3 each have their own
 * quirks. The dialect interface is the single seam through which we adapt
 * outbound traffic to those servers without bleeding the special cases into
 * tool definitions.
 *
 * Start with one capability — `adaptGetFilters` — and add optional methods
 * (`adaptSearchBody`, `normalizeRow`, etc.) as new quirk classes surface. Any
 * method beyond the required core is optional so new dialects don't have to
 * implement quirks they don't have.
 *
 * @module services/brapi-dialect/types
 */

/**
 * Result of adapting a filter map for a specific endpoint. `filters` is the
 * wire-shape map (what gets serialized into the URL); `warnings` are
 * operator-facing notes about lossy conversions (multi-value array downcast,
 * filters dropped because the server doesn't honor them, etc.). `dropped` is
 * the structured list of input keys that were removed entirely so callers can
 * detect "agent intended to scope, dialect couldn't honor it" without parsing
 * warning strings.
 */
export interface DialectAdaptation {
  /**
   * Input filter keys the dialect dropped entirely (server doesn't honor them
   * in any form). Each dropped key also produces a human-readable entry in
   * `warnings`. Empty when nothing was dropped.
   */
  dropped: readonly string[];
  filters: Record<string, unknown>;
  /**
   * True when at least one multi-value array filter was downcast to a single
   * scalar (because the active GET dialect only honors single values per
   * filter). The caller can use this signal to prefer POST `/search/{noun}`
   * when the upstream advertises a working search route — the search body
   * preserves the original multi-value semantics that the GET wire shape
   * would have lost. Absent (or false) when no downcast occurred.
   */
  requiresEscalation?: boolean;
  warnings: string[];
}

/**
 * Per-server filter / payload adapter. Implementations are stateless,
 * registered by id, and selected per-connection via `resolveDialect`. The
 * `id` should be a short, stable token (e.g. `spec`, `cassavabase`). Dialects
 * registered later override earlier ones with the same id.
 */
export interface BrapiDialect {
  /**
   * Adapt a merged filter map for a GET list endpoint. `endpoint` is the bare
   * resource segment (e.g. `studies`, `germplasm`) — not the path. Filters
   * are passed as a read-only record; implementations must return a fresh
   * object rather than mutating the input.
   *
   * The default `spec` dialect returns the input untouched. Server-specific
   * dialects translate, drop, or downcast filters so the upstream receives
   * names and shapes it actually honors.
   */
  adaptGetFilters(endpoint: string, filters: Readonly<Record<string, unknown>>): DialectAdaptation;
  /**
   * POST `/search/{noun}` routes the dialect knows are dead — advertised in
   * `/calls` but in practice unresponsive, broken, or returning malformed
   * envelopes. Tools that would otherwise issue an async-search call should
   * consult this set first and route around (or fail loudly with a recovery
   * hint) rather than hanging or returning garbage. Nouns are bare resource
   * segments (e.g. `germplasm`, `studies`), not full paths.
   *
   * Omit on dialects with no known dead routes (the default `spec` dialect).
   */
  readonly disabledSearchEndpoints?: ReadonlySet<string>;
  readonly id: string;
  /**
   * Aggregate confidence breakdown for the dialect's filter-translation
   * table. `verified` entries were empirically narrowed against a live server
   * during dialect bring-up; `inferred` entries follow the v2.0/v2.1 naming
   * pattern but haven't been independently checked. Surfaced on the
   * orientation envelope so agents can see the dialect's confidence floor at
   * a glance.
   *
   * Omitted on dialects with no translation table (the default `spec`
   * dialect, custom dialects that override `adaptGetFilters` directly).
   */
  readonly mappingSummary?: {
    inferred: number;
    verified: number;
  };
  /**
   * Coerce one upstream row into a canonical shape before schema validation.
   * Implementations strip server-specific encodings of "missing" — e.g.
   * CassavaBase returns `null` for many optional fields where the BrAPI v2.1
   * spec says the field should be omitted entirely. Returning a fresh object
   * with the null keys dropped lets the row schemas express the natural
   * "field is absent" via `optional()` without every schema absorbing a
   * `.nullish()` per field.
   *
   * Implementations must not mutate the input. The default `spec` dialect
   * omits this method (passthrough).
   */
  readonly normalizeRow?: (
    endpoint: string,
    row: Record<string, unknown>,
  ) => Record<string, unknown>;
  /**
   * Human-readable compatibility notes surfaced in brapi_connect /
   * brapi_server_info. Use this for verified quirks that are handled outside
   * `adaptGetFilters` (for example coordinate-axis recovery).
   */
  readonly notes?: readonly string[];
}
