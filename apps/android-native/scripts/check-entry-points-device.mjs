


import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { button, check, connect, draftText, evidenced, fail, field, hasText, inEditor, projectTitled, Stopped, tab, tabSelected, tagged, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-entry-points-device.mjs <adb-serial> [apk]');
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
const work = resolve(app, 'android/build/entry-points-check');
const coreSrc = resolve(app, '../../packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));

const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const titles = { shared: `77${run}1`, link: `77${run}2`, note: `77${run}3`, typed: `77${run}4`, first: `77${run}5`, second: `77${run}6`,
    overDraft: `77${run}7`, killed: `77${run}8`, clean: `77${run}9` };

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, requireAppFront, pid, screen, waitFor, tapExpecting } = device;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
const lines = (...needles) => device.logs(pid(), TAG).replace(/\\/g, '').split('\n').filter((line) => needles.every((needle) => line.includes(needle))).length;
const entries = (outcome) => lines('native-android-entry-point', `"outcome":"${outcome}"`);
const captures = () => lines('native-android-dev-task-command', '"operation":"captureModal"', '"outcome":"saved"');


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
    import { SqliteAdapter, createNativeHostContract, isSelectableProjectForTaskAssignment, setStorageAdapter, useTaskStore } from '${coreSrc}/index.ts';
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
    const project = store.projects.find((item) => isSelectableProjectForTaskAssignment(item));
    console.log(JSON.stringify({
        tasks: Object.fromEntries(Object.entries(titles).map(([name, title]) => [name,
            store._allTasks.filter((task) => task.title === title && !task.deletedAt).map((task) => ({ id: task.id, status: task.status }))])),
        project: project ? { id: project.id, title: project.title } : null,
    }));
    process.exit(0);
`], { encoding: 'utf8', env: { ...process.env, CHECK_DB: pullDatabase(), CHECK_TITLES: JSON.stringify(titles) } }).trim().split('\n').pop());


const onTabs = (name) => (nodes) => tabSelected(nodes, name) && !inEditor(nodes) && !tagged(nodes, 'global-search') && !tagged(nodes, 'menu-screen');
const inScreen = (title) => (nodes) => Boolean(tagged(nodes, 'menu-screen')) && hasText(nodes, title);
const popup = (text) => (nodes) => Boolean(tagged(nodes, 'quick-capture')) && draftText(nodes) === text;

const modal = (text) => (nodes) => Boolean(tagged(nodes, 'capture-modal')) && tagged(nodes, 'capture-modal-title')?.text === text;


const send = async (intent, expected, description, timeoutMs = 20_000) => {
    requireAppFront();
    const answered = lines('native-android-entry-point');
    sh(`am start -W ${intent} ${PKG}`);
    const deadline = Date.now() + 20_000;
    while (lines('native-android-entry-point') === answered) {
        if (Date.now() > deadline) fail(`core never answered the entry for ${description}`);
        await sleep(500);
    }
    return waitFor(description, expected, timeoutMs);
};

const share = (text) => { requireAppFront(); sh(`am start -W -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT '${text}' ${PKG}`); };

const holds = async (still, ms, description) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (!still(await screen())) fail(`${description} changed while an entry waited`);
        await sleep(500);
    }
};
const link = (path, expected, description, timeoutMs) => send(`-a android.intent.action.VIEW -d '${SCHEME}://${path}'`, expected, description, timeoutMs);
const atTabs = (nodes) => Boolean(tab(nodes, en['tab.inbox'])) && !tagged(nodes, 'menu-screen') && !tagged(nodes, 'global-search') && !inEditor(nodes)
    && !tagged(nodes, 'capture-modal');


const back = async (description) => {
    for (let press = 0; press < 3; press += 1) {
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        const deadline = Date.now() + 6_000;
        while (Date.now() < deadline) {
            if (atTabs(await screen())) return;
            await sleep(500);
        }
    }
    await waitFor(description, atTabs, 5_000);
};
const closePopup = (nodes) => tapExpecting(withDescription(nodes, en['common.close']) ?? fail('no Close on the capture popup'),
    (current) => !tagged(current, 'quick-capture'), 'the popup to close');

const cancelModal = (nodes, expected = (current) => !tagged(current, 'capture-modal'), description = 'the capture screen to close') =>
    tapExpecting(tagged(nodes, 'capture-modal-cancel') ?? fail('no Cancel on the capture screen'), expected, description);

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const restore = async () => {
    for (const name of PROPS) { try { setProp(name, ''); } catch {                   } }

    try {
        if (front().includes(`${PKG}/`)) {
            let nodes = await screen();
            if (tagged(nodes, 'quick-capture')) { sh('input keyevent KEYCODE_BACK'); await sleep(800); nodes = await screen(); }

            for (let step = 0; step < 2 && tagged(nodes, 'capture-modal'); step += 1) { sh('input keyevent KEYCODE_BACK'); await sleep(800); nodes = await screen(); }
            for (let step = 0; step < 3 && (inEditor(nodes) || tagged(nodes, 'menu-screen') || tagged(nodes, 'global-search')); step += 1) {
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
    sh('settings put system accelerometer_rotation 0');
    sh('settings put system user_rotation 0');
    await waitFor('the tabs', (nodes) => Boolean(tab(nodes, en['tab.inbox'])), 60_000);


    const manifestShortcuts = (pkg) => sh(`cmd shortcut get-shortcuts ${pkg}`).split('ShortcutInfo {').slice(1)
        .filter((entry) => /flags=0x[0-9a-f]+ \[[^\]]*Man/.test(entry))
        .map((entry) => ({ label: /shortLabel=[^\n]*\[(\w+)\]/.exec(entry)?.[1], activity: /activity=ComponentInfo\{([^}]+)\}/.exec(entry)?.[1] }));
    let shortcuts = [];
    for (let attempt = 0; attempt < 20 && shortcuts.length < 4; attempt += 1) {
        shortcuts = manifestShortcuts(PKG);
        if (shortcuts.length < 4) await sleep(1000);
    }
    const labels = shortcuts.map((entry) => entry.label).sort();
    check(JSON.stringify(labels) === JSON.stringify(['shortcut_add_task_details_short', 'shortcut_add_task_short', 'shortcut_open_calendar_short', 'shortcut_open_focus_short'])
        && shortcuts.every((entry) => entry.activity === `${PKG}/${PKG}.MainActivity`), `(a) RN's launcher shortcuts on RN's component name: ${JSON.stringify(shortcuts)}`);
    if (sh('pm list packages tech.dongdongbh.mindwtr.dev').split('\n').includes('package:tech.dongdongbh.mindwtr.dev')) {
        const rn = manifestShortcuts('tech.dongdongbh.mindwtr.dev').map((entry) => entry.label).sort();
        check(JSON.stringify(rn) === JSON.stringify(labels), `(a) the same shortcuts as the phone's RN development app: ${JSON.stringify(rn)}`);
    }


    const capturesBefore = captures();
    let nodes = await send(`-a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT '${titles.shared}'`, modal(titles.shared), 'the capture screen with the shared text');
    await tapExpecting(tagged(nodes, 'capture-modal-save') ?? fail('no Save on the capture screen'), onTabs(en['tab.inbox']), 'the share to save');
    await waitFor('the capture command', () => captures() === capturesBefore + 1, 15_000);
    let stored = core();
    check(stored.tasks.shared.length === 1 && stored.tasks.shared[0].status === 'inbox', `(b) the shared text is stored once, in the Inbox (${JSON.stringify(stored.tasks.shared)})`);
    if (!stored.project) {
        const text = `${titles.shared}0 +p${titles.shared}`;
        console.log(`note - the library has no project that takes tasks; sharing "${text}" to make one`);
        nodes = await send(`-a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT '${text}'`, modal(text), 'the capture screen with the project text');
        await tapExpecting(tagged(nodes, 'capture-modal-save'), onTabs(en['tab.inbox']), 'the project text to save');
        for (let wait = 0; wait < 15 && !stored.project; wait += 1) { await sleep(1000); stored = core(); }
    }


    await link('/inbox', onTabs(en['tab.inbox']), 'the Inbox');
    check(true, '(c) inbox opens the Inbox tab');
    await link('/open-feature?feature=today', onTabs(en['tab.next']), 'Focus');
    check(true, '(c) open-feature today opens the Focus tab');
    await link('/waiting', inScreen(en['waiting.title']), 'Waiting');
    await back('the tabs after Waiting');
    check(true, '(c) waiting opens RN\'s Waiting screen');
    await link('/open-feature?feature=someday', inScreen(en['someday.title']), 'Someday');
    await back('the tabs after Someday');
    check(true, '(c) open-feature someday opens RN\'s Someday screen');
    await link('/calendar', (current) => Boolean(tagged(current, 'calendar')), 'the Calendar');
    await back('the tabs after the Calendar');
    check(true, '(c) calendar opens RN\'s Calendar screen');
    nodes = await link(`/global-search?q=${titles.shared}`, (current) => Boolean(tagged(current, 'global-search')) && field(current)?.text === titles.shared, 'the search with its query');
    await back('the tabs after the search');
    check(true, '(c) global-search opens RN\'s search with the link\'s query');
    await link(`/open?task=${stored.tasks.shared[0].id}`, (current) => inEditor(current) && hasText(current, titles.shared), 'the shared task in the editor');
    nodes = await screen();
    await tapExpecting(withDescription(nodes, en['common.close']) ?? fail('no Close in the editor'), onTabs(en['tab.next']), 'Focus under the editor');
    check(true, '(c) open?task opens the task in the editor over Focus');
    if (!stored.project) fail('the library has no project that takes tasks, and the shared +project text made none');
    await link(`/open?project=${stored.project.id}`, (current) => projectTitled(current, stored.project.title) && Boolean(button(current, 'Back')), 'the project');
    await back('the tabs after the project');
    check(true, `(c) open?project opens the project ${stored.project.title}`);
    nodes = await link('/open-feature?feature=capture', popup(''), 'the empty capture popup');
    await closePopup(nodes);
    check(true, '(c) open-feature capture opens the capture popup');
    nodes = await link(`/capture?title=${titles.link}&note=77`, modal(titles.link), 'the capture screen with the link\'s title');
    check(tagged(nodes, 'capture-modal-description')?.text === '77', '(c) a capture link opens the capture screen with its title and note');
    await cancelModal(nodes, onTabs(en['tab.inbox']), 'the Inbox under the capture screen');
    nodes = await send(`-a com.google.android.gms.actions.CREATE_NOTE -t text/plain --es com.google.android.gms.actions.extra.NAME '${titles.note}'`,
        modal(titles.note), 'the capture screen with the note\'s name');
    await cancelModal(nodes);
    check(true, '(c) an assistant note opens the capture screen with its name');
    await link('/capture?note=77', (current) => hasText(current, en['shortcuts.captureUnavailable']), 'core\'s toast for a capture link without a title', 5_000);
    check(true, '(c) a capture link without a title shows core\'s toast');


    nodes = await link('/capture-quick', modal(''), 'the quick capture screen');
    await cancelModal(nodes, () => !front().includes(`${PKG}/`), 'the app to go behind');
    check(true, '(d) capture-quick opens the capture screen, and its Cancel returns to the previous screen');
    device.launch(ACTIVITY);
    await waitFor('the tabs again', (current) => Boolean(tab(current, en['tab.inbox'])), 30_000);

    await link('/capture-quick', modal(''), 'the quick capture screen again');
    for (let press = 0; press < 2 && tagged(await screen(), 'capture-modal'); press += 1) {
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(1_000);
    }
    await waitFor('the tabs after Back', atTabs, 10_000);
    check(front().includes(`${PKG}/`), '(d) Back from the quick capture screen stays in the app');


    nodes = await waitFor('the tabs', atTabs, 20_000);
    share(titles.first);
    share(titles.second);
    nodes = await waitFor('the first share\'s capture screen', modal(titles.first), 20_000);
    await holds(modal(titles.first), 3_000, 'the first share\'s capture screen');

    nodes = await cancelModal(await screen(), modal(titles.second), 'the second share\'s capture screen');
    await cancelModal(nodes, atTabs, 'the tabs');
    check(true, '(e) two shares open in the order they came, the second after the first\'s screen closed');


    await device.type(titles.typed);
    share(titles.overDraft);
    await holds(popup(titles.typed), 4_000, 'the typed capture draft');
    nodes = await screen();
    await tapExpecting(withDescription(nodes, en['common.close']) ?? fail('no Close on the capture popup'), modal(titles.overDraft), 'the waiting share\'s capture screen');
    await cancelModal(await screen());
    check(true, '(f) a share never replaces an open capture draft; it opens after the draft closes');

    stored = core();
    check(stored.tasks.shared.length === 1 && ['link', 'note', 'typed', 'first', 'second', 'overDraft'].every((name) => stored.tasks[name].length === 0),
        '(g) only the shared text was stored; the closed screens stored nothing');
    check(entries('captureModal') >= 7 && entries('capture') >= 1 && entries('notice') >= 1 && entries('task') >= 1 && entries('screen') >= 5,
        `(g) the entry-point log lines: captureModal ${entries('captureModal')}, capture ${entries('capture')}, notice ${entries('notice')}, task ${entries('task')}, screen ${entries('screen')}`);


    await link(`/open?task=${stored.tasks.shared[0].id}`, (current) => inEditor(current) && hasText(current, titles.shared), 'the shared task in the editor');
    share(titles.clean);
    nodes = await waitFor('the share\'s capture screen over the closed clean editor', modal(titles.clean), 15_000);
    await cancelModal(nodes, (current) => !tagged(current, 'capture-modal') && !inEditor(current), 'the tabs, with no editor');
    check(core().tasks.clean.length === 0, '(h) a share over a clean editor closes it and opens at once (#1410)');


    await link(`/open?task=${stored.tasks.shared[0].id}`, (current) => inEditor(current) && hasText(current, titles.shared), 'the shared task in the editor');
    nodes = await screen();
    await tapExpecting(withDescription(nodes, 'Edit') ?? fail('no Edit tab in the editor'), (current) => Boolean(field(current)), 'the editor\'s Form tab');

    await device.focusAtEnd(field(await screen()) ?? fail('no title field in the editor'));
    sh('input text 9');
    await waitFor('the unsaved title edit', (current) => field(current)?.text === `${titles.shared}9`, 10_000);
    share(titles.killed);
    await holds((current) => inEditor(current) && !tagged(current, 'capture-modal'), 3_000, 'the editor');
    sh(`am force-stop ${PKG}`);
    await sleep(1_000);
    device.launch(ACTIVITY);
    nodes = await waitFor('the waiting share\'s capture screen after the relaunch', modal(titles.killed), 60_000);
    await cancelModal(nodes);
    stored = core();
    check(stored.tasks.killed.length === 0 && entries('captureModal') >= 1, '(i) a share queued before a force-stop opens after the relaunch, once');
    console.log('Entry points device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
