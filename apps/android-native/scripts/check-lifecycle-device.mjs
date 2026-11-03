


import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { bootFailure, box, button, check, connect, draftText, evidenced, fail, field, hasText, owedRetry, readRetry, Stopped, tagged, taskRows, inboxCount } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-lifecycle-device.mjs <adb-serial> [apk]');
    process.exit(2);
}
const app = resolve(import.meta.dirname, '..');
const apk = apkArg ?? resolve(app, 'android/app/build/outputs/apk/play/debug/app-play-debug.apk');
const adbBin = process.env.ADB ?? '/home/dd/Android/Sdk/platform-tools/adb';
const aapt2 = process.env.AAPT2 ?? '/home/dd/Android/Sdk/build-tools/36.1.0/aapt2';
const PKG = 'tech.dongdongbh.mindwtr.nativeclient.dev';

const apkPackage = execFileSync(aapt2, ['dump', 'packagename', apk], { encoding: 'utf8' }).trim();
if (apkPackage !== PKG) {
    console.error(`REFUSED: ${apk} is package "${apkPackage}", not ${PKG}`);
    process.exit(2);
}
const ACTIVITY = `${PKG}/${PKG}.MainActivity`;
const TAG = 'MindwtrNativeDev';
const UI_FILE = '/data/local/tmp/mindwtr-native-dev-ui.xml';

const PROPS = ['fail_commit', 'delay_before_ms', 'delay_after_ms', 'language'];
const work = resolve(app, 'android/build/lifecycle-check');


const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const titles = { a: `81${run}`, b: `82${run}`, c1: `83${run}`, c2: `84${run}`, c3: `85${run}`, d: `86${run}` };

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, requireAppFront, pid, screen, waitFor, tap, type, reveal, swipe, toTop } = device;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);


const launch = () => device.launch(ACTIVITY);
const logs = (processId) => device.logs(processId, TAG);
const count = (text, needle) => text.split('\n').filter((line) => line.includes(needle)).length;
const boots = (processId) => count(logs(processId), 'Core host boot started');
const recreations = (processId) => logs(processId).split('\n')
    .filter((line) => line.includes('releaseCheck=v1.3.3/native-android-dev-host-reuse') && line.includes('reason=activity-recreate'));
const newScreens = (processId) => count(logs(processId), 'reason=new-screen');
const rotate = (rotation) => {
    requireAppFront();
    sh('settings put system accelerometer_rotation 0');
    sh(`settings put system user_rotation ${rotation}`);
};


const header = inboxCount;
const hasError = (nodes) => nodes.some((node) => node.text?.includes('Injected commit failure'));
const loaded = () => waitFor('the Inbox to load', (nodes) => Number.isFinite(header(nodes)), 60_000);

const tapAdd = async () => tap(button(await screen(), 'Save'));
const busyField = (nodes) => field(nodes)?.enabled === 'false';


const scrollToSave = async (nodes) => {
    const inside = (current) => {
        const area = tagged(current, 'capture-scroll');
        const save = current.find((node) => node.text === 'Save' || node['content-desc'] === 'Save');
        if (!area) return Boolean(save);
        const [, top, , bottom] = box(area);
        return Boolean(save) && box(save)[1] >= top && box(save)[3] <= bottom;
    };
    for (let step = 0; step < 8 && !inside(nodes); step += 1) {
        const [l, t, r, b] = box(tagged(nodes, 'capture-scroll'));
        requireAppFront();
        sh(`input swipe ${Math.round((l + r) / 2)} ${b - 20} ${Math.round((l + r) / 2)} ${t + 20} 400`);
        await sleep(600);
        nodes = await screen();
    }
    return inside(nodes) ? nodes : fail('Save never came into the popup\'s view');
};


const pullDatabase = () => {
    const dir = resolve(work, 'db');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = sh(`run-as ${PKG} ls files`).split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) {
        const name = `mindwtr-native-dev.db${suffix}`;
        if (present.includes(name)) device.pull(`files/${name}`, resolve(dir, name));
    }
    return resolve(dir, 'mindwtr-native-dev.db');
};
const rowsTitled = (...names) => Number(execFileSync('sqlite3', [pullDatabase(),
    `SELECT COUNT(*) FROM tasks WHERE title IN (${names.map((name) => `'${name}'`).join(', ')}) AND deletedAt IS NULL`],
{ encoding: 'utf8' }).trim());

