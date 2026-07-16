# brapi-mcp-server - Directory Structure

Generated on: 2026-07-16 09:39:42

```text
brapi-mcp-server/
├── .agents/
├── .claude/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.2.x/
│   ├── 0.3.x/
│   ├── 0.4.x/
│   ├── 0.5.x/
│   ├── 0.6.x/
│   ├── 0.7.x/
│   └── template.md
├── docs/
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
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
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
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
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
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
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   ├── alias-credentials.ts
│   │   ├── builtin-aliases.ts
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   │       ├── brapi-eda-study.prompt.ts
│   │   │       └── brapi-meta-analysis.prompt.ts
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── brapi-calls.resource.ts
│   │   │       ├── brapi-filters.resource.ts
│   │   │       ├── brapi-germplasm.resource.ts
│   │   │       ├── brapi-server-info.resource.ts
│   │   │       ├── brapi-study.resource.ts
│   │   │       └── brapi-variable.resource.ts
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── brapi-build-phenotype-matrix.tool.ts
│   │       │   ├── brapi-connect.tool.ts
│   │       │   ├── brapi-dataframe-describe.tool.ts
│   │       │   ├── brapi-dataframe-drop.tool.ts
│   │       │   ├── brapi-dataframe-export.tool.ts
│   │       │   ├── brapi-dataframe-query.tool.ts
│   │       │   ├── brapi-describe-filters.tool.ts
│   │       │   ├── brapi-export-genotype-matrix.tool.ts
│   │       │   ├── brapi-find-genotype-calls.tool.ts
│   │       │   ├── brapi-find-germplasm.tool.ts
│   │       │   ├── brapi-find-images.tool.ts
│   │       │   ├── brapi-find-locations.tool.ts
│   │       │   ├── brapi-find-observations.tool.ts
│   │       │   ├── brapi-find-studies.tool.ts
│   │       │   ├── brapi-find-variables.tool.ts
│   │       │   ├── brapi-find-variants.tool.ts
│   │       │   ├── brapi-germplasm-performance.tool.ts
│   │       │   ├── brapi-get-germplasm.tool.ts
│   │       │   ├── brapi-get-image.tool.ts
│   │       │   ├── brapi-get-study.tool.ts
│   │       │   ├── brapi-raw-get.tool.ts
│   │       │   ├── brapi-raw-search.tool.ts
│   │       │   ├── brapi-server-info.tool.ts
│   │       │   ├── brapi-submit-observations.tool.ts
│   │       │   ├── brapi-walk-pedigree.tool.ts
│   │       │   └── index.ts
│   │       └── shared/
│   │           ├── canvas-columns.ts
│   │           ├── connect-auth-schema.ts
│   │           ├── find-helpers.ts
│   │           ├── genotype-calls.ts
│   │           ├── observations.ts
│   │           ├── orientation-envelope.ts
│   │           └── raw-routing-hints.ts
│   ├── services/
│   │   ├── brapi-client/
│   │   │   ├── brapi-client.ts
│   │   │   ├── index.ts
│   │   │   └── types.ts
│   │   ├── brapi-dialect/
│   │   │   ├── bms-dialect.ts
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
│   │   ├── canvas-bridge/
│   │   │   ├── canvas-bridge.ts
│   │   │   ├── index.ts
│   │   │   └── types.ts
│   │   ├── capability-registry/
│   │   │   ├── capability-registry.ts
│   │   │   ├── index.ts
│   │   │   └── types.ts
│   │   ├── iso-country/
│   │   │   ├── index.ts
│   │   │   ├── iso-3166-data.ts
│   │   │   ├── resolve-country.ts
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
│   │   ├── alias-credentials.test.ts
│   │   ├── builtin-aliases.test.ts
│   │   └── server-config.test.ts
│   ├── prompts/
│   │   ├── brapi-eda-study.prompt.test.ts
│   │   └── brapi-meta-analysis.prompt.test.ts
│   ├── resources/
│   │   ├── brapi-calls.resource.test.ts
│   │   ├── brapi-filters.resource.test.ts
│   │   ├── brapi-germplasm.resource.test.ts
│   │   ├── brapi-server-info.resource.test.ts
│   │   ├── brapi-study.resource.test.ts
│   │   └── brapi-variable.resource.test.ts
│   ├── services/
│   │   ├── brapi-dialect/
│   │   │   ├── bms-dialect.test.ts
│   │   │   ├── brapi-test-dialect.test.ts
│   │   │   ├── cassavabase-dialect.test.ts
│   │   │   ├── detect.test.ts
│   │   │   ├── registry.test.ts
│   │   │   ├── resolve-dialect.test.ts
│   │   │   └── spec-dialect.test.ts
│   │   ├── _fake-canvas.ts
│   │   ├── brapi-client.test.ts
│   │   ├── canvas-bridge.test.ts
│   │   ├── capability-registry.test.ts
│   │   ├── iso-country.test.ts
│   │   ├── ontology-resolver.test.ts
│   │   ├── reference-data-cache.test.ts
│   │   └── server-registry.test.ts
│   ├── tools/
│   │   ├── shared/
│   │   │   ├── find-helpers.test.ts
│   │   │   └── orientation-envelope.test.ts
│   │   ├── _tool-test-helpers.ts
│   │   ├── brapi-build-phenotype-matrix.tool.test.ts
│   │   ├── brapi-connect.tool.test.ts
│   │   ├── brapi-dataframe-describe.tool.test.ts
│   │   ├── brapi-dataframe-drop.tool.test.ts
│   │   ├── brapi-dataframe-export.tool.test.ts
│   │   ├── brapi-dataframe-query.tool.test.ts
│   │   ├── brapi-describe-filters.tool.test.ts
│   │   ├── brapi-export-genotype-matrix.tool.test.ts
│   │   ├── brapi-find-genotype-calls.tool.test.ts
│   │   ├── brapi-find-germplasm.tool.test.ts
│   │   ├── brapi-find-images.tool.test.ts
│   │   ├── brapi-find-locations.tool.test.ts
│   │   ├── brapi-find-observations.tool.test.ts
│   │   ├── brapi-find-studies.tool.test.ts
│   │   ├── brapi-find-variables.tool.test.ts
│   │   ├── brapi-find-variants.tool.test.ts
│   │   ├── brapi-germplasm-performance.tool.test.ts
│   │   ├── brapi-get-germplasm.tool.test.ts
│   │   ├── brapi-get-image.tool.test.ts
│   │   ├── brapi-get-study.tool.test.ts
│   │   ├── brapi-raw-get.tool.test.ts
│   │   ├── brapi-raw-search.tool.test.ts
│   │   ├── brapi-server-info.tool.test.ts
│   │   ├── brapi-submit-observations.tool.test.ts
│   │   ├── brapi-walk-pedigree.tool.test.ts
│   │   └── security.test.ts
│   └── registration-gate.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
