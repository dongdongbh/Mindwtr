// Settings › Data's merges that run without Undo at the 15 MiB limit (large-library pass b): check-data-device.mjs's
// D1C_PART=no-undo memory rows alone (recovery snapshot plus library after at about 14.9 and 20 MiB). Same arguments and exit codes.
//   node apps/android-native/scripts/check-data-no-undo-device.mjs <adb-serial>
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const run = spawnSync(process.execPath, [resolve(import.meta.dirname, 'check-data-device.mjs'), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, D1C_PART: 'no-undo' } });
process.exit(run.status ?? 1);
