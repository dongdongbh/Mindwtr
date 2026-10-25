// Toolbars and selection mode check for the isolated native Android development app.
//
//   node apps/android-native/scripts/check-toolbars-device.mjs <adb-serial> [apk]
//
// Installs the debug APK with `install -r` (existing development data stays), captures six tasks with titles unique to this
// run (A with the fixed context @6901 and B in the Inbox, C and D starred, E and F archived), and checks against core's own
// views on a copy of the app's database: (a) the Inbox's Filters picker, found through its search, narrows the rows as core
// does, and Clear widens them; a sort choice is one write and the rows follow core's order; (b) rotation and process death keep
// the Inbox's open filter sheet and its selection; (c) a bulk move of the two selected rows is one core write; (d) the @6901
// Focus filter narrows Focus as core does, its Save under an injected failed commit stores nothing and Try again stores one
// saved filter under its request UUID, which is then deleted; (e) Focus's Reorder drag writes only the moved tasks; (f)
// Archived: a completion time stores core's picked value once, and Select all → Restore to Inbox moves exactly core's rows.
// Back leaves each mode before its screen (RN's #1415, ca5eee151, 90a0e079e): the Inbox's selection, Focus's Reorder and
// Archived's selection each end on Back, with the screen still open. It
// touches only the development package (it refuses any other APK), never launches over another app, puts the Inbox sort back,
// restores rotation and clears its debug properties on exit. Leave the device on its home screen before running. It needs host
// `bun`, and Android 11 or later (the reorder drag uses `input motionevent`).
// Exit 0 = pass, 1 = fail, 2 = refused before touching the device, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { EDGE_SAFE_X, box, button, check, connect, evidenced, fail, hasText, inboxCount, isOn, owedRetry, Stopped, tab, tabSelected, tagged, taskRows, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-toolbars-device.mjs <adb-serial> [apk]');
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
const PROPS = ['fail_commit', 'delay_before_ms', 'delay_after_ms', 'language'];
const DB = 'mindwtr-native-dev.db';
const work = resolve(app, 'android/build/toolbars-check');
const coreSrc = resolve(app, '../../packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));
// Digits for titles and tokens: the keyboard guard allows only an English layout, and digits never compose.
const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const titles = { a: `69${run}1`, b: `69${run}2`, c: `69${run}3`, d: `69${run}4`, e: `69${run}5`, f: `69${run}6` };
// One fixed context, so runs add no new token.
const CONTEXT = '@6901';

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting } = device;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
// Core on the copy runs in the phone's time zone: a completion time is a local day and time.
const timeZone = sh('getprop persist.sys.timezone') || undefined;
const commands = (operation, outcome = 'saved') => device.logs(pid(), TAG).replace(/\\/g, '').split('\n').filter((line) => line.includes('native-android-dev-task-command')
    && line.includes(`"operation":"${operation}"`) && line.includes(`"outcome":"${outcome}"`)).length;

