# brapi-mcp-server — Design

## MCP Surface

### Tools

Prefix `brapi_` throughout. Organized by domain.

**Connection & discovery**

| Name | Description | Key inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `brapi_connect` | Connect to a BrAPI v2 server, authenticate, cache the capability profile, and return the full `server_info` orientation envelope inline — one call bootstraps the session (see **Response companions**). Must be called first; subsequent tools route through the cached profile. | `baseUrl`, `auth?` (tagged union: `sgn`, `oauth2`, `api_key`, `none`), `alias?` | `openWorldHint: true` |
| `brapi_server_info` | Full orientation envelope for the active connection — identity (name, version, baseUrl, BrAPI version), auth status, capability profile (supported/missing calls + notable gaps), content summary (common crops, cheap program/study/germplasm/location counts when available), and server-specific notes. Designed so one call fully orients an agent; it's the primary handshake after `brapi_connect`. | — | `readOnlyHint: true` |
| `brapi_describe_filters` | List valid filter names for a given BrAPI endpoint — powers dynamic discovery before constructing `extraFilters` on `find_*` tools. Returns a filter catalog with name, type, description, and example per filter. Cached per connection via `CapabilityRegistry`. | `endpoint` (`studies`/`germplasm`/`variables`/`observations`/`images`/`variants`/`locations`/...) | `readOnlyHint: true` |

**Studies & trials**

| Name | Description | Key inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `brapi_find_studies` | Locate studies matching criteria — crop, trial type, season, location, program, date range, free text. Enriches with program/trial/location context in one call. Returns a dataset handle when rows exceed `loadLimit`. | `crop?`, `trialType?`, `seasons?`, `locations?`, `programs?`, `dateFrom?/dateTo?`, `text?`, `loadLimit?` | `readOnlyHint: true` |
| `brapi_get_study` | Fetch a single study with program, trial, location, observation variables, and observation-unit counts all resolved. | `studyDbId` | `readOnlyHint: true` |

**Germplasm**

| Name | Description | Key inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `brapi_find_germplasm` | Find germplasm by name, synonym, accession number, attribute, or free text. Matches across registered synonyms. | `text?`, `names?`, `attributes?`, `germplasmPUI?`, `loadLimit?` | `readOnlyHint: true` |
| `brapi_get_germplasm` | Fetch a single germplasm with attributes and direct parents. | `germplasmDbId` | `readOnlyHint: true` |
| `brapi_walk_pedigree` | Workflow: walk ancestry or descendancy across multiple generations, returning a DAG (nodes + edges — a cultivar may appear on multiple paths). BrAPI only gives direct parents per call; this tool handles traversal, deduplication, and depth limits. | `germplasmDbId`, `direction` (ancestors/descendants/both), `maxDepth?` (default 3) | `readOnlyHint: true` |

**Phenotyping**

| Name | Description | Key inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `brapi_find_variables` | Find observation variables (traits) by name, trait class, ontology term, or free-text query. When the server exposes ontology metadata, free-text queries resolve to ontology URIs (CO_*, TO_*) via the `OntologyResolver` service; otherwise falls back to substring match. | `text?`, `traitClass?`, `studyDbId?`, `ontologyDbId?`, `loadLimit?` | `readOnlyHint: true` |
| `brapi_find_observations` | Pull observation records filtered by study, germplasm, variable, season, or observation unit. Returns a dataset handle when rows exceed `loadLimit`; inspect via `brapi_manage_dataset`. | `studyDbIds?`, `germplasmDbIds?`, `observationVariableDbIds?`, `seasons?`, `loadLimit?` | `readOnlyHint: true` |
| `brapi_find_images` | Filter images by observation unit, study, descriptor, or physical properties (dimensions, MIME). Returns metadata; use `brapi_get_image` to fetch bytes. | `observationUnitDbIds?`, `studyDbIds?`, `minWidth?`, `minHeight?`, `imageFileName?`, `loadLimit?` | `readOnlyHint: true` |
| `brapi_get_image` | Fetch image bytes for up to 5 `imageDbIds` in one call (hard per-call cap — prevents context explosion). Each is returned as a base64-encoded PNG/JPEG `type: image` content block with no filesystem side-effects. Use `brapi_find_images` first to locate candidates. | `imageDbIds` (array, max 5) | `readOnlyHint: true`, `idempotentHint: true` |

