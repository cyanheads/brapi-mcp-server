/**
 * @fileoverview Raw list preview sizing and page-aware canvas staging.
 * @module mcp-server/tools/shared/raw-preview
 */

import {
  type DataframeHandle,
  extractListRows,
  noteSpillStop,
  type SpillInput,
  spillToCanvas,
  stagedDataframeNotice,
  toDataframeHandle,
} from './find-helpers.js';
import { renderRawRows, selectPreviewRows } from './inline-preview.js';

/** Keep envelope siblings while bounding raw list rows and retaining omitted data. */
export async function previewRawResult(
  raw: unknown,
  input: Omit<SpillInput<Record<string, unknown>>, 'firstPage'>,
  explicitPage: boolean,
): Promise<{ result: unknown; dataframe?: DataframeHandle }> {
  const rows = extractListRows(raw);
  if (rows === null || rows.length === 0) return { result: raw };
  const nested = !Array.isArray(raw);
  const selection = selectPreviewRows(rows, input.loadLimit, (prefix) =>
    renderRawRows(prefix, nested),
  );
  const more =
    input.totalCount === undefined
      ? rows.length >= input.loadLimit
      : input.totalCount > rows.length;
  if (!selection.bound && (explicitPage || !more)) return { result: raw };

  let dataframe: DataframeHandle;
  if (explicitPage || !more) {
    dataframe = toDataframeHandle(
      await input.bridge.registerDataframe(input.ctx, {
        source: input.source,
        baseUrl: input.connection.baseUrl,
        query: input.filters,
        rows,
      }),
    );
  } else {
    const spill = await spillToCanvas({ ...input, firstPage: rows });
    const warning = noteSpillStop(input.ctx, input.source, spill, input.totalCount);
    if (warning) input.ctx.enrich({ warnings: [warning] });
    // Nonempty raw object rows always survive this unfiltered walk.
    if (!spill.dataframe) throw new Error('Raw spill returned no dataframe for nonempty rows.');
    dataframe = toDataframeHandle(spill.dataframe);
  }
  const result = nested
    ? { ...(raw as Record<string, unknown>), data: selection.rows }
    : selection.rows;
  const bound =
    selection.bound === 'budget'
      ? 'the 24,000-byte inline budget bound the preview'
      : selection.bound === 'loadLimit'
        ? `loadLimit (${input.loadLimit}) bound the preview`
        : 'the upstream first page is the inline preview';
  const coverage = explicitPage
    ? 'The dataframe contains only the requested upstream page; fetch the next upstream page using its pagination, independently of SQL offsets.'
    : 'The dataframe contains every fetched row; its truncated flag and warnings disclose an incomplete upstream walk.';
  const continuation =
    selection.rows.length === 0
      ? 'Use a narrower projection (SELECT only the needed columns) or aggregation before retrying.'
      : 'Start a deterministic ORDER BY with LIMIT/OFFSET on the staged table at OFFSET 0, then advance OFFSET by rows actually shown by each SQL call; upstream page order may differ.';
  input.ctx.enrich.truncated({
    shown: selection.rows.length,
    cap: input.loadLimit,
    guidance: `Raw result shows ${selection.rows.length} row(s): ${bound}. ${stagedDataframeNotice([dataframe])} ${coverage} ${continuation}`,
  });
  return { result, dataframe };
}
