// Android system search check for the isolated native Android development app (pass O2d; RN's #1017, core's
// app-search-service.ts on HostAppSearch.kt).
//
//   node apps/android-native/scripts/check-app-search-device.mjs <adb-serial> [apk]
//
// Installs the debug APK with `install -r` (existing development data stays). The launcher's results are Samsung's and not
// checked; the index is read through the app's own debug query (debug.mindwtr.native.appsearch_dump: each resume logs the
// index's ids, never titles). (a) Settings › General's "Expose to system search" turned on indexes exactly core's active items
// (core's buildFullAppSearchIndex over a copy of the app's database); (b) a task this run captured is in the index, and after a
// force-stop and a new start (the start's live indexing) Mark Done takes it out within the 2 s debounce; (c) the switch turned
// off empties the index. It ends with the switch off and the
// index empty, and touches only the development package's own index (the RN app's is its own package's).
// Leave the device on its home screen before running. Exit 0 = pass, 1 = fail, 2 = refused before touching the device, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { button, check, connect, evidenced, fail, field, inboxCount, inEditor, Stopped, switchOn, tab, tagged, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: check-app-search-device.mjs <adb-serial> [apk]');
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
const DB = 'mindwtr-native-dev.db';
const PROPS = ['appsearch_dump'];
const work = resolve(app, 'android/build/app-search-check');
const coreSrc = resolve(app, '../../packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));
const title = `92${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const LABEL = en['settings.appSearchLabel'];

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting } = device;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
const inPopup = (nodes) => Boolean(tagged(nodes, 'quick-capture'));
const inSearch = (nodes) => Boolean(tagged(nodes, 'global-search')) && !inEditor(nodes);
const sheetOpen = (nodes) => Boolean(tagged(nodes, 'more-sheet'));
const onInbox = (nodes) => !inPopup(nodes) && !tagged(nodes, 'menu-screen') && !inSearch(nodes) && !inEditor(nodes) && Number.isFinite(inboxCount(nodes));
const results = (nodes) => nodes.filter((node) => (node['resource-id'] ?? '').endsWith('search-result')).map((node) => node['content-desc'] || node.text);

const toInbox = async () => {
    for (let step = 0; step < 8; step += 1) {
        const nodes = await screen();
        if (onInbox(nodes)) return nodes;
        requireAppFront();
        if (tab(nodes, en['tab.inbox']) && !tagged(nodes, 'menu-screen') && !inSearch(nodes) && !inPopup(nodes) && !sheetOpen(nodes) && !tagged(nodes, 'settings-main')
            && !tagged(nodes, 'settings-general')) {
            await tap(tab(nodes, en['tab.inbox']));
        } else {
            sh('input keyevent KEYCODE_BACK');
        }
        await sleep(1000);
    }
    return fail('the Inbox did not come back');
};
/** The index's ids, as the debug build logs them on a resume (Home, then the launcher's intent). */
const indexIds = async () => {
    requireAppFront();
    sh('input keyevent KEYCODE_HOME');
    await sleep(1200);
    sh('logcat -c');
    device.launch(ACTIVITY);
    let line = null;
    await waitFor('the index ids in the log', () => {
        line = device.logs(pid(), TAG).split('\n').reverse().find((text) => text.includes('system search debug ids=')) ?? null;
        return Boolean(line);
    }, 30_000);
    return JSON.parse(line.slice(line.indexOf('ids=') + 4).trim().replace(/\\/g, ''));
};
/** Core's index for the app's database now (a copy pulled through run-as). */
const coreIds = () => {
    const dir = resolve(work, 'db');
    mkdirSync(dir, { recursive: true });
    const present = sh(`run-as ${PKG} ls files`).split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    return JSON.parse(execFileSync('bun', ['-e', `
        import { Database } from 'bun:sqlite';
        import { SqliteAdapter, buildFullAppSearchIndex, setStorageAdapter, useTaskStore } from '${coreSrc}/index.ts';
        const db = new Database(process.env.CHECK_DB);
        const client = { run: async (sql, params = []) => { db.query(sql).run(...params); }, all: async (sql, params = []) => db.query(sql).all(...params),
            get: async (sql, params = []) => db.query(sql).get(...params) ?? undefined, exec: async (sql) => { db.exec(sql); } };
        setStorageAdapter(new SqliteAdapter(client));
        await useTaskStore.getState().fetchData({ throwOnError: true });
        const state = useTaskStore.getState();
        console.log(JSON.stringify(buildFullAppSearchIndex({ tasks: state.tasks, projects: state.projects, areas: state.areas }).map((doc) => doc.id).sort()));
    `], { encoding: 'utf8', env: { ...process.env, CHECK_DB: resolve(dir, DB) } }).trim().split('\n').at(-1));
};
const general = async () => {
    let nodes = await toInbox();
    nodes = await tapExpecting(tab(nodes, en['tab.menu']) ?? fail('no Menu tab'), sheetOpen, 'the More sheet');
    nodes = await device.settle(nodes);
    nodes = await tapExpecting(withDescription(nodes, en['settings.title']) ?? fail('no Settings tile'), (current) => Boolean(tagged(current, 'settings-main')), 'Settings');
    return tapExpecting(withDescription(nodes, en['settings.general']) ?? fail('no General row'), (current) => Boolean(withDescription(current, LABEL))
        || current.some((node) => node.text === LABEL), 'Settings › General');
};
const setSwitch = async (on) => {
    let nodes = await general();
    const row = withDescription(nodes, LABEL) ?? nodes.find((node) => node.text === LABEL) ?? fail(`no "${LABEL}" row (core hides it below Android 12)`);
    if (switchOn(nodes, LABEL) !== on) nodes = await tapExpecting(row, (current) => switchOn(current, LABEL) === on, `the switch ${on ? 'on' : 'off'}`);
    check(switchOn(nodes, LABEL) === on, `General's "${LABEL}" reads ${on ? 'on' : 'off'}`);
    await toInbox();
};
const captureTask = async () => {
    let nodes = await toInbox();
    nodes = await device.openCapture();
    await device.focusAtEnd(tagged(nodes, 'capture-title') ?? fail('no capture field'));
    requireAppFront();
    sh(`input text '${title}'`);
    await waitFor('the title in the capture field', (current) => tagged(current, 'capture-title')?.text === title, 15_000);
    await tapExpecting(button(await screen(), en['common.save']) ?? fail('no Save'), onInbox, 'the capture to close the popup');
};
const markDone = async () => {
    let nodes = await toInbox();
    nodes = await tapExpecting(withDescription(nodes, en['search.title']) ?? fail('no Search button in the header'), inSearch, 'the search screen');
    await device.focusAtEnd(field(nodes) ?? fail('no search field'));
    requireAppFront();
    sh(`input text ${title}`);
    nodes = await waitFor(`the result ${title}`, (current) => JSON.stringify(results(current)) === JSON.stringify([title]), 20_000);
    await tap(withDescription(nodes, en['review.markDone']) ?? fail('no Mark Done on the result'));
    await sleep(1500);
    await toInbox();
};
const taskId = () => {
    const dir = resolve(work, 'db');
    return execFileSync('sqlite3', [resolve(dir, DB), `SELECT id FROM tasks WHERE title = '${title}'`], { encoding: 'utf8' }).trim();
};