**Genotyping**

| Name | Description | Key inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `brapi_find_variants` | Find variant sets and variants by reference, study, or genomic region. | `variantSetDbId?`, `referenceName?`, `start?`, `end?`, `loadLimit?` | `readOnlyHint: true` |
| `brapi_find_genotype_calls` | Fetch genotype calls for a set of germplasm across a variant set. Handles BrAPI's `searchResultsDbId` async polling transparently. Default cap of 100,000 calls; override via `maxCalls` or route large pulls through `DatasetStore` for export. | `variantSetDbId`, `germplasmDbIds?`, `variantDbIds?`, `callFormat?`, `maxCalls?` | `readOnlyHint: true` |

**Locations**

| Name | Description | Key inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `brapi_find_locations` | Find research stations / field sites by country, abbreviation, type, or bounding box. | `countryCode?`, `locationType?`, `bbox?`, `text?`, `loadLimit?` | `readOnlyHint: true` |

**Write operations**

| Name | Description | Key inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `brapi_submit_observations` | Submit new or updated observations. Default `mode: 'preview'` validates + returns row counts; `mode: 'apply'` elicits confirmation, then writes. Rows carrying an `observationDbId` are routed to PUT (update); rows without one are POSTed (create). | `studyDbId`, `observations[]`, `mode` (preview/apply) | `destructiveHint: false` (additive) |

**Dataset management**

| Name | Description | Key inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `brapi_manage_dataset` | Consolidated dataset lifecycle. Modes: `list` (enumerate with provenance), `summary` (columns, row count, size, original query), `load` (page + column-select into context), `export` (generate download URL for CSV/Parquet), `delete`. | `mode`, `datasetId?`, `page?`, `columns?`, `format?` | Per-mode; `delete` destructive |

**Escape hatches** — last resort, prefer goal-shaped tools above

| Name | Description | Key inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `brapi_raw_get` | Passthrough to any BrAPI `GET /{path}` endpoint the goal-shaped tools don't cover (e.g. `/samples`, `/methods`, `/scales`, `/crosses`). Returns the raw upstream response envelope. Prefer `find_*`/`get_*` tools when applicable — they enrich results and resolve FKs; this tool does not. | `path`, `params?`, `pageToken?` | `readOnlyHint: true`, `openWorldHint: true` |
| `brapi_raw_search` | Passthrough to any BrAPI `POST /search/{noun}` endpoint with async polling handled transparently. Same preference guidance as `brapi_raw_get`. | `noun`, `filters`, `asyncPollTimeoutMs?` | `readOnlyHint: true`, `openWorldHint: true` |

> **Dynamic filter discovery + passthrough.** Every `find_*` tool accepts an optional `extraFilters?: Record<string, unknown>` — a catch-all forwarded verbatim to the upstream endpoint. Use `brapi_describe_filters` (or the paired `brapi://filters/{endpoint}` resource) to discover valid filter names for an endpoint before constructing the map. Named params (e.g. `crop`, `seasons`, `trialType` on `find_studies`) cover the common, validated cases; `extraFilters` handles server-specific or less-common BrAPI filters without a code change. Named params win on conflict and the handler surfaces a warning. On upstream 400, the full response body is preserved so the agent can self-correct.

### Resources

| URI template | Description | Pagination |
|:-------------|:------------|:-----------|
| `brapi://server/info` | Current connection summary + capability profile | — |
| `brapi://study/{studyDbId}` | Stable URI for a study (enriched form) | — |
| `brapi://germplasm/{germplasmDbId}` | Stable URI for a germplasm | — |
| `brapi://dataset/{datasetId}` | Dataset metadata (not full payload) | — |
| `brapi://calls` | Server capability profile | — |
| `brapi://filters/{endpoint}` | Filter catalog for a BrAPI endpoint (name/type/description/example per filter) | — |

