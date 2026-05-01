/**
 * @fileoverview Tests for the CassavaBase dialect — verifies the plural→singular
 * translation table per endpoint, the multi-value array downcast warning, the
 * `searchText` drop, and that unknown filters pass through unchanged.
 *
 * @module tests/services/brapi-dialect/cassavabase-dialect.test
 */

import { describe, expect, it } from 'vitest';
import { cassavabaseDialect } from '@/services/brapi-dialect/cassavabase-dialect.js';

describe('cassavabaseDialect', () => {
  describe('studies endpoint', () => {
    it('translates plural filter keys to singular', () => {
      const result = cassavabaseDialect.adaptGetFilters('studies', {
        commonCropNames: ['Cassava'],
        studyTypes: ['Yield Trial'],
        programDbIds: ['162'],
        seasonDbIds: ['2022'],
      });
      expect(result.filters).toEqual({
        commonCropName: 'Cassava',
        studyType: 'Yield Trial',
        programDbId: '162',
        seasonDbId: '2022',
      });
      expect(result.warnings).toEqual([]);
    });

    it('drops searchText and emits a warning', () => {
      const result = cassavabaseDialect.adaptGetFilters('studies', {
        commonCropNames: ['Cassava'],
        searchText: 'TMS',
      });
      expect(result.filters).toEqual({ commonCropName: 'Cassava' });
      expect(result.filters.searchText).toBeUndefined();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatch(/dropped filter 'searchText'/);
    });

    it('downcasts multi-value arrays to first value with loud warning', () => {
      const result = cassavabaseDialect.adaptGetFilters('studies', {
        seasonDbIds: ['2022', '2023', '2024'],
      });
      expect(result.filters).toEqual({ seasonDbId: '2022' });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatch(/'seasonDbIds' downcast to 'seasonDbId'/);
      expect(result.warnings[0]).toMatch(/only the first value/);
    });

    it('skips empty arrays without emitting them', () => {
      const result = cassavabaseDialect.adaptGetFilters('studies', {
        commonCropNames: [],
        studyTypes: ['Phenotyping'],
      });
      expect(result.filters).toEqual({ studyType: 'Phenotyping' });
      expect(Object.keys(result.filters)).not.toContain('commonCropName');
    });

    it('passes scalar booleans (e.g. active) through unchanged', () => {
      const result = cassavabaseDialect.adaptGetFilters('studies', {
        active: true,
      });
      expect(result.filters).toEqual({ active: true });
    });

    it('passes pagination params through unchanged', () => {
      const result = cassavabaseDialect.adaptGetFilters('studies', {
        page: 2,
        pageSize: 100,
        commonCropNames: ['Cassava'],
      });
      expect(result.filters).toEqual({
        page: 2,
        pageSize: 100,
        commonCropName: 'Cassava',
      });
    });

    it('passes unmapped extraFilters keys through unchanged', () => {
      const result = cassavabaseDialect.adaptGetFilters('studies', {
        commonCropNames: ['Cassava'],
        someServerSpecificFlag: 'yes',
      });
      expect(result.filters).toEqual({
        commonCropName: 'Cassava',
        someServerSpecificFlag: 'yes',
      });
    });

    it('drops undefined values (defensive — mergeFilters already does this)', () => {
      const result = cassavabaseDialect.adaptGetFilters('studies', {
        commonCropNames: ['Cassava'],
        studyTypes: undefined,
      });
      expect(result.filters).toEqual({ commonCropName: 'Cassava' });
    });
  });

  describe('germplasm endpoint', () => {
    it('translates plural keys to singular', () => {
      const result = cassavabaseDialect.adaptGetFilters('germplasm', {
        commonCropNames: ['Cassava'],
        germplasmNames: ['TME419'],
        accessionNumbers: ['TMe-419'],
        synonyms: ['TME-419'],
      });
      expect(result.filters).toEqual({
        commonCropName: 'Cassava',
        germplasmName: 'TME419',
        accessionNumber: 'TMe-419',
        synonym: 'TME-419',
      });
    });

    it('drops searchText on germplasm too', () => {
      const result = cassavabaseDialect.adaptGetFilters('germplasm', {
        searchText: 'TME',
      });
      expect(result.filters).toEqual({});
      expect(result.warnings[0]).toMatch(/dropped filter 'searchText'/);
    });

    it('passes genus/species (already singular) through', () => {
      const result = cassavabaseDialect.adaptGetFilters('germplasm', {
        genus: 'Manihot',
        species: 'esculenta',
      });
      expect(result.filters).toEqual({ genus: 'Manihot', species: 'esculenta' });
      expect(result.warnings).toEqual([]);
    });
  });

  describe('observations endpoint', () => {
    it('translates the full plural set', () => {
      const result = cassavabaseDialect.adaptGetFilters('observations', {
        studyDbIds: ['s1'],
        germplasmDbIds: ['g1'],
        observationVariableDbIds: ['v1'],
        observationUnitDbIds: ['ou1'],
        observationDbIds: ['o1'],
        seasonDbIds: ['2022'],
        programDbIds: ['p1'],
        trialDbIds: ['t1'],
        observationLevels: ['plot'],
      });
      expect(result.filters).toEqual({
        studyDbId: 's1',
        germplasmDbId: 'g1',
        observationVariableDbId: 'v1',
        observationUnitDbId: 'ou1',
        observationDbId: 'o1',
        seasonDbId: '2022',
        programDbId: 'p1',
        trialDbId: 't1',
        observationLevel: 'plot',
      });
    });

    it('passes range scalars through unchanged', () => {
      const result = cassavabaseDialect.adaptGetFilters('observations', {
        observationTimeStampRangeStart: '2022-01-01T00:00:00Z',
        observationTimeStampRangeEnd: '2022-12-31T23:59:59Z',
      });
      expect(result.filters).toEqual({
        observationTimeStampRangeStart: '2022-01-01T00:00:00Z',
        observationTimeStampRangeEnd: '2022-12-31T23:59:59Z',
      });
    });
  });

  describe('locations / variables / images / variants', () => {
    it('translates locations plurals', () => {
      const result = cassavabaseDialect.adaptGetFilters('locations', {
        locationDbIds: ['3'],
        countryCodes: ['NGA'],
        locationTypes: ['Field'],
      });
      expect(result.filters).toEqual({
        locationDbId: '3',
        countryCode: 'NGA',
        locationType: 'Field',
      });
    });

    it('translates variables plurals', () => {
      const result = cassavabaseDialect.adaptGetFilters('variables', {
        observationVariableDbIds: ['v1'],
        traitClasses: ['Agronomic'],
        ontologyDbIds: ['CO_334'],
      });
      expect(result.filters).toEqual({
        observationVariableDbId: 'v1',
        traitClass: 'Agronomic',
        ontologyDbId: 'CO_334',
      });
    });

    it('translates images plurals', () => {
      const result = cassavabaseDialect.adaptGetFilters('images', {
        imageDbIds: ['img1'],
        mimeTypes: ['image/jpeg'],
        descriptiveOntologyTerms: ['CO_334:plot'],
      });
      expect(result.filters).toEqual({
        imageDbId: 'img1',
        mimeType: 'image/jpeg',
        descriptiveOntologyTerm: 'CO_334:plot',
      });
    });

    it('translates variants plurals', () => {
      const result = cassavabaseDialect.adaptGetFilters('variants', {
        variantSetDbIds: ['vs1'],
        variantDbIds: ['v1'],
        referenceDbIds: ['ref1'],
      });
      expect(result.filters).toEqual({
        variantSetDbId: 'vs1',
        variantDbId: 'v1',
        referenceDbId: 'ref1',
      });
    });
  });

  describe('disabledSearchEndpoints', () => {
    it('declares known-dead POST /search routes', () => {
      const disabled = cassavabaseDialect.disabledSearchEndpoints;
      expect(disabled).toBeDefined();
      // Read endpoints with curated GET tools — agents should use those instead.
      expect(disabled?.has('germplasm')).toBe(true);
      expect(disabled?.has('studies')).toBe(true);
      expect(disabled?.has('observations')).toBe(true);
      expect(disabled?.has('locations')).toBe(true);
      expect(disabled?.has('variables')).toBe(true);
      expect(disabled?.has('images')).toBe(true);
      expect(disabled?.has('variants')).toBe(true);
    });

    it('does NOT mark `calls` (genotype data) as disabled', () => {
      // Async POST /search/calls is the only realistic delivery for bulk
      // genotype data, and we have no evidence it's broken on cassavabase.
      expect(cassavabaseDialect.disabledSearchEndpoints?.has('calls')).toBe(false);
    });
  });

  describe('unknown endpoint', () => {
    it('passes everything through with no translation', () => {
      const result = cassavabaseDialect.adaptGetFilters('something-new', {
        someFilterIds: ['a', 'b'],
        flag: true,
      });
      expect(result.filters).toEqual({
        someFilterIds: ['a', 'b'],
        flag: true,
      });
      expect(result.warnings).toEqual([]);
    });
  });
});
