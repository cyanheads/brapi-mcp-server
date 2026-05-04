/**
 * @fileoverview Tests for the `brapi_meta_analysis` prompt template.
 *
 * @module tests/prompts/brapi-meta-analysis.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { brapiMetaAnalysis } from '@/mcp-server/prompts/definitions/brapi-meta-analysis.prompt.js';

describe('brapi_meta_analysis prompt', () => {
  it('parses comma-separated germplasm IDs and inlines them', () => {
    const args = brapiMetaAnalysis.args.parse({
      germplasmDbIds: 'g-1, g-2 ,g-3',
      traitName: 'Plant height',
    });
    const text = (brapiMetaAnalysis.generate(args)[0]!.content as { text: string }).text;
    expect(text).toContain('Plant height');
    expect(text).toContain('"g-1"');
    expect(text).toContain('"g-2"');
    expect(text).toContain('"g-3"');
    expect(text).toContain('3 germplasm');
  });

  it('cites the curated tools the playbook expects', () => {
    const args = brapiMetaAnalysis.args.parse({
      germplasmDbIds: 'g-1',
      traitName: 'Dry matter content',
    });
    const text = (brapiMetaAnalysis.generate(args)[0]!.content as { text: string }).text;
    expect(text).toContain('brapi_find_variables');
    expect(text).toContain('brapi_find_observations');
    expect(text).toContain('brapi_get_study');
    expect(text).toContain('brapi_manage_dataset');
    expect(text).toContain('brapi_walk_pedigree');
  });

  it('tells agents to pivot to study-anchored observation calls after preflight stalls', () => {
    const args = brapiMetaAnalysis.args.parse({
      germplasmDbIds: 'g-1',
      traitName: 'Dry matter content',
    });
    const text = (brapiMetaAnalysis.generate(args)[0]!.content as { text: string }).text;
    expect(text).toContain('unanchored observation query stalled');
    expect(text).toContain('studies: ["<studyDbId>"]');
    expect(text).toContain('germplasm');
  });

  it('threads the alias arg through every tool call snippet', () => {
    const args = brapiMetaAnalysis.args.parse({
      germplasmDbIds: 'g-1',
      traitName: 'Yield',
      alias: 'bti-sweetpotato',
    });
    const text = (brapiMetaAnalysis.generate(args)[0]!.content as { text: string }).text;
    const aliasOccurrences = text.match(/alias: "bti-sweetpotato"/g) ?? [];
    expect(aliasOccurrences.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects empty traitName at parse time', () => {
    expect(() => brapiMetaAnalysis.args.parse({ germplasmDbIds: 'g-1', traitName: '' })).toThrow();
  });
});
