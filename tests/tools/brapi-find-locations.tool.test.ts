/**
 * @fileoverview End-to-end tests for `brapi_find_locations` — capability
 * gate, country/type distributions, client-side bbox filter, malformed bbox
 * warnings, dataframe spillover.
 *
 * @module tests/tools/brapi-find-locations.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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

async function connect(fetcher: MockFetcher, calls = ['locations'], serverName = 'Test') {
  fetcher.mockImplementation(async (url: string) => {
    const path = pathnameOf(url);
    if (path.endsWith('/serverinfo')) {
      return jsonResponse(
        envelope({
          serverName,
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

/**
 * Serve `rows` as a paged /locations list, answering 500 for pages at or past
 * `failFromPage`; any other URL fails the call.
 */
function serveLocations(
  fetcher: MockFetcher,
  rows: Record<string, unknown>[],
  failFromPage?: number,
): void {
  fetcher.mockImplementation(async (url: string) => {
    const u = new URL(String(url));
    if (u.hostname !== 'brapi.example.org' || u.pathname !== '/brapi/v2/locations') {
      throw new Error(`unmocked fetch: ${u.href}`);
    }
    const page = Number.parseInt(u.searchParams.get('page') ?? '0', 10);
    if (failFromPage !== undefined && page >= failFromPage) {
      return jsonResponse({ error: 'upstream down' }, 500);
    }
    const pageSize = Number.parseInt(u.searchParams.get('pageSize') ?? '10', 10);
    return jsonResponse(
      envelope(
        { data: rows.slice(page * pageSize, page * pageSize + pageSize) },
        { totalCount: rows.length },
      ),
    );
  });
}

/** Run the tool through `runToolContract` against the connection registered on `ctx`. */
async function callContract(ctx: Context, input: Record<string, unknown>) {
  const definition = {
    ...brapiFindLocations,
    handler: (parsed, contractCtx) =>
      brapiFindLocations.handler(parsed, { ...contractCtx, state: ctx.state }),
  } satisfies typeof brapiFindLocations;
  const result = await runToolContract(definition, input, { context: { tenantId: 't1' } });
  const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  return { result, structured: result.structuredContent as Record<string, unknown>, text };
}

const formatText = (result: Parameters<NonNullable<typeof brapiFindLocations.format>>[0]) =>
  (brapiFindLocations.format!(result)[0] as { text: string }).text;

