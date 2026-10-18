/**
 * @fileoverview Pure renderers that turn a `brapi_walk_pedigree` result into
 * Mermaid flowchart or Graphviz DOT source. Every edge is drawn parent →
 * child, roots are bold, loop-closing edges are dashed. Node identifiers are
 * generated (`n0`, `n1`, …); germplasm names and parent types are upstream
 * text, so labels are flattened to one line and escaped for the target syntax.
 * Both formats are inlined in the tool result, so source past 50,000
 * characters (or a Mermaid flowchart past 500 edges) is omitted with a reason.
 *
 * @module mcp-server/tools/shared/pedigree-diagram
 */

export type DiagramFormat = 'mermaid' | 'dot';

export interface DiagramNode {
  germplasmDbId: string;
  germplasmName?: string | undefined;
  isRoot: boolean;
}

export interface DiagramEdge {
  from: string;
  isCycle?: boolean | undefined;
  parentType?: string | undefined;
  relationship: 'parent' | 'child';
  to: string;
}

export type DiagramResult = { ok: true; source: string } | { ok: false; reason: string };

/** Mermaid's default `maxEdges`: a flowchart with more edges fails to render. */
export const MERMAID_MAX_EDGES = 500;
/** Mermaid's default `maxTextSize`: longer source fails to render. */
export const MERMAID_MAX_TEXT_SIZE = 50_000;
/** Cap on DOT source, which is inlined in both result surfaces like Mermaid's. */
export const DOT_MAX_TEXT_SIZE = 50_000;

/** Control characters and line/paragraph separators collapse to one space. */
const LINE_BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;
/**
 * Everything outside letters, digits, space, and a few inert punctuation
 * marks becomes a Mermaid entity code (`#34;`), so a label can neither close
 * its quotes nor carry markup, directives, or comments.
 */
const MERMAID_UNSAFE = /[^\p{L}\p{N} _.,()/+'-]/gu;
const DOT_UNSAFE = /["\\]/g;

/** Render the walk as `format` source, or say why the diagram was left out. */
export function renderPedigreeDiagram(
  format: DiagramFormat,
  nodes: readonly DiagramNode[],
  edges: readonly DiagramEdge[],
): DiagramResult {
  if (format === 'dot') {
    const source = renderDot(nodes, edges);
    if (source.length <= DOT_MAX_TEXT_SIZE) return { ok: true, source };
    return {
      ok: false,
      reason: `DOT diagram omitted: its source is ${count(source.length)} characters, past the ${count(DOT_MAX_TEXT_SIZE)}-character limit. ${NARROW_HINT}`,
    };
  }
  if (edges.length > MERMAID_MAX_EDGES) {
    return {
      ok: false,
      reason: `Mermaid diagram omitted: the walk has ${edges.length} edges, past Mermaid's default limit of ${MERMAID_MAX_EDGES}. ${mermaidRetryHint(nodes, edges)}`,
    };
  }
  const source = renderMermaid(nodes, edges);
  if (source.length > MERMAID_MAX_TEXT_SIZE) {
    return {
      ok: false,
      reason: `Mermaid diagram omitted: its source is ${count(source.length)} characters, past Mermaid's default limit of ${count(MERMAID_MAX_TEXT_SIZE)}. ${mermaidRetryHint(nodes, edges)}`,
    };
  }
  return { ok: true, source };
}

const NARROW_HINT = 'Lower maxDepth or pass fewer germplasmDbIds.';

/** Narrowing always helps; DOT is offered only when this walk's DOT source fits its cap. */
function mermaidRetryHint(nodes: readonly DiagramNode[], edges: readonly DiagramEdge[]): string {
  return renderDot(nodes, edges).length <= DOT_MAX_TEXT_SIZE
    ? 'Lower maxDepth, pass fewer germplasmDbIds, or request diagram: "dot".'
    : NARROW_HINT;
}

function count(n: number): string {
  return n.toLocaleString('en-US');
}

function renderMermaid(nodes: readonly DiagramNode[], edges: readonly DiagramEdge[]): string {
  const ids = nodeIds(nodes);
  const lines = ['flowchart TD'];
  for (const node of nodes) {
    lines.push(`  ${ids.get(node.germplasmDbId)}["${mermaidText(labelOf(node))}"]`);
  }
  for (const edge of edges) {
    const [parent, child] = endpoints(edge, ids);
    const arrow = edge.isCycle ? '-.->' : '-->';
    const label = edge.parentType ? `|"${mermaidText(edge.parentType)}"|` : '';
    lines.push(`  ${parent} ${arrow}${label} ${child}`);
  }
  const roots = nodes.filter((node) => node.isRoot).map((node) => ids.get(node.germplasmDbId));
  lines.push('  classDef root stroke-width:3px');
  if (roots.length > 0) lines.push(`  class ${roots.join(',')} root`);
  return lines.join('\n');
}

function renderDot(nodes: readonly DiagramNode[], edges: readonly DiagramEdge[]): string {
  const ids = nodeIds(nodes);
  const lines = ['digraph pedigree {', '  rankdir=TB;', '  node [shape=box];'];
  for (const node of nodes) {
    const style = node.isRoot ? ', style=bold, penwidth=2' : '';
    lines.push(`  ${ids.get(node.germplasmDbId)} [label="${dotText(labelOf(node))}"${style}];`);
  }
  for (const edge of edges) {
    const [parent, child] = endpoints(edge, ids);
    const attrs: string[] = [];
    if (edge.parentType) attrs.push(`label="${dotText(edge.parentType)}"`);
    if (edge.isCycle) attrs.push('style=dashed');
    lines.push(`  ${parent} -> ${child}${attrs.length > 0 ? ` [${attrs.join(', ')}]` : ''};`);
  }
  lines.push('}');
  return lines.join('\n');
}

function nodeIds(nodes: readonly DiagramNode[]): Map<string, string> {
  return new Map(nodes.map((node, i) => [node.germplasmDbId, `n${i}`]));
}

/** Generated ids of an edge's parent and child, whichever side found the pair. */
function endpoints(edge: DiagramEdge, ids: ReadonlyMap<string, string>): [string, string] {
  const [parentId, childId] =
    edge.relationship === 'parent' ? [edge.from, edge.to] : [edge.to, edge.from];
  const parent = ids.get(parentId);
  const child = ids.get(childId);
  if (parent === undefined || child === undefined) {
    throw new Error(`Pedigree edge ${parentId} → ${childId} names a germplasm with no node.`);
  }
  return [parent, child];
}

function labelOf(node: DiagramNode): string {
  return node.germplasmName ?? node.germplasmDbId;
}

function mermaidText(raw: string): string {
  return raw.replace(LINE_BREAKS, ' ').replace(MERMAID_UNSAFE, (ch) => `#${ch.codePointAt(0)};`);
}

function dotText(raw: string): string {
  return raw.replace(LINE_BREAKS, ' ').replace(DOT_UNSAFE, '\\$&');
}
