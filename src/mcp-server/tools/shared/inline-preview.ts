/**
 * @fileoverview Strict byte-bounded row previews for raw and SQL results.
 * @module mcp-server/tools/shared/inline-preview
 */

import { INLINE_RESULTS_BUDGET_BYTES, type InlineSelection } from './find-helpers.js';
import { fenced } from './markdown-literals.js';

/** Select a prefix fitting both the JSON array and serialized rendered row section. */
export function selectPreviewRows<T>(
  rows: readonly T[],
  limit: number,
  render: (rows: readonly T[]) => string,
): InlineSelection<T> {
  const ceiling = Math.min(rows.length, limit);
  let low = 0;
  let high = ceiling;
  while (low < high) {
    const count = Math.ceil((low + high) / 2);
    const prefix = rows.slice(0, count);
    if (
      Buffer.byteLength(JSON.stringify(prefix)) <= INLINE_RESULTS_BUDGET_BYTES &&
      Buffer.byteLength(JSON.stringify(render(prefix))) <= INLINE_RESULTS_BUDGET_BYTES
    )
      low = count;
    else high = count - 1;
  }
  const selected: InlineSelection<T> = { rows: rows.slice(0, low) };
  if (low < rows.length) selected.bound = low < ceiling ? 'budget' : 'loadLimit';
  return selected;
}

/** Render the raw list's row section, excluding envelope siblings. */
export function renderRawRows(rows: readonly unknown[], nested = false): string {
  return fenced(JSON.stringify(nested ? { data: rows } : rows, null, 2), 'json');
}