// ---- core on a copy of the app's database ----
const pullDatabase = () => {
    const dir = resolve(work, 'db');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = sh(`run-as ${PKG} ls files`).split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    return resolve(dir, DB);
};
/** Core's views on a copy (the first window of each), and the stored tasks titled as this run's. */
const core = () => JSON.parse(execFileSync('bun', ['-e', `
    import { Database } from 'bun:sqlite';
    import { SqliteAdapter, createNativeHostContract, setStorageAdapter, useTaskStore } from '${coreSrc}/index.ts';
    import { resolvePickedCompletedAt } from '${coreSrc}/archive-view-model.ts';
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
    const page = { offset: 0, limit: 50 };
    const rows = (items) => items.flatMap((item) => (item.type === 'task' ? [item.row.title] : []));
    const context = process.env.CHECK_CONTEXT;
    const inbox = value(host.getInboxView(page));
    const inboxFiltered = value(host.getInboxView({ ...page, filters: { tokens: [context] } }));
    const focusRows = (view) => view.sections.flatMap((section) => section.rows.map((row) => row.title));
    const focus = value(host.getFocus({ limit: 50, controls: {} }));
    const focusFiltered = value(host.getFocus({ limit: 50, controls: { filters: { tokens: [context] } } }));
    const archive = value(host.getArchiveView({ ...page, filters: { searchQuery: process.env.CHECK_RUN } }));
    const store = useTaskStore.getState();
    const live = store._allTasks.filter((task) => !task.deletedAt);
    const stored = Object.fromEntries(Object.values(JSON.parse(process.env.CHECK_TITLES)).map((title) => [title,
        live.filter((task) => task.title === title).map((task) => ({ id: task.id, status: task.status, completedAt: task.completedAt ?? null }))]));
    console.log(JSON.stringify({
        sortBy: store.settings.taskSortBy ?? 'default',
        sort: inbox.toolbar.sort.options.map(({ value, label, selected }) => ({ value, label, selected })),
        inbox: rows(inbox.items),
        inboxFiltered: rows(inboxFiltered.items),
        focus: focusRows(focus),
        focusFiltered: focusRows(focusFiltered),
        reorder: focus.controls.reorder ? focus.controls.reorder.rows.items.map(({ id, title, positionLabel }) => ({ id, title, positionLabel })) : [],
        focused: Object.fromEntries(live.filter((task) => task.isFocusedToday).map((task) => [task.id, { order: task.focusOrder ?? null, rev: task.rev ?? null, updatedAt: task.updatedAt }])),
        savedFilters: (store.settings.savedFilters ?? []).map(({ id, name, deletedAt }) => ({ id, name, deletedAt: deletedAt ?? null })),
        archive: archive.items.flatMap((item) => (item.type === 'task' ? [{ title: item.row.title, id: item.row.id,
            expected: item.completedAtPicker ? resolvePickedCompletedAt(item.completedAtPicker.day, item.completedAtPicker.time) : null }] : [])),
        archivedCount: live.filter((task) => task.status === 'archived').length,
        historyTile: value(host.getMoreMenu()).primary.concat(value(host.getMoreMenu()).utilities).find((item) => item.id === 'history').label,
        stored,
    }));
    process.exit(0);
`], { encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, TZ: timeZone, CHECK_DB: pullDatabase(), CHECK_TITLES: JSON.stringify(titles), CHECK_CONTEXT: CONTEXT, CHECK_RUN: run } })
    .trim().split('\n').pop());

// ---- UI (core's English) ----
const inPopup = (nodes) => Boolean(tagged(nodes, 'quick-capture'));
const onInbox = (nodes) => !inPopup(nodes) && !tagged(nodes, 'menu-screen') && tabSelected(nodes, en['tab.inbox']) && Number.isFinite(inboxCount(nodes));
const inScreen = (title) => (nodes) => Boolean(tagged(nodes, 'menu-screen')) && hasText(nodes, title);
const sheetOpen = (nodes) => Boolean(tagged(nodes, 'more-sheet'));
// A clickable row's label can sit on a child node with the row's own bounds (Archived's rows): read it there.
const rowLabel = (nodes, row) => row.text || row['content-desc']
    || nodes.find((node) => node !== row && node.bounds === row.bounds && (node.text || node['content-desc']))?.['content-desc'] || '';
