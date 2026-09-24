<div align="center">
  <h1>@cyanheads/brapi-mcp-server</h1>
  <p><b>A collaborative BrAPI v2.1 workspace for multi-agent research via MCP. Search studies, germplasm, genotypes, & more - across Breedbase, T3, Sweetpotatobase, & any BrAPI v2-compliant server.</b>
  <div>25 Tools • 6 Resources • 2 Prompts</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.8.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/cyanheads/brapi-mcp-server/pkgs/container/brapi-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/brapi-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/brapi-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/) [![Status](https://img.shields.io/badge/Status-Beta-yellow.svg?style=flat-square)](./CHANGELOG.md)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/brapi-mcp-server/releases/latest/download/brapi-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=brapi-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvYnJhcGktbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22brapi-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads/brapi-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://brapi.caseyjhand.com/mcp](https://brapi.caseyjhand.com/mcp)

</div>

---

## Overview

Plant-breeding data from any BrAPI (Breeding API) v2 server, including Breedbase instances such as Cassavabase and Sweetpotatobase and the Triticeae Toolbox (T3), with several servers connected at once under named aliases. Search studies, germplasm, observations, genotype calls, images, locations, and variants, walk pedigrees, and build phenotype and genotype matrices; results past the per-call cap spill into a DuckDB dataframe workspace that agents in the same session query with SQL. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `brapi_connect` | Authenticate to a BrAPI v2 server, register it under an alias, and return the orientation envelope |
| `brapi_server_info` | Re-fetch the orientation envelope for a registered alias, optionally refreshing capabilities |
| `brapi_describe_filters` | List valid filter names for an endpoint, for use in any finder's `extraFilters` |
| `brapi_find_studies` | Find studies by crop, trial type, season, location, or program |
| `brapi_get_study` | Fetch a study with program, trial, and location resolved, plus companion counts |
| `brapi_find_germplasm` | Find germplasm by name, synonym, accession, PUI, crop, or free text |
| `brapi_get_germplasm` | Fetch a germplasm with attributes, direct parents, and companion counts |
| `brapi_walk_pedigree` | Walk ancestry or descendancy as a deduplicated DAG with cycle detection |
| `brapi_find_variables` | Find observation variables by name, trait class, or ontology term, with free-text ranking |
| `brapi_find_observations` | Pull observation records by study, germplasm, variable, season, or unit |
| `brapi_find_images` | Find image metadata by unit, observation, study, ontology term, or MIME type |
| `brapi_get_image` | Fetch up to 5 images inline as image content blocks |
| `brapi_find_locations` | Find research stations by country, type, abbreviation, or bounding box |
| `brapi_find_variants` | Find variants by variant set, reference, or genomic region |
| `brapi_find_genotype_calls` | Pull genotype calls through async search, bounded by a deployment pull ceiling |
| `brapi_dataframe_describe` | List dataframes, or describe one with columns, row count, and provenance |
| `brapi_dataframe_query` | Run read-only SQL across dataframes |
| `brapi_dataframe_drop` | _Opt-in._ Drop a dataframe by name |
| `brapi_dataframe_export` | _Opt-in, stdio-only._ Export a dataframe to disk as CSV, Parquet, or JSON |
| `brapi_build_phenotype_matrix` | Build a germplasm × trait matrix from one or more studies as a dataframe |
| `brapi_germplasm_performance` | Per-variable aggregates (n, mean, median, sd, min, max) for one germplasm across its studies |
| `brapi_export_genotype_matrix` | Pivot a variant set's calls into a germplasm × variant matrix, with VCF-lite or PLINK text |
| `brapi_submit_observations` | _Opt-in._ Two-phase observation write: `preview` validates, `apply` confirms and writes |
| `brapi_raw_get` | Passthrough to any `GET /{path}` endpoint no curated tool covers |
| `brapi_raw_search` | Passthrough to any `POST /search/{noun}` endpoint, with async polling handled |

### Resources

| Resource | Description |
|:---|:---|
| `brapi://server/info` | Orientation envelope for the default connection |
| `brapi://calls` | Raw capability profile (`/serverinfo` + `/calls`) for the default connection |
| `brapi://study/{studyDbId}` | One study with program, trial, and location resolved |
| `brapi://germplasm/{germplasmDbId}` | One germplasm with attributes and parents |
| `brapi://filters/{endpoint}` | Filter catalog for one endpoint |
| `brapi://variable/{observationVariableDbId}` | One observation variable (trait, scale, method, ontology) |

Every resource reads the `default` connection and mirrors a tool; tool-only clients and multi-server workflows use the tools.

### Prompts

| Prompt | Description |
|:---|:---|
| `brapi_eda_study` | Exploratory-data-analysis playbook for one study, ending in a structured report |
| `brapi_meta_analysis` | Cross-study meta-analysis playbook for a germplasm × trait combination |

## Capability reference

### `brapi_connect` <sub>tool</sub>

- `baseUrl` and `auth` are optional: omitted values come from `BRAPI_<ALIAS>_*` env vars, the built-in aliases, then `BRAPI_DEFAULT_*` (see [Per-alias credentials](#per-alias-credentials)); `alias` (default `default`, pattern `^[a-zA-Z0-9_-]+$`) keeps several servers registered at once; `auth.mode` is `none`, `bearer`, `api_key`, `sgn` (Breedbase `/token` exchange), or `oauth2` (client credentials)
- Returns the orientation envelope: `server` identity, `auth` summary, `capabilities` (`supported`, `notableGaps`), active `dialect`, `content` counts, `attribution` for built-in servers, and `nextToolSuggestions` naming the entry-point finders this server can serve
- Typed errors: `auth_session_required`, `auth_base_url_mismatch`, `alias_base_url_unset`, `auth_token_exchange_failed`, `auth_no_access_token`, `upstream_unauthorized`, `upstream_forbidden`; a failed connect leaves any earlier registration under the alias intact

---

### `brapi_server_info` <sub>tool</sub>

- `alias` optional; `forceRefresh` (default `false`) refetches the capability profile instead of reading the cache
- Returns the same orientation envelope as `brapi_connect`

---

### `brapi_describe_filters` <sub>tool</sub>

- `endpoint` is one of `studies`, `germplasm`, `observations`, `variables`, `images`, `variants`, `locations`; `unknown_endpoint` carries `availableEndpoints`
- Each filter has `name`, `type`, `description`, and `example`; the catalog follows the v2.1 spec, and individual servers may honor a subset

---

### `brapi_find_studies` <sub>tool</sub>

- Filters: `crop`, `trialTypes`, `seasons`, `locations`, `programs`, `trials`, `studyNames`, `active`
- `distributions` over `programName`, `studyType`, `seasons`, `locationName`, `commonCropName`

---

### `brapi_get_study` <sub>tool</sub>

- `studyDbId` required; resolves `program`, `trial`, and `location` inline; `study_not_found` when the upstream has no such study
- Companion counts `observationCount`, `observationUnitCount`, `variableCount`; a count the server can't scope to the study is omitted with a warning, never reported as the server-wide total

---

### `brapi_find_germplasm` <sub>tool</sub>

- Filters: `names`, `germplasmDbIds`, `germplasmPUIs`, `accessionNumbers`, `crops`, `synonyms`, `collections`, `genus`, `species`; `text` is a client-side substring match on name, accession, display name, and synonyms that drops non-matching rows, so pair it with a server-side filter
- `distributions` over `commonCropName`, `genus`, `species`, `collection`, `countryOfOriginCode`

---

### `brapi_get_germplasm` <sub>tool</sub>

- `germplasmDbId` required; returns `attributes` and direct `parents`; `germplasm_not_found` when the upstream has no such germplasm
- Companion counts `studyCount`, `directParentCount`, `directDescendantCount`

---

### `brapi_walk_pedigree` <sub>tool</sub>

- 1–20 root `germplasmDbIds`; `direction` is `ancestors` (default), `descendants`, or `both`; `maxDepth` 1–10 (default 3); the walk stops at 1,000 nodes and sets `truncated`
- Deduplicated `nodes` and `edges` with `depthReached`, `rootCount`, `leafCount`, `cycleCount`, `deadEndCount`; past `loadLimit`, both sets spill to `nodesDataframe` and `edgesDataframe`

---

### `brapi_find_variables` <sub>tool</sub>

- Filters: `variables`, `variableNames`, `variablePUIs`, `traitClasses`, `ontologies`, `studies`, `methods`, `scales`, `crop`
- `text` ranks the full result set and moves matches to the top without dropping the rest; `ontologyCandidates` lists the ranked matches, each with `source` (`puiMatch`, `nameMatch`, `synonymMatch`, `traitClassMatch`)
- `distributions` over `ontologyDbId`, `traitClass`, `scaleName`

---

### `brapi_find_observations` <sub>tool</sub>

- Filters: `studies`, `germplasm`, `variables`, `observationUnits`, `observations`, `seasons`, `programs`, `trials`, `observationLevels`, `timestampFrom` / `timestampTo`
- `distributions` over `observationVariableName`, `studyName`, `germplasmName`, `observationLevel`, `season`

---

### `brapi_find_images` <sub>tool</sub>

- Filters: `images`, `observationUnits`, `observations`, `studies`, `imageFileNames`, `mimeTypes`, `descriptiveOntologyTerms`; returns metadata only, with bytes via `brapi_get_image`
- `distributions` over `mimeType`, `studyName`, `observationUnitName`, `descriptiveOntologyTerms`

---

### `brapi_get_image` <sub>tool</sub>

- 1–5 `imageDbIds` per call, up to 20 MB each; `images_unsupported` when the server doesn't advertise `/images`
- Each image's `source` is `imagecontent` or the `imageURL` fallback; failed fetches land in per-image `errors[]` and suspect payloads (a non-image MIME type) in `warnings[]`, so a partial batch still returns

---

### `brapi_find_locations` <sub>tool</sub>

- Filters: `locations`, `locationNames`, `countryCodes` (ISO 3166-1 alpha-3), `countryNames` (English names resolved to alpha-3), `locationTypes`, `abbreviations`; optional `bbox` needs all four of `minLat`, `maxLat`, `minLon`, `maxLon` and applies after the fetch
- `distributions` over `countryCode`, `locationType`; `coordinateAxisOrder: "swapped"` reports a server that stores coordinates as `[lat, lon]`

---

### `brapi_find_variants` <sub>tool</sub>

- Filters: `variantSets`, `variants`, `references`, and a genomic region of `referenceName` + `start` (inclusive) / `end` (exclusive), 1-based
- `distributions` over `variantType`, `referenceName`, `variantSetDbId`

---

### `brapi_find_genotype_calls` <sub>tool</sub>

- Needs at least one of `variantSetDbId`, `variantSetDbIds`, `germplasmDbIds`, `callSetDbIds`, `variantDbIds` (`no_filters` otherwise); optional `callFormat` (`VCF`, `FLAPJACK`, `DARTSEQ`, `JSON`)
- `distributions` over `callSetName`, `variantName`, `variantSetDbId`, plus the server's `callFormatting`; `search_endpoint_disabled` when the active dialect marks `POST /search/calls` as dead
- The upstream pull stops at `BRAPI_GENOTYPE_CALLS_MAX_PULL` (default 100,000) and sets `truncated`; `loadLimit` bounds only the inline preview

---

### `brapi_dataframe_describe` <sub>tool</sub>

- `dataframe` optional: omit to list every dataframe, or name one for columns, row count, and provenance (originating tool, `baseUrl`, query, expiry), which only auto-registered `df_*` tables carry
- Listing without a name fails with `list_all_disabled_on_shared_http` on an HTTP deployment where every caller shares the `default` tenant

---

### `brapi_dataframe_query` <sub>tool</sub>

- `sql` is a single `SELECT`; writes, DDL, `COPY`, `PRAGMA`, `ATTACH`, file reads, and system-catalog reads fail as `sql_rejected`, with the specific reason in `data.gateReason`
- Returns `rowCount`, typed `columns`, and `rows` bounded by `preview` (≤1,000), `rowLimit`, and `BRAPI_CANVAS_MAX_ROWS`; `truncated`, `shown`, `cap`, and `notice` disclose the cut
- `registerAs` (identifier, ≤63 characters) saves the full result as a new dataframe for chaining

---

### `brapi_dataframe_drop` <sub>tool</sub>

- `dataframe` required; returns `dropped: false`, not an error, for an unknown name
- Registered only when `BRAPI_CANVAS_DROP_ENABLED=true`

---

### `brapi_dataframe_export` <sub>tool</sub>

- `format` is `csv`, `parquet`, or `json`; optional `columns` or `sql` (mutually exclusive) and `filename` (no path separators or `..`; omit for a timestamp-suffixed default); returns the absolute `path`, `sizeBytes`, and `rowCount`
- Typed errors: `export_dir_unset`, `dataframe_not_found`, `invalid_filename`, `mutually_exclusive_projection`
- Registered only over stdio with `BRAPI_EXPORT_DIR` set

---

### `brapi_build_phenotype_matrix` <sub>tool</sub>

- `studies` required (≥1), optional `variables` / `germplasm` subsets; `shape` `wide` (default) or `long`; `aggregate` `mean` (default), `median`, `first`, or `all` (always long form); `loadLimit` caps observations per study
- Returns the matrix as a dataframe plus `observationCount`, `germplasmCount`, `variableCount`, and `variableLegend` mapping SQL-safe column names to variable names; `truncated` / `cap` flag a study that hit `loadLimit`; `no_observation_path` when neither `/observations` nor `/observationunits` returns data

---

### `brapi_germplasm_performance` <sub>tool</sub>

- `germplasmDbId` required; discovers its studies (up to 200) unless `studyDbIds` is supplied; optional `variables` subset; `germplasm_not_found` when the upstream has no such germplasm
- `perVariable` rows carry `n`, `mean`, `median`, `sd` (omitted when n < 2 or non-numeric), `min`, `max`, `studyCount`, `studyDbIds`, and `seasons`

---

### `brapi_export_genotype_matrix` <sub>tool</sub>

- `variantSetDbId` required (`no_filters` otherwise), optional `germplasmDbIds`; `format` is `matrix-json`, `vcf-lite` (adds `vcf` text), or `plink` (adds `ped` / `map` text), and every format registers the germplasm × variant dataframe
- `variantColumnLegend` maps SQL-safe column names back to variant IDs; `search_endpoint_disabled` when the active dialect marks `POST /search/calls` as dead
- `maxCalls` / `maxColumns` can lower `BRAPI_GENOTYPE_CALLS_MAX_PULL` / `BRAPI_GENOTYPE_MATRIX_MAX_COLUMNS` but never raise them; `truncated` means a ceiling fired, and `warnings` names which

---

### `brapi_submit_observations` <sub>tool</sub>

- `studyDbId` plus 1–5,000 `observations`; a row with `observationDbId` updates via `PUT`, one without creates via `POST`, and nothing is deleted
- `mode: "preview"` (default) returns `valid`, `invalid`, `routing` counts, and `perRowWarnings` without writing; `mode: "apply"` asks the caller to confirm (`force: true` skips it), writes, and returns `posted`, `updated`, and `studyObservationCount`; failures are `observations_unsupported`, `study_not_found`, `post_unsupported`, `put_unsupported`, and `user_declined`
- Registered only when `BRAPI_ENABLE_WRITES=true`; requires the `brapi:write:observations` scope

---

### `brapi_raw_get` <sub>tool</sub>

- `path` is a relative route such as `/samples` (a full URL fails as `cross_origin_path`); optional `params` and `loadLimit`
- Returns the raw envelope (`url`, `metadata`, `result`) plus a `suggestion` when a curated tool covers the endpoint; list results past `loadLimit` spill to a dataframe unless `params.page` / `params.pageSize` drive paging

---

### `brapi_raw_search` <sub>tool</sub>

- `noun` (e.g. `observations`, `calls`, `germplasm`) and a `body` posted verbatim to `POST /search/{noun}`; async searches are polled to completion
- Returns `kind` (`sync` or `async`), `searchResultsDbId`, `result`, and a `suggestion`; spills like `brapi_raw_get` unless `body.page` / `body.pageSize` is set; `search_endpoint_disabled` when the active dialect marks the route as dead

---

### `brapi://server/info` <sub>resource</sub>

- Orientation envelope for the `default` connection as `application/json`
- Same payload as `brapi_server_info` called with no arguments

---

### `brapi://calls` <sub>resource</sub>

- Capability profile for the `default` connection: supported services with their HTTP methods and versions, plus crops
- Reflects what `/serverinfo` + `/calls` returned at the last load

---

### `brapi://study/{studyDbId}` <sub>resource</sub>

- Same payload as `brapi_get_study` on the `default` connection
- `study_not_found` when the upstream has no such study

---

### `brapi://germplasm/{germplasmDbId}` <sub>resource</sub>

- Same payload as `brapi_get_germplasm` on the `default` connection
- `germplasm_not_found` when the upstream has no such germplasm

---

### `brapi://filters/{endpoint}` <sub>resource</sub>

- Same payload as `brapi_describe_filters`; `unknown_endpoint` for an endpoint outside the catalog
- Listing `brapi://filters` returns one resource per endpoint

---

### `brapi://variable/{observationVariableDbId}` <sub>resource</sub>

- The `/variables/{id}` record (trait, scale, method, ontology) on the `default` connection
- `variable_not_found` when the upstream has no such variable

---

### `brapi_eda_study` <sub>prompt</sub>

- Arguments: `studyDbId` required; `alias` optional
- Returns one user message: a six-step playbook (orient, variables, coverage, missing data, IQR outliers, optional pedigree walk) ending in a markdown report with recommended next steps

---

### `brapi_meta_analysis` <sub>prompt</sub>

- Arguments: `germplasmDbIds` (comma-separated) and `traitName` required; `alias` optional, run once per alias for multi-server analyses
- Returns one user message: a seven-step playbook (resolve the trait, discover studies, build the observation table, harmonize scales, summarize per study and across studies, optional pedigree walk) ending in a report that cites every dataframe handle or filter map used

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

BrAPI-specific:

- Shared finder contract: the seven filter finders (studies, germplasm, variables, observations, images, locations, variants) take `alias`, `loadLimit`, and `extraFilters` (keys from `brapi_describe_filters`), and return `results`, `hasMore`, `distributions`, and an optional `dataframe` handle
- Dataframe spillover: past `loadLimit`, finders page the rest of the result (up to 50 pages and 50,000 rows) into a DuckDB `df_<uuid>` table and return its handle
- Dialect adapters (`spec`, `brapi-test`, `breedbase`, `cassavabase`, `bms`), detected per connection, translate v2.1 plural filters into the form each server family honors, drop filters it ignores, and switch to `POST /search/{noun}` when a `GET` would narrow a multi-value filter; `BRAPI_<ALIAS>_DIALECT` pins one
- Several connections at once under named aliases, with three public Breedbase servers built in and credentials resolved per alias from env vars, so they stay out of the LLM context
- Capability-aware calls: each connection's `/serverinfo` + `/calls` profile is cached and checked before a tool calls an endpoint; a per-connection concurrency cap and exponential-backoff retries cover 429/5xx

Agent-friendly output:

- Typed failures: every connection-scoped tool and resource fails with `unknown_alias` until `brapi_connect` registers the alias, and a filter finder or `brapi_build_phenotype_matrix` fails with `all_filters_dropped` instead of widening to an unfiltered pull when the dialect drops every filter supplied
- Query echo on every finder: `totalCount`, `returnedCount`, the exact `appliedFilters` sent upstream, a `refinementHint` on broad results, an empty-result `notice`, and `warnings`
- Graceful partial failure: `brapi_get_image` returns per-image `errors[]` and `warnings[]` rows instead of failing the batch
- Discriminated outputs: `brapi_submit_observations` returns a `mode`-discriminated result (`preview` / `apply`), `brapi_raw_search` reports `kind`, and `brapi_get_image` reports each image's `source`

### Working with dataframes

When a finder's upstream total exceeds `loadLimit`, the response carries a `dataframe` handle: `tableName`, `rowCount`, `columns`, `createdAt`, `expiresAt`, plus `truncated`, `maxRows`, and `totalCount` when a cap fired. Columns renamed to pass the SQL identifier check map back to their upstream keys in `columnLegend`.

```text
1. brapi_find_observations { studies: ["s-422"] }
   → first-page rows inline + dataframe.tableName = "df_<uuid>" (when totalCount > loadLimit)
2. brapi_dataframe_describe { dataframe: "df_<uuid>" }
   → schema + provenance (originating tool, baseUrl, query, expiry)
3. brapi_dataframe_query { sql: "SELECT germplasmName, value FROM df_<uuid> WHERE observationVariableDbId = 'V1' LIMIT 100" }
   → typed columns + bounded rows
```

Dataframe names are capability tokens, not row-level ACLs: anyone holding a name in the same session or tenant bucket (see [Deployment shapes](#deployment-shapes)) can read its rows. Provenance lasts `BRAPI_DATASET_TTL_SECONDS` (default 24h); set `BRAPI_CANVAS_DROP_ENABLED=true` to expose `brapi_dataframe_drop` for explicit cleanup.

## Getting started

### Public Hosted Instance

A public instance is available at `https://brapi.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "brapi-mcp-server": {
      "type": "streamable-http",
      "url": "https://brapi.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "brapi-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/brapi-mcp-server@latest"],
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
    "brapi-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/brapi-mcp-server@latest"],
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
    "brapi-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/brapi-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

No env vars are required: the built-in aliases (`bti-cassava`, `bti-sweetpotato`, `bti-breedbase-demo`) connect as-is, and `brapi_connect` accepts any other BrAPI v2 URL at runtime. For servers that need a login, set credentials as env vars so passwords, tokens, and keys stay out of the LLM context (see [Per-alias credentials](#per-alias-credentials)).

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- [`@duckdb/node-api`](https://www.npmjs.com/package/@duckdb/node-api), installed as a regular dependency, with prebuilt native bindings for macOS, Linux (glibc and musl), and Windows on x64 and arm64. Cloudflare Workers is not supported.

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
# edit .env if you need credentials or non-default settings
```

## Configuration

Every variable is optional.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `BRAPI_DEFAULT_BASE_URL` | Base URL for the `default` alias (e.g. `https://test-server.brapi.org/brapi/v2`). | — |
| `BRAPI_DEFAULT_*` credentials | One credential family for the `default` alias; see [Per-alias credentials](#per-alias-credentials). | — |
| `BRAPI_DEFAULT_API_KEY_HEADER` | API-key header for the `default` alias, and the fallback header for any `api_key` auth that names none. | `Authorization` |
| `BRAPI_BUILTIN_ALIASES_DISABLED` | Comma-separated built-in aliases to remove (case-insensitive). | — |
| `BRAPI_LOAD_LIMIT` | Default inline row cap for finders before spilling to a dataframe. | `1000` |
| `BRAPI_PAGE_SIZE` | Upstream `pageSize` for spillover page walks. The dataframe ceiling is `pageSize × 50`, capped at 50,000 rows. | `1000` |
| `BRAPI_MAX_CONCURRENT_REQUESTS` | Per-connection concurrency cap. | `4` |
| `BRAPI_RETRY_MAX_ATTEMPTS` / `BRAPI_RETRY_BASE_DELAY_MS` | Retries on 429/5xx and the exponential-backoff base delay. | `3` / `500` |
| `BRAPI_REQUEST_TIMEOUT_MS` | Per-request HTTP timeout. | `30000` |
| `BRAPI_COMPANION_TIMEOUT_MS` | Timeout for non-critical enrichment calls (FK lookups, count probes), which also skip retries. | `8000` |
| `BRAPI_SEARCH_POLL_TIMEOUT_MS` / `BRAPI_SEARCH_POLL_INTERVAL_MS` | Async `/search` polling budget and interval. | `60000` / `1000` |
| `BRAPI_DATASET_TTL_SECONDS` | Lifetime of dataframe provenance (the handle's `expiresAt`). | `86400` |
| `BRAPI_REFERENCE_CACHE_TTL_SECONDS` | TTL for cached capability profiles and reference data (programs, trials, locations, crops). | `3600` |
| `BRAPI_ALLOW_PRIVATE_IPS` | Allow RFC 1918 / loopback targets. Dev only. | `false` |
| `BRAPI_SESSION_ISOLATION` | Scope connections and the default canvas to the MCP session when one exists; `false` shares them across the tenant. See [Deployment shapes](#deployment-shapes). | `true` |
| `BRAPI_ENABLE_WRITES` | **Feature flag.** Registers `brapi_submit_observations`. | `false` |
| `BRAPI_CANVAS_DROP_ENABLED` | **Feature flag.** Registers `brapi_dataframe_drop`. | `false` |
| `BRAPI_EXPORT_DIR` | **Feature flag.** Output directory for `brapi_dataframe_export`; setting it registers the tool, over stdio only. | — |
| `BRAPI_CANVAS_MAX_ROWS` / `BRAPI_CANVAS_QUERY_TIMEOUT_MS` | Response row cap and per-query timeout for `brapi_dataframe_query`. | `10000` / `30000` |
| `BRAPI_GENOTYPE_CALLS_MAX_PULL` | Upstream call ceiling per `brapi_find_genotype_calls` or `brapi_export_genotype_matrix` call. Max `500000`. | `100000` |
| `BRAPI_GENOTYPE_MATRIX_MAX_COLUMNS` | Variant-column ceiling per `brapi_export_genotype_matrix` matrix. Max `500000`. | `10000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode. This server requires `stateful` (apply-mode writes confirm over the session, and isolation keys off it); an HTTP start fails if it resolves to `stateless`. | `stateful` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

### Per-alias credentials

`brapi_connect` fills `baseUrl` and `auth` from env vars when the agent omits them, in this order:

1. **Agent input**, within the pairing rules below.
2. **Per-alias env vars**: `BRAPI_<ALIAS>_*`, uppercased with hyphens as underscores (`my-server` → `BRAPI_MY_SERVER_*`).
3. **Built-in aliases**: see [Built-in aliases](#built-in-aliases).
4. **`BRAPI_DEFAULT_BASE_URL`**, for an alias with no URL or credentials of its own.

Env credentials go only to the server configured with them:

- An alias's credentials pair with its `BRAPI_<ALIAS>_BASE_URL`, else its enabled built-in URL. A caller `baseUrl` that points elsewhere fails with `auth_base_url_mismatch`. Credentials with no URL of their own, including those left behind by a built-in disabled via `BRAPI_BUILTIN_ALIASES_DISABLED`, fail with `alias_base_url_unset` and are never sent to `BRAPI_DEFAULT_BASE_URL`.
- `BRAPI_DEFAULT_*` credentials attach only when the resolved URL is `BRAPI_DEFAULT_BASE_URL`; an alias pointed anywhere else connects without auth unless it has credentials of its own. With no `BRAPI_DEFAULT_BASE_URL` set, default credentials fail with `alias_base_url_unset`.

URLs compare after normalizing host case, default ports, and trailing slashes. Caller-supplied `auth` is never mixed with env credentials.

Each alias carries one credential family, and the auth mode follows from which fields are set. Mixing families within an alias raises a `ValidationError`.

| Vars set | Resolved `mode` |
|:---------|:----------------|
| `_USERNAME` + `_PASSWORD` | `sgn` (Breedbase `/token` exchange) |
| `_BEARER_TOKEN` | `bearer` |
| `_API_KEY` (+ optional `_API_KEY_HEADER`) | `api_key` |
| `_OAUTH_CLIENT_ID` + `_OAUTH_CLIENT_SECRET` (+ optional `_OAUTH_TOKEN_URL`) | `oauth2` |
| _(none set)_ | `none` |

`BRAPI_<ALIAS>_DIALECT` pins the dialect adapter (`spec`, `brapi-test`, `breedbase`, `cassavabase`, `bms`) when detection picks the wrong one; `auto` or unset detects it.

```sh
# .env — attach write credentials to the built-in 'bti-cassava' alias
BRAPI_BTI_CASSAVA_USERNAME=alice
BRAPI_BTI_CASSAVA_PASSWORD=...
# (BASE_URL omitted — the built-in registry covers it)

# Static API key as alias 'prod'
BRAPI_PROD_BASE_URL=https://my-brapi.example.com/brapi/v2
BRAPI_PROD_API_KEY=...
BRAPI_PROD_API_KEY_HEADER=X-API-Key
```

The agent then calls `brapi_connect({ alias: 'bti-cassava' })` with no `baseUrl`, no `auth`, and no secrets in the prompt.

### Built-in aliases

These public BrAPI v2 endpoints connect with no configuration. Their orientation envelope carries license, citation, and homepage in an `attribution` block ([Creative Commons Attribution](https://creativecommons.org/licenses/by/4.0/)).

| Alias | Upstream | Hosted by | Crop | Notes |
|:------|:---------|:----------|:-----|:------|
| `bti-cassava` | [cassavabase.org](https://cassavabase.org/) | Boyce Thompson Institute | Cassava | NextGen Cassava |
| `bti-sweetpotato` | [sweetpotatobase.org](https://sweetpotatobase.org/) | Boyce Thompson Institute | Sweet potato | |
| `bti-breedbase-demo` | [breedbase.org](https://breedbase.org/) | Boyce Thompson Institute | _Demo_ | Sample data only, for onboarding and tests |

The registry holds only servers verified for anonymous reads. Servers that require login, including the Triticeae Toolbox (T3) wheat, oat, and barley hosts, connect through `BRAPI_<ALIAS>_BASE_URL` plus credentials (see [`.env.example`](./.env.example)).

`BRAPI_<ALIAS>_BASE_URL` overrides a built-in URL, e.g. to point `bti-sweetpotato` at a staging mirror via `BRAPI_BTI_SWEETPOTATO_BASE_URL`. `BRAPI_<ALIAS>_USERNAME` and friends attach credentials on top of the built-in URL; each Breedbase instance has its own user table, so write access needs a separate account on each. `BRAPI_BUILTIN_ALIASES_DISABLED=bti-cassava,bti-breedbase-demo` removes entries.

**Citation:** all three built-ins reference Morales et al. 2022, _"Breedbase: a digital ecosystem for modern plant breeding."_ G3 12(7): jkac078. [doi:10.1093/g3journal/jkac078](https://doi.org/10.1093/g3journal/jkac078).

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start            # transport from MCP_TRANSPORT_TYPE (stdio default)
  bun run start:stdio
  bun run start:http

  # Or run from source with hot reload
  bun --watch src/index.ts
  ```

- **Run checks and tests**:

  ```sh
  bun run devcheck         # Lint, format, typecheck, security, changelog sync
  bun run test             # Vitest suite
  bun run lint:mcp         # Validate MCP definitions
  ```

### Docker

```sh
docker build -t brapi-mcp-server .
docker run --rm -p 3010:3010 brapi-mcp-server
```

The image defaults to HTTP transport, `stateful` session mode, and logs to `/var/log/brapi-mcp-server`. OpenTelemetry peer dependencies are installed by default; build with `--build-arg OTEL_ENABLED=false` to omit them.

### Deployment shapes

Two kinds of state scope by tenant and, by default, by MCP session: **connection state** (registered aliases and exchanged upstream tokens) and **dataframes** (`df_<uuid>` tables, usable by anyone who holds the name within its bucket). Three configurations set where those buckets end:

| Shape | Settings | Isolation | Best for |
|:------|:---------|:----------|:---------|
| **Per-session (default)** | `MCP_AUTH_MODE=none` + HTTP stateful + `BRAPI_SESSION_ISOLATION=true` | Each MCP session gets its own connections and canvas. Requests without a session share one tenant-wide namespace, so `brapi_connect` refuses their caller-supplied `auth` with `auth_session_required`; keyless connections and operator env credentials still work. | Multi-user hosting without SSO |
| **Per-user credentials** | `MCP_AUTH_MODE=jwt` or `oauth` (+ HTTP stateful) | Each user's JWT `tid` claim is its own tenant; sessions sub-scope inside it when isolation is on. | Multi-user hosting with institutional SSO; the strongest separation |
| **Shared workspace** | `MCP_AUTH_MODE=none` + `BRAPI_SESSION_ISOLATION=false` | All callers share one tenant's connections and canvas. | One researcher running parallel agents on shared upstream credentials |

Stdio is always a single session. Clients on MCP protocol revision 2026-07-28 carry no session on any transport, so outside the per-user-credentials shape they land in the shared tenant workspace, where re-registering an alias re-points every such caller's later calls to it.

On HTTP without per-user auth, `brapi_dataframe_describe` won't list dataframes without a name, and `brapi_dataframe_query` rejects system-catalog reads in every shape, so a caller without a known `df_<uuid>` name can't enumerate other callers' tables.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point: registers tools (behind their feature flags), resources, and prompts, and inits services. |
| `src/config` | Server env parsing (Zod), per-alias credential resolution, and the built-in alias registry. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) and shared helpers. Twenty-five tools across connection, retrieval, analysis, write, and raw passthrough. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/mcp-server/prompts` | Prompt definitions (`*.prompt.ts`). |
| `src/services` | BrAPI client, dialect adapters, filter catalog, canvas bridge, capability registry, ISO country resolver, ontology resolver, reference-data cache, server registry. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for tenant-scoped storage — no `console`, no direct persistence access
- Add new tools to the matching group in `src/mcp-server/tools/definitions/index.ts`; `src/index.ts` composes the groups behind their feature flags
- Wrap upstream calls: validate raw → normalize → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
