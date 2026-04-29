# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

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