const rowTitles = (nodes) => taskRows(nodes).sort((a, b) => box(a)[1] - box(b)[1]).map((node) => rowLabel(nodes, node));
const selectedCount = (nodes) => Number(nodes.map((node) => new RegExp(`^(\\d+) ${en['bulk.selected']}$`).exec(node.text ?? '')?.[1]).find(Boolean) ?? NaN);
const filterSheet = (nodes) => Boolean(withDescription(nodes, en['filters.label'])) && hasText(nodes, en['filters.label']);
const all = en['common.all'];
/** Opens the popup from + and saves [text] ('%s' is a space for `input text`); the popup closes on Save, as in RN. */
const capture = async (text, shown) => {
    let nodes = await screen();
    if (!inPopup(nodes)) nodes = await device.openCapture();
    await device.focusAtEnd(tagged(nodes, 'capture-title') ?? fail('no capture field'));
    requireAppFront();
    sh(`input text '${text}'`);
    await waitFor(`"${shown}" in the capture field`, (current) => tagged(current, 'capture-title')?.text === shown, 15_000);
    await tapExpecting(button(await screen(), en['common.save']) ?? fail('no Save'), onInbox, 'the capture to close the popup');
};
/** Types [text] into the field labelled [label] (its end focused first). */
const typeInto = async (label, text) => {
    await device.focusAtEnd(withDescription(await screen(), label) ?? fail(`no field "${label}"`));
    requireAppFront();
    sh(`input text '${text}'`);
    // A field that holds text reports no content-desc on this phone, so the typed text is read from the focused field.
    return waitFor(`"${text}" in "${label}"`, (current) => current.find((node) => node.class === 'android.widget.EditText' && node.focused === 'true')?.text === text, 10_000);
};
const back = async (done) => {
    requireAppFront();
    // An open keyboard takes the first Back (run 50 stayed on History), so close it first.
    if (/mInputShown=true/.test(sh('dumpsys input_method'))) {
        sh('input keyevent KEYCODE_BACK');
        await waitFor('the keyboard to close', () => !/mInputShown=true/.test(sh('dumpsys input_method')), 5_000);
    }
    sh('input keyevent KEYCODE_BACK');
    return waitFor('Back', done, 15_000);
};
/** A long-press on the row titled [title] (RN starts selection mode with it), well inside the row. */
const longPress = async (title) => {
    const row = taskRows(await screen()).find((node) => node.text === title) ?? fail(`no row ${title} on screen`);
    const [x1, y1, x2, y2] = box(row);
    const x = Math.max(Math.round((x1 + x2) / 2), EDGE_SAFE_X);
    requireAppFront();
    sh(`input swipe ${x} ${Math.round((y1 + y2) / 2)} ${x} ${Math.round((y1 + y2) / 2)} 900`);
    await sleep(600);
};
/** RN's hold-then-drag (the reorder screen): a finger down, held past the long press, moved in steps, and lifted. */
const holdAndDrag = async (x, y, toY) => {
    requireAppFront();
    const steps = 8;
    const moves = Array.from({ length: steps }, (_, index) => `input motionevent MOVE ${x} ${Math.round(y + ((toY - y) * (index + 1)) / steps)}`);
    sh(`input motionevent DOWN ${x} ${y}; sleep 0.8; ${moves.join('; ')}; sleep 0.3; input motionevent UP ${x} ${toY}`);
    await sleep(1200);
};
/** Taps [node] only after the screen holds still (a list that grows moves the row under the finger). */
const tapStill = async (find, expected, description) => {
    const nodes = await device.settle();
    return tapExpecting(find(nodes) ?? fail(`no ${description} target on screen`), expected, description);
};

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const restore = async () => {
    for (const name of PROPS) { try { setProp(name, ''); } catch { /* device gone */ } }
    // Leave the app on its Inbox tab: the other checks start there.
    try {
        for (let step = 0; step < 4 && front().includes(`${PKG}/`); step += 1) {
            const nodes = await screen();
            if (!tagged(nodes, 'menu-screen') && !sheetOpen(nodes) && !filterSheet(nodes) && Number.isNaN(selectedCount(nodes))) break;
            sh('input keyevent KEYCODE_BACK');
            await sleep(800);
        }
        const nodes = await screen();
        if (front().includes(`${PKG}/`) && tab(nodes, en['tab.inbox']) && !tabSelected(nodes, en['tab.inbox'])) await tap(tab(nodes, en['tab.inbox']));
    } catch { /* the app is gone */ }
    for (const [name, value] of [['user_rotation', originalRotation], ['accelerometer_rotation', originalAccelerometer]]) {
        try { sh(value === 'null' ? `settings delete system ${name}` : `settings put system ${name} ${value}`); } catch { /* device gone */ }
    }
    try { sh(`rm -f ${UI_FILE}`); } catch { /* device gone */ }
};

