


import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { button, check, connect, evidenced, fail, hasText, inEditor, owedRetry, projectTitled, Stopped, tab, tabSelected, tagged, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-capture-modal-device.mjs <adb-serial> [apk]');
    process.exit(2);
}
const app = resolve(import.meta.dirname, '..');
const apk = apkArg ?? resolve(app, 'android/app/build/outputs/apk/play/debug/app-play-debug.apk');
const adbBin = process.env.ADB ?? '/home/dd/Android/Sdk/platform-tools/adb';
const aapt2 = process.env.AAPT2 ?? '/home/dd/Android/Sdk/build-tools/36.1.0/aapt2';
const PKG = 'tech.dongdongbh.mindwtr.nativeclient.dev';
const SCHEME = 'mindwtr-native-dev';
const apkPackage = execFileSync(aapt2, ['dump', 'packagename', apk], { encoding: 'utf8' }).trim();
if (apkPackage !== PKG) {
    console.error(`REFUSED: ${apk} is package "${apkPackage}", not ${PKG}`);
    process.exit(2);
}
const ACTIVITY = `${PKG}/${PKG}.MainActivity`;
const TAG = 'MindwtrNativeDev';
const UI_FILE = '/data/local/tmp/mindwtr-native-dev-ui.xml';
const PROPS = ['fail_commit', 'delay_before_ms', 'delay_after_ms', 'language'];
const DB = 'mindwtr-native-dev.db';
const work = resolve(app, 'android/build/capture-modal-check');
const coreSrc = resolve(app, '../../packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));

const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const titles = { link: `79${run}1`, shared: `79${run}2`, cancelled: `79${run}3`, kept: `79${run}4`, first: `79${run}5`, second: `79${run}6`,
    failed: `79${run}7`, killed: `79${run}8`, cancelled2: `79${run}0` };
const PROJECT = `79${run}9`;
const TAG_NAME = '79tag';
const BODY = `79 body https://example.com/${run}`;

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, requireAppFront, pid, screen, waitFor, tapExpecting } = device;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
const lines = (...needles) => device.logs(pid(), TAG).replace(/\\/g, '').split('\n').filter((line) => needles.every((needle) => line.includes(needle))).length;
const saves = (operation) => lines('native-android-dev-task-command', `"operation":"${operation}"`, '"outcome":"saved"');


const pullDatabase = () => {
    const dir = resolve(work, 'db');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = sh(`run-as ${PKG} ls files`).split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    return resolve(dir, DB);
};

const core = () => JSON.parse(execFileSync('bun', ['-e', `
    import { Database } from 'bun:sqlite';
    import { SqliteAdapter, createNativeHostContract, setStorageAdapter, useTaskStore } from '${coreSrc}/index.ts';
    const db = new Database(process.env.CHECK_DB);
    setStorageAdapter(new SqliteAdapter({
        run: async (sql, params = []) => { db.query(sql).run(...params); },
        all: async (sql, params = []) => db.query(sql).all(...params),
        get: async (sql, params = []) => db.query(sql).get(...params) ?? undefined,
        exec: async (sql) => { db.exec(sql); },
    }));
    const host = createNativeHostContract();
    const ready = await host.activate({ writeSafetyReady: true });
    if (!ready.ok) throw new Error(ready.error.message);
    const store = useTaskStore.getState();
    const titles = JSON.parse(process.env.CHECK_TITLES);
    const project = (id) => store._allProjects.find((item) => item.id === id)?.title ?? null;
    console.log(JSON.stringify(Object.fromEntries(Object.entries(titles).map(([name, title]) => [name,
        store._allTasks.filter((task) => task.title === title && !task.deletedAt)
            .map((task) => ({ id: task.id, status: task.status, tags: task.tags ?? [], description: task.description ?? '', project: project(task.projectId) }))]))));
    process.exit(0);
`], { encoding: 'utf8', env: { ...process.env, CHECK_DB: pullDatabase(), CHECK_TITLES: JSON.stringify({ ...titles, kept0: `${titles.kept}0` }) } }).trim().split('\n').pop());


const titleField = (nodes) => tagged(nodes, 'capture-modal-title');

