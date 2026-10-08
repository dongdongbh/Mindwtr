// Settings and editor View tab check for the isolated native Android development app.
//
//   node apps/android-native/scripts/check-settings-editor-device.mjs <adb-serial> [apk]
//
// Installs the debug APK with `install -r` (existing development data stays). A list task (RN's taskMode 'list', which the app
// cannot make) is needed, so the script stops the app and, through core's own store on a host copy of the database, adds one Done
// list task with two done items, titled for this run (70 + run id + 1); then it checks the screens against core's own views on
// copies: (a) Settings opens from the More sheet with core's rows (the screens not built disabled); (b) General's week start is
// stored once and a re-pick writes nothing (core's sync stamp stays); (c) the language switch to Chinese changes core's words and
// the app's labels, and English comes back; (d) Manage's new area under an injected failed commit stores nothing, Try again
// stores it once, and a second area of that name shows core's taken-name line with Save off; (e) a GTD choice (Focus task limit)
// is stored once; rotation and process death keep the open GTD screen; (f) History's Done opens the Done list task on the View
// tab, and rotation and process death keep that tab; (g) a tick in the View tab and an item added on the Form tab save in ONE
// write (the task's rev + 1) with the status core's checklist edit sets (Next); (h) Reset checklist (from search) opens every
// saved item in one write. Every setting it changes (week start, language, Focus task limit, Manage's open Areas) is put back
// through the app before it ends, on failure too. It touches only the development package (it refuses any other APK), never
// launches over another app, leaves the app on its Inbox tab, restores rotation and clears its debug properties on exit. Leave the
// device on its home screen. It needs host `bun`.
// Exit 0 = pass, 1 = fail, 2 = refused before touching the device, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, check, connect, evidenced, fail, field, inboxCount, inEditor, isOn, mainList, owedRetry, Stopped, tab, tabSelected, tagged, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-settings-editor-device.mjs <adb-serial> [apk]');
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
const STAGED = '/data/local/tmp/mindwtr-native-dev-settings.db';
const PROPS = ['fail_commit', 'delay_before_ms', 'delay_after_ms', 'language'];
const DB = 'mindwtr-native-dev.db';
const work = resolve(app, 'android/build/settings-editor-check');
const coreSrc = resolve(app, '../../packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));
// Digits only: the keyboard guard allows only an English layout, and digits never compose.
const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const names = { task: `70${run}1`, area: `70${run}2`, items: [`72${run}1`, `72${run}2`], added: `73${run}` };

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { adbRaw, sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting } = device;
// The phone's locale as Android reports it (the app sends Locale.getDefault()'s tag to core).
const phoneLocale = (sh('getprop persist.sys.locale') || sh('getprop ro.product.locale')).trim();
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
const runAs = (command) => sh(`run-as ${PKG} ${command}`);
const commands = (operation, outcome = 'saved') => device.logs(pid(), TAG).replace(/\\/g, '').split('\n').filter((line) => line.includes('native-android-dev-task-command')
    && line.includes(`"operation":"${operation}"`) && line.includes(`"outcome":"${outcome}"`)).length;

// ---- core on a copy of the app's database ----
const pullDatabase = (name = 'db') => {
    const dir = resolve(work, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = runAs('ls files').split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    return resolve(dir, DB);
};
/**
 * Core on a copy: `inject` adds this run's Done list task (two done items) through core's store and checkpoints the WAL; `views`
 * prints core's words and values the check compares with: the More sheet's labels, the Settings menu rows, General's options (in
 * English, and its words in Chinese), Manage's and GTD's, the stored settings, this run's area, and the list task.
 */
const core = (mode, db = pullDatabase()) => JSON.parse(execFileSync('bun', ['-e', `
    import { Database } from 'bun:sqlite';
    import { SqliteAdapter, createNativeHostContract, flushPendingSave, setStorageAdapter, useTaskStore } from '${coreSrc}/index.ts';
    const db = new Database(process.env.CHECK_DB);
    setStorageAdapter(new SqliteAdapter({
        run: async (sql, params = []) => { db.query(sql).run(...params); },
        all: async (sql, params = []) => db.query(sql).all(...params),
        get: async (sql, params = []) => db.query(sql).get(...params) ?? undefined,
        exec: async (sql) => { db.exec(sql); },
    }));
    const host = createNativeHostContract();
    // The phone's locale, as the app passes it: core's "System default (…)" labels name what it resolves to.
    const locale = process.env.CHECK_LOCALE || null;
    if (!(await host.setLanguage({ storedLanguage: 'en', systemLocale: locale })).ok) throw new Error('language');
    const ready = await host.activate({ writeSafetyReady: true });
    if (!ready.ok) throw new Error(ready.error.message);
    const value = (result) => { if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message); return result.value; };
    const names = JSON.parse(process.env.CHECK_NAMES);
    const store = () => useTaskStore.getState();
    const live = (items) => items.filter((item) => !item.deletedAt);
    let out;
    if (process.env.CHECK_MODE === 'inject') {
        const result = await store().addTask(names.task, { status: 'done', taskMode: 'list',
            checklist: names.items.map((title) => ({ id: crypto.randomUUID(), title, isCompleted: true })) });
        if (!result.success || !result.id) throw new Error('addTask failed: ' + result.error);
        await flushPendingSave();
        if (store().persistenceFailure) throw new Error('save failed: ' + store().persistenceFailure.message);
        out = { id: result.id };
    } else {
        const labels = (language) => {
            const more = value(host.getMoreMenu());
            const tiles = Object.fromEntries([...more.primary, ...more.utilities].map((item) => [item.id, item.label]));
            const menu = value(host.getSettingsMenu({}));
            // The app passes its sync badge: the Sync row's words then end with the badge's (RN's MenuItem label).
            // The About row's words end with RN's update dot once an update was found (RN's stored `mindwtr-update-available`).
            const badged = [...['syncing', 'healthy', 'attention'].map((syncBadge) => value(host.getSettingsMenu({ syncBadge })).groups.flat()),
                value(host.getSettingsMenu({ updateAvailable: true })).groups.flat()];
            const general = value(host.getGeneralSettings({}));
            const strings = value(host.getStrings({ keys: ['common.back', 'tab.menu'] })).strings;
            return { language, tiles, rows: menu.groups.flat().map((row) => ({ id: row.id, label: row.accessibilityLabel,
                labels: [row.accessibilityLabel, ...badged.map((rows) => rows.find((item) => item.id === row.id).accessibilityLabel)], enabled: row.enabled })),
                general: { title: general.title, language: { label: general.language.label, value: general.language.value },
                    options: general.language.options.map((option) => ({ id: option.value, label: option.label, selected: option.selected })),
                    regional: { label: general.regional.label, summary: general.regional.summary },
                    weekStart: { label: general.regional.weekStart.label, value: general.regional.weekStart.value,
                        options: general.regional.weekStart.options.map((option) => ({ label: option.label, selected: option.selected })) } },
                strings };
        };
        const english = labels('en');
        value(await host.setLanguage({ storedLanguage: 'zh', systemLocale: locale }));
        const chinese = labels('zh');
        value(await host.setLanguage({ storedLanguage: 'en', systemLocale: locale }));
        const manage = value(host.getManageSettings({}));
        const gtd = value(host.getGtdSettings({}));
        const task = live(store()._allTasks).find((item) => item.title === names.task) ?? null;
        const layout = task ? value(host.getTaskEditorModel({ id: task.id })).layout.sections.find((section) => section.fields.includes('checklist')) ?? null : null;
        const settings = store().settings;
        out = {
            english, chinese,
            manage: { areas: manage.sections.find((section) => section.key === 'areas').title, newArea: manage.areas.newArea.label,
                editor: { taken: manage.editor.text.newArea.nameTaken, cancel: manage.editor.text.newArea.cancelLabel, save: manage.editor.text.newArea.saveLabel } },
            gtd: { title: gtd.hub.title, limit: gtd.hub.focusTaskLimit.options.map((option) => ({ label: option.label, value: option.value, selected: option.selected })) },
            settings: { weekStart: settings.weekStart ?? null, languageStamp: settings.syncPreferencesUpdatedAt?.language ?? null,
                language: settings.language ?? null, focusTaskLimit: settings.gtd?.focusTaskLimit ?? null },
            areas: live(store()._allAreas).filter((area) => area.name === names.area).length,
            task: task && { id: task.id, status: task.status, rev: task.rev ?? null, checklist: (task.checklist ?? []).map((item) => [item.title, item.isCompleted]),
                section: layout && { titleKey: layout.titleKey, open: layout.open } },
        };
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    console.log(JSON.stringify(out));
    process.exit(0);
`], { encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, CHECK_DB: db, CHECK_MODE: mode, CHECK_NAMES: JSON.stringify(names), CHECK_LOCALE: phoneLocale } }).trim().split('\n').pop());

// ---- UI ----
/** The tabs show, in the app's language ([labels]): no Menu screen, editor, search or capture over them. */
const onTabs = (nodes, labels) => !tagged(nodes, 'menu-screen') && !inEditor(nodes) && !tagged(nodes, 'global-search') && !tagged(nodes, 'quick-capture')
    && Boolean(tab(nodes, labels.strings['tab.menu']));
const onInbox = (nodes) => !tagged(nodes, 'menu-screen') && !inEditor(nodes) && Number.isFinite(inboxCount(nodes));
const sheetOpen = (nodes) => Boolean(tagged(nodes, 'more-sheet'));
const onSettings = (screenId) => (nodes) => Boolean(tagged(nodes, `settings-${screenId}`)) && !tagged(nodes, 'settings-picker') && !tagged(nodes, 'manage-editor');
const withPrefix = (nodes, prefix) => nodes.find((node) => (node['content-desc'] ?? '').startsWith(prefix));
const hideKeyboard = async () => {
    if (!/mInputShown=true/.test(sh('dumpsys input_method'))) return;
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await sleep(600);
};
/** Back until the tabs show (a Settings screen, the editor or the search closes; a sub-screen goes to its parent first). */
const toTabs = async (labels) => {
    for (let step = 0; step < 8; step += 1) {
        const nodes = await screen();
        if (onTabs(nodes, labels) && !sheetOpen(nodes)) return nodes;
        await hideKeyboard();
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(900);
    }
    return fail('the tabs did not come back');
};
/** The More sheet from the Menu tab ([labels] in the app's language), Settings, then the menu row labelled [row] (null: the menu). */
const openSettings = async (labels, row, screenId) => {
    let nodes = await toTabs(labels);
    nodes = await tapExpecting(tab(nodes, labels.strings['tab.menu']) ?? fail('no Menu tab'), sheetOpen, 'the More sheet');
    nodes = await device.settle(nodes);
    nodes = await tapExpecting(withDescription(nodes, labels.tiles.settings) ?? fail('no Settings in the More sheet'), onSettings('main'), 'Settings');
    if (row === null) return nodes;
    return tapExpecting(withDescription(nodes, labels.rows.find((item) => item.id === row).label) ?? fail(`no ${row} row`), onSettings(screenId), `Settings › ${row}`);
};
/** The General screen's Regional formats opened, then the week start picker; [label] chosen there. */
const pickWeekStart = async (labels, label) => {
    const week = `${labels.general.weekStart.label}: `;
    const regional = `${labels.general.regional.label}: `;
    // A read during the picker's closing animation shows neither row (run 48), so wait for one.
    let nodes = await waitFor('the Regional formats rows', (current) => Boolean(withPrefix(current, week) || withPrefix(current, regional)), 10_000);
    const weekRow = () => withPrefix(nodes, week);
    if (!weekRow()) nodes = await tapExpecting(withPrefix(nodes, regional), (current) => Boolean(withPrefix(current, week)), 'Regional formats open');
    // The opened rows can end at the screen's bottom edge, where a tap meets the gesture bar: move them up first.
    const listBottom = box(mainList(nodes))[3];
    if (box(weekRow())[3] > listBottom - 150) {
        requireAppFront();
        sh(`input swipe 540 ${listBottom - 300} 540 ${listBottom - 900} 1000`);
        nodes = await waitFor('the week start row in view', (current) => box(withPrefix(current, week) ?? { bounds: '[0,0][0,99999]' })[3] <= listBottom - 150, 10_000);
    }
    nodes = await tapExpecting(weekRow(), (current) => Boolean(tagged(current, 'settings-picker')), 'the week start picker');
    return tapExpecting(withDescription(nodes, label) ?? fail(`no week start "${label}"`), (current) => !tagged(current, 'settings-picker'), 'the picker to close');
};
/** The language picker from the General screen ([labels]: its words now), and the language [label] chosen. */
const pickLanguage = async (labels, label) => {
    let nodes = await screen();
    nodes = await tapExpecting(withPrefix(nodes, `${labels.general.language.label}: `) ?? fail('no Language row'), (current) => Boolean(tagged(current, 'settings-picker')), 'the language picker');
    return tapExpecting(withDescription(nodes, label) ?? fail(`no language "${label}"`), (current) => !tagged(current, 'settings-picker'), 'the picker to close');
};
/** The node tagged [tag] fully inside the screen's scrolling column, scrolled to (down first, then up); [required] false: undefined when absent. */
const revealTagged = async (tag, description, match = () => true, required = true) => {
    let nodes = await screen();
    const shown = (current) => {
        const node = current.find((item) => (item['resource-id'] ?? '').split('/').pop() === tag && match(item));
        const list = mainList(current);
        if (!node || !list) return node;
        return box(node)[1] >= box(list)[1] && box(node)[3] <= box(list)[3] ? node : undefined;
    };
    for (const direction of ['down', 'up']) {
        for (let step = 0; step < 10 && !shown(nodes); step += 1) {
            const next = await device.swipe(nodes, direction);
            if (device.signature(next) === device.signature(nodes)) break;
            nodes = next;
        }
        if (shown(nodes)) return { nodes, node: shown(nodes) };
    }
    return required ? fail(`no ${description} on screen`) : { nodes, node: undefined };
};
const killAndRelaunch = async (done, description) => {
    const processId = pid();
    requireAppFront();
    sh('input keyevent KEYCODE_HOME');
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    await sleep(1500);
    sh(`run-as ${PKG} kill -9 ${processId}`);
    await waitFor('process death', () => pid() !== processId, 10_000);
    device.launch(ACTIVITY);
    return waitFor(description, done, 60_000);
};
const rotateKeeps = async (done, description) => {
    sh('settings put system user_rotation 1');
    await waitFor(`${description} in landscape`, done, 20_000);
    sh('settings put system user_rotation 0');
    return waitFor(`${description} in portrait`, done, 20_000);
};

// Everything the check changes, put back through the app (last change first), on failure too.
const undo = [];
const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const restore = async () => {
    for (const name of PROPS) { try { setProp(name, ''); } catch { /* device gone */ } }
    while (undo.length > 0) {
        const step = undo.pop();
        try { if (front().includes(`${PKG}/`)) await step.run(); } catch (error) { console.error(`RESTORE FAILED: ${step.name}: ${error.message}; put it back by hand`); }
    }
    try {
        if (front().includes(`${PKG}/`)) {
            const nodes = await toTabs({ strings: { 'tab.menu': en['tab.menu'] } });
            if (tab(nodes, en['tab.inbox']) && !tabSelected(nodes, en['tab.inbox'])) await tap(tab(nodes, en['tab.inbox']));
        }
    } catch { /* the app is gone */ }
    for (const [name, value] of [['user_rotation', originalRotation], ['accelerometer_rotation', originalAccelerometer]]) {
        try { sh(value === 'null' ? `settings delete system ${name}` : `settings put system ${name} ${value}`); } catch { /* device gone */ }
    }
    try { sh(`rm -f ${UI_FILE} ${STAGED}`); } catch { /* device gone */ }
};

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    for (const name of PROPS) setProp(name, '');
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    // Boot once (this build's schema), stop, add this run's Done list task through core's store, and put the database back.
    device.launch(ACTIVITY);
    requireAppFront();
    sh('settings put system accelerometer_rotation 0');
    sh('settings put system user_rotation 0');
    await waitFor('the Inbox', onInbox, 60_000);
    await device.stopApp();
    const db = pullDatabase('inject');
    const injected = core('inject', db);
    check(!existsSync(`${db}-wal`) || statSync(`${db}-wal`).size === 0, `the Done list task ${names.task} is in the main database file`);
    adbRaw('push', db, STAGED);
    try { runAs(`cp ${STAGED} files/${DB}`); } finally { sh(`rm -f ${STAGED}`); }
    runAs(`rm -f files/${DB}-wal files/${DB}-shm`);
    device.launch(ACTIVITY);
    await waitFor('the Inbox', onInbox, 60_000);
    let seen = core('views');
    check(seen.task?.id === injected.id && seen.task.status === 'done', `core stores ${names.task} as a Done list task with ${seen.task?.checklist.length} done items`);
    const { english, chinese } = seen;

    // (a) Settings from the More sheet: core's rows; the screens not built here are disabled.
    let nodes = await openSettings(english, null);
    // Rows below the fold are read after a drag down (a dump lists only what shows).
    const rowsSeen = new Map();
    for (let step = 0; step < 6 && rowsSeen.size < english.rows.length; step += 1) {
        for (const row of english.rows) {
            const node = row.labels.map((label) => withDescription(nodes, label)).find(Boolean);
            if (node && !rowsSeen.has(row.id)) rowsSeen.set(row.id, node);
        }
        if (rowsSeen.size < english.rows.length) nodes = await device.swipe(nodes, 'down');
    }
    for (const row of english.rows) {
        const node = rowsSeen.get(row.id) ?? fail(`Settings lacks core's row "${row.label}"`);
        if ((node.enabled === 'true') !== row.enabled) fail(`"${row.label}" is ${node.enabled === 'true' ? 'enabled' : 'disabled'}; core says ${row.enabled ? 'built' : 'not built'}`);
    }
    nodes = await device.toTop();
    check(true, `(a) Settings opens from the More sheet with core's ${english.rows.length} rows (${english.rows.filter((row) => row.enabled).map((row) => row.id).join(', ')} built)`);

    // (b) General › Week start: another choice stored once; a re-pick of it writes nothing.
    nodes = await tapExpecting(withDescription(nodes, english.rows.find((row) => row.id === 'general').label), onSettings('general'), 'General');
    const originalWeek = english.general.weekStart.options.find((option) => option.selected) ?? fail('core shows no week start');
    // An explicit day, never core's first choice ("System default (…)"), so the choice is a real change.
    const otherWeek = english.general.weekStart.options.slice(1).find((option) => !option.selected);
    const stampBefore = seen.settings.languageStamp;
    let saves = commands('generalSetting');
    await pickWeekStart(english, otherWeek.label);
    undo.push({ name: `week start "${originalWeek.label}"`, run: async () => { await openSettings(english, 'general', 'general'); await pickWeekStart(english, originalWeek.label); } });
    await waitFor('the week start write', () => commands('generalSetting') === saves + 1, 15_000);
    seen = core('views');
    const stamp = seen.settings.languageStamp;
    check(seen.english.general.weekStart.options.find((option) => option.selected)?.label === otherWeek.label && stamp !== stampBefore,
        `(b) week start "${otherWeek.label}" is stored once (core's value ${seen.settings.weekStart})`);
    await pickWeekStart(english, otherWeek.label);
    await waitFor('the re-pick\'s answer', () => commands('generalSetting') === saves + 2, 15_000);
    seen = core('views');
    check(seen.settings.languageStamp === stamp, '(b) a re-pick of the same week start writes nothing (core\'s sync stamp is unchanged)');
    await pickWeekStart(english, originalWeek.label);
    await waitFor('the week start back', () => commands('generalSetting') === saves + 3, 15_000);
    undo.pop();

    // (c) Language: Chinese changes core's words and the app's own labels; English comes back.
    const zh = english.general.options.find((option) => option.id === 'zh') ?? fail('core offers no Chinese');
    saves = commands('generalSetting');
    await pickLanguage(english, zh.label);
    undo.push({ name: 'English', run: async () => { await openSettings(chinese, 'general', 'general'); await pickLanguage(chinese, 'English'); } });
    nodes = await waitFor('the Chinese words', (current) => Boolean(withDescription(current, chinese.strings['common.back'])) && current.some((node) => node.text === chinese.general.title), 20_000);
    check(commands('generalSetting') === saves + 1, `(c) Chinese: the header's Back reads "${chinese.strings['common.back']}" and core's title "${chinese.general.title}"`);
    await pickLanguage(chinese, 'English');
    nodes = await waitFor('the English words', (current) => Boolean(withDescription(current, english.strings['common.back'])) && current.some((node) => node.text === english.general.title), 20_000);
    undo.pop();
    check(core('views').english.general.options.find((option) => option.id === 'en').selected, '(c) English is back: the header and core\'s words read English again');

    // (d) Manage: a new area under an injected failed commit stores nothing; Try again stores it once; the same name again shows
    // core's taken-name line with Save off.
    nodes = await openSettings(english, 'manage', 'manage');
    const areasHeading = () => withPrefix(nodes, `${seen.manage.areas} · `) ?? fail('no Areas heading');
    // Areas is open when its New Area button is found (below the fold too); else its heading opens it (and it is closed again at the end).
    if (!(await revealTagged('manage-area-add', 'the New Area button', () => true, false)).node) {
        nodes = await device.toTop();
        await tap(areasHeading());
        await sleep(1500);
        undo.push({ name: 'Areas closed', run: async () => {
            await openSettings(english, 'manage', 'manage');
            if ((await revealTagged('manage-area-add', 'the New Area button', () => true, false)).node) {
                nodes = await device.toTop();
                await tap(areasHeading());
                await sleep(1500);
            }
        } });
    }
    const addArea = async () => {
        const { node } = await revealTagged('manage-area-add', 'the New Area button');
        nodes = await tapExpecting(node, (current) => Boolean(tagged(current, 'manage-editor')), 'the area editor');
        await device.focusAtEnd(tagged(nodes, 'manage-editor-name') ?? fail('no name field'));
        requireAppFront();
        sh(`input text '${names.area}'`);
        return waitFor(`"${names.area}" in the editor`, (current) => tagged(current, 'manage-editor-name')?.text === names.area, 15_000);
    };
    nodes = await addArea();
    await hideKeyboard();
    nodes = await screen();
    setProp('fail_commit', '1');
    const failedBefore = commands('manageEditor', 'failed');
    saves = commands('manageEditor');
    nodes = await tapExpecting(tagged(nodes, 'manage-editor-save'), (current) => Boolean(owedRetry(current)), 'the injected failure');
    check(core('views').areas === 0 && commands('manageEditor', 'failed') === failedBefore + 1, '(d) the failed Save stored no area; its exact retry is owed');
    setProp('fail_commit', '');
    await tapExpecting(owedRetry(nodes), (current) => !owedRetry(current) && !tagged(current, 'manage-editor'), 'Try again and the editor to close');
    await waitFor('the retried write', () => commands('manageEditor') === saves + 1, 15_000);
    check(core('views').areas === 1, `(d) Try again stored the area ${names.area} once`);
    await hideKeyboard();
    nodes = await addArea();
    await hideKeyboard();
    nodes = await waitFor('core\'s taken-name line', (current) => current.some((node) => node.text === seen.manage.editor.taken), 10_000);
    check(tagged(nodes, 'manage-editor-save')?.enabled === 'false', `(d) the same name again shows "${seen.manage.editor.taken}" and Save is off`);
    await hideKeyboard();
    nodes = await tapExpecting(withDescription(await screen(), seen.manage.editor.cancel) ?? fail('no Cancel'), (current) => !tagged(current, 'manage-editor'), 'the editor to close');
    check(core('views').areas === 1, '(d) the refused duplicate wrote nothing');

    // (e) GTD › Focus task limit: another choice stored once; rotation and process death keep the GTD screen.
    nodes = await openSettings(english, 'gtd', 'gtd');
    const originalLimit = seen.gtd.limit.find((option) => option.selected) ?? fail('core shows no Focus task limit');
    const otherLimit = seen.gtd.limit.find((option) => !option.selected);
    saves = commands('gtdSetting');
    await tapExpecting(withDescription(nodes, otherLimit.label) ?? fail(`no limit ${otherLimit.label}`), (current) => isOn(withDescription(current, otherLimit.label)), 'the new limit');
    undo.push({ name: `Focus task limit ${originalLimit.label}`, run: async () => {
        nodes = await openSettings(english, 'gtd', 'gtd');
        await tapExpecting(withDescription(nodes, originalLimit.label), (current) => isOn(withDescription(current, originalLimit.label)), 'the original limit');
    } });
    await waitFor('the limit\'s write', () => commands('gtdSetting') === saves + 1, 15_000);
    check(core('views').settings.focusTaskLimit === otherLimit.value, `(e) the Focus task limit ${otherLimit.label} is stored once`);
    await rotateKeeps(onSettings('gtd'), 'the GTD screen');
    nodes = await killAndRelaunch(onSettings('gtd'), 'the GTD screen after process death');
    check(nodes.some((node) => node.text === seen.gtd.title), '(e) rotation and process death keep Settings › GTD open');
    saves = commands('gtdSetting');
    await tapExpecting(withDescription(nodes, originalLimit.label), (current) => isOn(withDescription(current, originalLimit.label)), 'the original limit');
    await waitFor('the limit back', () => commands('gtdSetting') === saves + 1, 15_000);
    undo.pop();

    // (f) History's Done opens the Done list task on the View tab; rotation and process death keep the tab.
    nodes = await toTabs(english);
    nodes = await tapExpecting(tab(nodes, en['tab.menu']) ?? fail('no Menu tab'), sheetOpen, 'the More sheet');
    nodes = await device.settle(nodes);
    await tapExpecting(withDescription(nodes, english.tiles.history) ?? fail('no History'), (current) => Boolean(tagged(current, 'menu-screen')), 'History');
    nodes = await device.reveal(names.task, 60);
    const inView = (current) => inEditor(current) && Boolean(tagged(current, 'task-view')) && isOn(withDescription(current, en['markdown.preview']));
    nodes = await tapExpecting(nodes.find((node) => node.text === names.task) ?? fail(`${names.task} is not in History's Done`), inView, 'the editor on its View tab');
    check(true, '(f) the Done task opens on the View tab (RN\'s defaultEditTab "view")');
    await rotateKeeps(inView, 'the View tab');
    nodes = await killAndRelaunch(inView, 'the View tab after process death');
    check(true, '(f) rotation and process death keep the editor on its View tab');

    // (g) A tick in the View tab (the first item opens again: core sets the list task back to Next) and an item added on the Form
    // tab save in one write.
    const before = core('views').task;
    const first = (current) => withDescription(current, names.items[0]);
    nodes = await waitFor('the first item', (current) => first(current)?.checked === 'true', 20_000);
    nodes = await tapExpecting(first(nodes), (current) => first(current)?.checked === 'false', 'the first item opened');
    nodes = await tapExpecting(withDescription(nodes, en['markdown.edit']) ?? fail('no Edit tab'), (current) => inEditor(current) && isOn(withDescription(current, en['markdown.edit'])), 'the Form tab');
    const section = before.section ?? fail('the checklist field is hidden in this editor layout');
    if (section.titleKey && !section.open) {
        let found = await screen();
        for (let step = 0; step < 10 && !withDescription(found, en[section.titleKey]); step += 1) found = await device.swipe(found, 'down');
        await tapExpecting(withDescription(found, en[section.titleKey]) ?? fail(`no ${en[section.titleKey]} section`), (current) => Boolean(tagged(current, 'checklist-add-item')), 'the checklist field');
    }
    const { node: add } = await revealTagged('checklist-add-item', 'Add item');
    nodes = await tapExpecting(add, (current) => current.some((item) => (item['resource-id'] ?? '').endsWith('checklist-item-input') && item.text === ''), 'a new empty item');
    await device.focusAtEnd(nodes.find((item) => (item['resource-id'] ?? '').endsWith('checklist-item-input') && item.text === ''));
    requireAppFront();
    sh(`input text '${names.added}'`);
    await waitFor(`"${names.added}" in the new item`, (current) => current.some((item) => (item['resource-id'] ?? '').endsWith('checklist-item-input') && item.text === names.added), 15_000);
    await hideKeyboard();
    saves = commands('saveTaskDraft');
    await tapExpecting(withDescription(await screen(), en['common.save']) ?? (await screen()).find((node) => node.text === en['common.save']) ?? fail('no Save'), (current) => !inEditor(current), 'the editor to close');
    await waitFor('the save', () => commands('saveTaskDraft') === saves + 1, 15_000);
    let after = core('views').task;
    check(after.status === 'next' && after.rev === before.rev + 1 && JSON.stringify(after.checklist) === JSON.stringify([[names.items[0], false], [names.items[1], true], [names.added, false]]),
        `(g) the tick and the added item saved in one write (rev ${before.rev} → ${after.rev}) with core's status "${after.status}": ${JSON.stringify(after.checklist)}`);

    // (h) Reset checklist, from the task found by search: every saved item opens, in one write.
    nodes = await toTabs(english);
    nodes = await tapExpecting(withDescription(nodes, en['search.title']) ?? fail('no Search'), (current) => Boolean(tagged(current, 'global-search')), 'the search');
    await device.focusAtEnd(field(nodes) ?? fail('no search field'));
    requireAppFront();
    sh(`input text '${names.task}'`);
    const result = (current) => current.find((node) => (node['resource-id'] ?? '').endsWith('search-result') && (node['content-desc'] || node.text) === names.task);
    nodes = await waitFor('the task in the results', (current) => Boolean(result(current)), 20_000);
    await hideKeyboard();
    nodes = await tapExpecting(result(await screen()), (current) => inEditor(current) && Boolean(withDescription(current, en['markdown.edit'])), 'the editor');
    // A search result opens on the Form tab unless the device's "Open tasks in" says Preview.
    if (!isOn(withDescription(nodes, en['markdown.edit']))) {
        nodes = await tapExpecting(withDescription(nodes, en['markdown.edit']), (current) => isOn(withDescription(current, en['markdown.edit'])), 'the Form tab');
    }
    if (section.titleKey && !section.open) {
        let found = await screen();
        for (let step = 0; step < 10 && !withDescription(found, en[section.titleKey]); step += 1) found = await device.swipe(found, 'down');
        await tapExpecting(withDescription(found, en[section.titleKey]) ?? fail(`no ${en[section.titleKey]} section`), (current) => Boolean(tagged(current, 'checklist-add-item')), 'the checklist field');
    }
    const { node: reset } = await revealTagged('checklist-reset', 'Reset checklist');
    check(reset['content-desc'] === en['taskEdit.resetChecklist'], `(h) the Form tab offers core's "${en['taskEdit.resetChecklist']}"`);
    const resets = commands('resetChecklist');
    const second = (current) => withDescription(current, names.items[1]);
    nodes = await tapExpecting(reset, (current) => second(current)?.checked === 'false', 'every item open');
    await waitFor('the reset write', () => commands('resetChecklist') === resets + 1, 15_000);
    after = core('views').task;
    check(after.checklist.every(([, done]) => !done) && after.rev === before.rev + 2, `(h) Reset checklist opened every saved item in one write (rev ${after.rev})`);
    await sleep(1000);
    await tapExpecting(withDescription(await screen(), en['common.close']) ?? fail('no Close'), (current) => !inEditor(current), 'the editor to close');
    console.log('Settings and editor device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
