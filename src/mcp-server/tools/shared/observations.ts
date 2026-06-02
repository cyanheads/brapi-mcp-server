/**
 * @fileoverview Shared observation-pull logic for the phenotype tools
 * (`brapi_build_phenotype_matrix`, `brapi_germplasm_performance`). Owns the
 * study-anchored observation collection strategy and the raw/normalized row
 * shapes, so both tools pull observations identically without duplicating the
 * server-dependent fallback chain.
 *
 * Observation pull strategy (server-dependent), per study:
 *   1. Prefer `/observations?studyDbId=…` (BrAPI spec path).
 *   2. Fall back to `/observationunits?studyDbId=…` with embedded
 *      `observations[]` arrays when `/observations` returns empty or the dialect
 *      drops the study filter — required for the BrAPI Community Test Server,
 *      where `/observations?studyDbId` is not honored.
 *   3. When units carry `germplasmDbId`s but no embedded observations, pull
 *      `/observations?germplasmDbId=…` per germplasm and filter back to the
 *      study — stays study-anchored without an unbounded scan.
 *
 * `pullStudyObservations` returns `null` only when no usable observation path
 * exists for the study (caller throws its typed `no_observation_path` error);
 * an empty array means the paths exist but yielded no rows.
 *
 * @module mcp-server/tools/shared/observations
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { ServerConfig } from '@/config/server-config.js';
import { type BrapiClient, isDialectAllDropped } from '@/services/brapi-client/index.js';
import type { BrapiDialect } from '@/services/brapi-dialect/index.js';
import type { CallDescriptor } from '@/services/capability-registry/types.js';
import type { RegisteredServer } from '@/services/server-registry/index.js';
import {
  type BrapiListResult,
  companionRequestOptions,
  extractRows,
  mergeFilters,
} from './find-helpers.js';

/** Raw BrAPI `/observations` row shape (passthrough). */
export interface RawObservationRow {
  germplasmDbId?: string | null;
  germplasmName?: string | null;
  observationDbId?: string | null;
  observationVariableDbId?: string | null;
  observationVariableName?: string | null;
  season?: unknown;
  seasonDbId?: string | null;
  studyDbId?: string | null;
  value?: string | null;
  [key: string]: unknown;
}

/** Normalized observation — required fields are non-empty strings after extraction. */
export interface NormObs {
  germplasmDbId: string;
  germplasmName: string;
  observationVariableDbId: string;
  observationVariableName: string;
  /** Human season label (`"spring 2013"` / seasonDbId), when the row carries one. */
  season?: string;
  studyDbId: string;
  value: string;
}

/** Filters that scope an observation pull beyond the study anchor. */
export interface ObservationPullFilters {
  extraFilters?: Record<string, unknown> | undefined;
  germplasm?: string[] | undefined;
  variables?: string[] | undefined;
}

export interface PullStudyObservationsArgs {
  client: BrapiClient;
  config: ServerConfig;
  connection: RegisteredServer;
  ctx: Context;
  dialect: BrapiDialect;
  input: ObservationPullFilters;
  loadLimit: number;
  profile: Record<string, CallDescriptor>;
  studyDbId: string;
  warnings: string[];
}

/**
 * Collect observations for a single study, trying `/observations` first and
 * falling back to `/observationunits` (embedded, then germplasm-anchored).
 * Returns `null` when no usable path exists; `[]` when paths exist but are
 * empty.
 */
