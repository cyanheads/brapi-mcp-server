# brapi-mcp-server - Directory Structure

Generated on: 2026-04-24 02:48:00

```text
brapi-mcp-server/
├── .claude/
├── .github/
│   └── ISSUE_TEMPLATE/
│       ├── bug_report.yml
│       ├── config.yml
│       └── feature_request.yml
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   └── template.md
├── docs/
│   └── design.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-docs-sync.ts
│   ├── check-skills-sync.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   └── tree.ts
├── skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── migrate-mcp-ts-template/
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   └── setup/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── brapi-connect.tool.ts
│   │       │   ├── brapi-describe-filters.tool.ts
│   │       │   ├── brapi-find-genotype-calls.tool.ts
│   │       │   ├── brapi-find-germplasm.tool.ts
│   │       │   ├── brapi-find-images.tool.ts
│   │       │   ├── brapi-find-locations.tool.ts
│   │       │   ├── brapi-find-observations.tool.ts
│   │       │   ├── brapi-find-studies.tool.ts
│   │       │   ├── brapi-find-variables.tool.ts
│   │       │   ├── brapi-find-variants.tool.ts
│   │       │   ├── brapi-get-germplasm.tool.ts
│   │       │   ├── brapi-get-image.tool.ts
│   │       │   ├── brapi-get-study.tool.ts
│   │       │   ├── brapi-manage-dataset.tool.ts
│   │       │   ├── brapi-raw-get.tool.ts
│   │       │   ├── brapi-raw-search.tool.ts
│   │       │   ├── brapi-server-info.tool.ts
│   │       │   └── brapi-walk-pedigree.tool.ts
│   │       └── shared/
│   │           ├── connect-auth-schema.ts
│   │           ├── find-helpers.ts
│   │           ├── orientation-envelope.ts
│   │           └── raw-routing-hints.ts
│   ├── services/
│   │   ├── brapi-client/
│   │   │   ├── brapi-client.ts
│   │   │   ├── index.ts
│   │   │   └── types.ts
│   │   ├── brapi-filters/
│   │   │   ├── catalog.ts
│   │   │   ├── index.ts
│   │   │   └── types.ts
│   │   ├── capability-registry/
│   │   │   ├── capability-registry.ts
│   │   │   ├── index.ts
│   │   │   └── types.ts
│   │   ├── dataset-store/
│   │   │   ├── dataset-store.ts
│   │   │   ├── index.ts
│   │   │   └── types.ts
│   │   ├── ontology-resolver/
│   │   │   ├── index.ts
│   │   │   ├── ontology-resolver.ts
│   │   │   └── types.ts
│   │   ├── reference-data-cache/
│   │   │   ├── index.ts
│   │   │   ├── reference-data-cache.ts
│   │   │   └── types.ts
│   │   └── server-registry/
│   │       ├── index.ts
│   │       ├── server-registry.ts
│   │       └── types.ts
│   └── index.ts
├── tests/
│   ├── services/
│   │   ├── brapi-client.test.ts
│   │   ├── capability-registry.test.ts
│   │   ├── dataset-store.test.ts
│   │   ├── reference-data-cache.test.ts
│   │   └── server-registry.test.ts
│   └── tools/
│       ├── _tool-test-helpers.ts
│       ├── brapi-connect.tool.test.ts
│       ├── brapi-describe-filters.tool.test.ts
│       ├── brapi-find-germplasm.tool.test.ts
│       ├── brapi-find-studies.tool.test.ts
│       ├── brapi-get-germplasm.tool.test.ts
│       ├── brapi-get-study.tool.test.ts
│       └── brapi-server-info.tool.test.ts
├── .dockerignore
├── .env.example
├── .gitignore
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
