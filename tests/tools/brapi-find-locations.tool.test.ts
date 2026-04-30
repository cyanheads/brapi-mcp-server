/**
 * @fileoverview End-to-end tests for `brapi_find_locations` — capability
 * gate, country/type distributions, client-side bbox filter, malformed bbox
 * warnings, dataset spillover.
 *
 * @module tests/tools/brapi-find-locations.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiFindLocations } from '@/mcp-server/tools/definitions/brapi-find-locations.tool.js';
import {
  BASE_URL,
  envelope,
  initTestServices,
  jsonResponse,
  type MockFetcher,
  pathnameOf,
  resetTestServices,
} from './_tool-test-helpers.js';

function locRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    locationDbId: 'loc-1',
    locationName: 'NCSU Station 1',
    countryCode: 'USA',
    locationType: 'Research Station',
    latitude: 35.78,
    longitude: -78.68,
    ...extra,
  };
}

async function connect(fetcher: MockFetcher, calls = ['locations']) {
  fetcher.mockImplementation(async (url: string) => {
    const path = pathnameOf(url);
    if (path.endsWith('/serverinfo')) {
      return jsonResponse(
        envelope({
          serverName: 'Test',
          calls: calls.map((service) => ({ service, methods: ['GET'], versions: ['2.1'] })),
        }),
      );
    }
    if (path.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: [] }));
    return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
  });
  const ctx = createMockContext({ tenantId: 't1' });
  await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
  fetcher.mockReset();
  return ctx;
}

describe('brapi_find_locations tool', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('returns rows + per-country and per-type distributions', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      locRow(),
      locRow({ locationDbId: 'loc-2', countryCode: 'USA', locationType: 'Field' }),
      locRow({ locationDbId: 'loc-3', countryCode: 'NGA', latitude: 7.4, longitude: 3.9 }),
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiFindLocations.handler(brapiFindLocations.input.parse({}), ctx);

    expect(result.returnedCount).toBe(3);
    expect(result.distributions.countryCode).toEqual({ USA: 2, NGA: 1 });
    expect(result.distributions.locationType).toEqual({
      'Research Station': 2,
      Field: 1,
    });
  });

  it('applies a client-side bbox filter and reflects post-filter counts', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      locRow({ latitude: 35, longitude: -78 }), // inside
      locRow({ locationDbId: 'loc-2', latitude: 7, longitude: 3 }), // outside
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiFindLocations.handler(
      brapiFindLocations.input.parse({
        bbox: { minLat: 30, maxLat: 40, minLon: -90, maxLon: -70 },
      }),
      ctx,
    );

    expect(result.returnedCount).toBe(1);
    expect(result.totalCount).toBe(1);
    expect(result.results[0]?.locationDbId).toBe('loc-1');
  });

  it('warns and ignores partial bbox specifications', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [locRow()] }, { totalCount: 1 })));

    const result = await brapiFindLocations.handler(
      brapiFindLocations.input.parse({
        bbox: { minLat: 30, maxLat: 40 }, // missing lon corners
      }),
      ctx,
    );

    expect(result.warnings.join('\n')).toContain('all four corners');
    expect(result.returnedCount).toBe(1); // bbox ignored, original row kept
  });

  it('throws ValidationError when /locations is not advertised', async () => {
    const ctx = await connect(fetcher, ['studies']);
    await expect(
      brapiFindLocations.handler(brapiFindLocations.input.parse({}), ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
  });

  it('format() includes the location name, country, and coordinates', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [locRow()] }, { totalCount: 1 })));
    const result = await brapiFindLocations.handler(brapiFindLocations.input.parse({}), ctx);
    const text = (brapiFindLocations.format!(result)[0] as { text: string }).text;
    expect(text).toContain('NCSU Station 1');
    expect(text).toContain('USA');
    expect(text).toContain('lat=35.78');
  });

  it('tolerates null values on optional fields and skips coords in format() (Cassavabase shape)', async () => {
    const ctx = await connect(fetcher);
    const sparseRow = {
      locationDbId: 'loc-cb-1',
      locationName: 'Ibadan',
      countryCode: 'NGA',
      countryName: 'Nigeria',
      // Cassavabase nulls these in the wild:
      documentationURL: null,
      abbreviation: null,
      locationType: null,
      latitude: null,
      longitude: null,
      altitude: null,
    };
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [sparseRow] }, { totalCount: 1 })));
    const result = await brapiFindLocations.handler(brapiFindLocations.input.parse({}), ctx);
    expect(result.returnedCount).toBe(1);
    expect(result.results[0]?.documentationURL).toBeNull();
    // null lat/lon must not render — would print `lat=null` and confuse the LLM.
    const text = (brapiFindLocations.format!(result)[0] as { text: string }).text;
    expect(text).not.toContain('lat=');
    expect(text).not.toContain('lon=');
    expect(text).not.toContain('alt=');
  });

  it('extracts coordinates from BrAPI v2 GeoJSON Feature shape (CassavaBase real shape)', async () => {
    const ctx = await connect(fetcher);
    // CassavaBase's real `/locations/3` response — only GeoJSON, no legacy lat/lon.
    const geoJsonRow = {
      locationDbId: '3',
      locationName: 'Ibadan',
      countryCode: 'NGA',
      coordinates: {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [3.947, 7.378, 234] },
      },
    };
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [geoJsonRow] }, { totalCount: 1 })));

    const result = await brapiFindLocations.handler(
      brapiFindLocations.input.parse({
        bbox: { minLat: -90, maxLat: 90, minLon: -180, maxLon: 180 },
      }),
      ctx,
    );
    expect(result.returnedCount).toBe(1);
    const text = (brapiFindLocations.format!(result)[0] as { text: string }).text;
    expect(text).toContain('lat=7.378');
    expect(text).toContain('lon=3.947');
    expect(text).toContain('alt=234');
  });

  it('bbox honors GeoJSON coordinates and excludes outside-window points', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      {
        locationDbId: 'in',
        locationName: 'Ibadan',
        coordinates: { type: 'Feature', geometry: { type: 'Point', coordinates: [3.947, 7.378] } },
      },
      {
        locationDbId: 'out',
        locationName: 'Reykjavik',
        coordinates: {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-21.9, 64.1] },
        },
      },
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));
    const result = await brapiFindLocations.handler(
      brapiFindLocations.input.parse({
        bbox: { minLat: 0, maxLat: 30, minLon: -10, maxLon: 30 },
      }),
      ctx,
    );
    expect(result.returnedCount).toBe(1);
    expect(result.results[0]?.locationDbId).toBe('in');
  });
});
