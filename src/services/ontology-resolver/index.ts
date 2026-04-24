/**
 * @fileoverview Public API barrel for the OntologyResolver service.
 *
 * @module services/ontology-resolver
 */

export {
  getOntologyResolver,
  initOntologyResolver,
  OntologyResolver,
  resetOntologyResolver,
  type VariableLike,
} from './ontology-resolver.js';
export type { OntologyCandidate, ResolveOptions } from './types.js';
