/**
 * @fileoverview Regression coverage for pruning and native runtime inventory in the MCPB.
 * @module tests/scripts/mcpb-packaging.test
 */
import { describe, expect, it } from 'vitest';
import {
  filterAgentDocEntries,
  filterBuildOnlyEntries,
  filterNodeGypBuildEntries,
} from '../../scripts/clean-mcpb.ts';
import { checkBundleEntries } from '../../scripts/lint-packaging.ts';
import { parseDuckDbBindings } from '../../scripts/mcpb-duckdb-bindings.ts';

const agentDoc = 'node_modules/example/node_modules/@scope/child/skills/sample/SKILL.md';
const buildOnly = 'node_modules/@cyanheads/mcp-ts-core/templates/server.json';
const gypOutput = 'node_modules/addon/build/obj.target/addon.o';
const retained = [
  'skills/brapi/SKILL.md',
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.js',
  'node_modules/addon/binding.gyp',
  'node_modules/addon/build/Release/addon.node',
  'node_modules/example/build/Makefile',
];
const nativePackages = [
  ['darwin-arm64', 'libduckdb.dylib'],
  ['darwin-x64', 'libduckdb.dylib'],
  ['linux-arm64', 'libduckdb.so'],
  ['linux-arm64-musl', 'libduckdb.so'],
  ['linux-x64', 'libduckdb.so'],
  ['linux-x64-musl', 'libduckdb.so'],
  ['win32-arm64', 'duckdb.dll'],
  ['win32-x64', 'duckdb.dll'],
];
const bindings = nativePackages.flatMap(([platform, library]) =>
  ['package.json', 'duckdb.node', library].map(
    (file) => `node_modules/@duckdb/node-bindings-${platform}/${file}`,
  ),
);

describe('MCPB pruning', () => {
  it('strips dependency agent docs, build-only files and node-gyp intermediates', () => {
    const entries = [...retained, agentDoc, buildOnly, gypOutput];
    expect(filterAgentDocEntries(entries)).toEqual([agentDoc]);
    expect(filterBuildOnlyEntries(entries)).toEqual([buildOnly]);
    expect(filterNodeGypBuildEntries(entries)).toEqual([gypOutput]);
    const errors = checkBundleEntries(entries, 'fixture.mcpb');
    for (const path of [agentDoc, gypOutput, buildOnly]) {
      expect(errors).toContainEqual(expect.stringContaining(path));
    }
  });
});

describe('MCPB DuckDB runtime inventory', () => {
  it('accepts the complete inventory alongside the published skill and runtime files', () => {
    expect(checkBundleEntries([...retained, ...bindings], 'fixture.mcpb')).toEqual([]);
  });

  it('rejects an archive with no native bindings', () => {
    expect(checkBundleEntries(retained, 'fixture.mcpb')).toContainEqual(
      expect.stringContaining('node_modules/@duckdb/node-bindings-darwin-arm64/duckdb.node'),
    );
  });

  it('rejects an otherwise complete archive missing the Windows arm64 package', () => {
    const entries = bindings.filter((entry) => !entry.includes('win32-arm64'));
    expect(checkBundleEntries(entries, 'fixture.mcpb')).toContainEqual(
      expect.stringContaining('node_modules/@duckdb/node-bindings-win32-arm64/duckdb.node'),
    );
  });

  it('rejects a musl binding paired with the wrong shared library name', () => {
    const missing = 'node_modules/@duckdb/node-bindings-linux-x64-musl/libduckdb.so';
    const entries = bindings.map((entry) =>
      entry === missing ? entry.replace('.so', '.dll') : entry,
    );
    expect(checkBundleEntries(entries, 'fixture.mcpb')).toContainEqual(
      expect.stringContaining(missing),
    );
  });
});

describe('DuckDB loader manifest', () => {
  it('uses the exact version declared by each optional dependency', () => {
    const bindings = parseDuckDbBindings({
      name: '@duckdb/node-bindings',
      optionalDependencies: {
        '@duckdb/node-bindings-linux-x64': '3.1.2',
        '@duckdb/node-bindings-linux-x64-musl': '3.2.0-rc.1',
      },
    });
    expect(bindings.map(({ version }) => version)).toEqual(['3.1.2', '3.2.0-rc.1']);
  });

  it.each([
    {},
    { '@duckdb/node-bindings-linux-x64': '^2.0.0' },
    { '@duckdb/node-bindings-linux-x64': 'https://example.com/bindings.tgz' },
    { '@duckdb/node-bindings-linux-x64': 2 },
    { '@duckdb/node-bindings-linux/../escape': '2.0.0' },
    { '@duckdb/node-bindings-unknown-x64': '2.0.0' },
  ])('rejects an invalid optional dependency inventory (%j)', (optionalDependencies) => {
    expect(() =>
      parseDuckDbBindings({ name: '@duckdb/node-bindings', optionalDependencies }),
    ).toThrow();
  });
});
