/**
 * @fileoverview Tests for the orientation envelope — formatter headline
 * accuracy when the server advertises zero services (the "registered but
 * unreachable" case), structural sanity for the full render, and the
 * next-tool suggestions the builder derives from the capability profile.
 *
 * @module tests/tools/shared/orientation-envelope.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildOrientationEnvelope,
  formatOrientationEnvelope,
  type OrientationEnvelope,
  OrientationEnvelopeSchema,
} from '@/mcp-server/tools/shared/orientation-envelope.js';
import type { BrapiClient } from '@/services/brapi-client/index.js';
import {
  initBrapiDialectRegistry,
  resetBrapiDialectRegistry,
} from '@/services/brapi-dialect/index.js';
import type { CapabilityRegistry } from '@/services/capability-registry/index.js';
import type {
  CallDescriptor,
  CapabilityProfile,
  ServerIdentity,
} from '@/services/capability-registry/types.js';
import type { RegisteredServer } from '@/services/server-registry/index.js';

function makeEnvelope(overrides: Partial<OrientationEnvelope> = {}): OrientationEnvelope {
  return {
    alias: 'demo',
    baseUrl: 'https://demo.example.org/brapi/v2',
    server: { name: 'Demo BrAPI Server' },
    auth: { mode: 'none' },
    capabilities: {
      supportedCount: 3,
      supported: ['studies', 'germplasm', 'observations'],
      notableGaps: [],
    },
    dialect: {
      id: 'spec',
      source: 'fallback',
      envVar: 'BRAPI_DEMO_DIALECT',
      disabledSearchEndpoints: [],
      notes: [],
    },
    content: { crops: [] },
    nextToolSuggestions: [],
    notes: [],
    fetchedAt: '2026-05-22T00:00:00.000Z',
    ...overrides,
  };
}

describe('formatOrientationEnvelope', () => {
  it('opens with "Connected" when the server advertises at least one service', () => {
    const text = formatOrientationEnvelope(makeEnvelope());
    expect(text.split('\n', 1)[0]).toBe('# Connected: Demo BrAPI Server');
  });

  it('opens with "Registered" when the server advertised zero services', () => {
    const text = formatOrientationEnvelope(
      makeEnvelope({
        server: { name: 'Unreachable Server' },
        capabilities: { supportedCount: 0, supported: [], notableGaps: ['studies', 'germplasm'] },
      }),
    );
    expect(text.split('\n', 1)[0]).toBe('# Registered: Unreachable Server');
  });

  it('falls back to the alias for the headline when serverInfo.name is absent', () => {
    const text = formatOrientationEnvelope(
      makeEnvelope({
        server: {},
        alias: 'missing-srv',
        capabilities: { supportedCount: 0, supported: [], notableGaps: [] },
      }),
    );
    expect(text.split('\n', 1)[0]).toBe('# Registered: missing-srv');
  });

  it('renders the verified/inferred mapping count when the dialect carries one', () => {
    const text = formatOrientationEnvelope(
      makeEnvelope({
        dialect: {
          id: 'cassavabase',
          source: 'server-name',
          envVar: 'BRAPI_DEMO_DIALECT',
          disabledSearchEndpoints: [],
          notes: [],
          verifiedMappingCount: 5,
          inferredMappingCount: 42,
        },
      }),
    );
    expect(text).toContain('- **Filter mappings:** 5 verified, 42 inferred');
  });

  it('omits the mapping-count bullet when the dialect carries no summary (spec)', () => {
    const text = formatOrientationEnvelope(makeEnvelope());
    expect(text).not.toContain('Filter mappings:');
  });

  it('renders every section of a fully populated envelope in a stable order', () => {
    const text = formatOrientationEnvelope(
      makeEnvelope({
        alias: 'bti-cassava',
        baseUrl: 'https://cassavabase.org/brapi/v2',
        server: {
          name: 'CassavaBase',
          brapiVersion: '2.1',
          organizationName: 'BTI',
          description: 'Cassava breeding data',
          documentationURL: 'https://docs.example',
          contactEmail: 'ops@example.org',
          organizationURL: 'https://bti.example',
        },
        auth: { mode: 'bearer', headerName: 'Authorization', expiresAt: '2026-06-01T00:00:00Z' },
        capabilities: {
          supportedCount: 2,
          supported: ['search/studies', 'studies'],
          notableGaps: ['germplasm'],
        },
        dialect: {
          id: 'cassavabase',
          source: 'url-pattern',
          envVar: 'BRAPI_BTI_CASSAVA_DIALECT',
          disabledSearchEndpoints: ['studies'],
          notes: ['Dialect note.'],
          verifiedMappingCount: 1,
          inferredMappingCount: 2,
        },
        content: {
          crops: ['Cassava'],
          studyCount: 4,
          germplasmCount: 5,
          programCount: 6,
          locationCount: 7,
        },
        attribution: {
          homepage: 'https://cassavabase.org/',
          license: 'CC-BY',
          citation: 'Cite me.',
        },
        nextToolSuggestions: [
          {
            toolName: 'brapi_find_studies',
            reason: 'The server exposes studies; start here to find study DbIds.',
            args: { alias: 'bti-cassava' },
          },
        ],
        notes: ['A note.'],
      }),
    );
    expect(text).toBe(
      [
        '# Connected: CassavaBase',
        '',
        '- **Alias:** bti-cassava',
        '- **Base URL:** https://cassavabase.org/brapi/v2',
        '- **BrAPI version:** 2.1',
        '- **Organization:** BTI',
        '- **Description:** Cassava breeding data',
        '- **Docs:** https://docs.example',
        '- **Contact:** ops@example.org',
        '- **Organization URL:** https://bti.example',
        '',
        '**Auth:** bearer (header: Authorization) · expires 2026-06-01T00:00:00Z',
        '',
        '## Capabilities',
        '- 2 service(s) advertised',
        '- Supported: search/studies, studies',
        '- Notable gaps (missing from the common floor): germplasm',
        '',
        '## Dialect',
        '- **Active:** `cassavabase` (detected from url-pattern)',
        '- **Pin override:** `BRAPI_BTI_CASSAVA_DIALECT`',
        '- **Filter mappings:** 1 verified, 2 inferred — inferred mappings may not narrow as expected; check distributions before trusting result counts.',
        '- **POST /search routes routed around:** studies',
        '- Dialect note.',
        '',
        '## Content',
        '- **Crops (1):** Cassava',
        '- Studies: 4',
        '- Germplasm: 5',
        '- Programs: 6',
        '- Locations: 7',
        '',
        '## Attribution',
        '- **License:** CC-BY',
        '- **Homepage:** https://cassavabase.org/',
        '- **Citation:** Cite me.',
        '',
        '## Suggested next tools',
        '- `brapi_find_studies` `{"alias":"bti-cassava"}` — The server exposes studies; start here to find study DbIds.',
        '',
        '## Notes',
        '- A note.',
        '',
        '_Fetched at 2026-05-22T00:00:00.000Z._',
      ].join('\n'),
    );
  });

  it('says so when no entry-point finder is supported', () => {
    const text = formatOrientationEnvelope(makeEnvelope({ nextToolSuggestions: [] }));
    expect(text).toContain(
      '## Suggested next tools\n- None — this server exposes none of studies, germplasm, variables, or locations, so no entry-point finder applies.',
    );
  });
});

describe('buildOrientationEnvelope', () => {
  beforeEach(() => {
    initBrapiDialectRegistry();
  });

  afterEach(() => {
    resetBrapiDialectRegistry();
  });

  async function build(
    calls: CallDescriptor[],
    {
      alias = 'demo',
      server = {} as ServerIdentity,
      baseUrl = 'https://demo.example.org/brapi/v2',
    } = {},
  ): Promise<OrientationEnvelope> {
    const profile: CapabilityProfile = {
      baseUrl,
      server,
      supported: Object.fromEntries(calls.map((c) => [c.service, c])),
      crops: [],
      fetchedAt: '2026-06-01T00:00:00.000Z',
    };
    const registry = { profile: async () => profile } as unknown as CapabilityRegistry;
    // Count probes are best-effort; a rejecting client leaves every count unset.
    const client = {
      get: async () => {
        throw new Error('count probes not under test');
      },
    } as unknown as BrapiClient;
    const connection: RegisteredServer = {
      alias,
      baseUrl: profile.baseUrl,
      authMode: 'none',
      registeredAt: '2026-06-01T00:00:00.000Z',
    };
    const envelope = await buildOrientationEnvelope(createMockContext(), connection, {
      registry,
      client,
    });
    expect(envelope).toEqual(expect.schemaMatching(OrientationEnvelopeSchema));
    return envelope;
  }

  describe('built-in attribution', () => {
    const STUDIES = [{ service: 'studies', methods: ['GET'] }];

    it('attaches attribution when a built-in alias points at its built-in URL', async () => {
      const envelope = await build(STUDIES, {
        alias: 'bti-cassava',
        baseUrl: 'https://cassavabase.org/brapi/v2',
      });
      expect(envelope.attribution).toMatchObject({
        homepage: 'https://cassavabase.org/',
        license: 'CC-BY',
      });
    });

    it('matches the built-in URL after normalization (host case, trailing slash)', async () => {
      const envelope = await build(STUDIES, {
        alias: 'BTI-Cassava',
        baseUrl: 'https://CassavaBase.org/brapi/v2/',
      });
      expect(envelope.attribution?.homepage).toBe('https://cassavabase.org/');
    });

    it('omits attribution when a built-in alias was pointed at another server', async () => {
      const envelope = await build(STUDIES, {
        alias: 'bti-cassava',
        baseUrl: 'https://mirror.example.org/brapi/v2',
      });
      expect(envelope.attribution).toBeUndefined();
      expect(formatOrientationEnvelope(envelope)).not.toContain('## Attribution');
    });

    it('keeps the demo note and flag for the demo alias on its own URL only', async () => {
      const own = await build(STUDIES, {
        alias: 'bti-breedbase-demo',
        baseUrl: 'https://breedbase.org/brapi/v2',
      });
      expect(own.attribution?.isDemo).toBe(true);
      expect(own.notes.some((n) => n.includes('demo Breedbase instance'))).toBe(true);

      const elsewhere = await build(STUDIES, {
        alias: 'bti-breedbase-demo',
        baseUrl: 'https://production.example.org/brapi/v2',
      });
      expect(elsewhere.attribution).toBeUndefined();
      expect(elsewhere.notes.some((n) => n.includes('demo Breedbase instance'))).toBe(false);
    });
  });

  it('suggests all four entry-point finders in a fixed order, keyed by alias only', async () => {
    const envelope = await build(
      [
        { service: 'locations', methods: ['GET'] },
        { service: 'variables', methods: ['GET'] },
        { service: 'germplasm', methods: ['GET'] },
        { service: 'studies', methods: ['GET'] },
      ],
      { alias: 'bti-cassava' },
    );
    expect(envelope.nextToolSuggestions).toEqual([
      {
        toolName: 'brapi_find_studies',
        reason: 'The server exposes studies; start here to find study DbIds.',
        args: { alias: 'bti-cassava' },
      },
      {
        toolName: 'brapi_find_germplasm',
        reason: 'The server exposes germplasm; start here to find germplasm DbIds.',
        args: { alias: 'bti-cassava' },
      },
      {
        toolName: 'brapi_find_variables',
        reason:
          'The server exposes observation variables; start here to find observationVariable DbIds for traits.',
        args: { alias: 'bti-cassava' },
      },
      {
        toolName: 'brapi_find_locations',
        reason: 'The server exposes locations; start here to find location DbIds.',
        args: { alias: 'bti-cassava' },
      },
    ]);
  });

  it('counts a search-only route with no declared methods', async () => {
    const envelope = await build([{ service: 'search/studies' }]);
    expect(envelope.nextToolSuggestions.map((s) => s.toolName)).toEqual(['brapi_find_studies']);
  });

  it('counts descriptors whose methods array is empty as supporting every method', async () => {
    const envelope = await build([
      { service: 'germplasm', methods: [] },
      { service: 'search/locations', methods: [] },
    ]);
    expect(envelope.nextToolSuggestions.map((s) => s.toolName)).toEqual([
      'brapi_find_germplasm',
      'brapi_find_locations',
    ]);
  });

  it('leaves out a finder whose only route the active dialect disables', async () => {
    // CassavaBase routes around POST /search/germplasm and /search/studies.
    const envelope = await build(
      [
        { service: 'search/germplasm', methods: ['POST'] },
        { service: 'search/studies', methods: ['POST'] },
        { service: 'variables', methods: ['GET'] },
      ],
      { server: { name: 'CassavaBase' } },
    );
    expect(envelope.dialect.id).toBe('cassavabase');
    expect(envelope.nextToolSuggestions.map((s) => s.toolName)).toEqual(['brapi_find_variables']);
  });

  it('ignores services advertised for the wrong method and anchored finders', async () => {
    const envelope = await build([
      { service: 'studies', methods: ['POST'] },
      { service: 'search/germplasm', methods: ['GET'] },
      { service: 'observations', methods: ['GET'] },
      { service: 'images', methods: ['GET'] },
    ]);
    expect(envelope.nextToolSuggestions).toEqual([]);
  });

  it('returns an empty list for a server advertising nothing', async () => {
    const envelope = await build([]);
    expect(envelope.nextToolSuggestions).toEqual([]);
    expect(formatOrientationEnvelope(envelope)).toContain('- None — this server exposes none');
  });
});