let originalSort = null;
/** The Inbox's Sort control, then core's option labelled [label] in the modal. */
const chooseSort = async (label) => {
    const control = (await screen()).find((node) => node['content-desc']?.startsWith(`${en['sort.label']}: `)) ?? fail('no Sort control');
    const nodes = await tapExpecting(control, (current) => hasText(current, label), 'the sort modal');
    await tapExpecting(nodes.find((node) => node.text === label), (current) => !hasText(current, label), 'the modal to close');
};

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    if (Number(sh('getprop ro.build.version.sdk')) < 30) throw new Stopped('the reorder drag needs `input motionevent` (Android 11 or later)');
    for (const name of PROPS) setProp(name, '');
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    device.launch(ACTIVITY);
    requireAppFront();
    sh('settings put system accelerometer_rotation 0');
    sh('settings put system user_rotation 0');
    await waitFor('the Inbox', onInbox, 60_000);

    // The run's own captures, with core's quick-add tokens: a context, the star (/*), and Archived.
    await capture(`${titles.a}%s${CONTEXT}`, `${titles.a} ${CONTEXT}`);
    await capture(titles.b, titles.b);
    await capture(`${titles.c}%s/*`, `${titles.c} /*`);
    await capture(`${titles.d}%s/*`, `${titles.d} /*`);
    await capture(`${titles.e}%s/archived`, `${titles.e} /archived`);
    await capture(`${titles.f}%s/archived`, `${titles.f} /archived`);
    let seen = core();
    check(Object.values(titles).every((title) => seen.stored[title].length === 1), 'the six captures are stored once each');

    // (a) The sort: core's option other than the stored one (Newest puts this run's captures on top), one write, core's order.
    originalSort = seen.sort.find((option) => option.selected) ?? fail('core marks no sort selected');
    const pick = seen.sort.find((option) => option.value === (originalSort.value === 'created-desc' ? 'created' : 'created-desc')) ?? fail('core offers no created sort');
    const sortsBefore = commands('taskListSort');
    await chooseSort(pick.label);
    await waitFor('the sort write', () => commands('taskListSort') === sortsBefore + 1, 10_000);
    seen = core();
    let nodes = await device.toTop();
    nodes = await waitFor('core\'s sorted Inbox', (current) => {
        const shown = rowTitles(current);
        return shown.length > 0 && JSON.stringify(shown) === JSON.stringify(seen.inbox.slice(0, shown.length));
    }, 15_000);
    check(seen.sortBy === pick.value && commands('taskListSort') === sortsBefore + 1, `(a) Sort "${pick.label}" is one setTaskListSort write, and the rows follow core's order`);
    if (pick.value === 'created') {
        // The stored sort was Newest already: put it back now, so this run's captures sit on top.
        await chooseSort(originalSort.label);
        await waitFor('the sort back', () => core().sortBy === originalSort.value, 10_000);
        originalSort = null;
        seen = core(); // the filtered rows below follow the restored sort
    }

    // (a) Filters: the contexts picker, found through its search, narrows the Inbox as core does; Clear widens it again.
    nodes = await device.toTop();
    nodes = await tapExpecting(withDescription(nodes, `${en['filters.label']}: ${all}`) ?? fail('no Filters control'), filterSheet, 'the filter sheet');
    nodes = await tapExpecting(withDescription(nodes, `${en['filters.contexts']}: ${all}`) ?? fail('no contexts row'),
        (current) => Boolean(withDescription(current, `${en['common.search']} ${en['filters.contexts']}`)), 'the contexts picker');
    await typeInto(`${en['common.search']} ${en['filters.contexts']}`, CONTEXT.slice(1));
    nodes = await waitFor(`core's match ${CONTEXT}`, (current) => Boolean(withDescription(current, CONTEXT)), 10_000);
    await tapExpecting(withDescription(nodes, CONTEXT), (current) => isOn(withDescription(current, CONTEXT))
        || current.some((node) => node.text === en['bulk.selected']), `${CONTEXT} chosen`);
    nodes = await tapExpecting(button(await screen(), en['common.back']) ?? fail('no Back'), (current) => Boolean(withDescription(current, `${en['filters.contexts']}: ${CONTEXT}`)), 'the sheet');
    await tapExpecting(button(nodes, en['common.done']) ?? fail('no Done'), (current) => !filterSheet(current), 'the sheet to close');
    nodes = await waitFor('the narrowed Inbox', (current) => {
        const shown = rowTitles(current);
        return shown.includes(titles.a) && !shown.includes(titles.b) && JSON.stringify(shown) === JSON.stringify(seen.inboxFiltered.slice(0, shown.length));
    }, 15_000);
    check(Boolean(withDescription(nodes, `${en['filters.remove']}: ${CONTEXT}`)), `(a) ${CONTEXT} (picked through the picker's search) narrows the Inbox to core's rows, with its chip`);
    await tapExpecting(button(nodes, en['filters.clear']) ?? fail('no Clear'), (current) => rowTitles(current).includes(titles.b), 'Clear');
    check(true, '(a) Clear widens the Inbox again');

    // (b) Selection mode and the open filter sheet survive rotation and process death.
    nodes = await device.settle(await device.toTop());
    await longPress(titles.a);
    nodes = await waitFor('selection mode', (current) => selectedCount(current) === 1, 10_000);
    nodes = await tapExpecting(withDescription(nodes, `${en['filters.label']}: ${all}`) ?? fail('no Filters control'), filterSheet, 'the filter sheet');
    // The sheet is its own window, so the "1 selected" bar under it is not in the dump; (c) reads it after Back.
    const kept = filterSheet;
    sh('settings put system user_rotation 1');
    await waitFor('landscape: the sheet over one selected row', kept, 20_000);
    sh('settings put system user_rotation 0');
    await waitFor('portrait: the sheet over one selected row', kept, 20_000);
    const processId = pid();
    requireAppFront();
    sh('input keyevent KEYCODE_HOME');
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    await sleep(1500);
    sh(`run-as ${PKG} kill -9 ${processId}`);
    await waitFor('process death', () => pid() !== processId, 10_000);
    device.launch(ACTIVITY);
    await waitFor('the sheet over one selected row after process death', kept, 60_000);
    check(true, '(b) rotation and process death keep the Inbox\'s filter sheet open');

    // (c) The sheet closes on Back; a tap adds B; Move to Next is one write for both rows, as core plans it.
    nodes = await back((current) => !filterSheet(current) && selectedCount(current) === 1);
    check(true, '(b) the selection is still one row after rotation and process death');
    nodes = await tapStill((current) => taskRows(current).find((node) => node.text === titles.b), (current) => selectedCount(current) === 2, 'B selected');
    const bulkBefore = commands('bulkAction');
    const moveNext = `${en['bulk.moveTo']} ${en['status.next']}`;
    await tapExpecting(withDescription(nodes, moveNext) ?? fail(`no "${moveNext}"`), (current) => Number.isNaN(selectedCount(current)), 'the move to end selection mode');
    await waitFor('the bulk write', () => commands('bulkAction') === bulkBefore + 1, 10_000);
    seen = core();
    check(seen.stored[titles.a][0].status === 'next' && seen.stored[titles.b][0].status === 'next' && commands('bulkAction') === bulkBefore + 1,
        '(c) Move to Next on two selected rows is one bulk write; both are stored Next');
    // (c) Back leaves selection mode first: the Inbox stays open with no row selected.
    nodes = await device.settle(await device.toTop());
    await longPress(taskRows(nodes).sort((a, b) => box(a)[1] - box(b)[1])[0]?.text ?? fail('no Inbox row to select'));
    await waitFor('selection mode', (current) => selectedCount(current) === 1, 10_000);
    nodes = await back((current) => Number.isNaN(selectedCount(current)));
    check(tabSelected(nodes, en['tab.inbox']) && Number.isFinite(inboxCount(nodes)), '(c) Back ended the Inbox\'s selection mode, and the Inbox stayed open');

    // (d) Focus: the @6901 filter narrows Focus as core does.
    nodes = await tapExpecting(tab(await screen(), en['tab.next']) ?? fail('no Focus tab'), (current) => tabSelected(current, en['tab.next']), 'Focus');
    const focusSheet = (current) => hasText(current, en['filters.label']) && Boolean(withDescription(current, en['common.close']));
    nodes = await tapExpecting(withDescription(await device.toTop(), en['filters.label']) ?? fail('no Focus Filters button'), focusSheet, 'Focus\'s filter sheet');
    nodes = await tapExpecting(withDescription(nodes, `${en['filters.contexts']}: ${all}`) ?? fail('no contexts row'),
        (current) => Boolean(withDescription(current, CONTEXT)), 'the contexts picker');
    await tapExpecting(withDescription(nodes, CONTEXT), (current) => isOn(withDescription(current, CONTEXT)), `${CONTEXT} chosen`);
    nodes = await tapExpecting(button(await screen(), en['common.back']) ?? fail('no Back'), (current) => Boolean(withDescription(current, `${en['filters.contexts']}: ${CONTEXT}`)), 'the sheet');
    const focusRowsShown = (current) => taskRows(current).map((node) => node.text);
    nodes = await tapExpecting(button(nodes, en['common.done']) ?? fail('no Done'), (current) => !focusSheet(current), 'the sheet to close');
    // Earlier runs' A rows (Next, @6901) stay in Focus, so this run's A can sit below the fold under the timer card: reveal it.
    await waitFor('the narrowed Focus', (current) => focusRowsShown(current).length > 0 && !focusRowsShown(current).includes(titles.b)
        && focusRowsShown(current).every((title) => seen.focusFiltered.includes(title)), 15_000);
    nodes = await device.reveal(titles.a);
    if (!focusRowsShown(nodes).includes(titles.a)) fail(`this run's A (${titles.a}) is not in the narrowed Focus`);
    check(focusRowsShown(nodes).every((title) => seen.focusFiltered.includes(title)) && !seen.focusFiltered.includes(titles.b),
        `(d) ${CONTEXT} narrows Focus to core's rows (${seen.focusFiltered.length})`);

    // (d) Save the filter under a failed commit: nothing stored, the request UUID on disk; Try again stores one saved filter.
    nodes = await tapExpecting(withDescription(await device.toTop(), en['filters.label']) ?? fail('no Focus Filters button'), focusSheet, 'Focus\'s filter sheet');
    const saveLabel = 'Save';
    nodes = await tapExpecting(withDescription(nodes, saveLabel) ?? fail('no Save in the sheet'), (current) => Boolean(withDescription(current, 'Filter name')), 'the Save filter dialog');
    setProp('fail_commit', '1');
    nodes = await tapExpecting(button(nodes, saveLabel) ?? fail('no Save in the dialog'), (current) => Boolean(owedRetry(current)), 'the injected failure');
    const requestId = JSON.parse(sh(`run-as ${PKG} cat no_backup/menu/pending`)).id;
    check(!core().savedFilters.some((filter) => filter.id === requestId.toLowerCase()), `(d) the failed commit stored no saved filter; its request (${requestId}) is on disk`);
    setProp('fail_commit', '');
    await tapExpecting(owedRetry(await screen()), (current) => !owedRetry(current) && !withDescription(current, 'Filter name'), 'Try again');
    seen = core();
    const saved = seen.savedFilters.filter((filter) => filter.id === requestId.toLowerCase());
    check(saved.length === 1 && saved[0].deletedAt === null && commands('focusSave') === 1 && commands('focusSave', 'failed') >= 1,
        `(d) Try again stored one saved filter "${saved[0]?.name}" under its request UUID`);
    const deleteLabel = `${en['common.delete']} saved filter ${saved[0].name}`;
    nodes = await waitFor('the saved filter chip', (current) => Boolean(withDescription(current, deleteLabel)), 10_000);
    nodes = await tapExpecting(withDescription(nodes, deleteLabel), (current) => Boolean(button(current, en['common.delete'])), 'the delete question');
    await tapExpecting(button(nodes, en['common.delete']), (current) => !withDescription(current, deleteLabel), 'the chip to go');
    check(core().savedFilters.find((filter) => filter.id === requestId.toLowerCase())?.deletedAt !== null && commands('focusDelete') === 1,
        '(d) its delete (after core\'s question) is one write');
    await tapExpecting(button(await screen(), en['filters.clear']) ?? fail('no Clear'), (current) => !button(current, en['filters.clear']), 'Clear');

    // (e) Reorder: the last of Today's Focus dragged up one place is one write, and only the tasks whose place changed are written.
    seen = core();
    if (seen.reorder.length < 2) fail(`Today's Focus has ${seen.reorder.length} starred task(s); the drag needs two`);
    const order = seen.reorder.map((row) => row.id);
    const expectedOrder = [...order.slice(0, -2), order.at(-1), order.at(-2)];
    const before = seen.focused;
    nodes = await device.toTop();
    nodes = await tapExpecting(withDescription(nodes, en['projects.reorderTasks']) ?? fail('no Reorder'),
        (current) => Boolean(withDescription(current, seen.reorder.at(-1).positionLabel)), 'the reorder screen');
    nodes = await device.settle(nodes);
    const last = withDescription(nodes, seen.reorder.at(-1).positionLabel) ?? fail('the last row is not on screen');
    const above = withDescription(nodes, seen.reorder.at(-2).positionLabel) ?? fail('the row above it is not on screen');
    const [lx1, ly1, lx2, ly2] = box(last);
    const [, ay1, , ay2] = box(above);
    const reordersBefore = commands('focusReorder');
    await holdAndDrag(Math.max(Math.round((lx1 + lx2) / 2), EDGE_SAFE_X), Math.round((ly1 + ly2) / 2), Math.round((ay1 + ay2) / 2));
    await waitFor('the reorder write', () => commands('focusReorder') === reordersBefore + 1, 10_000);
    seen = core();
    check(JSON.stringify(seen.reorder.map((row) => row.id)) === JSON.stringify(expectedOrder) && commands('focusReorder') === reordersBefore + 1,
        '(e) the drop is one reorderFocus write, and Today\'s Focus has core\'s new order');
    const rewritten = order.filter((id) => seen.focused[id]?.rev !== before[id]?.rev).sort();
    const replaced = order.filter((id) => seen.focused[id]?.order !== before[id]?.order).sort();
    check(rewritten.length > 0 && JSON.stringify(rewritten) === JSON.stringify(replaced), `(e) only the ${replaced.length} task(s) whose place changed were written`);
    await tapExpecting(button(await screen(), en['common.done']) ?? fail('no Done'), (current) => !withDescription(current, seen.reorder[0].positionLabel), 'Done');
    // (e) Back leaves Reorder first: Focus stays open.
    nodes = await tapExpecting(withDescription(await device.toTop(), en['projects.reorderTasks']) ?? fail('no Reorder'),
        (current) => Boolean(withDescription(current, seen.reorder[0].positionLabel)), 'the reorder screen again');
    nodes = await back((current) => !withDescription(current, seen.reorder[0].positionLabel));
    check(tabSelected(nodes, en['tab.next']), '(e) Back ended Reorder, and Focus stayed open');

    // (f) Archived: this run's two rows (core's search), a completion time, then Select all → Restore to Inbox.
    nodes = await tapExpecting(tab(await screen(), en['tab.menu']) ?? fail('no Menu tab'), sheetOpen, 'the More sheet');
    nodes = await tapExpecting(withDescription(await device.settle(nodes), seen.historyTile) ?? fail('no History tile'), inScreen(en['nav.history']), 'History');
    nodes = await tapExpecting(tab(nodes, en['nav.archived']), (current) => tabSelected(current, en['nav.archived']), 'the Archived tab');
    await typeInto(en['common.search'], run);
    seen = core();
    nodes = await waitFor('core\'s two rows', (current) => JSON.stringify(rowTitles(current)) === JSON.stringify(seen.archive.map((row) => row.title)), 15_000);
    check(seen.archive.length === 2, '(f) Archived\'s search shows core\'s two rows for this run');
    const rowE = withDescription(nodes, titles.e) ?? fail('no E row');
    const [, ey1, , ey2] = box(rowE);
    const dateE = nodes.find((node) => node['content-desc'] === en['task.editCompletedAt'] && box(node)[1] >= ey1 && box(node)[3] <= ey2) ?? fail('no completion time on E');
    const archiveBefore = commands('archiveAction');
    nodes = await tapExpecting(dateE, (current) => Boolean(button(current, en['common.ok'])), 'the date dialog');
    await sleep(800);
    nodes = await tapExpecting(button(await screen(), en['common.ok']), (current) => Boolean(button(current, en['common.ok'])), 'the time dialog');
    await sleep(800);
    await tapExpecting(button(await screen(), en['common.ok']), (current) => !button(current, en['common.ok']), 'the dialogs to close');
    await waitFor('the completion write', () => commands('archiveAction') === archiveBefore + 1, 10_000);
    const pickedE = seen.archive.find((row) => row.title === titles.e).expected;
    check(core().stored[titles.e][0].completedAt === pickedE, `(f) the completion time stored core's picked value (${pickedE}) in one write`);
    const archivedBefore = core().archivedCount;
    const selectAll = `${en['bulk.select']} ${en['common.all']}`;
    nodes = await tapExpecting(button(await screen(), en['bulk.select']) ?? fail('no Select'), (current) => Boolean(button(current, selectAll)), 'selection');
    nodes = await tapExpecting(button(nodes, selectAll), (current) => hasText(current, `2 ${en['bulk.selected']}`), 'Select all');
    // (f) Back leaves the selection first: Archived stays open with its rows; then Select all again for the restore.
    nodes = await back((current) => !hasText(current, `2 ${en['bulk.selected']}`) && Boolean(button(current, en['bulk.select'])));
    check(tabSelected(nodes, en['nav.archived']) && rowTitles(nodes).includes(titles.e), '(f) Back ended Archived\'s selection, and Archived stayed open');
    nodes = await tapExpecting(button(nodes, en['bulk.select']), (current) => Boolean(button(current, selectAll)), 'selection again');
    nodes = await tapExpecting(button(nodes, selectAll), (current) => hasText(current, `2 ${en['bulk.selected']}`), 'Select all again');
    await tapExpecting(button(nodes, en['trash.restoreToInbox']), (current) => !rowTitles(current).includes(titles.e), 'Restore to Inbox');
    await waitFor('the restore write', () => commands('archiveAction') === archiveBefore + 2, 10_000);
    seen = core();
    check(seen.stored[titles.e][0].status === 'inbox' && seen.stored[titles.f][0].status === 'inbox' && seen.archivedCount === archivedBefore - 2,
        '(f) Select all → Restore to Inbox moved exactly core\'s two rows, in one write');
    // The search box empty again (Archived keeps it for the session), then back to the Inbox tab.
    await device.focusAtEnd(withDescription(await screen(), en['common.search']) ?? fail('no search box'));
    requireAppFront();
    sh(`input keyevent ${Array(run.length).fill('KEYCODE_DEL').join(' ')}`);
    await waitFor('the empty search box', (current) => !withDescription(current, en['common.search'])?.text, 10_000);
    await back((current) => !tagged(current, 'menu-screen'));
    await tapExpecting(tab(await screen(), en['tab.inbox']), onInbox, 'the Inbox tab');

    // The stored sort as it was.
    if (originalSort) {
        await chooseSort(originalSort.label);
        await waitFor('the sort back', () => core().sortBy === originalSort.value, 10_000);
        originalSort = null;
    }
    console.log('Toolbars device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    if (originalSort) console.error(`note - the Inbox sort is still "${originalSort.label}"'s replacement; choose "${originalSort.label}" in the Inbox's Sort to put it back`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
