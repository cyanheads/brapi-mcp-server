/**
 * @fileoverview Tests for the dialect registry — built-in init, custom
 * registration, fallback to spec on unknown ids.
 *
 * @module tests/services/brapi-dialect/registry.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brapiTestDialect } from '@/services/brapi-dialect/brapi-test-dialect.js';
import {
  breedbaseDialect,
  cassavabaseDialect,
} from '@/services/brapi-dialect/cassavabase-dialect.js';
import {
  getDialectById,
  initBrapiDialectRegistry,
  listRegisteredDialectIds,
  registerDialect,
  resetBrapiDialectRegistry,
} from '@/services/brapi-dialect/registry.js';
import { specDialect } from '@/services/brapi-dialect/spec-dialect.js';
import type { BrapiDialect } from '@/services/brapi-dialect/types.js';

describe('dialect registry', () => {
  beforeEach(() => {
    resetBrapiDialectRegistry();
  });

  afterEach(() => {
    resetBrapiDialectRegistry();
  });

  it('initBrapiDialectRegistry registers the built-ins', () => {
    initBrapiDialectRegistry();
    expect(listRegisteredDialectIds()).toEqual(['brapi-test', 'breedbase', 'cassavabase', 'spec']);
    expect(getDialectById('spec')).toBe(specDialect);
    expect(getDialectById('brapi-test')).toBe(brapiTestDialect);
    expect(getDialectById('breedbase')).toBe(breedbaseDialect);
    expect(getDialectById('cassavabase')).toBe(cassavabaseDialect);
  });

  it('falls back to spec when id is unknown', () => {
    initBrapiDialectRegistry();
    expect(getDialectById('not-a-real-dialect')).toBe(specDialect);
  });

  it('falls back to spec when registry is empty', () => {
    expect(getDialectById('cassavabase')).toBe(specDialect);
  });

  it('allows registering a custom dialect', () => {
    initBrapiDialectRegistry();
    const custom: BrapiDialect = {
      id: 'germinate',
      adaptGetFilters: () => ({ filters: {}, warnings: [] }),
    };
    registerDialect(custom);
    expect(getDialectById('germinate')).toBe(custom);
    expect(listRegisteredDialectIds()).toContain('germinate');
  });

  it('last-write-wins on id collision', () => {
    initBrapiDialectRegistry();
    const replacement: BrapiDialect = {
      id: 'cassavabase',
      adaptGetFilters: () => ({ filters: { replaced: true }, warnings: [] }),
    };
    registerDialect(replacement);
    expect(getDialectById('cassavabase')).toBe(replacement);
    expect(getDialectById('cassavabase')).not.toBe(cassavabaseDialect);
  });

  it('initBrapiDialectRegistry is idempotent', () => {
    initBrapiDialectRegistry();
    initBrapiDialectRegistry();
    expect(listRegisteredDialectIds()).toEqual(['brapi-test', 'breedbase', 'cassavabase', 'spec']);
  });
});