export async function pullStudyObservations(
  args: PullStudyObservationsArgs,
): Promise<NormObs[] | null> {
  const { studyDbId, input, client, connection, dialect, config, loadLimit, warnings, ctx } = args;

  // Build named filters for observations endpoint
  const namedFilters: Record<string, unknown> = {
    studyDbIds: [studyDbId],
  };
  if (input.variables?.length) namedFilters.observationVariableDbIds = input.variables;
  if (input.germplasm?.length) namedFilters.germplasmDbIds = input.germplasm;

  const merged = mergeFilters(namedFilters, input.extraFilters, warnings);

  // Apply dialect (plurals → singulars on SGN-family servers)
  const adapted = dialect.adaptGetFilters('observations', merged);
  warnings.push(...adapted.warnings);

  // When the dialect drops ALL filters for /observations (known case: the
  // brapi-test server doesn't honor studyDbId on /observations at all), skip
  // the observations path entirely and go straight to the observationunits
  // fallback rather than making an unscoped request.
  const obsFiltersDropped = adapted.dropped.length > 0 && Object.keys(adapted.filters).length === 0;
  const obsFilters = adapted.filters;

  // ---- Path 1: /observations ----
  const supportsObservations = supportsGet(args.profile, 'observations') && !obsFiltersDropped;
  if (supportsObservations) {
    const obs = await fetchObservationsPath(
      client,
      connection,
      dialect,
      config,
      obsFilters,
      loadLimit,
      ctx,
    );
    if (obs !== null && obs.length > 0) {
      return obs;
    }
    if (obs !== null && obs.length === 0) {
      // Server responded with empty for this study — note it and try fallback
      warnings.push(
        `Study '${studyDbId}': /observations returned 0 rows — trying /observationunits fallback.`,
      );
    }
  } else if (obsFiltersDropped) {
    warnings.push(
      `Study '${studyDbId}': dialect '${dialect.id}' drops all study filters for /observations — using /observationunits fallback.`,
    );
  }

  // ---- Path 2: /observationunits fallback ----
  // Two sub-strategies:
  //   2a. Units embed observations[] arrays — extract directly.
  //   2b. Units carry germplasmDbIds but observations[] is null — pull
  //       /observations?germplasmDbId=X per germplasm found in the study.
  const supportsObsUnits = supportsGet(args.profile, 'observationunits');
  if (supportsObsUnits) {
    const unitResult = await fetchObservationUnitsRaw(
      client,
      connection,
      dialect,
      config,
      studyDbId,
      loadLimit,
      ctx,
    );
    if (unitResult !== null) {
      // 2a: check for embedded observations
      const embeddedObs = extractEmbeddedObservations(unitResult, studyDbId);
      if (embeddedObs.length > 0) {
        warnings.push(
          `Study '${studyDbId}': Using /observationunits embedded observations[] fallback.`,
        );
        return embeddedObs;
      }

      // 2b: germplasm-anchored pull — units have germplasmDbIds, use them
      let germplasmIds = [
        ...new Set(
          unitResult
            .map((u) => u.germplasmDbId as string | null | undefined)
            .filter((id): id is string => typeof id === 'string' && id.length > 0),
        ),
      ];
      // When the caller scoped to specific germplasm, pull only those — avoids
      // an O(all-germplasm-in-study) fan-out for single-germplasm callers (#9).
      if (input.germplasm?.length) {
        const want = new Set(input.germplasm);
        germplasmIds = germplasmIds.filter((g) => want.has(g));
      }
      if (germplasmIds.length > 0) {
        const germObs = await fetchObservationsByGermplasm(
          client,
          connection,
          dialect,
          config,
          germplasmIds,
          studyDbId,
          loadLimit,
          ctx,
        );
        if (germObs !== null && germObs.length > 0) {
          warnings.push(
            `Study '${studyDbId}': Used /observationunits → /observations?germplasmDbId fallback because studyDbId filter is not honored on /observations.`,
          );
          return germObs;
        }
      }
    }
  }

  // Neither path yielded data. Distinguish "no path" from "empty".
  if (!supportsObservations && !obsFiltersDropped && !supportsObsUnits) {
    return null; // caller throws typed error
  }

  // Paths exist but all returned empty — treat as empty (not an error)
  warnings.push(
    `Study '${studyDbId}': No observations found via /observations or /observationunits.`,
  );
  return [];
}

