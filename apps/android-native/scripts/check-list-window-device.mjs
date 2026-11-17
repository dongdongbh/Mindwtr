import './device-lock.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Stopped, box, check, connect, evidenced, fail, tagged, taskRows } from './device.mjs';

const [serial, seedApk] = process.argv.slice(2);
if (!serial || !seedApk) {
    console.error('usage: check-list-window-device.mjs <adb-serial> <benchmarkSeed.apk>');
    process.exit(2);
}
const pkg = 'tech.dongdongbh.mindwtr.nativeclient.dev.benchmark';
const measure = resolve(import.meta.dirname, 'measure-startup-device.mjs');
const large = join(homedir(), '.mindwtr-harness', 'startup', 'large-5000.db');
const WINDOW_DELAY_MS = 30000;
const LAST_OF_FIRST_WINDOW = 245;

if (!existsSync(large)) execFileSync(process.execPath, [measure, 'fixture', '5000', large], { stdio: 'inherit' });
execFileSync(process.execPath, [measure, 'seed', serial, pkg, seedApk, seedApk, large], { stdio: 'inherit' });

const device = connect({ serial, pkg, uiFile: '/sdcard/list-window-ui.xml' });
const { sh, screen, waitFor, swipe } = device;
const number = (row) => Number(/^Synthetic task (\d+)$/.exec(row.text)?.[1] ?? NaN);
const deepest = (nodes) => Math.max(-1, ...taskRows(nodes).map(number).filter(Number.isFinite));
const selected = (nodes) => Number(nodes.map((node) => /^(\d+) selected$/.exec(node.text ?? '')?.[1]).find(Boolean) ?? 0);
const hold = (node) => {
    const [l, t, r, b] = box(node);
    sh(`input swipe ${Math.round((l + r) / 2)} ${Math.round((t + b) / 2)} ${Math.round((l + r) / 2)} ${Math.round((t + b) / 2)} 900`);
};

try {
    sh(`pm grant ${pkg} android.permission.POST_NOTIFICATIONS`);
    sh(`setprop debug.mindwtr.native.window_delay_ms ${WINDOW_DELAY_MS}`);
    device.launch(`${pkg}/${pkg}.MainActivity`, { startTab: 'inbox' });
    let nodes = await waitFor('the Inbox rows', (current) => taskRows(current).length > 0, 60_000);
    for (let attempt = 0; attempt < 3 && selected(nodes) !== 1; attempt += 1) {
        await sleep(2000);
        hold(taskRows(await screen())[0]);
        await sleep(1500);
        nodes = await screen();
    }
    check(selected(nodes) === 1, 'a long press starts selection with one row');

    for (let step = 0; step < 40 && !tagged(nodes, 'list-next-window'); step += 1) nodes = await swipe(nodes, 'down');
    check(Boolean(tagged(nodes, 'list-next-window')) && deepest(nodes) === LAST_OF_FIRST_WINDOW,
        `the end of the first window (task ${LAST_OF_FIRST_WINDOW}) shows the loading spinner`);

    const row = taskRows(nodes).filter((candidate) => box(candidate)[1] > 300).at(-1) ?? fail('no row to tap');
    const [l, t, r, b] = box(row);
    sh(`input tap ${Math.round((l + r) / 2)} ${Math.round((t + b) / 2)}`);
    await sleep(1200);
    nodes = await waitFor('the second selection', (current) => selected(current) === 2, 10_000);
    check(deepest(nodes) > LAST_OF_FIRST_WINDOW && !tagged(nodes, 'list-next-window'),
        `a row tapped while the next window loads keeps that window (deepest row ${deepest(nodes)}, spinner ${Boolean(tagged(nodes, 'list-next-window'))})`);
    console.log('List window device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    sh('setprop debug.mindwtr.native.window_delay_ms ""');
    sh(`am force-stop ${pkg}`);
}
