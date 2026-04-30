/**
 * @fileoverview `brapi_walk_pedigree` — walk germplasm ancestry or
 * descendancy as a DAG. BrAPI only exposes direct parents / direct progeny
 * per call, so we BFS outward from each root up to `maxDepth`, deduplicate
 * nodes (cultivars may appear on multiple paths), and break cycles.
 * Response includes traversal stats so the agent can see how the walk
 * terminated without re-running the tool.
 *
 * @module mcp-server/tools/definitions/brapi-walk-pedigree.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { type BrapiClient, getBrapiClient } from '@/services/brapi-client/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import { DEFAULT_ALIAS, getServerRegistry } from '@/services/server-registry/index.js';
import type { RegisteredServer } from '@/services/server-registry/types.js';
import { AliasInput, buildRequestOptions, isUpstreamNotFound } from '../shared/find-helpers.js';

const DEFAULT_MAX_DEPTH = 3;
const MAX_NODES = 1_000;

const NodeSchema = z
  .object({
    germplasmDbId: z.string().describe('Server-side identifier for the germplasm.'),
    germplasmName: z.string().optional().describe('Display name of the germplasm.'),
    depth: z
      .number()
      .int()
      .nonnegative()
      .describe('Min distance from any root germplasm (0 for roots).'),
    isRoot: z.boolean().describe('True when this node is one of the starting germplasm.'),
  })
  .describe('One germplasm reached during the walk.');

const EdgeSchema = z
  .object({
    from: z.string().describe('germplasmDbId of the source of the relationship.'),
    to: z.string().describe('germplasmDbId of the target.'),
    relationship: z
      .enum(['parent', 'child'])
      .describe('Direction: parent = from is a parent of to; child = from is a descendant of to.'),
    parentType: z
      .string()
      .optional()
      .describe('E.g. MALE, FEMALE, SELF, when the upstream response supplies it.'),
  })
  .describe('One deduplicated pedigree edge between two nodes.');

const OutputSchema = z.object({
  alias: z.string().describe('Alias of the registered BrAPI connection the call used.'),
  direction: z
    .enum(['ancestors', 'descendants', 'both'])
    .describe('The direction the walk expanded (echoed from the input).'),
  maxDepth: z
    .number()
    .int()
    .positive()
    .describe('The maximum depth the walk was allowed to reach (echoed from the input).'),
  nodes: z
    .array(NodeSchema)
    .describe(
      'Deduplicated node list — every germplasm reached by the walk, sorted by depth then DbId.',
    ),
  edges: z
    .array(EdgeSchema)
    .describe(
      'Deduplicated edge list. `relationship: "parent"` means `from` is a parent of `to`; `relationship: "child"` means `from` is a descendant of `to`.',
    ),
  depthReached: z
    .number()
    .int()
    .nonnegative()
    .describe(
      'Deepest BFS level that produced at least one new edge (0 if only roots were walked).',
    ),
  rootCount: z.number().int().nonnegative().describe('Number of starting germplasm roots.'),
  leafCount: z
    .number()
    .int()
    .nonnegative()
    .describe('Nodes that have no outgoing edges in the walked direction — terminal in the DAG.'),
  cycleCount: z
    .number()
    .int()
    .nonnegative()
    .describe('Number of times the walk revisited an already-registered node (cycles broken).'),
  deadEndCount: z
    .number()
    .int()
    .nonnegative()
    .describe('Nodes whose upstream pedigree/progeny lookup failed.'),
  truncated: z
    .boolean()
    .describe(`True when the walk hit the ${MAX_NODES}-node safety cap before exhausting depth.`),
  warnings: z
    .array(z.string())
    .describe('Advisory messages (capability gaps, per-node expansion failures).'),
});

type Output = z.infer<typeof OutputSchema>;

export const brapiWalkPedigree = tool('brapi_walk_pedigree', {
  description:
    'Walk germplasm ancestry or descendancy as a deduplicated DAG, with multi-generation traversal, cycle detection, and depth limits. Returns nodes + edges plus traversal stats (depthReached, rootCount, leafCount, cycleCount, deadEndCount).',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    germplasmDbIds: z
      .array(z.string().min(1))
      .min(1)
      .max(20)
      .describe('Starting germplasm (1–20 roots). All roots are walked concurrently.'),
    direction: z
      .enum(['ancestors', 'descendants', 'both'])
      .default('ancestors')
      .describe('Which direction to walk: ancestors (parents), descendants (progeny), or both.'),
    maxDepth: z
      .number()
      .int()
      .positive()
      .max(10)
      .default(DEFAULT_MAX_DEPTH)
      .describe(`Max generations to walk per direction (default ${DEFAULT_MAX_DEPTH}, cap 10).`),
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

    const profile = await capabilities.profile(connection.baseUrl, ctx, capabilityLookup);
    const hasPedigree = Boolean(profile.supported['germplasm/{germplasmDbId}/pedigree']);
    const hasProgeny = Boolean(profile.supported['germplasm/{germplasmDbId}/progeny']);

    const warnings: string[] = [];
    const wantsAncestors = input.direction === 'ancestors' || input.direction === 'both';
    const wantsDescendants = input.direction === 'descendants' || input.direction === 'both';

    if (wantsAncestors && !hasPedigree) {
      warnings.push(
        'Server does not expose /germplasm/{id}/pedigree — ancestor traversal is skipped.',
      );
    }
    if (wantsDescendants && !hasProgeny) {
      warnings.push(
        'Server does not expose /germplasm/{id}/progeny — descendant traversal is skipped.',
      );
    }

    if (hasPedigree) {
      const missing = await Promise.all(
        input.germplasmDbIds.map(async (id) =>
          (await rootExists(id, client, connection, ctx)) ? null : id,
        ),
      );
      for (const id of missing) {
        if (id) warnings.push(`Root germplasm '${id}' was not found in /germplasm/{id}/pedigree.`);
      }
    }

    const state = createWalkState(input.germplasmDbIds);
    let truncated = false;
    let cycleCount = 0;
    let deadEndCount = 0;
    let depthReached = 0;

    for (let depth = 1; depth <= input.maxDepth; depth++) {
      if (state.nodes.size >= MAX_NODES) {
        truncated = true;
        break;
      }
      const previousFrontier = state.frontier;
      state.frontier = new Set();
      if (previousFrontier.size === 0) break;

      const exp = await Promise.all(
        Array.from(previousFrontier).map(async (id) =>
          expandNode(id, {
            client,
            connection,
            ctx,
            walkAncestors: wantsAncestors && hasPedigree,
            walkDescendants: wantsDescendants && hasProgeny,
          }),
        ),
      );

      let producedEdge = false;
      for (const result of exp) {
        if (result.kind === 'deadEnd') {
          deadEndCount++;
          warnings.push(`Expansion failed for ${result.id}: ${result.error}`);
          continue;
        }

        for (const parent of result.parents) {
          const already = state.nodes.has(parent.germplasmDbId);
          registerNode(state, parent.germplasmDbId, parent.germplasmName, depth);
          const edge: z.infer<typeof EdgeSchema> = {
            from: parent.germplasmDbId,
            to: result.id,
            relationship: 'parent',
          };
          if (parent.parentType) edge.parentType = parent.parentType;
          const inverseKnown = isInverseEdgeKnown(state, edge);
          if (addEdge(state, edge)) producedEdge = true;
          if (already) {
            // direction='both' walks BFS in two directions concurrently — we
            // expect to re-encounter nodes via the inverse relationship as the
            // expansions meet. That's a structural symmetry, not a cycle.
            if (!inverseKnown) cycleCount++;
          } else {
            state.frontier.add(parent.germplasmDbId);
          }
        }

        for (const child of result.children) {
          const already = state.nodes.has(child.germplasmDbId);
          registerNode(state, child.germplasmDbId, child.germplasmName, depth);
          const edge: z.infer<typeof EdgeSchema> = {
            from: child.germplasmDbId,
            to: result.id,
            relationship: 'child',
          };
          const inverseKnown = isInverseEdgeKnown(state, edge);
          if (addEdge(state, edge)) producedEdge = true;
          if (already) {
            if (!inverseKnown) cycleCount++;
          } else {
            state.frontier.add(child.germplasmDbId);
          }
        }
      }

      if (producedEdge) depthReached = depth;
      if (state.frontier.size === 0) break;
    }

    const nodes = Array.from(state.nodes.values()).sort(
      (a, b) => a.depth - b.depth || a.germplasmDbId.localeCompare(b.germplasmDbId),
    );
    const edges = Array.from(state.edges.values());

    const leafCount = computeLeafCount(nodes, edges);

    const result: Output = {
      alias: connection.alias,
      direction: input.direction,
      maxDepth: input.maxDepth,
      nodes,
      edges,
      depthReached,
      rootCount: input.germplasmDbIds.length,
      leafCount,
      cycleCount,
      deadEndCount,
      truncated,
      warnings,
    };
    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(
      `# Pedigree walk — ${result.direction}, depth ${result.depthReached}/${result.maxDepth} — \`${result.alias}\``,
    );
    lines.push('');
    lines.push('## Stats');
    lines.push(`- nodes: ${result.nodes.length}`);
    lines.push(`- edges: ${result.edges.length}`);
    lines.push(`- rootCount: ${result.rootCount}`);
    lines.push(`- leafCount: ${result.leafCount}`);
    lines.push(`- cycleCount: ${result.cycleCount}`);
    lines.push(`- deadEndCount: ${result.deadEndCount}`);
    lines.push(`- truncated: ${result.truncated}`);

    if (result.nodes.length > 0) {
      lines.push('');
      lines.push('## Nodes');
      for (const node of result.nodes) {
        const parts: string[] = [`**${node.germplasmName ?? node.germplasmDbId}**`];
        parts.push(`id=\`${node.germplasmDbId}\``);
        parts.push(`depth=${node.depth}`);
        if (node.isRoot) parts.push('root');
        lines.push(`- ${parts.join(' · ')}`);
      }
    }

    if (result.edges.length > 0) {
      lines.push('');
      lines.push('## Edges');
      for (const edge of result.edges) {
        const suffix = edge.parentType ? ` (${edge.parentType})` : '';
        const arrow = edge.relationship === 'parent' ? '→' : '←';
        lines.push(`- \`${edge.from}\` ${arrow} \`${edge.to}\` · ${edge.relationship}${suffix}`);
      }
    }

    if (result.warnings.length > 0) {
      lines.push('');
      lines.push('## Warnings');
      for (const w of result.warnings) lines.push(`- ${w}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});

interface WalkState {
  edges: Map<string, z.infer<typeof EdgeSchema>>;
  frontier: Set<string>;
  nodes: Map<string, z.infer<typeof NodeSchema>>;
}

function createWalkState(rootIds: readonly string[]): WalkState {
  const nodes = new Map<string, z.infer<typeof NodeSchema>>();
  const frontier = new Set<string>();
  for (const id of rootIds) {
    nodes.set(id, { germplasmDbId: id, depth: 0, isRoot: true });
    frontier.add(id);
  }
  return { nodes, edges: new Map(), frontier };
}

function registerNode(state: WalkState, id: string, name: string | undefined, depth: number): void {
  const existing = state.nodes.get(id);
  if (existing) {
    if (!existing.germplasmName && name) existing.germplasmName = name;
    if (depth < existing.depth) existing.depth = depth;
    return;
  }
  const node: z.infer<typeof NodeSchema> = { germplasmDbId: id, depth, isRoot: false };
  if (name) node.germplasmName = name;
  state.nodes.set(id, node);
}

function addEdge(state: WalkState, edge: z.infer<typeof EdgeSchema>): boolean {
  const key = `${edge.relationship}:${edge.from}→${edge.to}`;
  if (state.edges.has(key)) return false;
  state.edges.set(key, edge);
  return true;
}

/**
 * `parent: A→B` and `child: B→A` describe the same biological relationship
 * from opposite ends. When direction='both', BFS will discover both —
 * detecting the inverse lets us avoid double-counting it as a cycle.
 */
