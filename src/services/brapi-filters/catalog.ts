/**
 * @fileoverview Static BrAPI v2.1 filter catalog. Covers the endpoints the
 * goal-shaped tools target plus the common escape-hatch nouns. Agents use
 * this via `brapi_describe_filters` to discover valid filter names before
 * constructing `extraFilters` on `find_*` tools. Catalog entries reflect the
 * BrAPI v2.1 spec — individual servers may implement subsets; filter failures
 * surface through the upstream 400 body, not a static check.
 *
 * @module services/brapi-filters/catalog
 */

import type { FilterCatalog, FilterDescriptor } from './types.js';

const PAGINATION_FILTERS: FilterDescriptor[] = [
  {
    name: 'page',
    type: 'integer',
    description: 'Zero-indexed page number.',
    example: '0',
  },
  {
    name: 'pageSize',
    type: 'integer',
    description: 'Rows per page. Cap varies by server; 1000 is a safe upper bound.',
    example: '100',
  },
];

const STUDIES: FilterDescriptor[] = [
  {
    name: 'commonCropNames',
    type: 'string[]',
    description: 'Common crop names (e.g. "Cassava", "Wheat"). Matches /commoncropnames.',
    example: 'Cassava',
  },
  {
    name: 'studyTypes',
    type: 'string[]',
    description: 'Study types — e.g. "Yield Trial", "Phenotyping".',
    example: 'Yield Trial',
  },
  {
    name: 'programDbIds',
    type: 'string[]',
    description: 'Filter to studies within specific breeding programs.',
    example: 'program-1',
  },
  {
    name: 'programNames',
    type: 'string[]',
    description: 'Filter by program display name.',
    example: 'Cassava Breeding',
  },
  {
    name: 'studyDbIds',
    type: 'string[]',
    description: 'Restrict to specific studies by DbId.',
    example: 'study-42',
  },
  {
    name: 'studyNames',
    type: 'string[]',
    description: 'Restrict by study display name.',
    example: 'IBA-2022-YT',
  },
  {
    name: 'trialDbIds',
    type: 'string[]',
    description: 'Restrict to studies inside specific trials.',
    example: 'trial-1',
  },
  {
    name: 'trialNames',
    type: 'string[]',
    description: 'Restrict by trial display name.',
    example: 'West Africa Yield Trial',
  },
  {
    name: 'locationDbIds',
    type: 'string[]',
    description: 'Restrict to studies at specific locations / research stations.',
    example: 'loc-ibadan',
  },
  {
    name: 'locationNames',
    type: 'string[]',
    description: 'Restrict by location display name.',
    example: 'NCSU Station 1',
  },
  {
    name: 'seasonDbIds',
    type: 'string[]',
    description: 'Restrict to specific seasons.',
    example: '2022',
  },
  {
    name: 'active',
    type: 'boolean',
    description: 'Only active (or only inactive) studies.',
    example: 'true',
  },
  {
    name: 'studyCodes',
    type: 'string[]',
    description: 'Short alphanumeric study codes.',
    example: 'IBA-YT-22',
  },
  {
    name: 'studyPUIs',
    type: 'string[]',
    description: 'Persistent unique identifiers (DOIs, URIs) for the studies.',
    example: 'doi:10.25739/abc123',
  },
  {
    name: 'externalReferenceIds',
    type: 'string[]',
    description: 'External reference identifier for cross-system joins.',
    example: 'ext-ref-1',
  },
  {
    name: 'externalReferenceSources',
    type: 'string[]',
    description: 'Source system name paired with externalReferenceIds.',
    example: 'GRIN',
  },
];

