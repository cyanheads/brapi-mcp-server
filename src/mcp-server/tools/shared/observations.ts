/**
 * @fileoverview Shared observation-pull logic for the phenotype tools
 * (`brapi_build_phenotype_matrix`, `brapi_germplasm_performance`). Owns the
 * study-anchored observation collection strategy, its failure contract, and the
 * raw/normalized row shapes, so both tools pull observations identically.
 *
 * SGN-family servers with advertised observation-unit GET use embedded
 * observations first: `/observations` can omit zero values. The unit walk
 * pages against raw unit totals and caps matching child observations.
 * Other servers retain this per-study strategy:
 *   1. `/observations?studyDbId=…` (BrAPI spec path), paged against the
 *      upstream `totalCount` in `BRAPI_PAGE_SIZE` pages (at most
 *      `MAX_SPILLOVER_PAGES`) and filtered client-side to the study and the
 *      requested germplasm / variables — some servers (Breedbase) ignore
 *      `germplasmDbId` there, and a server that ignores `studyDbId` too returns
 *      its whole observation set, so a match can sit on any page. The walk
 *      stops at `loadLimit` matching rows. A stop before `totalCount` (that
 *      limit, the page cap, a failed later page, a page repeating the previous
 *      one, or the call deadline) keeps the collected rows and reports a
 *      truncation with the rows examined.
 *   2. Fall back to `/observationunits?studyDbId=…` with embedded
 *      `observations[]` arrays when `/observations` returns no rows, fails with
 *      a non-timeout error, or the dialect drops the study filter — required
 *      for the BrAPI Community Test Server, where `/observations?studyDbId` is
 *      not honored.
 *   3. When units carry `germplasmDbId`s but no embedded observations, pull
 *      `/observations?germplasmDbId=…` per germplasm and filter back to the
 *      study, stopping at the first failed request.
 *
 * Failure contract: these requests are primary data — `BRAPI_REQUEST_TIMEOUT_MS`
 * per attempt, 429/5xx retried, every request bounded by the client's call
 * deadline (`CALL_DEADLINE_MS` from the tool call's start). A timeout is not
 * retried and ends the study's pull without a fallback request. A study is empty only on a definitive answer (no rows on
 * any path with no error along the way, or 0 observation units); otherwise its
 * first error is thrown and the consuming tool applies its own policy.
 *
 * `pullStudyObservations` returns `null` only when no usable observation path
 * exists for the study (caller throws its typed `no_observation_path` error).
 *
 * @module mcp-server/tools/shared/observations
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, requestCancelled } from '@cyanheads/mcp-ts-core/errors';
import type { ServerConfig } from '@/config/server-config.js';
import {
  type BrapiClient,
  type BrapiEnvelope,
  type BrapiRequestOptions,
  CALL_DEADLINE_REASON,
  isDialectAllDropped,
} from '@/services/brapi-client/index.js';
import { type BrapiDialect, prefersEmbeddedObservations } from '@/services/brapi-dialect/index.js';
import type { CallDescriptor } from '@/services/capability-registry/types.js';
import type { RegisteredServer } from '@/services/server-registry/index.js';
import {
  type BrapiListResult,
  buildRequestOptions,
  extractRows,
  firstRowKey,
  MAX_SPILLOVER_PAGES,
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

/** Why and where a study's `/observations` walk stopped before the upstream total. */
export interface StudyTruncation {
  /** What stopped the walk — the loadLimit, the page cap, a failed, empty, or repeated page. */
  reason: string;
  /** Rows examined before stopping (matching or not). */
  scanned: number;
  /** The upstream's `totalCount` for the study, when it reported one. */
  totalCount?: number;
}

/**
 * A study's pulled observations — only the study's rows, narrowed to the
 * caller's germplasm / variables — plus the truncation when the walk stopped early.
 */
export interface StudyPull {
  observations: NormObs[];
  /** The upstream rows behind `observations`, in the same order, for post-hoc filter checks. */
  rawRows: RawObservationRow[];
  truncation?: StudyTruncation;
}

export interface PullStudyObservationsArgs {
  client: BrapiClient;
  config: ServerConfig;
  connection: RegisteredServer;
  ctx: Context;
  dialect: BrapiDialect;
  input: ObservationPullFilters;
  /** Cap on matching observations collected for the study. */
  loadLimit: number;
  profile: Record<string, CallDescriptor>;
  studyDbId: string;
  warnings: string[];
}

