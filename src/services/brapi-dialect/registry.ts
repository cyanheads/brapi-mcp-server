/**
 * @fileoverview Dialect registry — singleton map from dialect id to
 * implementation. Initialized in `setup()` with the built-in dialects;
 * future plugins can register additional ones before `createApp()` returns.
 * Lookups never throw — unknown ids fall back to the `spec` dialect so a
 * stale env override or typo can't crash a tool call mid-flight.
 *
 * @module services/brapi-dialect/registry
 */

import { brapiTestDialect } from './brapi-test-dialect.js';
import { breedbaseDialect, cassavabaseDialect } from './cassavabase-dialect.js';
import { specDialect } from './spec-dialect.js';
import type { BrapiDialect } from './types.js';

const REGISTRY = new Map<string, BrapiDialect>();

/** Register a dialect. Last-write-wins on id collision. */
export function registerDialect(dialect: BrapiDialect): void {
  REGISTRY.set(dialect.id, dialect);
}

/**
 * Look up a registered dialect by id. Falls back to the `spec` (passthrough)
 * dialect when the id is unknown — keeps misconfiguration loud (the dialect
 * still adapts its translations) while avoiding hard failures.
 */
export function getDialectById(id: string): BrapiDialect {
  return REGISTRY.get(id) ?? specDialect;
}

/** Wire the built-in dialects. Idempotent — safe to call multiple times. */
export function initBrapiDialectRegistry(): void {
  REGISTRY.clear();
  registerDialect(specDialect);
  registerDialect(brapiTestDialect);
  registerDialect(breedbaseDialect);
  registerDialect(cassavabaseDialect);
}

/** Test-only — clear all registrations between suites. */
export function resetBrapiDialectRegistry(): void {
  REGISTRY.clear();
}

/** Test-only — list registered ids. */
export function listRegisteredDialectIds(): string[] {
  return Array.from(REGISTRY.keys()).sort();
}
