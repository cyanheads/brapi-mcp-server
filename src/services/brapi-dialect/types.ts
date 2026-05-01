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
 * filters dropped because the server doesn't honor them, etc.).
 */
export interface DialectAdaptation {
  filters: Record<string, unknown>;
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
   * Human-readable compatibility notes surfaced in brapi_connect /
   * brapi_server_info. Use this for verified quirks that are handled outside
   * `adaptGetFilters` (for example coordinate-axis recovery).
   */
  readonly notes?: readonly string[];
}
