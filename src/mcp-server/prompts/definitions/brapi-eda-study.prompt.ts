/**
 * @fileoverview `brapi_eda_study` — exploratory-data-analysis playbook for a
 * single BrAPI study. Walks the agent through structure, variables, coverage,
 * outliers, and missing-data checks using the curated `brapi_*` tool surface.
 * Pure prompt template: no Context, no auth, no side effects.
 *
 * @module mcp-server/prompts/definitions/brapi-eda-study.prompt
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

export const brapiEdaStudy = prompt('brapi_eda_study', {
  description:
    'Run an exploratory-data-analysis pass over a single BrAPI study — structure, variables, coverage, outliers, missing data — using the curated brapi_* tools.',
  args: z.object({
    studyDbId: z
      .string()
      .min(1)
      .describe('Target studyDbId. Locate via brapi_find_studies if unknown.'),
    alias: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional()
      .describe(
        'Connection alias registered via brapi_connect. Omit to use the default connection.',
      ),
  }),
  generate: (args) => {
    const aliasArg = args.alias ? `, alias: "${args.alias}"` : '';
    const text = [
      `You are running an exploratory data analysis (EDA) on BrAPI study \`${args.studyDbId}\`. Work through the steps below and produce a written report at the end. Use the curated \`brapi_*\` tools — do not hand-roll HTTP. If a step requires a capability the server does not advertise, note the gap and continue.`,
      '',
      '## Step 1 — Orient',
      `1. Call \`brapi_get_study\` with \`studyDbId: "${args.studyDbId}"${aliasArg}\` to pull the study record, resolved program/trial/location, and companion counts (\`observationCount\`, \`observationUnitCount\`, \`variableCount\`).`,
      '2. Note the season(s), crop, and active state. Capture the three companion counts — they bound everything that follows.',
      '',
      '## Step 2 — Variables',
      `1. Call \`brapi_find_variables\` with \`studies: ["${args.studyDbId}"]${aliasArg}\` to enumerate the observation variables measured in this study.`,
      '2. For each variable record the trait name, trait class, scale data type (numerical / categorical / date / text), and unit/scale name.',
      '3. Group variables by trait class and by scale data type — the breakdown drives which downstream checks make sense (numerical → outlier checks; categorical → distribution checks).',
      '',
      '## Step 3 — Observation coverage',
      `1. Call \`brapi_find_observations\` with \`studies: ["${args.studyDbId}"]${aliasArg}\` and a \`loadLimit\` large enough to materialize the full study in one shot if \`observationCount\` from Step 1 fits, otherwise spill to a dataset and read it back via \`brapi_manage_dataset\` (mode: \`load\`).`,
      '2. From the response `distributions`, capture: observations per variable, observations per germplasm, observations per observation level (plot / plant / field), and observations per season.',
      '3. Compute coverage = `observationCount` ÷ (`observationUnitCount` × `variableCount`). Anything materially below 1.0 implies missing measurements.',
      '',
      '## Step 4 — Missing data',
      '1. From the rows pulled in Step 3, count observations with `value == null`, `value == ""`, or values matching the unknown sentinel from the variable\'s scale (e.g. `.`, `NA`, `999`).',
      '2. Cross-tab missing-rate by variable and by germplasm. Surface the top-3 worst offenders on each axis.',
      '',
      '## Step 5 — Outliers (numerical variables only)',
      '1. For each numerical variable, parse `value` as a number (skip non-numeric).',
      '2. Compute median and IQR. Flag values outside [Q1 − 1.5·IQR, Q3 + 1.5·IQR].',
      "3. Cross-reference outliers with the scale's declared min/max if present — values outside the scale range are data-entry errors, values inside but outside IQR are biological outliers worth a second look.",
      '',
      '## Step 6 — Pedigree context (optional)',
      `1. Pick the top-5 germplasm by observation count from Step 3. Call \`brapi_walk_pedigree\` with \`germplasmDbIds: [...]\`, \`direction: "ancestors"\`, \`maxDepth: 2${aliasArg}\` to surface immediate parentage.`,
      '2. Note any common ancestors — they may explain trait covariance.',
      '',
      '## Report',
      'Produce a markdown report with the following sections:',
      '1. **Study summary** — name, crop, seasons, location, program, observation/unit/variable counts.',
      '2. **Variables** — table grouped by trait class with scale type and unit.',
      '3. **Coverage** — overall coverage ratio plus the per-variable and per-germplasm distributions.',
      '4. **Missing data** — top-3 worst variables and germplasm by missing rate.',
      '5. **Outliers** — per-variable outlier list (DbId, value, reason: out-of-range vs IQR).',
      '6. **Pedigree notes** — common ancestors among top-observed germplasm.',
      '7. **Recommended next steps** — concrete follow-ups (e.g. "re-measure variable X on germplasm Y", "expand pedigree walk to depth 4 on accession Z").',
      '',
      'Be honest about gaps — if the server lacks `/ontologies` and trait classes are sparse, say so. If `observationCount` is zero, stop after Step 1 and report that the study has no recorded observations yet.',
    ].join('\n');

    return [
      {
        role: 'user',
        content: { type: 'text', text },
      },
    ];
  },
});
