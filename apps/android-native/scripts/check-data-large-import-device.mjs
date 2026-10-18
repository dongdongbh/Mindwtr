// Settings › Data's largest TickTick and Mindwtr CSV imports on the S23 and their Undo (pass native-import-large): check-data-device.mjs's
// LI rows alone. Same arguments and exit codes.
//   node apps/android-native/scripts/check-data-large-import-device.mjs <adb-serial>
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const run = spawnSync(process.execPath, [resolve(import.meta.dirname, 'check-data-device.mjs'), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, D1C_PART: 'large-import' } });
process.exit(run.status ?? 1);
