<div align="center">
  <h1>@cyanheads/brapi-mcp-server</h1>
  <p><b>BrAPI v2.1 MCP server — studies, germplasm, observations, genotypes, images, and pedigrees across Breedbase, T3, Sweetpotatobase, and any BrAPI-compliant server.</b>
  <div>22 Tools • 6 Resources • 2 Prompts</div>
  </p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/@cyanheads/brapi-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/brapi-mcp-server) [![Version](https://img.shields.io/badge/Version-0.4.12-blue.svg?style=flat-square)](./CHANGELOG.md) [![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-259?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/)

[![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.11-blueviolet.svg?style=flat-square)](https://bun.sh/) [![Status](https://img.shields.io/badge/Status-Beta-yellow.svg?style=flat-square)](./CHANGELOG.md)

</div>

---

## Tools

Twenty-two tools grouped by shape — connection tools bootstrap a session, `find_*` tools return a summarized page plus distributions and spill overflow rows into the DatasetStore, `get_*` tools fetch a single record with companion counts, plus pedigree walking, dataset lifecycle, an opt-in SQL workspace over spilled rows, an additive write surface for observations, and raw passthrough escape hatches.

### Orient

| Tool | Description |
|:-----|:------------|
| `brapi_connect` | Authenticate, register the connection under an alias, cache the capability profile, and return the orientation envelope inline. One call fully orients the agent. |
| `brapi_server_info` | Re-fetch the orientation envelope for a registered alias — identity, auth, capabilities, content counts, attribution, notes. |
| `brapi_describe_filters` | Static BrAPI v2.1 filter catalog for any endpoint — powers `extraFilters` discovery on every `find_*` tool. |

### Retrieve

| Tool | Description |
|:-----|:------------|
| `brapi_find_studies` | Find studies by crop / trial type / season / location / program. Distributions + dataset spillover. |
| `brapi_get_study` | Fetch a study with program / trial / location FKs resolved and companion counts (observations, units, variables). |
| `brapi_find_germplasm` | Find germplasm by name, synonym, accession, PUI, crop, or free-text. Distributions + dataset spillover. |
| `brapi_get_germplasm` | Fetch a germplasm with attributes, direct parents, and companion counts (studies, parents, descendants). |
| `brapi_walk_pedigree` | BFS-walk ancestry / descendancy as a deduplicated DAG with cycle detection, depth limits, and traversal stats. |
| `brapi_find_variables` | Find observation variables by name / class / ontology / free-text; ranked client-side via `OntologyResolver` when `text` is supplied. |
| `brapi_find_observations` | Pull observation records by study / germplasm / variable / season / unit / timestamp. Dataset spillover. |
| `brapi_find_images` | Filter image metadata by unit / study / ontology / MIME type. Bytes via `brapi_get_image`. |
| `brapi_get_image` | Fetch image bytes for up to 5 imageDbIds inline as `type: image` blocks. Prefers `/imagecontent`, falls back to `imageURL`. |
| `brapi_find_locations` | Find research stations by country / type / abbreviation, with optional client-side bbox filter. |
| `brapi_find_variants` | Find variant records by variant set, reference, or genomic region (1-based inclusive / exclusive). |
| `brapi_find_genotype_calls` | Pull genotype calls via async-search polling. Upstream pull bounded by `BRAPI_GENOTYPE_CALLS_MAX_PULL` (default 100k, max 500k). |

### Orchestrate

| Tool | Description |
|:-----|:------------|
| `brapi_manage_dataset` | Lifecycle for `find_*` spillover datasets — list / summary / load (paged + projected) / delete. |

### Analyze (opt-in: `CANVAS_PROVIDER_TYPE=duckdb` + `BRAPI_CANVAS_ENABLED=true`)

| Tool | Description |
|:-----|:------------|
| `brapi_dataframe_query` | SELECT SQL across in-memory dataframes (DuckDB-backed). Spilled `find_*` datasets auto-register as `ds_<datasetId>`. Read-only — multi-statement, non-SELECT, file-reads, and exports rejected. |
| `brapi_dataframe_describe` | List dataframes with column schema, row counts, and dataset provenance. |
| `brapi_dataframe_drop` | Drop a dataframe by name. Idempotent. Underlying dataset is unaffected. |

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
| `brapi://dataset/{datasetId}` | Dataset metadata + provenance |
| `brapi://filters/{endpoint}` | `brapi_describe_filters` |

---

## Prompts

Multi-step BrAPI workflow templates — pure user-message generators, no side effects.

| Name | Args | Purpose |
|:-----|:-----|:--------|
| `brapi_eda_study` | `studyDbId`, `alias?` | EDA playbook for one study — orient, variables, coverage, missing data, outliers, pedigree, structured report. |
| `brapi_meta_analysis` | `germplasmDbIds` (CSV), `traitName`, `alias?` | Cross-study meta-analysis — trait resolution, study discovery, harmonization, per-germplasm × per-study and across-study summaries. |

---

## BrAPI-specific features

- **Multi-server session** — `ServerRegistry` maps aliases to live BrAPI connections; one session can span Breedbase, T3, and Sweetpotatobase in parallel.
- **Capability-aware calls** — `CapabilityRegistry` caches `/serverinfo` per connection and guards every tool call against unsupported endpoints. Falls back to `/calls` when `/serverinfo` is sparse.
- **Built-in known-server registry** — `cassava`, `sweetpotato`, `wheat`, `breedbase` resolve out-of-the-box without env vars; orientation envelope carries CC-BY attribution.
- **Dataset spillover** — `find_*` tools cap in-context rows at `loadLimit` and persist larger unions (up to 50k rows / 50 pages) as handles in `DatasetStore`. `brapi_manage_dataset` pages / projects / deletes them.
- **Dataframes (Tier 3, opt-in)** — spilled rows auto-register as DuckDB-backed `ds_<datasetId>` dataframes; agents run SELECT SQL via `brapi_dataframe_query` with read-only enforcement and a per-tenant workspace. Requires the optional `@duckdb/node-api` peer dep. Not on Cloudflare Workers.
- **Async-search transparency** — `brapi_find_genotype_calls` and `brapi_raw_search` handle the `POST /search/{noun}` → `GET /search/{noun}/{id}` 202-retry pattern automatically.
- **Pedigree DAG walks** — `brapi_walk_pedigree` BFS-traverses ancestry / descendancy with cycle detection (BrAPI only exposes one generation per call).
- **Image content** — `brapi_get_image` fetches bytes inline as MCP `type: image` blocks, preferring `/images/{id}/imagecontent` with `imageURL` fallback.
- **Free-text variable ranking** — `OntologyResolver` scores variables against a query (PUI / name / synonym / trait-class) so `find_variables text:"..."` returns ranked candidates even without `/ontologies`.
- **Auth variants in one schema** — tagged-union covers `none` / `bearer` / `api_key` / `sgn` (session-token exchange) / `oauth2` (client-credentials).
- **Typed error contracts** — every declared failure mode carries a stable `data.reason`, an HTTP-style `code`, and a `recovery.hint` so clients can route deterministically.
- **Compatibility matrix** — live server probes tracked in [docs/compatibility.md](./docs/compatibility.md).

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) — declarative definitions, unified error handling, pluggable auth (`none` / `jwt` / `oauth`), swappable storage, structured logging with optional OTel, STDIO + Streamable HTTP transports.

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

No env vars are required — the four built-in aliases (`cassava`, `sweetpotato`, `wheat`, `breedbase`) resolve out-of-the-box, and agents can connect to any other BrAPI v2 URL at runtime via `brapi_connect`. **For credentialed servers, prefer env vars over agent input** so passwords / tokens / API keys stay out of the LLM context — see [Per-alias credentials](#per-alias-credentials).

**Prerequisites:** [Bun v1.3.11+](https://bun.sh/) or Node.js v22+. *(Optional)* [`@duckdb/node-api`](https://www.npmjs.com/package/@duckdb/node-api) for the dataframe surface — Linux/macOS/Windows × x64 plus Linux/macOS arm64 (no Windows arm64; no Cloudflare Workers).

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
| `BRAPI_LOAD_LIMIT` | In-context row cap before `find_*` spills to `DatasetStore`. | `200` |
| `BRAPI_MAX_CONCURRENT_REQUESTS` | Per-connection concurrency cap. | `4` |
| `BRAPI_RETRY_MAX_ATTEMPTS` / `BRAPI_RETRY_BASE_DELAY_MS` | Retry policy for 429/5xx with exponential backoff. | `3` / `500` |
| `BRAPI_REQUEST_TIMEOUT_MS` | Per-request HTTP timeout. | `30000` |
| `BRAPI_SEARCH_POLL_TIMEOUT_MS` / `_INTERVAL_MS` | Async `/search` polling budget + interval. | `60000` / `1000` |
| `BRAPI_DATASET_TTL_SECONDS` / `BRAPI_DATASET_STORE_DIR` | TTL for spilled datasets + filesystem path when filesystem storage is active. | `86400` / — |
| `BRAPI_REFERENCE_CACHE_TTL_SECONDS` | TTL for programs / trials / locations / crops cache. | `3600` |
| `BRAPI_ALLOW_PRIVATE_IPS` | Allow RFC 1918 / loopback targets. Dev-only. | `false` |
| `BRAPI_ENABLE_WRITES` | Opt-in for `brapi_submit_observations` registration. | `false` |
| `BRAPI_GENOTYPE_CALLS_MAX_PULL` | Upstream row ceiling per `brapi_find_genotype_calls` invocation. Max 500,000. | `100000` |
| `CANVAS_PROVIDER_TYPE` | Framework `DataCanvas` switch — set to `duckdb` to enable the dataframe surface. | `none` |
| `BRAPI_CANVAS_ENABLED` / `BRAPI_CANVAS_MAX_ROWS` / `BRAPI_CANVAS_QUERY_TIMEOUT_MS` | Dataframe surface gate, response row cap, per-query timeout. | `true` / `10000` / `30000` |
| `MCP_TRANSPORT_TYPE` / `MCP_HTTP_PORT` | Transport (`stdio` \| `http`) + HTTP port. | `stdio` / `3010` |
| `MCP_AUTH_MODE` / `MCP_LOG_LEVEL` / `STORAGE_PROVIDER_TYPE` / `OTEL_ENABLED` | Auth mode (`none` \| `jwt` \| `oauth`), log level, storage backend, OpenTelemetry. | `none` / `info` / `in-memory` / `false` |

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
# .env — register Cassavabase as alias 'cassava' with write access
BRAPI_CASSAVA_USERNAME=alice
BRAPI_CASSAVA_PASSWORD=...
# (BASE_URL omitted — built-in registry covers it)

# Static API key as alias 'prod'
BRAPI_PROD_BASE_URL=https://my-brapi.example.com/brapi/v2
BRAPI_PROD_API_KEY=...
BRAPI_PROD_API_KEY_HEADER=X-API-Key
```

Then the agent calls `brapi_connect({ alias: 'cassava' })` — no `baseUrl`, no `auth`, no secrets in the prompt.

### Built-in aliases

The server ships with a curated registry of public BrAPI v2 endpoints. Each resolves out-of-the-box; the orientation envelope surfaces license, citation, and homepage in its `attribution` block under [Creative Commons Attribution](https://creativecommons.org/licenses/by/4.0/).

| Alias | Upstream | Hosted by | Crop | Notes |
|:------|:---------|:----------|:-----|:------|
| `cassava` | [cassavabase.org](https://cassavabase.org/) | Boyce Thompson Institute | Cassava | NextGen Cassava |
| `sweetpotato` | [sweetpotatobase.org](https://sweetpotatobase.org/) | Boyce Thompson Institute | Sweet potato | |
| `wheat` | [wheat.triticeaetoolbox.org](https://wheat.triticeaetoolbox.org/) | Triticeae Toolbox (T3) | Wheat | |
| `breedbase` | [breedbase.org](https://breedbase.org/) | Boyce Thompson Institute | _Demo_ | Sample data only — onboarding + tests. |

Set `BRAPI_<ALIAS>_BASE_URL` to repoint at a staging mirror or fork (env wins over the built-in URL). Set `BRAPI_<ALIAS>_USERNAME` etc. to attach credentials on top of the built-in URL — each Breedbase instance has its own user table, so write access requires separate registration on each upstream. Use `BRAPI_BUILTIN_ALIASES_DISABLED=cassava,wheat` to strip specific entries.

**Citation:** all four built-ins reference Morales et al. 2022, _"Breedbase: a digital ecosystem for modern plant breeding."_ G3 12(7): jkac078. [doi:10.1093/g3journal/jkac078](https://doi.org/10.1093/g3journal/jkac078).

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

Defaults to HTTP transport, stateless session mode, logs to `/var/log/brapi-mcp-server`. OTel peer deps are installed by default — `--build-arg OTEL_ENABLED=false` to omit.

### Multi-user HTTP deployments

`ctx.state` (where `ServerRegistry`, `DatasetStore`, and `CapabilityRegistry` live) is **scoped by `tenantId`, not session id**:

| Mode | `tenantId` |
|:-----|:-----------|
| `MCP_TRANSPORT_TYPE=stdio` (any auth) | `default` |
| `http` + `MCP_AUTH_MODE=none` | `default` for every client — **shared bucket** |
| `http` + `jwt` or `oauth` | JWT `tid` claim, fail-closed if absent |

For shared HTTP deployments, set `MCP_AUTH_MODE=jwt` (HS256, `MCP_AUTH_SECRET_KEY`) or `oauth` (JWKS, `OAUTH_ISSUER_URL` + `OAUTH_AUDIENCE`) so each caller's `tid` carves its own state. Otherwise registered aliases — including SGN-exchanged bearer tokens — leak across users.

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
