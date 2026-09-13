<div align="center">
  <h1>@cyanheads/brapi-mcp-server</h1>
  <p><b>A collaborative BrAPI v2.1 workspace for multi-agent research via MCP. Search studies, germplasm, genotypes, & more - across Breedbase, T3, Sweetpotatobase, & any BrAPI v2-compliant server.</b>
  <div>25 Tools • 6 Resources • 2 Prompts</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.7.12-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/cyanheads/brapi-mcp-server/pkgs/container/brapi-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/brapi-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/brapi-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/) [![Status](https://img.shields.io/badge/Status-Beta-yellow.svg?style=flat-square)](./CHANGELOG.md)

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

BrAPI v2.1 (the Breeding API) data from Breedbase, T3, Sweetpotatobase, and any BrAPI v2-compliant server. Search studies, germplasm, observations, genotypes, images, locations, and variants — result sets beyond the per-call cap spill into a DuckDB-backed dataframe workspace that agents on the same session can query with SQL or hand off by name, and connections to multiple upstream servers can be held open in parallel under named aliases. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `brapi_connect` | Authenticate to a BrAPI v2 server, register the connection under an alias, and return the full orientation envelope in one call. |
| `brapi_server_info` | Re-fetch the orientation envelope for a registered alias, optionally forcing a capability refresh. |
| `brapi_describe_filters` | List valid filter names for a BrAPI endpoint — companion lookup for `extraFilters` on any `find_*` tool. |
| `brapi_find_studies` | Find studies by crop, trial type, season, location, or program, with distributions and dataframe spillover. |
| `brapi_get_study` | Fetch a study with program/trial/location resolved and companion counts (observations, units, variables). |
| `brapi_find_germplasm` | Find germplasm by name, synonym, accession, PUI, crop, or free text, with distributions and dataframe spillover. |
| `brapi_get_germplasm` | Fetch a germplasm with attributes, direct parents, and companion counts (studies, parents, descendants). |
| `brapi_walk_pedigree` | BFS-walk ancestry or descendancy as a deduplicated DAG with cycle detection and depth limits. |
| `brapi_find_variables` | Find observation variables by name, trait class, ontology term, or free text, ranked via `OntologyResolver`. |
| `brapi_find_observations` | Pull observation records by study, germplasm, variable, season, or unit, with dataframe spillover. |
| `brapi_find_images` | Filter image metadata by unit, observation, study, ontology term, or MIME type. Bytes via `brapi_get_image`. |
| `brapi_get_image` | Fetch image bytes for up to 5 `imageDbId`s inline as `type: image` content blocks. |
| `brapi_find_locations` | Find research stations by country, type, abbreviation, or bounding box. |
| `brapi_find_variants` | Find variant records by variant set, reference, or genomic region. |
| `brapi_find_genotype_calls` | Pull genotype calls via async-search polling, bounded by an upstream pull ceiling. |
| `brapi_dataframe_describe` | List dataframes (or describe one) with column schema, row counts, and originating-source provenance. |
| `brapi_dataframe_query` | Run read-only SQL across in-memory dataframes (DuckDB-backed). |
| `brapi_dataframe_drop` | _Opt-in._ Drop a dataframe by name. Idempotent. |
| `brapi_dataframe_export` | _Opt-in, stdio-only._ Export a dataframe to disk as CSV, Parquet, or JSON. |
| `brapi_build_phenotype_matrix` | Build a germplasm × trait matrix from one or more studies, materialized as a canvas dataframe. |
| `brapi_germplasm_performance` | Per-variable performance aggregates (n, mean, median, sd, min, max) for a single germplasm across its studies. |
| `brapi_export_genotype_matrix` | Export genotype calls for a variant set as a germplasm × variant matrix, plus VCF-lite / PLINK serialization. |
| `brapi_submit_observations` | _Opt-in._ Two-phase observation write — `preview` validates, `apply` confirms and writes. |
| `brapi_raw_get` | Passthrough to any BrAPI `GET /{path}` endpoint not covered by a curated tool. |
| `brapi_raw_search` | Passthrough to any `POST /search/{noun}` endpoint, with async polling handled transparently. |

### Resources

URI-addressable mirrors of the curated tool surface for clients that prefer resources. All resources use the default connection — multi-server workflows route through tools.

| Resource | Description |
|:---|:---|
| `brapi://server/info` | Orientation envelope for the default connection — mirrors `brapi_server_info`. |
| `brapi://calls` | Raw capability profile (`/serverinfo` + `/calls`) for the default connection. |
| `brapi://study/{studyDbId}` | Single study record with program/trial/location resolved — mirrors `brapi_get_study`. |
| `brapi://germplasm/{germplasmDbId}` | Single germplasm record with attributes and parents — mirrors `brapi_get_germplasm`. |
| `brapi://filters/{endpoint}` | Filter catalog for one endpoint — mirrors `brapi_describe_filters`. |
| `brapi://variable/{observationVariableDbId}` | Single observation-variable record (trait, scale, method, ontology). |

### Prompts

| Prompt | Description |
|:---|:---|
| `brapi_eda_study` | EDA playbook for one study — orient, variables, coverage, missing data, outliers, pedigree, then a structured report. Args: `studyDbId`, optional `alias`. |
| `brapi_meta_analysis` | Cross-study meta-analysis for a germplasm × trait combination — resolve trait, discover studies, harmonize scales, summarize within and across studies. Args: `germplasmDbIds` (CSV), `traitName`, optional `alias`. |

## Capability reference

### `brapi_connect` <sub>tool</sub>

- `baseUrl` and `auth` are optional — when omitted, resolved from `BRAPI_<ALIAS>_*` env vars, then the built-in registry, then `BRAPI_DEFAULT_*`, so credentials never enter the LLM context
- `alias` (default `default`, pattern `^[a-zA-Z0-9_-]+$`) registers multiple concurrent connections in one session
- Auth is a tagged union: `none` / `bearer` / `api_key` / `sgn` (Breedbase `/token` exchange) / `oauth2` (client-credentials)
- Typed errors: `auth_token_exchange_failed`, `auth_no_access_token`
- Returns the full orientation envelope (identity, capabilities, content counts, attribution) — one call fully orients the agent; re-fetch on demand via `brapi_server_info`

---

### `brapi_server_info` <sub>tool</sub>

- `alias` optional (defaults to the connection registered under `default`); `forceRefresh` (default `false`) bypasses the cached capability profile
- Typed error: `unknown_alias`
- Returns the same orientation envelope shape as `brapi_connect`

---

### `brapi_describe_filters` <sub>tool</sub>

- `endpoint` required — one of `studies`, `germplasm`, `observations`, `variables`, `images`, `variants`, `locations`
- Each entry carries `name`, `type` (`string` / `integer` / `number` / `boolean` / `date` / `string[]` / `integer[]`), `description`, and an example value
- Typed error: `unknown_endpoint` (response carries `availableEndpoints` as recovery data)
- Catalog reflects the BrAPI v2.1 spec; individual servers may implement subsets

---

### `brapi_find_studies` <sub>tool</sub>

- Filters: `crop`, `trialTypes`, `seasons`, `locations`, `programs`, `trials`, `studyNames`, `active`, plus `extraFilters` passthrough
- `loadLimit` caps in-context rows; beyond it the full result set materializes as a canvas dataframe (query with `brapi_dataframe_query`)
- `distributions` cover `programName`, `studyType`, `seasons`, `locationName`, `commonCropName`
- Typed errors: `unknown_alias`, `all_filters_dropped` (every supplied filter was unsupported by the active dialect)
- Response enrichment: `totalCount`, `returnedCount`, `appliedFilters`, `refinementHint`, `notice`, `warnings`

---

### `brapi_get_study` <sub>tool</sub>

- `studyDbId` required; resolves `program`, `trial`, and `location` FKs inline
- Companion counts: `observationCount`, `observationUnitCount`, `variableCount` — omitted (with a warning) rather than reported as a server-wide total when the upstream can't scope a count to the study
- Typed errors: `unknown_alias`, `study_not_found`

---

### `brapi_find_germplasm` <sub>tool</sub>

- Filters: `names`, `germplasmDbIds`, `germplasmPUIs`, `accessionNumbers`, `crops`, `synonyms`, `collections`, `genus`, `species`, plus `extraFilters`
- `text` is a client-side substring match against `germplasmName`, `accessionNumber`, `defaultDisplayName`, and registered synonyms — combine with a server-side filter to narrow the upstream pull first
- `loadLimit` caps in-context rows; beyond it the full result set materializes as a canvas dataframe
- `distributions` cover `commonCropName`, `genus`, `species`, `collection`, `countryOfOriginCode`
- Typed errors: `unknown_alias`, `all_filters_dropped`

---

### `brapi_get_germplasm` <sub>tool</sub>

- `germplasmDbId` required; returns attributes (`/germplasm/{id}/attributes`) and direct parents (`/germplasm/{id}/pedigree`)
- Companions: `studyCount`, `directParentCount`, `directDescendantCount` (from `/germplasm/{id}/progeny`) — signals for pedigree depth and observation coverage
- Typed errors: `unknown_alias`, `germplasm_not_found`

---

### `brapi_walk_pedigree` <sub>tool</sub>

- 1–20 root `germplasmDbIds`, walked concurrently; `direction` is `ancestors` (default), `descendants`, or `both`; `maxDepth` 1–10 (default 3)
- Deduplicates nodes and breaks cycles; a 1,000-node safety cap sets `truncated` when reached
- Traversal stats: `depthReached`, `rootCount`, `leafCount`, `cycleCount`, `deadEndCount`
- `loadLimit` bounds the inline `nodes`/`edges` preview; beyond it both sets spill to JOINable canvas dataframes (`nodesDataframe`, `edgesDataframe`)
- Typed error: `unknown_alias`

---

### `brapi_find_variables` <sub>tool</sub>

- Filters: `variables`, `variableNames`, `variablePUIs`, `traitClasses`, `ontologies`, `studies`, `methods`, `scales`, `crop`, plus `extraFilters`
- `text` ranks the full upstream union via `OntologyResolver` (PUI / name / synonym / trait-class match) and fills the in-context window with matches first, unmatched rows for context — unlike `brapi_find_germplasm.text`, unmatched rows aren't dropped
- `ontologyCandidates` in the response carries the ranked matches with their match `source`
- `loadLimit` caps in-context rows; beyond it the full result set materializes as a canvas dataframe
- Typed errors: `unknown_alias`, `all_filters_dropped`

---

### `brapi_find_observations` <sub>tool</sub>

- Filters: `studies`, `germplasm`, `variables`, `observationUnits`, `observations`, `seasons`, `programs`, `trials`, `observationLevels`, `timestampFrom`/`timestampTo`, plus `extraFilters`
- `loadLimit` caps in-context rows; beyond it the full result set materializes as a canvas dataframe
- `distributions` cover `observationVariableName`, `studyName`, `germplasmName`, `observationLevel`, `season`
- Typed errors: `unknown_alias`, `all_filters_dropped`

---

### `brapi_find_images` <sub>tool</sub>

- Filters: `images`, `observationUnits`, `observations`, `studies`, `imageFileNames`, `mimeTypes`, `descriptiveOntologyTerms`, plus `extraFilters`
- Metadata only — fetch bytes via `brapi_get_image`
- `loadLimit` caps in-context rows; beyond it the full result set materializes as a canvas dataframe
- Typed errors: `unknown_alias`, `all_filters_dropped`

---

### `brapi_get_image` <sub>tool</sub>

- 1–5 `imageDbIds` per call
- Prefers `/images/{id}/imagecontent`; falls back to the metadata `imageURL` — `source` on each payload names which path served it
- Per-image `errors[]` for failed fetches and `warnings[]` for loaded-but-suspect content (e.g. a non-image MIME from the `imageURL` fallback) — a partial batch never fails as a whole
- Typed errors: `unknown_alias`, `images_unsupported` (server doesn't advertise `/images`)

---

### `brapi_find_locations` <sub>tool</sub>

- Filters: `locations`, `locationNames`, `countryCodes` (ISO 3166-1 alpha-3), `countryNames` (free-form English, resolved client-side to alpha-3), `locationTypes`, `abbreviations`, plus `extraFilters`
- Optional post-fetch `bbox` (`minLat`/`maxLat`/`minLon`/`maxLon`, all four required to activate); retries once with axes swapped when the spec-correct `[lon, lat]` reading yields zero matches on a server that stores `[lat, lon]`, and reports `coordinateAxisOrder: "swapped"`
- `loadLimit` caps in-context rows; beyond it the full result set materializes as a canvas dataframe
- Typed errors: `unknown_alias`, `all_filters_dropped`

---

### `brapi_find_variants` <sub>tool</sub>

- Filters: `variantSets`, `variants`, `references`, `referenceName` + `start`/`end` (1-based inclusive/exclusive genomic region), plus `extraFilters`
- `loadLimit` caps in-context rows; beyond it the full result set materializes as a canvas dataframe
- `distributions` cover `variantType`, `referenceName`, `variantSetDbId`
- Typed errors: `unknown_alias`, `all_filters_dropped`

---

### `brapi_find_genotype_calls` <sub>tool</sub>

- Requires at least one of `variantSetDbId`, `variantSetDbIds`, `germplasmDbIds`, `callSetDbIds`, or `variantDbIds` — unfiltered pulls are rejected
- Upstream pull bounded by `BRAPI_GENOTYPE_CALLS_MAX_PULL` (default 100,000, max 500,000) via the async `POST /search/calls` → `GET /search/calls/{id}` pattern
- `loadLimit` bounds the inline preview; the full collected set materializes as a dataframe when it exceeds `loadLimit`
- Typed errors: `unknown_alias`, `no_filters`, `search_endpoint_disabled` (dialect marks this server's search route as known-dead)

---

### `brapi_dataframe_describe` <sub>tool</sub>

- `dataframe` optional — omit to list all, or name one for full detail (columns, row count, provenance)
- Provenance (originating tool, `baseUrl`, query, expiry) is present only for auto-registered `df_*` dataframes, not user-derived ones from `registerAs`
- Typed error: `list_all_disabled_on_shared_http` — listing without a name is refused on a shared HTTP deployment without per-caller auth, since every caller shares one tenant workspace

---

### `brapi_dataframe_query` <sub>tool</sub>

- `sql` must be a single `SELECT` — writes, DDL, `COPY`, `PRAGMA`, `ATTACH`, and file reads are rejected at a three-layer gate (single statement → SELECT only → plan-walk allowlist); system-catalog reads (`information_schema`, `pg_catalog`, `sqlite_master`, `duckdb_*`) are denied separately
- `LIMIT`/`OFFSET` is the paging idiom; projection and aggregation (`COUNT`, `GROUP BY`, `AVG`) summarize without materializing every row
- `registerAs` (letters/digits/underscore, ≤63 chars) persists the result as a new dataframe; `preview` (≤1000) and `rowLimit` bound what's returned inline
- Typed error: `sql_rejected` (carries the granular gate reason on `data.gateReason`)
- Response enrichment: `truncated`, `shown`, `cap`, `notice`

---

### `brapi_dataframe_drop` <sub>tool</sub>

- _Opt-in via `BRAPI_CANVAS_DROP_ENABLED=true`_ — omitted from `tools/list` otherwise
- Idempotent: returns `dropped: false` (not an error) for an unknown name
- Dataframes also expire via TTL when left unmanaged, so explicit drop is only needed to free workspace memory immediately

---

### `brapi_dataframe_export` <sub>tool</sub>

- _Opt-in via `BRAPI_EXPORT_DIR`, stdio-only_ — omitted from `tools/list` under HTTP transport or when unset
- `format` is `csv`, `parquet`, or `json`; optional `columns` (thin projection) or `sql` (full SELECT, mutually exclusive with `columns`) materializes a temporary derived table first
- `filename` rejects path separators and `..` segments; omit for a timestamp-suffixed default
- Typed errors: `export_dir_unset`, `dataframe_not_found`, `invalid_filename`, `mutually_exclusive_projection`

---

### `brapi_build_phenotype_matrix` <sub>tool</sub>

- `studies` required (≥1) — study-anchored to avoid full-table scans; optional `variables`/`germplasm` subsets
- `shape`: `wide` (one row per germplasm, one column per variable) or `long` (one row per observation); `aggregate`: `mean` (default), `median`, `first`, or `all` (forces long form even when `shape:"wide"`)
- Wide-matrix column names are SQL-safe identifiers derived from `observationVariableDbId`; `variableLegend` maps them back to display names
- Typed errors: `unknown_alias`, `all_filters_dropped`, `no_observation_path` (neither `/observations` nor `/observationunits` returned data)
- Response enrichment: `truncated`, `shown`, `cap`, `notice`

---

### `brapi_germplasm_performance` <sub>tool</sub>

- `germplasmDbId` required; discovers the germplasm's studies automatically (capped at 200) unless an explicit `studyDbIds` set is supplied, which skips discovery entirely
- Per-variable aggregates: `n`, `mean`, `median`, `sd` (omitted when n < 2 or non-numeric), `min`/`max`, `studyCount`, `studyDbIds`, `seasons`
- Typed errors: `unknown_alias`, `germplasm_not_found`

---

### `brapi_export_genotype_matrix` <sub>tool</sub>

- `variantSetDbId` required; `format` is `matrix-json` (dataframe only), `vcf-lite` (VCF-subset text in `vcf`, plus dataframe), or `plink` (`.ped`/`.map` text, plus dataframe)
- `maxCalls`/`maxColumns` can only lower the deployment ceilings (`BRAPI_GENOTYPE_CALLS_MAX_PULL`, `BRAPI_GENOTYPE_MATRIX_MAX_COLUMNS`), never raise them
- `variantColumnLegend` maps SQL-safe column names back to original variant IDs; `truncated` names which ceiling fired when the matrix is incomplete
- Typed errors: `unknown_alias`, `no_filters`, `search_endpoint_disabled`

---

### `brapi_submit_observations` <sub>tool</sub>

- `studyDbId` required; 1–5,000 observation rows; `observationDbId` presence on a row routes it to `PUT`, absence to `POST`
- `mode: "preview"` (default) validates only and returns a POST/PUT routing breakdown; `mode: "apply"` asks the caller to confirm via a multi-round-trip input request, then writes and verifies post-state with a cheap count probe
- `force: true` skips the confirmation round — only for out-of-band-authorized writes
- Additive only — no observation is ever destroyed
- Requires `BRAPI_ENABLE_WRITES=true` to register; scoped to `brapi:write:observations`
- Typed errors: `unknown_alias`, `observations_unsupported`, `study_not_found`, `post_unsupported`, `put_unsupported`, `user_declined`

---

### `brapi_raw_get` <sub>tool</sub>

- `path` (relative BrAPI route, e.g. `/samples`) + optional `params`; last-resort escape hatch for endpoints no curated tool covers
- Emits a `suggestion` when a curated tool exists for the same endpoint
- Spills to a canvas dataframe when the upstream advertises more rows than `loadLimit` and the result is a list shape; skipped when the caller drives paging via `params.page`/`params.pageSize`
- Typed errors: `unknown_alias`, `cross_origin_path` (a full URL was passed instead of a relative route)

---

### `brapi_raw_search` <sub>tool</sub>

- `noun` (e.g. `observations`, `calls`, `germplasm`) + `body` posted verbatim to `POST /search/{noun}`; async polling resolved transparently, `kind` reports `sync` or `async`
- Emits a `suggestion` when a curated tool covers the same noun
- Same spillover behavior as `brapi_raw_get`
- Typed errors: `unknown_alias`, `search_endpoint_disabled`

---

### `brapi://server/info` <sub>resource</sub>

- No parameters — reads the cached capability profile for the `default` connection
- Typed error: `unknown_alias`

---

### `brapi://calls` <sub>resource</sub>

- No parameters — raw `/serverinfo` + `/calls` profile (server identity, crops, supported services) for the `default` connection
- Typed error: `unknown_alias`

---

### `brapi://study/{studyDbId}` <sub>resource</sub>

- Same payload as `brapi_get_study`, addressed by URI on the default connection
- Typed errors: `unknown_alias`, `study_not_found`

---

### `brapi://germplasm/{germplasmDbId}` <sub>resource</sub>

- Same payload as `brapi_get_germplasm`, addressed by URI on the default connection
- Typed errors: `unknown_alias`, `germplasm_not_found`

---

### `brapi://filters/{endpoint}` <sub>resource</sub>

- Same payload as `brapi_describe_filters`; listing the resource collection returns one entry per supported endpoint
- Typed error: `unknown_endpoint`

---

### `brapi://variable/{observationVariableDbId}` <sub>resource</sub>

- Canonical `/variables/{id}` record (trait, scale, method, ontology) on the default connection — the single-record counterpart to `brapi_find_variables`
- Typed errors: `unknown_alias`, `variable_not_found`

---

### `brapi_eda_study` <sub>prompt</sub>

- Arguments: `studyDbId` required; `alias` optional
- Six-step playbook — orient via `brapi_get_study`, enumerate variables, pull observation coverage, quantify missing data, flag numeric outliers (IQR), and an optional pedigree walk on the top-observed germplasm
- Ends in a structured markdown report with a recommended-next-steps section

---

### `brapi_meta_analysis` <sub>prompt</sub>

- Arguments: `germplasmDbIds` (comma-separated) and `traitName` required; `alias` optional (run once per alias for multi-server analyses)
- Seven-step playbook — resolve the trait to one or more observation variables, discover contributing studies, harmonize units/scales/methods across studies, then per-germplasm × per-study and across-study summary statistics
- Ends in a markdown report that cites every dataframe handle or filter map used, for reproducibility

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

BrAPI-specific:

- Dataframe spillover — `find_*` tools cap in-context rows at `loadLimit` and materialize larger unions (up to 50,000 rows) as DuckDB-backed `df_<uuid>` canvas dataframes, queryable via `brapi_dataframe_query`
- Dialect adaptation — five per-server-family adapters (`spec` / `brapi-test` / `breedbase` / `cassavabase` / `bms`) translate v2.1 plural filter keys to the singular form each family honors, drop known-broken filters, and escalate to `POST /search/{noun}` when `GET` would silently downcast
- Multi-server session with a built-in known-server registry — `ServerRegistry` holds live connections under named aliases; six public Breedbase/T3 endpoints resolve out-of-the-box with no env vars
- Capability-aware, rate-limited calls — `CapabilityRegistry` caches `/serverinfo` and guards every call against unsupported endpoints; a per-connection concurrency cap and exponential-backoff retry cover 429/5xx
- Tagged-union auth (`none` / `bearer` / `api_key` / `sgn` session-token exchange / `oauth2` client-credentials), resolved per alias from env vars so credentials never enter the LLM context

Agent-friendly output:

- Provenance on every dataframe — `brapi_dataframe_describe` reports the originating tool, `baseUrl`, and query for every auto-registered `df_<uuid>` table
- Graceful partial failure — `brapi_get_image` returns per-item `errors[]` and `warnings[]` rows instead of failing the whole batch when some images can't be loaded
- Discriminated output contracts — `brapi_submit_observations` returns a `mode`-discriminated union (`preview` / `apply`); `brapi_export_genotype_matrix` and the raw-passthrough tools carry typed `format`/`kind` fields callers branch on instead of parsing strings
- Response-shaping guidance — `find_*` tools echo `appliedFilters`, a `refinementHint` when results are broad, and typed `notice`/`warnings` so agents can see exactly what was queried and why a response looks the way it does

## Working with dataframes

When a `find_*` tool's upstream total exceeds `loadLimit`, the full union materializes as a canvas dataframe and the response carries an inline `dataframe` handle (`{ tableName, rowCount, columns, createdAt, expiresAt, … }`). Upstream column names that aren't SQL-safe identifiers are sanitized, and a `columnLegend` on the handle maps each renamed column back to its original key.

```text
1. brapi_find_observations { studies: ["s-422"] }
   → first-page rows inline + dataframe.tableName = "df_<uuid>" (when totalCount > loadLimit)
2. brapi_dataframe_describe { dataframe: "df_<uuid>" }
   → schema + provenance (originating tool, baseUrl, query, expiry)
3. brapi_dataframe_query { sql: "SELECT germplasmName, value FROM df_<uuid> WHERE observationVariableDbId = 'V1' LIMIT 100" }
   → typed columns + bounded rows
```

Dataframe names are capability tokens, not row-level ACLs — anyone holding the name within the same session or tenant bucket (see [Deployment shapes](#deployment-shapes)) can read its rows. They auto-expire via TTL (`BRAPI_DATASET_TTL_SECONDS`, default 24h); set `BRAPI_CANVAS_DROP_ENABLED=true` to expose `brapi_dataframe_drop` for explicit cleanup.

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

No env vars are required — the six built-in aliases (`bti-cassava`, `bti-sweetpotato`, `bti-breedbase-demo`, `t3-wheat`, `t3-oat`, `t3-barley`) resolve out-of-the-box, and agents can connect to any other BrAPI v2 URL at runtime via `brapi_connect`. For credentialed servers, prefer env vars over agent input so passwords, tokens, and API keys stay out of the LLM context — see [Per-alias credentials](#per-alias-credentials).

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- [`@duckdb/node-api`](https://www.npmjs.com/package/@duckdb/node-api) is a required dependency — supported on Linux/macOS/Windows × x64 plus Linux/macOS arm64 (no Windows arm64, no Cloudflare Workers).

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
| `BRAPI_DEFAULT_BASE_URL` | Default BrAPI v2 base URL (e.g. `https://test-server.brapi.org/brapi/v2`). | — |
| `BRAPI_DEFAULT_USERNAME` / `_PASSWORD` | SGN session-token auth for the default connection. | — |
| `BRAPI_DEFAULT_OAUTH_CLIENT_ID` / `_OAUTH_CLIENT_SECRET` | OAuth2 client-credentials for the default connection. | — |
| `BRAPI_DEFAULT_API_KEY` / `_API_KEY_HEADER` | Static API key for the default connection. | header `Authorization` |
| `BRAPI_BUILTIN_ALIASES_DISABLED` | Comma-separated alias names (case-insensitive) to remove from the built-in registry. | — |
| `BRAPI_LOAD_LIMIT` | In-context row cap returned by `find_*` tools before spilling to a canvas dataframe. | `1000` |
| `BRAPI_PAGE_SIZE` | Upstream `pageSize` used during canvas spillover walks (decoupled from `BRAPI_LOAD_LIMIT`). Dataframe ceiling = `pageSize × 50`. | `1000` |
| `BRAPI_MAX_CONCURRENT_REQUESTS` | Per-connection concurrency cap. | `4` |
| `BRAPI_RETRY_MAX_ATTEMPTS` / `BRAPI_RETRY_BASE_DELAY_MS` | Retry policy for 429/5xx with exponential backoff. | `3` / `500` |
| `BRAPI_REQUEST_TIMEOUT_MS` | Per-request HTTP timeout. | `30000` |
| `BRAPI_COMPANION_TIMEOUT_MS` | Tighter timeout for non-critical companion enrichments (FK lookups, count probes); companions also bypass the retry budget. | `8000` |
| `BRAPI_SEARCH_POLL_TIMEOUT_MS` / `_INTERVAL_MS` | Async `/search` polling budget + interval. | `60000` / `1000` |
| `BRAPI_DATASET_TTL_SECONDS` | TTL for dataframe provenance metadata persisted alongside spilled rows. | `86400` |
| `BRAPI_REFERENCE_CACHE_TTL_SECONDS` | TTL for programs / trials / locations / crops cache. | `3600` |
| `BRAPI_ALLOW_PRIVATE_IPS` | Allow RFC 1918 / loopback targets. Dev-only. | `false` |
| `BRAPI_ENABLE_WRITES` | **Feature flag.** Registers `brapi_submit_observations` when `true`. | `false` |
| `BRAPI_GENOTYPE_CALLS_MAX_PULL` | Upstream row ceiling per `brapi_find_genotype_calls` invocation. Max `500000`. | `100000` |
| `BRAPI_GENOTYPE_MATRIX_MAX_COLUMNS` | Distinct-variant column ceiling per `brapi_export_genotype_matrix` matrix — bounds the wide dataframe, the `variantColumnLegend`, and any VCF/PLINK text. Max `500000`. | `10000` |
| `BRAPI_CANVAS_DROP_ENABLED` | **Feature flag.** Registers `brapi_dataframe_drop` when `true`; dataframes still expire via TTL when left unmanaged. | `false` |
| `BRAPI_EXPORT_DIR` | **Feature flag.** Directory for `brapi_dataframe_export` output files — setting a path is the opt-in (no separate enable flag). Stdio-only; the tool stays disabled under HTTP transport regardless of this value. | — |
| `BRAPI_CANVAS_MAX_ROWS` / `BRAPI_CANVAS_QUERY_TIMEOUT_MS` | Per-query response row cap and wall-clock timeout for `brapi_dataframe_query`. | `10000` / `30000` |
| `BRAPI_SESSION_ISOLATION` | When `true`, scope connection state and the default canvas to `ctx.sessionId` (HTTP stateful/auto) so concurrent `MCP_AUTH_MODE=none` callers get isolated workspaces. Set `false` for the shared-workspace model. No effect on stdio. | `true` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateful`, `stateless`, or `auto` (resolves to `stateful`). This server pins `stateful` — apply-mode observation writes need a durable session to ask for confirmation, and per-session isolation keys off `ctx.sessionId`. | `stateful` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

Per-alias overrides follow the `BRAPI_<ALIAS>_*` pattern. See [`.env.example`](./.env.example) for the full list of optional overrides.

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

Defaults to HTTP transport, stateful session mode (engages the `mcp-session-id` lifecycle — precondition for `BRAPI_SESSION_ISOLATION=true`; hijack protection requires layering `MCP_AUTH_MODE=jwt|oauth` on top), logs to `/var/log/brapi-mcp-server`. OTel peer deps are installed by default — `--build-arg OTEL_ENABLED=false` to omit.

### Deployment shapes

Two stateful layers scope by tenant and, by default, by MCP session: **connection state** (registered aliases, exchanged upstream tokens) and **dataframes** (`df_<uuid>` tables — possession of the name grants full read/write/drop within its bucket, auto-expires in 24h by default, provenance recorded). `brapi-mcp-server` runs in three shapes that pick where those buckets end:

| Shape | Settings | Isolation | Best for |
|:------|:---------|:----------|:---------|
| **Per-session (default)** | `MCP_AUTH_MODE=none` + HTTP stateful + `BRAPI_SESSION_ISOLATION=true` | Each MCP session carves its own connection state and canvas. Concurrent HTTP callers don't see each other's aliases, exchanged tokens, or `df_<uuid>` rows. | Multi-user host without SSO. Default for institutional / public deployment under shared-trust auth. |
| **Per-user credentials** | `MCP_AUTH_MODE=jwt` or `oauth` (+ HTTP stateful) | Each user's JWT `tid` claim carves a tenant; sessions sub-scope inside each tenant when isolation is on. Cross-user spillover impossible at the framework level. | Multi-user host with institutional SSO — strongest separation. |
| **Shared workspace** | `MCP_AUTH_MODE=none` + `BRAPI_SESSION_ISOLATION=false` | All callers in one tenant share connection state and one canvas. | Solo, lab, or hosting where every caller is one researcher running parallel agents on shared upstream credentials. |

Stdio is always one session, so isolation is moot there. Clients on MCP protocol revision 2026-07-28 are session-less by every transport (no `ctx.sessionId`), so they always land in the shared tenant workspace regardless of `BRAPI_SESSION_ISOLATION` — only the per-user-credentials shape isolates them.

Belt-and-braces under shared trust: `brapi_dataframe_describe` requires an explicit `dataframe` name (no list-all enumeration) and `brapi_dataframe_query` rejects system-catalog reads, so a caller without a known `df_<uuid>` name can't fish through either surface even in the shared-workspace shape.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools/resources/prompts and inits services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Twenty-five tools across connection, retrieval, analysis, write, and raw-passthrough. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/mcp-server/prompts` | Prompt definitions (`*.prompt.ts`). |
| `src/services` | Domain service integrations — BrAPI client, dialect adapters, canvas bridge, capability registry, ontology resolver, reference-data cache, server registry. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for tenant-scoped storage — no `console`, no direct persistence access
- Register new tools in the `tools` array of `createApp()` in `src/index.ts`
- Wrap upstream calls: validate raw → normalize → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
