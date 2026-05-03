/**
 * @fileoverview `brapi_dataframe_drop` — release a single dataframe by name.
 * Idempotent (returns `dropped: false` for unknown names rather than failing).
 * Drops the dataframe and any provenance metadata stored alongside it. The
 * originating dataset is unaffected — use `brapi_manage_dataset mode=delete`
 * to drop both.
 *
 * @module mcp-server/tools/definitions/brapi-dataframe-drop.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge } from '@/services/canvas-bridge/index.js';

const InputSchema = z.object({
  dataframe: z
    .string()
    .min(1)
    .describe(
      'Dataframe to drop. Use brapi_dataframe_describe to discover names. Returns dropped:false (no error) when the name is unknown.',
    ),
});

const OutputSchema = z.object({
  dataframe: z.string().describe('The dataframe name that was requested for drop.'),
  dropped: z
    .boolean()
    .describe('True when the dataframe existed and was removed; false when it did not exist.'),
});

export const brapiDataframeDrop = tool('brapi_dataframe_drop', {
  description:
    'Drop a dataframe by name. Idempotent — returns dropped:false rather than failing when the name is unknown. The underlying dataset is untouched (use brapi_manage_dataset mode=delete to drop both).',
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  errors: [
    {
      reason: 'dataframe_disabled',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Dataframe surface is gated off by env (CANVAS_PROVIDER_TYPE != duckdb or BRAPI_CANVAS_ENABLED=false)',
      recovery:
        'Set CANVAS_PROVIDER_TYPE=duckdb and BRAPI_CANVAS_ENABLED=true on the deployment, or use brapi_manage_dataset for the underlying dataset.',
    },
  ] as const,
  input: InputSchema,
  output: OutputSchema,

  async handler(input, ctx) {
    const bridge = getCanvasBridge();
    if (!bridge.isEnabled()) {
      throw ctx.fail(
        'dataframe_disabled',
        'brapi_dataframe_drop is unavailable — dataframes are not enabled on this deployment.',
        { ...ctx.recoveryFor('dataframe_disabled') },
      );
    }
    const dropped = await bridge.drop(ctx, input.dataframe);
    return { dataframe: input.dataframe, dropped };
  },

  format: (result) => [
    {
      type: 'text',
      text: result.dropped
        ? `# Dropped \`${result.dataframe}\`\n- dropped: true`
        : `# No-op — \`${result.dataframe}\` not found\n- dropped: false`,
    },
  ],
});
