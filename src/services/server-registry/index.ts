/**
 * @fileoverview Public API barrel for the ServerRegistry service.
 *
 * @module services/server-registry
 */

export type { RegisterInput, TokenFetcher } from './server-registry.js';
export {
  DEFAULT_ALIAS,
  getServerRegistry,
  initServerRegistry,
  resetServerRegistry,
  ServerRegistry,
} from './server-registry.js';
export type { AuthMode, ConnectAuth, RegisteredServer } from './types.js';
