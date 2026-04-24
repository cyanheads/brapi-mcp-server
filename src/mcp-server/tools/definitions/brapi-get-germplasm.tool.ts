/**
 * @fileoverview `brapi_get_germplasm` — fetch a single germplasm with
 * attributes and direct parents, plus companion counts (studies the
 * germplasm has appeared in, direct parents, direct descendants) to signal
 * where to drill next.
 *
 * @module mcp-server/tools/definitions/brapi-get-germplasm.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { getBrapiClient } from '@/services/brapi-client/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import { DEFAULT_ALIAS, getServerRegistry } from '@/services/server-registry/index.js';
import { AliasInput, buildRequestOptions } from '../shared/find-helpers.js';

const GermplasmSchema = z
  .object({
    germplasmDbId: z.string(),
    germplasmName: z.string().optional(),
    germplasmPUI: z.string().optional(),
    commonCropName: z.string().optional(),
    accessionNumber: z.string().optional(),
    genus: z.string().optional(),
    species: z.string().optional(),
    subtaxa: z.string().optional(),
    defaultDisplayName: z.string().optional(),
    pedigree: z.string().optional(),
    biologicalStatusOfAccessionDescription: z.string().optional(),
    germplasmOrigin: z.string().optional(),
    countryOfOriginCode: z.string().optional(),
    collection: z.string().optional(),
    instituteCode: z.string().optional(),
    instituteName: z.string().optional(),
    synonyms: z
      .array(
        z.object({ synonym: z.string().optional(), type: z.string().optional() }).passthrough(),
      )
      .optional(),
  })
  .passthrough();

const ParentSchema = z
  .object({
    germplasmDbId: z.string().optional(),
    germplasmName: z.string().optional(),
    parentType: z.string().optional().describe('E.g. "MALE", "FEMALE", "SELF".'),
  })
  .passthrough();

const AttributeSchema = z
  .object({
    attributeDbId: z.string().optional(),
    attributeName: z.string().optional(),
    attributeValue: z.string().optional(),
    determinedDate: z.string().optional(),
  })
  .passthrough();

const OutputSchema = z.object({
  alias: z.string(),
  germplasm: GermplasmSchema,
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
  directParentCount: z.number().int().nonnegative().describe('Count of direct parents.'),
  directDescendantCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Count of direct descendants from /germplasm/{id}/progeny.'),
  warnings: z.array(z.string()),
});

type Output = z.infer<typeof OutputSchema>;

export const brapiGetGermplasm = tool('brapi_get_germplasm', {
  description:
    'Fetch a single germplasm by DbId with attributes and direct parents. Response companions report study count, direct parent count, and direct descendant count — signals for pedigree depth and observation coverage.',
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    germplasmDbId: z.string().min(1),
    alias: AliasInput,
  }),
  output: OutputSchema,

  async handler(input, ctx) {
    const registry = getServerRegistry();
    const capabilities = getCapabilityRegistry();
    const client = getBrapiClient();

    const connection = await registry.get(ctx, input.alias ?? DEFAULT_ALIAS);

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

    const germplasmEnv = await client.get<Record<string, unknown>>(
      connection.baseUrl,
      `/germplasm/${id}`,
      ctx,
      buildRequestOptions(connection),
    );
    const germplasm = germplasmEnv.result;
    if (!germplasm || typeof germplasm !== 'object' || !germplasm.germplasmDbId) {
      throw notFound(`Germplasm '${input.germplasmDbId}' not found on ${connection.baseUrl}.`, {
        germplasmDbId: input.germplasmDbId,
        baseUrl: connection.baseUrl,
      });
    }

    const [pedigree, attributes, studyCount, progenyCount] = await Promise.all([
      fetchPedigree(client, connection.baseUrl, id, ctx, buildRequestOptions(connection)).catch(
        (err) => recordWarning(warnings, 'pedigree lookup failed', err),
      ),
      fetchAttributes(client, connection.baseUrl, id, ctx, buildRequestOptions(connection)).catch(
        (err) => recordWarning(warnings, 'attributes lookup failed', err),
      ),
      fetchTotalCount(
        client,
        connection.baseUrl,
        '/studies',
        ctx,
        buildRequestOptions(connection, { germplasmDbIds: [input.germplasmDbId], pageSize: 0 }),
      ).catch((err) => recordWarning(warnings, 'study count probe failed', err)),
      fetchTotalCount(
        client,
        connection.baseUrl,
        `/germplasm/${id}/progeny`,
        ctx,
        buildRequestOptions(connection, { pageSize: 0 }),
      ).catch((err) => recordWarning(warnings, 'progeny count probe failed', err)),
    ]);

    const parents = pedigree?.parents ?? [];
    const attrList = attributes ?? [];

    const result: Output = {
      alias: connection.alias,
      germplasm: germplasm as z.infer<typeof GermplasmSchema>,
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
    lines.push(`# ${g.germplasmName ?? g.defaultDisplayName ?? g.germplasmDbId}`);
    lines.push('');
    lines.push(`- **germplasmDbId:** \`${g.germplasmDbId}\``);
    if (g.germplasmName) lines.push(`- **germplasmName:** ${g.germplasmName}`);
    if (g.germplasmPUI) lines.push(`- **germplasmPUI:** ${g.germplasmPUI}`);
    if (g.commonCropName) lines.push(`- **commonCropName:** ${g.commonCropName}`);
    if (g.accessionNumber) lines.push(`- **accessionNumber:** ${g.accessionNumber}`);
    if (g.genus) lines.push(`- **genus:** ${g.genus}`);
    if (g.species) lines.push(`- **species:** ${g.species}`);
    if (g.subtaxa) lines.push(`- **subtaxa:** ${g.subtaxa}`);
    if (g.defaultDisplayName) lines.push(`- **defaultDisplayName:** ${g.defaultDisplayName}`);
    if (g.pedigree) lines.push(`- **pedigree (string):** ${g.pedigree}`);
    if (g.biologicalStatusOfAccessionDescription)
      lines.push(`- **biologicalStatus:** ${g.biologicalStatusOfAccessionDescription}`);
    if (g.germplasmOrigin) lines.push(`- **germplasmOrigin:** ${g.germplasmOrigin}`);
    if (g.countryOfOriginCode) lines.push(`- **countryOfOriginCode:** ${g.countryOfOriginCode}`);
    if (g.collection) lines.push(`- **collection:** ${g.collection}`);
    if (g.instituteCode) lines.push(`- **instituteCode:** ${g.instituteCode}`);
    if (g.instituteName) lines.push(`- **instituteName:** ${g.instituteName}`);
    if (g.synonyms?.length) {
      const synStr = g.synonyms
        .map((s) => `${s.synonym ?? '?'}${s.type ? ` (${s.type})` : ''}`)
        .join(', ');
      lines.push(`- **synonyms:** ${synStr}`);
    }
    lines.push(`- **alias:** ${result.alias}`);

    lines.push('');
    lines.push(`## Parents (${result.directParentCount})`);
    if (result.parents.length === 0) {
      lines.push('_No parents recorded._');
    } else {
      for (const p of result.parents) {
        const parts: string[] = [];
        if (p.germplasmName) parts.push(p.germplasmName);
        if (p.germplasmDbId) parts.push(`id=\`${p.germplasmDbId}\``);
        if (p.parentType) parts.push(`type=${p.parentType}`);
        lines.push(`- ${parts.join(' · ')}`);
      }
    }

    lines.push('');
    lines.push(`## Attributes (${result.attributes.length})`);
    if (result.attributes.length === 0) {
      lines.push('_No attributes recorded._');
    } else {
      for (const a of result.attributes) {
        const parts: string[] = [];
        if (a.attributeName) parts.push(a.attributeName);
        if (a.attributeDbId) parts.push(`(id=\`${a.attributeDbId}\`)`);
        if (a.attributeValue !== undefined) parts.push(`= ${a.attributeValue}`);
        if (a.determinedDate) parts.push(`[determined ${a.determinedDate}]`);
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
      for (const w of result.warnings) lines.push(`- ${w}`);
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