/**
 * Collect a study's observations from advertised embedded units on SGN.
 * Other servers try `/observations`, then the embedded or germplasm fallback.
 * Returns `null` when no usable path exists; throws the study's first error when
 * no path gave a definitive answer.
 */
export async function pullStudyObservations(
  args: PullStudyObservationsArgs,
): Promise<StudyPull | null> {
  const { studyDbId, input, dialect, warnings, ctx } = args;

  const namedFilters: Record<string, unknown> = { studyDbIds: [studyDbId] };
  if (input.variables?.length) namedFilters.observationVariableDbIds = input.variables;
  if (input.germplasm?.length) namedFilters.germplasmDbIds = input.germplasm;
  const merged = mergeFilters(namedFilters, input.extraFilters, warnings);

  if (prefersEmbeddedObservations(dialect, args.profile)) {
    const keep = matcher(input, studyDbId);
    const pulled = await collectEmbeddedObservations({
      ...args,
      filters: merged,
      keep: (row) => {
        const norm = normalizeObsRow(row);
        return norm !== null && keep(norm);
      },
    });
    return {
      rawRows: pulled.rawRows,
      observations: pulled.rawRows
        .map(normalizeObsRow)
        .filter((row): row is NormObs => row !== null),
      ...(pulled.truncation && { truncation: pulled.truncation }),
    };
  }

  // Apply dialect (plurals → singulars on SGN-family servers)
  const adapted = dialect.adaptGetFilters('observations', merged);
  warnings.push(...adapted.warnings);

  // When the dialect drops ALL filters for /observations (known case: the
  // brapi-test server doesn't honor studyDbId on /observations at all), skip
  // the observations path entirely and go straight to the observationunits
  // fallback rather than making an unscoped request.
  const obsFiltersDropped = adapted.dropped.length > 0 && Object.keys(adapted.filters).length === 0;
  const supportsObservations = supportsGet(args.profile, 'observations') && !obsFiltersDropped;
  const supportsObsUnits = supportsGet(args.profile, 'observationunits');
  if (!supportsObservations && !obsFiltersDropped && !supportsObsUnits) return null;

  /** The first non-fatal error on the chain; thrown when no later path answers definitively. */
  let firstError: unknown;

  // ---- Path 1: /observations, paged ----
  if (supportsObservations) {
    try {
      const { observations, rawRows, scanned, otherStudyRows, truncation } = await scanObservations(
        args,
        adapted.filters,
      );
      if (otherStudyRows > 0) {
        warnings.push(
          `Study '${studyDbId}': /observations returned ${otherStudyRows} rows from other studies, left out — the server appears to ignore studyDbId there.`,
        );
      }
      if (scanned > 0) {
        if (!truncation) return { observations, rawRows };
        warnings.push(
          `Study '${studyDbId}': observation scan ${describeTruncation(truncation)} — results for this study are partial.`,
        );
        return { observations, rawRows, truncation };
      }
      warnings.push(
        `Study '${studyDbId}': /observations returned 0 rows — trying /observationunits fallback.`,
      );
    } catch (err) {
      if (isDialectAllDropped(err) || isTimeout(err) || ctx.signal.aborted) throw err;
      firstError = err;
    }
  } else if (obsFiltersDropped) {
    warnings.push(
      `Study '${studyDbId}': dialect '${dialect.id}' drops all study filters for /observations — using /observationunits fallback.`,
    );
  }

  const obsFailure =
    firstError === undefined ? '' : ` after /observations failed (${describeError(firstError)})`;

  // ---- Path 2: /observationunits fallback ----
  // Two sub-strategies:
  //   2a. Units embed observations[] arrays — extract directly.
  //   2b. Units carry germplasmDbIds but observations[] is null — pull
  //       /observations?germplasmDbId=X per germplasm found in the study.
  if (supportsObsUnits) {
    let germPull: Omit<StudyPull, 'truncation'> = { observations: [], rawRows: [] };
    try {
      const units = await fetchObservationUnits(args);
      if (units.length === 0) {
        warnings.push(
          firstError === undefined
            ? `Study '${studyDbId}': No observations found via /observations or /observationunits.`
            : `Study '${studyDbId}': /observations failed (${describeError(firstError)}) and /observationunits lists 0 observation units — reporting the study as empty.`,
        );
        return { observations: [], rawRows: [] };
      }

      const { embeddedCount, ...embedded } = extractEmbeddedObservations(
        units,
        studyDbId,
        matcher(input, studyDbId),
      );
      if (embeddedCount > 0) {
        warnings.push(
          `Study '${studyDbId}': Using /observationunits embedded observations[] fallback${obsFailure}.`,
        );
        return embedded;
      }

      let germplasmIds = [
        ...new Set(
          units
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
        germPull = await fetchObservationsByGermplasm(args, germplasmIds);
      }
    } catch (err) {
      if (isDialectAllDropped(err) || ctx.signal.aborted) throw err;
      throw firstError ?? err;
    }
    if (germPull.observations.length > 0) {
      warnings.push(
        `Study '${studyDbId}': Used /observationunits → /observations?germplasmDbId fallback${obsFailure || ' because studyDbId filter is not honored on /observations'}.`,
      );
      return germPull;
    }
  }

  if (firstError !== undefined) throw firstError;
  warnings.push(
    `Study '${studyDbId}': No observations found via /observations or /observationunits.`,
  );
  return { observations: [], rawRows: [] };
}

/**
 * Per-study outcome from {@link pullObservationsForStudies}. Carries the pull
 * result, the `null` no-observation-path sentinel, or the thrown `error`, plus
 * the study's own warnings buffer. The caller merges the warnings in input order
 * and applies its own failure policy — the helper itself is policy-neutral.
 */
export interface StudyObservationOutcome {
  /** The error {@link pullStudyObservations} threw for this study, when it threw. */
  error?: unknown;
  /**
   * Observations for the study, or `null` when no usable observation path exists
   * (mirrors {@link pullStudyObservations}'s `null` return). Also `null` when the
   * pull threw — disambiguate via `error`.
   */
  observations: NormObs[] | null;
  /** The upstream rows behind `observations`, in the same order; empty when `observations` is `null`. */
  rawRows: RawObservationRow[];
  studyDbId: string;
  /** Set when the study's `/observations` walk stopped before the upstream total. */
  truncation?: StudyTruncation;
  /**
   * Warnings this study's pull produced. Kept per-study (not a shared array) so
   * concurrent pulls never interleave their warnings — the caller concatenates
   * them in input order for a deterministic result.
   */
  warnings: string[];
}

/**
 * Shared inputs for {@link pullObservationsForStudies} — everything a per-study
 * pull needs except the `studyDbId` and its warnings buffer (both per-study).
 */
export interface PullObservationsForStudiesArgs {
  client: BrapiClient;
  config: ServerConfig;
  connection: RegisteredServer;
  ctx: Context;
  dialect: BrapiDialect;
  /**
   * When true, stop launching further batches once a batch contains a study with
   * no observation path — `brapi_build_phenotype_matrix` aborts on it, so pulling
   * the rest would be wasted upstream load. A study that threw never stops the
   * fan-out. When false (`brapi_germplasm_performance`), every study is pulled.
   */
  failFast: boolean;
  input: ObservationPullFilters;
  loadLimit: number;
  profile: Record<string, CallDescriptor>;
  studyDbIds: string[];
}

/**
 * Pull observations for many studies with bounded concurrency, returning
 * per-study outcomes in **input order** — never completion order.
 *
 * Studies are processed in sequential batches of `config.maxConcurrentRequests`;
 * within a batch the per-study pulls run concurrently, so a slow study does not
 * serialize the rest of its batch. `Promise.all` over internally-caught tasks
 * preserves input order and never rejects: a single study's failure is folded
 * into its outcome rather than aborting the batch or losing the others' results.
 * Studies whose turn comes after the call deadline fail without a request.
 *
 * Callers own the failure policy — `brapi_germplasm_performance` warns and
 * continues; `brapi_build_phenotype_matrix` warns per failed study, fails when
 * every study failed, and raises `no_observation_path` on a study with no path.
 * Input-order reassembly is load-bearing: both tools derive deterministic
 * column/row ordering from study encounter order. A caller cancellation rejects
 * the whole call rather than returning the studies that finished first.
 *
 * @param pull - the per-study pull, injectable for tests; defaults to {@link pullStudyObservations}.
 */
export async function pullObservationsForStudies(
  args: PullObservationsForStudiesArgs,
  pull: (a: PullStudyObservationsArgs) => Promise<StudyPull | null> = pullStudyObservations,
): Promise<StudyObservationOutcome[]> {
  const { studyDbIds, config, ctx, failFast, ...shared } = args;
  const batchSize = Math.max(1, config.maxConcurrentRequests);
  const outcomes: StudyObservationOutcome[] = [];

  for (let start = 0; start < studyDbIds.length && !ctx.signal.aborted; start += batchSize) {
    const batch = studyDbIds.slice(start, start + batchSize);
    const batchOutcomes = await Promise.all(
      batch.map(async (studyDbId): Promise<StudyObservationOutcome> => {
        const warnings: string[] = [];
        try {
          const result = await pull({ ...shared, config, ctx, studyDbId, warnings });
          if (result === null) return { studyDbId, observations: null, rawRows: [], warnings };
          return {
            studyDbId,
            observations: result.observations,
            rawRows: result.rawRows,
            warnings,
            ...(result.truncation && { truncation: result.truncation }),
          };
        } catch (error) {
          return { studyDbId, observations: null, rawRows: [], error, warnings };
        }
      }),
    );
    outcomes.push(...batchOutcomes);
    if (failFast && batchOutcomes.some((o) => o.observations === null && o.error === undefined)) {
      break;
    }
  }

  if (ctx.signal.aborted) throw requestCancelled('Observation pull cancelled by the caller.');
  return outcomes;
}

/** Render a truncation for a warning or notice: rows scanned vs total, and why. */
export function describeTruncation(t: StudyTruncation): string {
  const scanned =
    t.totalCount === undefined
      ? `${t.scanned} rows (no upstream total)`
      : `${t.scanned} of ${t.totalCount} rows`;
  return `stopped after ${scanned}: ${t.reason}`;
}

/**
 * Render a pull error for a warning: the HTTP status (and attempt count) for an
 * upstream HTTP error, the error message otherwise.
 */
export function describeError(err: unknown): string {
  const status = httpStatusOf(err);
  if (status === undefined) return err instanceof Error ? err.message : String(err);
  const attempts = err instanceof McpError ? err.data?.retryAttempts : undefined;
  return typeof attempts === 'number' && attempts > 1
    ? `HTTP ${status} after ${attempts} attempts`
    : `HTTP ${status}`;
}

function httpStatusOf(err: unknown): number | undefined {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    const status = e instanceof McpError ? e.data?.status : undefined;
    if (typeof status === 'number') return status;
  }
  return;
}