Tool-only clients lose nothing. Primary entities (study, germplasm) have dedicated `get_*` tools; `brapi://dataset/{datasetId}` pairs with `brapi_manage_dataset` (`mode: 'summary'`); `brapi://filters/{endpoint}` pairs with `brapi_describe_filters`; `brapi://server/info` and `brapi://calls` pair with `brapi_server_info`. Reference data (locations) is reachable via `brapi_find_locations` with an ID filter; niche lookups (trials, programs, samples, methods, scales, crosses) route through `brapi_raw_get`. Resources are additive for clients that render them — no feature is resource-only.

### Prompts

| Name | Description | Args |
|:-----|:------------|:-----|
| `brapi_eda_study` | EDA framework for a single study — structure, variables, coverage, outliers, missing data. | `studyDbId` |
| `brapi_meta_analysis` | Cross-study meta-analysis framework given germplasm + trait. | `germplasmDbIds`, `traitName` |

---

## Overview

A TypeScript MCP server exposing BrAPI v2.1 — the plant-breeding-database interop standard — to LLMs as a goal-oriented workbench. Wraps Core / Phenotyping / Genotyping / Germplasm modules, normalizes spec fragmentation via runtime capability introspection, and manages large result sets through tenant-scoped storage with TTLs. Target users: plant breeders, phenomics researchers, and data scientists who need to find, pull, compare, and export breeding data via natural language.

## User goals

The tool surface is shaped around these agent outcomes:

1. Locate studies by crop/season/location and inspect program/trial/variable context
2. Retrieve germplasm details and trace pedigree ancestry across generations
3. Pull phenotype observations filtered by study/germplasm/variable, with export paths to R/Python
4. Retrieve field-trial images for an observation unit
5. Pull genotype calls for a germplasm set across a variant set
6. Submit new or corrected observations from a completed field trial, preview-before-apply

## Requirements

- BrAPI v2.1 targeting; v2.0 servers run the same code path — tools that require a post-v2.0 endpoint check `CapabilityRegistry` and surface a clear "not supported by this server" error rather than attempting an alternate implementation.
- Capability introspection on connect; all tools check the cached `calls` profile before routing.
- Auth modes: SGN token (Breedbase family), OAuth2 (CGIAR), static API key (header-based, configurable header name), no-auth.
- Transparent handling of BrAPI's async search pattern (`searchResultsDbId` polling loop), with per-connection retry + exponential backoff on 429/5xx.
- Dataset lifecycle: metadata in `ctx.state`, payloads in `StorageService`, configurable TTL.
- Multi-call tools (e.g., `brapi_find_studies` FK resolution) return partial results with a `warnings[]` array when non-primary calls fail; primary-query failure surfaces as a tool error.
- Connection state lives in `ctx.state` for the session; if lost (process restart, stdio reconnect), tools return a structured "reconnect required" error pointing the caller back to `brapi_connect`.
- Read + write operations; write ops elicit-guarded via `mode: preview → apply`.
- Multi-server support within a single session via named aliases in `brapi_connect`; agents fan out across registered connections themselves when needed.

## Services

| Service | Wraps | Used by |
|:--------|:------|:--------|
| `BrapiClient` | BrAPI v2 REST surface — low-level GET, POST-search, `/search/*` polling loop, retry + exponential backoff | All tools |
| `CapabilityRegistry` | `/serverinfo` + `/calls` + `/commoncropnames` + per-endpoint filter catalog, aggregated per-connection | All tools (pre-flight check); `brapi_describe_filters` |
| `ReferenceDataCache` | Per-connection TTL cache for programs, trials, locations, crops — FK resolution targets reused across tools | `brapi_find_studies`, `brapi_find_locations`, any tool resolving reference FKs |
| `DatasetStore` | Tenant-scoped dataset persistence (metadata via `ctx.state`, payloads via `StorageService`) | Find/get tools, `brapi_manage_dataset` |
| `OntologyResolver` | Free-text → ontology-URI mapping for observation variables. Default backend: synonym + substring match against `/ontologies` + `/variables`. Swappable for embedding-based backends. | `brapi_find_variables` |
| `ServerRegistry` | Session-scoped named connection aliases (multi-server mode) | `brapi_connect` |

