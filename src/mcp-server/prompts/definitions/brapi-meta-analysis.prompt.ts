/**
 * @fileoverview `brapi_meta_analysis` — cross-study meta-analysis playbook.
 * Given a germplasm set and a target trait, walks the agent through ontology
 * resolution, study discovery, observation pull, harmonization, and
 * across-study summarization using the curated `brapi_*` tool surface. Pure
 * prompt template: no Context, no auth, no side effects.
 *
 * @module mcp-server/prompts/definitions/brapi-meta-analysis.prompt
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

export const brapiMetaAnalysis = prompt('brapi_meta_analysis', {
  description:
    'Cross-study meta-analysis playbook for a germplasm × trait combination — resolve trait, find studies, pull observations, harmonize scales, summarize across studies.',
  args: z.object({
    germplasmDbIds: z
      .string()
      .min(1)
      .describe(
        'Comma-separated germplasmDbIds (e.g. "germplasm-1,germplasm-2"). The meta-analysis will collect every observation of the target trait on these germplasm across all reachable studies.',
      ),
    traitName: z
      .string()
      .min(1)
      .describe(
        'Target trait name or free-text query — e.g. "dry matter content", "Plant height". The agent will resolve it to one or more observation variables via brapi_find_variables.',
      ),
    alias: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional()
      .describe(
        'Connection alias registered via brapi_connect. Omit to use the default connection. For multi-server meta-analyses, run this prompt once per registered alias and merge.',
      ),
  }),
  generate: (args) => {
    const aliasArg = args.alias ? `, alias: "${args.alias}"` : '';
    const ids = args.germplasmDbIds
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    const idsLiteral = JSON.stringify(ids);

    const text = [
      `You are running a cross-study meta-analysis on the **${args.traitName}** trait across ${ids.length} germplasm: ${ids.map((id) => `\`${id}\``).join(', ')}. Use the curated \`brapi_*\` tools throughout. Reproducibility matters — record every dataset handle and query you generate.`,
      '',
      '## Step 1 — Resolve the trait to one or more observation variables',
      `1. Call \`brapi_find_variables\` with \`text: "${args.traitName}"${aliasArg}\` to score candidates via the OntologyResolver.`,
      '2. Inspect `ontologyCandidates`. If exactly one candidate has an unambiguous PUI / trait name match, use it. If multiple variables represent the same biological trait (e.g. "Dry Matter %" measured by gravimetric vs NIR methods), keep all of them and note the method differences — you will harmonize later.',
      '3. Record the resulting `observationVariableDbId[]` and the scale `dataType` and `scaleName` for each. Numeric scales can be averaged across studies; categorical scales need a mapping table before pooling.',
      '',
      '## Step 2 — Discover studies that measured the trait on the target germplasm',
      `1. Call \`brapi_find_observations\` with \`germplasm: ${idsLiteral}\` and \`variables: [<resolved variable DbIds from Step 1>]\`${aliasArg}, \`loadLimit: 200\`.`,
      '2. If the response warns that an unanchored observation query stalled, do not retry the same germplasm-only shape. Use study anchors when available: re-call `brapi_find_observations` with both `studies: ["<studyDbId>"]` and the target `germplasm` / `variables` filters, one candidate study at a time.',
      '3. From `distributions.studyName`, capture the distinct studies returning observations. If `hasMore` is true and a `dataset` handle is returned, page through with `brapi_manage_dataset` (mode: `load`) to materialize the full set.',
      '4. For each study, call `brapi_get_study` to capture program, location, season, and trial context — these are the moderators in the meta-analysis.',
      '',
      '## Step 3 — Build the per-observation table',
      'For each observation row, capture:',
      '',
      '| Column | Source |',
      '|:-------|:-------|',
      '| `germplasmDbId` / `germplasmName` | observation row |',
      '| `studyDbId` / `studyName` | observation row + Step 2 |',
      '| `season` | observation row |',
      '| `locationDbId` / `locationName` | study record from Step 2 |',
      '| `programDbId` / `programName` | study record from Step 2 |',
      '| `observationVariableDbId` / `observationVariableName` | observation row |',
      '| `methodName`, `scaleName`, `dataType` | variable record from Step 1 |',
      '| `value` (raw) | observation row |',
      '| `value_num` (parsed) | parse `value` as number for numeric scales |',
      '| `observationTimeStamp` | observation row |',
      '',
      '## Step 4 — Harmonize',
      '1. **Numeric scales** — confirm all observations use the same unit. If multiple scales appear (e.g. percent vs decimal fraction), normalize to a single canonical unit and document the conversion factor.',
      "2. **Categorical scales** — build an explicit mapping table from each scale's category values to a shared ordinal or nominal scheme. Drop observations that cannot be mapped and report the count.",
      '3. **Method differences** — note whether different `methodName` values are pooled together. If methods are biologically distinct (e.g. visual vs instrumented), keep them as separate strata in the summary, not merged.',
      '',
      '## Step 5 — Per-germplasm × per-study summary',
      'Compute a wide table indexed by `germplasmDbId × studyDbId`:',
      '',
      '- Numeric variables: `n`, `mean`, `sd`, `min`, `max`, `cv = sd / mean`.',
      '- Categorical variables: mode, modal-frequency, count-per-category.',
      '',
      'Flag cells where `n < 3` (insufficient replication) and cells with `cv > 0.30` (high within-study variability).',
      '',
      '## Step 6 — Across-study meta-summary',
      'For each germplasm, summarize across studies:',
      '',
      "- **Numeric:** unweighted across-study mean, between-study variance (Cochran's Q proxy), grand min and max, study count.",
      '- **Categorical:** dominant category and the share of studies in which that category was modal.',
      '',
      'Identify germplasm with high between-study variance (`Q proxy / mean^2 > 0.05`) — those are the candidates for genotype × environment interaction follow-up.',
      '',
      '## Step 7 — Pedigree side-quest',
      `Optional: call \`brapi_walk_pedigree\` with \`germplasmDbIds: ${idsLiteral}\`, \`direction: "ancestors"\`, \`maxDepth: 2${aliasArg}\` to surface common parents. If the meta-analysis germplasm share a parent and exhibit similar trait values, that supports a heritability story; if they diverge, environment likely dominates.`,
      '',
      '## Report',
      'Produce a markdown report with the following sections:',
      '1. **Inputs** — verbatim trait name + germplasm IDs as supplied.',
      '2. **Variable resolution** — the variable(s) selected and why; any ambiguity left unresolved.',
      '3. **Studies** — table of contributing studies with program/location/season.',
      '4. **Harmonization log** — every unit conversion, scale mapping, and method-stratification decision.',
      '5. **Per-germplasm × per-study table** — Step 5 output.',
      '6. **Across-study summary** — Step 6 output, sorted by between-study variance descending.',
      '7. **Pedigree notes** — Step 7 if you ran it.',
      '8. **Caveats** — missing data rates, dropped observations, sample-size warnings, capability gaps from the server (e.g. ontology endpoint missing).',
      '',
      'Reproducibility is non-negotiable: cite the dataset handle returned by every `find_*` call so a future agent can re-run with the same upstream snapshot.',
    ].join('\n');

    return [
      {
        role: 'user',
        content: { type: 'text', text },
      },
    ];
  },
});
