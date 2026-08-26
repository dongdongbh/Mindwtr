import { existsSync, readFileSync, writeFileSync } from 'fs';

import { withMcpWriteLock } from '../db-write-lock.js';

const [mode, dbPath, signalPath, counterPath, releasePath] = process.argv.slice(2);
if (!mode || !dbPath || !signalPath || !counterPath) {
  throw new Error(
    'Usage: mcp-write-lock-worker <hold|increment> <db-path> <signal-path> <counter-path> [release-path]',
  );
}

const increment = async () => {
  const current = existsSync(counterPath) ? Number(readFileSync(counterPath, 'utf8')) : 0;
  await new Promise((resolve) => setTimeout(resolve, 25));
  writeFileSync(counterPath, String(current + 1));
};

if (mode === 'hold') {
  if (!releasePath) throw new Error('hold mode requires a release path');
  await withMcpWriteLock(dbPath, async () => {
    writeFileSync(signalPath, 'holding');
    while (!existsSync(releasePath)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await increment();
  });
} else if (mode === 'increment') {
  await withMcpWriteLock(dbPath, async () => {
    writeFileSync(signalPath, 'entered');
    await increment();
  });
} else {
  throw new Error(`Unknown MCP write lock worker mode: ${mode}`);
}
