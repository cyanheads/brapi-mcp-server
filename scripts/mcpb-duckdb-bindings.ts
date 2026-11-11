/**
 * @fileoverview Derive the MCPB's DuckDB runtime inventory from the installed loader manifest.
 * @module scripts/mcpb-duckdb-bindings
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { z } from 'zod';

const loaderName = '@duckdb/node-bindings';
const sharedLibraries = {
  darwin: 'libduckdb.dylib',
  linux: 'libduckdb.so',
  win32: 'duckdb.dll',
} as const;

const bindingName =
  /^@duckdb\/node-bindings-(?:(?:darwin|win32)-[a-z0-9]+|linux-[a-z0-9]+(?:-musl)?)$/;
const exactVersion = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
const loaderManifest = z.object({
  name: z.literal(loaderName),
  optionalDependencies: z.record(z.string().regex(bindingName), z.string().regex(exactVersion)),
});

/** Validate the upstream manifest before its package names and versions enter paths or npm specs. */
export function parseDuckDbBindings(manifest: unknown) {
  const packages = Object.entries(loaderManifest.parse(manifest).optionalDependencies);
  if (packages.length === 0) {
    throw new Error(`${loaderName} declares no platform packages in optionalDependencies.`);
  }
  return packages.map(([name, version]) => {
    const platform = z.enum(['darwin', 'linux', 'win32']).parse(name.split('-')[2]);
    return {
      name,
      version,
      directory: `node_modules/${name}`,
      runtimeFiles: ['package.json', 'duckdb.node', sharedLibraries[platform]],
    };
  });
}

/** Read the same loader manifest that this project's DuckDB API resolves. */
export function readDuckDbBindings() {
  const require = createRequire(import.meta.url);
  const loader = createRequire(require.resolve('@duckdb/node-api')).resolve(
    `${loaderName}/package.json`,
  );
  return parseDuckDbBindings(JSON.parse(readFileSync(loader, 'utf8')));
}

/** Report every missing DuckDB package manifest, native addon, or shared library. */
export function missingDuckDbBindingEntries(entries: string[]): string[] {
  const listed = new Set(entries);
  return readDuckDbBindings()
    .flatMap(({ directory, runtimeFiles }) => runtimeFiles.map((file) => `${directory}/${file}`))
    .filter((entry) => !listed.has(entry));
}
