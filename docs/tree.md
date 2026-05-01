# brapi-mcp-server - Directory Structure

Generated on: 2026-05-01 23:22:02

```text
brapi-mcp-server/
├── .agents/
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
│   ├── 0.2.x/
│   ├── 0.3.x/
│   ├── 0.4.x/
│   └── template.md
├── docs/
│   ├── compatibility.md
│   └── design.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skills-sync.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── split-changelog.ts
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
│   │   ├── alias-credentials.ts
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   │       ├── brapi-eda-study.prompt.ts
│   │   │       └── brapi-meta-analysis.prompt.ts
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── brapi-calls.resource.ts
│   │   │       ├── brapi-dataset.resource.ts
│   │   │       ├── brapi-filters.resource.ts
│   │   │       ├── brapi-germplasm.resource.ts
│   │   │       ├── brapi-server-info.resource.ts
│   │   │       └── brapi-study.resource.ts
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
│   │       │   ├── brapi-submit-observations.tool.ts
│   │       │   ├── brapi-walk-pedigree.tool.ts
│   │       │   └── index.ts
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
│   │   ├── brapi-dialect/
│   │   │   ├── brapi-test-dialect.ts
│   │   │   ├── cassavabase-dialect.ts
│   │   │   ├── detect.ts
│   │   │   ├── index.ts
│   │   │   ├── registry.ts
│   │   │   ├── singularizing-dialect.ts
│   │   │   ├── spec-dialect.ts
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
│   ├── config/
│   │   └── alias-credentials.test.ts
│   ├── prompts/
│   │   ├── brapi-eda-study.prompt.test.ts
│   │   └── brapi-meta-analysis.prompt.test.ts
│   ├── resources/
│   │   ├── brapi-calls.resource.test.ts
│   │   ├── brapi-dataset.resource.test.ts
│   │   ├── brapi-filters.resource.test.ts
│   │   ├── brapi-germplasm.resource.test.ts
│   │   ├── brapi-server-info.resource.test.ts
│   │   └── brapi-study.resource.test.ts
│   ├── services/
│   │   ├── brapi-dialect/
│   │   │   ├── brapi-test-dialect.test.ts
│   │   │   ├── cassavabase-dialect.test.ts
│   │   │   ├── detect.test.ts
│   │   │   ├── registry.test.ts
│   │   │   ├── resolve-dialect.test.ts
│   │   │   └── spec-dialect.test.ts
│   │   ├── brapi-client.test.ts
│   │   ├── capability-registry.test.ts
│   │   ├── dataset-store.test.ts
│   │   ├── ontology-resolver.test.ts
│   │   ├── reference-data-cache.test.ts
│   │   └── server-registry.test.ts
│   ├── tools/
│   │   ├── _tool-test-helpers.ts
│   │   ├── brapi-connect.tool.test.ts
│   │   ├── brapi-describe-filters.tool.test.ts
│   │   ├── brapi-find-genotype-calls.tool.test.ts
│   │   ├── brapi-find-germplasm.tool.test.ts
│   │   ├── brapi-find-images.tool.test.ts
│   │   ├── brapi-find-locations.tool.test.ts
│   │   ├── brapi-find-observations.tool.test.ts
│   │   ├── brapi-find-studies.tool.test.ts
│   │   ├── brapi-find-variables.tool.test.ts
│   │   ├── brapi-find-variants.tool.test.ts
│   │   ├── brapi-get-germplasm.tool.test.ts
│   │   ├── brapi-get-image.tool.test.ts
│   │   ├── brapi-get-study.tool.test.ts
│   │   ├── brapi-manage-dataset.tool.test.ts
│   │   ├── brapi-raw-get.tool.test.ts
│   │   ├── brapi-raw-search.tool.test.ts
│   │   ├── brapi-server-info.tool.test.ts
│   │   ├── brapi-submit-observations.tool.test.ts
│   │   └── brapi-walk-pedigree.tool.test.ts
│   └── registration-gate.test.ts
├── .dockerignore
├── .env.example
├── .gitignore
├── AGENTS.md
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