describe('brapi_find_locations tool', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  it('returns rows + per-country and per-type distributions, with name, country, and coordinates in format()', async () => {
    const ctx = await connect(fetcher);
    const rows = [
      locRow(),
      locRow({ locationDbId: 'loc-2', countryCode: 'USA', locationType: 'Field' }),
      locRow({ locationDbId: 'loc-3', countryCode: 'NGA', latitude: 7.4, longitude: 3.9 }),
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiFindLocations.handler(brapiFindLocations.input.parse({}), ctx);

    expect(getEnrichment(ctx).returnedCount).toBe(3);
    expect(result.distributions.countryCode).toEqual({ USA: 2, NGA: 1 });
    expect(result.distributions.locationType).toEqual({
      'Research Station': 2,
      Field: 1,
    });
    const text = formatText(result);
    expect(text).toContain('NCSU Station 1');
    expect(text).toContain('USA');
    expect(text).toContain('lat=35.78');
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

    expect(getEnrichment(ctx).returnedCount).toBe(1);
    expect(getEnrichment(ctx).totalCount).toBe(1);
    expect(result.results[0]?.locationDbId).toBe('loc-1');
  });

  it.each([
    { minLat: 30, maxLat: 40 },
    { minLat: 40, maxLat: 30, minLon: 0, maxLon: 10 },
    { minLat: 0, maxLat: 10, minLon: 20, maxLon: 10 },
  ])('rejects malformed bbox before location retrieval: %j', async (bbox) => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [locRow()] }, { totalCount: 1 })));
    const { result, structured, text } = await callContract(ctx, { bbox });
    expect(result.isError).toBe(true);
    expect(structured).toMatchObject({
      error: { data: { reason: 'invalid_bbox', recovery: { hint: expect.any(String) } } },
    });
    expect(text).toContain('bbox');
    expect(text).toContain('Recovery:');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects unresolved names unless an effective country restriction remains', async () => {
    const ctx = await connect(fetcher);
    const { result, structured, text } = await callContract(ctx, { countryNames: ['Ugandaa'] });
    expect(result.isError).toBe(true);
    expect(structured).toMatchObject({ error: { data: { reason: 'unresolved_country_names' } } });
    expect(text).toContain('Ugandaa');
    expect(text).toContain('countryCodes');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([508, [508]])(
    'preserves a numeric extraFilters country restriction: %j',
    async (countryCodes) => {
      const ctx = await connect(fetcher);
      fetcher.mockImplementation(async (url: string) => {
        const filtered = new URL(String(url)).searchParams.getAll('countryCodes').includes('508');
        const rows = filtered ? [locRow({ countryCode: '508' })] : [locRow()];
        return jsonResponse(envelope({ data: rows }, { totalCount: rows.length }));
      });
      const { result, structured } = await callContract(ctx, {
        countryNames: ['Atlantis'],
        extraFilters: { countryCodes },
      });
      expect(result.isError).not.toBe(true);
      expect(structured).toMatchObject({ results: [{ countryCode: '508' }] });
    },
  );

  it.each([{}, { minLat: 35.78, maxLat: 35.78, minLon: -78.68, maxLon: -78.68 }])(
    'preserves empty and equal-bound boxes: %j',
    async (bbox) => {
      const ctx = await connect(fetcher);
      fetcher.mockResolvedValue(jsonResponse(envelope({ data: [locRow()] }, { totalCount: 1 })));
      const { result, structured } = await callContract(ctx, { bbox });
      expect(result.isError).not.toBe(true);
      expect(structured).toMatchObject({ results: [{ locationDbId: 'loc-1' }] });
    },
  );

  it('throws ValidationError when /locations is not advertised', async () => {
    const ctx = await connect(fetcher, ['studies']);
    await expect(
      brapiFindLocations.handler(brapiFindLocations.input.parse({}), ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
  });

  it.each([
    [
      'CassavaBase',
      {
        locations: ['3', '4'],
        locationNames: ['Namulonge'],
        countryNames: ['Uganda'],
        locationTypes: ['Farm'],
        abbreviations: ['NM', 'UB'],
      },
      {
        locationDbIds: ['3', '4'],
        locationNames: ['Namulonge'],
        countryCodes: ['UGA'],
        locationTypes: ['Farm'],
        abbreviations: ['NM', 'UB'],
      },
      [
        locRow({ locationDbId: '3', countryCode: 'UGA', locationType: 'Farm' }),
        locRow({ locationDbId: '4', countryCode: 'UGA', locationType: 'Farm' }),
      ],
    ],
    [
      'Sweetpotatobase',
      { locations: ['29'], locationNames: ['Ica'], countryCodes: ['PER'], abbreviations: ['BIO'] },
      {
        locationDbIds: ['29'],
        locationNames: ['Ica'],
        countryCodes: ['PER'],
        abbreviations: ['BIO'],
      },
      [],
    ],
  ])(
    'keeps Breedbase location filters plural, multi-value intact, on a %s server',
    async (serverName, input, expectedParams, rows) => {
      const ctx = await connect(fetcher, ['locations'], serverName);
      fetcher.mockResolvedValue(
        jsonResponse(envelope({ data: rows }, { totalCount: rows.length })),
      );

      await brapiFindLocations.handler(brapiFindLocations.input.parse(input), ctx);

      const url = new URL(String(fetcher.mock.calls[0]![0]));
      expect(url.pathname).toBe('/brapi/v2/locations');
      for (const [param, values] of Object.entries(expectedParams)) {
        expect(url.searchParams.getAll(param)).toEqual(values);
        // The singular spelling (locationDbIds → locationDbId) is never sent.
        expect(url.searchParams.has(param.slice(0, -1))).toBe(false);
      }
      const warnings = getEnrichment(ctx).warnings.join('\n');
      expect(warnings).not.toContain('downcast');
      expect(warnings).not.toContain('may not honor this filter');
      expect(getEnrichment(ctx).returnedCount).toBe(rows.length);
    },
  );

  it('warns when a requested country appears but unrelated countries are also returned', async () => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(
      jsonResponse(
        envelope(
          {
            data: [
              locRow({ locationDbId: 'per-1', countryCode: 'PER' }),
              locRow({ locationDbId: 'usa-1', countryCode: 'USA' }),
            ],
          },
          { totalCount: 2 },
        ),
      ),
    );

    await brapiFindLocations.handler(
      brapiFindLocations.input.parse({ countryCodes: ['PER'] }),
      ctx,
    );

    expect(getEnrichment(ctx).warnings.join('\n')).toContain('carried other values');
    expect(getEnrichment(ctx).warnings.join('\n')).toContain('USA');
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
    expect(getEnrichment(ctx).returnedCount).toBe(1);
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
    expect(getEnrichment(ctx).returnedCount).toBe(1);
    const text = (brapiFindLocations.format!(result)[0] as { text: string }).text;
    expect(text).toContain('lat=7.378');
    expect(text).toContain('lon=3.947');
    expect(text).toContain('alt=234');
  });

  it('retries bbox with axes swapped when spec ordering returns zero against a non-conformant server (BrAPI test-server shape)', async () => {
    const ctx = await connect(fetcher);
    // Mirrors the BrAPI Community Test Server: Cornell at (42.44, -76.46) is
    // stored as [42.44423, -76.46313, 123]. Read GeoJSON-spec ([lon, lat]),
    // it'd be (lat=-76.46, lon=42.44) — outside any sane upstate-NY bbox.
    // The swap-on-zero retry should recover the row.
    const rows = [
      {
        locationDbId: 'location_01',
        locationName: 'Location 1',
        coordinates: {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [42.44423, -76.46313, 123] },
        },
      },
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiFindLocations.handler(
      brapiFindLocations.input.parse({
        bbox: { minLat: 42, maxLat: 43, minLon: -77, maxLon: -76 },
      }),
      ctx,
    );

    expect(result.coordinateAxisOrder).toBe('swapped');
    expect(getEnrichment(ctx).returnedCount).toBe(1);
    expect(result.results[0]?.locationDbId).toBe('location_01');
    expect(getEnrichment(ctx).warnings.join('\n')).toContain('[lat, lon, alt]');
    // Renderer must use the same swapped reading as the bbox filter, otherwise
    // the LLM sees coords that contradict the warning.
    const text = (brapiFindLocations.format!(result)[0] as { text: string }).text;
    expect(text).toContain('lat=42.44423');
    expect(text).toContain('lon=-76.46313');
  });

  /** One location at a single GeoJSON geometry. */
  const geoRow = (locationDbId: string, geometry: Record<string, unknown>) => ({
    locationDbId,
    locationName: locationDbId,
    coordinates: { type: 'Feature', geometry },
  });

  it.each([
    [
      'the spec reading matches',
      geoRow('in', { type: 'Point', coordinates: [3.947, 7.378] }),
      { minLat: 0, maxLat: 30, minLon: -10, maxLon: 30 },
      1,
    ],
    [
      // A Reykjavik point against a central-Africa box: neither reading matches.
      'both spec and swapped readings exclude every row',
      geoRow('rey', { type: 'Point', coordinates: [-21.9, 64.1] }),
      { minLat: 0, maxLat: 10, minLon: 0, maxLon: 10 },
      0,
    ],
    [
      'no row carries a Point geometry (Polygon-only)',
      geoRow('poly', {
        type: 'Polygon',
        coordinates: [
          [
            [42.44556, -76.45888, 123],
            [42.4415, -76.45888, 123],
            [42.4415, -76.4632, 123],
            [42.44556, -76.4632, 123],
            [42.44556, -76.45888, 123],
          ],
        ],
      }),
      { minLat: 42, maxLat: 43, minLon: -77, maxLon: -76 },
      0,
    ],
  ])(
    'keeps coordinateAxisOrder="spec" and never swaps when %s',
    async (_label, row, bbox, returned) => {
      const ctx = await connect(fetcher);
      fetcher.mockResolvedValue(jsonResponse(envelope({ data: [row] }, { totalCount: 1 })));

      const result = await brapiFindLocations.handler(
        brapiFindLocations.input.parse({ bbox }),
        ctx,
      );

      expect(result.coordinateAxisOrder).toBe('spec');
      expect(getEnrichment(ctx).returnedCount).toBe(returned);
      const warnings = getEnrichment(ctx).warnings.join('\n');
      expect(warnings).not.toContain('[lat, lon, alt]');
      // Only a bbox that excludes every row carries the verify-coordinate-convention warning.
      expect(warnings.includes('Verify the latitude/longitude window')).toBe(returned === 0);
    },
  );

  it('returns an empty result, not a canvas error, when bbox excludes every row of a spilled set', async () => {
    const ctx = await connect(fetcher);
    serveLocations(fetcher, [
      locRow({ locationDbId: 'a', latitude: 35, longitude: -78 }),
      locRow({ locationDbId: 'b', latitude: 7, longitude: 3 }),
      locRow({ locationDbId: 'c', latitude: 50, longitude: 10 }),
      locRow({ locationDbId: 'd', latitude: -10, longitude: -10 }),
    ]);

    // Open ocean: no row falls inside under either axis reading.
    const { result, structured, text } = await callContract(ctx, {
      loadLimit: 2,
      bbox: { minLat: -1, maxLat: 0, minLon: -150, maxLon: -149 },
    });

    expect(result.isError).toBeFalsy();
    // First page + the spill walk, which re-reads from page 0 at pageSize 10.
    expect(fetcher.mock.calls.length).toBe(2);
    expect(structured).toMatchObject({
      results: [],
      totalCount: 0,
      returnedCount: 0,
      hasMore: false,
      notice: expect.stringContaining('No rows returned'),
    });
    expect(structured).not.toHaveProperty('dataframe');
    expect(structured).not.toHaveProperty('refinementHint');
    expect(text).toContain('_No rows returned._');
    // The walk scanned all four rows, not just the two on the first page.
    expect((structured.warnings as string[]).filter((w) => w.startsWith('bbox excluded'))).toEqual([
      "bbox excluded all 4 upstream location(s). Verify the latitude/longitude window matches the server's coordinate convention.",
    ]);
    expect(text).not.toContain('returned on the first page');
    expect(text).not.toContain('More rows');
    expect(text).not.toContain('Table schema');
  });

  it('says how many locations a bbox scan left unchecked when the walk stops short', async () => {
    const ctx = await connect(fetcher);
    serveLocations(
      fetcher,
      Array.from({ length: 25 }, (_, i) =>
        locRow({ locationDbId: `l${i + 1}`, latitude: 35, longitude: -78 }),
      ),
      1,
    );

    const { structured } = await callContract(ctx, {
      loadLimit: 2,
      bbox: { minLat: -1, maxLat: 0, minLon: -150, maxLon: -149 },
    });

    expect(structured.hasMore).toBe(true);
    expect((structured.warnings as string[]).filter((w) => w.startsWith('bbox excluded'))).toEqual([
      "bbox excluded all 10 upstream location(s) scanned; the other 15 of 25 were not checked. Verify the latitude/longitude window matches the server's coordinate convention.",
    ]);
    // The spill walk's own stop warning reaches the tool's warnings too.
    expect((structured.warnings as string[]).join('\n')).toMatch(
      /stopped after 10 of 25 upstream row\(s\): page 1 failed/,
    );
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
    expect(getEnrichment(ctx).returnedCount).toBe(1);
    expect(result.results[0]?.locationDbId).toBe('in');
    expect(getEnrichment(ctx).warnings).toContain('bbox excluded 1 of 2 upstream location(s).');
  });

  it.each([
    // [label, input, countryCodes sent upstream, warning fragments]
    [
      'resolves a country name to its ISO alpha-3 code',
      { countryNames: ['Uganda'] },
      ['UGA'],
      ['"Uganda" → UGA'],
    ],
    [
      'resolves case-insensitively and via aliases',
      { countryNames: ['united states'] },
      ['USA'],
      [],
    ],
    [
      'unions explicit countryCodes with resolved names',
      { countryCodes: ['NGA'], countryNames: ['Uganda'] },
      ['NGA', 'UGA'],
      [],
    ],
    [
      'warns on an unresolvable name while retaining a resolved name',
      { countryNames: ['Atlantis', 'Uganda'] },
      ['UGA'],
      ['Could not resolve', 'Atlantis'],
    ],
    [
      'uppercases alphabetic codes and preserves numeric codes',
      { countryCodes: ['uga', '508'] },
      ['508', 'UGA'],
      [],
    ],
    [
      'retains explicit codes with unresolved names',
      { countryCodes: ['uga'], countryNames: ['Atlantis'] },
      ['UGA'],
      ['Atlantis'],
    ],
    [
      'uses effective extraFilters override with unresolved names',
      { countryNames: ['Atlantis'], extraFilters: { countryCodes: ['uga'] } },
      ['UGA'],
      ['Atlantis'],
    ],
  ])('%s', async (_label, input, codes, fragments) => {
    const ctx = await connect(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));

    await brapiFindLocations.handler(brapiFindLocations.input.parse(input), ctx);

    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.getAll('countryCodes').sort()).toEqual(codes);
    const warnings = getEnrichment(ctx).warnings.join('\n');
    for (const fragment of fragments) expect(warnings).toContain(fragment);
  });
});

