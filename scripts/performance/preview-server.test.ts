import { expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPreview } from './preview-server.mjs';

it('serves the built artifact without parsing console output and refuses an occupied port', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mindwtr-preview-test-'));
  mkdirSync(join(directory, 'dist'));
  writeFileSync(join(directory, 'dist/index.html'), '<h1>Benchmark fixture</h1>');
  let server: Awaited<ReturnType<typeof startPreview>> | undefined;
  try {
    server = await startPreview(directory, 0);
    expect(await (await fetch(server.url)).text()).toContain('Benchmark fixture');
    const port = Number(new URL(server.url).port);
    await expect(startPreview(directory, port)).rejects.toThrow(/already in use/);
    // Failure must not close or adopt the other listener.
    expect((await fetch(server.url)).ok).toBe(true);
  } finally {
    await server?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
