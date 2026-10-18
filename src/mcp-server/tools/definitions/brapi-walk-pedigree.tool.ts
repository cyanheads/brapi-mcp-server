/**
 * @fileoverview `brapi_walk_pedigree` — walk germplasm ancestry or
 * descendancy as a DAG. BrAPI only exposes direct parents / direct progeny
 * per call, so we BFS outward from each root up to `maxDepth`: ancestors are
 * walked only upward (/pedigree) and descendants only downward (/progeny), so
 * `both` is the union of the two walks. Each parent–child pair is one edge;
 * an edge that makes a germplasm its own ancestor is kept, marked `isCycle`,
 * and not walked further. Response includes traversal stats so the agent can
 * see how the walk terminated without re-running the tool.
 *
 * @module mcp-server/tools/definitions/brapi-walk-pedigree.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import {
  type BrapiClient,
  type BrapiEnvelope,
  getBrapiClient,
} from '@/services/brapi-client/index.js';
import { getCanvasBridge } from '@/services/canvas-bridge/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import type { RegisteredServer } from '@/services/server-registry/types.js';
import {
  AliasInput,
  buildRequestOptions,
  type DataframeHandle,
  DataframeHandleSchema,
  isUpstreamNotFound,
  LoadLimitInput,
  NonBlankString,
  renderDataframeHandle,
  requireRegisteredConnection,
  stagedDataframeNotice,
  toDataframeHandle,
} from '../shared/find-helpers.js';
import { selectPreviewRows } from '../shared/inline-preview.js';
import { renderPedigreeDiagram } from '../shared/pedigree-diagram.js';

const DEFAULT_MAX_DEPTH = 3;
const MAX_NODES = 1_000;
/**
 * Edge ceiling. Loop detection walks the recorded edges for every pair that
 * reconnects two known germplasm, so the edge count bounds that work as well
 * as the payload. Real pedigrees stay far below it: each germplasm has a
 * handful of parents.
 */
const MAX_EDGES = 10 * MAX_NODES;

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
    direction: z
      .enum(['root', 'ancestor', 'descendant', 'both'])
      .describe(
        '`root` = a starting germplasm; `ancestor` = reached upward via /pedigree; `descendant` = reached downward via /progeny; `both` = reached from both sides (a descendant of one root and an ancestor of another, or a node on a pedigree loop).',
      ),
  })
  .describe('One germplasm reached during the walk.');

const EdgeSchema = z
  .object({
    from: z.string().describe('germplasmDbId of the source of the relationship.'),
    to: z.string().describe('germplasmDbId of the target.'),
    relationship: z
      .enum(['parent', 'child'])
      .describe(
        'Which lookup found the pair. parent = from is a parent of to (found via /pedigree); child = from is a child of to (found via /progeny). A pair found both ways is listed once, as parent.',
      ),
    parentType: z
      .string()
      .optional()
      .describe(
        "The parent's role in the cross (e.g. MALE, FEMALE, SELF), when the upstream response supplies it.",
      ),
    isCycle: z
      .boolean()
      .optional()
      .describe(
        'True when this edge closes a loop (the parent is already a descendant of the child); the walk does not continue past it. Absent on other edges.',
      ),
  })
  .describe('One parent–child pair, recorded once whichever side found it.');

const FrontierSchema = z
  .object({
    germplasmDbId: z.string().describe('Expansion node identifier.'),
    side: z.enum(['ancestor', 'descendant']).describe('Direction not fully expanded.'),
    outcome: z
      .enum(['depth_limited', 'safety_skipped', 'failed', 'unsupported'])
      .describe('Why this direction remains unresolved.'),
    knownOmittedRelativeCount: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Already-fetched relatives omitted from the discovered graph; absent when not requested or failed.',
      ),
    error: z.string().optional().describe('Failure message for a failed expansion.'),
  })
  .describe('One unresolved expansion direction, distinct from a confirmed empty lookup.');

const SnapshotHandleSchema = DataframeHandleSchema.omit({
  truncated: true,
  maxRows: true,
  totalCount: true,
});

