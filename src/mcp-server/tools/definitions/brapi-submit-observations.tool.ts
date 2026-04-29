/**
 * @fileoverview `brapi_submit_observations` — submit new or updated
 * observations for a study. Two-phase write: `mode: 'preview'` validates rows
 * against the study's observation variables and returns a routing breakdown
 * (POST for new rows, PUT for rows carrying `observationDbId`); `mode: 'apply'`
 * elicits confirmation when supported, fans the rows out to POST + PUT in
 * parallel, then verifies the post-state with a cheap `pageSize=0` count.
 * Additive write — no observation is destroyed by this tool.
 *
 * @module mcp-server/tools/definitions/brapi-submit-observations.tool
 */

import { type Context, type HandlerContext, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { type BrapiClient, getBrapiClient } from '@/services/brapi-client/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import { DEFAULT_ALIAS, getServerRegistry } from '@/services/server-registry/index.js';
import type { RegisteredServer } from '@/services/server-registry/types.js';
import { AliasInput, buildRequestOptions, extractRows } from '../shared/find-helpers.js';

const ObservationRowSchema = z
  .object({
    observationDbId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Server-assigned identifier of an existing observation. When present, the row updates that observation; when absent, the row creates a new one.',
      ),
    observationUnitDbId: z
      .string()
      .min(1)
      .describe(
        'FK to the observation unit (plot / plant / sample) the value applies to. Required.',
      ),
    observationVariableDbId: z
      .string()
      .min(1)
      .describe('FK to the observation variable (trait) being measured. Required.'),
    value: z
      .string()
      .describe(
        'Recorded measurement value, stringified per BrAPI convention. Empty strings are flagged as warnings.',
      ),
    collector: z.string().optional().describe('Name or ID of the person who collected the value.'),
    observationTimeStamp: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp the observation was taken.'),
    season: z
      .object({
        seasonDbId: z.string().optional().describe('Server-side season identifier.'),
        year: z.string().optional().describe('Calendar year (e.g. "2024").'),
        season: z.string().optional().describe('Season label (e.g. "wet", "dry", "Q1").'),
      })
      .optional()
      .describe('Season block. Most servers tolerate either seasonDbId or year+label.'),
    geoCoordinates: z
      .object({
        type: z.literal('Feature').describe('GeoJSON feature type (always "Feature").'),
        geometry: z
          .object({
            type: z.literal('Point').describe('GeoJSON geometry type (always "Point").'),
            coordinates: z
              .array(z.number())
              .length(2)
              .describe('[longitude, latitude] in WGS84 decimal degrees.'),
          })
          .describe('GeoJSON point geometry.'),
      })
      .optional()
      .describe('Optional GeoJSON Feature carrying lon/lat for this observation.'),
  })
  .describe('One observation row. observationDbId presence routes to PUT vs POST.');

const PerRowWarningSchema = z
  .object({
    rowIndex: z.number().int().nonnegative().describe('Zero-based index of the row in the input.'),
    observationVariableDbId: z
      .string()
      .optional()
      .describe('Variable DbId on the row, when present.'),
    observationUnitDbId: z.string().optional().describe('Unit DbId on the row, when present.'),
    warning: z.string().describe('What was unusual about this row.'),
  })
  .describe('Per-row validation warning — does not abort the batch.');

const PreviewBranchSchema = z
  .object({
    mode: z.literal('preview').describe('Discriminator — `preview` reports validation only.'),
    studyDbId: z.string().describe('Study the rows belong to.'),
    studyName: z.string().optional().describe('Display name of the study, when available.'),
    valid: z.number().int().nonnegative().describe('Rows that pass per-row validation.'),
    invalid: z
      .number()
      .int()
      .nonnegative()
      .describe(
        'Rows with structural problems severe enough to skip on apply (missing required FKs, etc.).',
      ),
    routing: z
      .object({
        postCount: z
          .number()
          .int()
          .nonnegative()
          .describe('Rows that would be POSTed (no observationDbId).'),
        putCount: z
          .number()
          .int()
          .nonnegative()
          .describe('Rows that would be PUT (observationDbId present).'),
      })
      .describe('How rows would split across POST vs PUT.'),
    perRowWarnings: z
      .array(PerRowWarningSchema)
      .describe('Per-row notes — unknown variables, empty values, missing IDs.'),
    knownVariableCount: z
      .number()
      .int()
      .nonnegative()
      .describe('Count of variables exposed by the study (used to validate rows).'),
  })
  .describe('Preview output — no writes have occurred.');

