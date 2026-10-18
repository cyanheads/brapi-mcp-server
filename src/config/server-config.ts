/**
 * @fileoverview Server-specific configuration for brapi-mcp-server. Covers
 * default connection details, HTTP client behavior (timeouts, retries,
 * concurrency), async-search polling, dataframe lifecycle, and reference-data
 * cache tuning. Lazy-parsed via `parseEnvConfig` so env-var names appear in
 * validation errors.
 *
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';
import { configurationError } from '@cyanheads/mcp-ts-core/errors';

/**
 * Absolute upper bound on `genotypeCallsMaxPull`, and therefore on any
 * caller-supplied `maxCalls` override. No deployment can configure a ceiling
 * above this, so a tool input above it can never be honored — the input schemas
 * bound against this constant rather than restating the literal, keeping the
 * advertised input range and the deployment ceiling from drifting apart.
 */
export const GENOTYPE_CALLS_MAX_PULL_CEILING = 500_000;

/**
 * Absolute upper bound on `genotypeMatrixMaxColumns`, and therefore on any
 * caller-supplied `maxColumns` override to `brapi_export_genotype_matrix`. A
 * matrix's distinct-variant column count can never exceed the genotype-call
 * pull it is derived from, so it shares {@link GENOTYPE_CALLS_MAX_PULL_CEILING}'s
 * absolute ceiling; the tool input schema bounds against this constant rather
 * than restating the literal, keeping the advertised input range and the
 * deployment ceiling from drifting apart.
 */
export const GENOTYPE_MATRIX_MAX_COLUMNS_CEILING = 500_000;