const onModal = (title) => (nodes) => Boolean(tagged(nodes, 'capture-modal')) && titleField(nodes)?.text === title;
const atTabs = (nodes) => Boolean(tab(nodes, en['tab.inbox'])) && !tagged(nodes, 'capture-modal') && !inEditor(nodes);

const send = async (intent, expected, description) => {
    requireAppFront();
    const answered = lines('native-android-entry-point');
    sh(`am start -W ${intent} ${PKG}`);
    const deadline = Date.now() + 20_000;
    while (lines('native-android-entry-point') === answered) {
        if (Date.now() > deadline) fail(`core never answered the entry for ${description}`);
        await sleep(500);
    }
    return waitFor(description, expected, 20_000);
};
const link = (query, expected, description) => send(`-a android.intent.action.VIEW -d '${SCHEME}://capture?${query}'`, expected, description);
const control = (nodes, tag) => tagged(nodes, tag) ?? fail(`no ${tag} on the capture screen`);
const keyboardShown = () => /mInputShown=true/.test(sh('dumpsys input_method'));


const keyboardUp = async () => {
    for (let wait = 0; wait < 15 && !keyboardShown(); wait += 1) await sleep(200);
    if (!keyboardShown()) fail('the keyboard did not come up for the focused title field');
    return screen();
};

const keyboardDown = async () => {
    await device.tap(tagged(await keyboardUp(), 'capture-modal-hide-keyboard') ?? fail('no hide-keyboard button while the keyboard is up'));
    for (let wait = 0; wait < 15 && keyboardShown(); wait += 1) await sleep(200);
    if (keyboardShown()) fail('the hide-keyboard button left the keyboard up');
};