## Error design

Shared failure modes across tools. Tool-specific cases build on these.

| Failure mode | Error code | Recovery in message |
|:-------------|:-----------|:--------------------|
| Server lacks a required BrAPI call | `ValidationError` | List missing `calls`; point to `brapi_server_info` |
| No active connection in session | `FailedPrecondition` | Call `brapi_connect` first; mention env-var defaults if configured |
| Auth expired or invalid | `Forbidden` | Re-run `brapi_connect`; name the auth type that failed |
| Entity not found (valid ID format) | `NotFound` | Confirm ID; suggest `brapi_find_*` to search |
| Async search timed out | `ServiceUnavailable` | `BrapiClient` auto-retries `BRAPI_RETRY_MAX_ATTEMPTS` times before surfacing |
| Genotype call count exceeds cap | `ValidationError` | Bump `maxCalls` or route through `brapi_manage_dataset` export |
| Upstream 5xx after retries | `ServiceUnavailable` | Surface upstream body; if the agent has called `brapi_connect` with multiple aliases, suggest retrying against another registered connection |

## Auth scopes

Domain-led convention. Skip for stdio-only deployments.

| Scope | Covers |
|:------|:-------|
| `brapi:read` | All `find_*`, `get_*`, `walk_pedigree`, `server_info`, `describe_filters`, `raw_get`, `raw_search`, plus all `manage_dataset` modes |
| `brapi:write:observations` | `submit_observations` |

`brapi_connect` is unscoped — it's authentication, not an authorized operation.

## Config

| Env var | Required | Description |
|:--------|:---------|:------------|
| `BRAPI_DEFAULT_BASE_URL` | No | Default server if none set per session |
| `BRAPI_DEFAULT_USERNAME` / `_PASSWORD` | No | Default auth |
| `BRAPI_DEFAULT_OAUTH_CLIENT_ID` / `_CLIENT_SECRET` | No | For OAuth2 servers (CGIAR) |
| `BRAPI_DEFAULT_API_KEY` / `_API_KEY_HEADER` | No | Header-based API-key servers; header name defaults to `Authorization` |
| `BRAPI_DATASET_TTL_SECONDS` | No | Default 86400 (24h) |
| `BRAPI_DATASET_STORE_DIR` | No | Filesystem path for large payloads |
| `BRAPI_LOAD_LIMIT` | No | Default in-context row cap (default 200) |
| `BRAPI_MAX_CONCURRENT_REQUESTS` | No | Per-connection concurrency cap for parallel fan-out (default 4) |
| `BRAPI_RETRY_MAX_ATTEMPTS` | No | Max retries on 429/5xx (default 3, exponential backoff from 500ms) |
| `BRAPI_REFERENCE_CACHE_TTL_SECONDS` | No | TTL for `ReferenceDataCache` (default 3600) |

## Implementation order

1. Config, server setup, `BrapiClient` with async-search polling
2. `CapabilityRegistry` + `ReferenceDataCache` + `DatasetStore`
3. `brapi_connect`, `brapi_server_info`, `brapi_describe_filters` — session bootstrap + filter discovery
4. Read tools: studies, germplasm, observations, images (with `extraFilters` passthrough)
5. `brapi_manage_dataset` (consolidated)
6. Genotyping + locations + ontology resolver
7. Escape hatches (`brapi_raw_get`, `brapi_raw_search`)
8. Prompts
9. Write tools with elicit gates
10. Resources (additive)

Each step independently testable against BrAPI test server + Cassavabase + T3 wheat.

## Domain mapping

