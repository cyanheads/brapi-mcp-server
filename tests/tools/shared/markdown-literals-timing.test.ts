/**
 * @fileoverview CPU and growth bounds for upstream Markdown literal rendering.
 * @module tests/tools/shared/markdown-literals-timing.test
 */
import { describe, expect, it } from 'vitest';
import { code, fenced, literal, prose } from '@/mcp-server/tools/shared/markdown-literals.js';

describe('Markdown rendering CPU bounds', () => {
  it.each(['unclosed', 'nested', 'break-at-end', 'breaks-throughout', 'benign'])(
    '%s scales across a 64x span',
    (shape) => {
      const render = (value: string) =>
        prose(value).length +
        code(value).length +
        code(value, true).length +
        fenced(value).length +
        literal`value=\`${value}\``.length;
      const make = (size: number) => {
        const pattern =
          shape === 'unclosed'
            ? '[`\\|'
            : shape === 'nested'
              ? '[[**```\\|'
              : shape === 'breaks-throughout'
                ? '`\r\n[\\|\n'
                : shape === 'benign'
                  ? 'sample_123'
                  : '`[_\\|';
        const value = pattern.repeat(Math.ceil(size / pattern.length)).slice(0, size);
        return shape === 'break-at-end' ? `${value}\n` : value;
      };
      // Warm the real renderer before measuring, without an unrelated CPU load.
      for (let i = 0; i < 30; i++) render(make(5_000));
      const absolute = process.env.MARKDOWN_TIMING_VERIFY_FAILURE === '1' ? 0 : 2_000_000;
      const timings: number[] = [];
      for (const size of [1_250, 5_000, 20_000, 80_000]) {
        if (timings.length > 0) expect(timings.at(-1)).toBeLessThan(absolute);
        const value = make(size);
        const start = process.threadCpuUsage();
        let length = 0;
        for (let i = 0; i < 12; i++) length += render(value);
        const cpu = process.threadCpuUsage(start);
        const micros = (cpu.user + cpu.system) / 12;
        expect(length).toBeGreaterThan(value.length);
        expect(micros).toBeLessThan(absolute);
        timings.push(micros);
      }
      expect(timings[3]! / Math.max(timings[0]!, 1)).toBeLessThan(256);
      console.info(
        JSON.stringify({
          shape,
          runtime: process.versions.bun ? 'bun' : 'node',
          sizes: [1250, 5000, 20000, 80000],
          cpuMicros: timings,
        }),
      );
    },
  );
});