const ApplyBranchSchema = z
  .object({
    mode: z.literal('apply').describe('Discriminator — `apply` reports post-write state.'),
    studyDbId: z.string().describe('Study the rows belong to.'),
    studyName: z.string().optional().describe('Display name of the study, when available.'),
    posted: z
      .array(
        z
          .object({
            observationDbId: z
              .string()
              .optional()
              .describe('Server-assigned observationDbId (when echoed in the response).'),
            observationUnitDbId: z.string().optional().describe('FK echoed from the server.'),
            observationVariableDbId: z.string().optional().describe('FK echoed from the server.'),
            value: z.string().optional().describe('Value echoed from the server.'),
          })
          .describe('One created observation as echoed by the server.'),
      )
      .describe('Observations created by the call (POST results).'),
    updated: z
      .array(
        z
          .object({
            observationDbId: z.string().describe('Existing observationDbId that was updated.'),
            observationUnitDbId: z.string().optional().describe('FK echoed from the server.'),
            observationVariableDbId: z.string().optional().describe('FK echoed from the server.'),
            value: z.string().optional().describe('New value echoed from the server.'),
          })
          .describe('One updated observation as echoed by the server.'),
      )
      .describe('Observations updated by the call (PUT results).'),
    studyObservationCount: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Total observations recorded against the study after the write (cheap probe).'),
    latestObservationTimestamp: z
      .string()
      .optional()
      .describe('Most recent `observationTimeStamp` across the rows accepted in this call.'),
    perRowWarnings: z
      .array(PerRowWarningSchema)
      .describe('Per-row notes — unknown variables, empty values, missing IDs.'),
  })
  .describe('Apply output — writes succeeded, post-state attached.');

const OutputSchema = z.object({
  alias: z.string().describe('Alias of the registered BrAPI connection the call used.'),
  result: z
    .discriminatedUnion('mode', [PreviewBranchSchema, ApplyBranchSchema])
    .describe('Mode-specific result — discriminated by `mode`.'),
});

type Output = z.infer<typeof OutputSchema>;

interface RowDecision {
  observationDbId: string | undefined;
  rowIndex: number;
  warnings: string[];
}

const SUBMIT_ERRORS = [
  {
    reason: 'observations_unsupported',
    code: JsonRpcErrorCode.ValidationError,
    when: 'BrAPI server does not advertise /observations',
    recovery:
      'Run brapi_server_info to inspect the advertised endpoints, or call brapi_connect with a different alias for a server that exposes /observations.',
  },
  {
    reason: 'post_unsupported',
    code: JsonRpcErrorCode.ValidationError,
    when: 'Server does not advertise POST on /observations but new rows were submitted',
    recovery:
      'Remove the rows that lack observationDbId (those are the new rows) before retrying, or connect to a different server that supports POST on /observations.',
  },
  {
    reason: 'put_unsupported',
    code: JsonRpcErrorCode.ValidationError,
    when: 'Server does not advertise PUT on /observations but update rows were submitted',
    recovery:
      'Connect to a different server that supports PUT on /observations — dropping observationDbId would route as POST and create duplicates instead of updating the existing rows.',
  },
  {
    reason: 'elicit_unavailable',
    code: JsonRpcErrorCode.Forbidden,
    when: 'Apply mode invoked but client does not expose ctx.elicit and force was false',
    recovery:
      'Set force=true only with explicit user authorization, or use a client that supports elicitation.',
  },
  {
    reason: 'user_declined',
    code: JsonRpcErrorCode.Forbidden,
    when: 'User declined the elicitation prompt for the apply write',
    recovery: 'Re-run the tool when the user is ready to confirm the write.',
  },
] as const;

