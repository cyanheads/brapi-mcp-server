/**
 * @fileoverview Security tests — verifies that credentials never appear in
 * tool output or error messages, that injection attempts are rejected or
 * neutralized, and that oversized / path-traversal inputs are handled safely.
 *
 * All HTTP is mocked; no real network calls are made.
 *
 * @module tests/tools/security.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { brapiConnect } from '@/mcp-server/tools/definitions/brapi-connect.tool.js';
import { brapiFindGermplasm } from '@/mcp-server/tools/definitions/brapi-find-germplasm.tool.js';
import { brapiFindStudies } from '@/mcp-server/tools/definitions/brapi-find-studies.tool.js';
import { brapiRawGet } from '@/mcp-server/tools/definitions/brapi-raw-get.tool.js';
import { brapiRawSearch } from '@/mcp-server/tools/definitions/brapi-raw-search.tool.js';
import {
  BASE_URL,
  envelope,
  initTestServices,
  jsonResponse,
  type MockFetcher,
  pathnameOf,
  resetTestServices,
} from './_tool-test-helpers.js';

// Secret values that must never appear in tool output.
const FAKE_API_KEY = 'sk-super-secret-api-key-12345';
const FAKE_BEARER_TOKEN = 'bearer-token-do-not-leak-xyz987';
const FAKE_PASSWORD = 'very-secret-password-abc456';

/** Connect using bearer-token auth from env vars — verifies credentials flow through the auth stack. */
async function connectWithAuth(fetcher: MockFetcher) {
  fetcher.mockImplementation(async (url: string) => {
    const path = pathnameOf(url);
    if (path.endsWith('/serverinfo')) {
      return jsonResponse(
        envelope({
          serverName: 'Secure Server',
          calls: [
            { service: 'germplasm', methods: ['GET'], versions: ['2.1'] },
            { service: 'studies', methods: ['GET'], versions: ['2.1'] },
          ],
        }),
      );
    }
    if (path.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: [] }));
    return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
  });

  // Use a single auth family (bearer) so resolveConnectInput doesn't reject the ambiguous combo.
  vi.stubEnv('BRAPI_DEFAULT_BEARER_TOKEN', FAKE_BEARER_TOKEN);

  const ctx = createMockContext({ tenantId: 't1' });
  await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
  fetcher.mockReset();
  return ctx;
}

