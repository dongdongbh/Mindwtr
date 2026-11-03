


import './device-lock.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [serial, seedApk, benchApk, runsText = '10'] = process.argv.slice(2);
if (!serial || !seedApk || !benchApk) {
    console.error('usage: check-startup-device.mjs <adb-serial> <benchmarkSeed.apk> <benchmark.apk> [runs=10]');
    process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const measure = join(here, 'measure-startup-device.mjs');
const pkg = 'tech.dongdongbh.mindwtr.nativeclient.dev.benchmark';
const ADB = process.env.ADB ?? '/opt/android-sdk/platform-tools/adb';
const work = join(homedir(), '.mindwtr-harness', 'startup');
mkdirSync(join(work, 'runs'), { recursive: true });
const node = (...args) => execFileSync(process.execPath, [measure, ...args], { stdio: 'inherit' });


const doc = readFileSync(resolve(here, '../../../docs/performance/budgets.md'), 'utf8');
const section = doc.slice(doc.indexOf('## Native Android startup'));
const budgets = [...section.matchAll(/^\| `(empty|large-5000)` \| (\d+)ms \| (\d+)ms \| (\d+)ms \| (\d+)ms \|$/gm)]
    .map(([, db, ttid, cold, coldP90, warm]) => ({ db, ttid: +ttid, cold: +cold, coldP90: +coldP90, warm: +warm }));
if (budgets.length !== 2) throw new Error(`budgets.md: expected the empty and large-5000 rows, found ${budgets.length}`);

const large = join(work, 'large-5000.db');
if (!existsSync(large)) node('fixture', '5000', large);

let failed = false;
for (const budget of budgets) {
    node('seed', serial, pkg, seedApk, benchApk, budget.db === 'empty' ? 'empty' : large);
    execFileSync(ADB, ['-s', serial, 'shell', `am start -W -n ${pkg}/${pkg}.MainActivity`]);
    await new Promise((done) => setTimeout(done, 8000));
    const label = `check-${budget.db}`;
    try {
        node('run', serial, pkg, label, join(work, 'runs'), runsText, 'cold,warm', 'verify');
    } catch {
        console.error(`FAIL ${budget.db}: invalid samples (see ${join(work, 'runs', `${label}.json`)})`);
        failed = true;
        continue;
    }
    const { cold, warm } = JSON.parse(readFileSync(join(work, 'runs', `${label}.json`), 'utf8')).summary;
    for (const [name, value, limit] of [
        ['cold TTID median', cold.totalTime.median, budget.ttid],
        ['cold first content median', cold.fullyDrawn.median, budget.cold],
        ['cold first content p90', cold.fullyDrawn.p90, budget.coldP90],
        ['warm first content median', warm.fullyDrawn.median, budget.warm],
    ]) {
        const over = !(value <= limit);
        failed ||= over;
        console.log(`${over ? 'FAIL' : 'ok  '} ${budget.db} ${name}: ${value} ms (budget ${limit} ms)`);
    }
}
execFileSync(ADB, ['-s', serial, 'shell', 'input keyevent KEYCODE_HOME']);
console.log(failed ? 'Startup check FAILED' : 'Startup check passed');
process.exit(failed ? 1 : 0);
