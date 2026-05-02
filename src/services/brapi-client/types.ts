/**
 * @fileoverview Shared types for the BrapiClient service — envelope shape,
 * request options, auth config, and search response variants.
 *
 * @module services/brapi-client/types
 */

import type { BrapiDialect } from '@/services/brapi-dialect/types.js';

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
  /**
   * Per-server dialect. When supplied, `BrapiClient.get` extracts the endpoint
   * segment from `path` and routes `params` through `dialect.adaptGetFilters`
   * before serializing — so plural-vs-singular mismatches and silently-dropped
   * filters are handled uniformly at the client edge instead of at every call
   * site. Omit on intentional passthrough paths (`raw_get`).
   */
  dialect?: BrapiDialect;
  /** Query params. Arrays are repeated per BrAPI convention. */
  params?: Record<string, string | number | boolean | readonly (string | number)[] | undefined>;
  /**
   * Override the global retry budget for this single call. Use `0` for
   * companion enrichments where retries compound latency without producing a
   * different outcome. Falls back to `BRAPI_RETRY_MAX_ATTEMPTS` when omitted.
   */
  retryMaxAttempts?: number;
  /** Override the config default timeout. */
  timeoutMs?: number;
  /**
   * Sink for dialect translation warnings. When `dialect` is supplied, any
   * adapter warnings (downcast, dropped) are appended here verbatim. Allows
   * call sites to thread companion warnings into the same `warnings[]` array
   * the tool surfaces in its envelope.
   */
  warnings?: string[];
}

/** Stable error code surfaced by BrapiClient when the dialect adapter dropped every supplied filter. */
export const DIALECT_ALL_DROPPED_REASON = 'dialect_all_filters_dropped' as const;

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
