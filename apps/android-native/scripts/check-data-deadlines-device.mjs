// Settings › Data's size-scaled deadlines on the S23 (pass D1c design §3.4), part 1: check-data-device.mjs's DL1-DL2 rows alone,
// each with its failing control first (DL3-DL5: check-data-deadlines2-device.mjs), so each part fits the batch's hour per
// check. Same arguments and exit codes.
//   node apps/android-native/scripts/check-data-deadlines-device.mjs <adb-serial>
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const run = spawnSync(process.execPath, [resolve(import.meta.dirname, 'check-data-device.mjs'), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, D1C_PART: 'deadlines-1' } });
process.exit(run.status ?? 1);
