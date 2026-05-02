/**
 * @fileoverview Dialect for the BrAPI Community Test Server
 * (`https://test-server.brapi.org/brapi/v2`). Despite advertising BrAPI v2.1,
 * its GET list endpoints honor only the older v2.0 **singular** filter names;
 * the v2.1 plurals (`studyDbIds`, `germplasmDbIds`, …) are silently dropped
 * and the server returns the unfiltered set. Empirically verified on
 * 2026-05-01 against `/studies`, `/germplasm`, `/observations`, `/variables`,
 * `/locations`, plus per-endpoint singular probes — the singular forms filter
 * correctly across the board. Same shape as the SGN family, just on a
 * different server, so the same singularizing engine applies.
 *
 * POST `/search/{noun}` routes work as expected (sync responses, multi-value
 * arrays honored), so they are NOT marked disabled — multi-value queries can
 * still escalate to /search.
 *
 * `searchText` (a non-spec extension we used to send) is silently ignored on
 * `/germplasm`; `observationLevel(s)` is silently ignored on `/observations`
 * in both forms. Both go in the drop list with a loud warning so the agent
 * stops trusting the response as if the filter were honored.
 *
 * @module services/brapi-dialect/brapi-test-dialect
 */

import { createSingularizingDialect } from './singularizing-dialect.js';

/**
 * Plural BrAPI v2.1 filter key → singular form the test server honors. Keyed
 * by endpoint resource segment. Entries marked `// observed: works` were
 * narrowed against a live test-server.brapi.org probe; the remaining mappings
 * follow the same v2.0 naming pattern but haven't been independently verified
 * — the post-fetch `checkFilterMatchRates` heuristic in `find-helpers` will
 * surface a warning when a translation doesn't reduce the result set as
 * expected.
 */
const PLURAL_TO_SINGULAR: Record<string, Readonly<Record<string, string>>> = {
  studies: {
    studyDbIds: 'studyDbId', // observed: works
    studyNames: 'studyName',
    studyTypes: 'studyType',
    commonCropNames: 'commonCropName',
    programDbIds: 'programDbId', // observed: works
    programNames: 'programName',
    trialDbIds: 'trialDbId', // observed: works
    trialNames: 'trialName',
    locationDbIds: 'locationDbId', // observed: works
    locationNames: 'locationName',
    seasonDbIds: 'seasonDbId',
    germplasmDbIds: 'germplasmDbId', // observed: works
    studyCodes: 'studyCode',
    studyPUIs: 'studyPUI',
    externalReferenceIds: 'externalReferenceId',
    externalReferenceSources: 'externalReferenceSource',
  },
  germplasm: {
    germplasmDbIds: 'germplasmDbId', // observed: works
    germplasmNames: 'germplasmName',
    germplasmPUIs: 'germplasmPUI',
    accessionNumbers: 'accessionNumber',
    commonCropNames: 'commonCropName', // observed: works
    collections: 'collection',
    synonyms: 'synonym',
    programDbIds: 'programDbId',
    trialDbIds: 'trialDbId',
    studyDbIds: 'studyDbId',
    externalReferenceIds: 'externalReferenceId',
  },
  observations: {
    // studyDbIds intentionally absent — see DROPPED_FILTERS below (broken on
    // both GET singular and POST /search plural — neither form actually
    // filters; both return either 0 unconditionally or the unfiltered set).
    germplasmDbIds: 'germplasmDbId', // observed: works
    observationVariableDbIds: 'observationVariableDbId', // observed: works
    observationUnitDbIds: 'observationUnitDbId', // observed: works
    observationDbIds: 'observationDbId', // observed: works
    seasonDbIds: 'seasonDbId',
    programDbIds: 'programDbId',
    trialDbIds: 'trialDbId',
  },
  observationunits: {
    studyDbIds: 'studyDbId',
    germplasmDbIds: 'germplasmDbId',
    observationUnitDbIds: 'observationUnitDbId',
    programDbIds: 'programDbId',
    trialDbIds: 'trialDbId',
    locationDbIds: 'locationDbId',
    seasonDbIds: 'seasonDbId',
  },
  locations: {
    locationDbIds: 'locationDbId', // observed: works
    locationNames: 'locationName',
    countryCodes: 'countryCode',
    locationTypes: 'locationType',
    abbreviations: 'abbreviation',
  },
  variables: {
    observationVariableDbIds: 'observationVariableDbId', // observed: works
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
 * Filters the test server doesn't honor in either form — drop with a warning.
 * Empirically verified on 2026-05-01.
 *
 *   /germplasm?searchText=X      → totalCount unchanged regardless of X
 *   /observations?observationLevel(s)=plot → totalCount unchanged (rows
 *     carry empty observationLevel; filter never narrows)
 *   /observations?studyDbId(s)=X → broken in BOTH forms: GET singular returns
 *     0 unconditionally regardless of value, GET plural is ignored and returns
 *     the full set, POST /search/observations { studyDbIds: ["X"] } also
 *     returns 0 unconditionally. The join is broken upstream — no filter
 *     shape recovers it. Drop both forms; agents should scope by germplasm,
 *     observationUnit, or observationVariable (all of which DO filter).
 */
const DROPPED_FILTERS: Record<string, ReadonlySet<string>> = {
  germplasm: new Set(['searchText']),
  observations: new Set(['observationLevels', 'observationLevel', 'studyDbIds', 'studyDbId']),
};

export const brapiTestDialect = createSingularizingDialect({
  id: 'brapi-test',
  label: 'BrAPI Community Test Server',
  pluralToSingular: PLURAL_TO_SINGULAR,
  droppedFilters: DROPPED_FILTERS,
  notes: [
    'GET list endpoints honor only the BrAPI v2.0 singular filter names (studyDbId, germplasmDbId, …); the v2.1 plurals are silently ignored upstream. This dialect translates plurals to singular and downcasts multi-value arrays with a warning. POST /search/{noun} routes honor the v2.1 plurals correctly and remain the path for multi-value queries.',
    'searchText on /germplasm, observationLevel(s) on /observations, and studyDbId(s) on /observations are not honored upstream — all are dropped from the wire with a warning. /observations?studyDbId(s) is broken on this server in both GET and POST /search; scope observation queries by germplasm, observationUnit, or observationVariable instead.',
    'Location GeoJSON Point coordinates may be stored as [lat, lon, alt] instead of the GeoJSON-standard [lon, lat, alt]; brapi_find_locations retries bbox filtering with swapped axes when needed.',
  ],
});
