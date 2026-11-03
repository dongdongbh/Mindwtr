


import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const harness = join(homedir(), '.mindwtr-harness');
export const deviceLockFile = (serial) => join(harness, `device-${serial.replace(/[^\w.-]/g, '_')}.lock`);

const TIMED_OUT = 75;
const script = basename(process.argv[1] ?? '');
const serial = process.argv[2] ?? '';
if (/^(check-[\w-]+-device|capture-parity-screens)\.mjs$/.test(script) && /^[\w.:-]+$/.test(serial) && !serial.startsWith('-')
    && process.env.MINDWTR_DEVICE_LOCKED !== serial) {
    mkdirSync(harness, { recursive: true });
    const lock = deviceLockFile(serial);
    if (spawnSync('flock', ['-n', lock, 'true']).status !== 0) console.log(`waiting for another run on ${serial} (${lock})`);
    const run = spawnSync('flock', ['-E', String(TIMED_OUT), '-w', '14400', lock, process.execPath, ...process.execArgv, ...process.argv.slice(1)],
        { stdio: 'inherit', env: { ...process.env, MINDWTR_DEVICE_LOCKED: serial } });
    if (run.status === TIMED_OUT) console.error(`STOPPED: ${serial} stayed busy for 4 hours (${lock})`);
    process.exit(run.status ?? 1);
}
