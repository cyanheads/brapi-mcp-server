/**
 * @fileoverview Handler tests for `brapi_dataframe_drop`. Covers the
 * dropped:true path and the idempotent dropped:false path. The opt-in
 * `BRAPI_CANVAS_DROP_ENABLED` gate is enforced by the registration layer
 * (see registration-gate.test.ts), not by the handler itself.
 *
 * @module tests/tools/brapi-dataframe-drop.tool.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { brapiDataframeDrop } from '@/mcp-server/tools/definitions/brapi-dataframe-drop.tool.js';
import { initCanvasBridge, resetCanvasBridge } from '@/services/canvas-bridge/index.js';
import { FakeDataCanvas } from '../services/_fake-canvas.js';
import { TEST_CONFIG } from './_tool-test-helpers.js';

describe('brapi_dataframe_drop', () => {
  afterEach(() => {
    resetCanvasBridge();
  });

  it('returns dropped:true when the dataframe existed and was removed', async () => {
    const fake = new FakeDataCanvas();
    const bridge = initCanvasBridge(fake as unknown as DataCanvas, TEST_CONFIG);
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeDrop.errors });
    await bridge.registerTable(ctx, 'staging', [{ a: 1 }]);
    const result = await brapiDataframeDrop.handler(
      brapiDataframeDrop.input.parse({ dataframe: 'staging' }),
      ctx,
    );
    expect(result).toEqual({ dataframe: 'staging', dropped: true });
  });

  it('returns dropped:false (idempotent) for unknown dataframe names', async () => {
    const fake = new FakeDataCanvas();
    initCanvasBridge(fake as unknown as DataCanvas, TEST_CONFIG);
    const ctx = createMockContext({ tenantId: 't1', errors: brapiDataframeDrop.errors });
    const result = await brapiDataframeDrop.handler(
      brapiDataframeDrop.input.parse({ dataframe: 'never_existed' }),
      ctx,
    );
    expect(result).toEqual({ dataframe: 'never_existed', dropped: false });
  });

  it('renders different markers for dropped vs no-op', () => {
    const droppedText = renderText(
      brapiDataframeDrop.format?.({ dataframe: 'staging', dropped: true }),
    );
    expect(droppedText).toContain('# Dropped `staging`');

    const noopText = renderText(
      brapiDataframeDrop.format?.({ dataframe: 'missing', dropped: false }),
    );
    expect(noopText).toContain('# No-op');
  });
});

function renderText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const first = content[0];
  if (first && typeof first === 'object' && 'type' in first && first.type === 'text') {
    return (first as { text: string }).text;
  }
  return '';
}