const OutputSchema = z.object({
  alias: z.string().describe('Connection alias the call used.'),
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
      'Discovered nodes sorted by depth/DbId. Preview fits loadLimit and 24,000 bytes for array JSON and serialized row text; nodesDataframe retains omitted rows.',
    ),
  edges: z
    .array(EdgeSchema)
    .describe(
      'One edge per discovered pair. Preview independently fits loadLimit and 24,000 bytes for array JSON and serialized row text; edgesDataframe retains omitted rows.',
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
    .describe(
      'Non-root nodes with nothing recorded beyond them: ancestors with no parents, descendants with no progeny (a node on both sides needs neither). Includes nodes the depth limit stopped at.',
    ),
  confirmedLeafCount: z
    .number()
    .int()
    .nonnegative()
    .describe(
      'Non-root nodes with successful empty lookups on every reached side; unresolved directions never confirm leaves.',
    ),
  frontierCount: z
    .number()
    .int()
    .nonnegative()
    .describe('Unresolved node/side expansions across the full walk.'),
  frontier: z
    .array(FrontierSchema)
    .describe(
      'Bounded preview of unresolved directions; frontierDataframe retains omitted entries.',
    ),
  frontierDataframe: SnapshotHandleSchema.optional().describe(
    'Every unresolved node/side expansion, with ordinal ordering.',
  ),
  knownOmittedRelativeCount: z
    .number()
    .int()
    .nonnegative()
    .describe(
      'Distinct fetched relative IDs per expansion node/side omitted by safety limits; unrequested counts remain unknown.',
    ),
  omittedRelativesDataframe: SnapshotHandleSchema.optional().describe(
    'Fetched omitted relatives with ordinal, germplasmDbId, expansionNodeDbId and side; not an unvisited graph or resumable walk.',
  ),
  cycleCount: z
    .number()
    .int()
    .nonnegative()
    .describe(
      'Number of edges with isCycle: true. Paths that reconverge on one germplasm (shared ancestors, siblings, a parent shared by two roots) are not cycles.',
    ),
  deadEndCount: z
    .number()
    .int()
    .nonnegative()
    .describe('Nodes whose upstream pedigree/progeny lookup failed.'),
  truncated: z
    .boolean()
    .describe(
      `True when the walk hit its safety cap (${MAX_NODES} nodes or ${MAX_EDGES} edges) before exhausting depth.`,
    ),
  warnings: z
    .array(z.string())
    .describe(
      'Advisory messages (capability gaps, per-node expansion failures, an omitted diagram).',
    ),
  diagram: z
    .string()
    .optional()
    .describe(
      'Requested Mermaid or DOT for the discovered graph, beyond previews; partial when capped. Omitted with a warning past 50,000 characters, or 500 edges for Mermaid.',
    ),
  nodesDataframe: DataframeHandleSchema.optional().describe(
    'Discovered nodes when either preview is trimmed; truncated marks partial traversal. No unvisited relatives. JOIN germplasmDbId to the edge table on from_ or to.',
  ),
  edgesDataframe: DataframeHandleSchema.optional().describe(
    'Discovered edges when either preview is trimmed; truncated marks partial traversal. SQL renames from to from_; see columnLegend.',
  ),
});

type Output = z.infer<typeof OutputSchema>;

