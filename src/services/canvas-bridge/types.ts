/**
 * @fileoverview Internal types for the canvas-bridge service. Encodes the
 * provenance metadata persisted alongside an auto-registered dataframe — the
 * canvas itself only knows table names, columns, and row counts; this service
 * tracks the originating tool, baseUrl, and query so `brapi_dataframe_describe`
 * can surface full provenance.
 *
 * @module services/canvas-bridge/types
 */

/**
 * Source-of-truth provenance persisted alongside an auto-registered dataframe.
 * Stored under `brapi/canvas/tablemeta/<tableName>` in `ctx.state` with the
 * same TTL as the originating spillover. The dataframe name (e.g. `df_<uuid>`)
 * is the identity key — there is no separate dataset ID.
 */
export interface CanvasTableMeta {
  /** Originating BrAPI baseUrl. */
  baseUrl: string;
  /** ISO 8601 timestamp the dataframe was created. */
  createdAt: string;
  /** ISO 8601 timestamp the provenance metadata expires. */
  expiresAt: string;
  /** Original filter map / query — provenance for reproducibility. */
  query: unknown;
  /** Originating source tool (e.g. `find_observations`). */
  source: string;
}

/**
 * Describe output augmented with auto-register provenance. `provenance` is
 * absent for user-derived tables (created via `query({ registerAs })`).
 */
export interface DescribedTable {
  approxSizeBytes?: number;
  columns: { name: string; nullable?: boolean; type: string }[];
  name: string;
  /** Provenance, present when this table was auto-registered from a spillover. */
  provenance?: CanvasTableMeta;
  rowCount: number;
}
