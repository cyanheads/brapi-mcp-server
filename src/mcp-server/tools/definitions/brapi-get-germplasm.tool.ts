/**
 * @fileoverview `brapi_get_germplasm` — fetch a single germplasm with
 * attributes and direct parents, plus companion counts (studies the
 * germplasm has appeared in, direct parents, direct descendants) to signal
 * where to drill next.
 *
 * @module mcp-server/tools/definitions/brapi-get-germplasm.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getBrapiClient } from '@/services/brapi-client/index.js';
import { resolveDialect } from '@/services/brapi-dialect/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import {
  AliasInput,
  appendPassthroughLines,
  buildRequestOptions,
  collectPassthroughParts,
  dedupSynonymsByIdentity,
  fetchTotalCount,
  fetchValidatedScopedCount,
  isUpstreamNotFound,
  NonBlankString,
  requireRegisteredConnection,
} from '../shared/find-helpers.js';
import { literal, prose } from '../shared/markdown-literals.js';

const GermplasmSchema = z
  .object({
    germplasmDbId: z.string().describe('Server-side identifier for the germplasm.'),
    germplasmName: z.string().nullish().describe('Display name.'),
    germplasmPUI: z.string().nullish().describe('Persistent unique identifier (URI).'),
    commonCropName: z.string().nullish().describe('Common crop name.'),
    accessionNumber: z.string().nullish().describe('Gene-bank catalog number.'),
    genus: z.string().nullish().describe('Botanical genus.'),
    species: z.string().nullish().describe('Botanical species.'),
    subtaxa: z.string().nullish().describe('Botanical subtaxa.'),
    defaultDisplayName: z.string().nullish().describe('Preferred display label.'),
    pedigree: z.string().nullish().describe('Pedigree as a free-text string.'),
    biologicalStatusOfAccessionDescription: z
      .string()
      .nullish()
      .describe('MCPD biological-status label.'),
    germplasmOrigin: z
      .array(
        z
          .object({})
          .passthrough()
          .describe('One origin record (collection coordinates and uncertainty per BrAPI v2).'),
      )
      .nullish()
      .describe('Origin records — array of collection-site objects per BrAPI v2.'),
    countryOfOriginCode: z.string().nullish().describe('ISO 3166-1 alpha-3 country code.'),
    collection: z.string().nullish().describe('Collection name.'),
    instituteCode: z.string().nullish().describe('FAO WIEWS institute code.'),
    instituteName: z.string().nullish().describe('Display name of the holding institute.'),
    synonyms: z
      .array(
        z
          .object({
            synonym: z.string().nullish().describe('Synonym value.'),
            type: z.string().nullish().describe('Synonym type (e.g. "COMMON", "SYNONYM").'),
          })
          .passthrough()
          .describe('Registered synonym for this germplasm.'),
      )
      .nullish()
      .describe('All registered synonyms.'),
  })
  .passthrough();

const ParentSchema = z
  .object({
    germplasmDbId: z.string().nullish().describe('FK to the parent germplasm.'),
    germplasmName: z.string().nullish().describe('Display name of the parent germplasm.'),
    parentType: z.string().nullish().describe('E.g. "MALE", "FEMALE", "SELF".'),
  })
  .passthrough()
  .describe('One direct parent of the germplasm.');

const AttributeSchema = z
  .object({
    attributeDbId: z.string().nullish().describe('Attribute identifier.'),
    attributeName: z.string().nullish().describe('Attribute display name.'),
    attributeValue: z.string().nullish().describe('Recorded value (stringified).'),
    determinedDate: z.string().nullish().describe('ISO 8601 date the attribute was determined.'),
  })
  .passthrough()
  .describe('One germplasm attribute record.');

const OutputSchema = z.object({
  alias: z.string().describe('Connection alias the call used.'),
  germplasm: GermplasmSchema.describe(
    'Canonical germplasm record as returned by `/germplasm/{id}`.',
  ),
  parents: z.array(ParentSchema).describe('Direct parents from /germplasm/{id}/pedigree.'),
  attributes: z
    .array(AttributeSchema)
    .describe('Germplasm attributes from /germplasm/{id}/attributes.'),
  studyCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('How many studies this germplasm has appeared in.'),
  directParentCount: z
    .number()
    .int()
    .nonnegative()
    .describe('Length of parents[]; 0 also when the pedigree lookup is unsupported or failed.'),
  directDescendantCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Count of direct descendants from /germplasm/{id}/progeny.'),
  warnings: z
    .array(z.string())
    .describe('Advisory messages — failed sub-endpoint lookups, missing counts.'),
});

type Output = z.infer<typeof OutputSchema>;

export const brapiGetGermplasm = tool('brapi_get_germplasm', {
  description:
    'Fetch a single germplasm by DbId with attributes and direct parents. Response companions report study count, direct parent count, and direct descendant count — signals for pedigree depth and observation coverage.',
  annotations: { readOnlyHint: true, idempotentHint: true },
  errors: [
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'An uncaught BrAPI data request exhausted retries after HTTP 429',
      recovery:
        'Wait before retrying brapi_get_germplasm; reduce concurrent requests to this BrAPI server.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'unknown_alias',
      code: JsonRpcErrorCode.NotFound,
      when: 'No connection is registered under the requested alias, and the server has no base URL configured for it to connect on first use',
      recovery:
        'Run brapi_connect with this alias and a `baseUrl`, or pass an alias the brapi_connect description lists as built-in or operator-configured, before calling brapi_get_germplasm.',
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
        'The BrAPI server is slow or unreachable right now. Retry brapi_get_germplasm in a minute; if it keeps failing, the server may be down.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unauthorized',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'The BrAPI server answered HTTP 401: it requires credentials, or rejected the ones sent',
      recovery:
        'Run brapi_connect with credentials in `auth`, or ask the operator to set server-side credentials for this alias, then retry brapi_get_germplasm.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The BrAPI server answered HTTP 403: the credentials sent, or their absence, lack access',
      recovery:
        'Run brapi_connect with credentials that have access, or ask the operator to set server-side credentials for this alias that do, then retry brapi_get_germplasm.',
      thrownBy: 'service',
    },
    {
      reason: 'alias_base_url_invalid',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'The base URL configured on the server for this alias is not an absolute http(s) URL, or carries credentials',
      recovery:
        'Ask the operator to set the base URL configured for this alias to an absolute http(s) URL, then retry brapi_get_germplasm.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'private_address_blocked',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The base URL configured for this alias, or its token URL, is on a private or reserved address this server may not reach',
      recovery:
        'Ask the operator to point this alias at a publicly routable host, or to allow private addresses on this server, then retry brapi_get_germplasm.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'germplasm_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Upstream returned no germplasm record for the requested DbId',
      recovery:
        'Verify the germplasmDbId on the target server, or run brapi_find_germplasm to discover valid IDs.',
    },
  ] as const,
  input: z.object({
    germplasmDbId: NonBlankString.describe('Germplasm identifier.'),
    alias: AliasInput,
  }),
  output: OutputSchema,

  async handler(input, ctx) {
    const capabilities = getCapabilityRegistry();
    const client = getBrapiClient();

    const connection = await requireRegisteredConnection(ctx, input.alias);

    const capabilityLookup: { auth?: typeof connection.resolvedAuth } = {};
    if (connection.resolvedAuth) capabilityLookup.auth = connection.resolvedAuth;
    await capabilities.ensure(
      connection.baseUrl,
      { service: 'germplasm', method: 'GET' },
      ctx,
      capabilityLookup,
    );

    const id = encodeURIComponent(input.germplasmDbId);
    const warnings: string[] = [];

    let germplasmEnv: Awaited<ReturnType<typeof client.get<Record<string, unknown>>>>;
    try {
      germplasmEnv = await client.get<Record<string, unknown>>(
        connection.baseUrl,
        `/germplasm/${id}`,
        ctx,
        buildRequestOptions(connection, undefined, { singleton: true }),
      );
    } catch (err) {
      if (isUpstreamNotFound(err)) {
        throw ctx.fail(
          'germplasm_not_found',
          `Germplasm '${input.germplasmDbId}' not found on ${connection.baseUrl}.`,
          { germplasmDbId: input.germplasmDbId, baseUrl: connection.baseUrl },
        );
      }
      throw err;
    }
    const germplasm = germplasmEnv.result;
    if (!germplasm || typeof germplasm !== 'object' || !germplasm.germplasmDbId) {
      throw ctx.fail(
        'germplasm_not_found',
        `Germplasm '${input.germplasmDbId}' not found on ${connection.baseUrl}.`,
        { germplasmDbId: input.germplasmDbId, baseUrl: connection.baseUrl },
      );
    }

    const profile = await capabilities.profile(connection.baseUrl, ctx, capabilityLookup);
    const supportsPedigree = Boolean(profile.supported['germplasm/{germplasmDbId}/pedigree']);
    const supportsAttributes = Boolean(profile.supported['germplasm/{germplasmDbId}/attributes']);
    const supportsProgeny = Boolean(profile.supported['germplasm/{germplasmDbId}/progeny']);
    const supportsStudies = profile.supported.studies?.methods?.includes('GET') ?? false;

    const dialect = supportsStudies
      ? await resolveDialect(connection, ctx, capabilityLookup)
      : undefined;

    const [pedigree, attributes, studyCount, progenyCount] = await Promise.all([
      supportsPedigree
        ? fetchPedigree(client, connection.baseUrl, id, ctx, buildRequestOptions(connection)).catch(
            (err) => recordWarning(warnings, 'pedigree lookup failed', err),
          )
        : Promise.resolve(undefined),
      supportsAttributes
        ? fetchAttributes(
            client,
            connection.baseUrl,
            id,
            ctx,
            buildRequestOptions(connection),
          ).catch((err) => recordWarning(warnings, 'attributes lookup failed', err))
        : Promise.resolve(undefined),
      supportsStudies && dialect
        ? fetchValidatedScopedCount({
            client,
            connection,
            ctx,
            dialect,
            label: 'studyCount',
            path: '/studies',
            scopeDescription: 'germplasm filter',
            scopeFilter: { germplasmDbIds: [input.germplasmDbId] },
            service: 'studies',
            warnings,
          }).catch((err) => recordWarning(warnings, 'study count probe failed', err))
        : Promise.resolve(undefined),
      supportsProgeny
        ? fetchTotalCount(
            client,
            connection.baseUrl,
            `/germplasm/${id}/progeny`,
            ctx,
            buildRequestOptions(connection, { pageSize: 1 }),
          ).catch((err) => recordWarning(warnings, 'progeny count probe failed', err))
        : Promise.resolve(undefined),
    ]);

    const parents = pedigree?.parents ?? [];
    const attrList = attributes ?? [];
    // Some Breedbase deployments (CassavaBase) repeat each synonym entry 11×.
    // Dedup structurally so the in-context view matches what `find_germplasm`
    // returns and the agent isn't asked to reason about phantom duplicates.
    const cleanedGermplasm = dedupSynonymsByIdentity(germplasm as Record<string, unknown>);

    const result: Output = {
      alias: connection.alias,
      germplasm: cleanedGermplasm as z.infer<typeof GermplasmSchema>,
      parents,
      attributes: attrList,
      directParentCount: parents.length,
      warnings,
    };
    if (typeof studyCount === 'number') result.studyCount = studyCount;
    if (typeof progenyCount === 'number') result.directDescendantCount = progenyCount;
    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    const g = result.germplasm;
    const GERMPLASM_RENDERED = new Set([
      'germplasmDbId',
      'germplasmName',
      'germplasmPUI',
      'commonCropName',
      'accessionNumber',
      'genus',
      'species',
      'subtaxa',
      'defaultDisplayName',
      'pedigree',
      'biologicalStatusOfAccessionDescription',
      'germplasmOrigin',
      'countryOfOriginCode',
      'collection',
      'instituteCode',
      'instituteName',
      'synonyms',
    ]);
    lines.push(literal`# ${g.germplasmName ?? g.defaultDisplayName ?? g.germplasmDbId}`);
    lines.push('');
    lines.push(literal`- **germplasmDbId:** \`${g.germplasmDbId}\``);
    if (g.germplasmName) lines.push(literal`- **germplasmName:** ${g.germplasmName}`);
    if (g.germplasmPUI) lines.push(literal`- **germplasmPUI:** ${g.germplasmPUI}`);
    if (g.commonCropName) lines.push(literal`- **commonCropName:** ${g.commonCropName}`);
    if (g.accessionNumber) lines.push(literal`- **accessionNumber:** ${g.accessionNumber}`);
    if (g.genus) lines.push(literal`- **genus:** ${g.genus}`);
    if (g.species) lines.push(literal`- **species:** ${g.species}`);
    if (g.subtaxa) lines.push(literal`- **subtaxa:** ${g.subtaxa}`);
    if (g.defaultDisplayName)
      lines.push(literal`- **defaultDisplayName:** ${g.defaultDisplayName}`);
    if (g.pedigree) lines.push(literal`- **pedigree (string):** ${g.pedigree}`);
    if (g.biologicalStatusOfAccessionDescription)
      lines.push(literal`- **biologicalStatus:** ${g.biologicalStatusOfAccessionDescription}`);
    if (g.germplasmOrigin?.length)
      lines.push(literal`- **germplasmOrigin:** ${JSON.stringify(g.germplasmOrigin)}`);
    if (g.countryOfOriginCode)
      lines.push(literal`- **countryOfOriginCode:** ${g.countryOfOriginCode}`);
    if (g.collection) lines.push(literal`- **collection:** ${g.collection}`);
    if (g.instituteCode) lines.push(literal`- **instituteCode:** ${g.instituteCode}`);
    if (g.instituteName) lines.push(literal`- **instituteName:** ${g.instituteName}`);
    if (g.synonyms?.length) {
      const synStr = g.synonyms
        .map((s) => `${s.synonym ?? '?'}${s.type ? ` (${s.type})` : ''}`)
        .join(', ');
      lines.push(literal`- **synonyms:** ${synStr}`);
    }
    appendPassthroughLines(lines, g as Record<string, unknown>, GERMPLASM_RENDERED);
    lines.push(literal`- **alias:** ${result.alias}`);

    lines.push('');
    lines.push(`## Parents (${result.directParentCount})`);
    if (result.parents.length === 0) {
      lines.push('_No parents recorded._');
    } else {
      const PARENT_RENDERED = new Set(['germplasmDbId', 'germplasmName', 'parentType']);
      for (const p of result.parents) {
        const parts: string[] = [];
        if (p.germplasmName) parts.push(prose(p.germplasmName));
        if (p.germplasmDbId) parts.push(literal`id=\`${p.germplasmDbId}\``);
        if (p.parentType) parts.push(literal`type=${p.parentType}`);
        parts.push(...collectPassthroughParts(p as Record<string, unknown>, PARENT_RENDERED));
        lines.push(`- ${parts.join(' · ')}`);
      }
    }

    lines.push('');
    lines.push(`## Attributes (${result.attributes.length})`);
    if (result.attributes.length === 0) {
      lines.push('_No attributes recorded._');
    } else {
      const ATTR_RENDERED = new Set([
        'attributeName',
        'attributeDbId',
        'attributeValue',
        'determinedDate',
      ]);
      for (const a of result.attributes) {
        const parts: string[] = [];
        if (a.attributeName) parts.push(prose(a.attributeName));
        if (a.attributeDbId) parts.push(literal`(id=\`${a.attributeDbId}\`)`);
        if (a.attributeValue != null) parts.push(literal`= ${a.attributeValue}`);
        if (a.determinedDate) parts.push(literal`[determined ${a.determinedDate}]`);
        parts.push(...collectPassthroughParts(a as Record<string, unknown>, ATTR_RENDERED));
        lines.push(`- ${parts.join(' ')}`);
      }
    }

    lines.push('');
    lines.push('## Drill-down signals');
    lines.push(`- studyCount: ${result.studyCount ?? '—'}`);
    lines.push(`- directParentCount: ${result.directParentCount}`);
    lines.push(`- directDescendantCount: ${result.directDescendantCount ?? '—'}`);

    if (result.warnings.length > 0) {
      lines.push('');
      lines.push('## Warnings');
      for (const w of result.warnings) lines.push(literal`- ${w}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

function recordWarning(warnings: string[], label: string, err: unknown): undefined {
  warnings.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
  return;
}

async function fetchPedigree(
  client: ReturnType<typeof getBrapiClient>,
  baseUrl: string,
  id: string,
  ctx: Parameters<typeof client.get>[2],
  options: Parameters<typeof client.get>[3],
): Promise<{ parents: z.infer<typeof ParentSchema>[] } | undefined> {
  const env = await client.get<Record<string, unknown>>(
    baseUrl,
    `/germplasm/${id}/pedigree`,
    ctx,
    options,
  );
  const result = env.result;
  if (!result || typeof result !== 'object') return { parents: [] };
  const rawParents = (result as { parents?: unknown }).parents;
  if (!Array.isArray(rawParents)) return { parents: [] };
  return {
    parents: rawParents.filter(
      (p): p is z.infer<typeof ParentSchema> => typeof p === 'object' && p !== null,
    ),
  };
}

async function fetchAttributes(
  client: ReturnType<typeof getBrapiClient>,
  baseUrl: string,
  id: string,
  ctx: Parameters<typeof client.get>[2],
  options: Parameters<typeof client.get>[3],
): Promise<z.infer<typeof AttributeSchema>[]> {
  const env = await client.get<{ data?: unknown[] } | unknown[]>(
    baseUrl,
    `/germplasm/${id}/attributes`,
    ctx,
    options,
  );
  const result = env.result;
  const rows = Array.isArray(result)
    ? result
    : Array.isArray((result as { data?: unknown[] })?.data)
      ? (result as { data: unknown[] }).data
      : [];
  return rows.filter(
    (r): r is z.infer<typeof AttributeSchema> => typeof r === 'object' && r !== null,
  );
}
