/**
 * @fileoverview Tests for the orientation envelope formatter — headline
 * accuracy when the server advertises zero services (the "registered but
 * unreachable" case), and structural sanity for the full render.
 *
 * @module tests/tools/shared/orientation-envelope.test
 */

import { describe, expect, it } from 'vitest';
import {
  formatOrientationEnvelope,
  type OrientationEnvelope,
} from '@/mcp-server/tools/shared/orientation-envelope.js';

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
});