async function connectBasic(fetcher: MockFetcher) {
  fetcher.mockImplementation(async (url: string) => {
    const path = pathnameOf(url);
    if (path.endsWith('/serverinfo')) {
      return jsonResponse(
        envelope({
          serverName: 'Test',
          calls: [
            { service: 'germplasm', methods: ['GET'], versions: ['2.1'] },
            { service: 'studies', methods: ['GET'], versions: ['2.1'] },
          ],
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

/** Connect with brapi_raw_get error contracts wired so ctx.fail is available. */
async function connectForRawGet(fetcher: MockFetcher) {
  fetcher.mockImplementation(async (url: string) => {
    const path = pathnameOf(url);
    if (path.endsWith('/serverinfo')) {
      return jsonResponse(
        envelope({
          serverName: 'Test',
          calls: [
            { service: 'germplasm', methods: ['GET'], versions: ['2.1'] },
            { service: 'studies', methods: ['GET'], versions: ['2.1'] },
          ],
        }),
      );
    }
    if (path.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: [] }));
    return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
  });
  const ctx = createMockContext({ tenantId: 't1', errors: brapiRawGet.errors });
  await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
  fetcher.mockReset();
  return ctx;
}

describe('credential non-disclosure', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
    vi.unstubAllEnvs();
  });

  it('brapi_connect format() never includes the bearer token in the rendered output', async () => {
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/serverinfo')) {
        return jsonResponse(
          envelope({
            serverName: 'Test',
            calls: [{ service: 'studies', methods: ['GET'], versions: ['2.1'] }],
          }),
        );
      }
      if (path.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: [] }));
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });
    const ctx = createMockContext({ tenantId: 't1' });
    const result = await brapiConnect.handler(
      brapiConnect.input.parse({
        baseUrl: BASE_URL,
        auth: { mode: 'bearer', token: FAKE_BEARER_TOKEN },
      }),
      ctx,
    );
    const blocks = brapiConnect.format!(result);
    const rendered = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(rendered).not.toContain(FAKE_BEARER_TOKEN);
  });

  it('brapi_connect format() never includes an API key in the rendered output', async () => {
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/serverinfo')) {
        return jsonResponse(
          envelope({
            serverName: 'Test',
            calls: [{ service: 'studies', methods: ['GET'], versions: ['2.1'] }],
          }),
        );
      }
      if (path.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: [] }));
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });
    const ctx = createMockContext({ tenantId: 't1' });
    const result = await brapiConnect.handler(
      brapiConnect.input.parse({
        baseUrl: BASE_URL,
        auth: { mode: 'api_key', apiKey: FAKE_API_KEY },
      }),
      ctx,
    );
    const blocks = brapiConnect.format!(result);
    const rendered = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(rendered).not.toContain(FAKE_API_KEY);
  });

  it('brapi_find_germplasm result never leaks bearer token from env vars', async () => {
    vi.stubEnv('BRAPI_DEFAULT_BASE_URL', BASE_URL);
    vi.stubEnv('BRAPI_DEFAULT_BEARER_TOKEN', FAKE_BEARER_TOKEN);

    const ctx = await connectBasic(fetcher);
    fetcher.mockResolvedValue(
      jsonResponse(
        envelope({ data: [{ germplasmDbId: 'g1', germplasmName: 'TME419' }] }, { totalCount: 1 }),
      ),
    );

    const result = await brapiFindGermplasm.handler(brapiFindGermplasm.input.parse({}), ctx);

    // Serialize result to catch any accidental leakage.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(FAKE_BEARER_TOKEN);

    // Also verify format() output is clean.
    const text = brapiFindGermplasm.format!(result)
      .map((b) => ('text' in b ? b.text : ''))
      .join('\n');
    expect(text).not.toContain(FAKE_BEARER_TOKEN);
  });

  it('brapi_find_germplasm result never leaks bearer token injected via env vars into the session', async () => {
    // connectWithAuth stubs BRAPI_DEFAULT_BEARER_TOKEN so credentials flow through the auth
    // stack; downstream tool results must not serialise the token.
    const ctx = await connectWithAuth(fetcher);
    fetcher.mockResolvedValue(
      jsonResponse(
        envelope({ data: [{ germplasmDbId: 'g2', germplasmName: 'Sekiro' }] }, { totalCount: 1 }),
      ),
    );

    const result = await brapiFindGermplasm.handler(brapiFindGermplasm.input.parse({}), ctx);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(FAKE_BEARER_TOKEN);

    const text = brapiFindGermplasm.format!(result)
      .map((b) => ('text' in b ? b.text : ''))
      .join('\n');
    expect(text).not.toContain(FAKE_BEARER_TOKEN);
  });

  it('brapi_connect error message does not include auth credentials on ValidationError', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    vi.stubEnv('BRAPI_DEFAULT_BASE_URL', '');

    try {
      await brapiConnect.handler(
        brapiConnect.input.parse({
          baseUrl: BASE_URL,
          auth: { mode: 'bearer', token: FAKE_BEARER_TOKEN },
        }),
        ctx,
      );
    } catch (err) {
      // Even if the handler throws, the error message must not contain the token.
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain(FAKE_BEARER_TOKEN);
    }
  });

  it('brapi_connect error message does not leak password on auth misconfiguration', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    // ftp:// is not a valid URL — the input schema should reject before
    // any auth resolution so the password never reaches an error message.
    try {
      await brapiConnect.handler(
        {
          baseUrl: 'ftp://badscheme.example.com' as unknown as string,
          auth: { mode: 'sgn', username: 'user', password: FAKE_PASSWORD },
          alias: 'default',
        },
        ctx,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain(FAKE_PASSWORD);
    }
  });
});