function isTimeout(err: unknown): boolean {
  return err instanceof McpError && err.code === JsonRpcErrorCode.Timeout;
}

function supportsGet(profile: Record<string, CallDescriptor>, service: string): boolean {
  const descriptor = profile[service];
  if (!descriptor) return false;
  if (!descriptor.methods || descriptor.methods.length === 0) return true;
  return descriptor.methods.includes('GET');
}

/** A bounded embedded-unit scan; totals count raw units, never child observations. */
export interface EmbeddedObservationPull {
  appliedFilters: Record<string, unknown>;
  cappedStudyDbIds: string[];
  pagesFetched: number;
  rawRows: RawObservationRow[];
  scanned: number;
  studyDbIds: string[];
  totalCount?: number;
  truncation?: StudyTruncation;
}

/**
 * Walk advertised SGN units with embedded observations. Parent metadata fills
 * missing child fields; actual observation IDs alone identify repeated records.
 * First-page failures propagate, later failures retain a disclosed partial set.
 */
export async function collectEmbeddedObservations(args: {
  client: BrapiClient;
  config: ServerConfig;
  connection: RegisteredServer;
  ctx: Context;
  dialect: BrapiDialect;
  filters: Record<string, unknown>;
  loadLimit: number;
  perStudyLimit?: number;
  pageLimit?: number;
  warnings: string[];
  keep: (row: RawObservationRow) => boolean;
}): Promise<EmbeddedObservationPull> {
  const { client, connection, ctx, config, dialect, warnings } = args;
  const unitFilters = Object.fromEntries(
    Object.entries(args.filters).filter(([key, value]) => {
      if (!Array.isArray(value) || value.length <= 1) return true;
      warnings.push(
        `Filter '${key}' has multiple values; omitted from the singular units request and checked against returned observations.`,
      );
      return false;
    }),
  );
  const adapted = dialect.adaptGetFilters('observationunits', unitFilters);
  warnings.push(...adapted.warnings);
  const rawRows: RawObservationRow[] = [];
  const studies = new Set<string>();
  const seen = new Set<string>();
  const studyCounts = new Map<string, number>();
  const cappedStudies = new Set<string>();
  let scanned = 0;
  let pagesFetched = 0;
  let totalCount: number | undefined;
  let previousPage: string | undefined;
  let missingEmbeddedUnits = 0;
  const result = (): EmbeddedObservationPull => ({
    rawRows,
    studyDbIds: [...studies],
    scanned,
    pagesFetched,
    cappedStudyDbIds: [...cappedStudies],
    appliedFilters: { ...adapted.filters, includeObservations: true },
    ...(totalCount !== undefined && { totalCount }),
  });
  const stopped = (reason: string): EmbeddedObservationPull => {
    const truncation = { reason, scanned, ...(totalCount !== undefined && { totalCount }) };
    warnings.push(
      `Embedded observation scan ${describeTruncation(truncation)} — coverage is partial.`,
    );
    return { ...result(), truncation };
  };
  const completed = (): EmbeddedObservationPull =>
    missingEmbeddedUnits > 0
      ? stopped(
          `${missingEmbeddedUnits} units did not supply observations arrays; embedded measurements are unavailable for those units`,
        )
      : result();
  const pageLimit = args.pageLimit ?? MAX_SPILLOVER_PAGES;
  for (let page = 0; page < pageLimit; page++) {
    let envelope: BrapiEnvelope<BrapiListResult<Record<string, unknown>>>;
    try {
      envelope = await client.get(
        connection.baseUrl,
        '/observationunits',
        ctx,
        buildRequestOptions(
          connection,
          {
            ...(adapted.filters as QueryParams),
            includeObservations: true,
            pageSize: config.pageSize,
            page,
          },
          { dialect, retryOnTimeout: false },
        ),
      );
    } catch (error) {
      if (page === 0 || ctx.signal.aborted || isDialectAllDropped(error)) throw error;
      return stopped(`page ${page + 1} failed (${describeError(error)})`);
    }
    pagesFetched++;
    const units = extractRows<Record<string, unknown>>(envelope.result);
    if (page === 0) totalCount = envelope.metadata?.pagination?.totalCount;
    const signature = JSON.stringify(units);
    if (page > 0 && units.length > 0 && signature === previousPage)
      return stopped(`page ${page + 1} repeated page ${page}`);
    previousPage = signature;
    for (const unit of units) {
      scanned++;
      const scopedGermplasm = args.filters.germplasmDbIds ?? args.filters.germplasmDbId;
      const unitInScope =
        scopedGermplasm === undefined ||
        (Array.isArray(scopedGermplasm) ? scopedGermplasm : [scopedGermplasm]).includes(
          unit.germplasmDbId,
        );
      if (unitInScope && typeof unit.studyDbId === 'string') studies.add(unit.studyDbId);
      if (!Array.isArray(unit.observations)) {
        missingEmbeddedUnits++;
        continue;
      }
      const { observations: _children, ...parent } = unit;
      for (const child of unit.observations) {
        if (!child || typeof child !== 'object' || Array.isArray(child)) continue;
        const row: RawObservationRow = { ...parent };
        for (const [key, value] of Object.entries(child))
          if (value !== undefined && value !== null) row[key] = value;
        if (
          row.observationLevel == null &&
          unit.observationUnitPosition &&
          typeof unit.observationUnitPosition === 'object'
        ) {
          const level = (unit.observationUnitPosition as Record<string, unknown>).observationLevel;
          if (level && typeof level === 'object')
            row.observationLevel = (level as Record<string, unknown>).levelName;
        }
        if (typeof row.value === 'number') row.value = String(row.value);
        if (!args.keep(row)) continue;
        if (typeof row.studyDbId === 'string') studies.add(row.studyDbId);
        const id = row.observationDbId;
        if (typeof id === 'string' && id.length > 0) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        if (args.perStudyLimit !== undefined && typeof row.studyDbId === 'string') {
          const count = studyCounts.get(row.studyDbId) ?? 0;
          if (count >= args.perStudyLimit) {
            cappedStudies.add(row.studyDbId);
            continue;
          }
          studyCounts.set(row.studyDbId, count + 1);
        }
        if (rawRows.length >= args.loadLimit)
          return stopped(`reached loadLimit (${args.loadLimit}) matching observations`);
        rawRows.push(row);
      }
    }
    if (units.length === 0) {
      if (totalCount === undefined || scanned >= totalCount) return completed();
      return stopped(`page ${page + 1} came back empty`);
    }
    if (totalCount === undefined ? units.length < config.pageSize : scanned >= totalCount)
      return completed();
    if (rawRows.length >= args.loadLimit)
      return stopped(`reached loadLimit (${args.loadLimit}) matching observations`);
  }
  return stopped(`reached the ${pageLimit}-page cap`);
}

