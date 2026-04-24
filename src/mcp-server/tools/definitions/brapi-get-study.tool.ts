/**
 * @fileoverview `brapi_get_study` — fetch a single study by DbId, resolve
 * program/trial/location FKs via ReferenceDataCache, and attach cheap
 * `pageSize=0` counts (observations, observation units, variables) as
 * response companions so the agent can decide where to drill next.
 *
 * @module mcp-server/tools/definitions/brapi-get-study.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { getBrapiClient } from '@/services/brapi-client/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import { getReferenceDataCache } from '@/services/reference-data-cache/index.js';
import { DEFAULT_ALIAS, getServerRegistry } from '@/services/server-registry/index.js';
import { AliasInput, buildRequestOptions } from '../shared/find-helpers.js';

const StudySchema = z
  .object({
    studyDbId: z.string().describe('Server-side identifier for the study.'),
    studyName: z.string().optional().describe('Display name.'),
    studyType: z.string().optional().describe('E.g. "Yield Trial", "Phenotyping".'),
    studyDescription: z.string().optional().describe('Free-form description.'),
    programDbId: z.string().optional().describe('FK to the owning program.'),
    programName: z.string().optional().describe('Display name of the owning program.'),
    trialDbId: z.string().optional().describe('FK to the owning trial.'),
    trialName: z.string().optional().describe('Display name of the owning trial.'),
    locationDbId: z.string().optional().describe('FK to the study site.'),
    locationName: z.string().optional().describe('Display name of the study site.'),
    commonCropName: z.string().optional().describe('Common crop name (e.g. "Maize", "Wheat").'),
    seasons: z
      .array(z.string().describe('Season identifier — typically a year like "2022".'))
      .optional()
      .describe('Season identifiers this study spans.'),
    active: z.boolean().optional().describe('True while the study is open for data capture.'),
    startDate: z.string().optional().describe('ISO 8601 start date.'),
    endDate: z.string().optional().describe('ISO 8601 end date.'),
    studyCode: z.string().optional().describe('Short code or alias for the study.'),
    studyPUI: z.string().optional().describe('Persistent unique identifier (URI).'),
  })
  .passthrough();

const ProgramSchema = z
  .object({
    programDbId: z.string().describe('Server-side identifier for the program.'),
    programName: z.string().optional().describe('Display name.'),
    commonCropName: z.string().optional().describe('Common crop name this program targets.'),
    abbreviation: z.string().optional().describe('Short abbreviation.'),
    leadPersonName: z.string().optional().describe('Name of the program lead.'),
    documentationURL: z.string().optional().describe('URL pointing at program documentation.'),
  })
  .passthrough();

const TrialSchema = z
  .object({
    trialDbId: z.string().describe('Server-side identifier for the trial.'),
    trialName: z.string().optional().describe('Display name.'),
    programDbId: z.string().optional().describe('FK to the owning program.'),
    programName: z.string().optional().describe('Display name of the owning program.'),
    commonCropName: z.string().optional().describe('Common crop name.'),
    startDate: z.string().optional().describe('ISO 8601 start date.'),
    endDate: z.string().optional().describe('ISO 8601 end date.'),
    active: z.boolean().optional().describe('True while the trial is ongoing.'),
    trialDescription: z.string().optional().describe('Free-form description.'),
  })
  .passthrough();

const LocationSchema = z
  .object({
    locationDbId: z.string().describe('Server-side identifier for the location.'),
    locationName: z.string().optional().describe('Display name.'),
    abbreviation: z.string().optional().describe('Short abbreviation.'),
    countryCode: z.string().optional().describe('ISO 3166-1 alpha-3 country code.'),
    countryName: z.string().optional().describe('Display name of the country.'),
    locationType: z
      .string()
      .optional()
      .describe('Type of location (e.g. "Research Station", "Field").'),
    latitude: z.number().optional().describe('WGS84 latitude in decimal degrees.'),
    longitude: z.number().optional().describe('WGS84 longitude in decimal degrees.'),
    altitude: z.number().optional().describe('Altitude in meters above sea level.'),
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

    const connection = await registry.get(ctx, input.alias ?? DEFAULT_ALIAS);

    const capabilityLookup: { auth?: typeof connection.resolvedAuth } = {};
    if (connection.resolvedAuth) capabilityLookup.auth = connection.resolvedAuth;
    await capabilities.ensure(
      connection.baseUrl,
      { service: 'studies', method: 'GET' },
      ctx,
      capabilityLookup,
    );

    const warnings: string[] = [];
    const referenceLookup: { auth?: typeof connection.resolvedAuth } = {};
    if (connection.resolvedAuth) referenceLookup.auth = connection.resolvedAuth;

    const studyEnv = await client.get<Record<string, unknown>>(
      connection.baseUrl,
      `/studies/${encodeURIComponent(input.studyDbId)}`,
      ctx,
      buildRequestOptions(connection),
    );
    const study = studyEnv.result;
    if (!study || typeof study !== 'object' || !study.studyDbId) {
      throw notFound(`Study '${input.studyDbId}' not found on ${connection.baseUrl}.`, {
        studyDbId: input.studyDbId,
        baseUrl: connection.baseUrl,
      });
    }

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
      fetchTotalCount(
        client,
        connection.baseUrl,
        `/studies/${encodeURIComponent(input.studyDbId)}/observations`,
        ctx,
        buildRequestOptions(connection, { pageSize: 0 }),
      ).catch((err) => recordWarning(warnings, 'observation count probe failed', err)),
      fetchTotalCount(
        client,
        connection.baseUrl,
        `/studies/${encodeURIComponent(input.studyDbId)}/observationunits`,
        ctx,
        buildRequestOptions(connection, { pageSize: 0 }),
      ).catch((err) => recordWarning(warnings, 'observation-unit count probe failed', err)),
      fetchTotalCount(
        client,
        connection.baseUrl,
        `/studies/${encodeURIComponent(input.studyDbId)}/observationvariables`,
        ctx,
        buildRequestOptions(connection, { pageSize: 0 }),
      ).catch((err) => recordWarning(warnings, 'variable count probe failed', err)),
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
    if (study.seasons?.length) lines.push(`- **seasons:** ${study.seasons.join(', ')}`);
    if (study.active !== undefined) lines.push(`- **active:** ${study.active}`);
    if (study.startDate) lines.push(`- **startDate:** ${study.startDate}`);
    if (study.endDate) lines.push(`- **endDate:** ${study.endDate}`);
    if (study.studyCode) lines.push(`- **studyCode:** ${study.studyCode}`);
    if (study.studyPUI) lines.push(`- **studyPUI:** ${study.studyPUI}`);
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
    } else {
      lines.push(`- **${key}:** ${value}`);
    }
  }
}