const restore = async () => {
    try {
        if (front().includes(`${PKG}/`)) await setSwitch(false);
    } catch (error) { console.log(`warn - the switch could not be turned off: ${error.message}`); }
    for (const name of PROPS) { try { setProp(name, ''); } catch { /* device gone */ } }
    try { sh(`rm -f ${UI_FILE}`); } catch { /* device gone */ }
};

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    if (Number(sh('getprop ro.build.version.sdk')) < 31) throw new Stopped('Android system search needs Android 12 (API 31) or later');
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    setProp('appsearch_dump', '1');
    device.launch(ACTIVITY);
    requireAppFront();
    await waitFor('the Inbox', onInbox, 60_000);

    // (a) On: the index is core's full index of this library.
    await captureTask();
    await setSwitch(true);
    await sleep(4000);
    let ids = (await indexIds()).sort();
    const expected = coreIds();
    const id = taskId();
    check(JSON.stringify(ids) === JSON.stringify(expected), `(a) turned on, the index holds exactly core's ${expected.length} active items`);
    check(ids.includes(`task:${id}`), '(b) the task this run captured is in the index');

    // (b) A new process (force-stop, then the launcher): the start arms live indexing (appSearchStart), and Done takes the task
    // out (the 2 s debounce, then core's removal).
    await device.stopApp();
    device.launch(ACTIVITY);
    requireAppFront();
    await waitFor('the Inbox again', onInbox, 60_000);
    await sleep(4000);
    await markDone();
    await sleep(3500);
    ids = await indexIds();
    check(!ids.includes(`task:${id}`), '(b) Mark Done took the task out of the index');

    // (c) Off empties the index.
    await setSwitch(false);
    await sleep(2000);
    ids = await indexIds();
    check(ids.length === 0, `(c) turned off, the index is empty (${ids.length} left)`);
    console.log('System search device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
