/**
 * @fileoverview Tests for the BrAPI Community Test Server dialect — verifies
 * the plural→singular translation per endpoint, drop entries for filters the
 * server silently ignores in both forms (`searchText`,
 * `observationLevel(s)`), and that POST /search routes are NOT marked
 * disabled (the test server serves them correctly, unlike the SGN family).
 *
 * @module tests/services/brapi-dialect/brapi-test-dialect.test
 */

import { describe, expect, it } from 'vitest';
import { brapiTestDialect } from '@/services/brapi-dialect/brapi-test-dialect.js';

describe('brapiTestDialect', () => {
  describe('observations endpoint', () => {
    // /observations?studyDbId(s) is broken upstream in both GET and POST
    // /search forms — drop both with a warning rather than send a request
    // that returns garbage. Agents should scope by germplasm or
    // observationUnit instead.
    it('drops studyDbIds and studyDbId — server filter is broken', () => {
      const plural = brapiTestDialect.adaptGetFilters('observations', {
        studyDbIds: ['study2'],
      });
      expect(plural.filters).toEqual({});
      expect(plural.warnings.some((w) => /dropped filter 'studyDbIds'/.test(w))).toBe(true);

      const singular = brapiTestDialect.adaptGetFilters('observations', {
        studyDbId: 'study2',
      });
      expect(singular.filters).toEqual({});
      expect(singular.warnings.some((w) => /dropped filter 'studyDbId'/.test(w))).toBe(true);
    });

    it('translates germplasm, variable, and observationUnit plurals (these DO filter)', () => {
      const result = brapiTestDialect.adaptGetFilters('observations', {
        germplasmDbIds: ['germplasm1'],
        observationVariableDbIds: ['variable1'],
        observationUnitDbIds: ['observation_unit1'],
        observationDbIds: ['observation1'],
      });
      expect(result.filters).toEqual({
        germplasmDbId: 'germplasm1',
        observationVariableDbId: 'variable1',
        observationUnitDbId: 'observation_unit1',
        observationDbId: 'observation1',
      });
      expect(result.warnings).toEqual([]);
    });

    it('drops observationLevels (server ignores both plural and singular)', () => {
      const plural = brapiTestDialect.adaptGetFilters('observations', {
        observationLevels: ['plot'],
      });
      expect(plural.filters).toEqual({});
      expect(plural.warnings.some((w) => /dropped filter 'observationLevels'/.test(w))).toBe(true);

      const singular = brapiTestDialect.adaptGetFilters('observations', {
        observationLevel: 'plot',
      });
      expect(singular.filters).toEqual({});
      expect(singular.warnings.some((w) => /dropped filter 'observationLevel'/.test(w))).toBe(true);
    });

    it('downcasts multi-value germplasmDbIds with a loud warning', () => {
      const result = brapiTestDialect.adaptGetFilters('observations', {
        germplasmDbIds: ['germplasm1', 'germplasm2'],
      });
      expect(result.filters).toEqual({ germplasmDbId: 'germplasm1' });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatch(/'germplasmDbIds' downcast to 'germplasmDbId'/);
      expect(result.warnings[0]).toMatch(/only the first value/);
    });
  });

  describe('studies endpoint (Issue 2 root cause)', () => {
    it('translates germplasmDbIds → germplasmDbId so studyCount probe filters', () => {
      const result = brapiTestDialect.adaptGetFilters('studies', {
        germplasmDbIds: ['germplasm1'],
      });
      expect(result.filters).toEqual({ germplasmDbId: 'germplasm1' });
    });

    it('translates the full plural set used by find_studies', () => {
      const result = brapiTestDialect.adaptGetFilters('studies', {
        studyDbIds: ['study1'],
        commonCropNames: ['Tomatillo'],
        programDbIds: ['program1'],
        trialDbIds: ['trial1'],
        locationDbIds: ['location_01'],
        seasonDbIds: ['2022'],
      });
      expect(result.filters).toEqual({
        studyDbId: 'study1',
        commonCropName: 'Tomatillo',
        programDbId: 'program1',
        trialDbId: 'trial1',
        locationDbId: 'location_01',
        seasonDbId: '2022',
      });
      expect(result.warnings).toEqual([]);
    });

    // /studies?studyDbId works on this server (verified empirically). Only
    // /observations?studyDbId is broken — the drop list is endpoint-scoped.
    it('does NOT drop studyDbIds on /studies (server filter works there)', () => {
      const result = brapiTestDialect.adaptGetFilters('studies', {
        studyDbIds: ['study1'],
      });
      expect(result.filters).toEqual({ studyDbId: 'study1' });
      expect(result.warnings).toEqual([]);
    });

    it('does NOT drop locationDbIds (test server honors singular, unlike CassavaBase)', () => {
      const result = brapiTestDialect.adaptGetFilters('studies', {
        locationDbIds: ['location_01'],
      });
      expect(result.filters).toEqual({ locationDbId: 'location_01' });
      expect(result.warnings).toEqual([]);
    });
  });

  describe('germplasm endpoint', () => {
    it('translates germplasmDbIds and commonCropNames', () => {
      const result = brapiTestDialect.adaptGetFilters('germplasm', {
        germplasmDbIds: ['germplasm1'],
        commonCropNames: ['Tomatillo'],
      });
      expect(result.filters).toEqual({
        germplasmDbId: 'germplasm1',
        commonCropName: 'Tomatillo',
      });
    });

    it('drops searchText with a warning (server silently ignores it)', () => {
      const result = brapiTestDialect.adaptGetFilters('germplasm', {
        commonCropNames: ['Tomatillo'],
        searchText: 'TME',
      });
      expect(result.filters).toEqual({ commonCropName: 'Tomatillo' });
      expect(result.warnings.some((w) => /dropped filter 'searchText'/.test(w))).toBe(true);
    });

    it('passes genus/species (already singular per BrAPI spec) through', () => {
      const result = brapiTestDialect.adaptGetFilters('germplasm', {
        genus: 'Aspergillus',
        species: 'fructus',
      });
      expect(result.filters).toEqual({ genus: 'Aspergillus', species: 'fructus' });
      expect(result.warnings).toEqual([]);
    });
  });

  describe('locations / variables', () => {
    it('translates locations plurals', () => {
      const result = brapiTestDialect.adaptGetFilters('locations', {
        locationDbIds: ['location_01'],
        countryCodes: ['NGA'],
        locationTypes: ['Storage Location'],
      });
      expect(result.filters).toEqual({
        locationDbId: 'location_01',
        countryCode: 'NGA',
        locationType: 'Storage Location',
      });
    });

    it('translates variables plurals', () => {
      const result = brapiTestDialect.adaptGetFilters('variables', {
        observationVariableDbIds: ['variable1'],
      });
      expect(result.filters).toEqual({ observationVariableDbId: 'variable1' });
    });
  });

  describe('passthrough behavior', () => {
    it('passes pagination params through unchanged', () => {
      const result = brapiTestDialect.adaptGetFilters('studies', {
        page: 0,
        pageSize: 50,
        studyDbIds: ['study1'],
      });
      expect(result.filters).toEqual({ page: 0, pageSize: 50, studyDbId: 'study1' });
    });

    it('passes range scalars through unchanged', () => {
      const result = brapiTestDialect.adaptGetFilters('observations', {
        observationTimeStampRangeStart: '2022-01-01T00:00:00Z',
        observationTimeStampRangeEnd: '2022-12-31T23:59:59Z',
      });
      expect(result.filters).toEqual({
        observationTimeStampRangeStart: '2022-01-01T00:00:00Z',
        observationTimeStampRangeEnd: '2022-12-31T23:59:59Z',
      });
    });

    it('passes unmapped extraFilters keys through unchanged', () => {
      const result = brapiTestDialect.adaptGetFilters('studies', {
        studyDbIds: ['study1'],
        someServerSpecificFlag: 'yes',
      });
      expect(result.filters).toEqual({
        studyDbId: 'study1',
        someServerSpecificFlag: 'yes',
      });
    });

    it('skips empty arrays without emitting them', () => {
      const result = brapiTestDialect.adaptGetFilters('studies', {
        studyDbIds: [],
        commonCropNames: ['Tomatillo'],
      });
      expect(result.filters).toEqual({ commonCropName: 'Tomatillo' });
      expect(Object.keys(result.filters)).not.toContain('studyDbId');
    });

    it('drops undefined values (defensive — mergeFilters already does this)', () => {
      const result = brapiTestDialect.adaptGetFilters('observations', {
        germplasmDbIds: ['germplasm1'],
        observationVariableDbIds: undefined,
      });
      expect(result.filters).toEqual({ germplasmDbId: 'germplasm1' });
    });
  });

  describe('search routes', () => {
    it('does NOT declare any disabled POST /search routes (test server serves them)', () => {
      // The test server returns sync /search responses with v2.1 plurals
      // honored — opposite of the SGN family. Multi-value queries can
      // legitimately escalate to /search/{noun}.
      expect(brapiTestDialect.disabledSearchEndpoints).toBeUndefined();
    });
  });

  describe('notes', () => {
    it('mentions the v2.0/v2.1 GET filter mismatch', () => {
      const notes = brapiTestDialect.notes ?? [];
      expect(notes.some((n) => /v2\.0|singular/i.test(n))).toBe(true);
    });

    it('preserves the coordinate-axis quirk note for find_locations', () => {
      const notes = brapiTestDialect.notes ?? [];
      expect(notes.some((n) => /coordinate|GeoJSON/i.test(n))).toBe(true);
    });
  });
});
