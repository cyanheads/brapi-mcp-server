/**
 * @fileoverview `brapi_get_study` — fetch a single study by DbId, resolve
 * program/trial/location FKs via ReferenceDataCache, and attach cheap
 * `pageSize=1` counts (observations, observation units, variables) as
 * response companions so the agent can decide where to drill next.
 *
 * @module mcp-server/tools/definitions/brapi-get-study.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, requestCancelled } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getBrapiClient } from '@/services/brapi-client/index.js';
import { resolveDialect } from '@/services/brapi-dialect/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import { getReferenceDataCache } from '@/services/reference-data-cache/index.js';
import {
  AliasInput,
  appendPassthroughLines,
  asStringArray,
  buildRequestOptions,
  companionRequestOptions,
  extractCoordinates,
  fetchTotalCount,
  fetchValidatedScopedCount,
  isUpstreamNotFound,
  NonBlankString,
  requireRegisteredConnection,
} from '../shared/find-helpers.js';
import { literal } from '../shared/markdown-literals.js';

const StudySchema = z
  .object({
    studyDbId: z.string().describe('Server-side identifier for the study.'),
    studyName: z.string().nullish().describe('Display name.'),
    studyType: z.string().nullish().describe('E.g. "Yield Trial", "Phenotyping".'),
    studyDescription: z.string().nullish().describe('Free-form description.'),
    programDbId: z.string().nullish().describe('FK to the owning program.'),
    programName: z.string().nullish().describe('Display name of the owning program.'),
    trialDbId: z.string().nullish().describe('FK to the owning trial.'),
    trialName: z.string().nullish().describe('Display name of the owning trial.'),
    locationDbId: z.string().nullish().describe('FK to the study site.'),
    locationName: z.string().nullish().describe('Display name of the study site.'),
    commonCropName: z.string().nullish().describe('Common crop name (e.g. "Maize", "Wheat").'),
    seasons: z
      .array(
        z
          .string()
          .nullable()
          .describe(
            'Season identifier — typically a year like "2022". Nullable: some Breedbase deployments emit a null entry when the study is missing a season.',
          ),
      )
      .nullish()
      .describe('Season identifiers this study spans.'),
    active: z.boolean().nullish().describe('True while the study is open for data capture.'),
    startDate: z.string().nullish().describe('ISO 8601 start date.'),
    endDate: z.string().nullish().describe('ISO 8601 end date.'),
    studyCode: z.string().nullish().describe('Short code or alias for the study.'),
    studyPUI: z.string().nullish().describe('Persistent unique identifier (URI).'),
  })
  .passthrough();

const ProgramSchema = z
  .object({
    programDbId: z.string().describe('Server-side identifier for the program.'),
    programName: z.string().nullish().describe('Display name.'),
    commonCropName: z.string().nullish().describe('Common crop name this program targets.'),
    abbreviation: z.string().nullish().describe('Short abbreviation.'),
    leadPersonName: z.string().nullish().describe('Name of the program lead.'),
    documentationURL: z.string().nullish().describe('URL pointing at program documentation.'),
  })
  .passthrough();

const TrialSchema = z
  .object({
    trialDbId: z.string().describe('Server-side identifier for the trial.'),
    trialName: z.string().nullish().describe('Display name.'),
    programDbId: z.string().nullish().describe('FK to the owning program.'),
    programName: z.string().nullish().describe('Display name of the owning program.'),
    commonCropName: z.string().nullish().describe('Common crop name.'),
    startDate: z.string().nullish().describe('ISO 8601 start date.'),
    endDate: z.string().nullish().describe('ISO 8601 end date.'),
    active: z.boolean().nullish().describe('True while the trial is ongoing.'),
    trialDescription: z.string().nullish().describe('Free-form description.'),
  })
  .passthrough();

const LocationSchema = z
  .object({
    locationDbId: z.string().describe('Server-side identifier for the location.'),
    locationName: z.string().nullish().describe('Display name.'),
    abbreviation: z.string().nullish().describe('Short abbreviation.'),
    countryCode: z.string().nullish().describe('ISO 3166-1 alpha-3 country code.'),
    countryName: z.string().nullish().describe('Display name of the country.'),
    locationType: z
      .string()
      .nullish()
      .describe('Type of location (e.g. "Research Station", "Field").'),
    latitude: z
      .number()
      .nullish()
      .describe(
        'WGS84 latitude in decimal degrees (legacy field; modern servers use coordinates).',
      ),
    longitude: z
      .number()
      .nullish()
      .describe(
        'WGS84 longitude in decimal degrees (legacy field; modern servers use coordinates).',
      ),
    altitude: z.number().nullish().describe('Altitude in meters above sea level.'),
    coordinates: z
      .object({})
      .passthrough()
      .nullish()
      .describe('BrAPI v2 GeoJSON Feature carrying [lon, lat, alt?] in geometry.coordinates.'),
  })
  .passthrough();

const OutputSchema = z.object({
  alias: z.string().describe('Connection alias the call used.'),
  study: StudySchema.describe('Canonical study record as returned by `/studies/{id}`.'),
  program: ProgramSchema.optional().describe(
    'Resolved program record (when the study or parent trial identifies a program and the FK lookup succeeded).',
  ),
  trial: TrialSchema.optional().describe(
    'Resolved trial record (when the study has a trialDbId and the FK lookup succeeded).',
  ),
  location: LocationSchema.optional().describe(
    'Resolved location record (when the study has a locationDbId and the FK lookup succeeded).',
  ),
  observationCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Total observations recorded against this study. Omitted (with a warning) when the upstream server cannot scope the count to the study — never reported as the server-wide total.',
    ),
  observationUnitCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Total observation units (plots, plants, samples) in this study.'),
  variableCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Total observation variables (traits) measured in this study. Omitted (with a warning) when the upstream server cannot scope the count to the study — never reported as the server-wide total.',
    ),
  warnings: z.array(z.string()).describe('Advisory messages — failed FK lookups, missing counts.'),
});

type Output = z.infer<typeof OutputSchema>;

export const brapiGetStudy = tool('brapi_get_study', {
  description:
    'Fetch a single study by DbId with its program, trial, and location records resolved where those lookups succeed. Response includes cheap observation/observation-unit/variable counts as drill-down signals.',
  annotations: { readOnlyHint: true, idempotentHint: true },
  errors: [
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'An uncaught BrAPI data request exhausted retries after HTTP 429',
      recovery:
        'Wait before retrying brapi_get_study; reduce concurrent requests to this BrAPI server.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'unknown_alias',
      code: JsonRpcErrorCode.NotFound,
      when: 'No connection is registered under the requested alias, and the server has no base URL configured for it to connect on first use',
      recovery:
        'Run brapi_connect with this alias and a `baseUrl`, or pass an alias the brapi_connect description lists as built-in or operator-configured, before calling brapi_get_study.',
      thrownBy: 'service',
    },
    {
      reason: 'auth_token_exchange_failed',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Connecting the alias on first use, the SGN or OAuth token exchange against the BrAPI /token endpoint failed',
      recovery:
        'Ask the operator to check the credentials configured for this alias and that the server exposes /token, or run brapi_connect with credentials in `auth`.',
      thrownBy: 'service',
    },
    {
      reason: 'auth_no_access_token',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Connecting the alias on first use, the token endpoint answered without returning an access token',
      recovery:
        'Ask the operator to check that the credentials configured for this alias are valid and that the upstream IdP issues access tokens for this grant.',
      thrownBy: 'service',
    },
    {
      reason: 'capability_discovery_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Neither /serverinfo nor /calls listed any call, and at least one of them timed out, was unreachable, or answered 429 or a 5xx other than 501, so nothing was cached',
      recovery:
        'The BrAPI server is slow or unreachable right now. Retry brapi_get_study in a minute; if it keeps failing, the server may be down.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unauthorized',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'The BrAPI server answered HTTP 401: it requires credentials, or rejected the ones sent',
      recovery:
        'Run brapi_connect with credentials in `auth`, or ask the operator to set server-side credentials for this alias, then retry brapi_get_study.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The BrAPI server answered HTTP 403: the credentials sent, or their absence, lack access',
      recovery:
        'Run brapi_connect with credentials that have access, or ask the operator to set server-side credentials for this alias that do, then retry brapi_get_study.',
      thrownBy: 'service',
    },
    {
      reason: 'alias_base_url_invalid',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'The base URL configured on the server for this alias is not an absolute http(s) URL, or carries credentials',
      recovery:
        'Ask the operator to set the base URL configured for this alias to an absolute http(s) URL, then retry brapi_get_study.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'private_address_blocked',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The base URL configured for this alias, or its token URL, is on a private or reserved address this server may not reach',
      recovery:
        'Ask the operator to point this alias at a publicly routable host, or to allow private addresses on this server, then retry brapi_get_study.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'study_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Upstream returned no study record for the requested DbId',
      recovery:
        'Verify the studyDbId on the target server, or run brapi_find_studies to discover valid IDs.',
    },
  ] as const,
  input: z.object({
    studyDbId: NonBlankString.describe('Study identifier.'),
    alias: AliasInput,
  }),
  output: OutputSchema,

  async handler(input, ctx) {
    const capabilities = getCapabilityRegistry();
    const client = getBrapiClient();
    const referenceData = getReferenceDataCache();
    const config = getServerConfig();

    const connection = await requireRegisteredConnection(ctx, input.alias);

    const capabilityLookup: { auth?: typeof connection.resolvedAuth } = {};
    if (connection.resolvedAuth) capabilityLookup.auth = connection.resolvedAuth;
    await capabilities.ensure(
      connection.baseUrl,
      { service: 'studies', method: 'GET' },
      ctx,
      capabilityLookup,
    );

    const dialect = await resolveDialect(connection, ctx, capabilityLookup);

    const warnings: string[] = [];
    const referenceLookup: {
      auth?: typeof connection.resolvedAuth;
      dialect: typeof dialect;
      warnings: string[];
    } = { dialect, warnings };
    if (connection.resolvedAuth) referenceLookup.auth = connection.resolvedAuth;

    let studyEnv: Awaited<ReturnType<typeof client.get<Record<string, unknown>>>>;
    try {
      studyEnv = await client.get<Record<string, unknown>>(
        connection.baseUrl,
        `/studies/${encodeURIComponent(input.studyDbId)}`,
        ctx,
        buildRequestOptions(connection, undefined, { singleton: true }),
      );
    } catch (err) {
      if (isUpstreamNotFound(err)) {
        throw ctx.fail(
          'study_not_found',
          `Study '${input.studyDbId}' not found on ${connection.baseUrl}.`,
          { studyDbId: input.studyDbId, baseUrl: connection.baseUrl },
        );
      }
      throw err;
    }
    const study = studyEnv.result;
    if (!study || typeof study !== 'object' || !study.studyDbId) {
      throw ctx.fail(
        'study_not_found',
        `Study '${input.studyDbId}' not found on ${connection.baseUrl}.`,
        { studyDbId: input.studyDbId, baseUrl: connection.baseUrl },
      );
    }
    /** Copy only normalized program fields, preserving the singleton's nulls and raw metadata. */
    const normalizedStudy = dialect.normalizeRow?.('studies', study);
    for (const key of ['programDbId', 'programName'] as const) {
      if (study[key] === undefined && normalizedStudy?.[key] !== undefined) {
        study[key] = normalizedStudy[key];
      }
    }

    const profile = await capabilities.profile(connection.baseUrl, ctx, capabilityLookup);
    const supportsObservations = profile.supported.observations?.methods?.includes('GET') ?? false;
    const supportsObservationUnits =
      profile.supported.observationunits?.methods?.includes('GET') ?? false;
    const supportsVariables = profile.supported.variables?.methods?.includes('GET') ?? false;

    const programDbId = asString(study.programDbId);
    const trialDbId = asString(study.trialDbId);
    const locationDbId = asString(study.locationDbId);

    const [initialPrograms, trials, locations, obsCount, obsUnitCount, variableCount] =
      await Promise.all([
        programDbId
          ? referenceData
              .getPrograms(connection.baseUrl, [programDbId], ctx, referenceLookup)
              .catch((err) => recordWarning(warnings, 'program FK lookup failed', err, ctx.signal))
          : Promise.resolve(undefined),
        trialDbId
          ? referenceData
              .getTrials(connection.baseUrl, [trialDbId], ctx, referenceLookup)
              .catch((err) => recordWarning(warnings, 'trial FK lookup failed', err, ctx.signal))
          : Promise.resolve(undefined),
        locationDbId
          ? referenceData
              .getLocations(connection.baseUrl, [locationDbId], ctx, referenceLookup)
              .catch((err) => recordWarning(warnings, 'location FK lookup failed', err, ctx.signal))
          : Promise.resolve(undefined),
        supportsObservations
          ? fetchValidatedScopedCount({
              client,
              connection,
              ctx,
              dialect,
              label: 'observationCount',
              path: '/observations',
              scopeDescription: 'study filter',
              scopeFilter: { studyDbIds: [input.studyDbId] },
              service: 'observations',
              warnings,
            }).catch((err) =>
              recordWarning(warnings, 'observation count probe failed', err, ctx.signal),
            )
          : Promise.resolve(undefined),
        // observationUnitCount stays a plain probe — the test server (and the
        // SGN family) honor studyDbId on /observationunits, so it's reliably
        // study-scoped. The dialect is threaded through the client here so the
        // plural→singular translation happens at the wire edge.
        supportsObservationUnits
          ? fetchTotalCount(
              client,
              connection.baseUrl,
              '/observationunits',
              ctx,
              companionRequestOptions(connection, dialect, config, warnings, {
                studyDbIds: [input.studyDbId],
                pageSize: 1,
              }),
            ).catch((err) =>
              recordWarning(warnings, 'observation-unit count probe failed', err, ctx.signal),
            )
          : Promise.resolve(undefined),
        supportsVariables
          ? fetchValidatedScopedCount({
              client,
              connection,
              ctx,
              dialect,
              label: 'variableCount',
              path: '/variables',
              scopeDescription: 'study filter',
              // /variables historically responded to singular `studyDbId` on SGN
              // deployments — keep the singular key so the dialect (which carries
              // no `variables.studyDbIds → studyDbId` entry) passes it through
              // rather than dropping it; the baseline cross-check still catches
              // servers (e.g. the BrAPI test server) that accept but ignore it.
              scopeFilter: { studyDbId: input.studyDbId },
              service: 'variables',
              warnings,
            }).catch((err) =>
              recordWarning(warnings, 'variable count probe failed', err, ctx.signal),
            )
          : Promise.resolve(undefined),
      ]);

    const trial = trialDbId && trials instanceof Map ? trials.get(trialDbId) : undefined;
    const effectiveProgramDbId = programDbId ?? asString(trial?.programDbId);
    const programs =
      !programDbId && effectiveProgramDbId
        ? await referenceData
            .getPrograms(connection.baseUrl, [effectiveProgramDbId], ctx, referenceLookup)
            .catch((err) => recordWarning(warnings, 'program FK lookup failed', err, ctx.signal))
        : initialPrograms;

    const result: Output = {
      alias: connection.alias,
      study: study as z.infer<typeof StudySchema>,
      warnings,
    };
    if (effectiveProgramDbId && programs instanceof Map) {
      const program = programs.get(effectiveProgramDbId);
      if (program) result.program = program as z.infer<typeof ProgramSchema>;
    }
    if (trial) result.trial = trial as z.infer<typeof TrialSchema>;
    if (locationDbId && locations instanceof Map) {
      const location = locations.get(locationDbId);
      if (location) result.location = location as z.infer<typeof LocationSchema>;
    }
    if (typeof obsCount === 'number') result.observationCount = obsCount;
    if (typeof obsUnitCount === 'number') result.observationUnitCount = obsUnitCount;
    if (typeof variableCount === 'number') result.variableCount = variableCount;
    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    const study = result.study;
    const STUDY_RENDERED = new Set([
      'studyDbId',
      'studyName',
      'studyType',
      'studyDescription',
      'programDbId',
      'programName',
      'trialDbId',
      'trialName',
      'locationDbId',
      'locationName',
      'commonCropName',
      'seasons',
      'active',
      'startDate',
      'endDate',
      'studyCode',
      'studyPUI',
    ]);
    lines.push(literal`# ${study.studyName ?? study.studyDbId}`);
    lines.push('');
    lines.push(literal`- **studyDbId:** \`${study.studyDbId}\``);
    if (study.studyName) lines.push(literal`- **studyName:** ${study.studyName}`);
    if (study.studyType) lines.push(literal`- **studyType:** ${study.studyType}`);
    if (study.studyDescription)
      lines.push(literal`- **studyDescription:** ${study.studyDescription}`);
    if (study.programDbId) lines.push(literal`- **programDbId:** ${study.programDbId}`);
    if (study.programName) lines.push(literal`- **programName:** ${study.programName}`);
    if (study.trialDbId) lines.push(literal`- **trialDbId:** ${study.trialDbId}`);
    if (study.trialName) lines.push(literal`- **trialName:** ${study.trialName}`);
    if (study.locationDbId) lines.push(literal`- **locationDbId:** ${study.locationDbId}`);
    if (study.locationName) lines.push(literal`- **locationName:** ${study.locationName}`);
    if (study.commonCropName) lines.push(literal`- **commonCropName:** ${study.commonCropName}`);
    const cleanSeasons = asStringArray(study.seasons);
    if (cleanSeasons?.length) lines.push(literal`- **seasons:** ${cleanSeasons.join(', ')}`);
    if (study.active != null) lines.push(literal`- **active:** ${study.active}`);
    if (study.startDate) lines.push(literal`- **startDate:** ${study.startDate}`);
    if (study.endDate) lines.push(literal`- **endDate:** ${study.endDate}`);
    if (study.studyCode) lines.push(literal`- **studyCode:** ${study.studyCode}`);
    if (study.studyPUI) lines.push(literal`- **studyPUI:** ${study.studyPUI}`);
    appendPassthroughLines(lines, study as Record<string, unknown>, STUDY_RENDERED);
    lines.push(literal`- **alias:** ${result.alias}`);

    if (result.program) {
      lines.push('');
      lines.push('## Program');
      renderKeyValues(lines, result.program);
    }
    if (result.trial) {
      lines.push('');
      lines.push('## Trial');
      renderKeyValues(lines, result.trial);
    }
    if (result.location) {
      lines.push('');
      lines.push('## Location');
      renderKeyValues(lines, result.location);
      const coords = extractCoordinates(result.location);
      if (coords && result.location.latitude == null && result.location.longitude == null) {
        lines.push(literal`- **latitude:** ${coords.latitude}`);
        lines.push(literal`- **longitude:** ${coords.longitude}`);
        if (coords.altitude != null && result.location.altitude == null) {
          lines.push(literal`- **altitude:** ${coords.altitude}`);
        }
      }
    }

    lines.push('');
    lines.push('## Drill-down signals');
    lines.push(literal`- observationCount: ${result.observationCount ?? '—'}`);
    lines.push(literal`- observationUnitCount: ${result.observationUnitCount ?? '—'}`);
    lines.push(literal`- variableCount: ${result.variableCount ?? '—'}`);

    if (result.warnings.length > 0) {
      lines.push('');
      lines.push('## Warnings');
      for (const w of result.warnings) lines.push(literal`- ${w}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function recordWarning(
  warnings: string[],
  label: string,
  err: unknown,
  signal: AbortSignal,
): undefined {
  if (signal.aborted) throw requestCancelled('Study companion lookup cancelled by caller.');
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === JsonRpcErrorCode.RequestCancelled
  )
    throw err;
  warnings.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
  return;
}

function renderKeyValues(lines: string[], record: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      if (value.some((entry) => entry !== null && typeof entry === 'object')) {
        appendPassthroughLines(lines, { [key]: value }, new Set());
      } else {
        lines.push(literal`- **${key}:** ${value.join(', ')}`);
      }
    } else if (typeof value === 'object') {
      lines.push(literal`- **${key}:** ${JSON.stringify(value)}`);
    } else {
      lines.push(literal`- **${key}:** ${value}`);
    }
  }
}
