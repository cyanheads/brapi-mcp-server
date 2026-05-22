/**
 * @fileoverview Dialect for Breeding Management System (BMS) BrAPI servers —
 * the second most-deployed BrAPI stack in the CGIAR / partner crop community
 * (CIMMYT, IRRI, ICRISAT, IITA, CIP all run BMS instances). BMS predates the
 * BrAPI v2.1 plural-filter normalization and honors only the v2.0 singular
 * filter names on GET list endpoints — same translation engine the
 * SGN/Breedbase dialects use.
 *
 * Mappings are marked `verified: false` by default: we don't have a permanent
 * BMS test endpoint pinned, so the table follows the v2.0 naming pattern but
 * hasn't been independently narrowed against a live deployment. Field-test
 * results should flip individual entries to `verified: true` as they're
 * confirmed against IRRI, ICRISAT, IITA, or CIMMYT instances.
 *
 * Known BMS quirks NOT yet wired (deferred until a pinned test endpoint is
 * available):
 *   - 1-indexed pagination on some endpoints (`page=1` for the first page).
 *     Wiring this requires a `pageOffset` mechanism on the dialect interface,
 *     not just filter translation — track separately.
 *   - Inconsistent honoring of `commonCropName` vs `crop` on study queries.
 *   - Some endpoints expose only POST `/search/{noun}` (no GET filtering).
 *     The route resolver already handles this case via capability detection;
 *     the dialect doesn't need to declare anything special.
 *
 * @module services/brapi-dialect/bms-dialect
 */

import {
  createSingularizingDialect,
  type DialectFilterMappingInput,
} from './singularizing-dialect.js';

/**
 * v2.1 plural → v2.0 singular per endpoint. All entries marked unverified
 * pending live narrowing — the inferred-mapping warning the singularizer
 * emits on downcast will surface to agents so they can validate result
 * narrowing against distributions before trusting counts.
 */
const BMS_PLURAL_TO_SINGULAR: Record<
  string,
  Readonly<Record<string, DialectFilterMappingInput>>
> = {
  studies: {
    commonCropNames: 'commonCropName',
    studyTypes: 'studyType',
    programDbIds: 'programDbId',
    programNames: 'programName',
    trialDbIds: 'trialDbId',
    trialNames: 'trialName',
    locationDbIds: 'locationDbId',
    locationNames: 'locationName',
    seasonDbIds: 'seasonDbId',
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
    studyDbIds: 'studyDbId',
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

const BMS_NOTES = [
  'BMS (Breeding Management System) honors v2.0 singular filter names on GET endpoints; this dialect translates v2.1 plurals before sending. Mappings are inferred from the naming pattern and have not been independently verified against a live deployment — check result distributions to confirm a translated filter actually narrowed the result set.',
  'Known but not yet wired: 1-indexed pagination on some BMS endpoints (page=1 for the first page) and inconsistent `commonCropName` vs `crop` handling on study queries. Reach out with field-test reports against IRRI / ICRISAT / IITA / CIMMYT instances to harden these.',
] as const;

export const bmsDialect = createSingularizingDialect({
  id: 'bms',
  label: 'BMS',
  pluralToSingular: BMS_PLURAL_TO_SINGULAR,
  notes: BMS_NOTES,
});