/** Shared additive coverage contract; contributor fields retain their original meaning. */
export const ObservationCoverageSchema = z
  .object({
    partial: z
      .boolean()
      .describe('True when failed, truncated, or unprocessed work leaves coverage incomplete.'),
    discoveryLimited: z
      .boolean()
      .optional()
      .describe(
        'True when generic study discovery reached its bound; additional studies may exist.',
      ),
    studies: z
      .array(
        z
          .object({
            studyDbId: z
              .string()
              .describe('Requested study, or a study encountered in scoped units.'),
            status: z
              .enum(['contributed', 'empty', 'failed', 'partial', 'unprocessed'])
              .describe('Outcome of collecting this study; partial may contain observations.'),
            observationCount: z
              .number()
              .int()
              .nonnegative()
              .describe('Matching observations collected for this study.'),
            reason: z.string().optional().describe('Why collection failed or remained incomplete.'),
          })
          .describe('One study collection outcome.'),
      )
      .describe('Per-study outcomes in requested or encounter order.'),
    scan: z
      .object({
        complete: z
          .boolean()
          .describe('Whether the scoped unit walk exhausted its authoritative total.'),
        scannedUnits: z
          .number()
          .int()
          .nonnegative()
          .describe('Raw upstream units examined, including repeated IDs.'),
        pagesFetched: z
          .number()
          .int()
          .nonnegative()
          .describe('Unit pages returned before stopping.'),
        totalUnits: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Upstream raw unit total, when reported.'),
        reason: z.string().optional().describe('Bound or failure that stopped the unit walk.'),
      })
      .optional()
      .describe('Scoped-unit scan coverage; unseen studies are unknown after an incomplete walk.'),
  })
  .describe('Collection coverage, independent of the number of contributing studies.');

