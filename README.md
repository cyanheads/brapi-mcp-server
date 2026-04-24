<div align="center">
  <h1>brapi-mcp-server</h1>
  <p><b>MCP server for BrAPI v2.1 plant-breeding databases — connect, orient against the capability profile, and drive study / germplasm workflows across Breedbase, T3, Sweetpotatobase, and any BrAPI-compliant server.</b>
  <div>18 Tools • 0 Resources • 0 Prompts</div>
  </p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/brapi-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/brapi-mcp-server) [![Version](https://img.shields.io/badge/Version-0.2.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-259?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/)

[![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.11-blueviolet.svg?style=flat-square)](https://bun.sh/) [![Status](https://img.shields.io/badge/Status-Beta-yellow.svg?style=flat-square)](./CHANGELOG.md)

</div>

---

## Tools

Eighteen tools grouped by shape — connection tools bootstrap a session, `find_*` tools return a summarized page plus distributions and spill overflow rows into the DatasetStore, `get_*` tools fetch a single record with companion counts, plus pedigree walking, dataset lifecycle, and raw passthrough escape hatches.

### Orient

| Tool Name | Description |
|:----------|:------------|
| `brapi_connect` | Connect to a BrAPI v2 server, authenticate, cache the capability profile, and return the full orientation envelope inline. |
| `brapi_server_info` | Return the full orientation envelope for a registered BrAPI connection — identity, capabilities, content counts, notes. |
| `brapi_describe_filters` | List valid filter names for a BrAPI endpoint — powers dynamic discovery for `extraFilters` on any `find_*` tool. |

### Retrieve

| Tool Name | Description |
|:----------|:------------|
| `brapi_find_studies` | Locate studies matching crop / trial type / season / location / program filters, with per-field distributions and dataset spillover. |
| `brapi_get_study` | Fetch a single study with program / trial / location FKs resolved and companion counts for observations, units, and variables. |
| `brapi_find_germplasm` | Find germplasm by name, synonym, accession, crop, or free-text query, with distributions and dataset spillover. |
| `brapi_get_germplasm` | Fetch a single germplasm with attributes, direct parents, and companion counts (studies, parents, direct descendants). |
| `brapi_walk_pedigree` | Walk germplasm ancestry or descendancy as a deduplicated DAG (BFS) with cycle detection, depth limits, and traversal stats. |
| `brapi_find_variables` | Find observation variables (traits) by name, class, ontology, or free-text; ranked client-side via `OntologyResolver` when `text` is supplied. |
| `brapi_find_observations` | Pull observation records filtered by study, germplasm, variable, season, or observation unit. Dataset spillover. |
| `brapi_find_images` | Filter images by observation unit / study / ontology term / MIME type — metadata only, bytes via `brapi_get_image`. |
| `brapi_get_image` | Fetch image bytes for up to 5 imageDbIds inline as `type: image` content blocks. Prefers `/images/{id}/imagecontent`, falls back to `imageURL`. |
| `brapi_find_locations` | Find research stations / field sites by country / type / abbreviation, with optional client-side bounding-box filter. |
| `brapi_find_variants` | Find variant records by variant set, reference, or genomic region (1-based inclusive / exclusive). |
| `brapi_find_genotype_calls` | Pull genotype calls across a germplasm × variant set via async-search polling. Default 100k cap (hard cap 500k); rows beyond `loadLimit` spill to DatasetStore. |

### Orchestrate

| Tool Name | Description |
|:----------|:------------|
| `brapi_manage_dataset` | Lifecycle for `find_*` spillover datasets — list, summary, load (paged rows with column projection), delete. |

### Escape hatches

| Tool Name | Description |
|:----------|:------------|
| `brapi_raw_get` | Passthrough to any BrAPI `GET /{path}` the curated tools don't cover. Emits a routing nudge when a goal-shaped tool exists for the target. |
| `brapi_raw_search` | Passthrough to any BrAPI `POST /search/{noun}` with async polling handled transparently. Same routing nudge pattern. |

---

### `brapi_connect`

Session bootstrap. Authenticates to a BrAPI v2 server, registers the connection under a named alias, loads the capability profile via `CapabilityRegistry`, and inlines the full orientation envelope in the response. One call fully orients the agent.

- Tagged-union auth input: `none`, `sgn` (session-token exchange), `oauth2` (accepted at schema level, rejected at runtime pending client-credentials flow), `bearer`, `api_key`
- Multiple concurrent connections per session via distinct aliases
- Forces a fresh capability load on every connect — the agent expects current state
- Returns the same envelope as `brapi_server_info` — server identity, auth status, capability profile (supported/missing calls), content summary, server-specific notes

---

### `brapi_server_info`

On-demand orientation envelope for any registered alias. Useful for refreshing capability data after a long session or switching between aliases.

- Defaults to the most recent `brapi_connect` alias when `alias` is omitted
- `forceRefresh: true` bypasses the cached capability profile

---

### `brapi_describe_filters`

Static filter catalog drawn from the BrAPI v2.1 spec — name, type, description, and example per filter. Use it before constructing `extraFilters` on any `find_*` tool.

- Covers `studies`, `germplasm`, `variables`, `observations`, `images`, `variants`, `locations`
- Catalog entries reflect the v2.1 spec; individual servers may implement subsets (the capability profile from `brapi_connect` tells you which)
- Response includes `specReference` link and the full list of available endpoints for discovery

---

### `brapi_find_studies`

Locate studies with filters on crop, trial type, season, location, program, free text. Pulls an initial page (capped at `loadLimit`) and, when the upstream total exceeds `loadLimit`, spills the full union into `DatasetStore` and returns a dataset handle.

- Distributions computed across the full row set (`programName`, `studyType`, `seasons`, `locationName`, `commonCropName`)
- Refinement hint suggests which field to narrow when results exceed `loadLimit`
- `extraFilters` escape hatch for server-specific filter keys (discover via `brapi_describe_filters`)
- Warnings surface when `extraFilters` collides with named inputs

---

### `brapi_get_study`

Fetch a single study by `studyDbId` with FKs resolved via `ReferenceDataCache` and cheap `pageSize=0` probes for observation / observation-unit / variable counts.

- Resolves `programDbId`, `trialDbId`, `locationDbId` into full records in one call
- Companion counts signal where to drill next without a full page pull
- Warnings when the upstream server doesn't support count probes

---

### `brapi_find_germplasm`

Find germplasm by name, synonym, accession number, PUI, crop, or free-text. Matches across registered synonyms per BrAPI semantics.

- Distributions across `commonCropName`, `genus`, `species`, `collection`, `countryOfOriginCode`
- Dataset spillover identical to `brapi_find_studies`
- Refinement hint identifies the highest-cardinality dimension for narrowing

---

### `brapi_get_germplasm`

Fetch a single germplasm with attributes, direct parents, and three companion counts (studies the germplasm appeared in, direct parents, direct descendants) — the counts signal where pedigree traversal could go next.

- Pulls `/germplasm/{id}`, `/germplasm/{id}/attributes`, `/germplasm/{id}/pedigree`, and `/germplasm/{id}/progeny` in one call
- Warnings when the upstream server omits any of those sub-endpoints

---

### `brapi_walk_pedigree`

Walk germplasm ancestry or descendancy as a deduplicated DAG. BrAPI only exposes one generation per call, so this tool BFS-expands from each root, breaks cycles, and enforces a 1000-node safety cap.

- `direction`: `ancestors` (parents), `descendants` (progeny), or `both`
- Up to 20 roots per call, depth capped at 10 (default 3)
- Returns nodes + edges plus traversal stats (`depthReached`, `leafCount`, `cycleCount`, `deadEndCount`, `truncated`)
- Warnings when the server doesn't expose `/germplasm/{id}/pedigree` or `/progeny`

---

### `brapi_find_variables`

Find observation variables (traits) by name, trait class, ontology term, or free-text. When `text` is supplied, results are re-ranked client-side via `OntologyResolver`; otherwise falls back to upstream order.

- Distributions across `ontologyDbId`, `traitClass`, `scaleName`
- Ontology candidates (top 10) surfaced separately when `text` is supplied, with source attribution (`puiMatch` / `nameMatch` / `synonymMatch` / `traitClassMatch`)
- Dataset spillover and `extraFilters` passthrough identical to other `find_*` tools

---

### `brapi_find_observations`

Pull observation records filtered by study, germplasm, variable, season, observation unit, observation level, or timestamp range.

- Distributions across `observationVariableName`, `studyName`, `germplasmName`, `observationLevel`, `season`
- Dataset spillover when the upstream total exceeds `loadLimit` — handle passes to `brapi_manage_dataset`

---

### `brapi_find_images`

Filter images by observation unit, observation, study, descriptive ontology term, file name, or MIME type. Returns metadata only — use `brapi_get_image` for bytes.

- Distributions across `mimeType`, `studyName`, `observationUnitName`, `descriptiveOntologyTerms`
- Dataset spillover for large result sets

---

### `brapi_get_image`

Fetch image bytes for up to 5 `imageDbIds` and return them inline as `type: image` content blocks. Hard cap of 20 MB per image.

- Prefers BrAPI `/images/{id}/imagecontent`; falls back to the `imageURL` field when the server doesn't implement imagecontent
- Relative `imageURL`s resolve against the registered base URL; absolute URLs pass through (no auth attached to the fallback)
- Per-image error reporting — partial success is surfaced cleanly

---

### `brapi_find_locations`

Find research stations / field sites by country, abbreviation, type, or location ID.

- Optional client-side bounding-box filter (`bbox: {minLat, maxLat, minLon, maxLon}`) applied after the upstream fetch (BrAPI has no spec-level bbox filter)
- Distributions across `countryCode` and `locationType`
- All four corners required to activate `bbox`; mismatched values produce a warning and the filter is skipped

---

### `brapi_find_variants`

Find variant records by variant set, reference sequence, or genomic region.

- Genomic region uses 1-based inclusive `start` / exclusive `end` per the BrAPI spec
- Distributions across `variantType`, `referenceName`, `variantSetDbId`
- Warns when `start >= end`

---

### `brapi_find_genotype_calls`

Pull genotype calls for a germplasm × variant set. Handles BrAPI's async-search pattern (`POST /search/calls` → `GET /search/calls/{id}`) transparently.

- Requires at least one filter (`variantSetDbId`, `germplasmDbIds`, `callSetDbIds`, `variantDbIds`) — unfiltered pulls are rejected
- Default cap of 100,000 calls per call (hard cap 500,000); `truncated: true` flags when the cap was hit
- Rows beyond `loadLimit` (default 200) spill to `DatasetStore` for export via `brapi_manage_dataset`
- Echoes server-reported genotype-encoding (`expandHomozygotes`, `unknownString`, `sepPhased`, `sepUnphased`) so the agent can interpret the values

---

### `brapi_manage_dataset`

Consolidated lifecycle tool for datasets produced by `find_*` spillovers.

- `mode: list` — enumerate datasets with source / query / rowCount / expiration
- `mode: summary` — per-dataset metadata and provenance
- `mode: load` — paged rows (up to 1000 per page) with optional column projection
- `mode: delete` — drop metadata and payload
- Export (CSV / Parquet) is deferred until the write surface lands

---

### `brapi_raw_get`

Last-resort passthrough to any BrAPI `GET /{path}` the curated tools don't cover (e.g. `/samples`, `/methods`, `/scales`, `/crosses`). Returns the raw upstream envelope plus pagination metadata.

- Rejects absolute URLs in `path` — cross-origin smuggling via the registered base URL is blocked
- Emits a `suggestion` field when a goal-shaped tool covers the target endpoint (e.g. calling `raw_get /studies` nudges you to `brapi_find_studies`)
- Does not enrich results, resolve foreign keys, or compute distributions — prefer curated tools when they apply

---

### `brapi_raw_search`

Last-resort passthrough to any BrAPI `POST /search/{noun}`. Handles the 202 / async-poll pattern transparently.

- Same routing-nudge behavior as `brapi_raw_get`
- Returns `kind: sync | async` and the `searchResultsDbId` when the server took the async path

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool, resource, and prompt definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

BrAPI-specific:

- **Multi-server session** — `ServerRegistry` maps aliases to live BrAPI connections, so one agent session can span Breedbase, T3, and Sweetpotatobase in parallel
- **Capability-aware calls** — `CapabilityRegistry` caches the `/serverinfo` profile per connection and guards every tool call against unsupported endpoints before they hit the wire
- **Dataset spillover** — `find_*` tools cap in-context rows at `loadLimit` and transparently persist larger unions (up to 50k rows / 50 pages) as handles in `DatasetStore`; `brapi_manage_dataset` pages / projects / deletes them
- **Async-search transparency** — `brapi_find_genotype_calls` and `brapi_raw_search` handle the `POST /search/{noun}` → `GET /search/{noun}/{id}` 202-retry pattern without the agent needing to know
- **Pedigree DAG walks** — `brapi_walk_pedigree` BFS-traverses ancestry or descendancy with cycle detection, depth limits, and traversal stats — BrAPI only exposes one generation per call
- **Image content** — `brapi_get_image` fetches image bytes inline as MCP `type: image` blocks, preferring `/images/{id}/imagecontent` and falling back to the metadata `imageURL` field
- **Free-text variable ranking** — `OntologyResolver` scores variable records against a query (PUI / name / synonym / trait-class) so `find_variables text:"..."` returns ranked candidates even when the server has no `/ontologies` endpoint
- **Dynamic filter discovery** — static v2.1 filter catalog plus an `extraFilters` passthrough lets agents drive any server-specific filter without schema churn
- **Auth variants in one schema** — tagged-union connection auth covers none / bearer / api-key / SGN session-token exchange in a single input shape
- **Last-resort escape hatches** — `brapi_raw_get` and `brapi_raw_search` pass through to any endpoint with routing nudges pointing at the curated tool when one exists

---

## Getting started

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "brapi": {
      "type": "stdio",
      "command": "bunx",
      "args": ["brapi-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "brapi": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "brapi-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "brapi": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/brapi-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

No environment variables are required for the default BrAPI test server — agents can open connections at runtime via `brapi_connect`. Set `BRAPI_DEFAULT_BASE_URL` (and optional auth variables) if you want to pre-configure a default connection.

### Prerequisites

- [Bun v1.3.11](https://bun.sh/) or higher (or Node.js v22+).
- A BrAPI v2 endpoint to point at — the public [test server](https://test-server.brapi.org/brapi/v2) works out of the box; production servers typically need credentials.

### Installation

1. **Clone the repository:**

    ```sh
    git clone https://github.com/cyanheads/brapi-mcp-server.git
    ```

2. **Navigate into the directory:**

    ```sh
    cd brapi-mcp-server
    ```

3. **Install dependencies:**

    ```sh
    bun install
    ```

4. **Configure environment:**

    ```sh
    cp .env.example .env
    # edit .env and set required vars
    ```

---

## Configuration

Every variable is optional — agents can configure connections entirely at runtime via `brapi_connect`. Set the `BRAPI_DEFAULT_*` variables if you want a default connection without an explicit `brapi_connect` call.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `BRAPI_DEFAULT_BASE_URL` | Default BrAPI v2 base URL including path prefix (e.g. `https://test-server.brapi.org/brapi/v2`). | — |
| `BRAPI_DEFAULT_USERNAME` | Default SGN-family username for session-token auth. | — |
| `BRAPI_DEFAULT_PASSWORD` | Default SGN-family password. | — |
| `BRAPI_DEFAULT_API_KEY` | Default static API key. | — |
| `BRAPI_DEFAULT_API_KEY_HEADER` | Header name carrying the static API key. | `Authorization` |
| `BRAPI_LOAD_LIMIT` | In-context row cap before `find_*` tools spill to `DatasetStore`. | `200` |
| `BRAPI_MAX_CONCURRENT_REQUESTS` | Per-connection concurrency cap for parallel upstream fan-out. | `4` |
| `BRAPI_RETRY_MAX_ATTEMPTS` | Max retries on 429/5xx before surfacing the error. | `3` |
| `BRAPI_REQUEST_TIMEOUT_MS` | Per-request HTTP timeout. | `30000` |
| `BRAPI_SEARCH_POLL_TIMEOUT_MS` | Total budget for async `/search/{noun}/{id}` polling. | `60000` |
| `BRAPI_DATASET_TTL_SECONDS` | TTL for spilled datasets. | `86400` |
| `BRAPI_REFERENCE_CACHE_TTL_SECONDS` | TTL for reference-data cache entries (programs, trials, locations, crops). | `3600` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable OpenTelemetry. | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

---

## Running the server

### Local development

- **Hot-reload dev mode:**

    ```sh
    bun run dev:stdio
    bun run dev:http
    ```

- **Build and run the production version:**

    ```sh
    bun run rebuild
    bun run start:stdio
    # or
    bun run start:http
    ```

- **Run checks and tests:**

    ```sh
    bun run devcheck   # Lint, format, typecheck, security, changelog sync
    bun run test       # Vitest suite
    bun run lint:mcp   # Validate MCP definitions against spec
    ```

### Docker

```sh
docker build -t brapi-mcp-server .
docker run --rm -p 3010:3010 brapi-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/brapi-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

---

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers the 18 tools and inits the seven services. |
| `src/config` | Server-specific environment variable parsing with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) and shared helpers (`orientation-envelope`, `find-helpers`, `connect-auth-schema`, `raw-routing-hints`). |
| `src/services/brapi-client` | HTTP client with retry, concurrency capping, async-search polling, private-IP guard, and binary fetch. |
| `src/services/brapi-filters` | Static BrAPI v2.1 filter catalog. |
| `src/services/capability-registry` | Per-connection capability profile cache. |
| `src/services/dataset-store` | Tenant-scoped dataset handles for spilled `find_*` results. |
| `src/services/ontology-resolver` | Free-text → ontology-candidate matcher powering `brapi_find_variables` ranking. |
| `src/services/reference-data-cache` | Cache for programs, trials, locations, crops. |
| `src/services/server-registry` | Alias → live BrAPI connection map with auth resolution. |
| `tests/` | Unit and integration tests mirroring `src/`. |
| `docs/design.md` | End-to-end surface design (current + planned tools). |

---

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools in the `tools` array of `createApp()` in `src/index.ts`
- Wrap upstream calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

---

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

---

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
