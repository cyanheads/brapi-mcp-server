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
      'Default row cap returned in-context before spilling to a canvas dataframe. Also doubles as the upstream `pageSize` used during spillover walks — the dataframe ceiling is `loadLimit × MAX_SPILLOVER_PAGES (50)`, so the 1,000 default lines up with the documented 50,000-row spillover cap. Operators on small/test BrAPI servers can lower it; raising it above 1,000 is rarely useful because most BrAPI servers cap server-side pageSize at 1,000.',
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
    .describe('Max retries on 429/5xx before surfacing.'),
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
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true')
    .describe('Allow connecting to RFC 1918 / loopback targets. Dev-only.'),
  enableWrites: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true')
    .describe(
      'Opt-in flag for the write surface (`brapi_submit_observations`). Off by default — the tool is omitted from `tools/list` unless the operator opts in for this deployment.',
    ),
  genotypeCallsMaxPull: z.coerce
    .number()
    .int()
    .positive()
    .max(500_000)
    .default(100_000)
    .describe(
      'Hard ceiling on rows pulled from the upstream BrAPI server in a single brapi_find_genotype_calls invocation. Bounds total page count per query — protects the upstream from unbounded pagination loops. Default 100,000 (≈10 pages at the standard pageSize=10,000); maximum 500,000 (≈50 pages, matching the per-query budget of other find_* tools).',
    ),

  canvasDropEnabled: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true')
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
      'Hard upper bound on rows materialized into a brapi_dataframe_query response. Larger result sets must use registerAs to keep the full set in the workspace.',
    ),
  canvasQueryTimeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .default(30_000)
    .describe('Per-query wall-clock timeout for brapi_dataframe_query.'),

  sessionIsolation: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true')
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
    canvasDropEnabled: 'BRAPI_CANVAS_DROP_ENABLED',
    exportDir: 'BRAPI_EXPORT_DIR',
    canvasMaxRows: 'BRAPI_CANVAS_MAX_ROWS',
    canvasQueryTimeoutMs: 'BRAPI_CANVAS_QUERY_TIMEOUT_MS',
    sessionIsolation: 'BRAPI_SESSION_ISOLATION',
  });
  return _config;
}

/** Test-only — reset the lazy cache between suites. */
export function resetServerConfig(): void {
  _config = undefined;
}