| Noun | BrAPI module | Key operations | Tool(s) |
|:-----|:-------------|:---------------|:--------|
| Study | Core | list, get, search (POST) | `brapi_find_studies`, `brapi_get_study` |
| Germplasm | Germplasm | list, get, pedigree, progeny, attributes | `brapi_find_germplasm`, `brapi_get_germplasm`, `brapi_walk_pedigree` |
| ObservationVariable | Phenotyping | list, get, ontology | `brapi_find_variables` |
| Observation | Phenotyping | list (filtered), search (POST) | `brapi_find_observations` |
| ObservationUnit | Phenotyping | list, get | Covered inside `brapi_get_study` + `brapi_find_observations` |
| Image | Phenotyping | list, get bytes | `brapi_find_images`, `brapi_get_image` |
| VariantSet / Variant / Call | Genotyping | list, get, search (POST, async) | `brapi_find_variants`, `brapi_find_genotype_calls` |
| Location | Core | list (get via `find_locations` with ID filter) | `brapi_find_locations` |
| Program / Trial / Season / Crop | Core | list (reference data) | Returned enriched inside `brapi_find_studies` |

## Workflow analysis

### `brapi_server_info` — orientation envelope

Runs automatically as part of `brapi_connect` (inlined in its response — see Response companions) and on-demand whenever the agent wants a fresh health check. Shape:

| # | Call | Purpose |
|:--|:-----|:--------|
| 0 | `CapabilityRegistry.get()` | Read cached `/serverinfo` + `/calls` + `/commoncropnames` from `ctx.state` |
| 1 | Parallel opportunistic counts | `GET /studies?pageSize=0`, `/germplasm?pageSize=0`, `/programs?pageSize=0`, `/locations?pageSize=0` — totals pulled from pagination metadata only, skipped when the server doesn't expose them cheaply |
| 2 | Compose envelope | Merge identity, auth status, capability profile, counts, and server-specific notes |

Output shape:

```ts
{
  server:       { name, version, baseUrl, brapiVersion: '2.1' },
  auth:         { mode, expiresAt?, scopes? },
  capabilities: {
    supported:   string[],   // from /calls
    missing:     string[],   // required-but-absent endpoints
    notableGaps: string[],   // e.g. "ontology URIs unsupported, falling back to substring match"
  },
  content: {
    crops:           string[],     // from /commoncropnames
    programCount?:   number,       // pageSize=0 metadata; omit if not cheap
    studyCount?:     number,
    germplasmCount?: number,
    locationCount?:  number,
  },
  notes: string[],                 // server-specific quirks
}
```

Counts are opportunistic — populated only when a cheap total is available; all fields in `content` are optional because some servers won't expose them without full scans. A well-shaped envelope is the single most important schema in the surface: it means the agent orients in one call and pivots directly to retrieval without fishing through `find_*` tools.

### `brapi_find_studies` — 5–7 upstream calls

| # | Call | Purpose | Mode gate |
|:--|:-----|:--------|:----------|
| 0 | `CapabilityRegistry.ensure('studies')` | Confirm server supports the endpoint | always |
| 1 | `POST /search/studies` (or `GET /studies` fallback) | Primary query | always |
| 2 | `GET /search/studies/{id}` polling loop | Handle async pattern | if async |
| 3 | `GET /programs?programDbIds=...` | Batch-resolve program FKs (via `ReferenceDataCache`) | when `programDbId` in results |
| 4 | `GET /trials?trialDbIds=...` | Batch-resolve trial FKs (via `ReferenceDataCache`) | when `trialDbId` in results |
| 5 | `GET /locations?locationDbIds=...` | Batch-resolve location FKs (via `ReferenceDataCache`) | when `locationDbId` in results |
| 6 | `DatasetStore.save()` | Persist handle, return summary | when rows > `loadLimit` |

Steps 3–5 run in parallel subject to `BRAPI_MAX_CONCURRENT_REQUESTS`. Any of them failing degrades to partial results with a warning; only primary-query failure (step 1) is a hard error.

### `brapi_walk_pedigree` — N+1 expansion

| # | Call | Purpose |
|:--|:-----|:--------|
| 0 | `GET /germplasm/{id}/pedigree` | Root node |
| 1..N | Breadth-first expansion per `maxDepth` | Walk tree |
| Final | Dedupe, trim, return DAG (nodes + edges) | |

Dominant cost is N+1. Use `filter.germplasmDbIds` batch on `/germplasm` for parent lookups where supported.

