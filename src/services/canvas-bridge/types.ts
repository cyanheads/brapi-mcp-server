/**
 * @fileoverview Internal types for the canvas-bridge service. Encodes the
 * mapping between BrAPI dataset metadata and canvas-side table provenance —
 * the canvas itself only knows table names, columns, and row counts; this
 * service tracks the originating dataset (source tool, baseUrl, query) so
 * `brapi_dataframe_describe` can surface full provenance.
 *
 * @module services/canvas-bridge/types
 */

/**
 * Source-of-truth metadata persisted alongside an auto-registered canvas
 * table. Mirrors `DatasetMetadata` for the fields the agent cares about,
 * trimmed to what's actually useful in canvas describe output.
 */
export interface CanvasTableMeta {
  /** Originating BrAPI baseUrl. */
  baseUrl: string;
  /** ISO 8601 timestamp the dataset was created. */
  createdAt: string;
  /** Originating dataset ID (UUID from DatasetStore). */
  datasetId: string;
  /** ISO 8601 timestamp the dataset will expire from DatasetStore. */
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
  /** Provenance, present when this table was auto-registered from a dataset. */
  provenance?: CanvasTableMeta;
  rowCount: number;
}
