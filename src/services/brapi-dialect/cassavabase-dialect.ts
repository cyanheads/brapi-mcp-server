/**
 * @fileoverview Dialects for CassavaBase and broader CXGN / SGN-derived BrAPI
 * deployments — Breedbase, Sweetpotatobase, Yambase, Musabase, BananaBase,
 * T3, etc. These servers run the SGN BrAPI implementation, which predates the BrAPI v2.1
 * filter-name normalization and only honors the older **singular** query
 * parameters on GET list endpoints. Sending `commonCropNames=Cassava` is
 * silently ignored upstream — the singular `commonCropName=Cassava` works.
 * Empirically verified against `https://cassavabase.org/brapi/v2` on
 * 2026-04-30.
 *
 * The dialects:
 *   1. Translates plural filter keys to their singular equivalents per
 *      endpoint, downcasting array values to the first element with a loud
 *      warning when more than one value was supplied (the GET surface can't
 *      express multi-value filters; the spec-defined POST `/search/{noun}`
 *      route is advertised but unresponsive in practice).
 *   2. Drops filters that the server doesn't honor at all (`searchText` —
 *      we invented this earlier; not in the BrAPI v2.1 spec, no SGN-family
 *      server honors it).
 *
 * Translation engine lives in `singularizing-dialect.ts`; this module supplies
 * SGN-specific data only.
 *
 * @module services/brapi-dialect/cassavabase-dialect
 */

import { createSingularizingDialect } from './singularizing-dialect.js';
import type { BrapiDialect } from './types.js';

/**
 * Plural BrAPI v2.1 filter key → singular form CassavaBase honors. Keyed by
 * endpoint resource segment (matches the path's first segment, no leading
 * slash). Endpoints not listed here pass through with zero translation.
 *
 * Mappings reflect what's empirically verified to filter; entries marked
 * `// observed: works` were narrowed against a live CassavaBase deployment.
 * Other singulars follow the same naming pattern but haven't been
 * independently verified — the post-fetch `checkFilterMatchRates` heuristic
 * in `find-helpers` will surface a warning when a translation doesn't reduce
 * the result set as expected.
 */
const PLURAL_TO_SINGULAR: Record<string, Readonly<Record<string, string>>> = {
  studies: {
    commonCropNames: 'commonCropName', // observed: works
    studyTypes: 'studyType',
    programDbIds: 'programDbId', // observed: works
    programNames: 'programName',
    trialDbIds: 'trialDbId', // observed: works
    trialNames: 'trialName',
    locationNames: 'locationName',
    seasonDbIds: 'seasonDbId', // observed: works
    studyDbIds: 'studyDbId',
    studyNames: 'studyName',
    studyCodes: 'studyCode',
    studyPUIs: 'studyPUI',
    externalReferenceIds: 'externalReferenceId',
    externalReferenceSources: 'externalReferenceSource',
  },
  germplasm: {
    commonCropNames: 'commonCropName',
    germplasmDbIds: 'germplasmDbId',
    germplasmNames: 'germplasmName',
    germplasmPUIs: 'germplasmPUI',
    accessionNumbers: 'accessionNumber',
    collections: 'collection',
    synonyms: 'synonym',
    programDbIds: 'programDbId',
    trialDbIds: 'trialDbId',
    studyDbIds: 'studyDbId',
    externalReferenceIds: 'externalReferenceId',
  },
  observations: {
    studyDbIds: 'studyDbId', // observed: works
    germplasmDbIds: 'germplasmDbId',
    observationVariableDbIds: 'observationVariableDbId',
    observationUnitDbIds: 'observationUnitDbId',
    observationDbIds: 'observationDbId',
    seasonDbIds: 'seasonDbId',
    programDbIds: 'programDbId',
    trialDbIds: 'trialDbId',
    observationLevels: 'observationLevel',
  },
  observationunits: {
    studyDbIds: 'studyDbId',
    germplasmDbIds: 'germplasmDbId',
    observationUnitDbIds: 'observationUnitDbId',
    programDbIds: 'programDbId',
    trialDbIds: 'trialDbId',
    locationDbIds: 'locationDbId',
    seasonDbIds: 'seasonDbId',
    observationLevels: 'observationLevel',
  },
  locations: {
    locationDbIds: 'locationDbId',
    locationNames: 'locationName',
    countryCodes: 'countryCode',
    locationTypes: 'locationType',
    abbreviations: 'abbreviation',
  },
  variables: {
    observationVariableDbIds: 'observationVariableDbId',
    observationVariableNames: 'observationVariableName',
    observationVariablePUIs: 'observationVariablePUI',
    traitClasses: 'traitClass',
    methodDbIds: 'methodDbId',
    scaleDbIds: 'scaleDbId',
    ontologyDbIds: 'ontologyDbId',
  },
  images: {
    imageDbIds: 'imageDbId',
    observationUnitDbIds: 'observationUnitDbId',
    observationDbIds: 'observationDbId',
    studyDbIds: 'studyDbId',
    imageFileNames: 'imageFileName',
    mimeTypes: 'mimeType',
    descriptiveOntologyTerms: 'descriptiveOntologyTerm',
  },
  variants: {
    variantSetDbIds: 'variantSetDbId',
    variantDbIds: 'variantDbId',
    referenceDbIds: 'referenceDbId',
  },
  trials: {
    commonCropNames: 'commonCropName',
    programDbIds: 'programDbId',
    trialDbIds: 'trialDbId',
    trialNames: 'trialName',
  },
  programs: {
    commonCropNames: 'commonCropName',
    programDbIds: 'programDbId',
    programNames: 'programName',
  },
};

