


import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, button, check, connect, evidenced, fail, inboxCount, inEditor, linesAfter, logStamp, Stopped, switchOn, tab, tabSelected, tagged, taskRow, withDescription } from './device.mjs';
import { cleanupOnExit } from './check-net-device.mjs';
import { hostDevice, serveWebdav, startCloud, webdavDocument } from './sync-harness.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-sync-device.mjs <adb-serial> [apk]');
    process.exit(2);
}
const app = resolve(import.meta.dirname, '..');
const repo = resolve(app, '../..');
const apk = apkArg ?? resolve(app, 'android/app/build/outputs/apk/play/debug/app-play-debug.apk');
const bundle = resolve(app, 'android/app/src/main/assets/core-host.js');
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
const DB = 'mindwtr-native-dev.db';
const work = resolve(app, 'android/build/sync-check');
const { en } = await import(resolve(repo, 'packages/core/src/i18n/locales/en.ts'));


const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const WEBDAV_PORT = Number(process.env.MINDWTR_SYNC_WEBDAV_PORT ?? 18771);
const CLOUD_PORT = Number(process.env.MINDWTR_SYNC_CLOUD_PORT ?? 18772);
const FOLDER = `/dav/mindwtr-check-${run}`;
const USER = `native${run}`;
const PASSWORD = `pw${run}secret`;
const TOKEN = `nativesynccheck${run}token`;
const webdavFields = { url: `http://127.0.0.1:${WEBDAV_PORT}${FOLDER}`, username: USER, password: PASSWORD, allowInsecureHttp: true };
const cloudFields = { url: `http://127.0.0.1:${CLOUD_PORT}`, token: TOKEN, allowInsecureHttp: true };
const titles = {
    host: `Sync ✓ Grüße 😀 ${run}`,
    phone: `93${run}1`,
    down: `93${run}2`,
    failed: `93${run}3`,
    cloudHost: `Cloud ✓ 雲 😀 ${run}`,
    offline: `93${run}4`,
    midSync: `93${run}5`,
    killed: `93${run}6`,
};

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting } = device;
const logs = () => device.logs(pid(), TAG);


const pullFile = (remote, name) => {
    const dir = resolve(work, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const base = remote.split('/').pop();
    const folder = remote.slice(0, remote.length - base.length - 1);
    const present = sh(`run-as ${PKG} ls ${folder}`).split(/\s+/);
    for (const suffix of ['', '-wal', '-shm', '-journal']) if (present.includes(`${base}${suffix}`)) device.pull(`${remote}${suffix}`, resolve(dir, `${base}${suffix}`));
    return resolve(dir, base);
};
const sqlite = (file, sql) => {
    const out = execFileSync('sqlite3', ['-json', file, sql], { encoding: 'utf8' }).trim();
    return out ? JSON.parse(out) : [];
};

const phoneTasks = () => Object.fromEntries(sqlite(pullFile(`files/${DB}`, 'db'), 'SELECT title, status FROM tasks WHERE deletedAt IS NULL').map((row) => [row.title, row.status]));

const rkStorage = () => {
    const file = pullFile('databases/RKStorage', 'rk');
    return {
        keys: Object.fromEntries(sqlite(file, 'SELECT key, value FROM catalystLocalStorage').map((row) => [row.key, row.value])),
        version: sqlite(file, 'PRAGMA user_version')[0].user_version,
        schema: sqlite(file, "SELECT sql FROM sqlite_master WHERE name = 'catalystLocalStorage'")[0]?.sql ?? '',
    };
};

const plaintextHolders = () => sh(`run-as ${PKG} sh -c 'cd files && ls -R journal logs 2>/dev/null; cd ../shared_prefs && ls'`);
const grepApp = (text) => sh(`run-as ${PKG} sh -c "grep -rl '${text}' files databases shared_prefs 2>/dev/null || true"`).split(/\s+/).filter(Boolean);


const inPopup = (nodes) => Boolean(tagged(nodes, 'quick-capture'));
const sheetOpen = (nodes) => Boolean(tagged(nodes, 'more-sheet'));
const onSync = (nodes) => Boolean(tagged(nodes, 'settings-sync'));
const onInbox = (nodes) => !inPopup(nodes) && !tagged(nodes, 'menu-screen') && !tagged(nodes, 'global-search') && !inEditor(nodes)
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
        if (tab(nodes, en['tab.menu']) && !tagged(nodes, 'menu-screen') && !sheetOpen(nodes) && !inEditor(nodes) && !inPopup(nodes)) return nodes;
        await hideKeyboard();
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(1000);
    }
    return fail('the tabs did not come back');
};
const toInbox = async () => {
    let nodes = await toTabs();
    if (!tabSelected(nodes, en['tab.inbox'])) {
        nodes = await tapExpecting(tab(nodes, en['tab.inbox']), (current) => tabSelected(current, en['tab.inbox']), 'the Inbox');
    }

    if (!onInbox(nodes)) await device.toTop();
    return waitFor('the Inbox', onInbox, 30_000);
};

