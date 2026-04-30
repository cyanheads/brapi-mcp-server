/**
 * @fileoverview Shared builder for the BrAPI orientation envelope returned
 * by both `brapi_connect` (inlined after registration) and
 * `brapi_server_info` (on-demand). Pulls from CapabilityRegistry and the
 * active ServerRegistry entry, then layers in cheap opportunistic counts via
 * `pageSize=1` probes. Counts degrade silently — a server that doesn't
 * honor the probe just omits the field rather than failing the whole call.
 *
 * @module mcp-server/tools/shared/orientation-envelope
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import type { BrapiClient, BrapiRequestOptions } from '@/services/brapi-client/index.js';
import type {
  CapabilityLookupOptions,
  CapabilityRegistry,
} from '@/services/capability-registry/index.js';
import type { RegisteredServer } from '@/services/server-registry/index.js';

/**
 * BrAPI endpoints we treat as the "common floor" — their absence is worth
 * surfacing as a notable gap in the orientation envelope so the agent knows
 * which tools will fail before they call them.
 */
const COMMON_FLOOR = [
  'studies',
  'germplasm',
  'observations',
  'observationunits',
  'variables',
  'programs',
  'trials',
  'locations',
  'seasons',
  'search/studies',
  'search/germplasm',
  'search/observations',
];

export const ServerIdentitySchema = z
  .object({
    name: z.string().optional().describe('Server display name from /serverinfo.'),
    description: z.string().optional().describe('Free-form server description.'),
    organizationName: z.string().optional().describe('Hosting organization.'),
    organizationURL: z.string().optional().describe('Organization website.'),
    documentationURL: z.string().optional().describe('Documentation URL for this server.'),
    contactEmail: z.string().optional().describe('Contact email for the operator.'),
    brapiVersion: z.string().optional().describe('Highest BrAPI version the server reports.'),
  })
  .describe('Normalized identity fields from /serverinfo. Every field is optional.');

export const OrientationAuthSchema = z
  .object({
    mode: z
      .enum(['none', 'sgn', 'oauth2', 'api_key', 'bearer'])
      .describe('Auth mode of the active connection.'),
    headerName: z.string().optional().describe('HTTP header carrying credentials.'),
    expiresAt: z.string().optional().describe('ISO 8601 token-expiry timestamp, when known.'),
  })
  .describe('Auth summary for the active connection — no secrets returned.');

export const OrientationCapabilitiesSchema = z
  .object({
    supportedCount: z
      .number()
      .int()
      .nonnegative()
      .describe('Total distinct services the server advertises in /calls.'),
    supported: z
      .array(z.string().describe('BrAPI service name (e.g. "studies", "search/germplasm").'))
      .describe('Sorted list of supported service names.'),
    notableGaps: z
      .array(z.string().describe('Common-floor service the server does not expose.'))
      .describe('Common-floor services this server does NOT expose.'),
  })
  .describe('Capability profile summary. Downstream tools pre-flight against `supported`.');

export const OrientationContentSchema = z
  .object({
    crops: z
      .array(z.string().describe('Common crop name as returned by /commoncropnames.'))
      .describe('Crops the server declares via /commoncropnames.'),
    studyCount: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Total studies hosted, when the server exposes a cheap count.'),
    germplasmCount: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Total germplasm hosted, when the server exposes a cheap count.'),
    programCount: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Total programs hosted, when the server exposes a cheap count.'),
    locationCount: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Total locations hosted, when the server exposes a cheap count.'),
  })
  .describe('Content summary. Counts are populated only when the server supports cheap totals.');

