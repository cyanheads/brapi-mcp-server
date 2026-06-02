/**
 * @fileoverview Shared canvas column-name sanitizer. The two matrix-building
 * tools (`brapi_build_phenotype_matrix`, `brapi_export_genotype_matrix`) pivot
 * upstream IDs (`observationVariableDbId`, `variantDbId`) into dataframe column
 * names. The framework's canvas registers tables through `assertValidIdentifier`,
 * which rejects any column whose name fails `/^[A-Za-z_][A-Za-z0-9_]{0,62}$/` or
 * matches a reserved SQL keyword. BrAPI DbIds are routinely numeric (Breedbase
 * uses integers) or collide with reserved words, so column names must be
 * sanitized to SQL-safe identifiers before registration — paired with a legend
 * mapping the safe name back to the original ID so the correlation is never lost.
 *
 * `sanitizeRowColumns` applies the same rules to whole spilled rows at the
 * `CanvasBridge.registerDataframe` choke point, so every generic `find_*`
 * spillover (not just the matrix pivots) is protected — a `/variants` row's
 * reserved `end` key no longer fails registration.
 *
 * @module mcp-server/tools/shared/canvas-columns
 */

/**
 * Reserved SQL keywords rejected by the framework canvas gate
 * (`assertValidIdentifier`, reason `identifierReserved`). Kept in sync with the
 * framework's `RESERVED_IDENTIFIERS` set — a sanitized name matching one of
 * these (case-insensitive) is suffixed with `_` to clear the gate.
 */
const RESERVED_IDENTIFIERS = new Set([
  'select',
  'from',
  'where',
  'order',
  'group',
  'having',
  'limit',
  'offset',
  'union',
  'intersect',
  'except',
  'all',
  'distinct',
  'as',
  'and',
  'or',
  'not',
  'null',
  'true',
  'false',
  'case',
  'when',
  'then',
  'else',
  'end',
  'join',
  'inner',
  'outer',
  'left',
  'right',
  'full',
  'cross',
  'on',
  'using',
  'with',
  'recursive',
]);

/**
 * Sanitize an arbitrary upstream ID into a valid DuckDB column identifier.
 * Mirrors the framework's `CANVAS_IDENTIFIER_REGEX` (`/^[A-Za-z_][A-Za-z0-9_]{0,62}$/`):
 * replace illegal characters with `_`, prefix `v_` when the result would start
 * with a digit, truncate to 63 chars, and suffix `_` when the result collides
 * with a reserved SQL keyword.
 */
export function sanitizeColumnName(raw: string): string {
  let name = raw.replace(/[^A-Za-z0-9_]/g, '_');
  if (/^[0-9]/.test(name)) name = `v_${name}`;
  if (name.length > 63) name = name.slice(0, 63);
  if (name.length === 0) name = 'v_unknown';
  if (RESERVED_IDENTIFIERS.has(name.toLowerCase())) {
    name = name.length >= 63 ? `${name.slice(0, 62)}_` : `${name}_`;
  }
  return name;
}

/**
 * Sanitize a list of IDs into unique column names, preserving input order. When
 * two IDs sanitize to the same name, later collisions get a numeric suffix
 * (`_2`, `_3`, …). Returns the column names in order plus a legend mapping each
 * safe column name back to its original ID.
 */
export function buildUniqueColumns(ids: readonly string[]): {
  columns: string[];
  toOriginal: Record<string, string>;
} {
  const used = new Map<string, number>();
  const columns: string[] = [];
  const toOriginal: Record<string, string> = {};
  for (const id of ids) {
    const base = sanitizeColumnName(id);
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    const colName = count === 1 ? base : `${base}_${count}`;
    columns.push(colName);
    toOriginal[colName] = id;
  }
  return { columns, toOriginal };
}

/**
 * Sanitize every column key across a spilled row set into SQL-safe DuckDB
 * identifiers, reusing {@link buildUniqueColumns}. Returns the (possibly
 * rewritten) rows plus a legend mapping each *renamed* safe column back to its
 * original upstream key — entries are added only for columns that actually
 * changed. When every key is already a valid identifier the input rows are
 * returned by reference and the legend is empty, so the common (all-safe) path
 * stays allocation-free.
 *
 * Centralizing this at `CanvasBridge.registerDataframe` keeps every spill
 * consumer safe by construction: a row carrying a reserved word (`end`,
 * `order`, …) or a digit-leading key no longer trips the framework's
 * `assertValidIdentifier` gate at table registration.
 */
export function sanitizeRowColumns(rows: ReadonlyArray<Record<string, unknown>>): {
  legend: Record<string, string>;
  rows: Record<string, unknown>[];
} {
  // Ordered union of keys across all (sparse) rows — later rows may introduce
  // columns the first row lacks.
  const order: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        order.push(key);
      }
    }
  }

  const { columns } = buildUniqueColumns(order);
  const rename = new Map<string, string>();
  const legend: Record<string, string> = {};
  order.forEach((original, i) => {
    const safe = columns[i] ?? original;
    rename.set(original, safe);
    if (safe !== original) legend[safe] = original;
  });

  if (Object.keys(legend).length === 0) {
    return { rows: rows as Record<string, unknown>[], legend: {} };
  }

  const rewritten = rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      out[rename.get(key) ?? key] = value;
    }
    return out;
  });
  return { rows: rewritten, legend };
}
