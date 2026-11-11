---
name: brapi-guide
description: Use brapi_* tools to compare plant-breeding phenotypes across studies, verify which trials measured a trait, retrieve genotype calls or export a variant set, and query staged results in SQL.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Work within a BrAPI upstream's advertised endpoints. Access depends on the upstream, which may require credentials configured by the operator.

## Identifiers

Keep every BrAPI ID with the upstream connection that produced it. If comparing across connections, verify the biological identity and measurement definitions before joining records.

| ID | Where to get it |
| --- | --- |
| `germplasmDbId` | `brapi_find_germplasm` rows after resolving a name or accession. |
| `observationVariableDbId` | `brapi_find_variables` rows or ranked `ontologyCandidates` that carry a variable ID. Use a trait label or ontology PUI to find candidates. |
| `studyDbId` | `brapi_find_studies` for candidate studies, matching `brapi_find_observations` rows or contributing `brapi_germplasm_performance` studies for evidence of measurement. |
| `variantSetDbId` | Rows from `brapi_raw_get` on `/variantsets`. Follow upstream pages when searching for a set. |
| `variantDbId`, `callSetDbId` | Variant IDs from `brapi_find_variants` or genotype-call rows. Call-set IDs come from genotype-call rows. |

## Gates

- Before concluding that a study or measurement is absent, check the scan and its filters. A limited discovery, ignored filter, failed study, or incomplete scan leaves coverage unresolved. Treat a completed empty result as evidence only within the scope actually checked.
- Before pooling values, compare the variables' scales, units, and methods. Convert compatible units explicitly and keep incompatible measurements separate.
- Check the available tools before planning file export, cleanup, or observation submission. Dataframe file export requires a configured stdio server, while drop and observation submission are opt-in. Preview observations first and get the user's confirmation before applying the write.

## Workflows

### Compare phenotypes across studies

On SGN/Breedbase, scope `brapi_find_observations` to a study or germplasm to use embedded observations when the upstream advertises that route. If an observation search skips collection, get contributing study IDs from `brapi_germplasm_performance`, then retry against those studies or other known study IDs. A germplasm filter on study discovery can be ignored upstream. Verify study membership from matching observations, and use `brapi_get_study` for trial, location, and season context.

Read `coverage` in the performance or matrix result. Contributing studies have collected measurements. Empty, failed, partial, and unprocessed studies have distinct outcomes. An incomplete scoped-unit scan can leave additional studies unseen.

Use `brapi_build_phenotype_matrix` with long form and `aggregate: "all"` to preserve study IDs, categorical values, and replicate rows. A wide matrix aggregates across studies per germplasm and variable. For numeric comparisons, group the long rows by study, germplasm, and variable and count the values that convert successfully. Preserve measured zeros.

### Inspect calls or export a variant set

Scope `brapi_find_genotype_calls` to the relevant variant set or other known IDs when inspecting calls. Use `brapi_export_genotype_matrix` when you need the wide pivot or VCF-lite or PLINK text. Check whether the pull stopped early and whether the matrix reached its separate column limit. Use `variantColumnLegend` to map matrix columns back to variant IDs.

A bare numeric value can be dosage or a single allele index. When text export marks such a call missing, recover the original value from the staged matrix and leave the allele interpretation unresolved. Check coordinate and allele metadata before using the exported text for downstream analysis.

### Query staged results

Keep the staged `dataframe.tableName` or the table name in the staging notice. Call `brapi_dataframe_describe` with that name before writing SQL. Run one read-only statement through `brapi_dataframe_query`. Stage further results in the same workspace to join them there. The workspace is tenant-scoped and can be further scoped to the MCP session. Keep the exact name for deployments that disable listing.

Use `registerAs` to save the full SQL result under a fresh name for later queries. For a long phenotype table, replace the table name below with the one returned by the matrix tool.

```sql
SELECT studyDbId, germplasmDbId, observationVariableDbId, replicateIndex, value
FROM df_example
ORDER BY studyDbId, germplasmDbId, observationVariableDbId, replicateIndex
LIMIT 100 OFFSET 0
```

Advance the offset by rows actually returned. If none fit the preview, narrow the projection or aggregate. A staged preview covers the fetched rows, so check upstream coverage separately. The handle's `expiresAt` dates its provenance. Tables live in the canvas until it expires or the table is dropped. On `missing_table`, check the workspace and table name, then re-stage the source if needed.