export const OrientationEnvelopeSchema = z.object({
  alias: z.string().describe('Connection alias.'),
  baseUrl: z.string().describe('BrAPI v2 base URL for this connection.'),
  server: ServerIdentitySchema.describe('Normalized server identity block.'),
  auth: OrientationAuthSchema.describe('Auth summary for the active connection.'),
  capabilities: OrientationCapabilitiesSchema.describe(
    'Capability profile derived from /serverinfo.',
  ),
  content: OrientationContentSchema.describe('Content summary (crops + optional totals).'),
  notes: z
    .array(z.string().describe('Server-specific quirk or degradation note.'))
    .describe('Server-specific quirks or degradation notes.'),
  fetchedAt: z.string().describe('ISO 8601 timestamp of when this envelope was composed.'),
});

export type OrientationEnvelope = z.infer<typeof OrientationEnvelopeSchema>;

export interface BuildEnvelopeDeps {
  client: BrapiClient;
  registry: CapabilityRegistry;
}

/**
 * Compose the orientation envelope for a connected server. Runs the
 * CapabilityRegistry profile (cached after the first call) plus a parallel
 * set of cheap `pageSize=1` probes for totals. BrAPI v2.1 mandates
 * `pageSize >= 1` — strict servers reject `pageSize=0` with HTTP 400, so
 * we ask for one row and ignore it; only `metadata.pagination.totalCount`
 * matters here.
 */
export async function buildOrientationEnvelope(
  ctx: Context,
  connection: RegisteredServer,
  deps: BuildEnvelopeDeps,
): Promise<OrientationEnvelope> {
  const baseRequestOptions: BrapiRequestOptions = {};
  if (connection.resolvedAuth) baseRequestOptions.auth = connection.resolvedAuth;

  const capabilityLookup: CapabilityLookupOptions = {};
  if (connection.resolvedAuth) capabilityLookup.auth = connection.resolvedAuth;
  const profile = await deps.registry.profile(connection.baseUrl, ctx, capabilityLookup);

  const supportedServices = Object.keys(profile.supported).sort();
  const supportedSet = new Set(supportedServices);
  const notableGaps = COMMON_FLOOR.filter((svc) => !supportedSet.has(svc));

  const notes: string[] = [];
  if (supportedServices.length === 0) {
    notes.push(
      'Server did not advertise any calls via /serverinfo or /calls — downstream tools will fail until the capability profile populates.',
    );
  }
  if (!profile.server.brapiVersion) {
    notes.push(
      'Server did not declare a BrAPI version; treating as v2 by default. Behavior may vary.',
    );
  }

  const counts = await fetchOpportunisticCounts(
    deps.client,
    connection.baseUrl,
    ctx,
    supportedSet,
    baseRequestOptions,
  );

  const content: OrientationEnvelope['content'] = { crops: profile.crops };
  if (counts.studyCount !== undefined) content.studyCount = counts.studyCount;
  if (counts.germplasmCount !== undefined) content.germplasmCount = counts.germplasmCount;
  if (counts.programCount !== undefined) content.programCount = counts.programCount;
  if (counts.locationCount !== undefined) content.locationCount = counts.locationCount;

  const auth: OrientationEnvelope['auth'] = { mode: connection.authMode };
  if (connection.resolvedAuth?.headerName) auth.headerName = connection.resolvedAuth.headerName;
  if (connection.resolvedAuth?.expiresAt) auth.expiresAt = connection.resolvedAuth.expiresAt;

  return {
    alias: connection.alias,
    baseUrl: connection.baseUrl,
    server: { ...profile.server },
    auth,
    capabilities: {
      supportedCount: supportedServices.length,
      supported: supportedServices,
      notableGaps,
    },
    content,
    notes,
    fetchedAt: new Date().toISOString(),
  };
}

interface OpportunisticCounts {
  germplasmCount?: number;
  locationCount?: number;
  programCount?: number;
  studyCount?: number;
}