/** Reconcile requested studies against actual outcomes without treating empty as failed. */
export function studyCoverage(
  studies: string[],
  outcomes: StudyObservationOutcome[],
): z.infer<typeof ObservationCoverageSchema> {
  const byId = new Map(outcomes.map((outcome) => [outcome.studyDbId, outcome]));
  const rows = studies.map((studyDbId) => {
    const outcome = byId.get(studyDbId);
    const deadlineSkipped =
      outcome?.error instanceof McpError &&
      outcome.error.data?.reason === CALL_DEADLINE_REASON &&
      outcome.error.message.includes('was not sent');
    const status =
      !outcome || deadlineSkipped
        ? 'unprocessed'
        : outcome.error !== undefined || outcome.observations === null
          ? 'failed'
          : outcome.truncation
            ? 'partial'
            : outcome.observations.length
              ? 'contributed'
              : 'empty';
    const reason =
      outcome?.error !== undefined ? describeError(outcome.error) : outcome?.truncation?.reason;
    return {
      studyDbId,
      status,
      observationCount: outcome?.observations?.length ?? 0,
      ...(reason !== undefined && { reason }),
    } as z.infer<typeof ObservationCoverageSchema>['studies'][number];
  });
  return {
    partial: rows.some(
      (row) => row.status === 'failed' || row.status === 'partial' || row.status === 'unprocessed',
    ),
    studies: rows,
  };
}

