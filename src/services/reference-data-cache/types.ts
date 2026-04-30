/**
 * @fileoverview Reference-data shapes for FK resolution — programs, trials,
 * locations. Every non-id field is optional because BrAPI server
 * implementations vary wildly in what they populate.
 *
 * @module services/reference-data-cache/types
 */

export interface Program {
  abbreviation?: string;
  commonCropName?: string;
  documentationURL?: string;
  leadPersonDbId?: string;
  leadPersonName?: string;
  objective?: string;
  programDbId: string;
  programName?: string;
}

export interface Trial {
  active?: boolean;
  commonCropName?: string;
  documentationURL?: string;
  endDate?: string;
  programDbId?: string;
  programName?: string;
  startDate?: string;
  trialDbId: string;
  trialDescription?: string;
  trialName?: string;
}

export interface Location {
  abbreviation?: string;
  altitude?: number;
  /** BrAPI v2 GeoJSON Feature carrying [lon, lat, alt?] in geometry.coordinates. */
  coordinates?: { type?: string; geometry?: { type?: string; coordinates?: number[] } };
  countryCode?: string;
  countryName?: string;
  documentationURL?: string;
  /** Legacy WGS84 latitude — modern BrAPI v2 servers use `coordinates` instead. */
  latitude?: number;
  locationDbId: string;
  locationName?: string;
  locationType?: string;
  /** Legacy WGS84 longitude — modern BrAPI v2 servers use `coordinates` instead. */
  longitude?: number;
}