export const brapiWalkPedigree = tool('brapi_walk_pedigree', {
  description:
    'Walk germplasm ancestry or descendancy as a deduplicated DAG with cycle detection and depth limits. leafCount counts graph terminals, confirmedLeafCount counts successfully verified leaves, and frontier records unresolved directions. Nodes and edges each fit loadLimit and a 24,000-byte preview budget; trimmed discovered graphs and already-fetched omitted relatives are staged for brapi_dataframe_describe and brapi_dataframe_query (SQL). Diagrams describe only the discovered graph, never unvisited relatives.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'unknown_alias',
      code: JsonRpcErrorCode.NotFound,
      when: 'No connection is registered under the requested alias, and the server has no base URL configured for it to connect on first use',
      recovery:
        'Run brapi_connect with this alias and a `baseUrl`, or pass an alias the brapi_connect description lists as built-in or operator-configured, before calling brapi_walk_pedigree.',
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
        'The BrAPI server is slow or unreachable right now. Retry brapi_walk_pedigree in a minute; if it keeps failing, the server may be down.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unauthorized',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'The BrAPI server answered HTTP 401: it requires credentials, or rejected the ones sent',
      recovery:
        'Run brapi_connect with credentials in `auth`, or ask the operator to set server-side credentials for this alias, then retry brapi_walk_pedigree.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The BrAPI server answered HTTP 403: the credentials sent, or their absence, lack access',
      recovery:
        'Run brapi_connect with credentials that have access, or ask the operator to set server-side credentials for this alias that do, then retry brapi_walk_pedigree.',
      thrownBy: 'service',
    },
    {
      reason: 'alias_base_url_invalid',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'The base URL configured on the server for this alias is not an absolute http(s) URL, or carries credentials',
      recovery:
        'Ask the operator to set the base URL configured for this alias to an absolute http(s) URL, then retry brapi_walk_pedigree.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'private_address_blocked',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The base URL configured for this alias, or its token URL, is on a private or reserved address this server may not reach',
      recovery:
        'Ask the operator to point this alias at a publicly routable host, or to allow private addresses on this server, then retry brapi_walk_pedigree.',
      retryable: false,
      thrownBy: 'service',
    },
  ] as const,
  input: z.object({
    germplasmDbIds: z
      .array(NonBlankString)
      .min(1)
      .max(20)
      .describe('Starting germplasm (1–20 roots). All roots are walked concurrently.'),
    direction: z
      .enum(['ancestors', 'descendants', 'both'])
      .default('ancestors')
      .describe(
        "Which direction to walk: ancestors (parents), descendants (progeny), or both — the union of the two walks. Ancestors are walked only upward and descendants only downward, so a descendant's other parent is not included.",
      ),
    maxDepth: z
      .number()
      .int()
      .positive()
      .max(10)
      .default(DEFAULT_MAX_DEPTH)
      .describe(`Max generations to walk per direction (default ${DEFAULT_MAX_DEPTH}, cap 10).`),
    diagram: z
      .enum(['mermaid', 'dot'])
      .optional()
      .describe(
        'Also return the walk as diagram source: `mermaid` (flowchart) or `dot` (Graphviz). Edges point parent → child, roots are bold, loop-closing edges are dashed. Omit for no diagram.',
      ),
    loadLimit: LoadLimitInput.describe(
      'Row ceiling for each inline graph/frontier preview, also bounded by a 24,000-byte budget. Omit for the deployment default. A first row exceeding the byte budget yields zero preview rows; retrieve narrower projections from the staged dataframe.',
    ),
    alias: AliasInput,
  }),
  inputAliases: { germplasmDbId: 'germplasmDbIds' },
  output: OutputSchema,
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Staged graph, frontier or omitted-relative tables and how to read them.'),
  },

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

    /*
     * Each root's /pedigree is requested once: the response answers the
     * existence check, names the root, and is the root's depth-1 ancestor
     * expansion.
     */
    const rootPedigree = new Map<string, Promise<LookupEnvelope>>();
    const rootNames = new Map<string, string>();
    if (hasPedigree) {
      for (const id of input.germplasmDbIds) {
        if (!rootPedigree.has(id)) {
          rootPedigree.set(id, requestLookup(client, connection, id, 'pedigree', ctx));
        }
      }
      const checks = await Promise.all(
        Array.from(rootPedigree, async ([id, pending]) => ({ id, ...(await checkRoot(pending)) })),
      );
      for (const check of checks) {
        if (!check.found) {
          warnings.push(`Root germplasm '${check.id}' was not found in /germplasm/{id}/pedigree.`);
        }
        if (check.germplasmName) rootNames.set(check.id, check.germplasmName);
      }
    }

    const state = createWalkState(input.germplasmDbIds, rootNames, {
      ancestor: wantsAncestors && hasPedigree,
      descendant: wantsDescendants && hasProgeny,
    });
    let truncated = false;
    let deadEndCount = 0;
    let depthReached = 0;

    const frontier: z.infer<typeof FrontierSchema>[] = [];
    const confirmed = { ancestor: new Set<string>(), descendant: new Set<string>() };
    const omitted: (Relative & { ordinal: number; expansionNodeDbId: string; side: Side })[] = [];
    for (const id of state.nodes.keys()) {
      if (wantsAncestors && !hasPedigree)
        frontier.push({ germplasmDbId: id, side: 'ancestor', outcome: 'unsupported' });
      if (wantsDescendants && !hasProgeny)
        frontier.push({ germplasmDbId: id, side: 'descendant', outcome: 'unsupported' });
    }
    for (let depth = 1; depth <= input.maxDepth; depth++) {
      const upward = state.frontier.ancestor;
      const downward = state.frontier.descendant;
      state.frontier = { ancestor: new Set(), descendant: new Set() };
      const ids = new Set([...upward, ...downward]);
      if (ids.size === 0) break;
      if (atCap(state)) {
        // Already at the cap from a prior depth — skip fetching another round.
        truncated = true;
        for (const side of ['ancestor', 'descendant'] as const) {
          for (const id of side === 'ancestor' ? upward : downward)
            frontier.push({ germplasmDbId: id, side, outcome: 'safety_skipped' });
        }
        break;
      }

      const exp = await Promise.all(
        Array.from(ids, async (id) =>
          expandNode(id, {
            client,
            connection,
            ctx,
            walkAncestors: upward.has(id),
            walkDescendants: downward.has(id),
            pedigree: rootPedigree.get(id),
          }),
        ),
      );

      for (const result of exp) {
        if (result.failures.length > 0) {
          deadEndCount++;
          for (const failure of result.failures) {
            warnings.push(`Expansion failed for ${result.id} (${failure.side}): ${failure.error}`);
            frontier.push({
              germplasmDbId: result.id,
              side: failure.side,
              outcome: 'failed',
              error: failure.error,
            });
          }
        }
        const expanded = state.nodes.get(result.id);
        if (expanded && !expanded.germplasmName && result.germplasmName) {
          expanded.germplasmName = result.germplasmName;
        }

        for (const side of ['ancestor', 'descendant'] as const) {
          const relatives = side === 'ancestor' ? result.parents : result.children;
          if (!relatives) continue;
          if (relatives.length === 0) confirmed[side].add(result.id);
          let omittedCount = 0;
          const seenRelatives = new Set<string>();
          for (const relative of relatives) {
            if (seenRelatives.has(relative.germplasmDbId)) continue;
            seenRelatives.add(relative.germplasmDbId);
            const parentId = side === 'ancestor' ? relative.germplasmDbId : result.id;
            const childId = side === 'ancestor' ? result.id : relative.germplasmDbId;
            if (atCap(state) && !state.edges.has(pairKey(parentId, childId))) {
              truncated = true;
              omitted.push({
                ...relative,
                ordinal: omitted.length,
                expansionNodeDbId: result.id,
                side,
              });
              omittedCount++;
            } else if (link(state, side, parentId, childId, relative, depth)) {
              depthReached = depth;
            }
          }
          if (omittedCount > 0)
            frontier.push({
              germplasmDbId: result.id,
              side,
              outcome: 'safety_skipped',
              knownOmittedRelativeCount: omittedCount,
            });
        }
      }
    }

    for (const side of ['ancestor', 'descendant'] as const) {
      for (const id of state.frontier[side])
        frontier.push({
          germplasmDbId: id,
          side,
          outcome: 'depth_limited',
        });
    }

    if (truncated) {
      warnings.push(
        `Walk stopped at its safety cap (${MAX_NODES} nodes or ${MAX_EDGES} edges); the discovered DAG and diagram are partial. ${omitted.length} already-fetched relative entries were omitted; unrequested directions have unknown coverage. Retrieve omitted IDs from their dataframe and walk them in batches of up to 20 roots.`,
      );
    }

    const nodes = Array.from(state.nodes.values()).sort(
      (a, b) => a.depth - b.depth || a.germplasmDbId.localeCompare(b.germplasmDbId),
    );
    const edges = Array.from(state.edges.values());
    const cycleCount = edges.filter((edge) => edge.isCycle).length;
    const leafCount = computeLeafCount(nodes, edges);
    const confirmedLeafCount = nodes.filter(
      (node) =>
        !node.isRoot &&
        (node.direction === 'ancestor'
          ? confirmed.ancestor.has(node.germplasmDbId)
          : node.direction === 'descendant'
            ? confirmed.descendant.has(node.germplasmDbId)
            : confirmed.ancestor.has(node.germplasmDbId) &&
              confirmed.descendant.has(node.germplasmDbId)),
    ).length;

    let diagram: string | undefined;
    if (input.diagram) {
      const rendered = renderPedigreeDiagram(input.diagram, nodes, edges);
      if (rendered.ok) diagram = rendered.source;
      else warnings.push(rendered.reason);
    }

    // Both graph arrays and their actual rendered rows must fit each preview.
    // Stats and diagrams continue to describe the discovered graph.
    const loadLimit = input.loadLimit ?? getServerConfig().loadLimit;
    const selectedNodes = selectPreviewRows(nodes, loadLimit, renderNodeRows);
    const selectedEdges = selectPreviewRows(edges, loadLimit, renderEdgeRows);
    const previewNodes = selectedNodes.rows;
    const previewEdges = selectedEdges.rows;
    let nodesDataframe: DataframeHandle | undefined;
    let edgesDataframe: DataframeHandle | undefined;
    const notices: string[] = [];
    const query = {
      germplasmDbIds: input.germplasmDbIds,
      direction: input.direction,
      maxDepth: input.maxDepth,
      coverage: truncated ? 'partial_discovered_graph' : 'discovered_graph',
    };
    if (selectedNodes.bound || selectedEdges.bound) {
      const bridge = getCanvasBridge();
      // Register sequentially, not in parallel: the first call resolves and
      // caches the default canvas in ctx.state; a concurrent second call would
      // race that cache and land the two tables on different canvases, breaking
      // the JOIN. Both tables must share one canvas.
      if (nodes.length > 0) {
        const reg = await bridge.registerDataframe(ctx, {
          source: 'walk_pedigree_nodes',
          baseUrl: connection.baseUrl,
          query,
          rows: nodes,
        });
        nodesDataframe = toDataframeHandle(reg, nodes.length);
        if (truncated) nodesDataframe.truncated = true;
      }
      if (edges.length > 0) {
        const reg = await bridge.registerDataframe(ctx, {
          source: 'walk_pedigree_edges',
          baseUrl: connection.baseUrl,
          query,
          // isCycle is a column on every row, so SQL can filter on it.
          rows: edges.map((edge) => ({ ...edge, isCycle: edge.isCycle === true })),
        });
        edgesDataframe = toDataframeHandle(reg, edges.length);
        if (truncated) edgesDataframe.truncated = true;
      }
      const staged = [nodesDataframe, edgesDataframe].filter(
        (df): df is DataframeHandle => df !== undefined,
      );
      if (staged.length > 0) {
        notices.push(
          stagedDataframeNotice(
            staged,
            nodesDataframe && edgesDataframe
              ? { join: pedigreeJoinHint(nodesDataframe, edgesDataframe) }
              : {},
          ),
        );
      }
      notices.push(
        `Inline previews use loadLimit=${loadLimit} and a 24,000-byte budget for each node/edge array and its rendered rows (nodes: ${selectedNodes.bound ?? 'fits'}, edges: ${selectedEdges.bound ?? 'fits'}). Tables contain the discovered graph only${truncated ? ', partial because a safety cap stopped traversal' : ', within the requested depth and available directions'}. In brapi_dataframe_query, order nodes by depth, germplasmDbId and edges by from_, to. Start at OFFSET 0 and advance by rows actually shown; if zero fit, use a narrower projection or aggregation.`,
      );
    }

    const selectedFrontier = selectPreviewRows(frontier, loadLimit, renderFrontierRows);
    let frontierDataframe: DataframeHandle | undefined;
    let omittedRelativesDataframe: DataframeHandle | undefined;
    for (const entry of [
      {
        source: 'walk_pedigree_frontier',
        rows: selectedFrontier.bound ? frontier.map((row, ordinal) => ({ ordinal, ...row })) : [],
      },
      { source: 'walk_pedigree_omitted_relatives', rows: omitted },
    ]) {
      if (entry.rows.length === 0) continue;
      const reg = await getCanvasBridge().registerDataframe(ctx, {
        source: entry.source,
        baseUrl: connection.baseUrl,
        query,
        rows: entry.rows.map((row) => ({ ...row })),
      });
      const handle = toDataframeHandle(reg);
      if (entry.source === 'walk_pedigree_frontier') frontierDataframe = handle;
      else omittedRelativesDataframe = handle;
      notices.push(stagedDataframeNotice([handle]));
      const columns =
        entry.source === 'walk_pedigree_frontier'
          ? 'germplasmDbId, side, outcome'
          : 'germplasmDbId, expansionNodeDbId, side';
      notices.push(
        `Read ${entry.source === 'walk_pedigree_frontier' ? 'unresolved directions' : 'already-fetched omitted relatives'} with brapi_dataframe_query: SELECT ${columns} FROM ${handle.tableName} ORDER BY ordinal LIMIT 20 OFFSET 0; advance OFFSET by rows actually shown. If zero rows fit, use a narrower projection or aggregation. Unrequested relatives have no known count; these tables do not resume traversal.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    const result: Output = {
      alias: connection.alias,
      direction: input.direction,
      maxDepth: input.maxDepth,
      nodes: previewNodes,
      edges: previewEdges,
      depthReached,
      rootCount: input.germplasmDbIds.length,
      leafCount,
      confirmedLeafCount,
      frontier: selectedFrontier.rows,
      frontierCount: frontier.length,
      knownOmittedRelativeCount: omitted.length,
      cycleCount,
      deadEndCount,
      truncated,
      warnings,
    };
    if (nodesDataframe) result.nodesDataframe = nodesDataframe;
    if (edgesDataframe) result.edgesDataframe = edgesDataframe;
    if (frontierDataframe) result.frontierDataframe = frontierDataframe;
    if (omittedRelativesDataframe) result.omittedRelativesDataframe = omittedRelativesDataframe;
    if (diagram !== undefined) result.diagram = diagram;
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
    lines.push(`- confirmedLeafCount: ${result.confirmedLeafCount}`);
    lines.push(`- frontierCount: ${result.frontierCount}`);
    lines.push(`- knownOmittedRelativeCount: ${result.knownOmittedRelativeCount}`);
    lines.push(`- cycleCount: ${result.cycleCount}`);
    lines.push(`- deadEndCount: ${result.deadEndCount}`);
    lines.push(`- truncated: ${result.truncated}`);

    if (result.nodes.length > 0) {
      lines.push('');
      lines.push(
        result.nodesDataframe
          ? `## Nodes (preview — ${result.nodes.length} of ${result.nodesDataframe.rowCount}; full set in dataframe \`${result.nodesDataframe.tableName}\`)`
          : '## Nodes',
      );
      lines.push(renderNodeRows(result.nodes));
    }

    if (result.edges.length > 0) {
      lines.push('');
      lines.push(
        result.edgesDataframe
          ? `## Edges (preview — ${result.edges.length} of ${result.edgesDataframe.rowCount}; full set in dataframe \`${result.edgesDataframe.tableName}\`)`
          : '## Edges',
      );
      lines.push(renderEdgeRows(result.edges));
    }

    if (result.nodesDataframe) {
      lines.push('');
      lines.push('## Nodes dataframe');
      lines.push(...renderDataframeHandle(result.nodesDataframe));
    }

    if (result.edgesDataframe) {
      lines.push('');
      lines.push('## Edges dataframe');
      lines.push(...renderDataframeHandle(result.edgesDataframe));
    }
    if (result.frontierCount > 0)
      lines.push('', '## Unresolved directions', renderFrontierRows(result.frontier));
    if (result.frontierDataframe)
      lines.push('', '## Frontier dataframe', ...renderDataframeHandle(result.frontierDataframe));
    if (result.omittedRelativesDataframe)
      lines.push(
        '',
        '## Fetched omitted relatives dataframe',
        ...renderDataframeHandle(result.omittedRelativesDataframe),
      );

    if (result.diagram !== undefined) {
      // Every source line starts with renderer syntax, so the fence can't close early.
      const fence = result.diagram.startsWith('digraph') ? 'dot' : 'mermaid';
      lines.push('', '## Diagram', `\`\`\`${fence}`, result.diagram, '```');
    }

    if (result.warnings.length > 0) {
      lines.push('');
      lines.push('## Warnings');
      for (const w of result.warnings) lines.push(`- ${w}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});

type PedigreeNode = z.infer<typeof NodeSchema>;
type PedigreeEdge = z.infer<typeof EdgeSchema>;
type Side = 'ancestor' | 'descendant';

function renderNodeRows(nodes: readonly PedigreeNode[]): string {
  return nodes
    .map(
      (node) =>
        `- **${node.germplasmName ?? node.germplasmDbId}** · id=\`${node.germplasmDbId}\` · depth=${node.depth} · ${node.direction}`,
    )
    .join('\n');
}