describe('brapi_find_locations results[] over the filtered set (#66)', () => {
  // The walk pageSize is stubbed to 10; loadLimit defaults to BRAPI_LOAD_LIMIT's 1,000.
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
  });

  const serve = (rows: Record<string, unknown>[]) => serveLocations(fetcher, rows);
  const call = callContract;

  const ids = (s: Record<string, unknown>) =>
    (s.results as { locationDbId: string }[]).map((r) => r.locationDbId);
  const NC_BBOX = { minLat: 30, maxLat: 40, minLon: -90, maxLon: -70 };
  /** `n` locations; those whose 1-based index is in `inside` sit in NC_BBOX, the rest in Europe. */
  const sites = (n: number, inside: number[], extra: Record<string, unknown> = {}) =>
    Array.from({ length: n }, (_, idx) => {
      const i = idx + 1;
      return locRow({
        locationDbId: `loc-${i}`,
        ...(inside.includes(i)
          ? { latitude: 35, longitude: -78 }
          : { latitude: 50, longitude: 10 }),
        ...extra,
      });
    });

  it('returns the leading bbox matches past the first page, with hasMore over the filtered set', async () => {
    const ctx = await connect(fetcher);
    serve(sites(25, [3, 14, 25]));

    const { structured } = await call(ctx, { bbox: NC_BBOX, loadLimit: 5 });

    expect(ids(structured)).toEqual(['loc-3', 'loc-14', 'loc-25']);
    expect(structured).toMatchObject({ returnedCount: 3, totalCount: 3, hasMore: false });
    // Every match is inline, so nothing is staged.
    for (const key of ['truncated', 'shown', 'cap', 'dataframe']) {
      expect(structured).not.toHaveProperty(key);
    }
  });

  it('caps the bbox matches at loadLimit, discloses it, and stages only the post-bbox set (#28)', async () => {
    const ctx = await connect(fetcher);
    serve(sites(25, [2, 4, 6, 8, 12, 16, 20, 24]));

    const { structured } = await call(ctx, { bbox: NC_BBOX, loadLimit: 5 });

    expect(ids(structured)).toEqual(['loc-2', 'loc-4', 'loc-6', 'loc-8', 'loc-12']);
    // totalCount and the dataframe both count the 8 in-bbox rows, not the 25 upstream.
    expect(structured).toMatchObject({
      returnedCount: 5,
      totalCount: 8,
      hasMore: true,
      truncated: true,
      shown: 5,
      cap: 5,
      dataframe: { rowCount: 8 },
    });
  });

  it('trims results[] to the byte budget and stages every location', async () => {
    const ctx = await connect(fetcher);
    serve(sites(8, [], { instituteAddress: 'a'.repeat(4_900) }));

    const { structured, text } = await call(ctx, {});

    expect(Buffer.byteLength(JSON.stringify(structured.results), 'utf8')).toBeLessThanOrEqual(
      24_000,
    );
    expect(structured).toMatchObject({
      returnedCount: 4,
      totalCount: 8,
      hasMore: true,
      truncated: true,
      shown: 4,
      cap: 1_000,
      dataframe: { rowCount: 8 },
    });
    expect(text).toContain('24,000-byte inline budget');
  });
});