### `brapi_submit_observations` — elicit-guarded

| # | Call | Mode gate |
|:--|:-----|:----------|
| 0 | Validate rows against observation-variable scales/methods | always |
| 1 | Return preview summary | `preview` (default) |
| 2 | `ctx.elicit` confirmation with row count + study name | `apply`, when supported |
| 3 | `POST /observations` (rows without `observationDbId`) + `PUT /observations` (rows with one) | `apply` |
| 4 | `GET /observations?observationDbIds=...` | `apply` — verify post-state |

`destructiveHint: false` (additive) but `apply` still elicits: research data contamination is recoverable but costly to unwind. Idempotent on retry only when rows carry `observationDbId`.

## Response companions

Beyond each tool's primary return, responses include cheap-to-compute context that steers the agent's next decision without a follow-up call. Inspired by the pattern in [`git_wrapup_instructions`](https://github.com/cyanheads/git-mcp-server) (returns current repo status alongside guidance): the companion is what the agent needs to make its next move.

### Orient-combine (connect → server_info merged)

`brapi_connect` inlines the full `server_info` orientation envelope in its response. Every session does connect → server_info anyway; merging is free and means one call to fully orient. `brapi_server_info` remains callable on-demand for fresh health checks.

### Filter-value distributions on `find_*`

Every `find_*` tool returns a `distributions` map aggregating filter values across the result set — data already in the payload, just summarized. Example for `find_studies`:

```ts
{
  results: [...],
  distributions: {
    programs:   { 'Cassava Breeding': 28, 'Sweetpotato Genomics': 15, 'Yam Diversity': 7 },
    trialTypes: { 'Advanced Yield': 20, 'Preliminary Yield': 15, 'Observation': 15 },
    seasons:    { '2022': 18, '2021': 22, '2020': 10 },
    locations:  { 'NCSU Station 1': 22, 'NCSU Station 2': 18, 'Cornell': 10 },
  },
}
```

Agents refine queries ("scope down to Cassava Breeding") without another call. When results exceed `loadLimit` and a dataset handle is returned, distributions come from the full result set (computed server-side before truncation) plus a `refinementHint` pointing at the highest-leverage winnower: *"400 rows exceeded loadLimit=200. Tighten seasons (18/22/10 split → 2021-only cuts to ~220 rows) or narrow programs."*

### Post-action state on `submit_observations`

**Preview mode** returns a validation summary plus intended-routing breakdown:

```ts
{
  valid: 12,
  invalid: 0,
  routing: { postCount: 8, putCount: 4 },    // POST = new (no observationDbId), PUT = update
  perRowWarnings: [...],                      // unusual scale/method/value combinations
}
```

**Apply mode** returns post-state verification — git-status equivalent:

```ts
{
  posted: [...],
  updated: [...],
  studyObservationCount: 318,                 // new total after write
  latestObservationTimestamp: '2026-04-23T...',
  perRowWarnings: [...],
}
```

### Traversal stats on `walk_pedigree`

DAG response includes domain-relevant interpretation alongside nodes/edges:

| Field | Purpose |
|:--|:--|
| `depthReached` | Max generations actually walked (may be < `maxDepth` if dead-ends hit first) |
| `rootCount` | Nodes with no parents in the walked set |
| `leafCount` | Nodes with no children in the walked set |
| `cycleCount` | Cycles detected and broken during traversal |
| `deadEndCount` | Nodes where upstream pedigree lookup failed |

### Entity counts on `get_*`

| Tool | Companion counts |
|:--|:--|
| `brapi_get_study` | `observationCount`, `observationUnitCount`, `variableCount` — signals what drilling deeper would yield |
| `brapi_get_germplasm` | `studyCount` (appears in N studies), `directDescendantCount`, `directParentCount` — signals pedigree depth and observation coverage |

### Routing nudges on `raw_*`

When `brapi_raw_get` / `brapi_raw_search` hits an endpoint covered by a goal-shaped tool, the response includes a `suggestion` field: *"This endpoint is also served by `brapi_find_studies` which enriches with program/trial/location FKs in one call."* Nudges agents back toward the curated surface without being prescriptive.

### What we deliberately don't include

- **Explicit `nextToolSuggestions` arrays** — would duplicate the playbook tool we cut. Real data signal (distributions, counts, warnings) steers the agent organically without synthesis.
- **LLM-generated insights or recommendations** — surface raw signal, not generated prose. Reproducibility in research workflows requires deterministic outputs.

## Design decisions

- **Mode-consolidation for `brapi_manage_dataset`** — related ops on the same noun collapse under one tool instead of 4–5 siblings. Cost: modal tools with mode-specific schemas can hurt LLM tool-call accuracy. Mitigation: Zod discriminated unions on `mode` so invalid combinations fail at input validation, not mid-handler. Same pattern stands ready for `brapi_manage_list` if user-defined lists are promoted from deferred to MVP.
- **Goal-shaped tools as default, raw passthrough as escape hatch** — 1:1 API-proxy as the *primary* interface is an anti-pattern for agent workflows (it shifts composition burden onto the LLM and produces more round trips). But a documented last-resort `brapi_raw_get` / `brapi_raw_search` pair closes the completeness gap for niche endpoints (`/samples`, `/methods`, `/scales`, `/crosses`) without diluting the goal-shaped surface. Tool descriptions direct agents to `find_*`/`get_*` first; the raw tools are explicitly positioned as "when nothing else fits." This matches how the Plant-Phenomics-Lab/Breedbase-Client Python server operates (where `brapi_get`/`brapi_search` are the primary interface) while keeping our opinionated defaults.
- **Filter discovery + passthrough** — `brapi_describe_filters` (plus the paired `brapi://filters/{endpoint}` resource) lets an agent enumerate valid filters per endpoint; every `find_*` tool then accepts an `extraFilters?` map forwarded verbatim to the upstream. Goal-shaped named params cover the validated common cases; the discovery/passthrough pair handles server-specific or less-common filters without a code change. Cost: no runtime validation on passthrough values. Mitigation: preserve the full upstream 400 body so the agent can self-correct. Mirrors Breedbase-Client's `get_search_parameters` pattern but split cleanly between discovery (dedicated tool + resource) and usage (catch-all param on existing tools).
- **Connection is explicit** — `brapi_connect` must run before other tools. Auto-connect from env rejected: multi-server workflows need named connections, and the capability profile is per-server.
- **Orientation lives in `brapi_server_info`, not a separate instruction tool** — the agent's job splits three ways: orient (what's on this server?), retrieve (filter-fetch by parameters), and orchestrate (multi-step ops like pedigree walks or preview/apply writes). A rich `server_info` envelope (capabilities + content counts + notes) handles orientation in one call, and tool-specific error messages handle recovery. A separate playbook/guidance tool would duplicate both.
- **Ontology resolver is a separate service** — keeps heuristic/embedding-driven mapping out of the HTTP client where it doesn't belong; swappable.
- **Dataset provenance is mandatory** — every dataset carries the query that produced it. Reproducibility is non-negotiable in research contexts.
- **Genotyping is a first-class peer** — BrAPI's genotyping module warrants the same coverage as phenotyping; omitting it would leave breeders without half their data.
- **Images returned inline, never written to disk** — `brapi_get_image` returns base64-encoded bytes as a `type: image` content block. Works identically in stdio and HTTP deployments; no filesystem assumption bleeds into the tool contract.
- **No catastrophic-irreversible operations exposed** — the write surface is additive (observations POST/PUT). `brapi_manage_dataset` delete removes a server-side cached query result, not source data. No operation warrants the "stays in vendor UI" exclusion.
- **MCP Apps deferred to post-MVP** — three data-viz candidates are strong App Tool fits: interactive pedigree DAG (`brapi_walk_pedigree`), study-location world map (`brapi_find_studies` + `brapi_find_locations`), and image gallery (`brapi_find_images` + `brapi_get_image`). MVP ships text-only via `format()`; promote to `appTool()` + paired `appResource()` after the core surface is validated against real servers.

