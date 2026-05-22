/**
 * @fileoverview Tests for the BMS (Breeding Management System) dialect —
 * filter translation, mapping summary (all inferred), notes, and detection
 * from server-name + CGIAR organization-name patterns.
 *
 * @module tests/services/brapi-dialect/bms-dialect.test
 */

import { describe, expect, it } from 'vitest';
import { bmsDialect } from '@/services/brapi-dialect/bms-dialect.js';
import { detectDialectFromName } from '@/services/brapi-dialect/detect.js';

describe('bmsDialect', () => {
  it('translates v2.1 plurals to v2.0 singulars on studies', () => {
    const result = bmsDialect.adaptGetFilters('studies', {
      commonCropNames: ['Maize'],
      programDbIds: ['p1'],
      trialDbIds: ['t1'],
      studyDbIds: ['s1'],
    });
    expect(result.filters).toEqual({
      commonCropName: 'Maize',
      programDbId: 'p1',
      trialDbId: 't1',
      studyDbId: 's1',
    });
  });

  it('translates plurals on germplasm and observations endpoints', () => {
    expect(
      bmsDialect.adaptGetFilters('germplasm', { germplasmDbIds: ['g1'], synonyms: ['alpha'] })
        .filters,
    ).toEqual({ germplasmDbId: 'g1', synonym: 'alpha' });
    expect(
      bmsDialect.adaptGetFilters('observations', { studyDbIds: ['s1'], germplasmDbIds: ['g1'] })
        .filters,
    ).toEqual({ studyDbId: 's1', germplasmDbId: 'g1' });
  });

  it('signals requiresEscalation on multi-value downcast (#15 path)', () => {
    const result = bmsDialect.adaptGetFilters('studies', {
      programDbIds: ['p1', 'p2', 'p3'],
    });
    expect(result.requiresEscalation).toBe(true);
    expect(result.warnings[0]).toMatch(/downcast/);
  });

  it('marks every mapping as inferred until live-narrowed (#5)', () => {
    expect(bmsDialect.mappingSummary).toBeDefined();
    expect(bmsDialect.mappingSummary?.verified).toBe(0);
    expect(bmsDialect.mappingSummary?.inferred).toBeGreaterThan(20);
  });

  it('warns that mappings are inferred on every downcast', () => {
    const result = bmsDialect.adaptGetFilters('studies', {
      programDbIds: ['p1', 'p2'],
    });
    expect(result.warnings[0]).toMatch(/mapping inferred/);
  });

  it('surfaces compatibility notes for orientation envelope display', () => {
    expect(bmsDialect.notes).toBeDefined();
    expect(bmsDialect.notes?.length).toBeGreaterThan(0);
    expect(bmsDialect.notes?.[0]).toMatch(/BMS/);
  });

  it('does not declare any disabledSearchEndpoints', () => {
    expect(bmsDialect.disabledSearchEndpoints).toBeUndefined();
  });

  it('passes through unknown endpoints unchanged', () => {
    const result = bmsDialect.adaptGetFilters('unknown-future-endpoint', {
      whateverIds: ['x'],
      flag: true,
    });
    expect(result.filters).toEqual({ whateverIds: ['x'], flag: true });
  });
});

describe('detectDialectFromName: BMS', () => {
  it('detects from a literal "BMS" server name (word-bounded)', () => {
    expect(detectDialectFromName('BMS', undefined)).toEqual({ id: 'bms', source: 'server-name' });
    expect(detectDialectFromName('BMSAPI', undefined)).toEqual({
      id: 'bms',
      source: 'server-name',
    });
  });

  it('detects from the full "Breeding Management System" label', () => {
    expect(detectDialectFromName('Breeding Management System v5', undefined)).toEqual({
      id: 'bms',
      source: 'server-name',
    });
  });

  it('does NOT trigger on incidental BMS substrings (MBMS, BMSC)', () => {
    expect(detectDialectFromName('MBMSeq', undefined).id).toBe('spec');
    expect(detectDialectFromName('BMSCenter', undefined).id).toBe('spec');
  });

  it('detects via CGIAR organization names when server-name is generic', () => {
    expect(detectDialectFromName('BrAPI', 'CIMMYT')).toEqual({
      id: 'bms',
      source: 'organization-name',
    });
    expect(detectDialectFromName('BrAPI', 'IRRI')).toEqual({
      id: 'bms',
      source: 'organization-name',
    });
    expect(detectDialectFromName('BrAPI', 'ICRISAT')).toEqual({
      id: 'bms',
      source: 'organization-name',
    });
    expect(detectDialectFromName('BrAPI', 'IITA')).toEqual({
      id: 'bms',
      source: 'organization-name',
    });
    expect(detectDialectFromName('BrAPI', 'International Potato Center (CIP)')).toEqual({
      id: 'bms',
      source: 'organization-name',
    });
  });

  it('cassavabase still wins over BMS detection when both could match', () => {
    // Verifies the order of checks — CassavaBase is checked first so a server
    // that somehow names both stays on cassavabase.
    expect(detectDialectFromName('CassavaBase BMS', undefined).id).toBe('cassavabase');
  });
});
