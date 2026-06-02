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
