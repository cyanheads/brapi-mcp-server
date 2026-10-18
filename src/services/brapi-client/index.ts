/**
 * @fileoverview Public API barrel for the BrapiClient service.
 *
 * @module services/brapi-client
 */

export type { Fetcher } from './brapi-client.js';
export {
  BrapiClient,
  getBrapiClient,
  initBrapiClient,
  isDialectAllDropped,
  isPrivateAddressBlocked,
  resetBrapiClient,
} from './brapi-client.js';
export {
  CALL_DEADLINE_MS,
  CALL_DEADLINE_REASON,
  callDeadlineAt,
  callDeadlineExceeded,
  UPSTREAM_TIMEOUT_HINT,
} from './call-deadline.js';
export type {
  BinaryResponse,
  BrapiAuth,
  BrapiEnvelope,
  BrapiMetadata,
  BrapiPagination,
  BrapiRequestOptions,
  BrapiStatus,
  ResolvedAuth,
  SearchResponse,
} from './types.js';
export { DIALECT_ALL_DROPPED_REASON, PRIVATE_ADDRESS_BLOCKED_REASON } from './types.js';