const reveal = (find, description) => device.revealNode(find, description);

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
    const node = await reveal((current) => tagged(current, tag), tag);
    await tap(node);
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

const statusLine = async () => {
    const status = (await reveal((current) => tagged(current, 'sync-status'), 'the Last sync status')).text ?? '';
    const error = status.endsWith(en['settings.syncStatusFailedSuffix'])
        ? (await reveal((current) => tagged(current, 'sync-error'), 'the failure line')).text ?? null : null;
    return { status, error };
};

const insecureOn = async () => {
    const label = en['settings.allowInsecureHttp'];
    await hideKeyboard();
    const node = await reveal((current) => withDescription(current, label), 'Allow insecure HTTP');
    if (!switchOn(await screen(), label)) await tapExpecting(node, (current) => switchOn(current, label), 'insecure HTTP on');
};

const capture = async (text) => {
    await toInbox();
    const nodes = await device.openCapture();
    await device.focusAtEnd(tagged(nodes, 'capture-title') ?? fail('no capture field'));
    requireAppFront();
    sh(`input text '${text}'`);
    await waitFor(`"${text}" in the capture field`, (current) => tagged(current, 'capture-title')?.text === text, 15_000);
    await tapExpecting(button(await screen(), en['common.save']) ?? fail('no Save'), onInbox, 'the capture to close the popup');
};

const until = async (description, holds, timeoutMs = 120_000, everyMs = 2_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await holds()) return;
        if (Date.now() > deadline) fail(`timed out waiting for ${description}`);
        await sleep(everyMs);
    }
};


const commands = (operation, outcome = 'saved', since = '') => linesAfter(logs().replace(/\\/g, ''), since)
    .filter((line) => line.includes(`"operation":"${operation}"`) && line.includes(`"outcome":"${outcome}"`)).length;
const stamp = () => logStamp(logs());


const runCommand = async (tag, operation, description, toast, timeoutMs = 240_000) => {
    const since = stamp();
    let seen = false;
    await tapTag(tag, (current) => {
        seen ||= Boolean(toast) && current.some((node) => node.text === toast);
        return commands(operation, 'saved', since) > 0;
    }, description, timeoutMs);
    if (toast) {
        const nodes = await screen();
        seen ||= nodes.some((node) => node.text === toast);
        console.log(`info - ${description}: the toast "${toast}" ${seen ? 'showed' : 'was not caught on screen (3.2 s)'}`);
    }
};

const toastsOf = (operation) => [...logs().matchAll(new RegExp(`Native Android sync screen command=${operation} toasts=(\\S+(?: \\S+)*)`, 'g'))]
    .map((match) => match[1].split('|').at(-1));

const menuDotIsRed = async () => {
    const nodes = await toTabs();
    const [l, t, r, b] = box(tab(nodes, en['tab.menu']) ?? fail('no Menu tab'));
    const file = resolve(work, 'menu-dot.png');
    mkdirSync(work, { recursive: true });
    writeFileSync(file, device.adbRaw('exec-out', 'screencap', '-p'));
    const histogram = execFileSync('magick', [file, '-crop', `${r - l}x${Math.round((b - t) / 2)}+${l}+${t}`, '+repage', '-format', '%c', 'histogram:info:-'], { encoding: 'utf8' });

    return [...histogram.matchAll(/(\d+):\s*\(\s*(\d+),\s*(\d+),\s*(\d+)/g)].some(([, count, red, green, blue]) => Number(count) >= 6 && Number(red) > 200 && Number(green) < 120 && Number(blue) < 120);
};

const badge = () => [...logs().matchAll(/Native Android sync state badge=(\w+) cycles=(\d+)/g)].at(-1)?.slice(1) ?? [null, null];

let dav = null;
let cloud = null;
let second = null;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);