const GERMPLASM: FilterDescriptor[] = [
  {
    name: 'germplasmDbIds',
    type: 'string[]',
    description: 'Restrict to specific germplasm by DbId.',
    example: 'germplasm-1',
  },
  {
    name: 'germplasmNames',
    type: 'string[]',
    description: 'Restrict by germplasm display name.',
    example: 'TME419',
  },
  {
    name: 'germplasmPUIs',
    type: 'string[]',
    description: 'Persistent unique identifiers (DOIs, URIs).',
    example: 'doi:10.25739/germplasm-xyz',
  },
  {
    name: 'commonCropNames',
    type: 'string[]',
    description: 'Crop names the germplasm belongs to.',
    example: 'Cassava',
  },
  {
    name: 'accessionNumbers',
    type: 'string[]',
    description: 'Accession numbers from a genebank or seed repository.',
    example: 'TMe-419',
  },
  {
    name: 'collections',
    type: 'string[]',
    description: 'Collection the germplasm is curated under.',
    example: 'IITA Core',
  },
  {
    name: 'genus',
    type: 'string',
    description: 'Botanical genus.',
    example: 'Manihot',
  },
  {
    name: 'species',
    type: 'string',
    description: 'Botanical species epithet.',
    example: 'esculenta',
  },
  {
    name: 'synonyms',
    type: 'string[]',
    description: 'Known synonyms / alternate names.',
    example: 'TME419',
  },
  {
    name: 'familyCode',
    type: 'string',
    description: 'Pedigree family identifier.',
    example: 'TME-F1',
  },
  {
    name: 'programDbIds',
    type: 'string[]',
    description: 'Programs the germplasm is associated with.',
    example: 'program-1',
  },
  {
    name: 'trialDbIds',
    type: 'string[]',
    description: 'Trials the germplasm has been tested in.',
    example: 'trial-1',
  },
  {
    name: 'studyDbIds',
    type: 'string[]',
    description: 'Studies the germplasm has been tested in.',
    example: 'study-1',
  },
  {
    name: 'externalReferenceIds',
    type: 'string[]',
    description: 'External reference identifier for cross-system joins.',
    example: 'ext-ref-1',
  },
];

const VARIABLES: FilterDescriptor[] = [
  {
    name: 'observationVariableDbIds',
    type: 'string[]',
    description: 'Restrict to specific variables.',
    example: 'var-dry-matter',
  },
  {
    name: 'observationVariableNames',
    type: 'string[]',
    description: 'Restrict by variable display name.',
    example: 'Dry Matter %',
  },
  {
    name: 'observationVariablePUIs',
    type: 'string[]',
    description: 'Persistent ontology URIs.',
    example: 'CO_334:0000013',
  },
  {
    name: 'traitClasses',
    type: 'string[]',
    description: 'Trait class (e.g. "Agronomic", "Morphological").',
    example: 'Agronomic',
  },
  {
    name: 'methodDbIds',
    type: 'string[]',
    description: 'Measurement method identifiers.',
    example: 'method-1',
  },
  {
    name: 'scaleDbIds',
    type: 'string[]',
    description: 'Measurement scale identifiers.',
    example: 'scale-percent',
  },
  {
    name: 'ontologyDbIds',
    type: 'string[]',
    description: 'Ontology identifiers — scope the search to a specific ontology.',
    example: 'CO_334',
  },
  {
    name: 'commonCropName',
    type: 'string',
    description: 'Crop context for the variable.',
    example: 'Cassava',
  },
  {
    name: 'studyDbId',
    type: 'string',
    description: 'Return only variables exposed inside a specific study.',
    example: 'study-42',
  },
];

const OBSERVATIONS: FilterDescriptor[] = [
  {
    name: 'observationDbIds',
    type: 'string[]',
    description: 'Restrict to specific observations.',
    example: 'obs-1',
  },
  {
    name: 'observationUnitDbIds',
    type: 'string[]',
    description: 'Restrict to specific observation units (plots, plants, samples).',
    example: 'ou-1',
  },
  {
    name: 'observationVariableDbIds',
    type: 'string[]',
    description: 'Restrict to specific variables (traits).',
    example: 'var-dry-matter',
  },
  {
    name: 'studyDbIds',
    type: 'string[]',
    description: 'Restrict to specific studies.',
    example: 'study-1',
  },
  {
    name: 'germplasmDbIds',
    type: 'string[]',
    description: 'Restrict to specific germplasm.',
    example: 'germplasm-1',
  },
  {
    name: 'seasonDbIds',
    type: 'string[]',
    description: 'Restrict by season.',
    example: '2022',
  },
  {
    name: 'observationLevels',
    type: 'string[]',
    description: 'Observation unit level — e.g. "plot", "plant", "field".',
    example: 'plot',
  },
  {
    name: 'programDbIds',
    type: 'string[]',
    description: 'Restrict by program.',
    example: 'program-1',
  },
  {
    name: 'trialDbIds',
    type: 'string[]',
    description: 'Restrict by trial.',
    example: 'trial-1',
  },
  {
    name: 'observationTimeStampRangeStart',
    type: 'date',
    description: 'ISO 8601 start of the observation-time window.',
    example: '2022-01-01T00:00:00Z',
  },
  {
    name: 'observationTimeStampRangeEnd',
    type: 'date',
    description: 'ISO 8601 end of the observation-time window.',
    example: '2022-12-31T23:59:59Z',
  },
];