/**
 * Filters CassavaBase silently ignores entirely — drop them from the wire and
 * surface a warning so the agent stops trusting the response as if the filter
 * were honored. `searchText` is a non-spec extension we invented earlier;
 * no SGN-family server recognizes it. `locationDbIds` (and the singular
 * `locationDbId`) on `/studies` was empirically verified to leak: requesting
 * `locationDbId=3` still returned studies for other locations (Mokwa, Zaria).
 * Until we have a working alternative, narrow location-wise post-fetch via
 * `locationName` distribution or a follow-up `brapi_get_study` call.
 */
const DROPPED_FILTERS: Record<string, ReadonlySet<string>> = {
  studies: new Set(['searchText', 'locationDbIds', 'locationDbId']),
  germplasm: new Set(['searchText']),
};

/**
 * POST `/search/{noun}` routes CassavaBase advertises in `/calls` but does not
 * actually serve. Probing them in practice yields hangs, 5xx responses, or
 * empty envelopes that look successful but never carry data. Curated GET
 * tools (which the dialect already adapts to singular filters) cover the
 * same surface, so we route agents away from these dead endpoints with a
 * clear recovery hint instead of letting the request hang.
 *
 * Read endpoints we have curated GET tools for are listed; `calls` (genotype
 * data) is intentionally absent — async POST is the only realistic delivery
 * for bulk variant calls and we have no contrary evidence that route is dead.
 */
const DISABLED_SEARCH_ENDPOINTS: ReadonlySet<string> = new Set([
  'germplasm',
  'studies',
  'observations',
  'observationunits',
  'locations',
  'variables',
  'images',
  'variants',
  'variantsets',
  'samples',
  'callsets',
]);

const SGN_NOTES = [
  'SGN/Breedbase-style GET filters use singular names for many fields; this dialect translates plural BrAPI v2.1 filters before sending requests.',
  'Several advertised POST /search routes are treated as unavailable because SGN-family deployments often expose them in /calls while serving broken or hanging responses.',
] as const;

function createSgnFamilyDialect(id: string, label: string): BrapiDialect {
  return createSingularizingDialect({
    id,
    label,
    pluralToSingular: PLURAL_TO_SINGULAR,
    droppedFilters: DROPPED_FILTERS,
    disabledSearchEndpoints: DISABLED_SEARCH_ENDPOINTS,
    notes: SGN_NOTES,
  });
}

export const cassavabaseDialect = createSgnFamilyDialect('cassavabase', 'CassavaBase');

export const breedbaseDialect = createSgnFamilyDialect('breedbase', 'Breedbase/SGN');
