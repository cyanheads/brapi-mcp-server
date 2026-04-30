/**
 * @fileoverview Free-text → ontology-term matcher for observation variables.
 * The default backend scores each variable record against the query using
 * substring + synonym matching; no network I/O of its own (variable lists
 * are fetched upstream by the caller). Designed to be swappable — embedding-
 * backed implementations can replace this one without changing the tool
 * surface.
 *
 * @module services/ontology-resolver/ontology-resolver
 */

import type { OntologyCandidate, ResolveOptions } from './types.js';

/**
 * Loose shape of a BrAPI observation-variable record. Every field is
 * optional because server implementations vary in what they populate.
 * Trait subobject fields follow BrAPI v2.1 naming (`traitName`,
 * `traitDescription`); both legacy `name` / `description` aliases are
 * accepted for older or non-conformant servers.
 */
export interface VariableLike {
  method?: { methodName?: string };
  observationVariableDbId?: string;
  observationVariableName?: string;
  observationVariablePUI?: string;
  ontologyDbId?: string;
  ontologyName?: string;
  scale?: { scaleName?: string };
  synonyms?: string[] | undefined;
  trait?: {
    traitClass?: string;
    /** Legacy alias for `traitDescription` — accepted for older servers. */
    description?: string;
    /** Legacy alias for `traitName` — accepted for older servers. */
    name?: string;
    synonyms?: string[];
    traitDescription?: string;
    traitName?: string;
  };
}

export class OntologyResolver {
  /**
   * Rank a pool of variables against a free-text query. Returns up to
   * `limit` candidates sorted by match quality (exact PUI > name match >
   * synonym match). When the query is empty, returns the pool unchanged
   * (up to the limit).
   */
  match(
    query: string,
    variables: readonly VariableLike[],
    options: ResolveOptions = {},
  ): OntologyCandidate[] {
    const limit = options.limit ?? 10;
    const normalized = query.trim().toLowerCase();

    if (!normalized) {
      return variables.slice(0, limit).map((v) => toCandidate(v, 'nameMatch'));
    }

    const scored: { candidate: OntologyCandidate; score: number }[] = [];

    for (const variable of variables) {
      if (options.ontologyDbId && variable.ontologyDbId !== options.ontologyDbId) continue;
      const match = this.scoreOne(variable, normalized);
      if (match) scored.push(match);
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.candidate);
  }

  private scoreOne(
    variable: VariableLike,
    query: string,
  ): { candidate: OntologyCandidate; score: number } | undefined {
    const pui = variable.observationVariablePUI?.toLowerCase();
    if (pui && pui === query) {
      return { candidate: toCandidate(variable, 'puiMatch'), score: 100 };
    }

    const name = variable.observationVariableName?.toLowerCase();
    if (name) {
      if (name === query) return { candidate: toCandidate(variable, 'nameMatch'), score: 90 };
      if (name.includes(query)) return { candidate: toCandidate(variable, 'nameMatch'), score: 60 };
    }

    const synonymMatch = variable.synonyms?.find((s) => s.toLowerCase().includes(query));
    if (synonymMatch) {
      return { candidate: toCandidate(variable, 'synonymMatch'), score: 50 };
    }

    const traitSynonymMatch = variable.trait?.synonyms?.find((s) =>
      s.toLowerCase().includes(query),
    );
    if (traitSynonymMatch) {
      return { candidate: toCandidate(variable, 'synonymMatch'), score: 40 };
    }

    const traitName = (variable.trait?.traitName ?? variable.trait?.name)?.toLowerCase();
    if (traitName?.includes(query)) {
      return { candidate: toCandidate(variable, 'nameMatch'), score: 35 };
    }

    const traitClass = variable.trait?.traitClass?.toLowerCase();
    if (traitClass && traitClass === query) {
      return { candidate: toCandidate(variable, 'traitClassMatch'), score: 30 };
    }

    const traitDescription = (
      variable.trait?.traitDescription ?? variable.trait?.description
    )?.toLowerCase();
    if (traitDescription?.includes(query)) {
      return { candidate: toCandidate(variable, 'nameMatch'), score: 20 };
    }

    return;
  }
}

function toCandidate(
  variable: VariableLike,
  source: OntologyCandidate['source'],
): OntologyCandidate {
  const candidate: OntologyCandidate = { source };
  if (variable.observationVariableDbId) {
    candidate.observationVariableDbId = variable.observationVariableDbId;
  }
  if (variable.observationVariablePUI) candidate.termId = variable.observationVariablePUI;
  const name =
    variable.observationVariableName ?? variable.trait?.traitName ?? variable.trait?.name;
  if (name) candidate.name = name;
  const description = variable.trait?.traitDescription ?? variable.trait?.description;
  if (description) candidate.description = description;
  if (variable.ontologyDbId) candidate.ontologyDbId = variable.ontologyDbId;
  const combinedSynonyms = [...(variable.synonyms ?? []), ...(variable.trait?.synonyms ?? [])];
  if (combinedSynonyms.length > 0) candidate.synonyms = Array.from(new Set(combinedSynonyms));
  return candidate;
}

let _resolver: OntologyResolver | undefined;

export function initOntologyResolver(): void {
  _resolver = new OntologyResolver();
}

export function getOntologyResolver(): OntologyResolver {
  if (!_resolver) {
    throw new Error('OntologyResolver not initialized — call initOntologyResolver() in setup()');
  }
  return _resolver;
}

export function resetOntologyResolver(): void {
  _resolver = undefined;
}
