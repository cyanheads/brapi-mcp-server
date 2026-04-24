/**
 * @fileoverview Types for the BrAPI filter catalog — the static map of
 * endpoint → valid filter names used by `brapi_describe_filters` and the
 * `extraFilters` passthrough on `find_*` tools.
 *
 * @module services/brapi-filters/types
 */

export type FilterType =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'date'
  | 'string[]'
  | 'integer[]';

export interface FilterDescriptor {
  description: string;
  /** Example value, always stringified — renderable directly in tool output. */
  example: string;
  /** Filter parameter name (matches what BrAPI accepts on the query string). */
  name: string;
  type: FilterType;
}

export interface FilterCatalog {
  endpoint: string;
  filters: FilterDescriptor[];
  /** Pointer to the BrAPI v2 spec section covering this endpoint. */
  specReference?: string;
}