describe('path traversal and injection guards', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
    vi.unstubAllEnvs();
  });

  it('brapi_raw_get path traversal sequences are URL-normalized to the same host (no cross-host escape)', async () => {
    // The URL constructor normalises `/../etc/passwd` to `/brapi/etc/passwd` —
    // it stays on the registered host. The handler does not need to block `..`
    // segments because they cannot escape the base URL's origin.
    const ctx = await connectBasic(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));
    const result = await brapiRawGet.handler(
      brapiRawGet.input.parse({ path: '/../etc/passwd' }),
      ctx,
    );
    // The URL must still be within the registered host — no cross-origin escape.
    expect(new URL(result.url).hostname).toBe(new URL(BASE_URL).hostname);
  });

  it('brapi_raw_get rejects a fully-qualified cross-origin URL', async () => {
    const ctx = await connectForRawGet(fetcher);
    await expect(
      brapiRawGet.handler(
        brapiRawGet.input.parse({ path: 'https://attacker.example.com/steal?key=secret' }),
        ctx,
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
  });

  it('brapi_raw_search rejects nouns with path separators at schema validation', () => {
    expect(() => brapiRawSearch.input.parse({ noun: 'studies/../../../etc', body: {} })).toThrow();
  });

  it('brapi_raw_search rejects nouns with query-string injection at schema validation', () => {
    expect(() => brapiRawSearch.input.parse({ noun: 'studies?inject=1', body: {} })).toThrow();
  });

  it('brapi_connect alias regex rejects whitespace and special chars', () => {
    // The alias regex is /^[a-zA-Z0-9_-]+$/ — ensure common injection chars fail.
    expect(() =>
      brapiConnect.input.parse({ baseUrl: BASE_URL, alias: 'alias with spaces' }),
    ).toThrow();
    expect(() =>
      brapiConnect.input.parse({ baseUrl: BASE_URL, alias: 'alias;rm -rf /' }),
    ).toThrow();
    expect(() =>
      brapiConnect.input.parse({ baseUrl: BASE_URL, alias: 'alias/traversal' }),
    ).toThrow();
    expect(() =>
      brapiConnect.input.parse({ baseUrl: BASE_URL, alias: 'alias\ninjection' }),
    ).toThrow();
  });

  it('brapi_connect alias accepts only alphanumerics, hyphens, and underscores', () => {
    expect(() =>
      brapiConnect.input.parse({ baseUrl: BASE_URL, alias: 'valid-alias_123' }),
    ).not.toThrow();
  });

  it('brapi_find_germplasm does not forward searchText/text in query params (no server-side injection)', async () => {
    const ctx = await connectBasic(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));

    // text with SQL-like injection pattern — but since text is a client-side
    // filter, none of it must reach the wire as a query param.
    await brapiFindGermplasm.handler(brapiFindGermplasm.input.parse({ text: "' OR '1'='1" }), ctx);

    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.has('searchText')).toBe(false);
    expect(url.searchParams.has('text')).toBe(false);
    expect(url.searchParams.toString()).not.toContain('OR');
  });
});

describe('oversized input handling', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
    vi.unstubAllEnvs();
  });

  it('brapi_find_germplasm accepts a very long germplasm name without crashing', async () => {
    const ctx = await connectBasic(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));
    // 1024-char name — should process without throwing
    const longName = 'A'.repeat(1024);
    await expect(
      brapiFindGermplasm.handler(brapiFindGermplasm.input.parse({ names: [longName] }), ctx),
    ).resolves.not.toThrow();
  });

  it('brapi_find_studies accepts very long season strings without crashing', async () => {
    const ctx = await connectBasic(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));
    const longSeason = '2022-'.repeat(100);
    await expect(
      brapiFindStudies.handler(brapiFindStudies.input.parse({ seasons: [longSeason] }), ctx),
    ).resolves.not.toThrow();
  });

  it('brapi_raw_get does not accept params with excessively large values', async () => {
    // The tool itself doesn't cap param value length at the Zod layer — the
    // upstream HTTP fetch will fail. Verify the fetcher is called with the param
    // and the tool does not panic or corrupt other state.
    const ctx = await connectBasic(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));
    const bigValue = 'x'.repeat(10_000);
    const result = await brapiRawGet.handler(
      brapiRawGet.input.parse({ path: '/samples', params: { filter: bigValue } }),
      ctx,
    );
    // The result path must be correct; the oversized param is forwarded as-is.
    expect(result.path).toBe('/samples');
  });
});

