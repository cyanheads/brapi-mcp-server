/**
 * @fileoverview Public API for the BrAPI dialect service. Tools call
 * `resolveDialect(connection, ctx)` to get a per-connection adapter, then
 * `dialect.adaptGetFilters(endpoint, filters)` before serializing a GET
 * call. Detection runs once per connection per ctx (the underlying
 * capability profile is cached in `ctx.state`), so repeated calls are
 * cheap.
 *
 * @module services/brapi-dialect
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { ResolvedAuth } from '@/services/brapi-client/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import type { RegisteredServer } from '@/services/server-registry/index.js';
import { detectDialectId } from './detect.js';
import { getDialectById } from './registry.js';
import type { BrapiDialect } from './types.js';

export { brapiTestDialect } from './brapi-test-dialect.js';
export { breedbaseDialect, cassavabaseDialect } from './cassavabase-dialect.js';
export {
  type DialectDetection,
  type DialectDetectionSource,
  detectDialectFromName,
  detectDialectId,
  dialectEnvVar,
  readDialectOverride,
} from './detect.js';
export {
  getDialectById,
  initBrapiDialectRegistry,
  listRegisteredDialectIds,
  registerDialect,
  resetBrapiDialectRegistry,
} from './registry.js';
export { specDialect } from './spec-dialect.js';
export type { BrapiDialect, DialectAdaptation } from './types.js';

/**
 * Resolve the dialect for a registered connection. Reads the env override
 * first (`BRAPI_<ALIAS>_DIALECT`); on miss, falls back to detection from
 * the cached capability profile. The profile lookup is the same one tools
 * already trigger via `capabilities.ensure()` so this adds zero HTTP.
 */
export async function resolveDialect(
  connection: RegisteredServer,
  ctx: Context,
  options: { auth?: ResolvedAuth | undefined } = {},
): Promise<BrapiDialect> {
  const lookup: { auth?: ResolvedAuth } = {};
  if (options.auth) lookup.auth = options.auth;
  const profile = await getCapabilityRegistry().profile(connection.baseUrl, ctx, lookup);
  return getDialectById(detectDialectId(connection.alias, profile).id);
}
