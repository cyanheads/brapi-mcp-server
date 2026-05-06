# Agent Protocol

**Server:** brapi-mcp-server
**Version:** 0.5.3
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## What's Next?

When the user asks what to do next, what's left, or needs direction, suggest relevant options based on the current project state:

1. **Re-run the `setup` skill** — ensures AGENTS.md, skills, structure, and metadata are populated and up to date with the current codebase
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

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. The framework catches, classifies, and formats. Default to typed contracts: declare `errors: [...]` and throw via `ctx.fail(reason, …)` so failures carry stable `data.reason` codes for agent-client routing. Fall back to error factories (`notFound()`, `validationError()`, etc.) only for services or when no contract entry fits.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit` / `ctx.sample`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.

---

## Patterns

### Tool — connection bootstrap

`brapi_connect` is the session handshake. It registers the BrAPI server under a named alias, forces a capability refresh, and inlines the full orientation envelope so one call orients the agent. `baseUrl` and `auth` are both `optional()` — when omitted, `resolveConnectInput` fills them from `BRAPI_<ALIAS>_*` then `BRAPI_DEFAULT_*` env vars, so credentials never enter the LLM context. Same envelope is available on-demand via `brapi_server_info`.

```ts
// src/mcp-server/tools/definitions/brapi-connect.tool.ts (abbreviated)
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { resolveConnectInput } from '@/config/alias-credentials.js';
import { ConnectAuthSchema } from '../shared/connect-auth-schema.js';