type SubmitCtx = HandlerContext<(typeof SUBMIT_ERRORS)[number]['reason']>;

export const brapiSubmitObservations = tool('brapi_submit_observations', {
  description:
    'Submit new or updated observations for a study. Default mode `preview` validates rows against the study variables and returns a routing breakdown without writing. Mode `apply` elicits confirmation when supported, then creates rows that lack observationDbId, updates rows that carry one, and returns the post-write study count plus per-row server echoes. Additive only — no observation is destroyed.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  errors: SUBMIT_ERRORS,
  input: z.object({
    alias: AliasInput,
    studyDbId: z.string().min(1).describe('Study the observations are submitted against.'),
    observations: z
      .array(ObservationRowSchema)
      .min(1)
      .max(5_000)
      .describe('1 – 5000 observation rows. Mixed POST + PUT routing is supported.'),
    mode: z
      .enum(['preview', 'apply'])
      .default('preview')
      .describe(
        '`preview` (default) validates only; `apply` writes after eliciting confirmation when supported.',
      ),
    force: z
      .boolean()
      .default(false)
      .describe(
        'Bypass elicitation in apply mode. Use only when the client lacks ctx.elicit support; the agent must have explicit user authorization to apply.',
      ),
  }),
  output: OutputSchema,
  auth: ['brapi:write:observations'],

  async handler(input, ctx) {
    const registry = getServerRegistry();
    const capabilities = getCapabilityRegistry();
    const client = getBrapiClient();

    const connection = await registry.get(ctx, input.alias ?? DEFAULT_ALIAS);

    const capabilityLookup: { auth?: typeof connection.resolvedAuth } = {};
    if (connection.resolvedAuth) capabilityLookup.auth = connection.resolvedAuth;
    const profile = await capabilities.profile(connection.baseUrl, ctx, capabilityLookup);

    const obsDescriptor = profile.supported.observations;
    const supportsPost = obsDescriptor?.methods?.includes('POST') ?? false;
    const supportsPut = obsDescriptor?.methods?.includes('PUT') ?? false;
    if (!obsDescriptor) {
      throw ctx.fail(
        'observations_unsupported',
        `BrAPI server at ${connection.baseUrl} does not advertise '/observations' in /calls. Cannot submit observations.`,
        { baseUrl: connection.baseUrl, ...ctx.recoveryFor('observations_unsupported') },
      );
    }

    const knownVariables = await fetchStudyVariables(input.studyDbId, connection, client, ctx);
    const studyName = await fetchStudyName(input.studyDbId, connection, client, ctx);

    const decisions: RowDecision[] = [];
    const perRowWarnings: z.infer<typeof PerRowWarningSchema>[] = [];
    let valid = 0;
    let invalid = 0;
    let postCount = 0;
    let putCount = 0;

    for (const [i, row] of input.observations.entries()) {
      const rowWarnings: string[] = [];
      let structurallyValid = true;

      if (!row.observationUnitDbId) {
        rowWarnings.push('observationUnitDbId is required.');
        structurallyValid = false;
      }
      if (!row.observationVariableDbId) {
        rowWarnings.push('observationVariableDbId is required.');
        structurallyValid = false;
      }
      if (row.value === '') {
        rowWarnings.push('value is empty — submitted as an empty string.');
      }
      if (
        row.observationVariableDbId &&
        knownVariables.size > 0 &&
        !knownVariables.has(row.observationVariableDbId)
      ) {
        rowWarnings.push(
          `observationVariableDbId '${row.observationVariableDbId}' is not exposed by study '${input.studyDbId}'. The server may reject the row.`,
        );
      }

      const decision: RowDecision = {
        rowIndex: i,
        observationDbId: row.observationDbId,
        warnings: rowWarnings,
      };
      decisions.push(decision);

      if (structurallyValid) {
        valid++;
        if (row.observationDbId) putCount++;
        else postCount++;
      } else {
        invalid++;
      }

      for (const warning of rowWarnings) {
        const entry: z.infer<typeof PerRowWarningSchema> = { rowIndex: i, warning };
        if (row.observationVariableDbId)
          entry.observationVariableDbId = row.observationVariableDbId;
        if (row.observationUnitDbId) entry.observationUnitDbId = row.observationUnitDbId;
        perRowWarnings.push(entry);
      }
    }

    if (input.mode === 'preview') {
      const branch: z.infer<typeof PreviewBranchSchema> = {
        mode: 'preview',
        studyDbId: input.studyDbId,
        valid,
        invalid,
        routing: { postCount, putCount },
        perRowWarnings,
        knownVariableCount: knownVariables.size,
      };
      if (studyName) branch.studyName = studyName;
      return { alias: connection.alias, result: branch };
    }

    if (postCount > 0 && !supportsPost) {
      throw ctx.fail(
        'post_unsupported',
        `Server does not advertise POST on /observations. ${postCount} new row(s) cannot be created.`,
        { baseUrl: connection.baseUrl, postCount, ...ctx.recoveryFor('post_unsupported') },
      );
    }
    if (putCount > 0 && !supportsPut) {
      throw ctx.fail(
        'put_unsupported',
        `Server does not advertise PUT on /observations. ${putCount} update row(s) cannot be applied.`,
        { baseUrl: connection.baseUrl, putCount, ...ctx.recoveryFor('put_unsupported') },
      );
    }

    await confirmApply(ctx, {
      studyDbId: input.studyDbId,
      studyName,
      valid,
      invalid,
      postCount,
      putCount,
      force: input.force,
    });

    const validRows = decisions.flatMap((d) => {
      if (d.warnings.some(isStructural)) return [];
      const row = input.observations[d.rowIndex];
      return row ? [row] : [];
    });

    const postRows = validRows.filter((r) => !r.observationDbId);
    const putRows = validRows.filter((r) => r.observationDbId);

    const [postedEnv, updatedEnv] = await Promise.all([
      postRows.length > 0
        ? client.post<unknown>(
            connection.baseUrl,
            '/observations',
            postRows,
            ctx,
            buildRequestOptions(connection),
          )
        : Promise.resolve(undefined),
      putRows.length > 0
        ? client.put<unknown>(
            connection.baseUrl,
            '/observations',
            buildPutBody(putRows),
            ctx,
            buildRequestOptions(connection),
          )
        : Promise.resolve(undefined),
    ]);

    const posted = postedEnv ? extractObservationRows(postedEnv.result) : [];
    const updated = updatedEnv
      ? extractObservationRows(updatedEnv.result).filter(
          (r): r is typeof r & { observationDbId: string } => typeof r.observationDbId === 'string',
        )
      : [];

    const studyObservationCount = await fetchStudyObservationCount(
      input.studyDbId,
      connection,
      client,
      ctx,
    );

    const latestTimestamp = pickLatestTimestamp(input.observations);

    const branch: z.infer<typeof ApplyBranchSchema> = {
      mode: 'apply',
      studyDbId: input.studyDbId,
      posted,
      updated,
      perRowWarnings,
    };
    if (studyName) branch.studyName = studyName;
    if (studyObservationCount !== undefined) branch.studyObservationCount = studyObservationCount;
    if (latestTimestamp) branch.latestObservationTimestamp = latestTimestamp;

    return { alias: connection.alias, result: branch } satisfies Output;
  },

  format: (output) => {
    const lines: string[] = [];
    if (output.result.mode === 'preview') {
      const r = output.result;
      lines.push(
        `# Preview · study \`${r.studyDbId}\`${r.studyName ? ` (${r.studyName})` : ''} — \`${output.alias}\``,
      );
      lines.push('');
      lines.push(`- valid: ${r.valid}`);
      lines.push(`- invalid: ${r.invalid}`);
      lines.push(`- routing: POST ${r.routing.postCount} · PUT ${r.routing.putCount}`);
      lines.push(`- knownVariableCount: ${r.knownVariableCount}`);
      lines.push('- mode: preview · no writes performed');
      if (r.perRowWarnings.length > 0) {
        lines.push('');
        lines.push('## Per-row warnings');
        for (const w of r.perRowWarnings) {
          const id = w.observationVariableDbId ? ` var=\`${w.observationVariableDbId}\`` : '';
          const unit = w.observationUnitDbId ? ` unit=\`${w.observationUnitDbId}\`` : '';
          lines.push(`- row ${w.rowIndex}:${id}${unit} — ${w.warning}`);
        }
      }
    } else {
      const r = output.result;
      lines.push(
        `# Apply · study \`${r.studyDbId}\`${r.studyName ? ` (${r.studyName})` : ''} — \`${output.alias}\``,
      );
      lines.push('');
      lines.push(`- posted: ${r.posted.length}`);
      lines.push(`- updated: ${r.updated.length}`);
      lines.push(`- studyObservationCount: ${r.studyObservationCount ?? '—'}`);
      lines.push(`- latestObservationTimestamp: ${r.latestObservationTimestamp ?? '—'}`);
      lines.push('- mode: apply');
      if (r.posted.length > 0) {
        lines.push('');
        lines.push('## Posted (new observations)');
        for (const p of r.posted) {
          const parts: string[] = [];
          if (p.observationDbId) parts.push(`id=\`${p.observationDbId}\``);
          if (p.observationVariableDbId) parts.push(`var=${p.observationVariableDbId}`);
          if (p.observationUnitDbId) parts.push(`unit=${p.observationUnitDbId}`);
          if (p.value !== undefined) parts.push(`value=${p.value}`);
          lines.push(`- ${parts.join(' · ') || '_(server returned no fields)_'}`);
        }
      }
      if (r.updated.length > 0) {
        lines.push('');
        lines.push('## Updated');
        for (const u of r.updated) {
          const parts: string[] = [`id=\`${u.observationDbId}\``];
          if (u.observationVariableDbId) parts.push(`var=${u.observationVariableDbId}`);
          if (u.observationUnitDbId) parts.push(`unit=${u.observationUnitDbId}`);
          if (u.value !== undefined) parts.push(`value=${u.value}`);
          lines.push(`- ${parts.join(' · ')}`);
        }
      }
      if (r.perRowWarnings.length > 0) {
        lines.push('');
        lines.push('## Per-row warnings');
        for (const w of r.perRowWarnings) {
          const id = w.observationVariableDbId ? ` var=\`${w.observationVariableDbId}\`` : '';
          const unit = w.observationUnitDbId ? ` unit=\`${w.observationUnitDbId}\`` : '';
          lines.push(`- row ${w.rowIndex}:${id}${unit} — ${w.warning}`);
        }
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

function isStructural(warning: string): boolean {
  return warning.endsWith('is required.');
}

interface ConfirmInput {
  force: boolean;
  invalid: number;
  postCount: number;
  putCount: number;
  studyDbId: string;
  studyName: string | undefined;
  valid: number;
}

async function confirmApply(ctx: SubmitCtx, input: ConfirmInput): Promise<void> {
  if (input.force) return;
  if (!ctx.elicit) {
    throw ctx.fail(
      'elicit_unavailable',
      'Apply mode requires user confirmation. The MCP client does not expose elicitation, so set `force: true` to bypass — but only with explicit user authorization for this write.',
      {
        studyDbId: input.studyDbId,
        valid: input.valid,
        invalid: input.invalid,
        ...ctx.recoveryFor('elicit_unavailable'),
      },
    );
  }
  const message = [
    `Apply ${input.valid} observation row(s) to study \`${input.studyDbId}\`${input.studyName ? ` (${input.studyName})` : ''}?`,
    `POST ${input.postCount} new · PUT ${input.putCount} update · ${input.invalid} skipped (structural errors).`,
  ].join('\n');
  const result = await ctx.elicit(
    message,
    z.object({
      confirm: z
        .boolean()
        .describe('Set to true to commit the writes; false to abort with no side effects.'),
    }),
  );
  const confirmed =
    typeof result.data === 'object' &&
    result.data !== null &&
    (result.data as { confirm?: unknown }).confirm === true;
  if (result.action !== 'accept' || !confirmed) {
    throw ctx.fail('user_declined', 'User declined to apply observation writes.', {
      studyDbId: input.studyDbId,
      action: result.action,
      ...ctx.recoveryFor('user_declined'),
    });
  }
}

async function fetchStudyVariables(
  studyDbId: string,
  connection: RegisteredServer,
  client: BrapiClient,
  ctx: Context,
): Promise<Set<string>> {
  try {
    const env = await client.get<unknown>(
      connection.baseUrl,
      `/studies/${encodeURIComponent(studyDbId)}/observationvariables`,
      ctx,
      buildRequestOptions(connection, { pageSize: 1000 }),
    );
    const known = new Set<string>();
    const rows = extractRows<Record<string, unknown>>(
      env.result as { data?: Record<string, unknown>[] } | Record<string, unknown>[],
    );
    for (const row of rows) {
      const id = row.observationVariableDbId;
      if (typeof id === 'string' && id.length > 0) known.add(id);
    }
    return known;
  } catch (err) {
    ctx.log.debug('Could not load study variables for validation', {
      studyDbId,
      error: err instanceof Error ? err.message : String(err),
    });
    return new Set();
  }
}

async function fetchStudyName(
  studyDbId: string,
  connection: RegisteredServer,
  client: BrapiClient,
  ctx: Context,
): Promise<string | undefined> {
  try {
    const env = await client.get<Record<string, unknown>>(
      connection.baseUrl,
      `/studies/${encodeURIComponent(studyDbId)}`,
      ctx,
      buildRequestOptions(connection),
    );
    const name = env.result?.studyName;
    return typeof name === 'string' && name.length > 0 ? name : undefined;
  } catch {
    return;
  }
}

async function fetchStudyObservationCount(
  studyDbId: string,
  connection: RegisteredServer,
  client: BrapiClient,
  ctx: Context,
): Promise<number | undefined> {
  try {
    const env = await client.get<unknown>(
      connection.baseUrl,
      `/studies/${encodeURIComponent(studyDbId)}/observations`,
      ctx,
      buildRequestOptions(connection, { pageSize: 0 }),
    );
    const total = env.metadata?.pagination?.totalCount;
    return typeof total === 'number' ? total : undefined;
  } catch {
    return;
  }
}

function buildPutBody(rows: z.infer<typeof ObservationRowSchema>[]): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const row of rows) {
    if (!row.observationDbId) continue;
    map[row.observationDbId] = row;
  }
  return map;
}

function extractObservationRows(result: unknown): Array<{
  observationDbId?: string;
  observationUnitDbId?: string;
  observationVariableDbId?: string;
  value?: string;
}> {
  if (!result) return [];
  let rows: unknown[];
  if (Array.isArray(result)) {
    rows = result;
  } else if (typeof result === 'object' && Array.isArray((result as { data?: unknown }).data)) {
    rows = (result as { data: unknown[] }).data;
  } else {
    return [];
  }
  const out: Array<{
    observationDbId?: string;
    observationUnitDbId?: string;
    observationVariableDbId?: string;
    value?: string;
  }> = [];
  for (const entry of rows) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const item: {
      observationDbId?: string;
      observationUnitDbId?: string;
      observationVariableDbId?: string;
      value?: string;
    } = {};
    if (typeof record.observationDbId === 'string') item.observationDbId = record.observationDbId;
    if (typeof record.observationUnitDbId === 'string')
      item.observationUnitDbId = record.observationUnitDbId;
    if (typeof record.observationVariableDbId === 'string')
      item.observationVariableDbId = record.observationVariableDbId;
    if (typeof record.value === 'string') item.value = record.value;
    out.push(item);
  }
  return out;
}

function pickLatestTimestamp(rows: z.infer<typeof ObservationRowSchema>[]): string | undefined {
  let best: string | undefined;
  for (const row of rows) {
    if (typeof row.observationTimeStamp !== 'string') continue;
    if (!best || row.observationTimeStamp > best) best = row.observationTimeStamp;
  }
  return best;
}
