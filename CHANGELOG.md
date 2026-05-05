# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.5.0](changelog/0.5.x/0.5.0.md) — 2026-05-05 · ⚠️ Breaking

Consolidate spillover onto canvas-only dataframes — remove brapi_manage_dataset and the brapi://dataset/{id} resource, mandate DuckDB, gate brapi_dataframe_drop opt-in, and return typed columns from brapi_dataframe_query.

## [0.4.14](changelog/0.4.x/0.4.14.md) — 2026-05-04

Live-fire fixes against Cassavabase: canvas dataframes survive null columns; deduplicates 11×-repeated synonyms; find_variables actually re-ranks against the spilled union; truthful truncated-dataset metadata; trims empty nested containers.

## [0.4.13](changelog/0.4.x/0.4.13.md) — 2026-05-04

Built-in alias rename — source-prefixed handles (`bti-*`, `t3-*`); adds T3/Oat and T3/Barley; fixes hyphenated-builtin env shadow.

## [0.4.12](changelog/0.4.x/0.4.12.md) — 2026-05-04

Built-in alias registry — `cassava`, `sweetpotato`, `wheat`, and `breedbase` resolve out-of-the-box without env vars; orientation envelope now carries CC-BY attribution metadata.

## [0.4.11](changelog/0.4.x/0.4.11.md) — 2026-05-03

Framework bump to 0.8.13 — gated tools stay visible in the operator manifest via disabledTool(), SQL gate function deny-list adopted from the framework, RequestContext slice swapped onto the framework's exported type.

## [0.4.10](changelog/0.4.x/0.4.10.md) — 2026-05-03

Dataframe surface (Tier 3, opt-in) — spilled find_* rows auto-register as DuckDB-backed dataframes; agents run SELECT SQL across them via brapi_dataframe_query/describe/drop. Genotype-call cap promoted to operator policy.

## [0.4.9](changelog/0.4.x/0.4.9.md) — 2026-05-02

Sweetpotatobase follow-up: keep Breedbase location filters plural, add URL-pattern dialect detection, and fail soft when observation spillover pages stall.

## [0.4.8](changelog/0.4.x/0.4.8.md) — 2026-05-01

Generalize the /observations preflight from germplasm-only to any unanchored query, and make the probe fail-soft via companion call options so a stalled count surfaces as a warning instead of a hard error.

## [0.4.7](changelog/0.4.x/0.4.7.md) — 2026-05-01

Foundational dialect-bypass fix — every BrAPI client GET routes through the dialect adapter, with tight companion-call budgets so slow upstreams no longer 4× the response time.

## [0.4.6](changelog/0.4.x/0.4.6.md) — 2026-05-01

BrAPI Test Server v2.0 dialect, shared singularizing engine, and typed all_filters_dropped guard across find_* tools.

## [0.4.5](changelog/0.4.x/0.4.5.md) — 2026-05-01

Compatibility upgrade: OAuth2 client credentials, tolerant capability fallback, route-planned find tools, and live server matrix.

## [0.4.4](changelog/0.4.x/0.4.4.md) — 2026-04-30

format() / structuredContent parity — every find_* and get_* tool now emits passthrough fields so text-only clients see the full upstream payload.

## [0.4.3](changelog/0.4.x/0.4.3.md) — 2026-04-30

Field-test follow-up: studyCount cross-check, find_germplasm text spillover guard, find_observations preflight on unscoped germplasm queries, honest zero-match distributions, prominent dataset expiry.

## [0.4.2](changelog/0.4.x/0.4.2.md) — 2026-04-30

Row schemas accept null fields from sparse upstreams. FK match-rate checks across find_studies / find_observations / find_images surface silently-ignored filters as warnings. CassavaBase locationDbIds dropped on /studies.

## [0.4.1](changelog/0.4.x/0.4.1.md) — 2026-04-30

Dialects declare known-dead POST /search routes — raw_search and find_genotype_calls refuse with a typed error before hitting the upstream. Orientation envelope surfaces the active dialect so agents can plan around quirks.

## [0.4.0](changelog/0.4.x/0.4.0.md) — 2026-04-30