function isInverseEdgeKnown(state: WalkState, edge: z.infer<typeof EdgeSchema>): boolean {
  const inverseRel = edge.relationship === 'parent' ? 'child' : 'parent';
  return state.edges.has(`${inverseRel}:${edge.to}→${edge.from}`);
}

type Expansion =
  | {
      kind: 'ok';
      id: string;
      parents: Array<{ germplasmDbId: string; germplasmName?: string; parentType?: string }>;
      children: Array<{ germplasmDbId: string; germplasmName?: string }>;
    }
  | { kind: 'deadEnd'; id: string; error: string };

interface ExpandInput {
  client: BrapiClient;
  connection: RegisteredServer;
  ctx: Context;
  walkAncestors: boolean;
  walkDescendants: boolean;
}

async function expandNode(id: string, input: ExpandInput): Promise<Expansion> {
  try {
    const encoded = encodeURIComponent(id);
    const [pedigree, progeny] = await Promise.all([
      input.walkAncestors
        ? fetchPedigree(input.client, input.connection, encoded, input.ctx)
        : Promise.resolve([]),
      input.walkDescendants
        ? fetchProgeny(input.client, input.connection, encoded, input.ctx)
        : Promise.resolve([]),
    ]);
    return { kind: 'ok', id, parents: pedigree, children: progeny };
  } catch (err) {
    return {
      kind: 'deadEnd',
      id,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function rootExists(
  id: string,
  client: BrapiClient,
  connection: RegisteredServer,
  ctx: Context,
): Promise<boolean> {
  try {
    const env = await client.get<Record<string, unknown> | null>(
      connection.baseUrl,
      `/germplasm/${encodeURIComponent(id)}/pedigree`,
      ctx,
      buildRequestOptions(connection),
    );
    // Some servers (e.g. test-server.brapi.org) reply 200 with `result: null`
    // for unknown germplasm instead of 404.
    return env.result != null;
  } catch (err) {
    if (isUpstreamNotFound(err)) return false;
    // Non-404 errors get surfaced when the BFS later expands the node.
    return true;
  }
}

async function fetchPedigree(
  client: BrapiClient,
  connection: RegisteredServer,
  encodedId: string,
  ctx: Context,
): Promise<Array<{ germplasmDbId: string; germplasmName?: string; parentType?: string }>> {
  const env = await client.get<Record<string, unknown>>(
    connection.baseUrl,
    `/germplasm/${encodedId}/pedigree`,
    ctx,
    buildRequestOptions(connection),
  );
  const rawParents = (env.result as { parents?: unknown })?.parents;
  if (!Array.isArray(rawParents)) return [];
  const parents: Array<{ germplasmDbId: string; germplasmName?: string; parentType?: string }> = [];
  for (const entry of rawParents) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const dbId = record.germplasmDbId;
    if (typeof dbId !== 'string' || dbId.length === 0) continue;
    const item: { germplasmDbId: string; germplasmName?: string; parentType?: string } = {
      germplasmDbId: dbId,
    };
    if (typeof record.germplasmName === 'string') item.germplasmName = record.germplasmName;
    if (typeof record.parentType === 'string') item.parentType = record.parentType;
    parents.push(item);
  }
  return parents;
}

async function fetchProgeny(
  client: BrapiClient,
  connection: RegisteredServer,
  encodedId: string,
  ctx: Context,
): Promise<Array<{ germplasmDbId: string; germplasmName?: string }>> {
  const env = await client.get<Record<string, unknown> | null>(
    connection.baseUrl,
    `/germplasm/${encodedId}/progeny`,
    ctx,
    buildRequestOptions(connection),
  );
  const result = env.result as { progeny?: unknown; data?: unknown } | null;
  const rawProgeny = result?.progeny;
  const fallback = Array.isArray(rawProgeny)
    ? rawProgeny
    : Array.isArray(result?.data)
      ? (result.data as unknown[])
      : [];
  const children: Array<{ germplasmDbId: string; germplasmName?: string }> = [];
  for (const entry of fallback) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const dbId = record.germplasmDbId;
    if (typeof dbId !== 'string' || dbId.length === 0) continue;
    const item: { germplasmDbId: string; germplasmName?: string } = { germplasmDbId: dbId };
    if (typeof record.germplasmName === 'string') item.germplasmName = record.germplasmName;
    children.push(item);
  }
  return children;
}

function computeLeafCount(
  nodes: z.infer<typeof NodeSchema>[],
  edges: z.infer<typeof EdgeSchema>[],
): number {
  // A leaf has no outgoing edge (in the walked direction). For 'parent'
  // edges, `from` is the parent — so nodes that never appear as `from` in
  // parent edges are ancestry-leaves. For 'child' edges, nodes that never
  // appear as `from` in child edges are descendancy-leaves.
  const parentSources = new Set<string>();
  const childSources = new Set<string>();
  for (const edge of edges) {
    if (edge.relationship === 'parent') parentSources.add(edge.from);
    else childSources.add(edge.from);
  }
  let leaves = 0;
  for (const node of nodes) {
    const hasParentOut = parentSources.has(node.germplasmDbId);
    const hasChildOut = childSources.has(node.germplasmDbId);
    if (!hasParentOut && !hasChildOut) leaves++;
  }
  return leaves;
}
