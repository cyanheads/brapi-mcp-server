# Agent Protocol

**Server:** brapi-mcp-server
**Version:** 0.3.0
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## What's Next?

When the user asks what to do next, what's left, or needs direction, suggest relevant options based on the current project state:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit` / `ctx.sample`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.

---

## Patterns

### Tool — connection bootstrap

`brapi_connect` is the session handshake. It registers the BrAPI server under a named alias, forces a capability refresh, and inlines the full orientation envelope so one call orients the agent. The same shape is available on-demand via `brapi_server_info`.

```ts
// src/mcp-server/tools/definitions/brapi-connect.tool.ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { getBrapiClient } from '@/services/brapi-client/index.js';
import { getCapabilityRegistry } from '@/services/capability-registry/index.js';
import { getServerRegistry } from '@/services/server-registry/index.js';
import { ConnectAuthSchema } from '../shared/connect-auth-schema.js';
import {
  buildOrientationEnvelope,
  formatOrientationEnvelope,
  OrientationEnvelopeSchema,
} from '../shared/orientation-envelope.js';

export const brapiConnect = tool('brapi_connect', {
  description:
    'Connect to a BrAPI v2 server, authenticate, cache the capability profile, and return the full orientation envelope inline. Must be called before any other BrAPI tool. Supports multiple concurrent connections via named aliases.',
  annotations: { openWorldHint: true, readOnlyHint: false, idempotentHint: true },
  input: z.object({
    baseUrl: z.string().url().describe('BrAPI v2 base URL including any path prefix.'),
    auth: ConnectAuthSchema.default({ mode: 'none' }),
    alias: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .default('default')
      .describe('Alias for this connection.'),
  }),
  output: OrientationEnvelopeSchema,
  async handler(input, ctx) {
    const registry = getServerRegistry();
    const capabilities = getCapabilityRegistry();
    const client = getBrapiClient();
    const connection = await registry.register(ctx, input);
    await capabilities.invalidate(connection.baseUrl, ctx);
    return buildOrientationEnvelope(ctx, connection, { registry: capabilities, client });
  },
  format: (result) => [{ type: 'text', text: formatOrientationEnvelope(result) }],
});
```

### Tool — find with dataset spillover

`find_*` tools share a pattern: pull one page capped at `loadLimit`, compute distributions across the returned rows, and if the upstream total exceeds `loadLimit` spill the full union into `DatasetStore` and return a handle.

```ts
// src/mcp-server/tools/definitions/brapi-find-germplasm.tool.ts (abbreviated)
export const brapiFindGermplasm = tool('brapi_find_germplasm', {
  description:
    'Find germplasm by name, synonym, accession, PUI, crop, or free-text. Returns a dataset handle when the upstream total exceeds loadLimit.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    alias: AliasInput,
    names: z.array(z.string()).optional(),
    crops: z.array(z.string()).optional(),
    text: z.string().optional(),
    loadLimit: LoadLimitInput,
    extraFilters: ExtraFiltersInput,
  }),
  output: OutputSchema,
  async handler(input, ctx) {
    const connection = await getServerRegistry().get(ctx, input.alias ?? DEFAULT_ALIAS);
    await getCapabilityRegistry().ensure(connection.baseUrl, { service: 'germplasm', method: 'GET' }, ctx);

    const filters = mergeFilters(/* named + extraFilters */, warnings);
    const firstPage = await loadInitialPage(client, connection, '/germplasm', filters, loadLimit, ctx);

    if (firstPage.hasMore && firstPage.totalCount > loadLimit) {
      const spill = await spillToDataset({ /* persists union into DatasetStore */ });
      // ... attach dataset handle to result
    }
    return { /* results + distributions + refinementHint + dataset? */ };
  },
  format: (result) => [{ type: 'text', text: renderFindResult(result) }],
});
```

