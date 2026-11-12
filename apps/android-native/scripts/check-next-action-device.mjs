


import { execFileSync } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, check, connect, evidenced, fail, inboxCount, inEditor, linesAfter, logStamp, projectTitled, Stopped, switchOn, tab, tabSelected, tagged, taskRow, withDescription } from './device.mjs';
import { cleanupOnExit } from './check-net-device.mjs';
import { serveWebdav, webdavDocument } from './sync-harness.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-next-action-device.mjs <adb-serial> [apk]');
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
const work = resolve(app, 'android/build/next-action-check');
const shots = process.env.MINDWTR_SHOTS ?? work;
const { en } = await import(resolve(repo, 'packages/core/src/i18n/locales/en.ts'));

const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const PORT = Number(process.env.MINDWTR_NEXT_ACTION_WEBDAV_PORT ?? 18784);
const FOLDER = `/dav/mindwtr-next-action-${run}`;
const USER = `native${run}`;
const PASSWORD = `pw${run}secret`;
const PROJECT = { id: randomUUID(), title: `NA ${run}` };
const NEXT = { id: randomUUID(), title: `Next ${run}`, status: 'next' };
const WAITS = { id: randomUUID(), title: `Waits ${run}`, status: 'waiting' };
const LATER = { id: randomUUID(), title: `Later ${run}`, status: 'someday' };

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, requireAppFront, screen, waitFor, tap, tapExpecting } = device;
const runAs = (command) => sh(`run-as ${PKG} sh -c '${command}'`);
const allLogs = () => execFileSync(adbBin, ['-s', serial, 'logcat', '-d', '-s', `${TAG}:*`], { encoding: 'utf8', maxBuffer: 64 << 20 }).replace(/\\/g, '');
const pullDb = () => {
    const dir = resolve(work, 'db');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = runAs('ls files 2>/dev/null || true').split(/\s+/);
    for (const suffix of ['', '-wal', '-journal']) if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    return resolve(dir, DB);
};
const sqlite = (sql) => {
    const out = execFileSync('sqlite3', ['-json', pullDb(), sql], { encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
    return out ? JSON.parse(out) : [];
};

const projectTasks = () => Object.fromEntries(sqlite(`SELECT title, status FROM tasks WHERE projectId = '${PROJECT.id}' AND deletedAt IS NULL`)
    .map((row) => [row.title, row.status]));
const projectStatus = () => sqlite(`SELECT status FROM projects WHERE id = '${PROJECT.id}'`)[0]?.status;
const until = async (description, holds, timeoutMs = 60_000, everyMs = 1_500) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await holds();
        if (value) return value;
        if (Date.now() > deadline) fail(`timed out waiting for ${description}`);
        await sleep(everyMs);
    }
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
const prompted = (nodes) => Boolean(tagged(nodes, 'next-action-prompt'));
const toTabs = async () => {
    for (let step = 0; step < 8; step += 1) {
        const nodes = await screen();
        if (tab(nodes, en['tab.menu']) && !tagged(nodes, 'menu-screen') && !sheetOpen(nodes) && !inEditor(nodes) && !tagged(nodes, 'quick-capture')
            && !prompted(nodes) && !projectTitled(nodes, PROJECT.title)) return nodes;
        await hideKeyboard();
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(1000);
    }
    return fail('the tabs did not come back');
};
const reveal = (find, description) => device.revealNode(find, description);
const onSync = (nodes) => Boolean(tagged(nodes, 'settings-sync'));
const openSync = async () => {
    const nodes = await screen();
    if (onSync(nodes)) return nodes;
    let current = await toTabs();
    current = await tapExpecting(tab(current, en['tab.menu']) ?? fail('no Menu tab'), sheetOpen, 'the More sheet');
    await tapExpecting(withDescription(await device.settle(current), en['nav.settings']) ?? fail('no Settings tile'),
        (next) => Boolean(tagged(next, 'settings-main')), 'Settings');
    return tapExpecting(await reveal((next) => withPrefix(next, `${en['settings.sync']}. `), 'Sync row'), onSync, 'Settings › Sync', 30_000);
};
const fill = async (tag, text) => {
    await tap(await reveal((current) => tagged(current, tag), tag));
    await sleep(300);
    requireAppFront();
    sh('input keycombination KEYCODE_CTRL_LEFT KEYCODE_A');
    sh('input keyevent KEYCODE_DEL');
    sh(`input text '${text.replace(/ /g, '%s')}'`);
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


const inProject = (nodes) => projectTitled(nodes, PROJECT.title) && !inEditor(nodes);
const openProject = async () => {
    let nodes = await device.projectsTab(toTabs);
    nodes = await tapExpecting(tab(nodes, 'Projects'), (next) => tabSelected(next, 'Projects'), 'the Projects tab');
    const row = await reveal((current) => current.find((node) => node.text === PROJECT.title), `the project ${PROJECT.title}`);
    return tapExpecting(row, inProject, `the project ${PROJECT.title}`, 30_000);
};

const doneUntilPrompt = async (title) => {
    await reveal((current) => taskRow(current, title), `the row ${title}`);
    await device.swipeDone(await screen(), title);
    return waitFor(`the prompt after ${title}'s Done`, prompted, 20_000);
};

const candidate = (nodes, title) => {
    const card = tagged(nodes, 'next-action-prompt');
    if (!card) return undefined;
    const [l, t, r, b] = box(card);
    return nodes.find((node) => node.text === title && (([x1, y1, x2, y2]) => x1 >= l && y1 >= t && x2 <= r && y2 <= b)(box(node)));
};
const shoot = (name) => {
    mkdirSync(shots, { recursive: true });
    writeFileSync(resolve(shots, `next-action-${name}.png`), device.adbRaw('exec-out', 'screencap', '-p'));
    console.log(`shot - ${resolve(shots, `next-action-${name}.png`)}`);
};
const typeTitle = async (text) => {
    await tap(tagged(await screen(), 'next-action-input') ?? fail('no next action field'));
    await sleep(300);
    sh(`input text '${text.replace(/ /g, '%s')}'`);
    await waitFor(`"${text}" in the field`, (nodes) => tagged(nodes, 'next-action-input')?.text === text, 10_000);
    await hideKeyboardKeepingPrompt();
};

const hideKeyboardKeepingPrompt = async () => {
    if (!/mInputShown=true/.test(sh('dumpsys input_method'))) return;
    sh('input keyevent KEYCODE_ESCAPE');
    await sleep(600);
};

let dav = null;
let syncSet = false;
const originalNight = /Night mode: (\w+)/.exec(sh('cmd uimode night'))?.[1] ?? 'auto';
const originalAccelerometer = sh('settings get system accelerometer_rotation');
const cleanup = cleanupOnExit([
    () => execFileSync(adbBin, ['-s', serial, 'reverse', '--remove', `tcp:${PORT}`], { stdio: 'ignore' }),
    () => { void dav?.close(); },
    () => sh(`cmd uimode night ${['yes', 'no', 'auto'].includes(originalNight) ? originalNight : 'auto'}`),
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
    sh('cmd uimode night no');
    dav = await serveWebdav({ port: PORT, username: USER, password: PASSWORD });
    execFileSync(adbBin, ['-s', serial, 'reverse', `tcp:${PORT}`, `tcp:${PORT}`], { stdio: 'inherit' });
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    sh('logcat -c');
    await waitFor('home screen', () => front().includes(`${home}/`) || front().includes(`${PKG}/`), 10_000);
    device.launch(ACTIVITY);
    await waitFor('the Inbox', onInbox, 90_000);


    let nodes = await openSync();
    if (!nodes.some((node) => node.text === en['settings.syncOff'])) {
        await tapTag('sync-backend-off', (next) => next.some((node) => node.text === en['settings.syncOff']), 'Sync off');
    }
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
    const now = new Date().toISOString();
    const stamp = { createdAt: now, updatedAt: now, rev: 1, revBy: `next-action-check-${run}` };
    document.projects = [...(document.projects ?? []), { id: PROJECT.id, title: PROJECT.title, status: 'active', color: '#94a3b8',
        order: -1000, tagIds: [], ...stamp }];
    document.tasks = [...(document.tasks ?? []), ...[NEXT, WAITS, LATER].map((row) => ({ id: row.id, title: row.title, status: row.status,
        projectId: PROJECT.id, tags: [], contexts: [], ...stamp }))];
    dav.state.files.set(`${FOLDER}/data.json`, { body: Buffer.from(JSON.stringify(document)), etag: `"next-action-${run}"` });
    since = logStamp(allLogs());
    await tapTag('sync-now', () => commands('syncNow', since) > 0, 'Sync now', 240_000);
    await until('the project on the phone', () => Object.keys(projectTasks()).length === 3);


    await openProject();
    nodes = await doneUntilPrompt(NEXT.title);
    check(nodes.some((node) => node.text === en['projects.nextActionPromptTitle'])
        && nodes.some((node) => node.text === `Choose or add the next action for ${PROJECT.title}.`),
        '(1) the last Next task\'s Done shows RN\'s prompt with the project in its description');
    check(Boolean(candidate(nodes, WAITS.title)) && Boolean(candidate(nodes, LATER.title)) && Boolean(tagged(nodes, 'next-action-complete-project')),
        '(1) both other tasks are offered, with Complete project');
    shoot('light');
    sh('cmd uimode night yes');
    await sleep(2_500);
    nodes = await waitFor('the prompt in dark mode', prompted, 15_000);
    shoot('dark');
    sh('cmd uimode night no');
    await sleep(2_500);
    nodes = await waitFor('the prompt in light mode again', prompted, 15_000);
    await tapExpecting(candidate(nodes, WAITS.title) ?? fail('no Waiting candidate'), (next) => !prompted(next), 'Choose the Waiting task');
    await until('the Waiting task Next', () => projectTasks()[WAITS.title] === 'next');
    check(true, '(1) Choose made the Waiting task Next and closed the prompt');


    nodes = await doneUntilPrompt(WAITS.title);
    const before = JSON.stringify(projectTasks());
    await tapExpecting(tagged(nodes, 'next-action-skip') ?? fail('no Skip'), (next) => !prompted(next), 'Skip');
    check(JSON.stringify(projectTasks()) === before, '(2) Skip closed the prompt and wrote nothing');

    await reveal((current) => taskRow(current, LATER.title), `the row ${LATER.title}`);
    await tap(await device.revealAction(await screen(), LATER.title, 'organize'));
    const nextItem = (current) => {
        const header = current.find((node) => node.text === en['taskStatus.changeStatus']);
        return header && current.find((node) => node.text === en['status.next'] && node.class !== 'android.widget.EditText' && box(node)[1] > box(header)[1]);
    };
    await tap(nextItem(await waitFor('the status menu', (current) => Boolean(nextItem(current)), 10_000)));
    await until('the Someday task Next', () => projectTasks()[LATER.title] === 'next');
    check(!prompted(await screen()), '(2) the Someday row\'s tray Organize, then Next, shows no prompt');
    nodes = await doneUntilPrompt(LATER.title);
    check(!tagged(nodes, 'next-action-candidate'), '(2) that task\'s Done asks again, with no task to choose');
    const typed = `Typed ${run}`;
    await typeTitle(`${typed} /waiting`);
    nodes = await screen();
    await tapExpecting(tagged(nodes, 'next-action-add') ?? fail('no Add next action'), (next) => !prompted(next), 'Add next action', 30_000);
    await until(`"${typed}" Waiting in the project`, () => projectTasks()[typed] === 'waiting');
    check(true, `(2) Add next action made "${typed}" a Waiting task in the project (the quick-add grammar)`);


    nodes = await doneUntilPrompt(typed);
    const edit = `Edit ${run}`;
    await typeTitle(edit);
    await tapExpecting(tagged(await screen(), 'next-action-save-edit') ?? fail('no Save & edit'), inEditor, 'Save & edit', 30_000);
    check(projectTasks()[edit] === 'next', `(3) Save & edit made "${edit}" a Next task and opened it in the editor`);
    await toTabs();


    await openProject();
    await doneUntilPrompt(edit);
    await tapExpecting(tagged(await screen(), 'next-action-complete-project') ?? fail('no Complete project'), (next) => !prompted(next), 'Complete project', 30_000);
    await until('the project archived', () => projectStatus() === 'archived');
    check(true, '(4) Complete project archived the project');
    console.log('DEVICE_RESULT pass');
} catch (error) {
    if (!(error instanceof Stopped)) evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    if (dav) dav.state.down = false;
    try {
        if (syncSet) {
            if (!front().includes(`${PKG}/`)) device.launch(ACTIVITY);
            await syncOff();
        }
    } catch (error) { console.log(`warn - Sync could not be set Off: ${error.message}`); }
    cleanup();
    await sleep(500);
    process.exit(process.exitCode ?? 0);
}