const owedCaptureId = () => {
    const pending = JSON.parse(sh(`run-as ${PKG} cat no_backup/capture/capture`)).pending;
    if (pending?.kind !== 'capture') fail(`no owed capture on disk: ${JSON.stringify(pending)}`);
    return pending.id.toLowerCase();
};
const rowsWithId = (id) => Number(execFileSync('sqlite3', [pullDatabase(),
    `SELECT COUNT(*) FROM tasks WHERE id = '${id}' AND deletedAt IS NULL`], { encoding: 'utf8' }).trim());

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const restore = () => {
    for (const name of PROPS) { try { setProp(name, ''); } catch {                   } }
    for (const [name, value] of [['user_rotation', originalRotation], ['accelerometer_rotation', originalAccelerometer]]) {
        try { sh(value === 'null' ? `settings delete system ${name}` : `settings put system ${name} ${value}`); } catch {                   }
    }
    try { sh(`rm -f ${UI_FILE}`); } catch {                   }
};

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})${sh('getprop ro.boot.qemu.avd_name') ? ` / AVD ${sh('getprop ro.boot.qemu.avd_name')}` : ''}`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    for (const name of PROPS) setProp(name, '');


    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) {
        throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    }
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    launch();
    let nodes = await loaded();
    rotate(0);
    let processId = pid();
    let total = header(nodes);
    check(rowsTitled(...Object.values(titles)) === 0, '(a) this run\'s titles are not in the database yet');
    check(boots(processId) === 1, `(a) one host boot in process ${processId}`);
    await type(titles.a);
    await tapAdd();
    nodes = await waitFor('capture a', (current) => header(current) === total + 1 && draftText(current) === '');
    total += 1;
    check(hasText(await reveal(titles.a), titles.a) && rowsTitled(titles.a) === 1, '(a) captured task is listed and stored once');


    setProp('delay_before_ms', '5000');
    await type(titles.b);
    await tapAdd();
    check(busyField(await screen()), '(b) save is in flight');
    const recreatedBefore = recreations(processId).length;
    rotate(1);
    await waitFor('rotation recreation', () => recreations(processId).length > recreatedBefore, 15_000);
    check(recreations(processId).at(-1).includes('inFlight=true'), '(b) new Activity attached to the running host during the save');
    nodes = await waitFor('save b after rotation', (current) => header(current) === total + 1 && draftText(current) === '');
    total += 1;


    check(rowsTitled(titles.b) === 1, '(b) exactly one stored row for the capture');
    check(pid() === processId && boots(processId) === 1, '(b) same process, no second host boot');
    setProp('delay_before_ms', '');

    console.log(`info - (b) landscape shows ${taskRows(nodes).length} full task rows below the Process Inbox button`);
    const scrolled = await swipe(nodes, 'down');


    const list = scrolled.find((node) => node.scrollable === 'true');
    const tops = scrolled.filter((node) => /(^|\/)task-row$/.test(node['resource-id'] ?? '')).map((node) => box(node)[1]).sort((a, b) => a - b);
    const pitches = tops.slice(1).map((top, index) => top - tops[index]).sort((a, b) => a - b);
    const pitch = pitches[Math.floor(pitches.length / 2)];
    const rowsHeld = list && pitch ? (box(list)[3] - box(list)[1]) / pitch : 0;
    check(rowsHeld >= 3, `(b) the landscape list holds ${rowsHeld.toFixed(1)} task rows after one drag (at least 3)`);
    await toTop();
    rotate(0);
    await waitFor('rotation back', () => recreations(processId).length > recreatedBefore + 1, 15_000);
    await loaded();
    check(hasText(await reveal(titles.b), titles.b), '(b) the recreated Activity shows the saved task');


    setProp('delay_before_ms', '8000');
    await type(titles.c1);
    await tapAdd();
    check(busyField(await screen()), '(c1) save is in flight');
    requireAppFront();
    sh('input keyevent KEYCODE_HOME');
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    await sleep(1500);
    sh(`run-as ${PKG} kill -9 ${processId}`);
    await waitFor('process death', () => pid() !== processId, 10_000);
    setProp('delay_before_ms', '');
    check(rowsTitled(titles.c1) === 0, '(c1) no row before the retry (killed before commit)');
    const c1Id = owedCaptureId();
    launch();
    nodes = await loaded();
    processId = pid();
    check(boots(processId) === 1, '(c1) one host boot after process death');
    nodes = await waitFor('the relaunch to send the owed capture', (current) => header(current) === total + 1 && draftText(current) === '', 30_000);
    total += 1;
    check(rowsTitled(titles.c1) === 1 && rowsWithId(c1Id) === 1, `(c1) the relaunch sent the owed capture once: one row, and it is the task with the capture's ID ${c1Id}`);


    setProp('delay_after_ms', '20000');
    await type(titles.c2);
    await tapAdd();
    await waitFor('commit c2', () => rowsTitled(titles.c2) === 1, 6000);
    check(busyField(await screen()), '(c2) row committed while the acknowledgment is still pending');
    const c2Id = owedCaptureId();
    requireAppFront();
    sh('input keyevent KEYCODE_HOME');
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    await sleep(1500);
    sh(`run-as ${PKG} kill -9 ${processId}`);
    await waitFor('process death', () => pid() !== processId, 10_000);
    setProp('delay_after_ms', '');
    launch();
    nodes = await loaded();
    processId = pid();
    total += 1;
    check(boots(processId) === 1 && header(nodes) === total, '(c2) relaunch loads the committed row');

    nodes = await waitFor('the relaunch to settle the owed capture', (current) => draftText(current) === '' && !busyField(current), 30_000);
    check(header(nodes) === total && rowsTitled(titles.c2) === 1 && rowsWithId(c2Id) === 1, `(c2) the same-captureId re-send added no duplicate: one row, the task with ID ${c2Id}`);


    setProp('delay_after_ms', '20000');
    await type(titles.c3);
    await tapAdd();
    await waitFor('commit c3', () => rowsTitled(titles.c3) === 1, 6000);
    const c3Id = owedCaptureId();
    sh(`am force-stop ${PKG}`);
    setProp('delay_after_ms', '');
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    launch();
    nodes = await loaded();
    processId = pid();
    total += 1;
    check(boots(processId) === 1 && header(nodes) === total && hasText(await reveal(titles.c3), titles.c3), '(c3) committed row survives force-stop');

    nodes = await waitFor('the relaunch to settle the owed capture', (current) => draftText(current) === '' && !busyField(current), 30_000);

    nodes = await toTop();
    check(header(nodes) === total, `(c3) the Inbox count is ${total} (it shows ${header(nodes)})`);
    check(rowsTitled(titles.c3) === 1, `(c3) exactly one row titled ${titles.c3} (${rowsTitled(titles.c3)})`);
    check(rowsWithId(c3Id) === 1, `(c3) the row is the task with the capture's ID ${c3Id}`);
    check(draftText(nodes) === '', '(c3) no stale draft');


    setProp('fail_commit', '1');
    await type(titles.d);
    await tapAdd();
    nodes = await waitFor('save failure', hasError);
    const failedState = async (current, label) => {
        check(field(current)?.text === titles.d && field(current)?.enabled === 'false', `(d${label}) draft kept and locked`);
        current = await scrollToSave(current);
        check(button(current, 'Save')?.enabled === 'true', `(d${label}) exact retry allowed`);

        check(owedRetry(current)?.enabled === 'true' && !readRetry(current), `(d${label}) Try again is the capture's exact retry; no read refresh is offered`);

        const rows = taskRows(current);

        if (rows.length === 0 && label === ' after rotation') {
            check(Boolean(tagged(current, 'capture-scroll')), `(d${label}) the popup covers the list; no row is reachable`);
        } else {
            check(rows.length > 0 && rows.every((node) => node.enabled === 'false'), `(d${label}) rows locked`);
        }
    };
    await failedState(nodes, '');
    check(rowsTitled(titles.d) === 0, '(d) failed commit stored nothing');
    const recreatedBeforeFailure = recreations(processId).length;
    rotate(1);
    await waitFor('rotation recreation', () => recreations(processId).length > recreatedBeforeFailure, 15_000);
    nodes = await waitFor('failed state after rotation', hasError);
    await failedState(nodes, ' after rotation');
    rotate(0);
    await waitFor('rotation back', () => recreations(processId).length > recreatedBeforeFailure + 1, 15_000);


    for (let attempt = 0; attempt < 2 && front().includes(`${PKG}/`); attempt += 1) {
        sh('input keyevent KEYCODE_BACK');
        await sleep(1500);
    }
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    launch();
    nodes = await waitFor('failed state after Back and reopen', hasError);
    await failedState(nodes, ' after Back and reopen');


    const newScreensBefore = newScreens(processId);
    requireAppFront();
    sh(`am start -W -f 0x10008000 -n ${ACTIVITY}`);
    await waitFor('a new screen on the running host', () => newScreens(processId) > newScreensBefore, 15_000);
    nodes = await waitFor('failed state on the new screen', hasError);
    await failedState(nodes, ' on a new screen');
    check(pid() === processId && boots(processId) === 1 && rowsTitled(titles.d) === 0, '(d) same process and host, still no row');
    setProp('fail_commit', '');

    await device.tapExpecting(owedRetry(await screen()) ?? fail('no Try again for the owed capture'),
        (current) => !hasError(current), 'the retry from Try again');
    nodes = await waitFor('retry d', (current) => header(current) === total + 1 && draftText(current) === '');
    total += 1;
    check(!hasError(nodes) && taskRows(nodes).some((node) => node.enabled === 'true'),
        '(d) retry cleared the failure: rows work again');
    check(rowsTitled(titles.d) === 1 && boots(processId) === 1, '(d) exactly one row, still one host');


    requireAppFront();
    sh(`am force-stop ${PKG}`);
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    launch();
    nodes = await loaded();
    processId = pid();
    check(boots(processId) === 1 && !bootFailure(nodes), '(e) boot validation passed');
    check(header(nodes) === total, `(e) Inbox total is ${total}`);
    for (const [name, title] of Object.entries(titles)) check(rowsTitled(title) === 1, `(e) ${name} stored once`);
    console.log('Lifecycle device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    restore();
}
