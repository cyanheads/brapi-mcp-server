/**
 * @fileoverview Types for the capability profile pulled from a BrAPI server
 * on connect — what calls it supports, which crops it covers, and any
 * notable quirks that affect downstream tooling.
 *
 * @module services/capability-registry/types
 */

/**
 * One entry in the BrAPI `/calls` response — declares a supported endpoint
 * with the HTTP methods, data types, and spec versions the server honors.
 */
export interface CallDescriptor {
  dataTypes?: string[];
  methods?: ('GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH')[];
  service: string;
  versions?: string[];
}

/** Raw shape of `GET /serverinfo`. Fields vary wildly across implementations. */
export interface ServerInfoPayload {
  calls?: CallDescriptor[];
  contactEmail?: string;
  documentationURL?: string;
  location?: string;
  organizationName?: string;
  organizationURL?: string;
  serverDescription?: string;
  serverName?: string;
}

/**
 * Normalized server-identity fields extracted from `/serverinfo`. Every field
 * is optional — BrAPI servers in the wild vary in what they populate.
 */
export interface ServerIdentity {
  /** Highest BrAPI version reported across any call (e.g. "2.1"). */
  brapiVersion?: string;
  contactEmail?: string;
  description?: string;
  documentationURL?: string;
  name?: string;
  organizationName?: string;
  organizationURL?: string;
}

/**
 * Capability profile for one connected BrAPI server, cached per-connection.
 * Shape is fully JSON-serializable so it can live in `ctx.state`.
 */
export interface CapabilityProfile {
  baseUrl: string;
  crops: string[];
  /** ISO 8601 timestamp of when this profile was fetched. */
  fetchedAt: string;
  server: ServerIdentity;
  /**
   * Map of canonical service name → descriptor. The service name is the path
   * segment (e.g. "studies", "search/observations") per BrAPI convention.
   */
  supported: Record<string, CallDescriptor>;
}

/**
 * Loose probe of a single endpoint. Most handlers only care whether the
 * endpoint is supported at all and optionally for a specific HTTP method.
 */
export interface EndpointProbe {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  service: string;
}