function renderEdgeRows(edges: readonly PedigreeEdge[]): string {
  return edges
    .map(
      (edge) =>
        `- \`${edge.from}\` ${edge.relationship === 'parent' ? '→' : '←'} \`${edge.to}\` · ${edge.relationship}${edge.parentType ? ` (${edge.parentType})` : ''}${edge.isCycle ? ' · isCycle' : ''}`,
    )
    .join('\n');
}

function renderFrontierRows(frontier: readonly z.infer<typeof FrontierSchema>[]): string {
  return frontier
    .map(
      (entry) =>
        `- \`${entry.germplasmDbId}\` · ${entry.side} · ${entry.outcome}${entry.knownOmittedRelativeCount !== undefined ? ` · known omitted relatives=${entry.knownOmittedRelativeCount}` : ''}${entry.error ? ` · ${entry.error}` : ''}`,
    )
    .join('\n');
}

interface WalkState {
  /** Parent → children over every recorded pair, for loop detection. */
  childrenOf: Map<string, Set<string>>;
  /** One edge per parent–child pair, keyed by {@link pairKey}. */
  edges: Map<string, PedigreeEdge>;
  /** Nodes to expand at the next depth, per side. */
  frontier: Record<Side, Set<string>>;
  nodes: Map<string, PedigreeNode>;
  /** Nodes ever queued on each side — each side expands a node at most once. */
  queued: Record<Side, Set<string>>;
}

