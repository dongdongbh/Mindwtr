


import { execFileSync } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { check, connect, evidenced, fail, inboxCount, inEditor, isOn, linesAfter, logStamp, Stopped, switchOn, tab, tabSelected, tagged, taskRow, withDescription } from './device.mjs';
import { cleanupOnExit } from './check-net-device.mjs';
import { serveWebdav, webdavDocument } from './sync-harness.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-archive-retention-device.mjs <adb-serial> [apk]');
    process.exit(2);
}
const app = resolve(import.meta.dirname, '..');
const repo = resolve(app, '../..');
const apk = apkArg ?? resolve(app, 'android/app/build/outputs/apk/play/debug/app-play-debug.apk');
const adbBin = process.env.ADB ?? '/opt/android-sdk/platform-tools/adb';
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
const DB = 'mindwtr-native-dev.db';
const work = resolve(app, 'android/build/archive-retention-check');
const { en } = await import(resolve(repo, 'packages/core/src/i18n/locales/en.ts'));

const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const PORT = Number(process.env.MINDWTR_RETENTION_WEBDAV_PORT ?? 18783);
const FOLDER = `/dav/mindwtr-retention-${run}`;
const USER = `native${run}`;
const PASSWORD = `pw${run}secret`;
const DAYS = 7000;
const DAY = 24 * 60 * 60 * 1000;
const OLD = { id: randomUUID(), title: `Retention old ${run}`, days: 7300 };
const RECENT = { id: randomUUID(), title: `Retention recent ${run}`, days: 5 };
const OPEN = { id: randomUUID(), title: `Retention open ${run}` };

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, adbRaw, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting } = device;
const runAs = (command) => sh(`run-as ${PKG} sh -c '${command}'`);
const allLogs = () => execFileSync(adbBin, ['-s', serial, 'logcat', '-d', '-s', `${TAG}:*`], { encoding: 'utf8', maxBuffer: 64 << 20 }).replace(/\\/g, '');
const RAN = 'Native archive retention ran';

const ran = (since, ...needles) => linesAfter(allLogs(), since).filter((line) => line.includes(RAN) && needles.every((needle) => line.includes(needle)));

const pullDb = () => {
    const dir = resolve(work, 'db');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = runAs('ls files 2>/dev/null || true').split(/\s+/);
    for (const suffix of ['', '-wal', '-journal']) if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    return resolve(dir, DB);
};