const typeAtEnd = async (text, { enter = false } = {}) => {
    await device.focusAtEnd(titleField(await screen()) ?? fail('no title field'));
    requireAppFront();
    if (enter) sh('input keyevent KEYCODE_ENTER');
    sh(`input text ${text}`);
};
const rotate = (rotation) => {
    requireAppFront();
    sh('settings put system accelerometer_rotation 0');
    sh(`settings put system user_rotation ${rotation}`);
};

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const restore = async () => {
    for (const name of PROPS) { try { setProp(name, ''); } catch {                   } }


    try {
        if (front().includes(`${PKG}/`)) {
            let nodes = await screen();
            for (let step = 0; step < 4 && (tagged(nodes, 'capture-modal') || inEditor(nodes)); step += 1) {
                sh('input keyevent KEYCODE_BACK');
                await sleep(800);
                nodes = await screen();
            }
            if (tab(nodes, en['tab.inbox']) && !tabSelected(nodes, en['tab.inbox'])) await device.tap(tab(nodes, en['tab.inbox']));
        }
    } catch {                       }
    for (const [name, value] of [['user_rotation', originalRotation], ['accelerometer_rotation', originalAccelerometer]]) {
        try { sh(value === 'null' ? `settings delete system ${name}` : `settings put system ${name} ${value}`); } catch {                   }
    }
    try { sh(`rm -f ${UI_FILE}`); } catch {                   }
};

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    for (const name of PROPS) setProp(name, '');
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    device.launch(ACTIVITY);
    requireAppFront();
    rotate(0);
    await waitFor('the tabs', atTabs, 60_000);


    let nodes = await link(`title=${titles.link}&tags=${TAG_NAME}&project=${PROJECT}`, onModal(titles.link), 'the capture screen with the link\'s title');
    check(!tagged(nodes, 'capture-modal-description') && hasText(nodes, en['nav.addTask']), '(a) the link opens the capture screen: its title, no tag or project text');
    const before = saves('captureModal');

    nodes = await keyboardUp();
    await tapExpecting(control(nodes, 'capture-modal-save-edit'), (current) => inEditor(current) && !tagged(current, 'capture-modal'), 'the saved task\'s editor');
    check(saves('captureModal') === before + 1, '(a) Save & edit ran one capture screen save');

    nodes = await screen();
    nodes = await tapExpecting(withDescription(nodes, en['common.close']) ?? fail('no Close in the editor'),
        (current) => !inEditor(current) && projectTitled(current, PROJECT) && Boolean(button(current, 'Back')), 'the task\'s project under the editor');
    check(true, '(a) Save & edit opened the editor over the task\'s project');
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await waitFor('the tabs after the project', atTabs, 15_000);
    let stored = core();
    check(stored.link.length === 1 && JSON.stringify(stored.link[0].tags) === JSON.stringify([`#${TAG_NAME}`]) && stored.link[0].project === PROJECT,
        `(a) the link's task is stored once, with its tag and in its project (${JSON.stringify(stored.link)})`);


    nodes = await send(`-a android.intent.action.SEND -t text/plain --es android.intent.extra.SUBJECT '${titles.shared}' --es android.intent.extra.TEXT '${BODY}'`,
        onModal(titles.shared), 'the capture screen with the share\'s subject');
    check(tagged(nodes, 'capture-modal-description')?.text === BODY, '(b) the share\'s body is the description');
    nodes = await keyboardUp();
    await tapExpecting(control(nodes, 'capture-modal-save'), atTabs, 'the share to save');
    check(saves('captureModal') === before + 2, '(b) Save ran one capture screen save');
    stored = core();
    check(stored.shared.length === 1 && stored.shared[0].description === BODY && stored.shared[0].status === 'inbox',
        `(b) the share is stored once, in the Inbox, with its body as the description (${JSON.stringify(stored.shared)})`);


    nodes = await link(`title=${titles.cancelled}&note=79`, onModal(titles.cancelled), 'the capture screen to cancel');
    check(tagged(nodes, 'capture-modal-description')?.text === '79', '(c) the link\'s note is the description');

    await keyboardDown();
    nodes = await screen();
    await tapExpecting(control(nodes, 'capture-modal-cancel'), atTabs, 'Cancel to close the screen');


    await link(`title=${titles.kept}`, onModal(titles.kept), 'the capture screen to keep');
    await typeAtEnd('0');
    await waitFor('the typed digit', onModal(`${titles.kept}0`), 10_000);
    rotate(1);
    await sleep(2_000);
    await waitFor('the draft in landscape', onModal(`${titles.kept}0`), 20_000);
    rotate(0);
    await sleep(2_000);
    await waitFor('the draft back in portrait', onModal(`${titles.kept}0`), 20_000);
    check(true, '(d) a rotation keeps the typed draft');
    const processId = pid();
    requireAppFront();
    sh('input keyevent KEYCODE_HOME');
    await waitFor('the home screen', () => front().includes(`${home}/`), 10_000);
    await sleep(1_500);
    sh(`run-as ${PKG} kill -9 ${processId}`);
    await waitFor('process death', () => pid() !== processId, 10_000);
    device.launch(ACTIVITY);
    nodes = await waitFor('the draft after process death', onModal(`${titles.kept}0`), 60_000);
    check(pid() !== processId, '(e) process death keeps the typed draft');
    nodes = await screen();
    await tapExpecting(control(nodes, 'capture-modal-cancel'), atTabs, 'Cancel after the relaunch');


    await link(`title=${titles.first}`, onModal(titles.first), 'the capture screen for two lines');
    await typeAtEnd(titles.second, { enter: true });
    nodes = await waitFor('two lines in the field', onModal(`${titles.first}\n${titles.second}`), 10_000);
    nodes = await keyboardUp();
    const question = en['quickAdd.bulkConfirmTitle'].replace('{{count}}', '2');
    const createLabel = en['quickAdd.bulkConfirmCreate'];
    nodes = await tapExpecting(control(nodes, 'capture-modal-save'), (current) => hasText(current, question) && hasText(current, createLabel), 'core\'s several-lines question');

    const linesBefore = saves('captureModalLines');

    if (keyboardShown()) { sh('input keyevent KEYCODE_BACK'); for (let wait = 0; wait < 15 && keyboardShown(); wait += 1) await sleep(200); }
    sh('input keyevent KEYCODE_BACK');
    nodes = await waitFor('the question to close on Back', (current) => !hasText(current, question) && onModal(`${titles.first}\n${titles.second}`)(current), 10_000);
    check(saves('captureModalLines') === linesBefore, '(f) Back closed the several-lines question first: the screen kept both lines, and nothing was written');
    nodes = await tapExpecting(control(nodes, 'capture-modal-save'), (current) => hasText(current, question) && hasText(current, createLabel), 'core\'s several-lines question again');
    const create = button(nodes, createLabel) ?? fail('no Create tasks on the question');
    await tapExpecting(create, atTabs, 'Create tasks to save both lines');
    check(saves('captureModalLines') === linesBefore + 1, '(f) Create tasks ran one lines save');

    stored = core();
    check(stored.first.length === 1 && stored.second.length === 1, '(f) one task per line');


    nodes = await link(`title=${titles.failed}`, onModal(titles.failed), 'the capture screen for a failed save');
    setProp('fail_commit', '1');
    nodes = await keyboardUp();
    nodes = await tapExpecting(control(nodes, 'capture-modal-save'), (current) => hasText(current, en['task.addFailed']) && Boolean(owedRetry(current)),
        'the failed save\'s line and Try again');
    check(titleField(nodes)?.enabled === 'false' && owedRetry(nodes)?.enabled === 'true', '(g) the draft is locked and Try again offers the exact retry');
    check(core().failed.length === 0, '(g) the failed save stored nothing');
    setProp('fail_commit', '');
    await tapExpecting(owedRetry(await screen()), atTabs, 'Try again to save and close the screen');
    check(core().failed.length === 1 && lines('native-android-dev-task-command', '"operation":"captureModal"', '"outcome":"failed"') >= 1,
        '(g) Try again stored the failed save once');


    nodes = await link(`title=${titles.cancelled2}`, onModal(titles.cancelled2), 'the capture screen for a failed save to cancel');
    setProp('fail_commit', '1');
    nodes = await keyboardUp();
    nodes = await tapExpecting(control(nodes, 'capture-modal-save'), (current) => hasText(current, en['task.addFailed']) && Boolean(owedRetry(current)),
        'the failed save\'s line and Try again');
    check(control(nodes, 'capture-modal-cancel').enabled === 'true', '(h) Cancel is usable while the save is owed');
    nodes = await tapExpecting(control(nodes, 'capture-modal-cancel'), (current) => atTabs(current) && Boolean(owedRetry(current)), 'the tabs with the owed retry');
    setProp('fail_commit', '');
    await tapExpecting(owedRetry(nodes), (current) => atTabs(current) && !owedRetry(current), 'Try again on the tabs');
    check(core().cancelled2.length === 1, '(h) Cancel closed the screen, and the owed retry stored the save once');


    nodes = await link(`title=${titles.killed}`, onModal(titles.killed), 'the capture screen for a killed save');
    setProp('delay_before_ms', '8000');
    nodes = await keyboardUp();
    await device.tap(control(nodes, 'capture-modal-save'));
    await waitFor('the save in flight', (current) => titleField(current)?.enabled === 'false', 5_000);
    const pendingId = JSON.parse(sh(`run-as ${PKG} cat no_backup/capture-modal/modal`)).pending?.id ?? fail('no pending request on disk');
    const killedProcess = pid();
    requireAppFront();
    sh('input keyevent KEYCODE_HOME');
    await waitFor('the home screen', () => front().includes(`${home}/`), 10_000);
    sh(`run-as ${PKG} kill -9 ${killedProcess}`);
    await waitFor('process death', () => pid() !== killedProcess, 10_000);
    setProp('delay_before_ms', '');
    device.launch(ACTIVITY);
    await waitFor('the relaunch to send the owed save and close the screen', atTabs, 60_000);
    stored = core();
    check(stored.killed.length === 1 && stored.killed[0].id === pendingId.toLowerCase(),
        `(i) the relaunch sent the owed save once: one task, under the capture UUID ${pendingId} read before the kill`);
    check(stored.cancelled.length === 0 && stored.kept.length === 0 && stored.kept0.length === 0, '(c, e) Cancel stored nothing');
    check(stored.link.length === 1 && stored.shared.length === 1, '(a, b) each save stored once');
    console.log('Capture screen device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
