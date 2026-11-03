


import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { EDGE_SAFE_X, box, button, check, connect, evidenced, fail, hasText, inboxCount, owedRetry, Stopped, tab, tabSelected, tagged, taskRows, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-sweep-saved-device.mjs <adb-serial> [apk]');
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
const STAGED = '/data/local/tmp/mindwtr-native-dev-sweep.db';
const PROPS = ['fail_commit', 'delay_before_ms', 'delay_after_ms', 'language'];
const DB = 'mindwtr-native-dev.db';
const work = resolve(app, 'android/build/sweep-saved-check');
const coreSrc = resolve(app, '../../packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));

const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const names = {
    query: `75${run}`, search: `75${run}0`, task: `75${run}1`, captures: [`75${run}2`, `75${run}3`], area: `75${run}4`,
    context: `@75${run}5`, other: `@${run}6`,
};

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { adbRaw, sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting } = device;
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
    if (!(await host.setLanguage({ storedLanguage: 'en', systemLocale: null })).ok) throw new Error('language');
    const ready = await host.activate({ writeSafetyReady: true });
    if (!ready.ok) throw new Error(ready.error.message);
    const value = (result) => { if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message); return result.value; };
    const names = JSON.parse(process.env.CHECK_NAMES);
    const store = () => useTaskStore.getState();
    const live = (items) => items.filter((item) => !item.deletedAt);
    let out;
    if (process.env.CHECK_MODE === 'inject') {
        const result = await store().addTask(names.task, { status: 'next', contexts: [names.context, names.other] });
        if (!result.success || !result.id) throw new Error('addTask failed: ' + result.error);
        const search = { id: crypto.randomUUID(), name: names.search, query: names.query };
        await store().updateSettings({ savedSearches: [search, ...(store().settings.savedSearches ?? [])] });
        await flushPendingSave();
        if (store().persistenceFailure) throw new Error('save failed: ' + store().persistenceFailure.message);
        out = { id: result.id, search: search.id };
    } else {
        const tasks = Object.fromEntries([names.task, ...names.captures].map((title) => [title, live(store()._allTasks).filter((task) => task.title === title)
            .map((task) => ({ id: task.id, status: task.status, rev: task.rev ?? null, areaId: task.areaId ?? null }))]));
        const searchId = process.env.CHECK_SEARCH;
        const view = value(host.getSavedSearchView({ id: searchId }));
        const focus = value(host.getFocus({ limit: 50, controls: {} }));
        const sweep = (step) => value(host.getMindSweep({ state: { scope: 'all', step } })).group.title;
        out = {
            sweep: value(host.getInboxView({ offset: 0, limit: 50 })).mindSweep.accessibilityLabel,
            groups: [sweep(0), sweep(1)],
            tasks,
            areas: live(store()._allAreas).filter((area) => area.name === names.area).map((area) => area.id),
            searches: (store().settings.savedSearches ?? []).filter((search) => search.id === searchId).length,
            searchView: { found: view.found, title: view.title, rows: view.rows.map((row) => row.title), confirm: view.delete?.confirm ?? null },
            tokens: value(host.getFocusControlsList({ controls: {}, list: 'tokens', offset: 0, limit: 100, revision: focus.revision, query: names.query })).items.map((item) => item.value),
        };
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    console.log(JSON.stringify(out));
    process.exit(0);
`], { encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, CHECK_DB: db, CHECK_MODE: mode, CHECK_NAMES: JSON.stringify(names), CHECK_SEARCH: injected?.search ?? '' } })
    .trim().split('\n').pop());


const onInbox = (nodes) => !tagged(nodes, 'menu-screen') && tabSelected(nodes, en['tab.inbox']) && Number.isFinite(inboxCount(nodes));
const sheetOpen = (nodes) => Boolean(tagged(nodes, 'more-sheet'));
const inSweep = (nodes) => Boolean(tagged(nodes, 'mind-sweep'));
const groupTitle = (nodes) => tagged(nodes, 'mind-sweep-group-title')?.text;
const captured = (nodes) => nodes.filter((node) => (node['resource-id'] ?? '').endsWith('mind-sweep-captured-item')).map((node) => node.text);
const rowTitles = (nodes) => taskRows(nodes).sort((a, b) => box(a)[1] - box(b)[1]).map((node) => node.text);
const selectedCount = (nodes) => Number(nodes.map((node) => new RegExp(`^(\\d+) ${en['bulk.selected']}$`).exec(node.text ?? '')?.[1]).find(Boolean) ?? NaN);
const all = en['common.all'];

const clickableAround = (nodes, label) => {
    const area = (node) => { const [l, t, r, b] = box(node); return (r - l) * (b - t); };
    for (const labelNode of nodes.filter((node) => node.text === label || node['content-desc'] === label)) {
        const [x1, y1, x2, y2] = box(labelNode);
        const found = nodes.filter((node) => node.clickable === 'true').filter((node) => {
            const [l, t, r, b] = box(node);
            return l <= x1 && t <= y1 && r >= x2 && b >= y2;
        }).sort((a, b) => area(a) - area(b))[0];
        if (found) return found;
    }
    return undefined;
};
const hideKeyboard = async () => {
    if (!/mInputShown=true/.test(sh('dumpsys input_method'))) return;
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await waitFor('the keyboard to close', () => !/mInputShown=true/.test(sh('dumpsys input_method')), 5_000);
};

const typeInto = async (node, tag, text) => {
    await device.focusAtEnd(node ?? fail(`no field ${tag}`));
    requireAppFront();
    sh(`input text '${text}'`);
    return waitFor(`"${text}" in ${tag}`, (current) => tagged(current, tag)?.text === text, 10_000);
};
const longPress = async (title) => {
    const row = taskRows(await screen()).find((node) => node.text === title) ?? fail(`no row ${title} on screen`);
    const [x1, y1, x2, y2] = box(row);
    const x = Math.max(Math.round((x1 + x2) / 2), EDGE_SAFE_X);
    requireAppFront();
    sh(`input swipe ${x} ${Math.round((y1 + y2) / 2)} ${x} ${Math.round((y1 + y2) / 2)} 900`);
    await sleep(600);
};
const killAndRelaunch = async (done, description) => {
    const processId = pid();
    requireAppFront();
    sh('input keyevent KEYCODE_HOME');
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    await sleep(1500);
    runAs(`kill -9 ${processId}`);
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

const sweepAdd = async (title, expected, description) => {
    await typeInto(tagged(await screen(), 'mind-sweep-input'), 'mind-sweep-input', title);
    const add = await waitFor('Add enabled for the text', (current) => tagged(current, 'mind-sweep-add')?.enabled === 'true', 10_000);
    return tapExpecting(tagged(add, 'mind-sweep-add'), expected, description);
};


const pendingOnDisk = () => sh(`run-as ${PKG} ls no_backup/menu 2>/dev/null || true`).split(/\s+/).includes('pending');

let owed = null;


const settleOwed = async () => {
    if (!owed) return;
    for (const name of PROPS) { try { setProp(name, ''); } catch {                   } }
    try {
        if (front().includes(`${home}/`)) device.launch(ACTIVITY);
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const retry = owedRetry(await screen());
            if (!retry && !pendingOnDisk()) {
                console.log(`note - cleanup settled ${owed}: no retry is owed and no request is left on disk`);
                owed = null;
                return;
            }
            if (retry?.enabled === 'true') await tap(retry);
            await sleep(2000);
        }
    } catch (error) {
        console.error(`cleanup: ${error.message}`);
    }
    console.error(`RESTORE FAILED: ${owed} is still owed; open the app and tap Try again before anything else`);
    process.exitCode = 1;
};

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const restore = async () => {
    for (const name of PROPS) { try { setProp(name, ''); } catch {                   } }
    await settleOwed();

    try {
        for (let step = 0; step < 5 && front().includes(`${PKG}/`); step += 1) {
            const nodes = await screen();
            if (!tagged(nodes, 'menu-screen') && !sheetOpen(nodes) && Number.isNaN(selectedCount(nodes)) && tab(nodes, en['tab.inbox'])) break;
            sh('input keyevent KEYCODE_BACK');
            await sleep(800);
        }
        const nodes = await screen();
        if (front().includes(`${PKG}/`) && tab(nodes, en['tab.inbox']) && !tabSelected(nodes, en['tab.inbox'])) await tap(tab(nodes, en['tab.inbox']));
    } catch {                       }
    for (const [name, value] of [['user_rotation', originalRotation], ['accelerometer_rotation', originalAccelerometer]]) {
        try { sh(value === 'null' ? `settings delete system ${name}` : `settings put system ${name} ${value}`); } catch {                   }
    }
    try { sh(`rm -f ${UI_FILE} ${STAGED}`); } catch {                   }
};

let injected;
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
    injected = core('inject', db);
    check(!existsSync(`${db}-wal`) || statSync(`${db}-wal`).size === 0, `the task ${names.task} and the saved search ${names.search} are in the main database file`);
    adbRaw('push', db, STAGED);
    try { runAs(`cp ${STAGED} files/${DB}`); } finally { sh(`rm -f ${STAGED}`); }
    runAs(`rm -f files/${DB}-wal files/${DB}-shm`);
    device.launch(ACTIVITY);
    await waitFor('the Inbox', onInbox, 60_000);
    let seen = core('views');
    check(seen.tasks[names.task].length === 1 && seen.searches === 1, `core stores ${names.task} (Next, two contexts) and the saved search ${names.search}`);


    let nodes = await device.settle(await device.toTop());
    nodes = await tapExpecting(withDescription(nodes, seen.sweep) ?? fail(`no "${seen.sweep}" on the Inbox`), inSweep, 'Mind Sweep');
    nodes = await tapExpecting(tagged(nodes, 'mind-sweep-start') ?? fail('no Start'), (current) => groupTitle(current) === seen.groups[0], 'the first cue list');
    let adds = commands('mindSweepAdd');
    await sweepAdd(names.captures[0], (current) => captured(current).includes(`• ${names.captures[0]}`), 'the first capture listed');
    await waitFor('the first Add', () => commands('mindSweepAdd') === adds + 1, 10_000);
    setProp('fail_commit', '1');
    owed = 'the injected failed Mind Sweep Add';
    const failedBefore = commands('mindSweepAdd', 'failed');
    nodes = await sweepAdd(names.captures[1], (current) => Boolean(owedRetry(current)), 'the injected failure');
    const pending = JSON.parse(runAs('cat no_backup/menu/pending'));
    seen = core('views');
    check(pending.kind === 'mindSweepAdd' && seen.tasks[names.captures[1]].length === 0 && commands('mindSweepAdd', 'failed') === failedBefore + 1,
        `(a) the failed Add stored nothing; its exact request (${pending.id}) is on disk`);
    if (process.env.MINDWTR_CHECK_THROW_AFTER_INJECT === '1') throw new Error('stopped on purpose after the injected failure (MINDWTR_CHECK_THROW_AFTER_INJECT=1); cleanup must settle it');
    setProp('fail_commit', '');
    await tapExpecting(owedRetry(await screen()), (current) => !owedRetry(current) && captured(current).includes(`• ${names.captures[1]}`), 'Try again');
    await waitFor('the retried Add', () => commands('mindSweepAdd') === adds + 2, 10_000);
    owed = null;
    seen = core('views');
    const [first, second] = names.captures.map((title) => seen.tasks[title]);
    check(first.length === 1 && second.length === 1 && first[0].status === 'inbox' && second[0].status === 'inbox' && second[0].id === pending.id.toLowerCase(),
        `(a) both captures are Inbox tasks, once each; the retried one under its request UUID`);


    await hideKeyboard();
    nodes = await tapExpecting(tagged(await screen(), 'mind-sweep-next') ?? fail('no Next'), (current) => groupTitle(current) === seen.groups[1], 'the second cue list');
    await rotateKeeps((current) => groupTitle(current) === seen.groups[1], 'the second cue list');
    nodes = await killAndRelaunch((current) => groupTitle(current) === seen.groups[1], 'the second cue list after process death');
    nodes = await tapExpecting(tagged(nodes, 'mind-sweep-back') ?? fail('no Back'), (current) => groupTitle(current) === seen.groups[0]
        && names.captures.every((title) => captured(current).includes(`• ${title}`)), 'the first cue list with its captures');
    check(true, '(b) rotation and process death keep the sweep\'s step and its captures');
    await tapExpecting(tagged(nodes, 'mind-sweep-close') ?? fail('no Close'), onInbox, 'Close');


    nodes = await tapExpecting(tab(await screen(), en['tab.menu']) ?? fail('no Menu tab'), sheetOpen, 'the More sheet');
    nodes = await device.settle(nodes);
    nodes = await tapExpecting(withDescription(nodes, names.search) ?? fail(`no saved search ${names.search} in the More sheet`),
        (current) => Boolean(tagged(current, 'menu-screen')) && hasText(current, seen.searchView.title) && taskRows(current).length >= seen.searchView.rows.length, 'the saved search');
    check(JSON.stringify(rowTitles(nodes)) === JSON.stringify(seen.searchView.rows) && seen.searchView.rows.length === 3,
        `(c) the saved search shows core's ${seen.searchView.rows.length} rows in core's order`);
    const deletes = commands('savedSearchDelete');
    const confirm = seen.searchView.confirm ?? fail('core offers no Delete');
    nodes = await tapExpecting(tagged(nodes, 'saved-search-delete') ?? fail('no Delete'), (current) => hasText(current, confirm.message), 'core\'s question');
    await tapExpecting(clickableAround(nodes, confirm.confirmLabel) ?? fail(`no "${confirm.confirmLabel}"`),
        (current) => !tagged(current, 'menu-screen') && Boolean(tab(current, en['tab.menu'])), 'the screen to close');
    await waitFor('the delete', () => commands('savedSearchDelete') === deletes + 1, 10_000);
    check(core('views').searches === 0, '(c) Delete, after core\'s question, deleted the saved search in one write');


    seen = core('views');
    check(JSON.stringify(seen.tokens) === JSON.stringify([names.context]), `core's Focus contexts matching ${names.query}: ${names.context}`);
    nodes = await tapExpecting(tab(await screen(), en['tab.next']) ?? fail('no Focus tab'), (current) => tabSelected(current, en['tab.next']), 'Focus');
    const focusSheet = (current) => hasText(current, en['filters.label']) && Boolean(withDescription(current, en['common.close']));
    nodes = await tapExpecting(withDescription(await device.toTop(), en['filters.label']) ?? fail('no Focus Filters button'), focusSheet, 'Focus\'s filter sheet');
    const search = `${en['common.search']} ${en['filters.contexts']}`;
    nodes = await tapExpecting(withDescription(nodes, `${en['filters.contexts']}: ${all}`) ?? fail('no contexts row'), (current) => Boolean(withDescription(current, search)), 'the contexts picker');
    await device.focusAtEnd(withDescription(nodes, search));
    requireAppFront();
    sh(`input text '${names.query}'`);
    nodes = await waitFor(`core's match ${names.context}`, (current) => Boolean(withDescription(current, names.context)) && !withDescription(current, names.other), 15_000);
    check(true, `(d) the picker's search shows core's match ${names.context}, not ${names.other}`);
    await hideKeyboard();
    nodes = await tapExpecting(button(await screen(), en['common.back']) ?? fail('no Back'), (current) => Boolean(withDescription(current, `${en['filters.contexts']}: ${all}`)), 'the sheet');
    await tapExpecting(button(nodes, en['common.done']) ?? fail('no Done'), (current) => !focusSheet(current), 'the sheet to close');


    nodes = await tapExpecting(tab(await screen(), en['tab.inbox']), onInbox, 'the Inbox tab');
    nodes = await device.reveal(names.captures[0], 60);
    await device.settle(nodes);
    await longPress(names.captures[0]);
    nodes = await waitFor('selection mode', (current) => selectedCount(current) === 1, 10_000);
    const keep = `${en['projects.areaLabel']}: ${en['bulk.keepArea']}`;
    nodes = await tapExpecting(withDescription(nodes, en['bulk.organize']) ?? fail('no Bulk organize'), (current) => Boolean(withDescription(current, keep)), 'Bulk organize');
    nodes = await tapExpecting(withDescription(nodes, keep), (current) => Boolean(tagged(current, 'organize-picker-search')), 'the area picker');
    const createLabel = `${en['areas.create']}: ${names.area}`;
    await device.focusAtEnd(tagged(nodes, 'organize-picker-search'));
    requireAppFront();
    sh(`input text '${names.area}'`);
    await waitFor('core\'s Create row', (current) => tagged(current, 'organize-create')?.['content-desc'] === createLabel, 15_000);
    await hideKeyboard();
    const creates = commands('bulkCreate');
    const chosen = `${en['projects.areaLabel']}: ${names.area}`;
    nodes = await tapExpecting(tagged(await device.settle(), 'organize-create'), (current) => !tagged(current, 'organize-picker-search') && Boolean(withDescription(current, chosen)), 'the new area chosen');
    await waitFor('the create', () => commands('bulkCreate') === creates + 1, 10_000);
    seen = core('views');
    const [areaId] = seen.areas;
    const before = seen.tasks[names.captures[0]][0];
    check(seen.areas.length === 1 && before.areaId === null, `(e) the picker created the area ${names.area} once; no task changed yet`);
    const applies = commands('bulkAction');
    await tapExpecting(withDescription(nodes, en['bulk.applyToSelected']) ?? fail('no Apply'), (current) => Number.isNaN(selectedCount(current)), 'Apply');
    await waitFor('the organize write', () => commands('bulkAction') === applies + 1, 10_000);
    const after = core('views').tasks[names.captures[0]][0];
    check(after.areaId === areaId && after.rev === before.rev + 1, `(e) Apply stored the new area on ${names.captures[0]} in one write`);
    console.log('Mind Sweep, saved search, Focus picker search and Bulk organize device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