function createWalkState(
  rootIds: readonly string[],
  rootNames: ReadonlyMap<string, string>,
  sides: Record<Side, boolean>,
): WalkState {
  const state: WalkState = {
    nodes: new Map(),
    edges: new Map(),
    childrenOf: new Map(),
    frontier: { ancestor: new Set(), descendant: new Set() },
    queued: { ancestor: new Set(), descendant: new Set() },
  };
  for (const id of rootIds) {
    const node: PedigreeNode = { germplasmDbId: id, depth: 0, isRoot: true, direction: 'root' };
    const name = rootNames.get(id);
    if (name) node.germplasmName = name;
    state.nodes.set(id, node);
    if (sides.ancestor) enqueue(state, 'ancestor', id);
    if (sides.descendant) enqueue(state, 'descendant', id);
  }
  return state;
}

function enqueue(state: WalkState, side: Side, id: string): void {
  if (state.queued[side].has(id)) return;
  state.queued[side].add(id);
  state.frontier[side].add(id);
}

function atCap(state: WalkState): boolean {
  return state.nodes.size >= MAX_NODES || state.edges.size >= MAX_EDGES;
}

function pairKey(parentId: string, childId: string): string {
  return JSON.stringify([parentId, childId]);
}

/**
 * Record that `parentId` is a parent of `childId`, found from `side` (via
 * /pedigree for `ancestor`, /progeny for `descendant`). The pair gets one
 * edge whichever side finds it, labelled `parent` once /pedigree has seen it.
 * The newly reached end is registered and queued on `side` unless the edge
 * closes a loop. Returns true when the pair is new.
 */