const seeded = () => {
    const out = execFileSync('sqlite3', ['-json', pullDb(), `SELECT id, status, deletedAt, purgedAt FROM tasks WHERE id IN ('${OLD.id}', '${RECENT.id}')`],
        { encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
    return Object.fromEntries((out ? JSON.parse(out) : []).map((row) => [row.id, row]));
};
const live = (row) => Boolean(row) && !row.deletedAt && !row.purgedAt;
const until = async (description, holds, timeoutMs = 120_000, everyMs = 2_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await holds();
        if (value) return value;
        if (Date.now() > deadline) fail(`timed out waiting for ${description}`);
        await sleep(everyMs);
    }
};

const killApp = async () => {
    if (front().includes(`${PKG}/`)) sh('input keyevent KEYCODE_HOME');
    for (let attempt = 0; attempt < 20 && pid(); attempt += 1) {
        try { runAs(`kill -9 ${pid()}`); } catch {                      }
        await sleep(500);
    }
    if (pid()) fail('the app process did not end');
};

const leaveAndReturn = async () => {
    sh('input keyevent KEYCODE_HOME');
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    await sleep(1_500);
    device.launch(ACTIVITY);
    await waitFor('the app in front again', () => front().includes(`${PKG}/`), 30_000);
};


const sheetOpen = (nodes) => Boolean(tagged(nodes, 'more-sheet'));
const onInbox = (nodes) => !tagged(nodes, 'quick-capture') && !tagged(nodes, 'menu-screen') && !tagged(nodes, 'global-search') && !inEditor(nodes)
    && tabSelected(nodes, en['tab.inbox']) && Number.isFinite(inboxCount(nodes));
const withPrefix = (nodes, prefix) => nodes.find((node) => (node['content-desc'] ?? '').startsWith(prefix));
const hideKeyboard = async () => {
    if (!/mInputShown=true/.test(sh('dumpsys input_method'))) return;
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await sleep(600);
};
const toTabs = async () => {
    for (let step = 0; step < 8; step += 1) {
        const nodes = await screen();
        if (tab(nodes, en['tab.menu']) && !tagged(nodes, 'menu-screen') && !sheetOpen(nodes) && !inEditor(nodes) && !tagged(nodes, 'quick-capture')) return nodes;
        await hideKeyboard();
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(1000);
    }
    return fail('the tabs did not come back');
};
const reveal = (find, description) => device.revealNode(find, description);
const openSettingsRow = async (label, arrived, what) => {
    const nodes = await screen();
    if (arrived(nodes)) return nodes;
    let current = await toTabs();
    current = await tapExpecting(tab(current, en['tab.menu']) ?? fail('no Menu tab'), sheetOpen, 'the More sheet');
    await tapExpecting(withDescription(await device.settle(current), en['nav.settings']) ?? fail('no Settings tile'),
        (next) => Boolean(tagged(next, 'settings-main')), 'Settings');
    return tapExpecting(await reveal((next) => withPrefix(next, `${label}. `), `${what} row`), arrived, `Settings › ${what}`, 30_000);
};
const onSync = (nodes) => Boolean(tagged(nodes, 'settings-sync'));
const onData = (nodes) => Boolean(tagged(nodes, 'settings-data'));
const openSync = () => openSettingsRow(en['settings.sync'], onSync, 'Sync');
const openData = () => openSettingsRow(en['settings.data'], onData, 'Data');
const fill = async (tag, text) => {
    await tap(await reveal((current) => tagged(current, tag), tag));
    await sleep(300);
    requireAppFront();
    sh('input keycombination KEYCODE_CTRL_LEFT KEYCODE_A');
    sh('input keyevent KEYCODE_DEL');
    sh(`input text '${text}'`);
    await sleep(500);
};
const tapTag = async (tag, expected, description, timeoutMs = 30_000) => {
    await hideKeyboard();
    return tapExpecting(await reveal((current) => tagged(current, tag), tag), expected, description, timeoutMs);
};
const commands = (operation, since) => linesAfter(allLogs(), since)
    .filter((line) => line.includes(`"operation":"${operation}"`) && line.includes('"outcome":"saved"')).length;
const syncOff = async () => {
    const nodes = await openSync();
    if (!nodes.some((node) => node.text === en['settings.syncOff'])) {
        await tapTag('sync-backend-off', (current) => current.some((node) => node.text === en['settings.syncOff']), 'Sync off');
    }
};
const current = (days) => `${en['settings.archiveRetentionCurrent']}: ${days > 0 ? en['settings.archiveRetentionDays'].replace('{days}', String(days)) : en['settings.archiveRetentionNever']}`;
const setNever = async () => {
    const nodes = await openData();
    await reveal((next) => tagged(next, 'archive-retention-never'), 'Never');
    if (nodes.some((node) => node.text === current(0)) || (await screen()).some((node) => node.text === current(0))) return;
    await tapTag('archive-retention-never', (next) => next.some((node) => node.text === current(0)), 'Archive retention Never');
};

let dav = null;
let applied = false;
let syncSet = false;

const restore = async () => {
    if (dav) dav.state.down = false;
    if ((applied || syncSet) && !front().includes(`${PKG}/`)) device.launch(ACTIVITY);
    try { if (applied) await setNever(); } catch (error) { console.log(`warn - Archive retention could not be set to Never: ${error.message}`); }
    try { if (syncSet) await syncOff(); } catch (error) { console.log(`warn - Sync could not be set Off: ${error.message}`); }
};
class Refused extends Error {}
const originalAccelerometer = sh('settings get system accelerometer_rotation');
const cleanup = cleanupOnExit([
    () => execFileSync(adbBin, ['-s', serial, 'reverse', '--remove', `tcp:${PORT}`], { stdio: 'ignore' }),
    () => { void dav?.close(); },
    () => sh(`rm -f ${UI_FILE}`),
    () => { if (front().includes(`${PKG}/`)) sh('input keyevent KEYCODE_HOME'); },
    () => sh(`settings put system accelerometer_rotation ${originalAccelerometer === 'null' ? 1 : originalAccelerometer}`),
]);

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}\nrun: ${run}`);
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    dav = await serveWebdav({ port: PORT, username: USER, password: PASSWORD });
    execFileSync(adbBin, ['-s', serial, 'reverse', `tcp:${PORT}`, `tcp:${PORT}`], { stdio: 'inherit' });
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    sh('logcat -c');
    await waitFor('home screen', () => front().includes(`${home}/`) || front().includes(`${PKG}/`), 10_000);
    device.launch(ACTIVITY);
    await waitFor('the Inbox', onInbox, 90_000);


    let nodes = await openSync();
    if (!nodes.some((node) => node.text === en['settings.syncOff'])) {
        nodes = await tapTag('sync-backend-off', (next) => next.some((node) => node.text === en['settings.syncOff']), 'Sync off');
    }
    writeFileSync(resolve(work, 'sync-backend-selected.png'), adbRaw('exec-out', 'screencap', '-p'));
    check(isOn(tagged(nodes, 'sync-backend-off')) && ['dropbox', 'file', 'webdav', 'selfhosted'].every((name) => !isOn(tagged(nodes, `sync-backend-${name}`))),
        'Sync off is the one chosen backend, drawn with RN\'s 2 px outline and check (#1494, sync-backend-selected.png)');
    await tapTag('sync-backend-webdav', (next) => Boolean(tagged(next, 'sync-url')), 'the WebDAV form');
    syncSet = true;
    await fill('sync-url', `http://127.0.0.1:${PORT}${FOLDER}`);
    const label = en['settings.allowInsecureHttp'];
    await hideKeyboard();
    const insecure = await reveal((next) => withDescription(next, label), 'Allow insecure HTTP');
    if (!switchOn(await screen(), label)) await tapExpecting(insecure, (next) => switchOn(next, label), 'insecure HTTP on');
    await fill('sync-username', USER);
    await fill('sync-password', PASSWORD);
    let since = logStamp(allLogs());

    await tapTag('sync-save', () => commands('saveSyncBackend', since) > 0, 'Save', 240_000);
    const document = await until('the phone\'s data in the WebDAV folder', () => webdavDocument(dav, FOLDER), 60_000);
    const path = `${FOLDER}/data.json`;
    const stamp = (days) => new Date(Date.now() - days * DAY).toISOString();
    const task = ({ id, title, days }) => ({ id, title, status: 'archived', tags: [], contexts: [], createdAt: stamp(days), updatedAt: stamp(days),
        archivedAt: stamp(days), completedAt: stamp(days), rev: 1, revBy: `retention-check-${run}` });
    document.tasks = [...(document.tasks ?? []), task(OLD), task(RECENT),
        { id: OPEN.id, title: OPEN.title, status: 'inbox', tags: [], contexts: [], createdAt: stamp(0), updatedAt: stamp(0), rev: 1, revBy: `retention-check-${run}` }];
    dav.state.files.set(path, { body: Buffer.from(JSON.stringify(document)), etag: `"retention-${run}"` });
    since = logStamp(allLogs());
    await tapTag('sync-now', () => commands('syncNow', since) > 0, 'Sync now', 240_000);
    let rows = await until('both seeded tasks on the phone', () => { const found = seeded(); return live(found[OLD.id]) && live(found[RECENT.id]) && found; }, 60_000);
    check(rows[OLD.id].status === 'archived' && rows[RECENT.id].status === 'archived', '(1) Sync now brought both archived tasks to the phone');


    await openData();
    await fill('archive-retention-days', String(DAYS));
    await hideKeyboard();
    nodes = await tapTag('archive-retention-save', (next) => Boolean(tagged(next, 'archive-retention-review')), 'Save and its review', 60_000);

    const seededLine = new RegExp(`^${en['calendar.tasks']}: Retention old \\d+$`);
    const ownLines = nodes.filter((node) => seededLine.test(node.text ?? '')).length;
    const counts = en['settings.archiveRetentionCounts'].replace('{tasks}', String(ownLines)).replace('{projects}', '0').replace('{sections}', '0');
    if (!nodes.some((node) => node.text === counts) || !nodes.some((node) => node.text === `${en['calendar.tasks']}: ${OLD.title}`)) {
        await tapExpecting(tagged(nodes, 'archive-retention-cancel') ?? fail('no Cancel'), (next) => !tagged(next, 'archive-retention-review'), 'Cancel');
        throw new Refused(`the review lists more than this check's seeded tasks (expected "${counts}"); nothing applied, so no other item is removed`);
    }
    check(true, `(2) Save shows RN's review: "${counts}" and the seeded task`);

    await tapExpecting(tagged(nodes, 'archive-retention-apply') ?? fail('no Apply retention'), (next) => next.some((node) => node.text === current(DAYS)), 'Apply retention', 30_000);
    applied = true;
    check(live(seeded()[OLD.id]), `(2) Apply stores ${DAYS} days and removes nothing by itself`);


    dav.state.down = true;
    await killApp();
    since = logStamp(allLogs());
    device.launch(ACTIVITY);
    await waitFor('the Inbox', onInbox, 90_000);
    await until('the start\'s run', () => ran(since, '"skipped":"waiting-for-sync"').length > 0, 60_000);
    check(live(seeded()[OLD.id]), '(3) with no sync this session, the start\'s run logged skipped=waiting-for-sync and removed nothing');


    dav.state.down = false;
    nodes = await toTabs();
    const row = taskRow(nodes, OPEN.title) ?? (await device.revealNode((current) => taskRow(current, OPEN.title), `the seeded Inbox task ${OPEN.title}`));
    await tapExpecting(row, inEditor, 'a task editor');
    since = logStamp(allLogs());
    await leaveAndReturn();
    await until('the return\'s run with the editor open', () => ran(since, '"skipped":"editor-open"').length > 0, 60_000);
    check(inEditor(await screen()) && live(seeded()[OLD.id]), '(4) with an editor open, the return\'s run logged skipped=editor-open and removed nothing');


    await toTabs();
    since = logStamp(allLogs());
    for (let attempt = 0; attempt < 4 && ran(since, '"outcome":"purged"').length === 0; attempt += 1) {
        await leaveAndReturn();
        for (let wait = 0; wait < 15 && ran(since, '"outcome":"purged"').length === 0; wait += 1) await sleep(2_000);
    }
    const purged = ran(since, '"outcome":"purged"');
    check(purged.length === 1 && purged[0].includes(`"taskCount":${ownLines}`), `(5) a return after this session synced logged outcome=purged taskCount=${ownLines} (${purged.length} lines)`);
    rows = seeded();
    check(Boolean(rows[OLD.id]?.purgedAt), `(5) the task archived ${OLD.days} days ago is purged on the phone`);
    check(live(rows[RECENT.id]), `(5) the task archived ${RECENT.days} days ago stays`);
    console.log('DEVICE_RESULT pass');
} catch (error) {
    try {
        console.log(`evidence - app log (retention):\n${allLogs().split('\n').filter((line) => /archive retention|Core action|sync started/i.test(line))
            .slice(-40).map((line) => line.slice(0, 300)).join('\n')}`);
    } catch {                         }
    if (!(error instanceof Refused)) evidenced(error);
    console.error(error instanceof Refused ? `REFUSED: ${error.message}` : error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Refused ? 2 : error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
    cleanup();
    await sleep(500);
    process.exit(process.exitCode ?? 0);
}