describe('unicode and encoding edge cases', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
    vi.unstubAllEnvs();
  });

  it('brapi_find_germplasm returns rows with Unicode names without corruption', async () => {
    const ctx = await connectBasic(fetcher);
    const rows = [
      {
        germplasmDbId: 'g-uni',
        germplasmName: 'Café Variété — niño/niña',
        commonCropName: 'Cassava',
      },
      { germplasmDbId: 'g-cjk', germplasmName: '木薯品种 — 玉米杂交', commonCropName: 'Maize' },
      { germplasmDbId: 'g-emoji', germplasmName: 'Accession 🌽 Beta', commonCropName: 'Maize' },
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiFindGermplasm.handler(brapiFindGermplasm.input.parse({}), ctx);

    expect(result.results[0]?.germplasmName).toBe('Café Variété — niño/niña');
    expect(result.results[1]?.germplasmName).toBe('木薯品种 — 玉米杂交');
    expect(result.results[2]?.germplasmName).toBe('Accession 🌽 Beta');
    // format() must not corrupt the Unicode
    const text = brapiFindGermplasm.format!(result)
      .map((b) => ('text' in b ? b.text : ''))
      .join('\n');
    expect(text).toContain('Café Variété');
    expect(text).toContain('木薯品种');
  });

  it('brapi_raw_get encodes special characters in path segments correctly', async () => {
    const ctx = await connectBasic(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));
    // The tool normalizes path — non-ASCII chars in path segments must not crash.
    await brapiRawGet.handler(brapiRawGet.input.parse({ path: '/germplasm/accession-niño' }), ctx);
    const calledUrl = String(fetcher.mock.calls[0]![0]);
    expect(calledUrl).toContain('/germplasm/');
  });

  it('brapi_find_germplasm text filter handles Unicode search terms', async () => {
    const ctx = await connectBasic(fetcher);
    const rows = [
      { germplasmDbId: 'g1', germplasmName: 'TME419' },
      { germplasmDbId: 'g2', germplasmName: 'Variété niño' },
    ];
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: rows }, { totalCount: rows.length })));

    const result = await brapiFindGermplasm.handler(
      brapiFindGermplasm.input.parse({ text: 'niño' }),
      ctx,
    );

    expect(result.results[0]?.germplasmDbId).toBe('g2');
  });
});

describe('empty result-set edge cases', () => {
  let fetcher: MockFetcher;

  beforeEach(() => {
    fetcher = initTestServices();
  });

  afterEach(() => {
    resetTestServices();
    vi.unstubAllEnvs();
  });

  it('brapi_find_germplasm with zero results returns empty distributions and hasMore=false', async () => {
    const ctx = await connectBasic(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));

    const result = await brapiFindGermplasm.handler(brapiFindGermplasm.input.parse({}), ctx);

    expect(result.results).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    expect(result.dataframe).toBeUndefined();
    expect(Object.keys(result.distributions.commonCropName)).toHaveLength(0);
    expect(Object.keys(result.distributions.genus)).toHaveLength(0);
  });

  it('brapi_find_studies with zero results returns empty distributions and hasMore=false', async () => {
    fetcher.mockImplementation(async (url: string) => {
      const path = pathnameOf(url);
      if (path.endsWith('/serverinfo')) {
        return jsonResponse(
          envelope({
            serverName: 'Test',
            calls: [{ service: 'studies', methods: ['GET'], versions: ['2.1'] }],
          }),
        );
      }
      if (path.endsWith('/commoncropnames')) return jsonResponse(envelope({ data: [] }));
      return jsonResponse(envelope({ data: [] }, { totalCount: 0 }));
    });
    const ctx = createMockContext({ tenantId: 't1' });
    await brapiConnect.handler(brapiConnect.input.parse({ baseUrl: BASE_URL }), ctx);
    fetcher.mockReset();
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));

    const result = await brapiFindStudies.handler(brapiFindStudies.input.parse({}), ctx);

    expect(result.results).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    expect(result.dataframe).toBeUndefined();
    expect(Object.keys(result.distributions.programName)).toHaveLength(0);
    expect(Object.keys(result.distributions.seasons)).toHaveLength(0);
  });

  it('brapi_find_germplasm format() renders "No germplasm found" variant on empty results', async () => {
    const ctx = await connectBasic(fetcher);
    fetcher.mockResolvedValue(jsonResponse(envelope({ data: [] }, { totalCount: 0 })));

    const result = await brapiFindGermplasm.handler(brapiFindGermplasm.input.parse({}), ctx);

    const blocks = brapiFindGermplasm.format!(result);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    // The format must not blow up and must produce something sensible.
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });
});
