/**
 * @fileoverview Startup tests for the entry point (`src/index.ts`). Boots the
 * real entry module in a child process from an empty working directory (no
 * `.env`) and checks that every malformed `BRAPI_*` value fails behind the
 * framework's configuration banner — on stdio and HTTP — instead of crashing
 * at import with a raw stack.
 *
 * @module tests/index.test
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const BANNER = 'Configuration error — server failed to start';

interface Boot {
  code: number | null;
  stderr: string;
}

/** Start the entry point with only `env` (plus PATH/HOME) and collect its exit. */
function boot(cwd: string, env: Record<string, string>): Promise<Boot> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', [ENTRY], {
      cwd,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    // A server that started instead of failing is stopped by its own PID.
    const guard = setTimeout(() => child.kill('SIGTERM'), 20_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(guard);
      resolve({ code, stderr });
    });
  });
}

describe('entry point startup with malformed BRAPI_* config', () => {
  let cwd: string;

  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'brapi-startup-'));
  });

  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const cases: Array<{ name: string; value: string }> = [
    { name: 'BRAPI_LOAD_LIMIT', value: 'abc' },
    { name: 'BRAPI_CANVAS_MAX_ROWS', value: 'abc' },
    { name: 'BRAPI_ENABLE_WRITES', value: 'maybe' },
  ];

  for (const transport of ['stdio', 'http'] as const) {
    for (const { name, value } of cases) {
      it(`${name}=${value} fails behind the configuration banner on ${transport}`, async () => {
        const { code, stderr } = await boot(cwd, {
          MCP_TRANSPORT_TYPE: transport,
          MCP_HTTP_HOST: '127.0.0.1',
          MCP_HTTP_PORT: '0',
          [name]: value,
        });

        expect(code).toBe(1);
        expect(stderr).toContain(BANNER);
        expect(stderr).toContain(name);
        expect(stderr).not.toMatch(/McpError:|^\s+at /m);
      }, 30_000);
    }
  }

  it('reports a canvas row cap above the canvas limit the same way', async () => {
    const { code, stderr } = await boot(cwd, {
      MCP_TRANSPORT_TYPE: 'stdio',
      BRAPI_CANVAS_MAX_ROWS: '20000',
    });

    expect(code).toBe(1);
    expect(stderr).toContain(BANNER);
    expect(stderr).toContain('BRAPI_CANVAS_MAX_ROWS');
  }, 30_000);
});
