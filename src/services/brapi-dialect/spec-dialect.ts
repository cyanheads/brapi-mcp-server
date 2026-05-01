/**
 * @fileoverview The default `spec` dialect — passes filters through verbatim.
 * Used for any server that implements BrAPI v2.1 query-string filters as
 * specified (the BrAPI Community Test Server, modern PIPPA / GnpIS / Reference
 * Server deployments). Selected when no server-specific dialect matches the
 * detected `serverInfo.serverName`, or when an operator pins
 * `BRAPI_<ALIAS>_DIALECT=spec` to override detection.
 *
 * @module services/brapi-dialect/spec-dialect
 */

import type { BrapiDialect } from './types.js';

export const specDialect: BrapiDialect = {
  id: 'spec',
  adaptGetFilters(_endpoint, filters) {
    return { filters: { ...filters }, warnings: [] };
  },
};
