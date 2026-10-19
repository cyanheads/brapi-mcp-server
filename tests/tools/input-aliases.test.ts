/**
 * @fileoverview BrAPI identifier aliases through the production argument parser.
 * @module tests/tools/input-aliases
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import type { AnyToolDefinition } from '@cyanheads/mcp-ts-core/tools';
import { describe, expect, it } from 'vitest';
import { brapiGetImage } from '@/mcp-server/tools/definitions/brapi-get-image.tool.js';
import { readOnlyToolDefinitions } from '@/mcp-server/tools/definitions/index.js';

/** Echo parsed arguments so a contract test observes exactly what the handler receives. */
function probe(definition: AnyToolDefinition) {
  return tool('alias_probe', {
    description: 'Expose parsed arguments for contract verification.',
    input: definition.input,
    ...(definition.inputAliases ? { inputAliases: definition.inputAliases } : {}),
    output: z.object({ received: z.unknown().describe('Parsed arguments.') }),
    handler: async (input) => ({ received: input }),
    format: (result) => [{ type: 'text', text: JSON.stringify(result.received) }],
  });
}

describe('identifier input aliases', () => {
  it('characterizes canonical image arrays and their bound', async () => {
    const result = await runToolContract(probe(brapiGetImage), { imageDbIds: ['a', 'b'] });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ received: { imageDbIds: ['a', 'b'] } });
    expect(brapiGetImage.input.safeParse({ imageDbIds: [] }).success).toBe(false);
    expect(brapiGetImage.input.safeParse({ imageDbIds: Array(6).fill('a') }).success).toBe(false);
  });
  it('accepts a lone imageDbId through the real framework contract', async () => {
    const result = await runToolContract(probe(brapiGetImage), { imageDbId: 'a' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ received: { imageDbIds: ['a'] } });
    expect(JSON.stringify(result.content)).toContain('imageDbIds');
  });
  for (const definition of readOnlyToolDefinitions.filter(
    (candidate) => Object.keys(candidate.inputAliases ?? {}).length > 0,
  )) {
    it(`${definition.name} preserves every declared alias value and rejects collisions`, async () => {
      for (const [alias, canonical] of Object.entries(definition.inputAliases ?? {})) {
        const base: Record<string, unknown> =
          definition.name === 'brapi_build_phenotype_matrix'
            ? { studies: ['s'] }
            : definition.name === 'brapi_export_genotype_matrix'
              ? { variantSetDbId: 'vs', format: 'matrix-json' }
              : definition.name === 'brapi_germplasm_performance'
                ? { germplasmDbId: 'g' }
                : {};
        delete base[canonical];
        for (const value of ['one', ['one', 'two']]) {
          const result = await runToolContract(probe(definition), { ...base, [alias]: value });
          expect(
            result.isError,
            `${definition.name}.${alias}: ${JSON.stringify(result)}`,
          ).toBeFalsy();
          const received = (result.structuredContent as { received: Record<string, unknown> })
            .received;
          expect(received[canonical]).toEqual(Array.isArray(value) ? value : [value]);
          expect(received).not.toHaveProperty(alias);
          expect(JSON.stringify(result.content)).toContain('one');
          if (Array.isArray(value)) expect(JSON.stringify(result.content)).toContain('two');
        }
        const collision = await runToolContract(probe(definition), {
          ...base,
          [canonical]: ['kept'],
          [alias]: ['other'],
        });
        expect(collision.isError, `${definition.name}.${alias}`).toBe(true);
        expect(JSON.stringify(collision.content)).toContain(canonical);
      }
    });
  }
  it('rejects multiple aliases and unknown concepts without losing values', async () => {
    const definition = readOnlyToolDefinitions.find((d) => d.name === 'brapi_find_variables')!;
    const collision = await runToolContract(probe(definition), {
      studyDbId: 's1',
      studyDbIds: ['s2'],
    });
    expect(collision.isError).toBe(true);
    const unknown = await runToolContract(probe(brapiGetImage), {
      imageDbIds: ['a'],
      studyDbId: 's',
    });
    expect(unknown.isError).toBe(true);
  });
});
