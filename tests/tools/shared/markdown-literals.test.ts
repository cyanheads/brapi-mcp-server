/**
 * @fileoverview Parser-backed literal rendering regressions.
 * @module tests/tools/shared/markdown-literals.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { marked } from 'marked';
import { describe, expect, it, vi } from 'vitest';
import { brapiBuildPhenotypeMatrix } from '@/mcp-server/tools/definitions/brapi-build-phenotype-matrix.tool.js';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiDataframeDescribe } from '@/mcp-server/tools/definitions/brapi-dataframe-describe.tool.js';
import { brapiDataframeDrop } from '@/mcp-server/tools/definitions/brapi-dataframe-drop.tool.js';
import { brapiDataframeExport } from '@/mcp-server/tools/definitions/brapi-dataframe-export.tool.js';
import { brapiDataframeQuery } from '@/mcp-server/tools/definitions/brapi-dataframe-query.tool.js';
import { brapiDescribeFilters } from '@/mcp-server/tools/definitions/brapi-describe-filters.tool.js';
import { brapiExportGenotypeMatrix } from '@/mcp-server/tools/definitions/brapi-export-genotype-matrix.tool.js';
import { brapiFindGenotypeCalls } from '@/mcp-server/tools/definitions/brapi-find-genotype-calls.tool.js';
import { brapiFindGermplasm } from '@/mcp-server/tools/definitions/brapi-find-germplasm.tool.js';
import { brapiFindImages } from '@/mcp-server/tools/definitions/brapi-find-images.tool.js';
import { brapiFindLocations } from '@/mcp-server/tools/definitions/brapi-find-locations.tool.js';
import { brapiFindObservations } from '@/mcp-server/tools/definitions/brapi-find-observations.tool.js';
import { brapiFindStudies } from '@/mcp-server/tools/definitions/brapi-find-studies.tool.js';
import { brapiFindVariables } from '@/mcp-server/tools/definitions/brapi-find-variables.tool.js';
import { brapiFindVariants } from '@/mcp-server/tools/definitions/brapi-find-variants.tool.js';
import { brapiGermplasmPerformance } from '@/mcp-server/tools/definitions/brapi-germplasm-performance.tool.js';
import { brapiGetGermplasm } from '@/mcp-server/tools/definitions/brapi-get-germplasm.tool.js';
import { brapiGetImage } from '@/mcp-server/tools/definitions/brapi-get-image.tool.js';
import { brapiGetStudy } from '@/mcp-server/tools/definitions/brapi-get-study.tool.js';
import { brapiRawGet } from '@/mcp-server/tools/definitions/brapi-raw-get.tool.js';
import { brapiRawSearch } from '@/mcp-server/tools/definitions/brapi-raw-search.tool.js';
import { brapiSubmitObservations } from '@/mcp-server/tools/definitions/brapi-submit-observations.tool.js';
import { brapiWalkPedigree } from '@/mcp-server/tools/definitions/brapi-walk-pedigree.tool.js';
import {
  renderAppliedFiltersTrailer,
  renderWarningsTrailer,
} from '@/mcp-server/tools/shared/find-helpers.js';
import {
  code,
  fenced,
  literal,
  prose,
  singleLine,
} from '@/mcp-server/tools/shared/markdown-literals.js';
import { formatOrientationEnvelope } from '@/mcp-server/tools/shared/orientation-envelope.js';
import { getCanvasBridge } from '@/services/canvas-bridge/index.js';
import {
  BASE_URL,
  envelope,
  initTestServices,
  jsonResponse,
  pathnameOf,
  resetTestServices,
} from '../_tool-test-helpers.js';

const payload = 'value**\r\n# injected [click](https://example.org) <img src=x> `|\\_end';

function assertLiteral(markdown: string, value: string): void {
  const tokens = marked.lexer(markdown, { gfm: false });
  let visible = '';
  marked.walkTokens(tokens, (token) => {
    expect(['link', 'image', 'html']).not.toContain(token.type);
    if (token.type === 'heading') expect(token.text).not.toBe('injected');
    if (['text', 'escape', 'codespan'].includes(token.type) && 'text' in token)
      visible += token.text;
  });
  expect(visible).toContain(singleLine(value));
}

describe('shared Markdown contexts', () => {
  it('rejects unescaped parser controls before accepting literal output', () => {
    for (const value of ['[click](https://example.org)', '<img src=x>']) {
      expect(() => assertLiteral(value, value)).toThrow();
      assertLiteral(prose(value), value);
    }
  });

  it.each([
    'benign_2026',
    'a\\b',
    'a*b_ c',
    'x|y',
    '[x](url)',
    '<b>&amp;</b>',
    '`a``b',
    '  ` spaced `  ',
    'x\r\ny\nz\u2028q',
    '# heading',
    '- item',
    '1. item',
  ])('preserves literal prose and code for %j', (value) => {
    assertLiteral(`- **${prose(value)}**`, value.trim());
    const tokens = marked.Lexer.lexInline(code(value));
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ type: 'codespan', text: singleLine(value) });
  });

  it('leaves intraword underscores unchanged and sizes paired template code slots', () => {
    expect(prose('sample_123')).toBe('sample_123');
    expect(literal`id=\`${'a`b\\c'}\``).toBe('id=``a`b\\c``');
  });

  it.each(['`', '\\', '**', '_end', '[x](url)', '<b>&amp;</b>', 'x\n# heading'])(
    'preserves adjacent template slots and authored emphasis for %j',
    (value) => {
      const rendered = literal`- **${value}** · id=\`${value}\` · ${value}${value}`;
      assertLiteral(rendered, value);
      const html = marked.parse(rendered, { gfm: false }) as string;
      expect(html.match(/<strong>/g)).toHaveLength(1);
      expect(html.match(/<code>/g)).toHaveLength(1);
      expect(html.match(/<li>/g)).toHaveLength(1);
      const spans: string[] = [];
      marked.walkTokens(marked.lexer(rendered, { gfm: false }), (token) => {
        if (token.type === 'codespan') spans.push(token.text);
      });
      expect(spans).toEqual([singleLine(value)]);
    },
  );

  it('keeps one table row and exact code values, including literal backslashes', () => {
    const value = 'a\\|`b\n# heading';
    const result = brapiDescribeFilters.output.parse({
      endpoint: 'studies',
      filterCount: 1,
      availableEndpoints: ['studies'],
      filters: [{ name: value, type: 'string', description: payload, example: value }],
    });
    const blocks = brapiDescribeFilters.format!(result);
    const tokens = marked.lexer(blocks.map((b) => ('text' in b ? b.text : '')).join('\n'));
    const table = tokens.find((t) => t.type === 'table');
    expect(table?.type).toBe('table');
    if (table?.type !== 'table') throw new Error('Expected table');
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toHaveLength(4);
    const html = marked.parser(tokens);
    expect(html).toContain('<code>a&#92;&#124;`b # heading</code></td>');
    expect(table.rows[0]?.[0]?.text).toBe(code(value, true));
    expect(table.rows[0]?.[3]?.text).toBe(code(value, true));
    expect(result.filters[0]?.name).toBe(value);
  });

  it('retains warning headings and literal filter and warning text', () => {
    assertLiteral(renderWarningsTrailer([payload]), payload);
    expect(renderWarningsTrailer([payload])).toMatch(/^\*\*Warnings:\*\*\n-/);
    expect(renderWarningsTrailer([])).toBe('');
    assertLiteral(renderAppliedFiltersTrailer({})({ [payload]: [payload] }), payload);
  });

  it('roundtrips arbitrary fenced source without introducing a second block', () => {
    const source = '```\n# heading\n````\nsource';
    const tokens = marked.lexer(fenced(source, 'text'));
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ type: 'code', text: source });
  });
});

describe('formatter boundary wiring', () => {
  const dataframe = {
    tableName: 'df_test',
    rowCount: 1,
    columns: ['sample'],
    createdAt: '2026-10-18T00:00:00Z',
    expiresAt: '2026-10-19T00:00:00Z',
  };
  const observation = {
    observationDbId: payload,
    observationVariableDbId: payload,
    observationUnitDbId: payload,
    value: payload,
  };
  it.each([
    [
      brapiDataframeDescribe,
      {
        tables: [
          {
            name: payload,
            rowCount: 1,
            columns: [{ name: payload, type: 'VARCHAR' }],
            provenance: {
              source: payload,
              baseUrl: payload,
              query: { value: payload },
              createdAt: '2026-10-18T00:00:00Z',
              expiresAt: '2026-10-19T00:00:00Z',
            },
          },
        ],
      },
    ],
    [brapiDataframeDrop, { dataframe: payload, dropped: true }],
    [
      brapiDataframeExport,
      {
        dataframe: 'df_test',
        filename: payload,
        path: payload,
        format: 'json',
        rowCount: 1,
        sizeBytes: 1,
        columns: [{ name: payload, type: 'VARCHAR' }],
        expiresAt: '2026-10-19T00:00:00Z',
      },
    ],
    [
      brapiBuildPhenotypeMatrix,
      {
        alias: 'default',
        studies: [payload],
        coverage: {
          partial: true,
          studies: [
            { studyDbId: payload, status: 'partial', observationCount: 1, reason: payload },
          ],
        },
        shape: 'wide',
        aggregate: 'first',
        observationCount: 1,
        germplasmCount: 1,
        variableCount: 1,
        variableLegend: { sample: payload },
        dataframe,
        warnings: [payload],
      },
    ],
    [
      brapiExportGenotypeMatrix,
      {
        alias: 'default',
        format: 'vcf-lite',
        rowCount: 1,
        columnCount: 1,
        variantColumnLegend: { sample: payload },
        callFormatting: { unknownString: payload },
        dataframe,
        vcf: '```\n# injected\n````\nsource',
        truncated: false,
        warnings: [payload],
      },
    ],
    [
      brapiSubmitObservations,
      {
        alias: 'default',
        result: {
          mode: 'preview',
          studyDbId: payload,
          studyName: payload,
          valid: 1,
          invalid: 0,
          routing: { postCount: 1, putCount: 0 },
          knownVariableCount: 1,
          perRowWarnings: [{ rowIndex: 0, ...observation, warning: payload }],
        },
      },
    ],
    [
      brapiSubmitObservations,
      {
        alias: 'default',
        result: {
          mode: 'apply',
          studyDbId: payload,
          studyName: payload,
          posted: [observation],
          updated: [observation],
          perRowWarnings: [{ rowIndex: 0, ...observation, warning: payload }],
          warnings: [payload],
        },
      },
    ],
  ] as const)(
    'remaining formatter family %#: preserves literals and structured values',
    (definition, fixture) => {
      const result = definition.output.parse(fixture);
      const before = JSON.stringify(result);
      const rendered = definition.format!(result as never)
        .map((b) => ('text' in b ? b.text : ''))
        .join('\n');
      assertLiteral(rendered, payload);
      expect(JSON.stringify(result)).toBe(before);
      if (definition === brapiExportGenotypeMatrix) {
        const blocks = marked.lexer(rendered).filter((token) => token.type === 'code');
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toMatchObject({ text: '```\n# injected\n````\nsource' });
      }
    },
  );

  it('keeps categorical observation extrema literal inside the statistics join', () => {
    const result = brapiGermplasmPerformance.output.parse({
      alias: 'default',
      germplasmDbId: 'g1',
      studyCount: 1,
      studyDbIds: ['s1'],
      coverage: { partial: false, studies: [] },
      perVariable: [
        {
          observationVariableDbId: 'v1',
          n: 1,
          min: payload,
          max: payload,
          studyCount: 1,
          studyDbIds: ['s1'],
          seasons: [],
        },
      ],
      warnings: [],
    });
    const before = JSON.stringify(result);
    const rendered = brapiGermplasmPerformance.format!(result)
      .map((b) => ('text' in b ? b.text : ''))
      .join('\n');
    assertLiteral(rendered, payload);
    expect(JSON.stringify(result)).toBe(before);
  });

  it('keeps orientation fields and SQL projected names and values literal', () => {
    assertLiteral(
      formatOrientationEnvelope({
        alias: 'default',
        baseUrl: 'https://example.org',
        server: { name: payload, description: payload },
        auth: { mode: 'none' },
        capabilities: { supportedCount: 1, supported: ['studies'], notableGaps: [] },
        dialect: {
          id: 'spec',
          source: 'fallback',
          envVar: 'BRAPI_DEFAULT_DIALECT',
          disabledSearchEndpoints: [],
          notes: [payload],
        },
        content: { crops: [payload] },
        nextToolSuggestions: [],
        notes: [payload],
        fetchedAt: '2026-10-18T00:00:00Z',
      }),
      payload,
    );
    const result = brapiDataframeQuery.output.parse({
      rowCount: 1,
      columns: [{ name: payload, type: 'VARCHAR' }],
      rows: [{ [payload]: payload }],
    });
    const markdown = brapiDataframeQuery.format!(result)
      .map((b) => ('text' in b ? b.text : ''))
      .join('\n');
    assertLiteral(markdown, payload);
    expect(result.rows).toEqual([{ [payload]: payload }]);
  });

  it('sizes finder previews with their actual escaped rows and stages every original value', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      germplasmDbId: `g${i}`,
      germplasmName: '*'.repeat(3000),
    }));
    const fetcher = initTestServices();
    const bridge = getCanvasBridge();
    const staged = vi.spyOn(bridge, 'registerDataframe');
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/serverinfo'))
        return jsonResponse(
          envelope({
            serverName: 'Literal test',
            calls: [{ service: 'germplasm', methods: ['GET'], versions: ['2.1'] }],
          }),
        );
      if (path.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: [] }));
      if (path.endsWith('/germplasm'))
        return jsonResponse(envelope({ data: rows }, { totalCount: rows.length }));
      throw new Error(`Unexpected request: ${url}`);
    });
    try {
      const ctx = createMockContext({ errors: brapiFindGermplasm.errors });
      await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
      const result = await brapiFindGermplasm.handler(
        brapiFindGermplasm.input.parse({ loadLimit: 12 }),
        ctx,
      );
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results.length).toBeLessThan(7);
      expect(result.results).toEqual(rows.slice(0, result.results.length));
      expect(staged.mock.calls).toHaveLength(1);
      expect(staged.mock.calls[0]?.[1].rows).toEqual(rows);
      expect(result.dataframe?.rowCount).toBe(12);
      const markdown = brapiFindGermplasm.format!(result)
        .map((b) => ('text' in b ? b.text : ''))
        .join('\n');
      const section = markdown.split('## Germplasm\n')[1]?.split('\n\n## Dataframe handle')[0];
      expect(section).toBeDefined();
      expect(Buffer.byteLength(JSON.stringify(`## Germplasm\n${section}`))).toBeLessThanOrEqual(
        24_000,
      );
    } finally {
      staged.mockRestore();
      resetTestServices();
    }
  });
  const base = {
    alias: 'default',
    hasMore: false,
    distributions: Object.fromEntries(
      [
        'commonCropName',
        'genus',
        'species',
        'collection',
        'countryOfOriginCode',
        'programName',
        'studyType',
        'seasons',
        'locationName',
        'ontologyDbId',
        'traitClass',
        'scaleName',
        'countryCode',
        'locationType',
        'observationVariableName',
        'studyName',
        'germplasmName',
        'observationLevel',
        'season',
        'mimeType',
        'observationUnitName',
        'descriptiveOntologyTerms',
        'variantType',
        'referenceName',
        'variantSetDbId',
      ].map((key) => [key, {}]),
    ),
  };
  const finders = [
    [
      brapiFindGermplasm,
      { ...base, results: [{ germplasmDbId: payload, germplasmName: payload }] },
    ],
    [brapiFindStudies, { ...base, results: [{ studyDbId: payload, studyName: payload }] }],
    [
      brapiFindVariables,
      {
        ...base,
        ontologyCandidates: [],
        results: [{ observationVariableDbId: payload, observationVariableName: payload }],
      },
    ],
    [
      brapiFindLocations,
      {
        ...base,
        coordinateAxisOrder: 'spec',
        results: [{ locationDbId: payload, locationName: payload }],
      },
    ],
    [
      brapiFindObservations,
      { ...base, results: [{ observationDbId: payload, observationVariableName: payload }] },
    ],
    [brapiFindImages, { ...base, results: [{ imageDbId: payload, imageName: payload }] }],
    [brapiFindVariants, { ...base, results: [{ variantDbId: payload, variantNames: [payload] }] }],
    [
      brapiFindGenotypeCalls,
      {
        ...base,
        truncated: false,
        callFormatting: {},
        distributions: { callSetName: {}, variantName: {}, variantSetDbId: {} },
        results: [{ callSetDbId: payload, callSetName: payload }],
      },
    ],
  ] as const;
  it.each(finders)(
    'finder %#: keeps upstream fields literal and unchanged',
    (definition, fixture) => {
      const result = definition.output.parse(fixture);
      const before = JSON.stringify(result);
      const rendered = definition.format!(result as never)
        .map((b) => ('text' in b ? b.text : ''))
        .join('\n');
      assertLiteral(rendered, payload);
      expect(JSON.stringify(result)).toBe(before);
    },
  );

  it.each([
    [
      brapiGetGermplasm,
      {
        alias: 'default',
        germplasm: { germplasmDbId: payload, germplasmName: payload },
        parents: [{ germplasmName: payload }],
        attributes: [{ attributeValue: payload }],
        directParentCount: 1,
        warnings: [payload],
      },
    ],
    [
      brapiGetStudy,
      {
        alias: 'default',
        study: { studyDbId: payload, studyName: payload },
        program: { programDbId: payload, programName: payload, nested: { value: payload } },
        warnings: [payload],
      },
    ],
    [
      brapiGetImage,
      {
        alias: 'default',
        images: [
          {
            imageDbId: payload,
            mimeType: 'image/png',
            sizeBytes: 1,
            source: 'imagecontent',
            metadata: { imageDbId: payload, imageName: payload },
          },
        ],
        errors: [{ imageDbId: payload, error: payload }],
        warnings: [{ imageDbId: payload, warning: payload }],
      },
    ],
  ] as const)('$0.name escapes detail and companion fields', (definition, fixture) => {
    const result = definition.output.parse(fixture);
    const rendered = definition.format!(result as never)
      .map((b) => ('text' in b ? b.text : ''))
      .join('\n');
    assertLiteral(rendered, payload);
  });

  it.each([brapiRawGet, brapiRawSearch])(
    '$name preserves fenced JSON in its complete formatter',
    (definition) => {
      const raw = {
        data: [{ value: '```\n# injected\n```', nested: { value: payload } }],
        sibling: payload,
      };
      const result = definition.output.parse({
        alias: 'default',
        path: '/germplasm',
        url: 'https://example.org',
        noun: 'germplasm',
        kind: 'sync',
        metadata: {},
        result: raw,
      });
      const markdown = definition.format!(result as never)
        .map((b) => ('text' in b ? b.text : ''))
        .join('\n');
      const blocks = marked.lexer(markdown);
      const codeBlocks = blocks.filter((b) => b.type === 'code');
      expect(codeBlocks).toHaveLength(1);
      expect(codeBlocks[0]?.type).toBe('code');
      if (codeBlocks[0]?.type !== 'code') throw new Error('Expected JSON code block');
      expect(JSON.parse(codeBlocks[0].text)).toEqual(raw);
      expect(result.result).toEqual(raw);
      expect(blocks.filter((b) => b.type === 'heading').map((b) => b.text)).not.toContain(
        'injected',
      );
    },
  );
});

function text(name: string, id: string): string {
  const value = brapiWalkPedigree.output.parse({
    alias: 'default',
    direction: 'ancestors',
    maxDepth: 1,
    depthReached: 0,
    nodes: [{ germplasmDbId: id, germplasmName: name, depth: 0, direction: 'root', isRoot: true }],
    edges: [],
    rootCount: 1,
    leafCount: 1,
    confirmedLeafCount: 1,
    frontierCount: 0,
    knownOmittedRelativeCount: 0,
    cycleCount: 0,
    deadEndCount: 0,
    truncated: false,
    frontier: [],
    warnings: [],
  });
  return brapiWalkPedigree.format!(value)
    .map((b) => ('text' in b ? b.text : ''))
    .join('\n');
}

describe('pedigree Markdown literals', () => {
  it('characterizes authored headings, bold names and literal code backslashes', () => {
    const html = marked.parse(text('Plant A', 'id\\value')) as string;
    expect(html).toContain('<strong>Plant A</strong>');
    expect(html).toContain('<code>id\\value</code>');
    expect(html).toContain('<h2>Nodes</h2>');
  });

  it('keeps upstream names and identifiers inside their authored structures', () => {
    const name = 'normal**\n# upstream heading [link](https://example.com) <img src=x>';
    const id = 'id`\n# id heading';
    const html = marked.parse(text(name, id), { gfm: false }) as string;
    expect(html).not.toContain('<h1>upstream');
    expect(html).not.toContain('<h1>id heading');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('<img ');
    expect(html).toContain('<code>id` # id heading</code>');
    expect(html).toContain(
      '<strong>normal** # upstream heading [link](https://example.com) &lt;img src=x&gt;</strong>',
    );
  });
});
