


import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, button, check, chipOn, connect, evidenced, fail, hasText, inEditor, Stopped, tab, tabSelected, tagged, taskRows, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-widget-list-device.mjs <adb-serial> [apk]');
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
const SCHEME = 'mindwtr-native-dev';
const UI_FILE = '/data/local/tmp/mindwtr-native-dev-ui.xml';
const DB = 'mindwtr-native-dev.db';
const work = resolve(app, 'android/build/widget-list-check');
const shots = resolve(process.env.MINDWTR_HARNESS_DIR ?? work, 'widget-list');
const coreSrc = resolve(app, '../../packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));
const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { adbRaw, sh, home, front, requireAppFront, screen, waitFor, tapExpecting } = device;
const runAs = (command) => sh(`run-as ${PKG} ${command}`);


const CONTEXT = `@wlc${run}`;
const FILTER_NAME = `Wlc ${run}`;
const titles = { b: `Wlc Bravo ${run}`, a: `Wlc Alpha ${run}` };

const core = (ids, contexts = []) => {
    const dir = resolve(work, 'db');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = runAs('ls files').split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    return JSON.parse(execFileSync('bun', ['-e', `
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
        if (!(await host.setLanguage({ storedLanguage: 'en', systemLocale: null })).ok) throw new Error('language');
        const ready = await host.activate({ writeSafetyReady: true });
        if (!ready.ok) throw new Error(ready.error.message);
        const value = (result) => { if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message); return result.value; };
        const views = Object.fromEntries(JSON.parse(process.env.CHECK_IDS).map((id) => {
            const view = value(host.getWidgetListView({ id, offset: 0, limit: 10 }));
            return [id, { found: view.found, contextsFilterId: view.contextsFilterId ?? null, title: view.title, total: view.total, rows: view.rows.map((row) => row.title), empty: view.empty?.message ?? null }];
        }));
        const store = useTaskStore.getState();
        const filters = (store.settings.savedFilters ?? []).map((filter) => filter.id);
        const contextsFilter = (store.settings.savedFilters ?? []).find((filter) => filter.name === process.env.CHECK_FILTER_NAME && filter.view === 'contexts' && !filter.deletedAt)?.id ?? null;
        const chips = value(host.getContextsView({ searchQuery: process.env.CHECK_CONTEXT.slice(1), offset: 0, limit: 1 })).chips;
        const contexts = JSON.parse(process.env.CHECK_CONTEXTS).map((input) => {
            const view = value(host.getContextsView({ ...input, offset: 0, limit: 20 }));
            return { rows: view.rows.map((row) => row.title), savedFilterId: view.savedFilterId, sortLabel: view.sort.accessibilityLabel,
                sort: view.sort.options.map(({ value, label, selected }) => ({ value, label, selected })) };
        });
        const more = value(host.getMoreMenu());
        console.log(JSON.stringify({ views, filters, contextsFilter, contexts, quickAccess: more.quickAccessView,
            tile: [...more.primary, ...more.utilities].find((item) => item.id === 'contexts')?.label ?? null, chip: chips.find((chip) => chip.id === process.env.CHECK_CONTEXT)?.accessibilityLabel ?? null,
            taskSortBy: store.settings.taskSortBy ?? 'default' }));
        process.exit(0);
    `], { encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, CHECK_DB: resolve(dir, DB), CHECK_IDS: JSON.stringify(ids), CHECK_CONTEXTS: JSON.stringify(contexts),
        CHECK_CONTEXT: CONTEXT, CHECK_FILTER_NAME: FILTER_NAME } })
        .trim().split('\n').pop());
};


const onInbox = (nodes) => !tagged(nodes, 'menu-screen') && tabSelected(nodes, en['tab.inbox']);
const header = (nodes, title) => tagged(nodes, 'menu-screen') && nodes.some((node) => node.text === title && node.class !== 'android.widget.EditText');
const rowTitles = (nodes) => taskRows(nodes).sort((a, b) => box(a)[1] - box(b)[1]).map((node) => node.text);

const openLink = (id) => {
    const current = front();
    if (!current.includes(`${PKG}/`) && !current.includes(`${home}/`)) throw new Stopped(`another app is in front: ${current.trim()}`);
    sh(`am start -W -a android.intent.action.VIEW -d '${SCHEME}:///widget-list/${encodeURIComponent(id)}' ${PKG}`);
};
const shot = (name) => {
    mkdirSync(shots, { recursive: true });
    const file = resolve(shots, `${name}-native.png`);
    writeFileSync(file, adbRaw('exec-out', 'screencap', '-p'));
    console.log(`screenshot ${file}`);
};