export const ServerConfigSchema = z.object({
  defaultBaseUrl: z
    .string()
    .url()
    .optional()
    .describe('Default BrAPI v2 base URL if no connection is opened via brapi_connect.'),
  defaultUsername: z
    .string()
    .optional()
    .describe('Default SGN-family username for session-token auth.'),
  defaultPassword: z
    .string()
    .optional()
    .describe('Default SGN-family password for session-token auth.'),
  defaultOauthClientId: z
    .string()
    .optional()
    .describe('Default OAuth2 client ID (e.g. CGIAR-family servers).'),
  defaultOauthClientSecret: z.string().optional().describe('Default OAuth2 client secret.'),
  defaultApiKey: z.string().optional().describe('Default static API key.'),
  defaultApiKeyHeader: z
    .string()
    .default('Authorization')
    .describe('Header name to carry the static API key.'),

  datasetTtlSeconds: z.coerce
    .number()
    .int()
    .positive()
    .default(86_400)
    .describe('TTL for dataframe provenance metadata persisted alongside spilled rows (seconds).'),

  loadLimit: z.coerce
    .number()
    .int()
    .positive()
    .default(1_000)
    .describe(
      'Default in-context row cap for find_* tools. A 24,000-byte budget also bounds the inline rows, whichever binds first; when either cuts them short of the matched set, the matched rows land in a canvas dataframe — query with brapi_dataframe_query (SQL). Also the default per-study cap on matching observations collected by brapi_build_phenotype_matrix and brapi_germplasm_performance.',
    ),
  pageSize: z.coerce
    .number()
    .int()
    .positive()
    .default(1_000)
    .describe(
      'Upstream pageSize used during canvas spillover walks. Decoupled from loadLimit so lowering the inline preview cap no longer shrinks the dataframe ceiling. Most BrAPI servers cap pageSize at 1,000; the dataframe ceiling is pageSize × 50 pages, capped at 50,000 rows.',
    ),
  maxConcurrentRequests: z.coerce
    .number()
    .int()
    .positive()
    .default(4)
    .describe('Per-connection concurrency cap for parallel upstream fan-out.'),
  retryMaxAttempts: z.coerce
    .number()
    .int()
    .min(0)
    .default(3)
    .describe(
      "Max retries on 429/5xx and timeouts before surfacing. A timed-out request is retried only while the call's 50 s upstream deadline still fits another attempt.",
    ),
  retryBaseDelayMs: z.coerce
    .number()
    .int()
    .positive()
    .default(500)
    .describe('Base delay for exponential backoff in retry.'),
  referenceCacheTtlSeconds: z.coerce
    .number()
    .int()
    .positive()
    .default(3_600)
    .describe('TTL for ReferenceDataCache entries (programs, trials, locations, crops).'),

  requestTimeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .default(30_000)
    .describe('Per-request HTTP timeout.'),
  companionTimeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .default(8_000)
    .describe(
      'Tighter timeout for non-critical companion enrichments (FK lookups, count probes). Companions also bypass the retry budget so a slow upstream surfaces a warning instead of stretching the response by 4×.',
    ),
  searchPollTimeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .default(60_000)
    .describe('Total wait budget for async /search/{noun}/{id} polling.'),
  searchPollIntervalMs: z.coerce
    .number()
    .int()
    .positive()
    .default(1_000)
    .describe('Poll interval between async-search status checks.'),
  allowPrivateIps: z
    .stringbool()
    .default(false)
    .describe('Allow connecting to RFC 1918 / loopback targets. Dev-only.'),
  enableWrites: z
    .stringbool()
    .default(false)
    .describe(
      'Opt-in flag for the write surface (`brapi_submit_observations`). Off by default — the tool is omitted from `tools/list` unless the operator opts in for this deployment.',
    ),
  genotypeCallsMaxPull: z.coerce
    .number()
    .int()
    .positive()
    .max(GENOTYPE_CALLS_MAX_PULL_CEILING)
    .default(100_000)
    .describe(
      'Hard ceiling on rows pulled from the upstream BrAPI server in a single brapi_find_genotype_calls or brapi_export_genotype_matrix invocation. Bounds total page count per query — protects the upstream from unbounded pagination loops. brapi_export_genotype_matrix accepts a maxCalls override but clamps it to this value, so the ceiling holds regardless of caller input. Default 100,000 (≈10 pages at the standard pageSize=10,000); maximum 500,000 (≈50 pages, matching the per-query budget of other find_* tools).',
    ),
  genotypeMatrixMaxColumns: z.coerce
    .number()
    .int()
    .positive()
    .max(GENOTYPE_MATRIX_MAX_COLUMNS_CEILING)
    .default(10_000)
    .describe(
      'Hard ceiling on the number of distinct variant columns brapi_export_genotype_matrix pivots into a single germplasm × variant matrix. Bounds the wide canvas dataframe, the variantColumnLegend, and any VCF/PLINK serialization — all of which scale with column count independently of the row (call) pull cap. A schema-legal skew (one germplasm × many variants) can otherwise drive the column count to the full genotypeCallsMaxPull budget and emit a multi-megabyte legend. brapi_export_genotype_matrix accepts a maxColumns override but clamps it to this value, so the ceiling holds regardless of caller input. Default 10,000 (legend ≈ 250 KB) — an order of magnitude below genotypeCallsMaxPull; maximum 500,000. Raise it only when a wide panel genuinely needs more variant columns inline.',
    ),

  canvasDropEnabled: z
    .stringbool()
    .default(false)
    .describe(
      'Opt-in flag for `brapi_dataframe_drop`. Off by default — the tool is omitted from `tools/list` unless the operator opts in. Dataframes still expire via TTL when left unmanaged.',
    ),
  exportDir: z
    .string()
    .optional()
    .describe(
      'Filesystem directory for `brapi_dataframe_export` output files. When unset, the export tool is omitted from `tools/list` (no separate enable flag — setting the path *is* the opt-in). The framework reads the resolved path from `CANVAS_EXPORT_PATH`; the entry point bridges `BRAPI_EXPORT_DIR` → `CANVAS_EXPORT_PATH` so operators only need to set the brapi-prefixed name. Stdio-only — under `MCP_TRANSPORT_TYPE=http` the tool stays disabled regardless of this value because the returned path lives on the server, not the user.',
    ),
  canvasMaxRows: z.coerce
    .number()
    .int()
    .positive()
    .default(10_000)
    .describe(
      'Hard upper bound on rows materialized into a brapi_dataframe_query response. Larger result sets must use registerAs to keep the full set in the workspace. Must not exceed the framework canvas row limit (CANVAS_DEFAULT_ROW_LIMIT, default 10,000) — startup fails when it does, since the canvas rejects every query whose row limit is above its own.',
    ),
  canvasQueryTimeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .default(30_000)
    .describe('Per-query wall-clock timeout for brapi_dataframe_query.'),

  sessionIsolation: z
    .stringbool()
    .default(true)
    .describe(
      'When true (default) and an MCP session ID is present (HTTP stateful/auto), scope ServerRegistry connection state and the CanvasBridge default canvas to the session. Concurrent HTTP callers under MCP_AUTH_MODE=none then operate in isolated workspaces — registered aliases, exchanged tokens, and df_<uuid> namespaces do not cross sessions. Set to false to share state across sessions in one tenant (the pre-0.6 multi-agent collaboration model). No effect on stdio (no session) or HTTP stateless without exposeStatelessSessionId; both fall back to per-tenant keying. Under MCP_AUTH_MODE=jwt|oauth, tenants already isolate — sessions add a sub-scope inside each tenant.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    defaultBaseUrl: 'BRAPI_DEFAULT_BASE_URL',
    defaultUsername: 'BRAPI_DEFAULT_USERNAME',
    defaultPassword: 'BRAPI_DEFAULT_PASSWORD',
    defaultOauthClientId: 'BRAPI_DEFAULT_OAUTH_CLIENT_ID',
    defaultOauthClientSecret: 'BRAPI_DEFAULT_OAUTH_CLIENT_SECRET',
    defaultApiKey: 'BRAPI_DEFAULT_API_KEY',
    defaultApiKeyHeader: 'BRAPI_DEFAULT_API_KEY_HEADER',
    datasetTtlSeconds: 'BRAPI_DATASET_TTL_SECONDS',
    loadLimit: 'BRAPI_LOAD_LIMIT',
    pageSize: 'BRAPI_PAGE_SIZE',
    maxConcurrentRequests: 'BRAPI_MAX_CONCURRENT_REQUESTS',
    retryMaxAttempts: 'BRAPI_RETRY_MAX_ATTEMPTS',
    retryBaseDelayMs: 'BRAPI_RETRY_BASE_DELAY_MS',
    referenceCacheTtlSeconds: 'BRAPI_REFERENCE_CACHE_TTL_SECONDS',
    requestTimeoutMs: 'BRAPI_REQUEST_TIMEOUT_MS',
    companionTimeoutMs: 'BRAPI_COMPANION_TIMEOUT_MS',
    searchPollTimeoutMs: 'BRAPI_SEARCH_POLL_TIMEOUT_MS',
    searchPollIntervalMs: 'BRAPI_SEARCH_POLL_INTERVAL_MS',
    allowPrivateIps: 'BRAPI_ALLOW_PRIVATE_IPS',
    enableWrites: 'BRAPI_ENABLE_WRITES',
    genotypeCallsMaxPull: 'BRAPI_GENOTYPE_CALLS_MAX_PULL',
    genotypeMatrixMaxColumns: 'BRAPI_GENOTYPE_MATRIX_MAX_COLUMNS',
    canvasDropEnabled: 'BRAPI_CANVAS_DROP_ENABLED',
    exportDir: 'BRAPI_EXPORT_DIR',
    canvasMaxRows: 'BRAPI_CANVAS_MAX_ROWS',
    canvasQueryTimeoutMs: 'BRAPI_CANVAS_QUERY_TIMEOUT_MS',
    sessionIsolation: 'BRAPI_SESSION_ISOLATION',
  });
  return _config;
}

