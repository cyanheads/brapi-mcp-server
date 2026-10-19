/**
 * @fileoverview Literal upstream values at Markdown render boundaries.
 * @module mcp-server/tools/shared/markdown-literals
 */
import { escapeHtml, markdown } from '@cyanheads/mcp-ts-core/utils';

/** Flatten record fields that occupy a single authored line. */
export function singleLine(value: unknown): string {
  return String(value).replace(/[\r\n\u2028\u2029]+/g, ' ');
}

/** Preserve punctuation as visible text in prose, headings and emphasis. */
export function prose(value: unknown): string {
  return singleLine(value)
    .replace(/[\\`*[\]<>|&~#+]/g, '\\$&')
    .replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, '\\$&')
    .replace(
      /^([ \t]*)(-|\d+[.)])(?=\s)/,
      (_match, space: string, marker: string) => `${space}${marker.slice(0, -1)}\\${marker.at(-1)}`,
    );
}

/** Interpolate record fields into authored prose; paired backticks mark code slots. */
export function literal(parts: TemplateStringsArray, ...values: unknown[]): string {
  let text = '';
  let previous = '';
  for (const [i, next] of parts.entries()) {
    if (i === 0) {
      text = next;
    } else if (previous.endsWith('`') && next.startsWith('`')) {
      text = `${text.slice(0, -1)}${code(values[i - 1])}${next.slice(1)}`;
    } else {
      text += prose(values[i - 1]) + next;
    }
    previous = next;
  }
  return text;
}

/** Sized inline code preserves backslashes; table parsing still requires escaped pipes. */
export function code(value: unknown, table = false): string {
  const text = singleLine(value);
  // GFM splits cells before parsing code spans; slash parity makes \| unrepresentable there.
  if (table && text.includes('\\|'))
    return `<code>${escapeHtml(text).replace(/[\\|]/g, (char) => (char === '\\' ? '&#92;' : '&#124;'))}</code>`;
  return markdown()
    .inlineCode(table ? text.replace(/\|/g, '\\|') : text)
    .build();
}

/** Sized fences preserve arbitrary JSON and generated source without closing early. */
export function fenced(value: string, language = ''): string {
  return markdown().codeBlock(value, language).build().trimEnd();
}
