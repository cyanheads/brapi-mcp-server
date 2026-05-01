/**
 * @fileoverview Dialect marker for the BrAPI Community Test Server. The
 * server mostly follows v2.1 filter naming, so GET filters pass through
 * unchanged. The useful compatibility data is the verified location-coordinate
 * quirk, which `brapi_find_locations` already recovers from by retrying bbox
 * filtering with swapped GeoJSON Point axes when the spec reading yields no
 * matches.
 *
 * @module services/brapi-dialect/brapi-test-dialect
 */

import type { BrapiDialect } from './types.js';

export const brapiTestDialect: BrapiDialect = {
  id: 'brapi-test',
  notes: [
    'Location GeoJSON Point coordinates may be stored as [lat, lon, alt] instead of the GeoJSON-standard [lon, lat, alt]; brapi_find_locations retries bbox filtering with swapped axes when needed.',
  ],
  adaptGetFilters(_endpoint, filters) {
    return { filters: { ...filters }, warnings: [] };
  },
};
