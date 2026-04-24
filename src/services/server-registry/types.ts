/**
 * @fileoverview Types for ServerRegistry — session-scoped connection aliases.
 * A `RegisteredServer` holds everything tools need to route a request: the
 * base URL, the resolved auth header, and the declared auth mode (so tools
 * can surface meaningful re-auth guidance).
 *
 * @module services/server-registry/types
 */

import type { ResolvedAuth } from '@/services/brapi-client/index.js';

export type AuthMode = 'none' | 'sgn' | 'oauth2' | 'api_key' | 'bearer';

export interface RegisteredServer {
  alias: string;
  authMode: AuthMode;
  baseUrl: string;
  registeredAt: string;
  /** Resolved header to attach to outbound requests. Omitted for `none`. */
  resolvedAuth?: ResolvedAuth;
}

/**
 * Input accepted by `ServerRegistry.register`. Discriminated by `mode`.
 * Optional fields allow `undefined` explicitly so Zod-parsed values (which
 * carry optional-as-undefined) assign cleanly under `exactOptionalPropertyTypes`.
 */
export type ConnectAuth =
  | { mode: 'none' }
  | { mode: 'sgn'; username: string; password: string }
  | {
      mode: 'oauth2';
      clientId: string;
      clientSecret: string;
      tokenUrl?: string | undefined;
    }
  | { mode: 'api_key'; apiKey: string; headerName?: string | undefined }
  | { mode: 'bearer'; token: string };
