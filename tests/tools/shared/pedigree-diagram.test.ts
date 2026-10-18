/**
 * @fileoverview Tests for the pedigree diagram renderers — Mermaid and DOT
 * source shape, parent → child normalization, cycle styling, label escaping
 * against hostile germplasm names, Mermaid's render limits, and escaper cost.
 *
 * @module tests/tools/shared/pedigree-diagram.test
 */

import { describe, expect, it } from 'vitest';
import {
  type DiagramEdge,
  type DiagramNode,
  DOT_MAX_TEXT_SIZE,
  MERMAID_MAX_EDGES,
  MERMAID_MAX_TEXT_SIZE,
  renderPedigreeDiagram,
} from '@/mcp-server/tools/shared/pedigree-diagram.js';

function rendered(...args: Parameters<typeof renderPedigreeDiagram>): string {
  const result = renderPedigreeDiagram(...args);
  if (!result.ok) throw new Error(`expected a diagram, got: ${result.reason}`);
  return result.source;
}

/** What a diagram label reads as once its target syntax is decoded. */
function flattened(raw: string): string {
  return raw.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ');
}

const LINE_SEPARATOR = String.fromCodePoint(0x2028);

/*
 * Line grammars for exactly what the renderers emit. A label that broke out
 * of its quotes, or a line break that survived into the source, fails to
 * match — and a label that smuggled in a node or edge statement changes the
 * statement counts.
 */
const MERMAID_LABEL = '"([^"\\r\\n]*)"';
const MERMAID_NODE = new RegExp(`^ {2}(n\\d+)\\[${MERMAID_LABEL}\\]$`);
const MERMAID_EDGE = new RegExp(`^ {2}(n\\d+) (-->|-\\.->)(?:\\|${MERMAID_LABEL}\\|)? (n\\d+)$`);
const MERMAID_FIXED =
  /^(flowchart TD| {2}classDef root stroke-width:3px| {2}class n\d+(,n\d+)* root)$/;

const DOT_LABEL = '"((?:[^"\\\\\\r\\n]|\\\\[^\\r\\n])*)"';
const DOT_NODE = new RegExp(`^ {2}(n\\d+) \\[label=${DOT_LABEL}(, style=bold, penwidth=2)?\\];$`);
const DOT_EDGE = new RegExp(
  `^ {2}(n\\d+) -> (n\\d+)(?: \\[(?:label=${DOT_LABEL})?(?:, )?(style=dashed)?\\])?;$`,
);
const DOT_FIXED = /^(digraph pedigree \{| {2}rankdir=TB;| {2}node \[shape=box\];|\})$/;