export const brapiConnect = tool('brapi_connect', {
  description: 'Connect to a BrAPI v2 server… baseUrl + auth fall back to BRAPI_<ALIAS>_* / BRAPI_DEFAULT_* env vars when omitted.',
  annotations: { openWorldHint: true, readOnlyHint: false, idempotentHint: true },
  errors: [
    { reason: 'auth_token_exchange_failed', code: JsonRpcErrorCode.Forbidden,
      when: 'SGN or OAuth token exchange against /token failed',
      recovery: 'Verify the credentials and that the server exposes /token before retrying.' },
    { reason: 'auth_no_access_token', code: JsonRpcErrorCode.Forbidden,
      when: 'Token endpoint responded but did not return an access_token',
      recovery: 'Confirm the credentials are valid and the IdP issues access tokens for this grant.' },
  ] as const,
  input: z.object({
    baseUrl: z.string().url().optional().describe('Falls back to BRAPI_<ALIAS>_BASE_URL → BRAPI_DEFAULT_BASE_URL.'),
    auth: ConnectAuthSchema.optional().describe('Falls back to env-derived credentials.'),
    alias: z.string().regex(/^[a-zA-Z0-9_-]+$/).default('default'),
  }),
  output: OrientationEnvelopeSchema,
  async handler(input, ctx) {
    const resolved = resolveConnectInput(input.alias, { baseUrl: input.baseUrl, auth: input.auth });
    const connection = await getServerRegistry().register(ctx, {
      alias: input.alias, baseUrl: resolved.baseUrl, auth: resolved.auth,
    });
    await getCapabilityRegistry().invalidate(connection.baseUrl, ctx);
    return buildOrientationEnvelope(ctx, connection, { registry: getCapabilityRegistry(), client: getBrapiClient() });
  },
  format: (result) => [{ type: 'text', text: formatOrientationEnvelope(result) }],
});
```

### Tool — find with dataframe spillover

`find_*` tools share a pattern: pull one page capped at `loadLimit`, compute distributions across the returned rows, and if the upstream total exceeds `loadLimit` materialize the full union as a canvas dataframe and return a handle. Spilled rows live in DuckDB only — there is no parallel JSON store. Canvas is mandatory: startup fails closed when `core.canvas` is undefined.

```ts
// src/mcp-server/tools/definitions/brapi-find-germplasm.tool.ts (abbreviated)
export const brapiFindGermplasm = tool('brapi_find_germplasm', {
  description:
    'Find germplasm by name, synonym, accession, PUI, crop, or free-text. Spills to a canvas dataframe when the upstream total exceeds loadLimit — query with brapi_dataframe_query (SQL).',
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
    const bridge = getCanvasBridge();

    const filters = mergeFilters(/* named + extraFilters */, warnings);
    const firstPage = await loadInitialPage(client, connection, '/germplasm', filters, loadLimit, ctx);

    const { fullRows, dataframe } = await maybeSpill({
      firstPage, client, connection, bridge,
      path: '/germplasm', filters, source: 'find_germplasm', loadLimit, ctx,
    });
    return { /* results + distributions + refinementHint + dataframe? */ };
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
  loadLimit: z.coerce.number().int().positive().default(1_000),
  maxConcurrentRequests: z.coerce.number().int().positive().default(4),
  retryMaxAttempts: z.coerce.number().int().min(0).default(3),
  datasetTtlSeconds: z.coerce.number().int().positive().default(86_400),
  referenceCacheTtlSeconds: z.coerce.number().int().positive().default(3_600),
  sessionIsolation: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
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

**Per-alias credentials** live in `src/config/alias-credentials.ts`. `readAliasCredentials(alias)` reads `BRAPI_<ALIAS>_*` (uppercased, hyphens → underscores), `deriveAuthFromCredentials(creds)` derives the auth mode from which fields are set (USERNAME+PASSWORD → `sgn`; BEARER_TOKEN → `bearer`; API_KEY → `api_key`; OAUTH_CLIENT_ID+SECRET → `oauth2`; mixing families raises `ValidationError`), and `resolveConnectInput(alias, agentInput)` layers agent input → alias env → default env → no-auth fallback.

---

## Context

Handlers receive a unified `ctx` object. Currently used surface:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.state` | Tenant-scoped KV — used by `ServerRegistry` (connection aliases), `CanvasBridge` (default canvas pointer + per-table provenance), and `CapabilityRegistry` (cached profiles). Spilled `find_*` rows live on the canvas (DuckDB), not in `ctx.state`. |
| `ctx.sessionId` | Mcp-Session-Id (HTTP stateful/auto); `undefined` for stdio and stateless HTTP unless `exposeStatelessSessionId` is opted in. Composed into `ServerRegistry.connKey` and `CanvasBridge.defaultCanvasKey` when `BRAPI_SESSION_ISOLATION=true` (default), so concurrent HTTP sessions in the same tenant don't share connection state or canvas. Discovery / scoping key on top of tenant-keyed state — not an authorization principal. |
| `ctx.signal` | `AbortSignal` — threaded into every BrAPI HTTP call so client-side cancellation aborts the upstream request. |
| `ctx.requestId` | Unique request ID — auto-attached to every `ctx.log` entry. |
| `ctx.tenantId` | Tenant ID from JWT or `'default'` for stdio / HTTP+`auth=none` — outer scope on all `ctx.state` reads/writes. |

`ctx.elicit` is used by `brapi_submit_observations` to gate apply-mode writes behind user confirmation (with explicit `force: true` as the bypass). `ctx.sample` and `ctx.progress` are not used yet — they'll show up when long-running workflows (pedigree traversal, genotype-call pulls) need progress reporting or LLM sampling. `ctx.fail(reason, …)` is the typed thrower keyed off declared `errors[]` contracts — used by 8 tools and 3 resources today. `ctx.recoveryFor(reason)` resolves the matching contract entry's recovery hint into `data.recovery.hint` so it surfaces on the wire.

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Default for new tools: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` to receive a typed `ctx.fail(reason, …)` keyed by the declared reason union. TypeScript catches `ctx.fail('typo')` at compile time, `data.reason` is auto-populated for observability, and the linter enforces conformance against the handler body. The `recovery` field is required descriptive metadata (≥ 5 words, lint-validated); to surface it on the wire, spread `...ctx.recoveryFor('reason')` into `data` or pass an explicit `{ recovery: { hint: '...' } }` when runtime context matters. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and don't need declaring. Live across the BrAPI surface today: `brapi_connect`, `brapi_dataframe_query`, `brapi_describe_filters`, `brapi_find_genotype_calls`, `brapi_get_germplasm`, `brapi_get_image`, `brapi_get_study`, `brapi_raw_get`, `brapi_raw_search`, `brapi_submit_observations`, plus the `brapi://study/{studyDbId}`, `brapi://germplasm/{germplasmDbId}`, and `brapi://filters/{endpoint}` resources.

```ts
errors: [
  { reason: 'unknown_alias', code: JsonRpcErrorCode.NotFound,
    when: 'No connection registered for this alias',
    recovery: 'Call brapi_connect with this alias before retrying.' },
],
async handler(input, ctx) {
  const conn = registry.peek(input.alias);
  if (!conn) throw ctx.fail('unknown_alias', `No connection for ${input.alias}`,
    { ...ctx.recoveryFor('unknown_alias') });
  // ...
}
```

**Declare contracts inline on each tool, even when similar across tools.** The contract is part of the tool's documented public surface — reading one tool definition file should give the full picture (input, output, errors, handler, format). Don't extract a shared `errors[]` constant or contract module to deduplicate near-identical entries; per-tool repetition is the intended cost of locality, and dynamic `recovery` hints often need tool-specific runtime context anyway.

**Fallback (no contract entry fits, services, prototype tools):** throw via factories or plain `Error`.

```ts
// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// Error factories — explicit code, concise
import { notFound, validationError, internalError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// McpError — full control over code and data
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.DatabaseError, 'Connection failed', { pool: 'primary' });
```

Available factories include `notFound`, `validationError`, `forbidden`, `unauthorized`, `serviceUnavailable`, `rateLimited`, `timeout`, `conflict`, `internalError`, `serializationError`, `databaseError`, `configurationError`, `invalidParams`, `invalidRequest`. See framework CLAUDE.md for the full auto-classification table and the `api-errors` skill for contract patterns.

---

## Structure

```text
src/
  index.ts                                # createApp() entry point — registers 21 tools, 5 resources, 2 prompts; inits 7 services
  config/
    server-config.ts                      # BRAPI_* env vars (Zod schema, lazy-parsed)
    alias-credentials.ts                  # Per-alias env-var resolution (BRAPI_<ALIAS>_*) for brapi_connect
  services/
    brapi-client/                         # HTTP client — retry, concurrency cap, async-search poll, private-IP guard, binary fetch, POST/PUT
    brapi-dialect/                        # Per-server filter / payload adapters (spec, cassavabase) — translates plural→singular, drops searchText, declares known-dead POST /search routes; envelope surfaces id + source + disabled-search nouns
    brapi-filters/                        # Static v2.1 filter catalog
    canvas-bridge/                        # Default-canvas resolver (per-session when BRAPI_SESSION_ISOLATION=true; per-tenant otherwise), df_<uuid> table generator, provenance store
    capability-registry/                  # Per-connection /serverinfo cache + call guard
    ontology-resolver/                    # Free-text → ontology-term matcher for variables
    reference-data-cache/                 # Programs / trials / locations / crops lookup cache
    server-registry/                      # Alias → live connection map with auth resolution; session-scoped under BRAPI_SESSION_ISOLATION=true
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
        brapi-find-genotype-calls.tool.ts # Async-search genotype calls with maxCalls cap + dataframe spillover
        brapi-dataframe-describe.tool.ts  # List / describe canvas dataframes with columns, row counts, provenance
        brapi-dataframe-query.tool.ts     # Run SQL across canvas dataframes (SELECT only); typed columns response
        brapi-dataframe-drop.tool.ts      # Drop a dataframe by name (opt-in via BRAPI_CANVAS_DROP_ENABLED)
        brapi-dataframe-export.tool.ts    # Write CSV/Parquet/JSON to BRAPI_EXPORT_DIR (opt-in, stdio-only)
        brapi-submit-observations.tool.ts # Two-phase observation write — preview / apply (POST + PUT) with elicit gate
        brapi-raw-get.tool.ts             # Last-resort GET passthrough with routing nudge
        brapi-raw-search.tool.ts          # Last-resort POST /search passthrough with async polling
      shared/
        connect-auth-schema.ts            # Tagged-union auth input
        orientation-envelope.ts           # Shared envelope builder + formatter
        find-helpers.ts                   # Alias / loadLimit / extraFilters fragments, mergeFilters, maybeSpill, DataframeHandleSchema
        raw-routing-hints.ts              # Routing nudges emitted by raw_get / raw_search when a curated tool exists
    resources/
      definitions/
        brapi-server-info.resource.ts     # brapi://server/info — orientation envelope (default connection)
        brapi-calls.resource.ts           # brapi://calls — raw capability profile
        brapi-study.resource.ts           # brapi://study/{studyDbId} — single study with FKs
        brapi-germplasm.resource.ts       # brapi://germplasm/{germplasmDbId} — single germplasm with attributes + parents
        brapi-filters.resource.ts         # brapi://filters/{endpoint} — filter catalog
    prompts/
      definitions/
        brapi-eda-study.prompt.ts         # EDA playbook for one study (orient → variables → coverage → outliers → report)
        brapi-meta-analysis.prompt.ts     # Cross-study meta-analysis (resolve trait → discover studies → harmonize → summarize)
```

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

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, Codex: `.codex/skills/`, shared: `.agents/skills/`, others: equivalent). This makes skills available as context without needing to reference `skills/` paths manually. After framework updates, run the `maintenance` skill — it re-syncs the agent directory automatically (Phase B).

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
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
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

**Runtime:** Scripts and the production entry point use Bun directly — Bun executes TypeScript natively, no `tsx` shim. The `packageManager` field pins the version.

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
| `bun run start` | Production mode — defers transport selection to `MCP_TRANSPORT_TYPE` (stdio default) |
| `bun run start:stdio` | Production mode (stdio) — requires prior `bun run build` |
| `bun run start:http` | Production mode (HTTP) — requires prior `bun run build` |
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
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Codex → `structuredContent`, Codex Desktop → `content[]`); both must carry the same data
- [ ] BrAPI tool: resolves connection via `ServerRegistry.get(ctx, alias ?? DEFAULT_ALIAS)` before touching the client
- [ ] BrAPI tool: gates the call with `CapabilityRegistry.ensure(...)` — never fires against an endpoint the server didn't advertise
- [ ] BrAPI tool: raw / domain / output schemas reviewed against real upstream sparsity (most `/germplasm` and `/studies` fields are optional in the wild)
- [ ] BrAPI tool: normalization and `format()` preserve uncertainty — never fabricate missing IDs, names, or counts
- [ ] BrAPI tool with dataframe spillover: rows beyond `loadLimit` materialize as a `df_<uuid>` canvas table via `CanvasBridge.registerDataframe`, handle surfaces in `result.dataframe`, `hasMore` set correctly
- [ ] Tests include at least one sparse upstream payload (fields omitted) alongside the happy path
- [ ] Registered in the `tools` array of `createApp()` in `src/index.ts`
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `bun run devcheck` passes
