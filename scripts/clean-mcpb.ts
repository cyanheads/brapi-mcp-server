#!/usr/bin/env node
/**
 * @fileoverview Post-pack MCPB bundle cleaner. Runs after `mcpb pack` (wired
 * into the `bundle` package script) to remove bundle content the pack step
 * cannot exclude:
 *
 *   1. `mcpb clean <bundle>` — official dev-dependency prune + manifest
 *      validation (a measured real-world bundle dropped 61 MB → 12.9 MB).
 *   2. Exact-name strip of three entry classes nested under `node_modules/`,
 *      which root-anchored `.mcpbignore` patterns cannot reach by design
 *      (issues #146/#207):
 *        a. Dependency-shipped agent docs at an installed package's root —
 *           `framework-skills/`, `skills/`, `.claude/`, `.agents/` trees and
 *           `AGENTS.md`/`CLAUDE.md` — plus `SKILL.md` files anywhere (issues
 *           #230/#794/#820). A `skills/` below a package root is runtime code.
 *        b. node-gyp build output beside a `binding.gyp` — generator files,
 *           intermediate trees, and link inputs, which record the packing
 *           host's paths; compiled `*.node` addons stay (issue #783).
 *        c. Build-only package files — mcp-ts-core's `changelog/`, `config/`,
 *           `scripts/`, `templates/`, `biome.json`, and `vitest.config.base.mjs`,
 *           and better-sqlite3's `deps/` and `src/` C sources (issue #791).
 *   3. Replace the build host's DuckDB bindings with every platform package
 *      declared by the installed DuckDB loader. The canvas requires DuckDB.
 *   4. Verify the pruned entries are gone and the DuckDB inventory is complete.
 *
 * Entry names are passed to `zip -d` with `-nw` (no-wildcard) so they match
 * literally — bracketed runtime filenames like `pages/[slug].js` exist in
 * real packages and must not glob. Bundles are unsigned in this flow; if
 * `mcpb sign` is ever adopted, this script must run before signing.
 *
 * Usage: `bun run scripts/clean-mcpb.ts dist/<name>.mcpb`
 *
 * @module scripts/clean-mcpb
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { missingDuckDbBindingEntries, readDuckDbBindings } from './mcpb-duckdb-bindings.ts';

/**
 * Agent-doc entries under `node_modules/` that must not ship in a bundle: a
 * `framework-skills/`, `skills/`, `.claude/`, or `.agents/` directory, or an
 * `AGENTS.md` or `CLAUDE.md` file, at the root of an installed package
 * (`node_modules/<name>/` or `node_modules/@scope/<name>/`, at any nesting
 * depth), and a `SKILL.md` anywhere under `node_modules/`. Matching is
 * positional: a `skills/` directory below a package root is runtime code (the
 * MCP SDK's `dist/ext/skills/`, which the framework imports at startup), and a
 * segment starting with `@` always opens a two-segment scoped name, so
 * `@scope/skills` is a package, not a skills directory.
 * KEEP IN SYNC with `AGENT_DOC_ENTRY` in `scripts/lint-packaging.ts`
 * (post-bundle content check) — edit both literals together. The assertion that
 * they match lives in the mcp-ts-core repository's own test suite; `tests/` is
 * not part of the published package, so nothing enforces the pair in a server
 * these scripts were copied into.
 */
export const AGENT_DOC_ENTRY =
  /^node_modules\/(?:.+\/node_modules\/)?(?:@[^/]+\/[^/]+|[^@/][^/]*)\/(?:(?:framework-skills|skills|\.claude|\.agents)\/|(?:AGENTS|CLAUDE)\.md$)|^node_modules\/.*\/SKILL\.md$/;

/**
 * node-gyp output, matched against an entry's path below a `build/` directory
 * that has a sibling `binding.gyp` (see `filterNodeGypBuildEntries`).
 * KEEP IN SYNC with `NODE_GYP_OUTPUT` and `filterNodeGypBuildEntries` in
 * `scripts/lint-packaging.ts` (post-bundle content check) — edit both together.
 * The assertion that they select the same entries lives in the mcp-ts-core
 * repository's own test suite; `tests/` is not part of the published package,
 * so nothing enforces the pair in a server these scripts were copied into.
 *
 * Generator files (`config.gypi` records the packing host's node-gyp cache as
 * `nodedir`; `Makefile` records the checkout path), MSBuild projects,
 * `gyp-*-tool`, the `obj.target/`, `obj/`, `.deps/`, and `node_gyp_bins/`
 * intermediate trees, and link inputs and debug symbols. None is loaded at
 * runtime. Everything else under `build/` ships, so a compiled `*.node` addon
 * (loaders search `build/`, `build/Debug/`, and `build/Release/`) and any
 * shared library beside it survive.
 */