## Known limitations

- Servers marked ❌ in the Compatibility matrix (Crop Ontology, EU-SOL, TERRA-REF, URGI GnpIS) don't implement enough of BrAPI to be usable — `brapi_connect` returns a clear error listing which required calls are missing.
- Servers without `/ontologies` can't benefit from ontology-URI trait resolution — `brapi_find_variables` falls back to substring match on trait names and says so in the response.
- BrAPI's image-bytes endpoint (`/images/{id}/imagecontent`) isn't universally implemented; `brapi_get_image` falls back to fetching the `imageURL` field when the server lacks it.
- Genotype call volume can be enormous; `brapi_find_genotype_calls` enforces a default cap of 100,000 calls with a `maxCalls` override.
- Write surface is MVP: only `brapi_submit_observations` is exposed. Germplasm, study, and variant-set submission are deferred until observation submission is validated against real servers.
- **Cross-server federation (`brapi_compare_servers`) is deferred.** Agents wanting to cross-reference across Cassavabase/Sweetpotatobase/etc. connect to each server with an `alias` and fan out `brapi_find_*` calls themselves — the LLM-side merge is straightforward and avoids a four-query-type mode-consolidated tool. Promoted to a first-class tool if real sessions show repeated manual fan-out.
- **BrAPI user-defined lists (`brapi_manage_list`) are deferred.** Upstream support is inconsistent across server implementations, and a read/write surface spanning five modes × eight list types is disproportionate to MVP value. Added when a concrete user workflow demands it.
- **No instruction/playbook tool.** Guidance is carried in tool-specific error messages (see Error design) and in `brapi_server_info.notes[]` rather than a separate meta tool.

