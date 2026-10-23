// Review's Mark reviewed and Organize, and the token and Board picker search check for the isolated native Android development app.
//
//   node apps/android-native/scripts/check-review-organize-device.mjs <adb-serial> [apk]
//
// Installs the debug APK with `install -r` (existing development data stays). Tasks due for review cannot be made in the app, so
// the script stops the app once and, through core's own store on a host copy of the database, adds this run's two areas (76 + run
// id + 0 and + 7), a project in the second (76 + run id + 9) and six Next tasks in the first (76 + run id + 1 to 6), each due for
// review, each with the contexts @76 + run id + 8 and @ + run id + 9. The app runs in English (the debug language override, put back
// on exit). Then it checks against core's own views on copies: (a) on Review's Due scope, one row's Review in 1 week and another's
// Mark reviewed are one write each of core's review date; (b) the bar's Mark reviewed clears two rows in one write; (c) folding a
// selected row's area ends the selection, as core says; (d) Review's Organize sheet: the area and project pickers' search shows
// core's match, Today on Due, rotation and process death keep the open sheet, an Apply under an injected failed commit stores
// nothing, and its exact retry stores the project and the date on both selected tasks in one write; (e) the Contexts token picker's
// search shows core's matching tokens only; (f) the Board filter picker's search shows core's match only. On exit, an injected
// failure left owed is settled through the app's Try again, then this run's tasks, project and areas are removed through core's
// store (tasks and the project deleted forever), and a cleanup that cannot finish says so. It changes no setting; it touches only
// the development package (it refuses any other APK), never launches over another app, leaves the app on its Inbox tab, restores
// rotation and its debug properties on exit. Leave the device on its home screen. It needs host `bun`. check-projects-device.mjs
// --prune-old removes what an interrupted run left.
// Exit 0 = pass, 1 = fail, 2 = refused before touching the device, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { EDGE_SAFE_X, box, button, check, chipOn, connect, evidenced, fail, inboxCount, isOn, mainList, owedRetry, Stopped, tab, tabSelected, tagged, taskRows, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-review-organize-device.mjs <adb-serial> [apk]');
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
const STAGED = '/data/local/tmp/mindwtr-native-dev-review-organize.db';
// The fault properties are cleared; the language property is set to English for the run and put back after.
const FAULTS = ['fail_commit', 'delay_before_ms', 'delay_after_ms'];
const DB = 'mindwtr-native-dev.db';
const work = resolve(app, 'android/build/review-organize-check');
const coreSrc = resolve(app, '../../packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));
// Digits only: the keyboard guard allows only an English layout, and digits never compose.
const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const names = {
    areaX: `76${run}0`, tasks: [1, 2, 3, 4, 5, 6].map((index) => `76${run}${index}`), areaY: `76${run}7`, project: `76${run}9`,
    context: `@76${run}8`, other: `@${run}9`, query: `76${run}`,
};

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { adbRaw, sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting } = device;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
const runAs = (command) => sh(`run-as ${PKG} ${command}`);
const commands = (operation, outcome = 'saved') => device.logs(pid(), TAG).replace(/\\/g, '').split('\n').filter((line) => line.includes('native-android-dev-task-command')
    && line.includes(`"operation":"${operation}"`) && line.includes(`"outcome":"${outcome}"`)).length;
const timeZone = sh('getprop persist.sys.timezone') || undefined;

// ---- core on a copy of the app's database ----
const pullDatabase = (name = 'db') => {
    const dir = resolve(work, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = runAs('ls files').split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    return resolve(dir, DB);
};
let injected = null;
/**
 * Core on a copy, in the phone's time zone: `inject` adds this run's areas, project and tasks through core's store (each task's
 * review date three days back); `remove` deletes them (the tasks and the project forever); both checkpoint the WAL. `views` prints
 * what the check compares with: this run's tasks as stored, core's
 * Review overview for this run's area (its labels, rows, links, the selection's bar and Organize dialog, and whether a fold ends a
 * selection), core's Contexts token picker for the run's query, core's Board tokens for it, and the More sheet's tiles.
 */
const core = (mode, db = pullDatabase()) => JSON.parse(execFileSync('bun', ['-e', `
    import { Database } from 'bun:sqlite';
    import { SqliteAdapter, createNativeHostContract, flushPendingSave, getAdvancedReviewDate, isTaskDueForReview, setStorageAdapter, useTaskStore } from '${coreSrc}/index.ts';
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
    // Three days back, as a local day (the phone's time zone): due for review.
    const reviewAt = new Date(Date.now() - 3 * 86400000).toLocaleDateString('en-CA');
    let out;
    if (process.env.CHECK_MODE === 'inject') {
        const [areaX, areaY] = [await store().addArea(names.areaX), await store().addArea(names.areaY)];
        if (!areaX || !areaY) throw new Error('addArea failed');
        const project = await store().addProject(names.project, '#94a3b8', { areaId: areaY.id });
        if (!project) throw new Error('addProject failed');
        for (const title of names.tasks) {
            const result = await store().addTask(title, { status: 'next', areaId: areaX.id, reviewAt, contexts: [names.context, names.other] });
            if (!result.success) throw new Error('addTask failed: ' + result.error);
        }
        await flushPendingSave();
        if (store().persistenceFailure) throw new Error('save failed: ' + store().persistenceFailure.message);
        out = { areaX: areaX.id, areaY: areaY.id, project: project.id, reviewAt };
    } else if (process.env.CHECK_MODE === 'remove') {
        const done = (result) => { if (!result.success) throw new Error('remove failed: ' + result.error); };
        const tasks = live(store()._allTasks).filter((task) => names.tasks.includes(task.title)).map((task) => task.id);
        if (tasks.length > 0) { done(await store().batchDeleteTasks(tasks)); done(await store().purgeTasks(tasks)); }
        const projects = live(store()._allProjects).filter((project) => project.title === names.project).map((project) => project.id);
        for (const id of projects) { done(await store().deleteProject(id)); done(await store().purgeProject(id)); }
        const areas = live(store()._allAreas).filter((area) => area.name === names.areaX || area.name === names.areaY).map((area) => area.id);
        for (const id of areas) done(await store().deleteArea(id));
        await flushPendingSave();
        if (store().persistenceFailure) throw new Error('save failed: ' + store().persistenceFailure.message);
        out = { tasks: tasks.length, projects: projects.length, areas: areas.length };
    } else {
        const ids = JSON.parse(process.env.CHECK_IDS);
        const tasks = Object.fromEntries(names.tasks.map((title) => [title, live(store()._allTasks).filter((task) => task.title === title).map((task) => ({
            id: task.id, rev: task.rev ?? null, reviewAt: task.reviewAt ?? null, due: isTaskDueForReview(task), areaId: task.areaId ?? null, dueDate: task.dueDate ?? null,
            projectId: task.projectId ?? null,
        }))]));
        const id = (index) => tasks[names.tasks[index]][0]?.id;
        const overview = (extra = {}) => value(host.getReviewOverview({ scope: 'due', offset: 0, limit: 100, ...extra }));
        const top = overview();
        const area = top.items.find((item) => item.type === 'area' && item.areaId === ids.areaX) ?? null;
        let review = null;
        if (area) {
            const opened = overview({ expandedAreaIds: [area.id] });
            const projects = opened.items.filter((item) => item.type === 'project' && item.areaGroupId === area.id);
            const expanded = { expandedAreaIds: [area.id], expandedProjectIds: projects.map((project) => project.id) };
            const rows = overview(expanded).items.filter((item) => item.type === 'task' && item.areaGroupId === area.id);
            const drawn = (taskId) => rows.some((item) => item.row.id === taskId);
            const pair = [id(4), id(5)];
            const selected = pair.every(drawn) ? overview({ ...expanded, selectedIds: pair, organize: { draft: {} } }) : null;
            const chosen = selected ? overview({ ...expanded, selectedIds: pair, organize: { draft: { areaChoice: ids.areaY } } }).bulk.organize : null;
            const inProject = selected ? overview({ ...expanded, selectedIds: pair, organize: { draft: { projectChoice: ids.project } } }).bulk.organize : null;
            const one = drawn(id(4)) ? overview({ ...expanded, selectedIds: [id(4)] }) : null;
            const folded = one ? overview({ expandedAreaIds: [], expandedProjectIds: expanded.expandedProjectIds, selectedIds: [id(4)] }) : null;
            const organize = selected?.bulk.organize;
            const due = organize?.dates.find((date) => date.field === 'dueDate');
            review = {
                area: area.accessibilityLabel,
                projects: projects.map((project) => project.accessibilityLabel),
                rows: rows.map((item) => item.row.title),
                links: Object.fromEntries(rows.map((item) => [item.row.title, item.review && { mark: item.review.markReviewed.accessibilityLabel, advance: item.review.advance.accessibilityLabel }])),
                oneCount: one?.bulk?.countLabel ?? null,
                foldEnds: folded ? folded.bulk === null : null,
                bar: selected && { count: selected.bulk.countLabel, organize: selected.bulk.actions.find((action) => action.id === 'organize').label,
                    markReviewed: selected.bulk.actions.find((action) => action.id === 'markReviewed')?.label ?? null },
                organize: organize && { area: organize.area.accessibilityLabel, areaLabel: organize.area.label, apply: organize.applyLabel, cancel: organize.cancelLabel,
                    today: due.quickDates.find((chip) => chip.preset === 'today'), chosenArea: chosen.area.accessibilityLabel,
                    project: organize.project.accessibilityLabel, projectLabel: organize.project.label, chosenProject: inProject.project.accessibilityLabel },
            };
        }
        const scope = top.scope;
        const context = { tokens: [names.context], offset: 0, limit: 50 };
        const chip = value(host.getContextsView({ searchQuery: names.context.slice(1), offset: 0, limit: 50 })).chips.find((item) => item.id === names.context);
        const picked = id(0) ? value(host.getContextsView({ ...context, selectedIds: [id(0)] })) : null;
        const add = picked?.bulk?.tokenActions.find((action) => action.field === 'contexts' && action.mode === 'add');
        const found = picked ? value(host.getContextsView({ ...context, selectedIds: [id(0)], picker: { field: 'contexts', mode: 'add', query: names.query } })).bulk.picker.items : [];
        // The Board's tokens (all, and for the query), read under one revision (again on a minute boundary).
        let board;
        for (let attempt = 0; !board && attempt < 3; attempt += 1) {
            try {
                const view = value(host.getBoardView({ limit: 50 }));
                const tokens = (query) => {
                    const items = [];
                    for (let offset = 0; ; offset += 100) {
                        const window = value(host.getBoardList({ filters: view.filters, list: 'tokens', offset, limit: 100, revision: view.revision, ...(query === undefined ? {} : { query }) }));
                        items.push(...window.items.map((item) => item.value));
                        if (offset + 100 >= window.total) return items;
                    }
                };
                board = { filter: view.bar.filterLabel, all: tokens(), found: tokens(names.query) };
            } catch (error) {
                if (!String(error.message).startsWith('STALE_REVISION')) throw error;
            }
        }
        const more = value(host.getMoreMenu());
        out = {
            tasks, review, scope: { due: scope.options.find((option) => option.id === 'due').label, selected: scope.selected },
            advanced: getAdvancedReviewDate(process.env.CHECK_REVIEW_AT),
            contexts: { chip: chip?.accessibilityLabel ?? null, add: add?.title ?? null, exit: picked?.bulk?.exitLabel ?? null, all: add?.tokens ?? [], found },
            board,
            quickAccess: more.quickAccessView,
            tiles: Object.fromEntries([...more.primary, ...more.utilities].map((item) => [item.id, item.label])),
        };
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    console.log(JSON.stringify(out));
    process.exit(0);
`], {
    encoding: 'utf8', maxBuffer: 64 << 20,
    env: { ...process.env, TZ: timeZone, CHECK_DB: db, CHECK_MODE: mode, CHECK_NAMES: JSON.stringify(names), CHECK_IDS: JSON.stringify(injected ?? {}), CHECK_REVIEW_AT: injected?.reviewAt ?? '' },
}).trim().split('\n').pop());

// ---- UI (core's English) ----
const onInbox = (nodes) => !tagged(nodes, 'menu-screen') && tabSelected(nodes, en['tab.inbox']) && Number.isFinite(inboxCount(nodes));
const sheetOpen = (nodes) => Boolean(tagged(nodes, 'more-sheet'));
const onReview = (nodes) => Boolean(tagged(nodes, 'review-list'));
// A clickable row's label can sit on a child node with the row's own bounds (dd's phone): read it there.
const rowLabel = (nodes, row) => row.text || row['content-desc']
    || nodes.find((node) => node !== row && node.bounds === row.bounds && (node.text || node['content-desc']))?.['content-desc'] || '';
const rowTitles = (nodes) => taskRows(nodes).sort((a, b) => box(a)[1] - box(b)[1]).map((node) => rowLabel(nodes, node));
const texts = (nodes) => new Set(nodes.map((node) => node.text).filter(Boolean));
/** The smallest focusable or clickable node around [label]'s center (a selectable's state sits there, not on its text). */
const around = (nodes, label) => {
    if (!label) return undefined;
    const [x1, y1, x2, y2] = box(label);
    const [cx, cy] = [(x1 + x2) / 2, (y1 + y2) / 2];
    const area = (node) => { const [l, t, r, b] = box(node); return (r - l) * (b - t); };
    return nodes.filter((node) => node.focusable === 'true' || node.clickable === 'true').filter((node) => {
        const [l, t, r, b] = box(node);
        return l <= cx && cx <= r && t <= cy && cy <= b;
    }).sort((a, b) => area(a) - area(b))[0];
};
/** The choice reading [text] is on (Review's scope buttons carry their state around their text). */
const textOn = (nodes, text) => { const label = nodes.find((node) => node.text === text); return isOn(label) || isOn(around(nodes, label)); };
/** A node reading or named [text] on the same line as [anchor] (the Contexts bar's X exit beside its count, not the Done status). */
const onLineOf = (nodes, anchor, text) => {
    if (!anchor) return undefined;
    const [, t, , b] = box(anchor);
    const middle = (t + b) / 2;
    return nodes.find((node) => (node.text === text || node['content-desc'] === text) && box(node)[1] <= middle && box(node)[3] >= middle);
};
/** The nodes inside [outer]'s bounds. */
const inside = (nodes, outer) => {
    if (!outer) return [];
    const [l, t, r, b] = box(outer);
    return nodes.filter((node) => { const [x1, y1, x2, y2] = box(node); return x1 >= l && y1 >= t && x2 <= r && y2 <= b && x2 > x1 && y2 > y1; });
};
/** A node wholly inside the main list (not under the tab bar or a header). */
const shownInList = (nodes, node) => {
    const list = mainList(nodes);
    if (!node) return false;
    // A list short enough to fit the screen reports no scrollable node (run 60): then a drawn node is shown.
    if (!list) return box(node)[3] > box(node)[1];
    const [, top, , bottom] = box(list);
    const [, y1, , y2] = box(node);
    return y2 > y1 && y1 >= top && y2 <= bottom;
};
/** Scrolls the main list until [find] gives a node wholly inside it (back to the top first, then forward). */
const revealNode = async (find, description) => {
    let nodes = await device.toTop();
    for (let step = 0; step < 30 && !shownInList(nodes, find(nodes)); step += 1) {
        const next = await device.swipe(nodes, 'down');
        if (device.signature(next) === device.signature(nodes)) break;
        nodes = next;
    }
    nodes = await device.settle(nodes);
    return shownInList(nodes, find(nodes)) ? nodes : fail(`${description} is not on screen`);
};
const hideKeyboard = async () => {
    if (!/mInputShown=true/.test(sh('dumpsys input_method'))) return;
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await waitFor('the keyboard to close', () => !/mInputShown=true/.test(sh('dumpsys input_method')), 5_000);
};
const back = async (done) => {
    await hideKeyboard();
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    return waitFor('Back', done, 15_000);
};
/** Types [text] into [node] (its end focused first). */
const typeInto = async (node, text, description) => {
    await device.focusAtEnd(node ?? fail(`no field for ${description}`));
    requireAppFront();
    sh(`input text '${text}'`);
    await sleep(600);
};
/** The row titled [title], scrolled wholly into the list. */
const revealRow = async (title) => {
    const find = (current) => taskRows(current).find((node) => rowLabel(current, node) === title);
    return find(await revealNode(find, title)) ?? fail(`no row ${title}`);
};
const longPress = async (title) => {
    const nodes = await screen();
    const row = taskRows(nodes).find((node) => rowLabel(nodes, node) === title) ?? fail(`no row ${title} on screen`);
    const [x1, y1, x2, y2] = box(row);
    const x = Math.max(Math.round((x1 + x2) / 2), EDGE_SAFE_X);
    requireAppFront();
    sh(`input swipe ${x} ${Math.round((y1 + y2) / 2)} ${x} ${Math.round((y1 + y2) / 2)} 900`);
    await sleep(600);
};
/** The More sheet from the Menu tab, then the tile labelled [label], until [done]. */
const openTile = async (label, done, description) => {
    let nodes = await screen();
    if (!sheetOpen(nodes)) nodes = await tapExpecting(tab(nodes, en['tab.menu']) ?? fail('no Menu tab'), sheetOpen, 'the More sheet');
    nodes = await device.settle(nodes);
    return tapExpecting(withDescription(nodes, label) ?? fail(`no ${label} tile`), done, description);
};
/** HOME, the process killed, and the app launched again until [done]: the check's process death. */
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

/** An injected failure whose exact retry is still owed: named while it is, so cleanup can settle it. */
let owed = null;
/**
 * Cleanup for a check that stopped between a failure's injection and its retry: the fault cleared, the dialog over the failure
 * message closed (its Cancel), and that exact request sent again through the app's Try again until no retry is owed. A cleanup
 * that cannot settle it says so loudly and fails the run.
 */
const settleOwed = async () => {
    if (!owed) return;
    for (const name of FAULTS) { try { setProp(name, ''); } catch { /* device gone */ } }
    try {
        if (front().includes(`${home}/`)) device.launch(ACTIVITY);
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const nodes = await screen();
            const retry = owedRetry(nodes);
            if (!retry) {
                console.log(`note - cleanup settled ${owed}: no retry is owed`);
                owed = null;
                return;
            }
            const cancel = withDescription(nodes, en['common.cancel']);
            if (cancel) await tap(cancel);
            else if (retry.enabled === 'true') await tap(retry);
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
/**
 * This run's tasks, project and areas removed through core's store on a host copy (the app stopped, as for the injection), then the
 * app launched again on its Inbox. Only after any owed write is settled; a removal that cannot finish says so.
 */
const removeFixtures = async () => {
    if (!injected) return;
    if (owed) {
        console.error(`RESTORE FAILED: this run's fixtures (76${run}…) stay, since ${owed} is still owed; run check-projects-device.mjs --prune-old after settling it`);
        process.exitCode = 1;
        return;
    }
    try {
        const current = front();
        if (!current.includes(`${PKG}/`) && !current.includes(`${home}/`)) throw new Error(`another app is in front: ${current.trim()}`);
        await device.stopApp();
        const db = pullDatabase('remove');
        const removed = core('remove', db);
        adbRaw('push', db, STAGED);
        try { runAs(`cp ${STAGED} files/${DB}`); } finally { sh(`rm -f ${STAGED}`); }
        runAs(`rm -f files/${DB}-wal files/${DB}-shm`);
        injected = null;
        device.launch(ACTIVITY);
        await waitFor('the Inbox', onInbox, 60_000);
        console.log(`note - removed this run's fixtures: ${removed.tasks} tasks and ${removed.projects} project deleted forever, ${removed.areas} areas deleted`);
    } catch (error) {
        console.error(`RESTORE FAILED: this run's fixtures (76${run}…) could not be removed (${error.message}); run check-projects-device.mjs --prune-old`);
        process.exitCode = 1;
    }
};

const originalLanguage = sh('getprop debug.mindwtr.native.language');
const restore = async () => {
    for (const name of FAULTS) { try { setProp(name, ''); } catch { /* device gone */ } }
    await settleOwed();
    // Leave the app on its Inbox tab: the other checks start there.
    try {
        for (let step = 0; step < 6 && front().includes(`${PKG}/`); step += 1) {
            const nodes = await screen();
            if (!tagged(nodes, 'menu-screen') && !sheetOpen(nodes) && tab(nodes, en['tab.inbox'])) break;
            sh('input keyevent KEYCODE_BACK');
            await sleep(800);
        }
        const nodes = await screen();
        if (front().includes(`${PKG}/`) && tab(nodes, en['tab.inbox']) && !tabSelected(nodes, en['tab.inbox'])) await tap(tab(nodes, en['tab.inbox']));
    } catch { /* the app is gone */ }
    await removeFixtures();
    for (const [name, value] of [['user_rotation', originalRotation], ['accelerometer_rotation', originalAccelerometer]]) {
        try { sh(value === 'null' ? `settings delete system ${name}` : `settings put system ${name} ${value}`); } catch { /* device gone */ }
    }
    try { setProp('language', originalLanguage); } catch { /* device gone */ }
    try { sh(`rm -f ${UI_FILE} ${STAGED}`); } catch { /* device gone */ }
};

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')}) / ${timeZone ?? 'no time zone'}`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    for (const name of FAULTS) setProp(name, '');
    // The selectors read core's English: the app boots in English whatever language it keeps (restored on exit).
    setProp('language', 'en');
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    // Boot once (this build's schema), stop, add this run's areas and tasks through core's store, and put the database back.
    device.launch(ACTIVITY);
    requireAppFront();
    sh('settings put system accelerometer_rotation 0');
    sh('settings put system user_rotation 0');
    await waitFor('the Inbox', onInbox, 60_000);
    await device.stopApp();
    const db = pullDatabase('inject');
    injected = core('inject', db);
    check(!existsSync(`${db}-wal`) || statSync(`${db}-wal`).size === 0, `the areas, project and six tasks of run ${run} are in the main database file`);
    adbRaw('push', db, STAGED);
    try { runAs(`cp ${STAGED} files/${DB}`); } finally { sh(`rm -f ${STAGED}`); }
    runAs(`rm -f files/${DB}-wal files/${DB}-shm`);
    device.launch(ACTIVITY);
    await waitFor('the Inbox', onInbox, 60_000);
    let seen = core('views');
    const review = seen.review ?? fail(`core's Review shows no group for ${names.areaX} (an area filter hides it? run check-projects-device first)`);
    check(names.tasks.every((title) => seen.tasks[title].length === 1 && seen.tasks[title][0].due) && review.rows.length === 6 && names.tasks.every((title) => review.rows.includes(title)),
        `core stores the six tasks, due for review, and Review's Due scope lists them under ${names.areaX}`);

    // Review (the quick-access tab or the More sheet's tile), on its Due scope, with this run's area and its tasks unfolded.
    if (seen.quickAccess === 'review') await tapExpecting(tab(await screen(), en['tab.review']) ?? fail('no Review tab'), onReview, 'the Review tab');
    else await openTile(seen.tiles.review, onReview, 'Review');
    let nodes = await device.settle(await device.toTop());
    // RN's Review opens on its Due scope; a scope the app kept from before is put back to Due.
    if (!textOn(nodes, seen.scope.due)) {
        const due = nodes.find((node) => node.text === seen.scope.due) ?? fail('no Due scope');
        nodes = await tapExpecting(due, (current) => textOn(current, seen.scope.due), 'the Due scope');
    }
    const ours = (current) => rowTitles(current).some((title) => names.tasks.includes(title));
    /** Taps the fold header described [label] (scrolled into the list first) until [shows]. */
    const unfold = async (label, shows, description) => {
        const found = await revealNode((current) => withDescription(current, label), description);
        return tapExpecting(withDescription(found, label), shows, description);
    };
    await unfold(review.area, (current) => review.projects.every((label) => withDescription(current, label)), `${names.areaX} unfolded`);
    for (const label of review.projects) nodes = await unfold(label, ours, 'its task group unfolded');
    const shownOrder = rowTitles(nodes).filter((title) => names.tasks.includes(title));
    check(review.rows.join('|').includes(shownOrder.join('|')), `Review draws this run's rows in core's order (${shownOrder.length} on screen)`);

    // (a) A row's Review in 1 week and another's Mark reviewed: core's action on the row, one write each.
    const rowLink = async (title, kind) => {
        const label = seen.review.links[title]?.[kind] ?? fail(`core offers no ${kind} under ${title}`);
        const shown = await revealNode((current) => withDescription(current, label), `${kind} under ${title}`);
        const before = commands('reviewAction');
        await tapExpecting(withDescription(shown, label), (current) => !withDescription(current, label), `${title} to leave the Due scope`);
        await waitFor(`the ${kind} write`, () => commands('reviewAction') === before + 1, 10_000);
    };
    let before = seen.tasks;
    await rowLink(names.tasks[0], 'advance');
    await rowLink(names.tasks[1], 'mark');
    seen = core('views');
    const [advanced, marked] = [names.tasks[0], names.tasks[1]].map((title) => seen.tasks[title][0]);
    check(advanced.reviewAt === seen.advanced && !advanced.due && advanced.rev === before[names.tasks[0]][0].rev + 1,
        `(a) Review in 1 week stored core's date ${seen.advanced} in one write`);
    check(marked.reviewAt === null && !marked.due && marked.rev === before[names.tasks[1]][0].rev + 1, '(a) Mark reviewed cleared the review date in one write');

    // (b) The bar's Mark reviewed on two selected rows: one write, both cleared.
    const selectedLine = (current) => current.find((node) => /^\d+ /.test(node.text ?? '') && node.text.endsWith(` ${en['bulk.selected']}`))?.text;
    const rowSelected = (title) => (current) => current.some((node) => node.text === title && node.checked === 'true');
    // The bar is the list's first item and scrolls with it (RN's too), so a row far down leaves it off screen: read it from the top.
    const barShows = (want, description) => revealNode((current) => current.find((node) => want(selectedLine([node]) ?? '')), description);
    await revealRow(names.tasks[2]);
    await longPress(names.tasks[2]);
    await waitFor('selection mode', rowSelected(names.tasks[2]), 10_000);
    await tapExpecting(await revealRow(names.tasks[3]), rowSelected(names.tasks[3]), 'the second row selected');
    await barShows((line) => line.startsWith('2 '), 'two rows selected');
    before = seen.tasks;
    let writes = commands('reviewAction');
    nodes = await device.toTop();
    nodes = await tapExpecting(button(nodes, review.bar.markReviewed ?? fail('core\'s bar has no Mark reviewed')) ?? fail('no Mark reviewed on the bar'),
        (current) => !selectedLine(current), 'the selection to end');
    await waitFor('the batch write', () => commands('reviewAction') === writes + 1, 10_000);
    seen = core('views');
    check([2, 3].every((index) => { const task = seen.tasks[names.tasks[index]][0]; return task.reviewAt === null && task.rev === before[names.tasks[index]][0].rev + 1; }),
        '(b) the bar\'s Mark reviewed cleared both rows\' review dates in one write');

    // (c) Folding a selected row's area ends the selection, as core's view says.
    check(seen.review?.foldEnds === true, 'core ends a selection whose row a fold hides');
    await revealRow(names.tasks[4]);
    await longPress(names.tasks[4]);
    await waitFor('one row selected', rowSelected(names.tasks[4]), 10_000);
    await barShows((line) => line === seen.review.oneCount, 'one row selected');
    const fold = await revealNode((current) => withDescription(current, seen.review.area), 'the area header');
    nodes = await tapExpecting(withDescription(fold, seen.review.area), (current) => !selectedLine(current) && !rowTitles(current).includes(names.tasks[4]), 'the fold');
    check(!selectedLine(nodes), `(c) folding ${names.areaX} ended the selection, as core does`);
    nodes = await unfold(seen.review.area, (current) => rowTitles(current).includes(names.tasks[4]) && !selectedLine(current), `${names.areaX} unfolded again, not selecting`);

    // (d) Review's Organize sheet on two selected rows: the area and project pickers' search, Today on Due, rotation and process
    // death, then an Apply under a failed commit (nothing stored) and its exact retry (one write for both tasks). A chosen project
    // resets the area to Keep (RN's rule), so the tasks take the project (in the second area) and the date.
    const organize = seen.review.organize ?? fail('core offers no Organize for the two rows');
    await revealRow(names.tasks[4]);
    await longPress(names.tasks[4]);
    await waitFor('one row selected', rowSelected(names.tasks[4]), 10_000);
    await tapExpecting(await revealRow(names.tasks[5]), rowSelected(names.tasks[5]), 'the second row selected');
    await barShows((line) => line === seen.review.bar.count, 'two rows selected');
    nodes = await device.toTop();
    const dialogOpen = (current) => Boolean(withDescription(current, organize.apply));
    /** The Organize sheet's control described [label], its fields scrolled up (from just above Apply) until it shows. */
    const sheetShows = async (label) => {
        let shown = await screen();
        for (let step = 0; step < 4; step += 1) {
            const node = withDescription(shown, label);
            if (node && box(node)[3] > box(node)[1]) return shown;
            const [l, t, r] = box(withDescription(shown, organize.apply) ?? fail('the Organize sheet closed'));
            const x = Math.max(EDGE_SAFE_X + 40, Math.round((l + r) / 2) - 200);
            requireAppFront();
            sh(`input swipe ${x} ${t - 80} ${x} ${t - 500} 500`);
            shown = await device.settle();
        }
        return fail(`${label} is not in the Organize sheet`);
    };
    nodes = await tapExpecting(button(nodes, seen.review.bar.organize) ?? fail('no Organize on the bar'), (current) => dialogOpen(current) && Boolean(withDescription(current, organize.area)), 'the Organize sheet');
    const search = `${en['common.search']} ${organize.areaLabel}`;
    nodes = await tapExpecting(withDescription(nodes, organize.area), (current) => Boolean(withDescription(current, search)), 'the area picker');
    await typeInto(withDescription(nodes, search), names.areaY, 'the area search');
    nodes = await waitFor(`core's match ${names.areaY}`, (current) => Boolean(withDescription(current, names.areaY)) && !withDescription(current, names.areaX), 15_000);
    check(true, `(d) the area picker's search shows core's match ${names.areaY}, not ${names.areaX}`);
    await hideKeyboard();
    nodes = await tapExpecting(withDescription(await device.settle(), names.areaY), (current) => Boolean(withDescription(current, organize.chosenArea)), 'the area chosen');
    const projectSearch = `${en['common.search']} ${organize.projectLabel}`;
    nodes = await tapExpecting(withDescription(nodes, organize.project) ?? fail('no Project row'), (current) => Boolean(withDescription(current, projectSearch)), 'the project picker');
    await typeInto(withDescription(nodes, projectSearch), names.project, 'the project search');
    nodes = await waitFor(`core's match ${names.project}`, (current) => Boolean(withDescription(current, names.project)), 15_000);
    await hideKeyboard();
    nodes = await tapExpecting(withDescription(await device.settle(), names.project), (current) => Boolean(withDescription(current, organize.chosenProject)), 'the project chosen');
    check(!withDescription(nodes, organize.chosenArea), `(d) the project picker's search chose ${names.project}, and the area went back to Keep, as core's draft says`);
    const today = organize.today;
    nodes = await sheetShows(today.accessibilityLabel);
    nodes = await tapExpecting(withDescription(nodes, today.accessibilityLabel), (current) => chipOn(current, today.accessibilityLabel), 'Today on Due');
    const sheetKept = (current) => dialogOpen(current) && Boolean(withDescription(current, organize.chosenProject)) && chipOn(current, today.accessibilityLabel);
    // Landscape shows the sheet's top only (its fields scroll); portrait and a relaunch show the area and the date again.
    sh('settings put system user_rotation 1');
    await waitFor('the sheet in landscape', dialogOpen, 20_000);
    sh('settings put system user_rotation 0');
    await waitFor('the sheet in portrait', sheetKept, 20_000);
    nodes = await killAndRelaunch(sheetKept, 'the sheet after process death');
    check(true, '(d) rotation and process death keep the open Organize sheet with its project and date');
    before = core('views').tasks;
    writes = commands('reviewAction');
    const failedBefore = commands('reviewAction', 'failed');
    setProp('fail_commit', '1');
    owed = 'the injected failed Organize Apply';
    // The sheet is its own window over the failure message (run 60): the failed Apply shows as Apply locked, and the
    // app's command log records the failed write; Cancel below shows the message's Try again.
    nodes = await tapExpecting(withDescription(nodes, organize.apply), (current) => withDescription(current, organize.apply)?.enabled === 'false', 'Apply locked by the failure');
    await waitFor('the injected failure', () => commands('reviewAction', 'failed') === failedBefore + 1, 15_000);
    seen = core('views');
    check([4, 5].every((index) => seen.tasks[names.tasks[index]][0].rev === before[names.tasks[index]][0].rev) && commands('reviewAction', 'failed') === failedBefore + 1,
        '(d) the failed Apply stored nothing; its exact retry is owed');
    setProp('fail_commit', '');
    // The sheet stays over the failure message (its Apply waits); Cancel shows the message's Try again.
    nodes = await tapExpecting(withDescription(await screen(), organize.cancel) ?? fail('no Cancel'), (current) => !dialogOpen(current) && Boolean(owedRetry(current)), 'the sheet to close');
    await tapExpecting(owedRetry(nodes), (current) => !owedRetry(current) && !selectedLine(current), 'Try again');
    await waitFor('the retried write', () => commands('reviewAction') === writes + 1, 10_000);
    owed = null;
    seen = core('views');
    check([4, 5].every((index) => {
        const task = seen.tasks[names.tasks[index]][0];
        return task.projectId === injected.project && task.areaId === null && task.dueDate === today.value && task.rev === before[names.tasks[index]][0].rev + 1;
    }), `(d) Try again stored the project ${names.project} and the due date ${today.value} on both tasks, in one write`);
    if (seen.quickAccess === 'review') await tapExpecting(tab(await screen(), en['tab.inbox']), onInbox, 'the Inbox');
    else await back(onInbox);

    // (e) The Contexts token picker: its search shows core's matching tokens only.
    check(seen.contexts.all.includes(names.context) && seen.contexts.all.includes(names.other) && JSON.stringify(seen.contexts.found) === JSON.stringify([names.context]),
        `core's Add context tokens hold ${names.context} and ${names.other}; its search for ${names.query} finds ${names.context} only`);
    const onContexts = (current) => Boolean(tagged(current, 'contexts-list'));
    if (seen.quickAccess === 'contexts') await tapExpecting(tab(await screen(), en['nav.contexts']) ?? fail('no Contexts tab'), onContexts, 'the Contexts tab');
    else await openTile(seen.tiles.contexts, onContexts, 'Contexts');
    nodes = await waitFor('the chip search', (current) => Boolean(tagged(current, 'list-search')));
    await typeInto(tagged(nodes, 'list-search'), names.context.slice(1), 'the chip search');
    nodes = await waitFor(`core's chip "${seen.contexts.chip}"`, (current) => Boolean(seen.contexts.chip && withDescription(current, seen.contexts.chip)), 15_000);
    await hideKeyboard();
    await tapExpecting(withDescription(await screen(), seen.contexts.chip), (current) => chipOn(current, seen.contexts.chip), `${names.context} chosen`);
    await revealRow(names.tasks[0]);
    await longPress(names.tasks[0]);
    nodes = await waitFor('the Contexts bar', (current) => Boolean(button(current, seen.contexts.add)), 10_000);
    nodes = await tapExpecting(button(nodes, seen.contexts.add), (current) => Boolean(tagged(current, 'menu-dialog-field')), 'the Add context picker');
    await typeInto(tagged(nodes, 'menu-dialog-field'), names.query, 'the picker search');
    const chipsShown = (current) => [...texts(inside(current, tagged(current, 'token-picker-list')))];
    nodes = await waitFor('core\'s matching tokens', (current) => JSON.stringify(chipsShown(current)) === JSON.stringify(seen.contexts.found), 15_000);
    check(!chipsShown(nodes).includes(names.other), `(e) the token picker's search shows core's match ${names.context} only`);
    await hideKeyboard();
    nodes = await tapExpecting(button(await screen(), en['common.cancel']) ?? fail('no Cancel'), (current) => !tagged(current, 'menu-dialog-field'), 'the picker to close');
    const count = (current) => current.find((node) => /^\d+ /.test(node.text ?? '') && node.text.endsWith(` ${en['bulk.selected']}`));
    nodes = await tapExpecting(onLineOf(nodes, count(nodes), seen.contexts.exit) ?? fail('no exit beside the bar\'s count'), (current) => !button(current, seen.contexts.add), 'the selection to end');
    if (seen.quickAccess === 'contexts') await tapExpecting(tab(await screen(), en['tab.inbox']), onInbox, 'the Inbox');
    else await back(onInbox);

    // (f) The Board's filter picker: its search shows core's match only.
    const board = seen.board ?? fail('core\'s Board could not be read');
    check(board.all.includes(names.context) && board.all.includes(names.other) && JSON.stringify(board.found) === JSON.stringify([names.context]),
        `core's Board tokens hold ${names.context} and ${names.other}; its search for ${names.query} finds ${names.context} only`);
    const onBoard = (current) => Boolean(tagged(current, 'board'));
    const filters = (current) => Boolean(tagged(current, 'board-filters'));
    nodes = await openTile(seen.tiles.board, onBoard, 'the Board');
    nodes = await tapExpecting(withDescription(nodes, board.filter) ?? fail('no Filters'), filters, 'the filter sheet');
    const tokensRow = `${en['filters.contexts']}: ${en['common.all']}`;
    const pickerSearch = `${en['common.search']} ${en['filters.contexts']}`;
    nodes = await tapExpecting(withDescription(nodes, tokensRow) ?? fail('no contexts row'), (current) => Boolean(withDescription(current, pickerSearch)), 'the contexts picker');
    await typeInto(withDescription(nodes, pickerSearch), names.query, 'the Board picker search');
    const options = (current) => inside(current, tagged(current, 'board-filters')).map((node) => node['content-desc']).filter((label) => label === names.context || label === names.other);
    nodes = await waitFor('core\'s Board match', (current) => JSON.stringify(options(current)) === JSON.stringify(board.found), 15_000);
    check(true, `(f) the Board picker's search shows core's match ${names.context}, not ${names.other}`);
    await hideKeyboard();
    // The sheet's own Back and Done (the header has a Back, and a column reads Done).
    const inSheet = (current, text) => inside(current, tagged(current, 'board-filters')).find((node) => node.text === text);
    nodes = await tapExpecting(inSheet(await screen(), en['common.back']) ?? fail('no Back in the sheet'), (current) => Boolean(withDescription(current, tokensRow)), 'the sheet');
    await tapExpecting(inSheet(nodes, en['common.done']) ?? fail('no Done in the sheet'), (current) => !filters(current), 'the sheet to close');
    await back(onInbox);
    console.log('Review organize, token picker and Board picker device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