/** Render every coverage outcome on clients that only forward formatted content. */
export function renderObservationCoverage(
  coverage: z.infer<typeof ObservationCoverageSchema>,
): string[] {
  return [
    `Coverage: ${coverage.partial ? 'partial' : 'complete'} · ${coverage.studies.filter((s) => s.observationCount > 0).length} contributing / ${coverage.studies.length} known studies`,
    ...(coverage.discoveryLimited !== undefined
      ? [`Study discovery limited: ${coverage.discoveryLimited}`]
      : []),
    ...coverage.studies.map(
      (s) =>
        `- ${s.studyDbId}: ${s.status} (${s.observationCount} observations)${s.reason ? ` — ${s.reason}` : ''}`,
    ),
    ...(coverage.scan
      ? [
          `Unit scan: ${coverage.scan.scannedUnits}${coverage.scan.totalUnits === undefined ? '' : ` / ${coverage.scan.totalUnits}`} units · ${coverage.scan.pagesFetched} pages · ${coverage.scan.complete ? 'complete' : 'partial'}${coverage.scan.reason ? ` — ${coverage.scan.reason}` : ''}`,
        ]
      : []),
  ];
}

/**
 * Request options for an observation-pull request: no retry on timeout. The
 * client holds every request to the call deadline, so a request after it is
 * never sent.
 */
