/**
 * @fileoverview Dataset lifecycle types — provenance, metadata, paginated
 * load responses. All JSON-serializable so they round-trip through `ctx.state`.
 *
 * @module services/dataset-store/types
 */

export interface CreateDatasetInput {
  /** BrAPI base URL the dataset was pulled from. */
  baseUrl: string;
  /** Optional column list; inferred from the first row when omitted. */
  columns?: string[];
  /** Cap the producer applied — number of rows that would have been pulled without truncation. Omit when no cap was applied. */
  maxRows?: number;
  /** Full query params / filter map — required for reproducibility. */
  query: unknown;
  /** Row payload. */
  rows: Record<string, unknown>[];
  /** Original tool / operation that produced the dataset (e.g. 'find_studies'). */
  source: string;
  /** True when the producer hit a cap before exhausting the upstream result set. */
  truncated?: boolean;
}

export interface DatasetMetadata {
  baseUrl: string;
  columns: string[];
  /** ISO 8601 create timestamp. */
  createdAt: string;
  datasetId: string;
  /** ISO 8601 expiry — when the TTL will evict the dataset. */
  expiresAt: string;
  /** Cap that was applied at create time. Omitted when none. */
  maxRows?: number;
  query: unknown;
  rowCount: number;
  /** Serialized payload size in bytes (UTF-8 JSON). */
  sizeBytes: number;
  source: string;
  /** True when the dataset rows were capped before exhausting upstream. */
  truncated?: boolean;
}

export interface DatasetLoadOptions {
  /** Subset of columns to return. Omitted → all columns. */
  columns?: string[];
  /** 1-indexed page number. Default 1. */
  page?: number;
  /** Rows per page. Default 100, max 1000. */
  pageSize?: number;
}

export interface DatasetPage {
  datasetId: string;
  page: number;
  pageSize: number;
  rows: Record<string, unknown>[];
  totalPages: number;
  totalRows: number;
}

export interface DatasetListOptions {
  cursor?: string;
  limit?: number;
}

export interface DatasetListPage {
  cursor?: string;
  datasets: DatasetMetadata[];
}
