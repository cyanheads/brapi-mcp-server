/**
 * @fileoverview `brapi_dataframe_drop` — release a single dataframe by name.
 * Idempotent (returns `dropped: false` for unknown names rather than failing).
 * Drops the dataframe and its provenance metadata.
 *
 * Gated opt-in via `BRAPI_CANVAS_DROP_ENABLED` — when the operator hasn't
 * opted in, the tool is omitted from `tools/list` entirely and dataframes
 * expire via TTL when left unmanaged.
 *
 * @module mcp-server/tools/definitions/brapi-dataframe-drop.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
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
    'Drop a dataframe by name. Idempotent — returns dropped:false rather than failing when the name is unknown. Dataframes also expire via TTL automatically; explicit drop is only needed when the operator wants to free workspace memory immediately.',
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  input: InputSchema,
  output: OutputSchema,

  async handler(input, ctx) {
    const bridge = getCanvasBridge();
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