function pullRequestOptions(
  args: PullStudyObservationsArgs,
  params: BrapiRequestOptions['params'],
): BrapiRequestOptions {
  return buildRequestOptions(args.connection, params, {
    dialect: args.dialect,
    retryOnTimeout: false,
  });
}

type QueryParams = Record<
  string,
  string | number | boolean | readonly (string | number)[] | undefined
>;

/**
 * Keeps the study's rows matching the caller's germplasm / variable subsets —
 * servers may ignore any of those filters, `studyDbId` included.
 */
function matcher(input: ObservationPullFilters, studyDbId: string): (o: NormObs) => boolean {
  const germplasm = input.germplasm?.length ? new Set(input.germplasm) : undefined;
  const variables = input.variables?.length ? new Set(input.variables) : undefined;
  return (o) =>
    o.studyDbId === studyDbId &&
    (!germplasm || germplasm.has(o.germplasmDbId)) &&
    (!variables || variables.has(o.observationVariableDbId));
}

/**
 * Walk `/observations` for the study against `totalCount`, keeping rows that
 * match the study and the caller's subsets, until the study is exhausted or
 * `loadLimit` matching rows are collected. `scanned` counts the rows examined,
 * so a stop mid-page never reads as a full page scanned. A first-page error is
 * thrown (the study's failure); a later stop — including a page that repeats
 * the previous one, from a server ignoring `page` — keeps the collected rows
 * and returns a truncation.
 */
async function scanObservations(
  args: PullStudyObservationsArgs,
  filters: Record<string, unknown>,
): Promise<StudyPull & { otherStudyRows: number; scanned: number }> {
  const { client, connection, config, loadLimit, ctx, studyDbId } = args;
  const pageSize = config.pageSize;
  const keep = matcher(args.input, studyDbId);
  const observations: NormObs[] = [];
  const rawRows: RawObservationRow[] = [];
  let scanned = 0;
  let otherStudyRows = 0;
  let totalCount: number | undefined;
  let previousFirstRow: string | undefined;
  const stopped = (reason: string) => ({
    observations,
    rawRows,
    scanned,
    otherStudyRows,
    truncation: { reason, scanned, ...(totalCount !== undefined && { totalCount }) },
  });

  for (let page = 0; page < MAX_SPILLOVER_PAGES; page++) {
    let envelope: BrapiEnvelope<BrapiListResult<RawObservationRow>>;
    try {
      envelope = await client.get<BrapiListResult<RawObservationRow>>(
        connection.baseUrl,
        '/observations',
        ctx,
        pullRequestOptions(args, {
          ...(filters as QueryParams),
          pageSize,
          page,
        }),
      );
    } catch (err) {
      if (page === 0 || ctx.signal.aborted) throw err;
      return stopped(`page ${page + 1} failed (${describeError(err)})`);
    }
    const rows = extractRows<RawObservationRow>(envelope.result);
    if (page === 0) {
      const tc = envelope.metadata?.pagination?.totalCount;
      if (typeof tc === 'number') totalCount = tc;
    }
    const firstRow = firstRowKey(rows);
    if (page > 0 && firstRow !== undefined && firstRow === previousFirstRow) {
      return stopped(
        `page ${page + 1} repeated page ${page} — the server is not paging /observations`,
      );
    }
    previousFirstRow = firstRow;
    for (const row of rows) {
      scanned++;
      const norm = normalizeObsRow(row);
      if (norm && norm.studyDbId !== studyDbId) otherStudyRows++;
      if (!norm || !keep(norm)) continue;
      if (observations.length >= loadLimit) {
        return stopped(`reached loadLimit (${loadLimit}) matching rows`);
      }
      observations.push(norm);
      rawRows.push(row);
    }
    if (rows.length === 0) {
      if (page === 0 || totalCount === undefined || scanned >= totalCount) break;
      return stopped(`page ${page + 1} came back empty`);
    }
    const exhausted = totalCount === undefined ? rows.length < pageSize : scanned >= totalCount;
    if (exhausted) break;
    if (observations.length >= loadLimit) {
      return stopped(`reached loadLimit (${loadLimit}) matching rows`);
    }
    if (page === MAX_SPILLOVER_PAGES - 1) {
      return stopped(`reached the ${MAX_SPILLOVER_PAGES}-page cap`);
    }
  }
  return { observations, rawRows, scanned, otherStudyRows };
}

