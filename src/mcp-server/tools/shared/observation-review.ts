/**
 * @fileoverview Study-scoped evidence used to review observation submissions.
 * @module mcp-server/tools/shared/observation-review
 */
import { type Context, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { defaultIsTransient } from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
import type { BrapiClient } from '@/services/brapi-client/index.js';
import type { BrapiDialect } from '@/services/brapi-dialect/index.js';
import type { CapabilityProfile } from '@/services/capability-registry/types.js';
import type { RegisteredServer } from '@/services/server-registry/types.js';
import { companionRequestOptions } from './find-helpers.js';

const Bound = z.union([z.number(), z.string()]).nullish();
const Scale = z.object({
  dataType: z.string().nullish(),
  dateFormat: z.string().nullish(),
  validValues: z
    .object({
      maximumValue: Bound,
      minimumValue: Bound,
      max: Bound,
      min: Bound,
      categories: z.array(z.object({ value: z.string().nullish() })).nullish(),
    })
    .nullish(),
});
type Scale = z.infer<typeof Scale>;
const Row = z.record(z.string(), z.unknown());
const Page = z.union([z.array(Row), z.object({ data: z.array(Row) }).transform((r) => r.data)]);
const Decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const CalendarDate = z.iso.date();
function numeric(raw: string | number | null | undefined): number | undefined {
  if (raw == null || (typeof raw === 'string' && !Decimal.test(raw.trim()))) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
function scaleWarning(value: string, scale: Scale): string | undefined {
  const bounds = scale.validValues;
  if (!value) return undefined;
  if (scale.dataType === 'Numerical') {
    const n = numeric(value);
    if (n === undefined) return 'Value is not a finite decimal number on this Numerical scale.';
    const min = numeric(bounds?.minimumValue ?? bounds?.min);
    const max = numeric(bounds?.maximumValue ?? bounds?.max);
    if (min !== undefined && n < min) return `Value falls below the scale minimum of ${min}.`;
    if (max !== undefined && n > max) return `Value exceeds the scale maximum of ${max}.`;
  }
  if (scale.dataType === 'Date') {
    const date = value.trim();
    if (scale.dateFormat === 'YYYY-MM-DD')
      return CalendarDate.safeParse(date).success
        ? undefined
        : 'Value does not match the YYYY-MM-DD calendar date format.';
    const calendar = /^(\d{4})-?(\d{2})-?(\d{2})(?:$|T)/.exec(date);
    if (calendar) {
      const day = `${calendar[1]}-${calendar[2]}-${calendar[3]}`;
      if (
        !CalendarDate.safeParse(day).success ||
        (date.includes('T') && !Number.isFinite(Date.parse(day + date.slice(date.indexOf('T')))))
      )
        return 'Value is not a valid calendar date.';
    } else if (!Number.isFinite(Date.parse(date)))
      return 'Value does not parse as a date on this scale.';
  }
  if (scale.dataType === 'Nominal' || scale.dataType === 'Ordinal' || scale.dataType === 'Code') {
    const categories = bounds?.categories;
    if (
      categories?.length &&
      categories.every((c) => typeof c.value === 'string') &&
      !categories.some((c) => c.value === value)
    )
      return 'Value is outside the categories declared by this scale.';
  }
  return undefined;
}

interface ReviewInput {
  observations: readonly {
    observationVariableDbId: string;
    observationUnitDbId: string;
    observationDbId?: string | undefined;
    value: string;
  }[];
  studyDbId: string;
}

/** Reads at most one page per resource. An incomplete page can prove a conflict but cannot prove absence. */
export async function reviewStudyRows(
  input: ReviewInput,
  connection: RegisteredServer,
  profile: CapabilityProfile,
  dialect: BrapiDialect,
  config: ServerConfig,
  client: BrapiClient,
  ctx: Context,
) {
  async function read(
    endpoint: 'variables' | 'observationunits' | 'observations',
    key: string,
    needed: boolean,
  ) {
    const records = new Map<string, Record<string, unknown>>();
    const notes: string[] = [];
    let complete = false;
    if (!needed) return { records, complete, notes };
    const descriptor = profile.supported[endpoint];
    // Variable validation predates capability advertising and also supports servers omitting this endpoint from discovery.
    if (
      (endpoint !== 'variables' && !descriptor) ||
      (descriptor?.methods && !descriptor.methods.includes('GET'))
    ) {
      notes.push(
        `Skipped /${endpoint} validation because the server does not advertise GET for it.`,
      );
      return { records, complete, notes };
    }
    try {
      const env = await client.get<unknown>(
        connection.baseUrl,
        `/${endpoint}`,
        ctx,
        companionRequestOptions(connection, dialect, config, notes, {
          studyDbIds: [input.studyDbId],
          pageSize: 1000,
        }),
      );
      const page = Page.safeParse(env.result);
      if (page.success) {
        for (const row of page.data) {
          const id = row[key];
          if (typeof id === 'string' && id.length) records.set(id, row);
        }
        complete =
          env.metadata?.pagination?.totalCount === records.size &&
          records.size === page.data.length;
      }
      if (!complete)
        notes.push(
          `The /${endpoint} check is incomplete. IDs absent from this page are unverified.`,
        );
    } catch (err) {
      ctx.signal.throwIfAborted();
      const unavailable =
        err instanceof McpError &&
        ([
          JsonRpcErrorCode.NotFound,
          JsonRpcErrorCode.Timeout,
          JsonRpcErrorCode.ServiceUnavailable,
          JsonRpcErrorCode.RateLimited,
          JsonRpcErrorCode.Forbidden,
          JsonRpcErrorCode.Unauthorized,
        ].some((code) => code === err.code) ||
          (err.code === JsonRpcErrorCode.ValidationError &&
            (typeof err.data?.httpStatus === 'number' ||
              err.data?.reason === 'upstream_bad_request')));
      if (!unavailable && !defaultIsTransient(err)) throw err;
      notes.push(
        `The /${endpoint} check could not retrieve the study page. Membership is unverified.`,
      );
    }
    return { records, complete, notes };
  }
  const [variables, units, updates] = await Promise.all([
    read('variables', 'observationVariableDbId', true),
    read('observationunits', 'observationUnitDbId', true),
    read(
      'observations',
      'observationDbId',
      input.observations.some((row) => row.observationDbId !== undefined),
    ),
  ]);
  const scales = new Map<string, Scale>();
  for (const [id, row] of variables.records) {
    const scale = Scale.safeParse(row.scale);
    if (scale.success) scales.set(id, scale.data);
  }
  function mismatch(page: typeof units, id: string) {
    const row = page.records.get(id);
    return row
      ? typeof row.studyDbId === 'string' && row.studyDbId !== input.studyDbId
      : page.complete;
  }
  let flagged = 0;
  const perRowWarnings = input.observations.flatMap((row, rowIndex) => {
    const warnings: string[] = [];
    if (!row.value) warnings.push('value is empty — submitted as an empty string.');
    const scale = scales.get(row.observationVariableDbId);
    const warning = scale && scaleWarning(row.value, scale);
    if (warning) warnings.push(warning);
    if (mismatch(variables, row.observationVariableDbId))
      warnings.push(
        `observationVariableDbId '${row.observationVariableDbId}' is not exposed by study '${input.studyDbId}'. The server may reject the row.`,
      );
    if (mismatch(units, row.observationUnitDbId))
      warnings.push(
        `observationUnitDbId '${row.observationUnitDbId}' is not in study '${input.studyDbId}'.`,
      );
    if (row.observationDbId && mismatch(updates, row.observationDbId))
      warnings.push(
        `observationDbId '${row.observationDbId}' is not in study '${input.studyDbId}'.`,
      );
    if (warnings.length) flagged++;
    return warnings.map((warning) => ({
      rowIndex,
      observationVariableDbId: row.observationVariableDbId,
      observationUnitDbId: row.observationUnitDbId,
      warning,
    }));
  });
  return {
    flagged,
    perRowWarnings,
    knownVariableCount: variables.records.size,
    notes: [...variables.notes, ...units.notes, ...updates.notes],
  };
}