export const NODE_GYP_OUTPUT =
  /(?:^|\/)(?:(?:obj\.target|obj|\.deps|node_gyp_bins)\/|(?:config\.gypi|Makefile|gyp-mac-tool|gyp-flock-tool|[^/]+\.(?:Makefile|mk|sln|vcxproj|vcxproj\.filters|a|o|lib|obj|exp|pdb|ilk|iobj|ipdb))$)/;

/**
 * Build-only package files that must not ship in a bundle.
 * KEEP IN SYNC with `BUILD_ONLY_ENTRY` in `scripts/lint-packaging.ts`
 * (post-bundle content check) — edit both literals together. The assertion that
 * they match lives in the mcp-ts-core repository's own test suite; `tests/` is
 * not part of the published package, so nothing enforces the pair in a server
 * these scripts were copied into.
 *
 * mcp-ts-core publishes `changelog/`, `scripts/`, and `templates/` for `init`
 * and maintenance, and the config bases a server's own tooling extends —
 * `biome.json`, `vitest.config.base.mjs`, and `config/tsconfig.base.json`, the
 * only file in `config/`. The running server reads none of them (its
 * `framework-skills/`, `CLAUDE.md`, and `AGENTS.md` are agent-doc entries, so
 * no entry falls in both classes). better-sqlite3 publishes its `deps/` and
 * `src/` C sources for a source build; at runtime it loads a prebuilt or
 * compiled addon.
 */
export const BUILD_ONLY_ENTRY =
  /^node_modules\/(?:.+\/node_modules\/)?(?:@cyanheads\/mcp-ts-core\/(?:(?:changelog|config|scripts|templates)\/|(?:biome\.json|vitest\.config\.base\.mjs)$)|better-sqlite3\/(?:deps|src)\/)/;

/** Filter a bundle entry listing down to the agent-doc entries to strip. */
export function filterAgentDocEntries(entries: string[]): string[] {
  return entries.filter((entry) => AGENT_DOC_ENTRY.test(entry));
}

/**
 * Filter a bundle entry listing down to the node-gyp output to strip: entries
 * under `<dir>/build/` matching `NODE_GYP_OUTPUT`, for each `<dir>/binding.gyp`
 * in the listing. A `build/` with no sibling `binding.gyp` is never touched —
 * `@opentelemetry/semantic-conventions/build/src/` is a runtime entry.
 * KEEP IN SYNC with `filterNodeGypBuildEntries` in `scripts/lint-packaging.ts`.
 */
export function filterNodeGypBuildEntries(entries: string[]): string[] {
  const buildDirs = entries
    .filter((entry) => /(?:^|\/)binding\.gyp$/.test(entry))
    .map((entry) => `${entry.slice(0, -'binding.gyp'.length)}build/`);
  return entries.filter((entry) =>
    buildDirs.some((dir) => entry.startsWith(dir) && NODE_GYP_OUTPUT.test(entry.slice(dir.length))),
  );
}

/** Filter a bundle entry listing down to the build-only package files to strip. */
export function filterBuildOnlyEntries(entries: string[]): string[] {
  return entries.filter((entry) => BUILD_ONLY_ENTRY.test(entry));
}

/** Listing a 12k-entry bundle exceeds execFileSync's 1 MB default buffer. */
const MAX_LIST_BUFFER = 64 * 1024 * 1024;

/** `zip -d` argv batch size — stays clear of ARG_MAX with long entry names. */
const DELETE_BATCH = 200;
const COMMAND_TIMEOUT_MS = 300_000;
const packageIdentity = z.object({ name: z.string(), version: z.string() });

function listEntries(bundle: string): string[] {
  return execFileSync('unzip', ['-Z1', bundle], {
    encoding: 'utf-8',
    maxBuffer: MAX_LIST_BUFFER,
    timeout: COMMAND_TIMEOUT_MS,
  })
    .split('\n')
    .filter((line) => line.length > 0);
}

