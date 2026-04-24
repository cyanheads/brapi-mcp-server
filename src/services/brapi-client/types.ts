/**
 * @fileoverview Shared types for the BrapiClient service — envelope shape,
 * request options, auth config, and search response variants.
 *
 * @module services/brapi-client/types
 */

/** BrAPI v2 standard response envelope. */
export interface BrapiEnvelope<T> {
  metadata: BrapiMetadata;
  result: T;
}

export interface BrapiMetadata {
  datafiles?: unknown[];
  pagination?: BrapiPagination;
  status?: BrapiStatus[];
}

export interface BrapiPagination {
  currentPage: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

export interface BrapiStatus {
  message: string;
  messageType: 'INFO' | 'WARNING' | 'ERROR';
}

/**
 * Configured auth for a BrAPI connection. `sgn` and `oauth2` are resolved to
 * a bearer token before being handed to the client; `api_key` and `none` are
 * used verbatim.
 */
export type BrapiAuth =
  | { mode: 'none' }
  | { mode: 'sgn'; username: string; password: string }
  | { mode: 'oauth2'; clientId: string; clientSecret: string; tokenUrl?: string }
  | { mode: 'api_key'; apiKey: string; headerName?: string }
  | { mode: 'bearer'; token: string };

/** Resolved auth header ready to attach to a request. */
export interface ResolvedAuth {
  /** ISO 8601 timestamp — caller may refresh before this. */
  expiresAt?: string;
  headerName: string;
  headerValue: string;
}

export interface BrapiRequestOptions {
  auth?: ResolvedAuth;
  /** Query params. Arrays are repeated per BrAPI convention. */
  params?: Record<string, string | number | boolean | readonly (string | number)[] | undefined>;
  /** Override the config default timeout. */
  timeoutMs?: number;
}

/**
 * POST /search/{noun} returns either full results inline, or a
 * `searchResultsDbId` that the caller polls via getSearchResults.
 */
export type SearchResponse<T> =
  | { kind: 'sync'; envelope: BrapiEnvelope<T> }
  | { kind: 'async'; searchResultsDbId: string };

/** Raw bytes returned from a binary fetch (e.g. image content). */
export interface BinaryResponse {
  bytes: Uint8Array;
  /** `Content-Type` header as reported by the server; falls back to octet-stream. */
  contentType: string;
}