/** Fetch the study's observationunit records (without extracting observations). */
async function fetchObservationUnits(
  args: PullStudyObservationsArgs,
): Promise<Record<string, unknown>[]> {
  const { client, connection, dialect, studyDbId, loadLimit, ctx } = args;
  const adapted = dialect.adaptGetFilters('observationunits', { studyDbIds: [studyDbId] });
  const envelope = await client.get<
    BrapiListResult<Record<string, unknown>> | Record<string, unknown>[]
  >(
    connection.baseUrl,
    '/observationunits',
    ctx,
    pullRequestOptions(args, {
      ...(adapted.filters as QueryParams),
      pageSize: loadLimit,
    }),
  );
  return extractRows<Record<string, unknown>>(envelope.result);
}

/**
 * Extract embedded observations[] from observationunit records (strategy 2a),
 * keeping those `keep` accepts. `embeddedCount` counts every embedded
 * observation before that filter — any at all means the server answers this way.
 */
function extractEmbeddedObservations(
  units: Record<string, unknown>[],
  studyDbId: string,
  keep: (o: NormObs) => boolean,
): Omit<StudyPull, 'truncation'> & { embeddedCount: number } {
  const observations: NormObs[] = [];
  const rawRows: RawObservationRow[] = [];
  let embeddedCount = 0;
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
      embeddedCount++;
      const season = seasonLabel(r);
      const norm: NormObs = {
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
      };
      if (!keep(norm)) continue;
      observations.push(norm);
      rawRows.push(r);
    }
  }
  return { observations, rawRows, embeddedCount };
}

/**
 * Pull observations anchored by germplasmDbId (strategy 2b), one request per
 * germplasm, keeping only the target study's rows that match the caller's
 * subsets. Used when the studyDbId filter is not honored on /observations but
 * the study's units name its germplasm. Stops at the first failed request — the
 * error propagates and the study fails rather than reporting a partial
 * germplasm set as complete.
 */
async function fetchObservationsByGermplasm(
  args: PullStudyObservationsArgs,
  germplasmIds: string[],
): Promise<Omit<StudyPull, 'truncation'>> {
  const { client, connection, dialect, studyDbId, loadLimit, ctx } = args;
  const keep = matcher(args.input, studyDbId);
  const observations: NormObs[] = [];
  const rawRows: RawObservationRow[] = [];
  for (const germId of germplasmIds) {
    const adapted = dialect.adaptGetFilters('observations', { germplasmDbIds: [germId] });
    // Skip if the germplasm filter is also dropped
    if (adapted.dropped.length > 0 && Object.keys(adapted.filters).length === 0) continue;
    const envelope = await client.get<BrapiListResult<RawObservationRow> | RawObservationRow[]>(
      connection.baseUrl,
      '/observations',
      ctx,
      pullRequestOptions(args, {
        ...(adapted.filters as QueryParams),
        pageSize: loadLimit,
      }),
    );
    for (const row of extractRows<RawObservationRow>(envelope.result)) {
      const norm = normalizeObsRow(row);
      if (!norm || !keep(norm)) continue;
      observations.push(norm);
      rawRows.push(row);
    }
  }
  return { observations, rawRows };
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