function run(cmd: string, args: string[], cwd?: string): void {
  execFileSync(cmd, args, { cwd, stdio: 'inherit', timeout: COMMAND_TIMEOUT_MS });
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function appendDuckDbBindings(bundle: string, scratch: string): void {
  const bindings = readDuckDbBindings();
  /**
   * npm verifies each tarball against registry integrity metadata. Packing a registry
   * spec fetches other platforms without installing them or resolving their dependencies.
   */
  run(
    'npm',
    [
      'pack',
      '--ignore-scripts',
      '--silent',
      '--fetch-retries=1',
      '--fetch-timeout=60000',
      '--',
      ...bindings.map(({ name, version }) => `${name}@${version}`),
    ],
    scratch,
  );

  const archivedFiles: string[] = [];
  for (const { name, version, directory, runtimeFiles } of bindings) {
    const tarball = join(scratch, `${name.slice(1).replace('/', '-')}-${version}.tgz`);
    const target = join(scratch, directory);
    const files = [...runtimeFiles, 'LICENSE', 'README.md'];
    mkdirSync(target, { recursive: true });
    run('tar', [
      '-xzf',
      tarball,
      '--strip-components=1',
      '-C',
      target,
      ...files.map((file) => `package/${file}`),
    ]);
    for (const file of files) {
      if (!lstatSync(join(target, file)).isFile()) {
        throw new Error(`${name}@${version} contains a non-file entry at ${file}.`);
      }
      archivedFiles.push(`${directory}/${file}`);
    }
    const metadata = packageIdentity.parse(
      JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')),
    );
    if (metadata.name !== name || metadata.version !== version) {
      throw new Error(
        `Expected ${name}@${version}, received ${metadata.name}@${metadata.version}.`,
      );
    }
  }
  run('zip', ['-q', bundle, ...archivedFiles], scratch);
}

function main(): void {
  const bundleArg = process.argv[2];
  if (!bundleArg) throw new Error('Usage: clean-mcpb.ts <bundle.mcpb> — run after `mcpb pack`.');
  const original = resolve(bundleArg);
  if (!existsSync(original)) throw new Error(`No bundle at ${original} — run \`mcpb pack\` first.`);

  const sizeBefore = statSync(original).size;
  // Stage beside the output so a failed fetch or validation leaves the packed file intact.
  const scratch = mkdtempSync(join(dirname(original), '.mcpb-clean-'));
  const bundle = join(scratch, basename(original));
  try {
    copyFileSync(original, bundle);
    run('npx', ['-y', '@anthropic-ai/mcpb', 'clean', bundle]);

    const entries = listEntries(bundle);
    const agentDocs = filterAgentDocEntries(entries);
    const nodeGyp = filterNodeGypBuildEntries(entries);
    const buildOnly = filterBuildOnlyEntries(entries);
    const oldBindings = entries.filter((entry) =>
      entry.startsWith('node_modules/@duckdb/node-bindings-'),
    );
    // An entry in two classes is named once: a `zip -d` batch naming only deleted entries exits 12.
    const doomed = [...new Set([...agentDocs, ...nodeGyp, ...buildOnly, ...oldBindings])];
    for (let i = 0; i < doomed.length; i += DELETE_BATCH) {
      run('zip', ['-q', '-d', '-nw', bundle, ...doomed.slice(i, i + DELETE_BATCH)]);
    }
    appendDuckDbBindings(bundle, scratch);

    const remainingEntries = listEntries(bundle);
    const remaining = [
      ...filterAgentDocEntries(remainingEntries),
      ...filterNodeGypBuildEntries(remainingEntries),
      ...filterBuildOnlyEntries(remainingEntries),
    ];
    if (remaining.length > 0) {
      throw new Error(
        `${remaining.length} entries still present after strip:\n${remaining.join('\n')}`,
      );
    }
    const missing = missingDuckDbBindingEntries(remainingEntries);
    if (missing.length > 0) {
      throw new Error(`Missing DuckDB runtime entries:\n${missing.join('\n')}`);
    }
    const sizeAfter = statSync(bundle).size;
    renameSync(bundle, original);
    console.log(
      `Bundle cleaned: ${mb(sizeBefore)} → ${mb(sizeAfter)} ` +
        `(${agentDocs.length} agent-doc, ${nodeGyp.length} node-gyp build, ` +
        `${buildOnly.length} build-only entries stripped, all DuckDB platform bindings included).`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`✗ Bundle cleaning failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