function supportsGet(profile: Record<string, CallDescriptor>, service: string): boolean {
  const descriptor = profile[service];
  if (!descriptor) return false;
  if (!descriptor.methods || descriptor.methods.length === 0) return true;
  return descriptor.methods.includes('GET');
}

/** Fetch from /observations with study-anchored filters. Returns null on error. */
async function fetchObservationsPath(
  client: BrapiClient,
  connection: RegisteredServer,
  dialect: BrapiDialect,
  config: ServerConfig,
  filters: Record<string, unknown>,
  pageSize: number,
  ctx: Context,
): Promise<NormObs[] | null> {
  try {
    const opts = companionRequestOptions(connection, dialect, config, [], {
      ...(filters as Record<
        string,
        string | number | boolean | readonly (string | number)[] | undefined
      >),
      pageSize,
    });
    const envelope = await client.get<BrapiListResult<RawObservationRow> | RawObservationRow[]>(
      connection.baseUrl,
      '/observations',
      ctx,
      opts,
    );
    const rows = extractRows<RawObservationRow>(envelope.result);
    return rows.flatMap(normalizeObsRow).filter(Boolean) as NormObs[];
  } catch (err) {
    if (isDialectAllDropped(err)) throw err;
    return null;
  }
}

/** Fetch raw observationunit records (without extracting observations). Returns null on error. */
async function fetchObservationUnitsRaw(
  client: BrapiClient,
  connection: RegisteredServer,
  dialect: BrapiDialect,
  config: ServerConfig,
  studyDbId: string,
  pageSize: number,
  ctx: Context,
): Promise<Record<string, unknown>[] | null> {
  try {
    const rawFilters: Record<string, unknown> = { studyDbIds: [studyDbId] };
    const adapted = dialect.adaptGetFilters('observationunits', rawFilters);
    const obsUnitFilters = adapted.filters;

    const opts = companionRequestOptions(connection, dialect, config, [], {
      ...(obsUnitFilters as Record<
        string,
        string | number | boolean | readonly (string | number)[] | undefined
      >),
      pageSize,
    });
    const envelope = await client.get<
      BrapiListResult<Record<string, unknown>> | Record<string, unknown>[]
    >(connection.baseUrl, '/observationunits', ctx, opts);
    return extractRows<Record<string, unknown>>(envelope.result);
  } catch (err) {
    if (isDialectAllDropped(err)) throw err;
    return null;
  }
}

/** Extract embedded observations[] from observationunit records (strategy 2a). */
function extractEmbeddedObservations(
  units: Record<string, unknown>[],
  studyDbId: string,
): NormObs[] {
  const obs: NormObs[] = [];
  for (const unit of units) {
    const unitStudyDbId = (unit.studyDbId as string | null | undefined) ?? studyDbId;
    const unitGermplasmDbId = (unit.germplasmDbId as string | null | undefined) ?? 'unknown';
    const unitGermplasmName =
      typeof unit.germplasmName === 'string' && unit.germplasmName.length > 0
        ? unit.germplasmName
        : unitGermplasmDbId;
    const embedded = unit.observations;
    if (!Array.isArray(embedded)) continue;
    for (const raw of embedded) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as RawObservationRow;
      const varId = r.observationVariableDbId ?? null;
      const val = r.value ?? null;
      if (!varId || val === null || val === undefined) continue;
      const season = seasonLabel(r);
      obs.push({
        germplasmDbId: unitGermplasmDbId,
        germplasmName: unitGermplasmName,
        observationVariableDbId: String(varId),
        observationVariableName:
          typeof r.observationVariableName === 'string' && r.observationVariableName.length > 0
            ? r.observationVariableName
            : String(varId),
        studyDbId: unitStudyDbId,
        value: String(val),
        ...(season ? { season } : {}),
      });
    }
  }
  return obs;
}

