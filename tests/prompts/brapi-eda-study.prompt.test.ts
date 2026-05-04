/**
 * @fileoverview Tests for the `brapi_eda_study` prompt template.
 *
 * @module tests/prompts/brapi-eda-study.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { brapiEdaStudy } from '@/mcp-server/prompts/definitions/brapi-eda-study.prompt.js';

describe('brapi_eda_study prompt', () => {
  it('renders the studyDbId into the workflow text', () => {
    const args = brapiEdaStudy.args.parse({ studyDbId: 's-42' });
    const messages = brapiEdaStudy.generate(args);
    expect(messages).toHaveLength(1);
    const message = messages[0]!;
    expect(message.role).toBe('user');
    expect(message.content.type).toBe('text');
    const text = (message.content as { text: string }).text;
    expect(text).toContain('s-42');
    expect(text).toContain('brapi_get_study');
    expect(text).toContain('brapi_find_variables');
    expect(text).toContain('brapi_find_observations');
    expect(text).toContain('brapi_walk_pedigree');
  });

  it('inlines the alias arg when provided', () => {
    const args = brapiEdaStudy.args.parse({ studyDbId: 's-1', alias: 'bti-cassava' });
    const text = (brapiEdaStudy.generate(args)[0]!.content as { text: string }).text;
    expect(text).toContain('alias: "bti-cassava"');
  });

  it('omits the alias arg when not provided', () => {
    const args = brapiEdaStudy.args.parse({ studyDbId: 's-1' });
    const text = (brapiEdaStudy.generate(args)[0]!.content as { text: string }).text;
    expect(text).not.toContain('alias:');
  });

  it('rejects empty studyDbId at parse time', () => {
    expect(() => brapiEdaStudy.args.parse({ studyDbId: '' })).toThrow();
  });

  it('rejects malformed alias at parse time', () => {
    expect(() => brapiEdaStudy.args.parse({ studyDbId: 's-1', alias: 'has space' })).toThrow();
  });
});
