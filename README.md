<div align="center">
  <h1>@cyanheads/brapi-mcp-server</h1>
  <p><b>A collaborative BrAPI v2.1 workspace for multi-agent research via MCP. Search studies, germplasm, genotypes, & more - across Breedbase, T3, Sweetpotatobase, & any BrAPI v2-compliant server.</b>
  <div>22 Tools • 5 Resources • 2 Prompts • Multi-agent collaboration</div>
  </p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/@cyanheads/brapi-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/brapi-mcp-server) [![Version](https://img.shields.io/badge/Version-0.5.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-259?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/)

[![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.11-blueviolet.svg?style=flat-square)](https://bun.sh/) [![Status](https://img.shields.io/badge/Status-Beta-yellow.svg?style=flat-square)](./CHANGELOG.md)

</div>

---

## Tools

22 tools grouped by shape — connection tools bootstrap a session, `find_*` tools return a summarized page plus distributions and spill overflow rows into a canvas dataframe that any agent can query or hand off by ID, `get_*` tools fetch a single record with companion counts, plus pedigree walking, an embedded SQL workspace over spilled rows (DuckDB-backed), file export for human handoff, an additive write surface for observations, and raw passthrough escape hatches.

### Orient

| Tool | Description |
|:-----|:------------|
| `brapi_connect` | Authenticate, register the connection under an alias, cache the capability profile, and return the orientation envelope inline. One call fully orients the agent. |
| `brapi_server_info` | Re-fetch the orientation envelope for a registered alias — identity, auth, capabilities, content counts, attribution, notes. |
| `brapi_describe_filters` | Static BrAPI v2.1 filter catalog for any endpoint — powers `extraFilters` discovery on every `find_*` tool. |

### Retrieve

| Tool | Description |
|:-----|:------------|
| `brapi_find_studies` | Find studies by crop / trial type / season / location / program. Distributions + dataframe spillover. |
| `brapi_get_study` | Fetch a study with program / trial / location FKs resolved and companion counts (observations, units, variables). |
| `brapi_find_germplasm` | Find germplasm by name, synonym, accession, PUI, crop, or free-text. Distributions + dataframe spillover. |
| `brapi_get_germplasm` | Fetch a germplasm with attributes, direct parents, and companion counts (studies, parents, descendants). |
| `brapi_walk_pedigree` | BFS-walk ancestry / descendancy as a deduplicated DAG with cycle detection, depth limits, and traversal stats. |
| `brapi_find_variables` | Find observation variables by name / class / ontology / free-text; ranked client-side via `OntologyResolver` when `text` is supplied. |
| `brapi_find_observations` | Pull observation records by study / germplasm / variable / season / unit / timestamp. Dataframe spillover. |
| `brapi_find_images` | Filter image metadata by unit / study / ontology / MIME type. Bytes via `brapi_get_image`. |
| `brapi_get_image` | Fetch image bytes for up to 5 imageDbIds inline as `type: image` blocks. Prefers `/imagecontent`, falls back to `imageURL`. |
| `brapi_find_locations` | Find research stations by country / type / abbreviation, with optional client-side bbox filter. |
| `brapi_find_variants` | Find variant records by variant set, reference, or genomic region (1-based inclusive / exclusive). |
| `brapi_find_genotype_calls` | Pull genotype calls via async-search polling. Upstream pull bounded by `BRAPI_GENOTYPE_CALLS_MAX_PULL` (default 100k, max 500k). |

### Analyze

| Tool | Description |
|:-----|:------------|
| `brapi_dataframe_describe` | Start here after a spillover. Lists dataframes (or describes one) with column schema, row counts, and originating-source provenance. |
| `brapi_dataframe_query` | SELECT SQL across in-memory dataframes (DuckDB-backed). Spilled `find_*` rows auto-register as `df_<uuid>`. Read-only — multi-statement, non-SELECT, file-reads, and exports rejected. Returns typed columns (`{ name, type }[]`). |
| `brapi_dataframe_drop` | _Opt-in via `BRAPI_CANVAS_DROP_ENABLED=true`._ Drop a dataframe by name. Idempotent. Dataframes also expire via TTL when left unmanaged. |
| `brapi_dataframe_export` | _Opt-in via `BRAPI_EXPORT_DIR=<path>`, stdio-only._ Export a dataframe to disk (CSV / Parquet / JSON) under the configured directory and return the absolute path for the human to open. Optional `columns` projection or `sql` filter materializes a derived table for the export, dropped after. |

### Write (opt-in: `BRAPI_ENABLE_WRITES=true`)

| Tool | Description |
|:-----|:------------|
| `brapi_submit_observations` | Two-phase observation write — `mode: preview` validates; `mode: apply` elicits confirmation, then fans POST + PUT in parallel. Additive only — no destructive deletion. |

### Escape hatches

| Tool | Description |
|:-----|:------------|
| `brapi_raw_get` | Passthrough to any BrAPI `GET /{path}` not covered by curated tools. Emits a routing nudge when one applies. |
| `brapi_raw_search` | Passthrough to any `POST /search/{noun}` with async polling handled transparently. Same nudge pattern. |

> **Alias discovery.** Built-in and operator-configured aliases are appended to the `brapi_connect` description at server startup, so agents see the inventory on `tools/list`. Restart after env-var changes to refresh.

---

## Resources

URI-addressable mirrors of the curated tool surface for clients that prefer resources. All resources use the default connection — multi-server workflows route through tools.

| URI template | Mirrors |
|:-------------|:--------|
| `brapi://server/info` | `brapi_server_info` (default connection) |
| `brapi://calls` | Raw capability profile |
| `brapi://study/{studyDbId}` | `brapi_get_study` |
| `brapi://germplasm/{germplasmDbId}` | `brapi_get_germplasm` |
| `brapi://filters/{endpoint}` | `brapi_describe_filters` |

---

## Prompts

Multi-step BrAPI workflow templates — pure user-message generators, no side effects.

| Name | Args | Purpose |
|:-----|:-----|:--------|
| `brapi_eda_study` | `studyDbId`, `alias?` | EDA playbook for one study — orient, variables, coverage, missing data, outliers, pedigree, structured report. |
| `brapi_meta_analysis` | `germplasmDbIds` (CSV), `traitName`, `alias?` | Cross-study meta-analysis — trait resolution, study discovery, harmonization, per-germplasm × per-study and across-study summaries. |

---

## Multi-agent workflows

The server has two stateful layers and two scoping axes:

| Layer | Default scope | Why |
|:------|:--------------|:----|
| **Connection state** (aliases, exchanged tokens) | Tenant + session | Credentials and live tokens. Tenant gates by user (`jwt`/`oauth`) or collapses to `'default'` (`none`). Session sub-scope (`BRAPI_SESSION_ISOLATION=true`, default) prevents concurrent HTTP sessions in one tenant from sharing each other's tokens. |
| **Dataframes** (`df_<uuid>` tables) | Tenant + session | Within one (tenant, session), agents share by `df_<uuid>` name — possession grants full read/write/drop, auto-expires in 24h, provenance recorded. The underlying canvas is tenant-gated by the framework; the session sub-scope is enforced by the bridge's keying. |

Within one (tenant, session), dataframes act as a self-cleaning shared notebook: hand the `df_<uuid>` name between parallel agents on the same MCP session, persist it across a multi-step workflow, query / project / aggregate / join from any position. Address-by-name, time-bounded, scoped to that session.

**Default (isolated) shape.** Under `MCP_AUTH_MODE=none` + HTTP stateful (the default), each MCP session carves its own connection state and its own canvas. Two researchers connected to the same host don't see each other's `brapi_connect` aliases, exchanged SGN/OAuth tokens, or spilled `df_<uuid>` rows. Stdio always behaves as one session (single-process, no concurrency).

**Legacy shared-workspace shape.** Set `BRAPI_SESSION_ISOLATION=false` for cross-session collaboration in one tenant — multiple MCP sessions then share connection state and one default canvas, the way pre-0.6 deployments behaved. Useful when planning, analysis, and writeup agents run as separate MCP clients but operate as one researcher on shared upstream credentials.

**On privileged data.** The `df_<uuid>` name is a capability token within a canvas — not row-level access control. Anyone holding the name within the same (tenant, session) bucket can read its rows. Under default isolation, that bucket is one MCP session. Under `BRAPI_SESSION_ISOLATION=false`, the bucket widens to the whole tenant (all callers under `auth=none`, or one user's sessions under `jwt`/`oauth`). Treat dataframe names like authenticated share links — pass within the bucket, not externally. The 24h TTL caps blast radius; the provenance trail (originating tool, baseUrl, query) supports audit. Belt-and-braces: `brapi_dataframe_describe` requires an explicit `dataframe` name on shared-trust HTTP (no list-all enumeration), and `brapi_dataframe_query` rejects system-catalog reads (`information_schema`, `pg_catalog`, `sqlite_master`, `duckdb_*`) — so a caller without a known `df_<uuid>` name can't fish through either surface.

---

## BrAPI-specific features

- **Dataframe spillover** — `find_*` tools cap in-context rows at `loadLimit` and materialize larger unions (up to 50k rows / 50 pages) as DuckDB-backed `df_<uuid>` canvas dataframes. Discover with `brapi_dataframe_describe`, query with `brapi_dataframe_query` (SQL paging via `LIMIT/OFFSET`, projection, aggregation). Read-only enforcement at the SQL gate; session-scoped by default (tenant-scoped under `BRAPI_SESSION_ISOLATION=false`) — see [Multi-agent workflows](#multi-agent-workflows).
- **Multi-server session** — `ServerRegistry` maps aliases to live BrAPI connections; one session can span Breedbase, T3, and Sweetpotatobase in parallel.
- **Built-in known-server registry** — `bti-cassava`, `bti-sweetpotato`, `bti-breedbase-demo`, `t3-wheat`, `t3-oat`, `t3-barley` resolve out-of-the-box without env vars; orientation envelope carries CC-BY attribution.
- **Capability-aware calls** — `CapabilityRegistry` caches `/serverinfo` per connection and guards every tool call against unsupported endpoints. Falls back to `/calls` when `/serverinfo` is sparse.
- **DuckDB required** — `@duckdb/node-api` is a regular dependency; startup fails closed when the framework canvas is unavailable. Not supported on Cloudflare Workers (no native binary in that runtime).
- **Async-search transparency** — `brapi_find_genotype_calls` and `brapi_raw_search` handle the `POST /search/{noun}` → `GET /search/{noun}/{id}` 202-retry pattern automatically.
- **Pedigree DAG walks** — `brapi_walk_pedigree` BFS-traverses ancestry / descendancy with cycle detection (BrAPI only exposes one generation per call).
- **Image content** — `brapi_get_image` fetches bytes inline as MCP `type: image` blocks, preferring `/images/{id}/imagecontent` with `imageURL` fallback.
- **Free-text variable ranking** — `OntologyResolver` scores variables against a query (PUI / name / synonym / trait-class) so `find_variables text:"..."` returns ranked candidates even without `/ontologies`.
- **Auth variants in one schema** — tagged-union covers `none` / `bearer` / `api_key` / `sgn` (session-token exchange) / `oauth2` (client-credentials).
- **Typed error contracts** — every declared failure mode carries a stable `data.reason`, an HTTP-style `code`, and a `recovery.hint` so clients can route deterministically.

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) — declarative definitions, unified error handling, pluggable auth (`none` / `jwt` / `oauth`), swappable storage, structured logging with optional OTel, STDIO + Streamable HTTP transports.

---

## Working with dataframes

When a `find_*` tool's upstream total exceeds `loadLimit`, the full union materializes as a canvas dataframe and the response carries an inline `dataframe` handle (`{ tableName, rowCount, columns, createdAt, expiresAt, … }`). SQL is the paging idiom — use `LIMIT/OFFSET` to walk pages, projection (`SELECT col1, col2`) to trim columns, and aggregation (`COUNT`, `GROUP BY`, `AVG`) to summarize without materializing every row.

Dataframe names are session-scoped capability tokens by default — pass `tableName` to any other agent on the same MCP session (or a downstream step in the same workflow) and they query the same workspace by name without re-pulling from the upstream. The `brapi_dataframe_*` tools offer SQL manipulation and more. See [Multi-agent workflows](#multi-agent-workflows) for cross-session / cross-tenant rules.

```text
1. brapi_find_observations { studies: ["s-422"] }
   → first-page rows inline + dataframe.tableName = "df_<uuid>" (when totalCount > loadLimit)
2. brapi_dataframe_describe { dataframe: "df_<uuid>" }
   → schema + provenance (originating tool, baseUrl, query, expiry)
3. brapi_dataframe_query { sql: "SELECT germplasmName, value FROM df_<uuid> WHERE observationVariableDbId = 'V1' LIMIT 100" }
   → typed columns + bounded rows
4. brapi_dataframe_query { sql: "SELECT COUNT(*) AS n, AVG(CAST(value AS DOUBLE)) AS mean FROM df_<uuid> WHERE observationVariableDbId = 'V1'" }
   → aggregate without round-tripping all rows
```

Dataframes auto-expire via TTL (`BRAPI_DATASET_TTL_SECONDS`, default 24h). Set `BRAPI_CANVAS_DROP_ENABLED=true` to expose `brapi_dataframe_drop` for explicit cleanup.

---

## Getting started

Add to your MCP client config — pick one runner:

```json
{
  "mcpServers": {
    "brapi": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/brapi-mcp-server@latest"],
      "env": { "MCP_TRANSPORT_TYPE": "stdio", "MCP_LOG_LEVEL": "info" }
    }
  }
}
```

Swap `command`/`args` for `npx -y @cyanheads/brapi-mcp-server@latest` (no Bun) or `docker run -i --rm -e MCP_TRANSPORT_TYPE=stdio ghcr.io/cyanheads/brapi-mcp-server:latest`.

For Streamable HTTP:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

No env vars are required — the six built-in aliases (`bti-cassava`, `bti-sweetpotato`, `bti-breedbase-demo`, `t3-wheat`, `t3-oat`, `t3-barley`) resolve out-of-the-box, and agents can connect to any other BrAPI v2 URL at runtime via `brapi_connect`. **For credentialed servers, prefer env vars over agent input** so passwords / tokens / API keys stay out of the LLM context — see [Per-alias credentials](#per-alias-credentials).

**Prerequisites:** [Bun v1.3.11+](https://bun.sh/) or Node.js v22+. [`@duckdb/node-api`](https://www.npmjs.com/package/@duckdb/node-api) is a required dependency — supported on Linux/macOS/Windows × x64 plus Linux/macOS arm64 (no Windows arm64; no Cloudflare Workers).

---

## Configuration

Every variable is optional.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `BRAPI_DEFAULT_BASE_URL` | Default BrAPI v2 base URL (e.g. `https://test-server.brapi.org/brapi/v2`). | — |
| `BRAPI_DEFAULT_USERNAME` / `_PASSWORD` | SGN session-token auth for the default connection. | — |
| `BRAPI_DEFAULT_OAUTH_CLIENT_ID` / `_OAUTH_CLIENT_SECRET` | OAuth2 client-credentials for the default connection. | — |
| `BRAPI_DEFAULT_API_KEY` / `_API_KEY_HEADER` | Static API key for the default connection. | header `Authorization` |
| `BRAPI_BUILTIN_ALIASES_DISABLED` | Comma-separated alias names (case-insensitive) to remove from the built-in registry. | — |
| `BRAPI_LOAD_LIMIT` | In-context row cap before `find_*` spills to a canvas dataframe; also doubles as the upstream pageSize during spillover walks (`loadLimit × 50` is the dataframe ceiling). | `1000` |
| `BRAPI_MAX_CONCURRENT_REQUESTS` | Per-connection concurrency cap. | `4` |
| `BRAPI_RETRY_MAX_ATTEMPTS` / `BRAPI_RETRY_BASE_DELAY_MS` | Retry policy for 429/5xx with exponential backoff. | `3` / `500` |
| `BRAPI_REQUEST_TIMEOUT_MS` | Per-request HTTP timeout. | `30000` |
| `BRAPI_COMPANION_TIMEOUT_MS` | Tighter timeout for non-critical companion enrichments (FK lookups, count probes). Companions also bypass the retry budget so a slow upstream surfaces as a warning instead of stretching the response. | `8000` |
| `BRAPI_SEARCH_POLL_TIMEOUT_MS` / `_INTERVAL_MS` | Async `/search` polling budget + interval. | `60000` / `1000` |
| `BRAPI_DATASET_TTL_SECONDS` | TTL for dataframe provenance metadata persisted alongside spilled rows. | `86400` |
| `BRAPI_REFERENCE_CACHE_TTL_SECONDS` | TTL for programs / trials / locations / crops cache. | `3600` |
| `BRAPI_ALLOW_PRIVATE_IPS` | Allow RFC 1918 / loopback targets. Dev-only. | `false` |
| `BRAPI_ENABLE_WRITES` | Opt-in for `brapi_submit_observations` registration. | `false` |
| `BRAPI_GENOTYPE_CALLS_MAX_PULL` | Upstream row ceiling per `brapi_find_genotype_calls` invocation. Max 500,000. | `100000` |
| `BRAPI_CANVAS_DROP_ENABLED` | Opt-in for `brapi_dataframe_drop` registration. Off by default; dataframes expire via TTL when left unmanaged. | `false` |
| `BRAPI_EXPORT_DIR` | Directory for `brapi_dataframe_export` output files. Setting a path is the opt-in (no separate enable flag); unset leaves the tool out of `tools/list`. Stdio-only — the tool stays disabled under HTTP transport regardless of this value. Bridged to the framework's `CANVAS_EXPORT_PATH` automatically. | — |
| `BRAPI_CANVAS_MAX_ROWS` / `BRAPI_CANVAS_QUERY_TIMEOUT_MS` | Per-query response row cap and wall-clock timeout for `brapi_dataframe_query`. | `10000` / `30000` |
| `MCP_TRANSPORT_TYPE` / `MCP_HTTP_PORT` / `MCP_SESSION_MODE` | Transport (`stdio` \| `http`), HTTP port, session mode (`stateful` \| `stateless` \| `auto`). | `stdio` / `3010` / `auto` |
| `MCP_AUTH_MODE` / `MCP_LOG_LEVEL` / `STORAGE_PROVIDER_TYPE` / `OTEL_ENABLED` | Auth mode (`none` \| `jwt` \| `oauth`), log level, storage backend, OpenTelemetry. | `none` / `info` / `in-memory` / `false` |
| `BRAPI_SESSION_ISOLATION` | When `true`, scope ServerRegistry connection state and the CanvasBridge default canvas to `ctx.sessionId` (HTTP stateful/auto). Concurrent callers under `MCP_AUTH_MODE=none` operate in isolated workspaces. Set `false` for the legacy shared-workspace collaboration model. No effect on stdio. | `true` |

Per-alias overrides follow the `BRAPI_<ALIAS>_*` pattern — see [`.env.example`](./.env.example) for every override and inline comments.

### Per-alias credentials

`brapi_connect` resolves `baseUrl` and `auth` from env vars when the agent omits them — credentials never enter the LLM context. Four layers of precedence:

1. **Explicit agent input** — always wins.
2. **Per-alias env vars** — `BRAPI_<ALIAS>_*` (uppercased, hyphens → underscores: `my-server` → `BRAPI_MY_SERVER_*`).
3. **Built-in known-server registry** — see [Built-in aliases](#built-in-aliases).
4. **Default env vars** — `BRAPI_DEFAULT_*`, only when the alias differs from `default`. Not layered on top of a built-in URL — defaults belong to the default server.

Each alias carries **one** credential family — auth mode is derived from which fields are set:

| Vars set | Resolved `mode` |
|:---------|:----------------|
| `_USERNAME` + `_PASSWORD` | `sgn` (Breedbase `/token` exchange) |
| `_BEARER_TOKEN` | `bearer` |
| `_API_KEY` (+ optional `_API_KEY_HEADER`) | `api_key` |
| `_OAUTH_CLIENT_ID` + `_OAUTH_CLIENT_SECRET` (+ optional `_OAUTH_TOKEN_URL`) | `oauth2` |
| _(none set)_ | `none` |

Mixing families within an alias raises a `ValidationError`.

```sh
# .env — attach write credentials to the built-in 'bti-cassava' alias
BRAPI_BTI_CASSAVA_USERNAME=alice
BRAPI_BTI_CASSAVA_PASSWORD=...
# (BASE_URL omitted — built-in registry covers it)

# Static API key as alias 'prod'
BRAPI_PROD_BASE_URL=https://my-brapi.example.com/brapi/v2
BRAPI_PROD_API_KEY=...
BRAPI_PROD_API_KEY_HEADER=X-API-Key
```

Then the agent calls `brapi_connect({ alias: 'bti-cassava' })` — no `baseUrl`, no `auth`, no secrets in the prompt.

### Built-in aliases

The server ships with a curated registry of public BrAPI v2 endpoints. Each resolves out-of-the-box; the orientation envelope surfaces license, citation, and homepage in its `attribution` block under [Creative Commons Attribution](https://creativecommons.org/licenses/by/4.0/).

| Alias | Upstream | Hosted by | Crop | Notes |
|:------|:---------|:----------|:-----|:------|
| `bti-cassava` | [cassavabase.org](https://cassavabase.org/) | Boyce Thompson Institute | Cassava | NextGen Cassava |
| `bti-sweetpotato` | [sweetpotatobase.org](https://sweetpotatobase.org/) | Boyce Thompson Institute | Sweet potato | |
| `bti-breedbase-demo` | [breedbase.org](https://breedbase.org/) | Boyce Thompson Institute | _Demo_ | Sample data only — onboarding + tests. |
| `t3-wheat` | [wheat.triticeaetoolbox.org](https://wheat.triticeaetoolbox.org/) | Triticeae Toolbox (T3) | Wheat | Wheat CAP / IWYP. |
| `t3-oat` | [oat.triticeaetoolbox.org](https://oat.triticeaetoolbox.org/) | Triticeae Toolbox (T3) | Oat | Global Oat Genetics Database. |
| `t3-barley` | [barley.triticeaetoolbox.org](https://barley.triticeaetoolbox.org/) | Triticeae Toolbox (T3) | Barley | T-CAP / US Wheat & Barley Scab Initiative. |

Set `BRAPI_<ALIAS>_BASE_URL` to repoint at a staging mirror or fork (env wins over the built-in URL — hyphens in the alias become underscores in the env var, so `t3-wheat` → `BRAPI_T3_WHEAT_BASE_URL`). Set `BRAPI_<ALIAS>_USERNAME` etc. to attach credentials on top of the built-in URL — each Breedbase instance has its own user table, so write access requires separate registration on each upstream. Use `BRAPI_BUILTIN_ALIASES_DISABLED=bti-cassava,t3-wheat` to strip specific entries.

**Citation:** all six built-ins reference Morales et al. 2022, _"Breedbase: a digital ecosystem for modern plant breeding."_ G3 12(7): jkac078. [doi:10.1093/g3journal/jkac078](https://doi.org/10.1093/g3journal/jkac078).

---

## Running the server

```sh
# Hot-reload dev (Bun runs TS directly)
bun --watch src/index.ts

# Production
bun run rebuild
bun run start            # transport via MCP_TRANSPORT_TYPE (stdio default)
bun run start:stdio      # or pin explicitly
bun run start:http

# Checks
bun run devcheck         # lint + format + typecheck + security + changelog sync
bun run test             # Vitest
bun run lint:mcp         # validate MCP definitions
```

### Docker

```sh
docker build -t brapi-mcp-server .
docker run --rm -p 3010:3010 brapi-mcp-server
```

Defaults to HTTP transport, stateful session mode (engages `mcp-session-id` lifecycle and hijack protection), logs to `/var/log/brapi-mcp-server`. OTel peer deps are installed by default — `--build-arg OTEL_ENABLED=false` to omit.

### Deployment shapes

`brapi-mcp-server` runs in three shapes — pick the one that matches your trust domain. The differentiator is what isolates **connection state** (registered aliases, cached upstream tokens) and **dataframes**: nothing, the MCP session, or the auth tenant.

| Shape | Settings | Isolation | Best for |
|:------|:---------|:----------|:---------|
| **Per-session (default)** | `MCP_AUTH_MODE=none` + HTTP stateful + `BRAPI_SESSION_ISOLATION=true` | Each MCP session carves its own connection state and canvas. Concurrent HTTP callers don't see each other's aliases, exchanged tokens, or `df_<uuid>` rows. | Multi-user host without SSO. Default for institutional / public deployment under shared-trust auth. |
| **Per-user credentials** | `MCP_AUTH_MODE=jwt` or `oauth` (+ HTTP stateful) | Each user's JWT `tid` claim carves a tenant. Sessions sub-scope inside each tenant when isolation is on. Cross-user spillover impossible at the framework level. | Multi-user host with institutional SSO (Shibboleth, Okta, etc.) — strongest separation. |
| **Shared workspace (legacy)** | `MCP_AUTH_MODE=none` + `BRAPI_SESSION_ISOLATION=false` | All callers in one tenant share connection state and one canvas. Possession of a `df_<uuid>` name = full read/write across the workspace. | Solo, lab, or hosting where every caller is one researcher running parallel agents on shared upstream credentials. |

**Shape selection guide:**

- **Multi-user public/institutional HTTP, no SSO.** Use the per-session default. Each researcher's stateful HTTP session is isolated even though they all resolve to `tenantId='default'`.
- **Multi-user with institutional SSO.** Layer JWT or OAuth on top of per-session: `MCP_AUTH_MODE=jwt` (HS256, `MCP_AUTH_SECRET_KEY`) or `oauth` (JWKS, `OAUTH_ISSUER_URL` + `OAUTH_AUDIENCE`). Each user's `tid` carves a tenant; `BRAPI_SESSION_ISOLATION=true` then sub-scopes inside it for users running parallel sessions.
- **One researcher, parallel agents.** If multiple agents (planner, analyst, writeup) connect as separate MCP clients but should share one workspace, set `BRAPI_SESSION_ISOLATION=false` and rely on shared trust. This is the legacy shape.
- **Stdio.** Always one session; isolation is moot. The flag has no effect.

**Belt-and-braces under shared trust.** Even with `BRAPI_SESSION_ISOLATION=false`, `brapi_dataframe_describe` requires an explicit `dataframe` name on HTTP (no list-all enumeration), and `brapi_dataframe_query` rejects system-catalog reads (`information_schema`, `pg_catalog`, `sqlite_master`, `duckdb_*`). The dataframe name is the capability token; possession proves it.

---

## Development

See [`CLAUDE.md`](./CLAUDE.md) for full architectural rules. Short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage — no `console`, no direct persistence
- Register new tools in the `tools` array of `createApp()` in `src/index.ts`
- Wrap upstream calls: validate raw → normalize → return output schema; never fabricate missing fields

```sh
git clone https://github.com/cyanheads/brapi-mcp-server.git
cd brapi-mcp-server
bun install
cp .env.example .env       # edit if you need credentials
bun run devcheck && bun run test
```

PRs welcome.

---

## License

Apache-2.0 — see [LICENSE](LICENSE).
