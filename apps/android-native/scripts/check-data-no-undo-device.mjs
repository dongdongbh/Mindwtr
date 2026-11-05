


import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const run = spawnSync(process.execPath, [resolve(import.meta.dirname, 'check-data-device.mjs'), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, D1C_PART: 'no-undo' } });
process.exit(run.status ?? 1);