/**
 * Pull observations anchored by germplasmDbId (strategy 2b). Used when
 * studyDbId filter is not honored on /observations but we know germplasmDbIds
 * in the study from the observationunits response. Filters results to only
 * observations for the target study.
 */
async function fetchObservationsByGermplasm(
  client: BrapiClient,
  connection: RegisteredServer,
  dialect: BrapiDialect,
  config: ServerConfig,
  germplasmIds: string[],
  studyDbId: string,
  pageSize: number,
  ctx: Context,
): Promise<NormObs[] | null> {
  try {
    // Pull per germplasm to stay study-anchored. Bound by pageSize per call.
    // For wide queries this is O(germplasmCount) requests but avoids an
    // unbounded full-table scan on the observations endpoint.
    const allObs: NormObs[] = [];
    for (const germId of germplasmIds) {
      const rawFilters: Record<string, unknown> = { germplasmDbIds: [germId] };
      const adapted = dialect.adaptGetFilters('observations', rawFilters);
      // Skip if the germplasm filter is also dropped
      if (adapted.dropped.length > 0 && Object.keys(adapted.filters).length === 0) continue;

      const opts = companionRequestOptions(connection, dialect, config, [], {
        ...(adapted.filters as Record<
          string,
          string | number | boolean | readonly (string | number)[] | undefined
        >),
        pageSize,
      });
      try {
        const envelope = await client.get<BrapiListResult<RawObservationRow> | RawObservationRow[]>(
          connection.baseUrl,
          '/observations',
          ctx,
          opts,
        );
        const rows = extractRows<RawObservationRow>(envelope.result);
        // Filter to only observations for the target study
        for (const row of rows) {
          if (row.studyDbId !== studyDbId) continue;
          const norm = normalizeObsRow(row);
          if (norm) allObs.push(norm);
        }
      } catch {}
    }
    return allObs;
  } catch (err) {
    if (isDialectAllDropped(err)) throw err;
    return null;
  }
}

/** Normalise a raw /observations row; drops rows missing any required field. */
export function normalizeObsRow(row: RawObservationRow): NormObs | null {
  const varId = row.observationVariableDbId ?? null;
  const germId = row.germplasmDbId ?? null;
  const studyId = row.studyDbId ?? null;
  const val = row.value ?? null;
  if (!varId || !germId || !studyId || val === null || val === undefined) return null;
  const norm: NormObs = {
    germplasmDbId: String(germId),
    germplasmName:
      typeof row.germplasmName === 'string' && row.germplasmName.length > 0
        ? row.germplasmName
        : String(germId),
    observationVariableDbId: String(varId),
    observationVariableName:
      typeof row.observationVariableName === 'string' && row.observationVariableName.length > 0
        ? row.observationVariableName
        : String(varId),
    studyDbId: String(studyId),
    value: String(val),
  };
  const season = seasonLabel(row);
  if (season) norm.season = season;
  return norm;
}

/**
 * Derive a human season label from a BrAPI observation row. Servers carry
 * season either as a nested object (`{ seasonName, year, seasonDbId }`) or a
 * flat `seasonDbId` string. Returns undefined when neither is present.
 */
export function seasonLabel(row: RawObservationRow): string | undefined {
  const s: unknown = row.season;
  if (s && typeof s === 'object') {
    const so = s as Record<string, unknown>;
    const name =
      typeof so.seasonName === 'string' && so.seasonName.length > 0 ? so.seasonName : undefined;
    const year = typeof so.year === 'number' ? so.year : undefined;
    if (name && year !== undefined) return `${name} ${year}`;
    if (name) return name;
    if (typeof so.seasonDbId === 'string' && so.seasonDbId.length > 0) return so.seasonDbId;
  } else if (typeof s === 'string' && s.length > 0) {
    return s;
  }
  if (typeof row.seasonDbId === 'string' && row.seasonDbId.length > 0) return row.seasonDbId;
  return;
}