Per-server dialect adapters route around upstream filter quirks. CassavaBase and SGN-family deployments now receive the singular filter forms they actually honor; `searchText` (the fictional non-spec query param earlier versions sent) is dropped.

## [0.3.9](changelog/0.3.x/0.3.9.md) — 2026-04-29

Resolver field-name fix for BrAPI v2.1 trait subobjects + bbox swap-on-zero detection for non-conformant GeoJSON deployments.

## [0.3.8](changelog/0.3.x/0.3.8.md) — 2026-04-29

Field-test fixes from real CassavaBase data — GeoJSON coordinates, `pageSize=0`→`pageSize=1` for v2.1-strict servers, variable text-match by dbId when PUI is sparse, pedigree leaf-count correctness — plus shared `find_*` rendering.

## [0.3.7](changelog/0.3.x/0.3.7.md) — 2026-04-29

Add `BRAPI_ENABLE_WRITES` env-var gate for the write surface — `brapi_submit_observations` is omitted from `tools/list` unless the operator opts in for the deployment. Mirrors obsidian-mcp-server's `OBSIDIAN_ENABLE_COMMANDS` pattern.

## [0.3.6](changelog/0.3.x/0.3.6.md) — 2026-04-30

Drop the tsx runtime shim — package scripts and the production entry point invoke Bun directly. Fixes a Docker linux/arm64 build failure (tsx + Bun 1.3.13 in oven/bun:1) and aligns the script execution model with the cyanheads MCP fleet.

## [0.3.5](changelog/0.3.x/0.3.5.md) — 2026-04-30

Cassavabase null-tolerance pass — schemas accept upstream nulls without dropping rows, walk-pedigree no longer false-flags inverse-edge backtracks as cycles, get-image flags broken upstream URLs. Plus npm scope rename to @cyanheads/brapi-mcp-server.

## [0.3.4](changelog/0.3.x/0.3.4.md) — 2026-04-29

Field-test pass against real BrAPI servers — capability-gated companion lookups, top-level study FK probes, structured-season + multi-set variant tolerance, and a multi-tenant HTTP deployment notice.

## [0.3.3](changelog/0.3.x/0.3.3.md) — 2026-04-29

Tighten recovery hints across BrAPI tool/resource error contracts and wire service-layer throws so declared hints actually reach the wire.

## [0.3.2](changelog/0.3.x/0.3.2.md) — 2026-04-29

Adopt mcp-ts-core 0.8.6 typed-error contracts across the BrAPI surface, fix a germplasmOrigin schema bug that broke output validation against spec-compliant servers.

## [0.3.1](changelog/0.3.x/0.3.1.md) — 2026-04-29

Per-alias env-var fallback for brapi_connect — credentials live in BRAPI_<ALIAS>_* and never enter the LLM context. Plus a Breedbase /token form-encoding fix that unblocks SGN auth against Cassavabase et al.

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-04-25

Surface complete — adds brapi_submit_observations write tool, six brapi:// resources, two workflow prompts (eda_study, meta_analysis), POST/PUT methods on BrapiClient, and full test backfill (101 → 191 tests).

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-04-24

Framework bump to @cyanheads/mcp-ts-core 0.6.16 — recursive describe-on-fields linting, synced skills, and .describe() coverage on every nested field, array element, and union variant across the 18-tool surface.

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-04-23

Read-side surface expansion — 11 new tools (variables, observations, images, genotype calls, locations, variants, pedigree walks, dataset lifecycle, raw passthrough) plus OntologyResolver and binary image fetch.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-04-23

Docs and metadata polish for publish — full README, LICENSE, project tree; BrAPI-specific CLAUDE.md; richer package.json keywords/engines, server.json env vars, and Dockerfile OCI labels.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-04-23

Phase 3 tool surface — 7 read-side BrAPI tools (connect, server_info, describe_filters, find/get studies & germplasm) plus ServerRegistry for session-scoped multi-server workflows and a static BrAPI v2.1 filter catalog.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-04-23

Initial scaffold from @cyanheads/mcp-ts-core with complete MCP surface design — 19 tools and 6 resources for BrAPI v2.1 find/get, pedigree traversal, writes, filter discovery, and dataset lifecycle.