async function fetchOpportunisticCounts(
  client: BrapiClient,
  baseUrl: string,
  ctx: Context,
  supportedSet: Set<string>,
  baseOptions: BrapiRequestOptions,
): Promise<OpportunisticCounts> {
  const probes: Array<{ key: keyof OpportunisticCounts; path: string; service: string }> = [
    { key: 'studyCount', path: '/studies', service: 'studies' },
    { key: 'germplasmCount', path: '/germplasm', service: 'germplasm' },
    { key: 'programCount', path: '/programs', service: 'programs' },
    { key: 'locationCount', path: '/locations', service: 'locations' },
  ];

  const attempts = probes
    .filter((probe) => supportedSet.has(probe.service))
    .map(async (probe) => {
      try {
        const env = await client.get<unknown>(baseUrl, probe.path, ctx, {
          ...baseOptions,
          params: { pageSize: 1 },
        });
        const total = env.metadata?.pagination?.totalCount;
        if (typeof total === 'number' && Number.isFinite(total)) {
          return { key: probe.key, total };
        }
      } catch (err) {
        ctx.log.debug('Opportunistic count probe failed', {
          path: probe.path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    });

  const settled = await Promise.all(attempts);
  const result: OpportunisticCounts = {};
  for (const entry of settled) {
    if (!entry) continue;
    result[entry.key] = entry.total;
  }
  return result;
}

export function formatOrientationEnvelope(envelope: OrientationEnvelope): string {
  const lines: string[] = [];
  const title = envelope.server.name ?? envelope.alias;
  lines.push(`# Connected: ${title}`);
  lines.push('');
  lines.push(`- **Alias:** ${envelope.alias}`);
  lines.push(`- **Base URL:** ${envelope.baseUrl}`);
  lines.push(`- **BrAPI version:** ${envelope.server.brapiVersion ?? 'unknown'}`);
  if (envelope.server.organizationName)
    lines.push(`- **Organization:** ${envelope.server.organizationName}`);
  if (envelope.server.description) lines.push(`- **Description:** ${envelope.server.description}`);
  if (envelope.server.documentationURL)
    lines.push(`- **Docs:** ${envelope.server.documentationURL}`);
  if (envelope.server.contactEmail) lines.push(`- **Contact:** ${envelope.server.contactEmail}`);
  if (envelope.server.organizationURL)
    lines.push(`- **Organization URL:** ${envelope.server.organizationURL}`);

  lines.push('');
  lines.push(
    `**Auth:** ${envelope.auth.mode}${envelope.auth.headerName ? ` (header: ${envelope.auth.headerName})` : ''}${envelope.auth.expiresAt ? ` · expires ${envelope.auth.expiresAt}` : ''}`,
  );

  lines.push('');
  lines.push('## Capabilities');
  lines.push(`- ${envelope.capabilities.supportedCount} service(s) advertised`);
  if (envelope.capabilities.supported.length > 0) {
    lines.push(`- Supported: ${envelope.capabilities.supported.join(', ')}`);
  }
  if (envelope.capabilities.notableGaps.length > 0) {
    lines.push(
      `- Notable gaps (missing from the common floor): ${envelope.capabilities.notableGaps.join(', ')}`,
    );
  }

  lines.push('');
  lines.push('## Content');
  if (envelope.content.crops.length > 0) {
    lines.push(
      `- **Crops (${envelope.content.crops.length}):** ${envelope.content.crops.join(', ')}`,
    );
  } else {
    lines.push('- Crops: — (server did not expose /commoncropnames)');
  }
  if (envelope.content.studyCount !== undefined)
    lines.push(`- Studies: ${envelope.content.studyCount}`);
  if (envelope.content.germplasmCount !== undefined)
    lines.push(`- Germplasm: ${envelope.content.germplasmCount}`);
  if (envelope.content.programCount !== undefined)
    lines.push(`- Programs: ${envelope.content.programCount}`);
  if (envelope.content.locationCount !== undefined)
    lines.push(`- Locations: ${envelope.content.locationCount}`);

  if (envelope.notes.length > 0) {
    lines.push('');
    lines.push('## Notes');
    for (const note of envelope.notes) lines.push(`- ${note}`);
  }

  lines.push('');
  lines.push(`_Fetched at ${envelope.fetchedAt}._`);
  return lines.join('\n');
}