## Compatibility

Test matrix adopted from [Plant-Phenomics-Lab/Breedbase-Client](https://github.com/Plant-Phenomics-Lab/Breedbase-Client) (Jerry Yu, Akarsh Eathamukkala, Jay Shah, Benjamin Maza, Jerome Maleski). Servers marked ❌ don't implement enough of BrAPI v2 to be usable — `brapi_connect` returns a clear error listing which required calls are missing.

| Server | Auth | Base GET | Search | Images |
|:-------|:-----|:--------:|:------:|:------:|
| Cassavabase | SGN | ✅ | ✅ | ✅ |
| Solgenomics | SGN | ✅ | ✅ | ✅ |
| Sweetpotatobase | SGN | ✅ | ✅ | ✅ |
| Yambase | SGN | ✅ | ✅ | ✅ |
| Musabase | SGN | ✅ | ✅ | No images |
| CitrusBase | SGN | Untested | Untested | Untested |
| sugarcane.sgn.cornell.edu | SGN | Untested | Untested | Untested |
| BrAPI Test Server | None | ✅ | ✅ | ✅ |
| T3 (Wheat / Oat / Barley) | None | ✅ | ✅ | ✅ |
| Gigwa | None | ✅ | ✅ | No images |
| MGIS | None | ✅ | No images | ✅ |
| Musa Acuminata GWAS Panel (v1, v2) | None | ✅ | ✅ | No images |
| Musa Germplasm Information System v5 | None | ✅ | ✅ | No images |
| Crop Ontology | None | ❌ | ❌ | ❌ |
| EU-SOL Tomato Collection | None | ❌ | ❌ | ❌ |
| TERRA-REF | None | ❌ | ❌ | ❌ |
| URGI GnpIS | None | ❌ | ❌ | ❌ |

Primary testing targets for this server: BrAPI Test Server (no-auth, fast iteration), Cassavabase (SGN auth, full feature coverage), T3 Wheat (no-auth, phenotyping + genotyping), Gigwa (genotyping-heavy).

## API reference

- BrAPI v2.1 spec: https://brapi.org/specification
- Modules: Core, Phenotyping, Genotyping, Germplasm
- Search pattern: `POST /search/{noun}` → `{searchResultsDbId}` → `GET /search/{noun}/{id}` (may return 202 pending for async implementations)
- Response envelope: `{metadata: {pagination, status}, result: ...}`
- Auth: SGN tokens, OAuth2 (CGIAR), static API key, none (Gigwa, T3, test server)