### Server config

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  defaultBaseUrl: z.string().url().optional(),
  loadLimit: z.coerce.number().int().positive().default(200),
  maxConcurrentRequests: z.coerce.number().int().positive().default(4),
  retryMaxAttempts: z.coerce.number().int().min(0).default(3),
  datasetTtlSeconds: z.coerce.number().int().positive().default(86_400),
  referenceCacheTtlSeconds: z.coerce.number().int().positive().default(3_600),
  // …see src/config/server-config.ts for the full schema
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    defaultBaseUrl: 'BRAPI_DEFAULT_BASE_URL',
    loadLimit: 'BRAPI_LOAD_LIMIT',
    maxConcurrentRequests: 'BRAPI_MAX_CONCURRENT_REQUESTS',
    retryMaxAttempts: 'BRAPI_RETRY_MAX_ATTEMPTS',
    datasetTtlSeconds: 'BRAPI_DATASET_TTL_SECONDS',
    referenceCacheTtlSeconds: 'BRAPI_REFERENCE_CACHE_TTL_SECONDS',
  });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so validation errors name the actual variable (`BRAPI_LOAD_LIMIT`) rather than the internal path (`loadLimit`). It throws a `ConfigurationError` the framework catches and prints as a clean startup banner.

---

## Context

Handlers receive a unified `ctx` object. Currently used surface:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.state` | Tenant-scoped KV — used by `ServerRegistry` (connection aliases), `DatasetStore` (spilled `find_*` results), and `CapabilityRegistry` (cached profiles). |
| `ctx.signal` | `AbortSignal` — threaded into every BrAPI HTTP call so client-side cancellation aborts the upstream request. |
| `ctx.requestId` | Unique request ID — auto-attached to every `ctx.log` entry. |
| `ctx.tenantId` | Tenant ID from JWT or `'default'` for stdio — scopes all `ctx.state` reads/writes. |

`ctx.elicit`, `ctx.sample`, and `ctx.progress` are not used yet — they'll show up when write tools (`brapi_submit_observations`) and long-running workflows (pedigree traversal, genotype-call pulls) land.

---

## Errors

Handlers throw — the framework catches, classifies, and formats. Three escalation levels:

```ts
// 1. Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// 2. Error factories — explicit code, concise
import { notFound, validationError, forbidden, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// 3. McpError — full control over code and data
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.DatabaseError, 'Connection failed', { pool: 'primary' });
```

Plain `Error` is fine for most cases. Use factories when the error code matters. See framework CLAUDE.md for the full auto-classification table and all available factories.

---

## Structure

```text
src/
  index.ts                                # createApp() entry point — registers 18 tools, inits 7 services
  config/
    server-config.ts                      # BRAPI_* env vars (Zod schema, lazy-parsed)
  services/
    brapi-client/                         # HTTP client — retry, concurrency cap, async-search poll, private-IP guard, binary fetch
    brapi-filters/                        # Static v2.1 filter catalog
    capability-registry/                  # Per-connection /serverinfo cache + call guard
    dataset-store/                        # Tenant-scoped handles for spilled find_* results
    ontology-resolver/                    # Free-text → ontology-term matcher for variables
    reference-data-cache/                 # Programs / trials / locations / crops lookup cache
    server-registry/                      # Alias → live connection map with auth resolution
  mcp-server/
    tools/
      definitions/
        brapi-connect.tool.ts             # Session bootstrap — auth, capability load, orientation envelope
        brapi-server-info.tool.ts         # Orientation envelope on demand
        brapi-describe-filters.tool.ts    # Static BrAPI v2.1 filter catalog lookup
        brapi-find-studies.tool.ts        # find_* — studies, distributions + spillover
        brapi-get-study.tool.ts           # get_* — study + FK resolution + companion counts
        brapi-find-germplasm.tool.ts      # find_* — germplasm
        brapi-get-germplasm.tool.ts       # get_* — germplasm + attributes + parents + companion counts
        brapi-walk-pedigree.tool.ts       # BFS DAG walk (ancestors / descendants / both) with cycle detection
        brapi-find-variables.tool.ts      # find_* — observation variables, free-text ranking via OntologyResolver
        brapi-find-observations.tool.ts   # find_* — observation records
        brapi-find-images.tool.ts         # find_* — image metadata
        brapi-get-image.tool.ts           # Fetch image bytes inline (imagecontent → imageURL fallback)
        brapi-find-locations.tool.ts      # find_* — locations, optional client-side bbox filter
        brapi-find-variants.tool.ts       # find_* — variants, 1-based inclusive/exclusive genomic region
        brapi-find-genotype-calls.tool.ts # Async-search genotype calls with maxCalls cap + spillover
        brapi-manage-dataset.tool.ts      # Dataset lifecycle — list / summary / load / delete
        brapi-raw-get.tool.ts             # Last-resort GET passthrough with routing nudge
        brapi-raw-search.tool.ts          # Last-resort POST /search passthrough with async polling
      shared/
        connect-auth-schema.ts            # Tagged-union auth input
        orientation-envelope.ts           # Shared envelope builder + formatter
        find-helpers.ts                   # Alias / loadLimit / extraFilters fragments, mergeFilters, maybeSpill, DatasetHandleSchema
        raw-routing-hints.ts              # Routing nudges emitted by raw_get / raw_search when a curated tool exists
