/**
 * @fileoverview Public API barrel for the BrAPI filter catalog.
 *
 * @module services/brapi-filters
 */

export { getFilterCatalog, listFilterEndpoints } from './catalog.js';
export type { FilterCatalog, FilterDescriptor, FilterType } from './types.js';