const IMAGES: FilterDescriptor[] = [
  {
    name: 'imageDbIds',
    type: 'string[]',
    description: 'Restrict to specific images.',
    example: 'img-1',
  },
  {
    name: 'imageFileNames',
    type: 'string[]',
    description: 'Filter by uploaded file name.',
    example: 'plot-042.jpg',
  },
  {
    name: 'observationUnitDbIds',
    type: 'string[]',
    description: 'Images associated with specific observation units.',
    example: 'ou-1',
  },
  {
    name: 'observationDbIds',
    type: 'string[]',
    description: 'Images attached to specific observations.',
    example: 'obs-1',
  },
  {
    name: 'studyDbIds',
    type: 'string[]',
    description: 'Restrict to specific studies.',
    example: 'study-1',
  },
  {
    name: 'mimeTypes',
    type: 'string[]',
    description: 'MIME filter — e.g. "image/jpeg", "image/png".',
    example: 'image/jpeg',
  },
  {
    name: 'descriptiveOntologyTerms',
    type: 'string[]',
    description: 'Ontology tags attached to the image.',
    example: 'CO_334:plot',
  },
];

const VARIANTS: FilterDescriptor[] = [
  {
    name: 'variantSetDbIds',
    type: 'string[]',
    description: 'Restrict to specific variant sets.',
    example: 'vset-1',
  },
  {
    name: 'variantDbIds',
    type: 'string[]',
    description: 'Restrict to specific variants.',
    example: 'variant-1',
  },
  {
    name: 'referenceDbIds',
    type: 'string[]',
    description: 'Reference sequence identifiers.',
    example: 'ref-chr1',
  },
  {
    name: 'referenceName',
    type: 'string',
    description: 'Reference display name — e.g. "chr01".',
    example: 'chr1',
  },
  {
    name: 'start',
    type: 'integer',
    description: 'Inclusive start position on the reference (1-based).',
    example: '1000',
  },
  {
    name: 'end',
    type: 'integer',
    description: 'Exclusive end position on the reference.',
    example: '5000',
  },
];

const LOCATIONS: FilterDescriptor[] = [
  {
    name: 'locationDbIds',
    type: 'string[]',
    description: 'Restrict to specific locations.',
    example: 'loc-1',
  },
  {
    name: 'locationNames',
    type: 'string[]',
    description: 'Restrict by display name.',
    example: 'NCSU Station 1',
  },
  {
    name: 'locationTypes',
    type: 'string[]',
    description: 'Location type — e.g. "Research Station", "Field".',
    example: 'Research Station',
  },
  {
    name: 'countryCodes',
    type: 'string[]',
    description: 'ISO 3166-1 alpha-3 country codes.',
    example: 'USA',
  },
  {
    name: 'abbreviations',
    type: 'string[]',
    description: 'Short location abbreviations.',
    example: 'NCSU-1',
  },
];

const SPEC_BASE = 'https://brapi.org/specification';

const CATALOG: Record<string, Omit<FilterCatalog, 'endpoint'>> = {
  studies: {
    specReference: `${SPEC_BASE}/core/get-studies`,
    filters: withPagination(STUDIES),
  },
  germplasm: {
    specReference: `${SPEC_BASE}/germplasm/get-germplasm`,
    filters: withPagination(GERMPLASM),
  },
  variables: {
    specReference: `${SPEC_BASE}/phenotyping/get-variables`,
    filters: withPagination(VARIABLES),
  },
  observations: {
    specReference: `${SPEC_BASE}/phenotyping/get-observations`,
    filters: withPagination(OBSERVATIONS),
  },
  images: {
    specReference: `${SPEC_BASE}/phenotyping/get-images`,
    filters: withPagination(IMAGES),
  },
  variants: {
    specReference: `${SPEC_BASE}/genotyping/get-variants`,
    filters: withPagination(VARIANTS),
  },
  locations: {
    specReference: `${SPEC_BASE}/core/get-locations`,
    filters: withPagination(LOCATIONS),
  },
};

function withPagination(filters: FilterDescriptor[]): FilterDescriptor[] {
  return [...filters, ...PAGINATION_FILTERS];
}

export function getFilterCatalog(endpoint: string): FilterCatalog | undefined {
  const entry = CATALOG[endpoint];
  if (!entry) return;
  return { endpoint, ...entry };
}

export function listFilterEndpoints(): string[] {
  return Object.keys(CATALOG).sort();
}