function link(
  state: WalkState,
  side: Side,
  parentId: string,
  childId: string,
  entry: Relative,
  depth: number,
): boolean {
  const reachedId = side === 'ancestor' ? parentId : childId;
  const key = pairKey(parentId, childId);
  const existing = state.edges.get(key);
  const isNew = existing === undefined;
  let isCycle: boolean;
  if (existing) {
    isCycle = existing.isCycle === true;
    if (side === 'ancestor' && existing.relationship === 'child') {
      const parentType = entry.parentType ?? existing.parentType;
      state.edges.set(key, toEdge(side, parentId, childId, parentType, isCycle));
    }
  } else {
    isCycle =
      parentId === childId ||
      (state.nodes.has(reachedId) && reaches(state.childrenOf, childId, parentId));
    state.edges.set(key, toEdge(side, parentId, childId, entry.parentType, isCycle));
    const children = state.childrenOf.get(parentId);
    if (children) children.add(childId);
    else state.childrenOf.set(parentId, new Set([childId]));
  }
  registerNode(state, reachedId, entry.germplasmName, depth, side);
  if (!isCycle) enqueue(state, side, reachedId);
  return isNew;
}

function toEdge(
  side: Side,
  parentId: string,
  childId: string,
  parentType: string | undefined,
  isCycle: boolean,
): PedigreeEdge {
  const edge: PedigreeEdge =
    side === 'ancestor'
      ? { from: parentId, to: childId, relationship: 'parent' }
      : { from: childId, to: parentId, relationship: 'child' };
  if (parentType) edge.parentType = parentType;
  if (isCycle) edge.isCycle = true;
  return edge;
}

