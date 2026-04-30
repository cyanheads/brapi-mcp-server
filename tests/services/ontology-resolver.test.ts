/**
 * @fileoverview Unit tests for OntologyResolver. Covers PUI / name / synonym
 * paths, the BrAPI v2.1 trait-subobject paths (`traitName`, `traitDescription`),
 * and the legacy `name` / `description` aliases retained for older servers.
 *
 * @module tests/services/ontology-resolver.test
 */

import { describe, expect, it } from 'vitest';
import { OntologyResolver, type VariableLike } from '@/services/ontology-resolver/index.js';

const resolver = new OntologyResolver();

describe('OntologyResolver', () => {
  it('matches on observationVariableName (substring)', () => {
    const variables: VariableLike[] = [
      { observationVariableDbId: 'v1', observationVariableName: 'Dry Matter %' },
      { observationVariableDbId: 'v2', observationVariableName: 'Plant Height' },
    ];
    const candidates = resolver.match('dry matter', variables);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.observationVariableDbId).toBe('v1');
    expect(candidates[0]?.source).toBe('nameMatch');
  });

  it('matches on trait.traitName when the variable name does not contain the query (BrAPI v2.1 shape)', () => {
    // Mirrors the BrAPI Community Test Server: `observationVariableName` is
    // "Pawpaw Height" / "Corn Stalk Height", but `trait.traitName` is "Plant Height".
    // Resolver must surface both rows for the free-text query "plant height".
    const variables: VariableLike[] = [
      {
        observationVariableDbId: 'variable1',
        observationVariableName: 'Corn Stalk Height',
        trait: { traitName: 'Plant Height' },
      },
      {
        observationVariableDbId: 'variable2',
        observationVariableName: 'Pawpaw Height',
        trait: { traitName: 'Plant Height' },
      },
      {
        observationVariableDbId: 'variable3',
        observationVariableName: 'Fruit Color',
        trait: { traitName: 'Color' },
      },
    ];
    const candidates = resolver.match('plant height', variables);
    expect(candidates.map((c) => c.observationVariableDbId).sort()).toEqual([
      'variable1',
      'variable2',
    ]);
    expect(candidates.every((c) => c.source === 'nameMatch')).toBe(true);
  });

  it('matches on trait.traitDescription when name and traitName miss', () => {
    const variables: VariableLike[] = [
      {
        observationVariableDbId: 'v1',
        observationVariableName: 'PH_PLANT',
        trait: {
          traitName: 'Stature',
          traitDescription: 'plant height measured from soil to apex',
        },
      },
    ];
    const candidates = resolver.match('plant height', variables);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.observationVariableDbId).toBe('v1');
  });

  it('falls back to legacy trait.name / trait.description for non-conformant servers', () => {
    const variables: VariableLike[] = [
      {
        observationVariableDbId: 'legacy-1',
        observationVariableName: 'YLD',
        // Older / non-conformant servers populate `name` and `description`
        // instead of the v2.1 `traitName` / `traitDescription` keys.
        trait: { name: 'Yield', description: 'fresh weight per plot' },
      },
    ];
    const byName = resolver.match('yield', variables);
    expect(byName.map((c) => c.observationVariableDbId)).toEqual(['legacy-1']);
    const byDesc = resolver.match('fresh weight', variables);
    expect(byDesc.map((c) => c.observationVariableDbId)).toEqual(['legacy-1']);
  });

  it('toCandidate populates name + description from BrAPI v2.1 trait fields when the variable name is absent', () => {
    const variables: VariableLike[] = [
      {
        observationVariableDbId: 'v1',
        trait: { traitName: 'Plant Height', traitDescription: 'apex-to-soil distance' },
      },
    ];
    const [candidate] = resolver.match('plant height', variables);
    expect(candidate?.name).toBe('Plant Height');
    expect(candidate?.description).toBe('apex-to-soil distance');
  });

  it('ranks PUI exact > variable name exact > variable name substring > trait name > trait description', () => {
    const variables: VariableLike[] = [
      {
        observationVariableDbId: 'desc',
        observationVariableName: 'Z',
        trait: { traitDescription: 'plant height measured from base' },
      },
      {
        observationVariableDbId: 'trait',
        observationVariableName: 'Y',
        trait: { traitName: 'plant height' },
      },
      { observationVariableDbId: 'sub', observationVariableName: 'tall plant height' },
      { observationVariableDbId: 'exact', observationVariableName: 'plant height' },
      { observationVariableDbId: 'pui', observationVariablePUI: 'plant height' },
    ];
    const candidates = resolver.match('plant height', variables);
    expect(candidates.map((c) => c.observationVariableDbId)).toEqual([
      'pui',
      'exact',
      'sub',
      'trait',
      'desc',
    ]);
  });

  it('returns the pool unchanged (up to limit) when the query is empty', () => {
    const variables: VariableLike[] = [
      { observationVariableDbId: 'v1', observationVariableName: 'A' },
      { observationVariableDbId: 'v2', observationVariableName: 'B' },
      { observationVariableDbId: 'v3', observationVariableName: 'C' },
    ];
    const candidates = resolver.match('   ', variables, { limit: 2 });
    expect(candidates.map((c) => c.observationVariableDbId)).toEqual(['v1', 'v2']);
  });

  it('honors ontologyDbId scope when provided', () => {
    const variables: VariableLike[] = [
      {
        observationVariableDbId: 'v1',
        observationVariableName: 'Plant Height',
        ontologyDbId: 'CO_334',
      },
      {
        observationVariableDbId: 'v2',
        observationVariableName: 'Plant Height',
        ontologyDbId: 'CO_338',
      },
    ];
    const candidates = resolver.match('plant height', variables, { ontologyDbId: 'CO_334' });
    expect(candidates.map((c) => c.observationVariableDbId)).toEqual(['v1']);
  });
});
