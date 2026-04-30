/**
 * @fileoverview Types for OntologyResolver — resolved ontology-URI candidates
 * with score and source attribution.
 *
 * @module services/ontology-resolver/types
 */

/**
 * One candidate match returned by `OntologyResolver.resolve`. `source`
 * reports how the match was produced so downstream tooling can surface the
 * degradation path to users (e.g. "substring match — server has no /ontologies").
 */
export interface OntologyCandidate {
  /** Short definition or description, when available. */
  description?: string;
  /** Display name of the trait/variable/term. */
  name?: string;
  /**
   * Server-side variable DbId of the row this candidate was scored from.
   * Always populated when the source variable carries one; used by callers
   * to map candidates back to rows (PUI is too sparse on real servers).
   */
  observationVariableDbId?: string;
  /** Originating ontology (e.g. "CO_334"). */
  ontologyDbId?: string;
  /**
   * How the candidate was surfaced:
   *  - `puiMatch`  — exact match on `observationVariablePUIs`
   *  - `nameMatch` — substring match on `observationVariableNames`
   *  - `synonymMatch` — match on a registered synonym
   *  - `traitClassMatch` — match via trait class
   */
  source: 'puiMatch' | 'nameMatch' | 'synonymMatch' | 'traitClassMatch';
  /** Synonyms registered for this term. */
  synonyms?: string[];
  /** Persistent ontology URI or term ID (e.g. "CO_334:0000013"). */
  termId?: string;
}

export interface ResolveOptions {
  /** Max candidates to return. Default 10. */
  limit?: number;
  /** Optional ontology scope (e.g. "CO_334"). */
  ontologyDbId?: string;
}