const expectList = async (id, view, label) => {
    openLink(id);
    const nodes = await waitFor(`${label}: the widget list "${view.title}"`, (current) => header(current, view.title)
        && (view.total === 0 || taskRows(current).length > 0), 30_000);
    const shown = rowTitles(nodes);
    check(!onInbox(nodes), `(${label}) the link opens the widget list, not the Inbox`);
    check(shown.length > 0 ? JSON.stringify(shown) === JSON.stringify(view.rows.slice(0, shown.length)) : view.total === 0,
        `(${label}) "${view.title}" shows core's first ${shown.length} of ${view.total} rows in core's order`);
    return nodes;
};
const inPopup = (nodes) => Boolean(tagged(nodes, 'quick-capture'));
const sheetOpen = (nodes) => Boolean(tagged(nodes, 'more-sheet'));
const onContexts = (nodes) => Boolean(tagged(nodes, 'contexts-list'));
const capture = async (text, shown) => {
    let nodes = await screen();
    if (!inPopup(nodes)) nodes = await device.openCapture();
    await device.focusAtEnd(tagged(nodes, 'capture-title') ?? fail('no capture field'));
    requireAppFront();
    sh(`input text '${text}'`);
    await waitFor(`"${shown}" in the capture field`, (current) => tagged(current, 'capture-title')?.text === shown, 15_000);
    await tapExpecting(button(await screen(), en['common.save']) ?? fail('no Save'), onInbox, 'the capture to close the popup');
};
const hideKeyboard = async () => {
    if (!/mInputShown=true/.test(sh('dumpsys input_method'))) return;
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await sleep(600);
};
const revealChip = async (name) => {
    let nodes = await screen();
    for (let step = 0; step < 40 && !withDescription(nodes, name); step += 1) {
        const row = nodes.find((node) => /^Wlc \d+$/.test(node['content-desc'] ?? ''));
        if (!row) break;
        const [, top, , bottom] = box(row);
        const y = Math.round((top + bottom) / 2);
        requireAppFront();
        sh(`input swipe 900 ${y} 300 ${y} 400`);
        await sleep(500);
        nodes = await screen();
    }
    return nodes;
};
const waitChip = async (on, description) => {
    const until = Date.now() + 20_000;
    for (;;) {
        const nodes = await revealChip(FILTER_NAME);
        if (Boolean(withDescription(nodes, FILTER_NAME)) && chipOn(nodes, FILTER_NAME) === on) return nodes;
        if (Date.now() > until) fail(`timed out waiting for ${description}`);
        await sleep(500);
    }
};
const backTo = async (done, description) => {
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    return waitFor(description, done, 15_000);
};

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const restore = async () => {
    try {
        for (let step = 0; step < 6 && front().includes(`${PKG}/`); step += 1) {
            const nodes = await screen();
            if (onInbox(nodes)) break;
            sh('input keyevent KEYCODE_BACK');
            await sleep(800);
        }
        const nodes = await screen();
        if (front().includes(`${PKG}/`) && tab(nodes, en['tab.inbox']) && !tabSelected(nodes, en['tab.inbox'])) await device.tap(tab(nodes, en['tab.inbox']));
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
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    device.launch(ACTIVITY);
    requireAppFront();
    sh('settings put system accelerometer_rotation 0');
    sh('settings put system user_rotation 0');
    await waitFor('the Inbox', onInbox, 60_000);
    const gone = `filter:gone-${run}`;
    let seen = core(['next', gone]);

    if (seen.filters.length > 0) seen = core(['next', gone, ...seen.filters.map((id) => `filter:${id}`)]);
    const filterId = seen.filters.map((id) => `filter:${id}`).find((id) => seen.views[id]?.found && !seen.views[id].contextsFilterId) ?? null;
    const next = seen.views.next;
    check(next.found && next.title === (en['nav.next'] ?? 'Next Actions') && next.total > 0, `core's Next Actions list holds ${next.total} tasks`);


    sh('input keyevent KEYCODE_HOME');
    await waitFor('the home screen', () => front().includes(`${home}/`), 10_000);
    let nodes = await expectList('next', next, 'a');
    await sleep(800);
    shot('next');
    const [first] = rowTitles(nodes);
    const action = await device.revealAction(nodes, first);

    const [al, at, ar, ab] = box(action);
    const label = (await screen()).find((node) => node.text && (() => { const [l, t, r, b] = box(node); return l >= al && t >= at && r <= ar && b <= ab; })())?.text;
    check(Boolean(label), `(a) a row's swipe shows RN's action "${label}" (not run)`);

    {
        const row = taskRows(await screen()).find((node) => node.text === first) ?? fail(`no row ${first}`);
        const [x1, y1, x2, y2] = box(row);
        const y = Math.round((y1 + y2) / 2);
        requireAppFront();

        const from = Math.round((x1 + x2) / 2);
        sh(`input swipe ${from} ${y} ${Math.max(from - 440, 160)} ${y} 300`);
        await waitFor('the tray to close', (current) => !current.some((node) => /swipe-\w+$/.test(node['resource-id'] ?? '')), 8_000);
    }
    nodes = await tapExpecting(taskRows(await screen()).find((node) => node.text === first) ?? fail(`no row ${first}`), inEditor, `the editor for ${first}`);
    check(nodes.some((node) => node.text === first), `(a) the row's tap opens the editor on ${first}`);
    nodes = await backTo((current) => !inEditor(current) && header(current, next.title), 'the widget list again');
    check(true, '(a) Back closes the editor onto the widget list');
    await backTo(onInbox, 'the tabs');
    check(true, '(a) Back leaves the widget list');


    if (filterId) {
        const view = seen.views[filterId];
        check(view.found, `core finds the saved filter ${filterId} ("${view.title}", ${view.total} tasks)`);
        await expectList(filterId, view, 'b');
        await backTo(onInbox, 'the tabs');
    } else {
        console.log(`skip - (b) none of the device's ${seen.filters.length} saved filters opens as a widget list`);
    }


    await capture(`${titles.b}%s${CONTEXT}`, `${titles.b} ${CONTEXT}`);
    await capture(`${titles.a}%s${CONTEXT}`, `${titles.a} ${CONTEXT}`);
    seen = core([gone]);
    nodes = await screen();
    if (seen.quickAccess === 'contexts') await tapExpecting(tab(nodes, en['nav.contexts']) ?? fail('no Contexts tab'), onContexts, 'the Contexts tab');
    else {
        if (!sheetOpen(nodes)) nodes = await tapExpecting(tab(nodes, en['tab.menu']) ?? fail('no Menu tab'), sheetOpen, 'the More sheet');
        nodes = await device.settle(nodes);
        await tapExpecting(withDescription(nodes, seen.tile) ?? fail(`no ${seen.tile} tile`), onContexts, 'Contexts');
    }
    nodes = await waitFor('the chip search', (current) => Boolean(tagged(current, 'list-search')));
    await device.focusAtEnd(tagged(nodes, 'list-search'));
    requireAppFront();
    sh(`input text '${CONTEXT.slice(1)}'`);
    nodes = await waitFor(`core's chip "${seen.chip}"`, (current) => Boolean(seen.chip && withDescription(current, seen.chip)), 15_000);
    await hideKeyboard();
    await tapExpecting(withDescription(await screen(), seen.chip), (current) => chipOn(current, seen.chip), `${CONTEXT} chosen`);
    await device.focusAtEnd(tagged(await screen(), 'list-search'));
    requireAppFront();
    sh(`input keyevent ${Array(CONTEXT.length + 2).fill('KEYCODE_DEL').join(' ')}`);
    await waitFor('the search to clear', (current) => tagged(current, 'list-search')?.text !== CONTEXT.slice(1) && taskRows(current).length === 2, 15_000);
    await hideKeyboard();
    const filterSheet = (current) => Boolean(withDescription(current, en['filters.label'])) && hasText(current, en['filters.label']);
    await tapExpecting(withDescription(await screen(), en['filters.label']) ?? fail('no Filters control'), filterSheet, 'the filter sheet');
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await waitFor('the Save control', (current) => !filterSheet(current) && Boolean(withDescription(current, en['common.save'])), 15_000);
    nodes = await tapExpecting(withDescription(await screen(), en['common.save']), (current) => Boolean(tagged(current, 'menu-dialog-field')), 'the Save filter dialog');
    await device.focusAtEnd(tagged(nodes, 'menu-dialog-field'));
    requireAppFront();
    sh(`input text '${FILTER_NAME.replace(' ', '%s')}'`);
    nodes = await waitFor('the filter name', (current) => tagged(current, 'menu-dialog-field')?.text === FILTER_NAME, 10_000);
    const dialogSave = nodes.filter((node) => node['content-desc'] === en['common.save']).sort((a, b) => box(b)[1] - box(a)[1])[0];
    await tapExpecting(dialogSave ?? fail('no Save in the dialog'), (current) => !tagged(current, 'menu-dialog-field'), 'the Save filter dialog to close');
    nodes = await waitChip(true, 'the saved filter chip');
    await tapExpecting(withDescription(nodes, FILTER_NAME), (current) => !chipOn(current, FILTER_NAME), 'the saved filter cleared');
    seen = core([], []);
    const contextsId = seen.contextsFilter ?? fail(`core stores no Contexts saved filter "${FILTER_NAME}"`);
    seen = core([`filter:${contextsId}`], [{ savedFilterId: contextsId, sortOverride: null }]);
    const savedView = seen.contexts[0];
    check(seen.views[`filter:${contextsId}`].contextsFilterId === contextsId && savedView.rows.length === 2,
        `core names "${FILTER_NAME}" a Contexts filter with ${savedView.rows.length} rows`);
    const globalSort = seen.taskSortBy;
    if (seen.quickAccess === 'contexts') await tapExpecting(tab(await screen(), en['tab.inbox']), onInbox, 'the Inbox');
    else await backTo(onInbox, 'the tabs');
    sh('input keyevent KEYCODE_HOME');
    await waitFor('the home screen', () => front().includes(`${home}/`), 10_000);
    openLink(`filter:${contextsId}`);
    nodes = await waitFor(`(d) the Contexts screen with core's rows for "${FILTER_NAME}"`, (current) => onContexts(current)
        && JSON.stringify(rowTitles(current).filter((title) => Object.values(titles).includes(title))) === JSON.stringify(savedView.rows), 30_000);
    nodes = await waitChip(true, `(d) the "${FILTER_NAME}" chip selected`);
    check(true, `(d) the saved Contexts filter link opens the Contexts screen with "${FILTER_NAME}" selected and core's rows ${JSON.stringify(savedView.rows)}`);
    await sleep(800);
    shot('contexts-filter');
    const shownSort = savedView.sort.find((option) => option.selected) ?? fail('core marks no Contexts sort');
    const pick = savedView.sort.find((option) => option.value === (shownSort.value === 'created' ? 'title' : 'created')) ?? fail('core offers no created sort');
    seen = core([], [{ savedFilterId: contextsId, sortOverride: pick.value }]);
    const overridden = seen.contexts[0];
    nodes = await tapExpecting(withDescription(await screen(), savedView.sortLabel) ?? fail(`no sort control "${savedView.sortLabel}"`), (current) => hasText(current, pick.label), 'the sort modal');
    await tapExpecting(nodes.find((node) => node.text === pick.label), (current) => !hasText(current, pick.label) && onContexts(current)
        && JSON.stringify(rowTitles(current).filter((title) => Object.values(titles).includes(title))) === JSON.stringify(overridden.rows), 'the overridden order');
    seen = core([], []);
    check(seen.taskSortBy === globalSort && chipOn(await revealChip(FILTER_NAME), FILTER_NAME) && JSON.stringify(overridden.rows) !== JSON.stringify(savedView.rows),
        `(d) Sort "${pick.label}" reorders the saved filter to ${JSON.stringify(overridden.rows)} and keeps the global sort "${globalSort}"`);
    shot('contexts-filter-sorted');
    await backTo(onInbox, 'the tabs');


    const missing = seen.views[gone] ?? core([gone]).views[gone];
    check(!missing.found && missing.title === en['search.noResults'] && missing.empty === en['search.noResults'], 'core answers a gone filter with "No results"');
    nodes = await expectList(gone, missing, 'c');
    check(taskRows(nodes).length === 0 && nodes.filter((node) => node.text === missing.empty).length === 2, '(c) the header and the empty line read "No results", with no row');
    shot('gone');
    check(!button(nodes, en['common.more']), '(c) no More');
    await backTo(onInbox, 'the tabs');
    console.log('Widget list device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