/** True when `target` is reachable from `start` along parent → child edges. */
function reaches(
  childrenOf: ReadonlyMap<string, ReadonlySet<string>>,
  start: string,
  target: string,
): boolean {
  const seen = new Set<string>([start]);
  const stack = [start];
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    for (const next of childrenOf.get(id) ?? []) {
      if (next === target) return true;
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

/**
 * Add a node to the walk state. When `id` is already registered, merge the
 * incoming `side` with the existing direction — `ancestor` + `descendant` →
 * `both`. Roots are never overwritten. Depth converges to the minimum across
 * encounters.
 */
function registerNode(
  state: WalkState,
  id: string,
  name: string | undefined,
  depth: number,
  side: Side,
): void {
  const existing = state.nodes.get(id);
  if (existing) {
    if (!existing.germplasmName && name) existing.germplasmName = name;
    if (depth < existing.depth) existing.depth = depth;
    if (existing.direction !== 'root' && existing.direction !== side) {
      existing.direction = 'both';
    }
    return;
  }
  const node: PedigreeNode = {
    germplasmDbId: id,
    depth,
    isRoot: false,
    direction: side,
  };
  if (name) node.germplasmName = name;
  state.nodes.set(id, node);
}

/** A parent (from /pedigree) or child (from /progeny) entry of the expanded germplasm. */
interface Relative {
  germplasmDbId: string;
  germplasmName?: string;
  /** The parent's role in the cross — on a /progeny entry, the expanded germplasm's role. */
  parentType?: string;
}

type LookupEnvelope = BrapiEnvelope<Record<string, unknown> | null>;

type Expansion = {
  id: string;
  /** The expanded germplasm's own name, from its /pedigree or /progeny response. */
  germplasmName?: string;
  parents?: Relative[];
  children?: Relative[];
  failures: { side: Side; error: string }[];
};

interface ExpandInput {
  client: BrapiClient;
  connection: RegisteredServer;
  ctx: Context;
  /** A /pedigree response already requested for this germplasm (roots only). */
  pedigree: Promise<LookupEnvelope> | undefined;
  walkAncestors: boolean;
  walkDescendants: boolean;
}

async function expandNode(id: string, input: ExpandInput): Promise<Expansion> {
  const lookups = await Promise.allSettled([
    input.walkAncestors
      ? (input.pedigree ?? requestLookup(input.client, input.connection, id, 'pedigree', input.ctx))
      : undefined,
    input.walkDescendants
      ? requestLookup(input.client, input.connection, id, 'progeny', input.ctx)
      : undefined,
  ]);
  input.ctx.signal?.throwIfAborted();
  const expansion: Expansion = { id, failures: [] };
  for (const [index, lookup] of lookups.entries()) {
    const side = index === 0 ? 'ancestor' : 'descendant';
    if (lookup.status === 'rejected') {
      expansion.failures.push({
        side,
        error: lookup.reason instanceof Error ? lookup.reason.message : String(lookup.reason),
      });
    } else if (lookup.value) {
      if (side === 'ancestor') expansion.parents = readRelatives(lookup.value.result?.parents);
      else expansion.children = readProgeny(lookup.value.result);
      const name = selfName(lookup.value);
      if (name && !expansion.germplasmName) expansion.germplasmName = name;
    }
  }
  return expansion;
}

function requestLookup(
  client: BrapiClient,
  connection: RegisteredServer,
  id: string,
  lookup: 'pedigree' | 'progeny',
  ctx: Context,
): Promise<LookupEnvelope> {
  return client.get<Record<string, unknown> | null>(
    connection.baseUrl,
    `/germplasm/${encodeURIComponent(id)}/${lookup}`,
    ctx,
    buildRequestOptions(connection, undefined, { singleton: true }),
  );
}

/** Settle a root's /pedigree lookup into "does it exist" and its own name. */
async function checkRoot(
  pending: Promise<LookupEnvelope>,
): Promise<{ found: boolean; germplasmName?: string }> {
  try {
    const env = await pending;
    // Some servers (e.g. test-server.brapi.org) reply 200 with `result: null`
    // for unknown germplasm instead of 404.
    if (env.result == null) return { found: false };
    const name = selfName(env);
    return name ? { found: true, germplasmName: name } : { found: true };
  } catch (err) {
    if (isUpstreamNotFound(err)) return { found: false };
    // Non-404 errors get surfaced when the BFS expands the root.
    return { found: true };
  }
}

function selfName(env: LookupEnvelope | undefined): string | undefined {
  const name = env?.result?.germplasmName;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

function readProgeny(result: Record<string, unknown> | null): Relative[] {
  return readRelatives(Array.isArray(result?.progeny) ? result.progeny : result?.data);
}

function readRelatives(raw: unknown): Relative[] {
  if (!Array.isArray(raw)) return [];
  const relatives: Relative[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const dbId = record.germplasmDbId;
    if (typeof dbId !== 'string' || dbId.length === 0) continue;
    const item: Relative = { germplasmDbId: dbId };
    if (typeof record.germplasmName === 'string') item.germplasmName = record.germplasmName;
    if (typeof record.parentType === 'string') item.parentType = record.parentType;
    relatives.push(item);
  }
  return relatives;
}

/**
 * How the staged node and edge tables join: a node's germplasmDbId matches an
 * edge's `from` or `to` column, under the SQL-safe names the edge table was
 * registered with (`from` is a reserved word, so it lands as `from_`).
 */
function pedigreeJoinHint(nodes: DataframeHandle, edges: DataframeHandle): string {
  const column = (key: string) =>
    Object.entries(edges.columnLegend ?? {}).find(([, original]) => original === key)?.[0] ?? key;
  return `join germplasmDbId in \`${nodes.tableName}\` to ${column('from')} or ${column('to')} in \`${edges.tableName}\``;
}

/**
 * A leaf is a non-root node with nothing recorded beyond it on the side it
 * was reached from: an ancestor with no parents, a descendant with no
 * progeny, a node on both sides with neither. Roots seed the walk and are
 * never leaves.
 */
function computeLeafCount(nodes: readonly PedigreeNode[], edges: readonly PedigreeEdge[]): number {
  const hasParent = new Set<string>();
  const hasChild = new Set<string>();
  for (const edge of edges) {
    const [parentId, childId] =
      edge.relationship === 'parent' ? [edge.from, edge.to] : [edge.to, edge.from];
    hasChild.add(parentId);
    hasParent.add(childId);
  }
  let leaves = 0;
  for (const node of nodes) {
    const id = node.germplasmDbId;
    const terminal =
      (node.direction === 'ancestor' && !hasParent.has(id)) ||
      (node.direction === 'descendant' && !hasChild.has(id)) ||
      (node.direction === 'both' && !hasParent.has(id) && !hasChild.has(id));
    if (terminal) leaves++;
  }
  return leaves;
}
