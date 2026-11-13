


import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, button, check, connect, evidenced, fail, field, inboxCount, inEditor, isOn, mainList, owedRetry, Stopped, tab, tabSelected, tagged, withDescription } from './device.mjs';

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

const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const names = { task: `70${run}1`, area: `70${run}2`, items: [`72${run}1`, `72${run}2`], added: `73${run}`, pending: `74${run}` };

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { adbRaw, sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting } = device;

const phoneLocale = (sh('getprop persist.sys.locale') || sh('getprop ro.product.locale')).trim();
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
const runAs = (command) => sh(`run-as ${PKG} ${command}`);
const commands = (operation, outcome = 'saved') => device.logs(pid(), TAG).replace(/\\/g, '').split('\n').filter((line) => line.includes('native-android-dev-task-command')
    && line.includes(`"operation":"${operation}"`) && line.includes(`"outcome":"${outcome}"`)).length;


const pullDatabase = (name = 'db') => {
    const dir = resolve(work, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = runAs('ls files').split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    return resolve(dir, DB);
};


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
            // The About row's words end with RN's update dot once an update was found (RN's stored mindwtr-update-available).
            const badged = [...['syncing', 'healthy', 'attention'].map((syncBadge) => value(host.getSettingsMenu({ syncBadge })).groups.flat()),
                value(host.getSettingsMenu({ updateAvailable: true })).groups.flat()];
            const general = value(host.getGeneralSettings({}));
            const strings = value(host.getStrings({ keys: ['common.back', 'tab.menu'] })).strings;
            return { language, tiles, rows: menu.groups.flat().map((row) => ({ id: row.id, label: row.accessibilityLabel,
                labels: [row.accessibilityLabel, ...badged.map((rows) => rows.find((item) => item.id === row.id).accessibilityLabel)], enabled: row.enabled })),
                general: { title: general.title, language: { label: general.language.label, value: general.language.value },
                    options: general.language.options.map((option) => ({ id: option.value, label: option.label, selected: option.selected })),
                    regional: { label: general.regional.label, summary: general.regional.summary },
                    quickAccess: { label: general.appearance.quickAccess.label,
                        options: general.appearance.quickAccess.options.map((option) => ({ value: option.value, label: option.label, selected: option.selected })) },
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

const openSettings = async (labels, row, screenId) => {
    let nodes = await toTabs(labels);
    nodes = await tapExpecting(tab(nodes, labels.strings['tab.menu']) ?? fail('no Menu tab'), sheetOpen, 'the More sheet');
    nodes = await device.settle(nodes);
    nodes = await tapExpecting(withDescription(nodes, labels.tiles.settings) ?? fail('no Settings in the More sheet'), onSettings('main'), 'Settings');
    if (row === null) return nodes;
    return tapExpecting(withDescription(nodes, labels.rows.find((item) => item.id === row).label) ?? fail(`no ${row} row`), onSettings(screenId), `Settings › ${row}`);
};

const pickWeekStart = async (labels, label) => {
    const week = `${labels.general.weekStart.label}: `;
    const regional = `${labels.general.regional.label}: `;


    let nodes = await device.settle();
    if (!withPrefix(nodes, week) && !withPrefix(nodes, regional)) {
        await device.revealNode((current) => withPrefix(current, week) ?? withPrefix(current, regional), 'the Regional formats rows', false);
        nodes = await screen();
    }
    const weekRow = () => withPrefix(nodes, week);
    if (!weekRow()) nodes = await tapExpecting(withPrefix(nodes, regional), (current) => Boolean(withPrefix(current, week)), 'Regional formats open');

    const listBottom = box(mainList(nodes))[3];
    if (box(weekRow())[3] > listBottom - 150) {
        requireAppFront();
        sh(`input swipe 540 ${listBottom - 300} 540 ${listBottom - 900} 1000`);
        nodes = await waitFor('the week start row in view', (current) => box(withPrefix(current, week) ?? { bounds: '[0,0][0,99999]' })[3] <= listBottom - 150, 10_000);
    }
    nodes = await tapExpecting(weekRow(), (current) => Boolean(tagged(current, 'settings-picker')), 'the week start picker');
    return tapExpecting(withDescription(nodes, label) ?? fail(`no week start "${label}"`), (current) => !tagged(current, 'settings-picker'), 'the picker to close');
};

const pickLanguage = async (labels, label) => {
    let nodes = await screen();
    nodes = await tapExpecting(withPrefix(nodes, `${labels.general.language.label}: `) ?? fail('no Language row'), (current) => Boolean(tagged(current, 'settings-picker')), 'the language picker');
    return tapExpecting(withDescription(nodes, label) ?? fail(`no language "${label}"`), (current) => !tagged(current, 'settings-picker'), 'the picker to close');
};

const pickQuickAccess = async (labels, label) => {
    const row = await device.revealNode((current) => withPrefix(current, `${labels.general.quickAccess.label}: `), 'the Quick access row');
    const nodes = await tapExpecting(row, (current) => Boolean(tagged(current, 'settings-picker')), 'the quick access picker');
    return tapExpecting(withDescription(nodes, label) ?? fail(`no quick access "${label}"`), (current) => !tagged(current, 'settings-picker'), 'the picker to close');
};

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


const undo = [];
const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const restore = async () => {
    for (const name of PROPS) { try { setProp(name, ''); } catch {                   } }
    while (undo.length > 0) {
        const step = undo.pop();
        try { if (front().includes(`${PKG}/`)) await step.run(); } catch (error) { console.error(`RESTORE FAILED: ${step.name}: ${error.message}; put it back by hand`); }
    }
    try {
        if (front().includes(`${PKG}/`)) {
            const nodes = await toTabs({ strings: { 'tab.menu': en['tab.menu'] } });
            if (tab(nodes, en['tab.inbox']) && !tabSelected(nodes, en['tab.inbox'])) await tap(tab(nodes, en['tab.inbox']));
        }
    } catch {                       }
    for (const [name, value] of [['user_rotation', originalRotation], ['accelerometer_rotation', originalAccelerometer]]) {
        try { sh(value === 'null' ? `settings delete system ${name}` : `settings put system ${name} ${value}`); } catch {                   }
    }
    try { sh(`rm -f ${UI_FILE} ${STAGED}`); } catch {                   }
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


    let nodes = await openSettings(english, null);

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


    nodes = await tapExpecting(withDescription(nodes, english.rows.find((row) => row.id === 'general').label), onSettings('general'), 'General');
    const originalWeek = english.general.weekStart.options.find((option) => option.selected) ?? fail('core shows no week start');

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


    const quickFrom = english.general.quickAccess.options.find((option) => option.selected) ?? fail('core shows no quick access view');
    const quickTo = english.general.quickAccess.options.find((option) => option.value === (quickFrom.value === 'projects' ? 'review' : 'projects'));
    saves = commands('generalSetting');
    await pickQuickAccess(english, quickTo.label);
    undo.push({ name: `quick access "${quickFrom.label}"`, run: async () => { await openSettings(english, 'general', 'general'); await pickQuickAccess(english, quickFrom.label); } });
    await waitFor('the quick access write', () => commands('generalSetting') === saves + 1, 15_000);
    await toTabs(english);
    await waitFor(`the "${quickTo.label}" tab without the More sheet`, (current) => !sheetOpen(current) && Boolean(tab(current, quickTo.label)) && !tab(current, quickFrom.label), 10_000);
    check(true, `(c) Quick access "${quickTo.label}" replaces the "${quickFrom.label}" tab at once, without opening the More sheet (RN's tab bar)`);
    await openSettings(english, 'general', 'general');
    await pickQuickAccess(english, quickFrom.label);
    await waitFor('the quick access back', () => commands('generalSetting') === saves + 2, 15_000);
    undo.pop();


    nodes = await openSettings(english, 'manage', 'manage');
    const areasHeading = () => withPrefix(nodes, `${seen.manage.areas} · `) ?? fail('no Areas heading');

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


    nodes = await toTabs(english);
    nodes = await tapExpecting(tab(nodes, en['tab.menu']) ?? fail('no Menu tab'), sheetOpen, 'the More sheet');
    nodes = await device.settle(nodes);
    await tapExpecting(withDescription(nodes, english.tiles.history) ?? fail('no History'), (current) => Boolean(tagged(current, 'menu-screen')), 'History');

    const row = await device.revealNode((current) => current.find((node) => node.text === names.task), `${names.task} in History's Done`);
    const inView = (current) => inEditor(current) && Boolean(tagged(current, 'task-view')) && isOn(withDescription(current, en['markdown.preview']));
    nodes = await tapExpecting(row, inView, 'the editor on its View tab');
    check(true, '(f) the Done task opens on the View tab (RN\'s defaultEditTab "view")');
    await rotateKeeps(inView, 'the View tab');
    nodes = await killAndRelaunch(inView, 'the View tab after process death');
    check(true, '(f) rotation and process death keep the editor on its View tab');


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


    nodes = await toTabs(english);
    nodes = await tapExpecting(withDescription(nodes, en['search.title']) ?? fail('no Search'), (current) => Boolean(tagged(current, 'global-search')), 'the search');
    await device.focusAtEnd(field(nodes) ?? fail('no search field'));
    requireAppFront();
    sh(`input text '${names.task}'`);
    const result = (current) => current.find((node) => (node['resource-id'] ?? '').endsWith('search-result') && (node['content-desc'] || node.text) === names.task);
    nodes = await waitFor('the task in the results', (current) => Boolean(result(current)), 20_000);
    await hideKeyboard();
    nodes = await tapExpecting(result(await screen()), (current) => inEditor(current) && Boolean(withDescription(current, en['markdown.edit'])), 'the editor');

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


    nodes = await tapExpecting(withDescription(await screen(), en['markdown.preview']) ?? fail('no View tab'), inView, 'the View tab');
    const { node: pendingBox } = await revealTagged('view-checklist-add', 'the View tab add box');
    await device.focusAtEnd(pendingBox);
    requireAppFront();
    sh(`input text '${names.pending}'`);
    await waitFor(`"${names.pending}" in the add box`, (current) => tagged(current, 'view-checklist-add')?.text === names.pending, 15_000);
    await hideKeyboard();
    nodes = await tapExpecting(withDescription(await screen(), en['common.close']) ?? fail('no Close'),
        (current) => Boolean(button(current, en['common.discard'])), 'the discard question');
    check(nodes.some((node) => node.text === en['taskEdit.discardChanges']), '(i) Close with typed add-box text asks before it drops it');
    nodes = await tapExpecting(button(nodes, en['common.cancel']) ?? fail('no Cancel'), (current) => inView(current) && !button(current, en['common.discard']), 'the View tab again');
    check(tagged(nodes, 'view-checklist-add')?.text === names.pending, '(i) Cancel keeps the typed text in the add box');
    const pendingSaves = commands('saveTaskDraft');
    await tapExpecting(withDescription(await screen(), en['common.save']) ?? (await screen()).find((node) => node.text === en['common.save']) ?? fail('no Save'), (current) => !inEditor(current), 'the editor to close');
    await waitFor('the save', () => commands('saveTaskDraft') === pendingSaves + 1, 15_000);
    after = core('views').task;
    check(after.rev === before.rev + 3 && after.checklist.at(-1)?.[0] === names.pending && after.checklist.at(-1)?.[1] === false,
        `(i) Save added the typed item in one write (rev ${after.rev}): ${JSON.stringify(after.checklist)}`);
    console.log('Settings and editor device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
