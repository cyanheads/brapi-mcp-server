/**
 * @fileoverview Handler tests for `brapi_dataframe_describe`. Covers the
 * empty/no-dataframes case and provenance augmentation for `df_*`-prefixed
 * dataframes.
 *
 * @module tests/tools/brapi-dataframe-describe.tool.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { resetConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { brapiDataframeDescribe } from '@/mcp-server/tools/definitions/brapi-dataframe-describe.tool.js';
import { initCanvasBridge, resetCanvasBridge } from '@/services/canvas-bridge/index.js';
import { FakeDataCanvas } from '../services/_fake-canvas.js';
import { TEST_CONFIG } from './_tool-test-helpers.js';

describe('brapi_dataframe_describe', () => {
  afterEach(() => {
    resetCanvasBridge();
    vi.unstubAllEnvs();
    resetConfig();
  });

  it('returns an empty list when no dataframes registered yet', async () => {
    const fake = new FakeDataCanvas();
    initCanvasBridge(fake as unknown as DataCanvas, TEST_CONFIG);
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeDescribe.errors });
    const result = await brapiDataframeDescribe.handler(
      brapiDataframeDescribe.input.parse({}),
      ctx,
    );
    expect(result.tables).toEqual([]);
  });

  it('surfaces df_<uuid> dataframes with provenance', async () => {
    const fake = new FakeDataCanvas();
    const bridge = initCanvasBridge(fake as unknown as DataCanvas, TEST_CONFIG);
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeDescribe.errors });
    const handle = await bridge.registerDataframe(ctx, {
      source: 'find_observations',
      baseUrl: 'https://brapi.example.org/brapi/v2',
      query: { studies: ['422'] },
      rows: [{ observationDbId: 'o1' }],
    });

    const result = await brapiDataframeDescribe.handler(
      brapiDataframeDescribe.input.parse({}),
      ctx,
    );
    expect(result.tables).toHaveLength(1);
    const [table] = result.tables;
    expect(table?.name).toBe(handle.tableName);
    expect(table?.name.startsWith('df_')).toBe(true);
    expect(table?.provenance?.source).toBe('find_observations');
    expect(table?.provenance?.baseUrl).toBe('https://brapi.example.org/brapi/v2');
  });

  it('renders an empty marker when no dataframes exist', () => {
    const formatted = brapiDataframeDescribe.format?.({ tables: [] });
    const text =
      (formatted ?? [])[0]?.type === 'text' ? (formatted![0] as { text: string }).text : '';
    expect(text).toContain('# 0 dataframe(s)');
    expect(text).toContain('No dataframes');
  });

  it('gates list-all under shared-tenant HTTP', async () => {
    const fake = new FakeDataCanvas();
    initCanvasBridge(fake as unknown as DataCanvas, TEST_CONFIG);
    vi.stubEnv('MCP_TRANSPORT_TYPE', 'http');
    vi.stubEnv('MCP_AUTH_MODE', 'none');
    resetConfig();
    const ctx = createMockContext({
      tenantId: 'default',
      errors: brapiDataframeDescribe.errors,
    });
    await expect(
      brapiDataframeDescribe.handler(brapiDataframeDescribe.input.parse({}), ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: expect.objectContaining({ reason: 'list_all_disabled_on_shared_http' }),
    });
  });

  it('allows list-all under stdio with default tenant (single-process safety)', async () => {
    const fake = new FakeDataCanvas();
    initCanvasBridge(fake as unknown as DataCanvas, TEST_CONFIG);
    vi.stubEnv('MCP_TRANSPORT_TYPE', 'stdio');
    resetConfig();
    const ctx = createMockContext({
      tenantId: 'default',
      errors: brapiDataframeDescribe.errors,
    });
    const result = await brapiDataframeDescribe.handler(
      brapiDataframeDescribe.input.parse({}),
      ctx,
    );
    expect(result.tables).toEqual([]);
  });

  it('allows list-all under HTTP with per-user tenant (auth carves isolation)', async () => {
    const fake = new FakeDataCanvas();
    initCanvasBridge(fake as unknown as DataCanvas, TEST_CONFIG);
    vi.stubEnv('MCP_TRANSPORT_TYPE', 'http');
    vi.stubEnv('MCP_AUTH_MODE', 'jwt');
    vi.stubEnv('MCP_AUTH_SECRET_KEY', 'x'.repeat(40));
    resetConfig();
    const ctx = createMockContext({
      tenantId: 'alice',
      errors: brapiDataframeDescribe.errors,
    });
    const result = await brapiDataframeDescribe.handler(
      brapiDataframeDescribe.input.parse({}),
      ctx,
    );
    expect(result.tables).toEqual([]);
  });

  it('allows specific-dataframe lookup under shared-tenant HTTP (possession of name)', async () => {
    const fake = new FakeDataCanvas();
    const bridge = initCanvasBridge(fake as unknown as DataCanvas, TEST_CONFIG);
    vi.stubEnv('MCP_TRANSPORT_TYPE', 'http');
    vi.stubEnv('MCP_AUTH_MODE', 'none');
    resetConfig();
    const ctx = createMockContext({
      tenantId: 'default',
      errors: brapiDataframeDescribe.errors,
    });
    const handle = await bridge.registerDataframe(ctx, {
      source: 'find_observations',
      baseUrl: 'https://brapi.example.org/brapi/v2',
      query: {},
      rows: [{ observationDbId: 'o1' }],
    });
    const result = await brapiDataframeDescribe.handler(
      brapiDataframeDescribe.input.parse({ dataframe: handle.tableName }),
      ctx,
    );
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]?.name).toBe(handle.tableName);
  });

  it('gate error carries recovery hint pointing at auth-mode and named dataframe', async () => {
    const fake = new FakeDataCanvas();
    initCanvasBridge(fake as unknown as DataCanvas, TEST_CONFIG);
    vi.stubEnv('MCP_TRANSPORT_TYPE', 'http');
    vi.stubEnv('MCP_AUTH_MODE', 'none');
    resetConfig();
    const ctx = createMockContext({
      tenantId: 'default',
      errors: brapiDataframeDescribe.errors,
    });
    try {
      await brapiDataframeDescribe.handler(brapiDataframeDescribe.input.parse({}), ctx);
      expect.fail('expected handler to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      const data = (err as McpError).data as { recovery?: { hint?: string } } | undefined;
      expect(data?.recovery?.hint).toMatch(/dataframe/);
      expect(data?.recovery?.hint).toMatch(/find_\*|registerAs/);
    }
  });

  it('renders provenance lines for df_-prefixed dataframes', () => {
    const formatted = brapiDataframeDescribe.format?.({
      tables: [
        {
          name: 'df_abc',
          rowCount: 5,
          columns: [
            { name: 'id', type: 'VARCHAR' },
            { name: 'value', type: 'DOUBLE', nullable: true },
          ],
          provenance: {
            source: 'find_observations',
            baseUrl: 'https://b/v2',
            query: { studies: ['s1'] },
            createdAt: '2026-05-02T00:00:00.000Z',
            expiresAt: '2026-05-03T00:00:00.000Z',
          },
        },
      ],
    });
    const text =
      (formatted ?? [])[0]?.type === 'text' ? (formatted![0] as { text: string }).text : '';
    expect(text).toContain('## `df_abc`');
    expect(text).toContain('- provenance:');
    expect(text).toContain('source: find_observations');
    expect(text).toContain('baseUrl: https://b/v2');
  });

  it('caps a pathological wide column list and points recovery at brapi_dataframe_query', () => {
    // A genotype-matrix pivot: one column per variant. Uncapped, this renders a
    // line per variant into content[] and scales to megabytes on a wide matrix.
    const columns = Array.from({ length: 200 }, (_, i) => ({
      name: `variant_col_${i}`,
      type: 'VARCHAR',
    }));
    const formatted = brapiDataframeDescribe.format?.({
      tables: [{ name: 'df_wide', rowCount: 3, columns }],
    });
    const text =
      (formatted ?? [])[0]?.type === 'text' ? (formatted![0] as { text: string }).text : '';

    // The total count still reports every column...
    expect(text).toContain('- columns: 200');
    // ...but the per-column listing is capped with an honest omission notice.
    expect(text).toContain('variant_col_0: VARCHAR');
    expect(text).not.toContain('variant_col_199');
    expect(text).toMatch(/…\+\d+ more column\(s\) not shown/);
    // Recovery names the real uncapped path — brapi_dataframe_query, not another
    // (now equally capped) describe call, and structuredContent (unreadable to
    // content-only clients) is not cited.
    expect(text).toContain('brapi_dataframe_query');
    expect(text).toContain('SELECT * FROM df_wide LIMIT 0');

    // structuredContent still carries the complete schema regardless of render.
    const structured = { tables: [{ name: 'df_wide', rowCount: 3, columns }] };
    expect(structured.tables[0]?.columns).toHaveLength(200);
  });

  it('renders every column when the list fits the budget (normal find_* shape)', () => {
    const columns = Array.from({ length: 12 }, (_, i) => ({
      name: `col_${i}`,
      type: 'VARCHAR',
    }));
    const formatted = brapiDataframeDescribe.format?.({
      tables: [{ name: 'df_narrow', rowCount: 3, columns }],
    });
    const text =
      (formatted ?? [])[0]?.type === 'text' ? (formatted![0] as { text: string }).text : '';
    for (const col of columns) expect(text).toContain(`${col.name}: VARCHAR`);
    expect(text).not.toContain('not shown');
  });
});
