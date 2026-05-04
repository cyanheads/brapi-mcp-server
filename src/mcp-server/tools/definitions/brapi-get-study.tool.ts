/**
 * @fileoverview `brapi_get_study` — fetch a single study by DbId, resolve
 * program/trial/location FKs via ReferenceDataCache, and attach cheap
 * `pageSize=1` counts (observations, observation units, variables) as
 * response companions so the agent can decide where to drill next.
 *
 * @module mcp-server/tools/definitions/brapi-get-study.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getBrapiClient } from '@/services/brapi-client/index.js';
import { resolveDialect } from '@/services/brapi-dialect/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import { getReferenceDataCache } from '@/services/reference-data-cache/index.js';
import { DEFAULT_ALIAS, getServerRegistry } from '@/services/server-registry/index.js';
import {
  AliasInput,
  appendPassthroughLines,
  asStringArray,
  buildRequestOptions,
  companionRequestOptions,
  extractCoordinates,
  isUpstreamNotFound,
} from '../shared/find-helpers.js';

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
  alias: z.string().describe('Alias of the registered BrAPI connection the call used.'),
  study: StudySchema.describe('Canonical study record as returned by `/studies/{id}`.'),
  program: ProgramSchema.optional().describe(
    'Resolved program record (when the study has a programDbId and the FK lookup succeeded).',
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
    .describe('Total observations recorded against this study.'),
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
    .describe('Total observation variables (traits) measured in this study.'),
  warnings: z.array(z.string()).describe('Advisory messages — failed FK lookups, missing counts.'),
});

type Output = z.infer<typeof OutputSchema>;

export const brapiGetStudy = tool('brapi_get_study', {
  description:
    'Fetch a single study by DbId with program, trial, and location fully resolved. Response includes cheap observation/observation-unit/variable counts as drill-down signals.',
  annotations: { readOnlyHint: true, idempotentHint: true },
  errors: [
    {
      reason: 'study_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Upstream returned no study record for the requested DbId',
      recovery:
        'Verify the studyDbId on the target server, or run brapi_find_studies to discover valid IDs.',
    },
  ] as const,
  input: z.object({
    studyDbId: z.string().min(1).describe('Study identifier.'),
    alias: AliasInput,
  }),
  output: OutputSchema,

  async handler(input, ctx) {
    const registry = getServerRegistry();
    const capabilities = getCapabilityRegistry();
    const client = getBrapiClient();
    const referenceData = getReferenceDataCache();
    const config = getServerConfig();

    const connection = await registry.get(ctx, input.alias ?? DEFAULT_ALIAS);

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
        buildRequestOptions(connection),
      );
    } catch (err) {
      if (isUpstreamNotFound(err)) {
        throw ctx.fail(
          'study_not_found',
          `Study '${input.studyDbId}' not found on ${connection.baseUrl}.`,
          {
            studyDbId: input.studyDbId,
            baseUrl: connection.baseUrl,
            ...ctx.recoveryFor('study_not_found'),
          },
        );
      }
      throw err;
    }
    const study = studyEnv.result;
    if (!study || typeof study !== 'object' || !study.studyDbId) {
      throw ctx.fail(
        'study_not_found',
        `Study '${input.studyDbId}' not found on ${connection.baseUrl}.`,
        {
          studyDbId: input.studyDbId,
          baseUrl: connection.baseUrl,
          ...ctx.recoveryFor('study_not_found'),
        },
      );
    }

    const profile = await capabilities.profile(connection.baseUrl, ctx, capabilityLookup);
    const supportsObservations = profile.supported.observations?.methods?.includes('GET') ?? false;
    const supportsObservationUnits =
      profile.supported.observationunits?.methods?.includes('GET') ?? false;
    const supportsVariables = profile.supported.variables?.methods?.includes('GET') ?? false;

    const programDbId = asString(study.programDbId);
    const trialDbId = asString(study.trialDbId);
    const locationDbId = asString(study.locationDbId);

    const [programs, trials, locations, obsCount, obsUnitCount, variableCount] = await Promise.all([
      programDbId
        ? referenceData
            .getPrograms(connection.baseUrl, [programDbId], ctx, referenceLookup)
            .catch((err) => recordWarning(warnings, 'program FK lookup failed', err))
        : Promise.resolve(undefined),
      trialDbId
        ? referenceData
            .getTrials(connection.baseUrl, [trialDbId], ctx, referenceLookup)
            .catch((err) => recordWarning(warnings, 'trial FK lookup failed', err))
        : Promise.resolve(undefined),
      locationDbId
        ? referenceData
            .getLocations(connection.baseUrl, [locationDbId], ctx, referenceLookup)
            .catch((err) => recordWarning(warnings, 'location FK lookup failed', err))
        : Promise.resolve(undefined),
      supportsObservations
        ? fetchTotalCount(
            client,
            connection.baseUrl,
            '/observations',
            ctx,
            companionRequestOptions(connection, dialect, config, warnings, {
              studyDbIds: [input.studyDbId],
              pageSize: 1,
            }),
          ).catch((err) => recordWarning(warnings, 'observation count probe failed', err))
        : Promise.resolve(undefined),
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
          ).catch((err) => recordWarning(warnings, 'observation-unit count probe failed', err))
        : Promise.resolve(undefined),
      supportsVariables
        ? fetchTotalCount(
            client,
            connection.baseUrl,
            '/variables',
            ctx,
            companionRequestOptions(connection, dialect, config, warnings, {
              // /variables historically responded to singular `studyDbId` on
              // SGN deployments — keep the singular here so the dialect (which
              // doesn't carry a `variables.studyDbIds → studyDbId` entry) is a
              // pass-through, not a silent translation that breaks the probe.
              studyDbId: input.studyDbId,
              pageSize: 1,
            }),
          ).catch((err) => recordWarning(warnings, 'variable count probe failed', err))
        : Promise.resolve(undefined),
    ]);

    const result: Output = {
      alias: connection.alias,
      study: study as z.infer<typeof StudySchema>,
      warnings,
    };
    if (programDbId && programs instanceof Map) {
      const program = programs.get(programDbId);
      if (program) result.program = program as z.infer<typeof ProgramSchema>;
    }
    if (trialDbId && trials instanceof Map) {
      const trial = trials.get(trialDbId);
      if (trial) result.trial = trial as z.infer<typeof TrialSchema>;
    }
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
    lines.push(`# ${study.studyName ?? study.studyDbId}`);
    lines.push('');
    lines.push(`- **studyDbId:** \`${study.studyDbId}\``);
    if (study.studyName) lines.push(`- **studyName:** ${study.studyName}`);
    if (study.studyType) lines.push(`- **studyType:** ${study.studyType}`);
    if (study.studyDescription) lines.push(`- **studyDescription:** ${study.studyDescription}`);
    if (study.programDbId) lines.push(`- **programDbId:** ${study.programDbId}`);
    if (study.programName) lines.push(`- **programName:** ${study.programName}`);
    if (study.trialDbId) lines.push(`- **trialDbId:** ${study.trialDbId}`);
    if (study.trialName) lines.push(`- **trialName:** ${study.trialName}`);
    if (study.locationDbId) lines.push(`- **locationDbId:** ${study.locationDbId}`);
    if (study.locationName) lines.push(`- **locationName:** ${study.locationName}`);
    if (study.commonCropName) lines.push(`- **commonCropName:** ${study.commonCropName}`);
    const cleanSeasons = asStringArray(study.seasons);
    if (cleanSeasons?.length) lines.push(`- **seasons:** ${cleanSeasons.join(', ')}`);
    if (study.active != null) lines.push(`- **active:** ${study.active}`);
    if (study.startDate) lines.push(`- **startDate:** ${study.startDate}`);
    if (study.endDate) lines.push(`- **endDate:** ${study.endDate}`);
    if (study.studyCode) lines.push(`- **studyCode:** ${study.studyCode}`);
    if (study.studyPUI) lines.push(`- **studyPUI:** ${study.studyPUI}`);
    appendPassthroughLines(lines, study as Record<string, unknown>, STUDY_RENDERED);
    lines.push(`- **alias:** ${result.alias}`);

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
        lines.push(`- **latitude:** ${coords.latitude}`);
        lines.push(`- **longitude:** ${coords.longitude}`);
        if (coords.altitude != null && result.location.altitude == null) {
          lines.push(`- **altitude:** ${coords.altitude}`);
        }
      }
    }

    lines.push('');
    lines.push('## Drill-down signals');
    lines.push(`- observationCount: ${result.observationCount ?? '—'}`);
    lines.push(`- observationUnitCount: ${result.observationUnitCount ?? '—'}`);
    lines.push(`- variableCount: ${result.variableCount ?? '—'}`);

    if (result.warnings.length > 0) {
      lines.push('');
      lines.push('## Warnings');
      for (const w of result.warnings) lines.push(`- ${w}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function recordWarning(warnings: string[], label: string, err: unknown): undefined {
  warnings.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
  return;
}

async function fetchTotalCount(
  client: ReturnType<typeof getBrapiClient>,
  baseUrl: string,
  path: string,
  ctx: Parameters<typeof client.get>[2],
  options: Parameters<typeof client.get>[3],
): Promise<number | undefined> {
  const env = await client.get<unknown>(baseUrl, path, ctx, options);
  const total = env.metadata?.pagination?.totalCount;
  return typeof total === 'number' ? total : undefined;
}

function renderKeyValues(lines: string[], record: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`- **${key}:** ${value.join(', ')}`);
    } else if (typeof value === 'object') {
      lines.push(`- **${key}:** ${JSON.stringify(value)}`);
    } else {
      lines.push(`- **${key}:** ${value}`);
    }
  }
}