/**
 * Fail startup when `BRAPI_CANVAS_MAX_ROWS` exceeds the framework canvas row
 * limit (`CANVAS_DEFAULT_ROW_LIMIT`). The bridge passes the configured cap to
 * the canvas as each query's row limit, and the canvas rejects any limit above
 * its own, so the pair would otherwise start cleanly and then fail every
 * `brapi_dataframe_query` call. Called from `setup()`, where both configs are
 * parsed, so the error prints behind the framework's startup config banner.
 */
export function assertCanvasMaxRowsWithinCanvasLimit(
  serverConfig: Pick<ServerConfig, 'canvasMaxRows'>,
  canvasRowLimit: number,
): void {
  if (serverConfig.canvasMaxRows <= canvasRowLimit) return;
  throw configurationError(
    `BRAPI_CANVAS_MAX_ROWS (${serverConfig.canvasMaxRows}) exceeds the framework canvas row limit CANVAS_DEFAULT_ROW_LIMIT (${canvasRowLimit}); the canvas would reject every brapi_dataframe_query. Set BRAPI_CANVAS_MAX_ROWS to ${canvasRowLimit} or less, or raise CANVAS_DEFAULT_ROW_LIMIT.`,
    { canvasMaxRows: serverConfig.canvasMaxRows, canvasRowLimit },
  );
}

/**
 * Resolve the `brapi_dataframe_export` registration gate. Two reasons it can be
 * off: (1) running under HTTP transport — file paths only make sense when the
 * server lives on the user's machine, (2) `BRAPI_EXPORT_DIR` unset — setting it
 * is the opt-in (no separate enable flag). Returns `null` when the tool should
 * register, otherwise the operator metadata to wrap the disabled tool with.
 * `config` is `undefined` when the server config failed to parse.
 */
export function resolveDataframeExportGate(
  config: Pick<ServerConfig, 'exportDir'> | undefined,
): { reason: string; hint: string } | null {
  const transportMode = process.env.MCP_TRANSPORT_TYPE ?? 'stdio';
  if (transportMode !== 'stdio') {
    return {
      reason: 'Dataframe export requires stdio transport.',
      hint: 'File paths must resolve on the same machine as the user — run the server with MCP_TRANSPORT_TYPE=stdio to enable.',
    };
  }
  if (!config?.exportDir) {
    return {
      reason: 'Dataframe export is unconfigured (BRAPI_EXPORT_DIR unset).',
      hint: 'Set BRAPI_EXPORT_DIR to a writable directory on the server host to enable file export.',
    };
  }
  return null;
}

/**
 * True when `brapi_dataframe_export` is registered, so a response names the
 * export tool only where a client can call it.
 */
export function isDataframeExportRegistered(): boolean {
  return resolveDataframeExportGate(getServerConfig()) === null;
}

/** Test-only — reset the lazy cache between suites. */
export function resetServerConfig(): void {
  _config = undefined;
}
