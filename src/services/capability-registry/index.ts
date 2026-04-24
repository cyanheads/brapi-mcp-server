/**
 * @fileoverview Public API barrel for the CapabilityRegistry service.
 *
 * @module services/capability-registry
 */

export type { CapabilityLookupOptions } from './capability-registry.js';
export {
  CapabilityRegistry,
  getCapabilityRegistry,
  initCapabilityRegistry,
  resetCapabilityRegistry,
} from './capability-registry.js';
export type {
  CallDescriptor,
  CapabilityProfile,
  EndpointProbe,
  ServerIdentity,
  ServerInfoPayload,
} from './types.js';