function decodeMermaid(text: string): string {
  return text.replace(/#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

function decodeDot(text: string): string {
  return text.replace(/\\(.)/g, '$1');
}

interface Parsed {
  edges: Array<{ from: string; to: string; label?: string; dashed: boolean }>;
  labels: Map<string, string>;
}

function parseMermaid(source: string): Parsed {
  const parsed: Parsed = { labels: new Map(), edges: [] };
  for (const line of source.split('\n')) {
    const node = MERMAID_NODE.exec(line);
    const edge = MERMAID_EDGE.exec(line);
    if (node) parsed.labels.set(node[1]!, decodeMermaid(node[2]!));
    else if (edge) {
      const e: Parsed['edges'][number] = {
        from: edge[1]!,
        to: edge[4]!,
        dashed: edge[2] === '-.->',
      };
      if (edge[3] !== undefined) e.label = decodeMermaid(edge[3]);
      parsed.edges.push(e);
    } else expect(line).toMatch(MERMAID_FIXED);
  }
  return parsed;
}

function parseDot(source: string): Parsed {
  const parsed: Parsed = { labels: new Map(), edges: [] };
  for (const line of source.split('\n')) {
    const node = DOT_NODE.exec(line);
    const edge = DOT_EDGE.exec(line);
    if (node) parsed.labels.set(node[1]!, decodeDot(node[2]!));
    else if (edge) {
      const e: Parsed['edges'][number] = { from: edge[1]!, to: edge[2]!, dashed: !!edge[4] };
      if (edge[3] !== undefined) e.label = decodeDot(edge[3]);
      parsed.edges.push(e);
    } else expect(line).toMatch(DOT_FIXED);
  }
  return parsed;
}

const HOSTILE = [
  'quote " inside',
  'brackets [x] ]] [[',
  'angles <b>bold</b> <script>alert(1)</script>',
  'hash #35; #quot; #',
  'back\\slash \\" \\\\ \\N',
  `line\nbreak\r\nand\rcarriage${LINE_SEPARATOR}sep`,
  'arrow --> n0 -.-> n1 ==> x',
  'braces { } }%% %%{init: {"theme":"dark"}}%%',
  'pipes |"label"| and ; semicolons; style n0 fill:#f00;',
  'backtick `md` ```fence```',
  'amp &amp; &lt; &#60;',
  '"] --> n9["injected',
  '"]; n9 -> n0; n8 [label="x',
  'classDef evil fill:#f00',
  'Ñandú çà 漢字 🌱',
];

describe('renderPedigreeDiagram', () => {
  it('renders a root-only walk as a valid one-node diagram', () => {
    const nodes: DiagramNode[] = [{ germplasmDbId: 'g-1', germplasmName: 'Root', isRoot: true }];
    expect(rendered('mermaid', nodes, [])).toBe(
      ['flowchart TD', '  n0["Root"]', '  classDef root stroke-width:3px', '  class n0 root'].join(
        '\n',
      ),
    );
    expect(rendered('dot', nodes, [])).toBe(
      [
        'digraph pedigree {',
        '  rankdir=TB;',
        '  node [shape=box];',
        '  n0 [label="Root", style=bold, penwidth=2];',
        '}',
      ].join('\n'),
    );
  });

  it('draws every edge parent → child, labels parentType, and dashes loop-closing edges', () => {
    const nodes: DiagramNode[] = [
      { germplasmDbId: 'R', germplasmName: 'Root', isRoot: true },
      { germplasmDbId: 'P', germplasmName: 'Mother', isRoot: false },
      { germplasmDbId: 'C', isRoot: false },
    ];
    const edges: DiagramEdge[] = [
      { from: 'P', to: 'R', relationship: 'parent', parentType: 'FEMALE' },
      { from: 'C', to: 'R', relationship: 'child', parentType: 'MALE' },
      { from: 'C', to: 'P', relationship: 'child', isCycle: true },
    ];

    expect(rendered('mermaid', nodes, edges)).toBe(
      [
        'flowchart TD',
        '  n0["Root"]',
        '  n1["Mother"]',
        '  n2["C"]',
        '  n1 -->|"FEMALE"| n0',
        '  n0 -->|"MALE"| n2',
        '  n1 -.-> n2',
        '  classDef root stroke-width:3px',
        '  class n0 root',
      ].join('\n'),
    );
    expect(rendered('dot', nodes, edges)).toBe(
      [
        'digraph pedigree {',
        '  rankdir=TB;',
        '  node [shape=box];',
        '  n0 [label="Root", style=bold, penwidth=2];',
        '  n1 [label="Mother"];',
        '  n2 [label="C"];',
        '  n1 -> n0 [label="FEMALE"];',
        '  n0 -> n2 [label="MALE"];',
        '  n1 -> n2 [style=dashed];',
        '}',
      ].join('\n'),
    );
  });

  it('styles every root and labels a dashed edge that carries a parentType', () => {
    const nodes: DiagramNode[] = [
      { germplasmDbId: 'A', isRoot: true },
      { germplasmDbId: 'B', isRoot: true },
    ];
    const edges: DiagramEdge[] = [
      { from: 'A', to: 'B', relationship: 'parent', parentType: 'SELF', isCycle: true },
    ];
    const mermaid = rendered('mermaid', nodes, edges);
    expect(mermaid).toContain('  n0 -.->|"SELF"| n1');
    expect(mermaid).toContain('  class n0,n1 root');
    const dot = rendered('dot', nodes, edges);
    expect(dot).toContain('  n0 -> n1 [label="SELF", style=dashed];');
    expect(dot.match(/style=bold/g)).toHaveLength(2);
  });

  describe.each(['mermaid', 'dot'] as const)('%s escaping', (format) => {
    const parse = format === 'mermaid' ? parseMermaid : parseDot;

    it('keeps every hostile name as literal label text', () => {
      const nodes: DiagramNode[] = HOSTILE.map((name, i) => ({
        germplasmDbId: `id-${i}`,
        germplasmName: name,
        isRoot: i === 0,
      }));
      const edges: DiagramEdge[] = HOSTILE.slice(1).map((name, i) => ({
        from: `id-${i}`,
        to: `id-${i + 1}`,
        relationship: 'parent',
        parentType: name,
      }));
      const source = rendered(format, nodes, edges);

      const parsed = parse(source);
      expect(parsed.labels.size).toBe(nodes.length);
      expect(parsed.edges).toHaveLength(edges.length);
      HOSTILE.forEach((name, i) => {
        expect(parsed.labels.get(`n${i}`)).toBe(flattened(name));
      });
      parsed.edges.forEach((edge, i) => {
        expect(edge).toEqual({
          from: `n${i}`,
          to: `n${i + 1}`,
          label: flattened(HOSTILE[i + 1]!),
          dashed: false,
        });
      });
    });

    it('never lets a fuzzed name add a node or an edge', () => {
      const alphabet = [
        ...'"[]<>#\\\n\r{}|;:%`&-.=/ ab1',
        '-->',
        '-.->',
        '}%%',
        '%%{',
        '\\"',
        '#35;',
        LINE_SEPARATOR,
      ];
      let seed = 42;
      const next = () => {
        seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
        return seed;
      };
      for (let round = 0; round < 200; round++) {
        const name = Array.from(
          { length: 1 + (next() % 24) },
          () => alphabet[next() % alphabet.length],
        ).join('');
        const nodes: DiagramNode[] = [
          { germplasmDbId: 'a', germplasmName: name, isRoot: true },
          { germplasmDbId: 'b', germplasmName: name, isRoot: false },
        ];
        const edges: DiagramEdge[] = [
          { from: 'b', to: 'a', relationship: 'parent', parentType: name },
        ];
        const parsed = parse(rendered(format, nodes, edges));
        expect(parsed.labels).toEqual(
          new Map([
            ['n0', flattened(name)],
            ['n1', flattened(name)],
          ]),
        );
        expect(parsed.edges).toEqual([
          { from: 'n1', to: 'n0', label: flattened(name), dashed: false },
        ]);
      }
    });

    it('generates node identifiers instead of using raw germplasmDbIds', () => {
      const nodes: DiagramNode[] = [
        { germplasmDbId: 'end', isRoot: true },
        { germplasmDbId: 'a b"]-->x', isRoot: false },
      ];
      const edges: DiagramEdge[] = [{ from: 'a b"]-->x', to: 'end', relationship: 'parent' }];
      const parsed = parse(rendered(format, nodes, edges));
      expect(parsed.labels).toEqual(
        new Map([
          ['n0', 'end'],
          ['n1', 'a b"]-->x'],
        ]),
      );
      expect(parsed.edges).toEqual([{ from: 'n1', to: 'n0', dashed: false }]);
    });
  });

  it('never starts a source line with a backtick, so a fenced block cannot be closed early', () => {
    const nodes: DiagramNode[] = [
      { germplasmDbId: 'x', germplasmName: 'a\n```\n# heading\n```', isRoot: true },
    ];
    for (const format of ['mermaid', 'dot'] as const) {
      const source = rendered(format, nodes, []);
      for (const line of source.split('\n')) expect(line.startsWith('`')).toBe(false);
    }
  });

  describe('Mermaid render limits', () => {
    const chain = (edgeCount: number) => {
      const nodes: DiagramNode[] = Array.from({ length: edgeCount + 1 }, (_, i) => ({
        germplasmDbId: `g${i}`,
        isRoot: i === 0,
      }));
      const edges: DiagramEdge[] = Array.from({ length: edgeCount }, (_, i) => ({
        from: `g${i + 1}`,
        to: `g${i}`,
        relationship: 'parent' as const,
      }));
      return { nodes, edges };
    };

    it(`renders exactly ${MERMAID_MAX_EDGES} edges`, () => {
      const { nodes, edges } = chain(MERMAID_MAX_EDGES);
      const parsed = parseMermaid(rendered('mermaid', nodes, edges));
      expect(parsed.edges).toHaveLength(MERMAID_MAX_EDGES);
    });

    it(`omits a Mermaid diagram past ${MERMAID_MAX_EDGES} edges, pointing at DOT, which still renders`, () => {
      const { nodes, edges } = chain(MERMAID_MAX_EDGES + 1);
      const result = renderPedigreeDiagram('mermaid', nodes, edges);
      expect(result).toEqual({
        ok: false,
        reason:
          'Mermaid diagram omitted: the walk has 501 edges, past Mermaid\'s default limit of 500. Lower maxDepth, pass fewer germplasmDbIds, or request diagram: "dot".',
      });
      expect(parseDot(rendered('dot', nodes, edges)).edges).toHaveLength(MERMAID_MAX_EDGES + 1);
    });

    /** `count` nodes each labelled with `name`, no edges. */
    const named = (count: number, name: string): DiagramNode[] =>
      Array.from({ length: count }, (_, i) => ({
        germplasmDbId: `g${i}`,
        germplasmName: name,
        isRoot: i === 0,
      }));

    it(`omits a Mermaid diagram whose source passes ${MERMAID_MAX_TEXT_SIZE} characters, pointing at DOT when it fits`, () => {
      // `<` costs four characters in Mermaid and one in DOT.
      const nodes = named(40, '<'.repeat(400));
      const result = renderPedigreeDiagram('mermaid', nodes, []);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toMatch(
        /^Mermaid diagram omitted: its source is \d{2},\d{3} characters, past Mermaid's default limit of 50,000\. Lower maxDepth, pass fewer germplasmDbIds, or request diagram: "dot"\.$/,
      );
      expect(renderPedigreeDiagram('dot', nodes, []).ok).toBe(true);
    });

    it('when both formats are over the limit, each omission advises only narrowing the walk', () => {
      const nodes = named(40, 'x'.repeat(1_300));
      const mermaid = renderPedigreeDiagram('mermaid', nodes, []);
      const dot = renderPedigreeDiagram('dot', nodes, []);
      expect(!mermaid.ok && mermaid.reason).toMatch(
        /^Mermaid diagram omitted: its source is \d{2},\d{3} characters, past Mermaid's default limit of 50,000\. Lower maxDepth or pass fewer germplasmDbIds\.$/,
      );
      expect(!dot.ok && dot.reason).toMatch(
        /^DOT diagram omitted: its source is \d{2},\d{3} characters, past the 50,000-character limit\. Lower maxDepth or pass fewer germplasmDbIds\.$/,
      );
    });
  });

  describe('DOT render limit', () => {
    /** One root node whose DOT source is exactly `length` characters. */
    const dotOfLength = (length: number): DiagramNode[] => {
      const node = { germplasmDbId: 'g0', germplasmName: '', isRoot: true };
      const overhead = rendered('dot', [node], []).length;
      return [{ ...node, germplasmName: 'x'.repeat(length - overhead) }];
    };

    it(`renders a DOT source of exactly ${DOT_MAX_TEXT_SIZE} characters`, () => {
      expect(rendered('dot', dotOfLength(DOT_MAX_TEXT_SIZE), [])).toHaveLength(DOT_MAX_TEXT_SIZE);
    });

    it(`omits a DOT source one character past ${DOT_MAX_TEXT_SIZE}`, () => {
      expect(renderPedigreeDiagram('dot', dotOfLength(DOT_MAX_TEXT_SIZE + 1), [])).toEqual({
        ok: false,
        reason:
          'DOT diagram omitted: its source is 50,001 characters, past the 50,000-character limit. Lower maxDepth or pass fewer germplasmDbIds.',
      });
    });

    it('bounds a walk with thousands of edges and long upstream labels', () => {
      const nodes: DiagramNode[] = Array.from({ length: 1_000 }, (_, i) => ({
        germplasmDbId: `g${i}`,
        germplasmName: 'y'.repeat(200),
        isRoot: i === 0,
      }));
      const edges: DiagramEdge[] = Array.from({ length: 10_000 }, (_, i) => ({
        from: `g${(i % 999) + 1}`,
        to: `g${i % 999}`,
        parentType: 'z'.repeat(100),
        relationship: 'parent' as const,
      }));
      const result = renderPedigreeDiagram('dot', nodes, edges);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toMatch(
        /^DOT diagram omitted: its source is [\d,]+ characters/,
      );
    });
  });

  describe('escaper cost', () => {
    /*
     * Each shape doubles from its smallest size to 64× that and checks an
     * absolute CPU bound at every size before going on. Shapes stay below the
     * input size where Bun's regex engine changes mode; the digit run, which
     * never crosses it, carries the full 5k → 320k span.
     */
    const shapes: Array<{ name: string; unit: string; from: number }> = [
      { name: 'repeated quote', unit: '"', from: 1_250 },
      { name: 'repeated opener', unit: '[', from: 1_250 },
      { name: 'nested braces', unit: '{', from: 1_250 },
      { name: 'repeated backslash', unit: '\\', from: 1_250 },
      { name: 'repeated arrow prefix', unit: '-->', from: 1_250 },
      { name: 'repeated entity prefix', unit: '#3', from: 1_250 },
      { name: 'line breaks', unit: '\r\n', from: 1_250 },
      { name: 'digit run', unit: '7', from: 5_000 },
    ];

    function cpuMs(run: () => void): number {
      const start = process.threadCpuUsage();
      run();
      const used = process.threadCpuUsage(start);
      return (used.user + used.system) / 1000;
    }

    for (const shape of shapes) {
      it(`stays linear on a ${shape.name}`, () => {
        const timings: number[] = [];
        for (let size = shape.from; size <= shape.from * 64; size *= 2) {
          const name = shape.unit.repeat(Math.ceil(size / shape.unit.length)).slice(0, size);
          const nodes: DiagramNode[] = [{ germplasmDbId: 'x', germplasmName: name, isRoot: true }];
          const ms = cpuMs(() => {
            renderPedigreeDiagram('mermaid', nodes, []);
            renderPedigreeDiagram('dot', nodes, []);
          });
          expect(ms).toBeLessThan(500);
          timings.push(Math.max(ms, 0.05));
        }
        expect(timings).toHaveLength(7);
        expect(timings.at(-1)! / timings[0]!).toBeLessThan(256);
      });
    }
  });
});