```

No resources or prompts yet — `find_*` tools expose the dataset surface via handles.

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-docs.tool.ts` |
| Tool/resource/prompt names | snake_case | `search_docs` |
| Directories | kebab-case | `src/services/doc-search/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search items by query and filter.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). This makes skills available as context without needing to reference `skills/` paths manually. After framework updates, run the `maintenance` skill — it re-syncs the agent directory automatically (Phase B).

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling |
| `api-workers` | Cloudflare Workers runtime |

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use `tsx` — both `npm run <cmd>` and `bun run <cmd>` work. Prefer `bun` (declared in `packageManager`).

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run tree` | Generate `docs/tree.md` |
| `bun run format` | Auto-fix formatting via Biome |
| `bun run lint:mcp` | Validate MCP tool / resource / prompt definitions against the spec |
| `bun run test` | Vitest suite |
| `bun run dev:stdio` | Dev mode (stdio, hot-reload) |
| `bun run dev:http` | Dev mode (HTTP, hot-reload) |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/<minor>.x/` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |

---

## Changelog

Directory-based, grouped by minor series using the `.x` semver-wildcard convention. Source of truth is `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per released version, shipped in the npm package. At release time, author the per-version file with a concrete version and date, then run `npm run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited, never renamed, never moved. Read it to remember the frontmatter + section layout when scaffolding a new per-version file. `CHANGELOG.md` is a **navigation index** (header + link + one-line summary per version), regenerated by `npm run changelog:build`. Devcheck hard-fails on drift. Never hand-edit `CHANGELOG.md`.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: One-line headline, ≤250 chars  # required — powers the rollup index
breaking: false                          # optional — true flags breaking changes
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge in the rollup — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames).

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getMyService } from '@/services/my-domain/my-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When schema-level regex/length matters, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage — no `console`, no direct persistence access
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] BrAPI tool: resolves connection via `ServerRegistry.get(ctx, alias ?? DEFAULT_ALIAS)` before touching the client
- [ ] BrAPI tool: gates the call with `CapabilityRegistry.ensure(...)` — never fires against an endpoint the server didn't advertise
- [ ] BrAPI tool: raw / domain / output schemas reviewed against real upstream sparsity (most `/germplasm` and `/studies` fields are optional in the wild)
- [ ] BrAPI tool: normalization and `format()` preserve uncertainty — never fabricate missing IDs, names, or counts
- [ ] BrAPI tool with dataset spillover: rows beyond `loadLimit` persist via `DatasetStore`, handle surfaces in `result.dataset`, `hasMore` set correctly
- [ ] Tests include at least one sparse upstream payload (fields omitted) alongside the happy path
- [ ] Registered in the `tools` array of `createApp()` in `src/index.ts`
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `bun run devcheck` passes