const storedCount = (title) => sqlite(pullFile(`files/${DB}`, 'db'), `SELECT COUNT(*) AS n FROM tasks WHERE deletedAt IS NULL AND title = '${title}'`)[0].n;
const cleanup = cleanupOnExit([
    () => setProp('journal_stop', ''),
    () => execFileSync(adbBin, ['-s', serial, 'reverse', '--remove', `tcp:${WEBDAV_PORT}`], { stdio: 'ignore' }),
    () => execFileSync(adbBin, ['-s', serial, 'reverse', '--remove', `tcp:${CLOUD_PORT}`], { stdio: 'ignore' }),
    () => { void dav?.close(); },
    () => { cloud?.child.kill('SIGTERM'); },
    () => second?.stop(),
    () => sh(`rm -f ${UI_FILE}`),
]);

try {
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')}) / locale ${sh('getprop persist.sys.locale')}`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}\nrun: ${run}`);
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    dav = await serveWebdav({ port: WEBDAV_PORT, username: USER, password: PASSWORD });
    cloud = await startCloud({ repo, port: CLOUD_PORT, token: TOKEN, dataDir: resolve(work, `cloud-${run}`) });
    for (const port of [WEBDAV_PORT, CLOUD_PORT]) execFileSync(adbBin, ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`], { stdio: 'inherit' });
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    await device.stopApp();
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    device.launch(ACTIVITY);
    await waitFor('the Inbox', onInbox, 60_000);
    await until('the app to start sync', () => logs().includes('Native Android sync started'), 30_000, 1_000);
    check(true, '(0) the app booted and started sync after its journal replay');
    second = await hostDevice({ bundle, name: 'second', log: (line) => { if (/error|fail/i.test(line)) console.log(`note - ${line.slice(0, 240)}`); } });
    await second.boot();


    let nodes = await openSync();
    check(onSync(nodes), '(1) Settings › Sync opens from the Settings menu');
    if (!nodes.some((node) => node.text === en['settings.syncOff'])) {
        await tapTag('sync-backend-off', (current) => current.some((node) => node.text === en['settings.syncOff']), 'Sync off');
    }
    check(rkStorage().keys['@mindwtr_sync_backend'] !== 'webdav', '(1) the stored backend is not WebDAV before the check configures it');


    await tapTag('sync-backend-webdav', (current) => Boolean(tagged(current, 'sync-url')), 'the WebDAV form');
    await fill('sync-url', webdavFields.url);
    await insecureOn();
    await fill('sync-username', USER);
    await fill('sync-password', PASSWORD);
    const beforeTest = dav.state.authorized.length;
    await runCommand('sync-test', 'testSyncConnection', 'Test connection', en['settings.syncMobile.connectionOk']);
    check(toastsOf('testSyncConnection').at(-1) === `success:${en['settings.syncMobile.connectionOk']}`, `(2) Test connection answered RN's "${en['settings.syncMobile.connectionOk']}" (${toastsOf('testSyncConnection').at(-1)})`);
    check(dav.state.authorized.slice(beforeTest).some((request) => request.startsWith(`GET ${FOLDER}/`)), '(2) Test connection signed in to the local WebDAV folder with the typed password');
    check(rkStorage().keys['@mindwtr_sync_backend'] !== 'webdav' && webdavDocument(dav, FOLDER) === null, '(2) Test connection stored nothing and wrote nothing');
    await runCommand('sync-save', 'saveSyncBackend', 'Save', en['settings.syncCompleted']);
    await until('the phone\'s data in the WebDAV folder', () => webdavDocument(dav, FOLDER) !== null, 30_000);
    const stored = rkStorage();
    check(stored.keys['@mindwtr_sync_backend'] === 'webdav' && stored.keys['@mindwtr_webdav_url'] === webdavFields.url
        && stored.keys['@mindwtr_webdav_username'] === USER && stored.keys['@mindwtr_webdav_allow_insecure_http'] === 'true',
    '(2) Save stored the backend, URL, username and insecure flag in RN\'s RKStorage under RN\'s keys');
    check(stored.version === 1 && /key TEXT PRIMARY KEY, value TEXT NOT NULL/.test(stored.schema), `(2) RKStorage keeps RN's schema at user_version ${stored.version}`);
    check(!Object.values(stored.keys).some((value) => value.includes(PASSWORD)), '(2) the password is not in RKStorage');
    const secretPrefs = sh(`run-as ${PKG} cat shared_prefs/SecureStore.xml`);
    check(/name="key_v1-mindwtr_webdav_password"/.test(secretPrefs) && !secretPrefs.includes(PASSWORD), '(2) the password is sealed in RN\'s SecureStore entry, never in plain text');
    const holders = grepApp(PASSWORD);
    check(holders.length === 0, `(2) no app file holds the password in plain text (${holders.join(', ') || 'none'}; journal, logs, databases, preferences)`);
    check(!logs().includes(PASSWORD), '(2) no log line holds the password');
    console.log(`info - files checked: ${plaintextHolders().replace(/\s+/g, ' ')}`);


    await second.configure('webdav', webdavFields);
    const remote = webdavDocument(dav, FOLDER);
    const phoneTitles = Object.keys(phoneTasks());
    const secondTitles = await second.titles();
    check(phoneTitles.length > 0 && remote.tasks.length >= phoneTitles.length, `(3) the phone uploaded its ${phoneTitles.length} tasks`);
    await second.capture(titles.host);
    const hostReply = await second.syncNow('webdav', { ...webdavFields, password: null });
    console.log(`info - the second device's Sync now replied ${JSON.stringify(hostReply)}`);
    const hostWrote = () => webdavDocument(dav, FOLDER).tasks.some((task) => task.title === titles.host);
    if (hostReply?.toasts?.some((toast) => toast.title === en['settings.syncQueued'])) {
        await until('the second device\'s queued retry to write its emoji task', hostWrote, 30_000, 1_000);
    }
    check(hostWrote(), '(3) the second device wrote its emoji task to the folder');
    nodes = await openSync();
    await runCommand('sync-now', 'syncNow', 'Sync now', en['settings.syncCompleted']);
    await until('the second device\'s task on the phone', () => phoneTasks()[titles.host] === 'inbox', 30_000);
    check(true, `(3) Sync now brought "${titles.host}" to the phone exactly (${secondTitles.length} tasks on the second device)`);
    await toInbox();
    let shown = await device.reveal(titles.host);
    for (let attempt = 0; attempt < 3 && !taskRow(shown, titles.host); attempt += 1) {
        await sleep(5_000);
        shown = await device.reveal(titles.host);
    }
    if (!taskRow(shown, titles.host)) {
        console.log(`evidence - app log:\n${logs().split('\n').filter((line) => /sync state|Core action failed|background|refresh/i.test(line)).slice(-30).join('\n')}`);
    }
    check(Boolean(taskRow(shown, titles.host)), '(3) the Inbox shows the emoji title as the second device wrote it');

    await device.completeUntil(titles.host, 'the second device\'s task moved on', (current) => !taskRow(current, titles.host));
    const movedTo = phoneTasks()[titles.host];
    check(Boolean(movedTo) && movedTo !== 'inbox', `(3) the phone moved the emoji task on (${movedTo})`);
    await waitFor('the Done toast to time out', (current) => !current.some((node) => node.text === en['common.undo']), 60_000);
    await capture(titles.phone);

    await until('the phone\'s automatic sync to upload its change and its capture', () => {
        const document = webdavDocument(dav, FOLDER);
        const host = document?.tasks.find((task) => task.title === titles.host);
        return host?.status === movedTo && document.tasks.some((task) => task.title === titles.phone && !task.deletedAt);
    }, 300_000, 3_000);
    check(true, `(3) a data change on the phone synced by itself (core's data-change trigger): the ${movedTo} task and the capture are in the folder`);
    await second.syncNow('webdav', { ...webdavFields, password: null });
    const secondNow = await second.titles();
    check(secondNow.includes(titles.phone) && !secondNow.includes(titles.host), `(3) the second device has the phone's capture, and the emoji task left its Inbox (${movedTo})`);
    check(webdavDocument(dav, FOLDER).tasks.find((task) => task.title === titles.host)?.title === titles.host, '(3) the emoji title round-tripped byte for byte');


    let release = () => {};
    dav.state.holdWrites = new Promise((done) => { release = done; });
    const heldBefore = dav.state.heldAt.length;
    await capture(titles.midSync);
    await until('the phone\'s automatic sync to wait on its document write', () => dav.state.heldAt.length > heldBefore, 300_000, 500);
    const heldSince = dav.state.heldAt[heldBefore];
    check(true, '(3b) the phone\'s automatic sync waits on its document write');
    await toInbox();
    const popup = await device.openCapture();
    await device.focusAtEnd(tagged(popup, 'capture-title') ?? fail('no capture field'));
    requireAppFront();
    sh(`input text '${titles.killed}'`);
    await waitFor(`"${titles.killed}" in the capture field`, (current) => tagged(current, 'capture-title')?.text === titles.killed, 15_000);
    const killedPid = pid();
    setProp('journal_stop', 'after:captureSubmit');
    try {
        await tap(button(await screen(), en['common.save']) ?? fail('no Save'));
        await until('the process to stop after core\'s reply', () => pid() !== killedPid, 30_000, 100);
    } finally {
        setProp('journal_stop', '');
    }

    const heldMs = Date.now() - heldSince;
    check(device.logs(killedPid, TAG).includes('Native Android journal stop at=after op=captureSubmit') && heldMs < 30_000,
        `(3b) the process died mid-sync (${Math.round(heldMs / 1000)} s into the held write), after core's reply to the capture and before the journal dropped it`);
    await sleep(1500);
    if (!pid() || pid() === killedPid) {
        await waitFor('the home screen or the app', () => front().includes(`${home}/`) || front().includes(`${PKG}/`), 15_000);
        device.launch(ACTIVITY);
    }
    let replayLine = '';
    await waitFor('the boot\'s journal replay', () => {
        replayLine = (pid() && logs().split('\n').find((line) => line.includes('Native Android journal replay'))) || '';
        return Boolean(replayLine);
    }, 60_000);

    check(/sent=1 dropped=1 left=0 owed=none/.test(replayLine), `(3b) the relaunched app's journal re-sent the capture (${replayLine.trim().slice(-80)})`);
    check(storedCount(titles.killed) === 1 && storedCount(titles.midSync) === 1, '(3b) the phone stores each capture once');
    release();
    dav.state.holdWrites = null;

    if (!front().includes(`${PKG}/`)) device.launch(ACTIVITY);
    await waitFor('the Inbox', onInbox, 60_000);

    await until('the next syncs to bring both captures to the folder', () => {
        const live = (webdavDocument(dav, FOLDER)?.tasks ?? []).filter((task) => !task.deletedAt);
        return [titles.midSync, titles.killed].every((title) => live.filter((task) => task.title === title).length === 1);
    }, 600_000, 3_000);
    check(true, '(3b) the next syncs wrote both captures to the folder, once each');

    for (const deadline = Date.now() + 180_000; ;) {
        const answer = JSON.stringify(await second.syncNow('webdav', { ...webdavFields, password: null }));
        if (!answer.includes('holding this sync location')) break;
        if (Date.now() > deadline) fail('the second device stayed fenced out of the folder for 3 minutes');
        await sleep(5_000);
    }
    const secondAfterKill = await second.titles();
    check([titles.midSync, titles.killed].every((title) => secondAfterKill.filter((shownTitle) => shownTitle === title).length === 1),
        '(3b) the second device has both captures, once each');
    check(storedCount(titles.killed) === 1, '(3b) after the syncs the phone still stores the killed capture once');


    const [badgeBefore] = badge();
    check(badgeBefore === 'healthy', `(4) the sync badge is healthy before the outage (${badgeBefore})`);
    const writesBefore = dav.state.requests.filter((request) => request.startsWith('PUT')).length;
    dav.state.down = true;
    await capture(titles.down);
    await until('the automatic sync to fail', () => badge()[0] === 'attention', 180_000);

    check(await menuDotIsRed(), '(4) the Menu tab\'s sync dot shows RN\'s attention red');
    nodes = await openSync();
    const failed = await statusLine();
    check(failed.status.endsWith(en['settings.syncStatusFailedSuffix']) && Boolean(failed.error),
        `(4) the status line shows the failure: "${failed.status}" / "${failed.error}"`);
    check(phoneTasks()[titles.down] === 'inbox', '(4) the capture stays on the phone');
    check(!webdavDocument(dav, FOLDER).tasks.some((task) => task.title === titles.down)
        && dav.state.requests.filter((request) => request.startsWith('PUT')).length === writesBefore, '(4) nothing reached the server while it was down');


    dav.state.down = false;
    dav.state.failWrites = 1_000;
    const failedAt = badge()[1];
    await capture(titles.failed);

    await until('a sync whose writes fail', () => Number(badge()[1]) > Number(failedAt) && badge()[0] === 'attention', 480_000, 3_000);
    check(!webdavDocument(dav, FOLDER).tasks.some((task) => task.title === titles.failed), '(5) the failed write left the folder without the capture');
    dav.state.failWrites = 0;
    await until('the retry to upload the capture with no tap', () => webdavDocument(dav, FOLDER).tasks.some((task) => task.title === titles.failed)
        && webdavDocument(dav, FOLDER).tasks.some((task) => task.title === titles.down), 600_000, 3_000);
    check(true, '(5) once the server took writes again, the retry uploaded both captures by itself');
    await until('the badge healthy again', () => badge()[0] === 'healthy', 30_000);


    nodes = await openSync();
    await tapTag('sync-backend-selfhosted', (current) => Boolean(tagged(current, 'sync-token')), 'the self-hosted form');
    await fill('sync-url', cloudFields.url);
    await insecureOn();
    await fill('sync-token', TOKEN);
    await runCommand('sync-save', 'saveSyncBackend', 'Save', en['settings.syncCompleted']);
    const cloudStored = rkStorage().keys;
    check(cloudStored['@mindwtr_sync_backend'] === 'cloud' && cloudStored['@mindwtr_cloud_provider'] === 'selfhosted' && cloudStored['@mindwtr_cloud_url'] === cloudFields.url
        && !Object.values(cloudStored).some((value) => value.includes(TOKEN)), '(6) Save stored the self-hosted backend under RN\'s keys, the token only in the secret store');
    check(grepApp(TOKEN).length === 0 && !logs().includes(TOKEN), '(6) no app file and no log line holds the token');
    await second.configure('selfhosted', cloudFields);
    check((await second.titles()).includes(titles.failed), '(6) the second device joined the cloud and has the phone\'s tasks');
    await second.capture(titles.cloudHost);
    await second.syncNow('selfhosted', { ...cloudFields, token: null });
    nodes = await openSync();
    await runCommand('sync-now', 'syncNow', 'Sync now', en['settings.syncCompleted']);
    await until('the cloud task on the phone', () => phoneTasks()[titles.cloudHost] === 'inbox', 30_000);
    check(true, `(6) Sync now brought "${titles.cloudHost}" from the cloud exactly`);
    const offlineSkips = () => (logs().match(/Sync skipped after offline detection/g) ?? []).length;
    const skipsBefore = offlineSkips();
    await cloud.stop();
    await capture(titles.offline);
    await until('the automatic sync to meet the stopped cloud', () => offlineSkips() > skipsBefore, 480_000, 3_000);
    check(phoneTasks()[titles.offline] === 'inbox', '(6) with the cloud stopped the capture stays on the phone (read as offline, as on RN)');
    cloud = await startCloud({ repo, port: CLOUD_PORT, token: TOKEN, dataDir: resolve(work, `cloud-${run}`) });
    nodes = await openSync();
    await runCommand('sync-now', 'syncNow', 'Sync now after the cloud came back', en['settings.syncCompleted']);
    await second.syncNow('selfhosted', { ...cloudFields, token: null });
    check((await second.titles()).includes(titles.offline), '(6) the cloud back, Sync now uploaded the capture made while it was stopped');


    nodes = await openSync();
    const choicesSince = stamp();
    dav.state.delayMs = 2_000;
    await hideKeyboard();
    const webdavChip = await reveal((current) => tagged(current, 'sync-backend-webdav'), 'the WebDAV chip');

    const offChip = tagged(await screen(), 'sync-backend-off') ?? fail('no Off chip beside WebDAV');
    await tap(webdavChip);
    await tap(offChip);


    await sleep(3_000);
    dav.state.delayMs = 0;
    await until('both backend choices to answer', () => commands('selectSyncBackend', 'saved', choicesSince) >= 2, 240_000, 1_000);
    await until('Off stored', () => rkStorage().keys['@mindwtr_sync_backend'] === 'off', 15_000, 1_000);
    check(true, '(7) Off tapped during a slow WebDAV choice is not dropped: both choices answered, and RKStorage holds "off"');
    await toTabs();
    console.log('Sync device check passed');
} catch (error) {
    try {
        console.log(`evidence - app log (sync):\n${logs().split('\n').filter((line) => /\[sync\]|sync state|automatic cycle|Auto-sync|task command|Core action|idle pump/.test(line))
            .slice(-60).map((line) => line.slice(0, 300)).join('\n')}`);
    } catch {                       }
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    cleanup();
    await sleep(500);
    process.exit(process.exitCode ?? 0);
}
