/**
 * @fileoverview Server-specific configuration for brapi-mcp-server. Covers
 * default connection details, HTTP client behavior (timeouts, retries,
 * concurrency), async-search polling, dataset lifecycle, and reference-data
 * cache tuning. Lazy-parsed via `parseEnvConfig` so env-var names appear in
 * validation errors.
 *
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
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
    .describe('TTL for datasets held in DatasetStore (seconds).'),
  datasetStoreDir: z
    .string()
    .optional()
    .describe('Filesystem path for DatasetStore payloads when filesystem storage is active.'),

  loadLimit: z.coerce
    .number()
    .int()
    .positive()
    .default(200)
    .describe('Default row cap returned in-context before spilling to DatasetStore.'),
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
    datasetStoreDir: 'BRAPI_DATASET_STORE_DIR',
    loadLimit: 'BRAPI_LOAD_LIMIT',
    maxConcurrentRequests: 'BRAPI_MAX_CONCURRENT_REQUESTS',
    retryMaxAttempts: 'BRAPI_RETRY_MAX_ATTEMPTS',
    retryBaseDelayMs: 'BRAPI_RETRY_BASE_DELAY_MS',
    referenceCacheTtlSeconds: 'BRAPI_REFERENCE_CACHE_TTL_SECONDS',
    requestTimeoutMs: 'BRAPI_REQUEST_TIMEOUT_MS',
    searchPollTimeoutMs: 'BRAPI_SEARCH_POLL_TIMEOUT_MS',
    searchPollIntervalMs: 'BRAPI_SEARCH_POLL_INTERVAL_MS',
    allowPrivateIps: 'BRAPI_ALLOW_PRIVATE_IPS',
    enableWrites: 'BRAPI_ENABLE_WRITES',
  });
  return _config;
}

/** Test-only — reset the lazy cache between suites. */
export function resetServerConfig(): void {
  _config = undefined;
}
