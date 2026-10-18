// Menu tab check for the isolated native Android development app.
//
//   node apps/android-native/scripts/check-menu-device.mjs <adb-serial> [apk]
//
// Installs the debug APK with `install -r` (existing development data stays), captures five tasks with titles unique to
// this run (Waiting with and without person 6061, Someday, Done, Archived), and checks RN's Menu tab against core's own
// menu views on a copy of the app's database: (a) the Menu tab opens the More sheet with core's tiles and utilities, the
// screens this app lacks drawn disabled; (b) Waiting shows core's stats and rows, and the person chip narrows them as
// core does; (c) Someday: New section… stores the fixed section 6000 once (later runs find it), Move to section… moves the
// Someday capture into it and the toast's Undo moves it back (one write each), and a failed commit of a heading's Add task
// keeps its exact retry (the capture UUID on disk) and Try again stores it once; (d) Reference opens on core's list;
// (e) History's Done and Archived tabs show core's rows; (f) Archived's Restore (move to Inbox) stores once; (g) rotation
// and process death keep History on its Archived tab. It touches only the development package (it refuses any other APK),
// never launches over another app, restores rotation and clears its debug properties on exit.
// Leave the device on its home screen before running. It needs host `bun`.
// Exit 0 = pass, 1 = fail, 2 = refused before touching the device, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { EDGE_SAFE_X, besideRow, box, button, check, chipOn, connect, evidenced, fail, hasText, inboxCount, owedRetry, Stopped, tab, tabSelected, tagged, taskRows, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-menu-device.mjs <adb-serial> [apk]');
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
const work = resolve(app, 'android/build/menu-check');
const coreSrc = resolve(app, '../../packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));
// Digits for titles and tokens: the keyboard guard allows only an English layout, and digits never compose.
const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const titles = { waitingPerson: `60${run}1`, waiting: `60${run}2`, someday: `60${run}3`, added: `60${run}4`, done: `60${run}5`, archived: `60${run}6` };
// One fixed section and person, so runs add no sections (core returns an existing section for its title).
const SECTION = '6000';
const PERSON = '6061';

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting } = device;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
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
/** Core's menu views on a copy (the first window of each), and the stored tasks titled as this run's. */
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
    if (!(await host.setLanguage({ storedLanguage: 'en', systemLocale: null })).ok) throw new Error('language');
    const ready = await host.activate({ writeSafetyReady: true });
    if (!ready.ok) throw new Error(ready.error.message);
    const value = (result) => { if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message); return result.value; };
    const page = { offset: 0, limit: 50 };
    const titleOf = (item) => item.type === 'task' ? item.row.title : null;
    const more = value(host.getMoreMenu());
    const waiting = value(host.getWaitingView(page));
    const person = value(host.getWaitingView({ ...page, person: process.env.CHECK_PERSON }));
    const done = value(host.getDoneView(page));
    const archive = value(host.getArchiveView(page));
    const reference = value(host.getReferenceView(page));
    const store = useTaskStore.getState();
    const sections = (store.settings.gtd?.viewSections?.someday ?? []).filter((section) => section.title === process.env.CHECK_SECTION);
    const live = store._allTasks.filter((task) => !task.deletedAt);
    const stored = Object.fromEntries(Object.values(JSON.parse(process.env.CHECK_TITLES)).map((title) => [title,
        live.filter((task) => task.title === title).map((task) => ({ id: task.id, status: task.status, section: task.viewSectionIds?.someday ?? null }))]));
    console.log(JSON.stringify({
        tiles: [...more.primary, ...more.utilities].map((item) => ({ id: item.id, label: item.label })),
        waiting: { rows: waiting.rows.map((row) => row.title), stats: waiting.stats },
        person: person.rows.map((row) => row.title),
        done: done.items.map(titleOf).filter(Boolean),
        archive: archive.items.map(titleOf).filter(Boolean),
        reference: { rows: reference.items.map(titleOf).filter(Boolean), empty: reference.empty.message },
        sections: sections.map((section) => section.id),
        stored,
    }));
    process.exit(0);
`], { encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, CHECK_DB: pullDatabase(), CHECK_TITLES: JSON.stringify(titles), CHECK_SECTION: SECTION, CHECK_PERSON: PERSON } })
    .trim().split('\n').pop());

// ---- UI (core's English) ----
const inPopup = (nodes) => Boolean(tagged(nodes, 'quick-capture'));
const onInbox = (nodes) => !inPopup(nodes) && !tagged(nodes, 'menu-screen') && Number.isFinite(inboxCount(nodes));
const inScreen = (title) => (nodes) => Boolean(tagged(nodes, 'menu-screen')) && hasText(nodes, title);
const sheetOpen = (nodes) => Boolean(tagged(nodes, 'more-sheet'));
/** The task rows fully inside the list, top to bottom (their title nodes). */
// A clickable row's label can sit on a child node with the row's own bounds (Archived's rows): read it there.
const rowLabel = (nodes, row) => row.text || row['content-desc']
    || nodes.find((node) => node !== row && node.bounds === row.bounds && (node.text || node['content-desc']))?.['content-desc'] || '';
const rowTitles = (nodes) => taskRows(nodes).sort((a, b) => box(a)[1] - box(b)[1]).map((node) => rowLabel(nodes, node));
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
/** The More sheet from the Menu tab, then the tile labelled [label]. */
const openTile = async (label, title) => {
    let nodes = await screen();
    if (!sheetOpen(nodes)) nodes = await tapExpecting(tab(nodes, en['tab.menu']) ?? fail('no Menu tab'), sheetOpen, 'the More sheet');
    nodes = await device.settle(nodes);
    return tapExpecting(withDescription(nodes, label) ?? fail(`no ${label} tile`), inScreen(title), `the ${title} screen`);
};
const back = async (done) => {
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    return waitFor('Back', done, 15_000);
};
/** Swipes the row whose TalkBack text is [title] to the right by [dx] px (RN's Swipeable), and returns the screen. */
const swipeRight = async (title) => {
    const row = withDescription(await screen(), title) ?? fail(`no row ${title}`);
    const [x1, y1, , y2] = box(row);
    const y = Math.round((y1 + y2) / 2);
    requireAppFront();
    // Start clear of the screen edge: a swipe from the edge is the system Back gesture (run 29 closed History).
    const from = Math.max(x1 + 10, EDGE_SAFE_X);
    sh(`input swipe ${from} ${y} ${from + 440} ${y} 400`);
    await sleep(700);
    return screen();
};

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const restore = async () => {
    for (const name of PROPS) { try { setProp(name, ''); } catch { /* device gone */ } }
    // Leave the app on its Inbox tab: the other checks start there.
    try {
        for (let step = 0; step < 3 && front().includes(`${PKG}/`); step += 1) {
            const nodes = await screen();
            if (!tagged(nodes, 'menu-screen') && !sheetOpen(nodes)) break;
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

    // The run's own captures, each with core's quick-add status (and person) token.
    await capture(`${titles.waitingPerson}%s/waiting%s%${PERSON}`, `${titles.waitingPerson} /waiting %${PERSON}`);
    await capture(`${titles.waiting}%s/waiting`, `${titles.waiting} /waiting`);
    await capture(`${titles.someday}%s/someday`, `${titles.someday} /someday`);
    await capture(`${titles.done}%s/done`, `${titles.done} /done`);
    await capture(`${titles.archived}%s/archived`, `${titles.archived} /archived`);
    let seen = core();
    check(Object.values(titles).filter((title) => title !== titles.added).every((title) => seen.stored[title].length === 1), 'the five captures are stored once each');

    // (a) The Menu tab opens RN's More sheet: core's tiles and utilities; the screens this app lacks are drawn disabled.
    let nodes = await tapExpecting(tab(await screen(), en['tab.menu']) ?? fail('no Menu tab'), sheetOpen, 'the More sheet');
    nodes = await device.settle(nodes);
    for (const tile of seen.tiles) {
        const node = withDescription(nodes, tile.label) ?? fail(`the sheet lacks core's "${tile.label}"`);
        const built = ['waiting', 'someday', 'reference', 'history', 'projects', 'review', 'contexts', 'trash', 'calendar', 'board', 'settings'].includes(tile.id);
        if (!built && node.enabled !== 'false') fail(`"${tile.label}" is not built here but is enabled`);
    }
    check(true, `(a) the sheet shows core's ${seen.tiles.length} destinations; the unbuilt ones are disabled`);

    // (b) Waiting: core's stats and rows; the person chip narrows them as core does.
    nodes = await tapExpecting(withDescription(nodes, seen.tiles.find((tile) => tile.id === 'waiting').label), inScreen(en['waiting.title']), 'Waiting');
    nodes = await waitFor('core\'s Waiting rows', (current) => rowTitles(current).length > 0);
    const statText = `${seen.waiting.stats[0].value} ${seen.waiting.stats[0].label}`;
    const shownRows = rowTitles(nodes);
    check(hasText(nodes, statText) && JSON.stringify(shownRows) === JSON.stringify(seen.waiting.rows.slice(0, shownRows.length)),
        `(b) Waiting shows core's stats ("${statText}") and its first ${shownRows.length} rows in core's order`);
    nodes = await tapExpecting(withDescription(nodes, PERSON) ?? fail(`no person chip ${PERSON}`), (current) => chipOn(current, PERSON), `${PERSON} chosen`);
    nodes = await waitFor('the narrowed rows', (current) => JSON.stringify(rowTitles(current)) === JSON.stringify(seen.person.slice(0, rowTitles(current).length))
        && rowTitles(current).includes(titles.waitingPerson) && !rowTitles(current).includes(titles.waiting), 10_000);
    check(true, `(b) the ${PERSON} chip narrows Waiting to core's rows (${seen.person.length})`);
    await back(onInbox);

    // (c) Someday: New section…, Move to section… with Undo, and a failed Add task's exact retry.
    const somedayLabel = seen.tiles.find((tile) => tile.id === 'someday').label;
    await openTile(somedayLabel, en['someday.title']);
    nodes = await tapExpecting(withDescription(await screen(), en['taskEdit.moreOptions']) ?? fail('no list menu'),
        (current) => Boolean(withDescription(current, en['viewSections.new'])), 'the Someday menu');
    nodes = await tapExpecting(withDescription(nodes, en['viewSections.new']), (current) => Boolean(tagged(current, 'menu-dialog-field')), 'the New section prompt');
    await device.focusAtEnd(tagged(nodes, 'menu-dialog-field'));
    requireAppFront();
    sh(`input text '${SECTION}'`);
    nodes = await waitFor('the section name', (current) => tagged(current, 'menu-dialog-field')?.text === SECTION, 10_000);
    await tapExpecting(withDescription(nodes, en['common.save']) ?? fail('no Save'), (current) => !tagged(current, 'menu-dialog-field'), 'the section to be created');
    seen = core();
    check(seen.sections.length === 1, `(c) exactly one section "${SECTION}" is stored (created now or found again)`);

    const statusLabel = en['task.aria.changeStatus'].replace('{{status}}', en['status.someday']);
    // The list reads itself again after the create and gains the new section's heading, which moves every row down:
    // wait for that heading and a still screen, so the tap below cannot land on the row that slid into place (run 23).
    await waitFor(`the "${SECTION}" heading`, (current) => hasText(current, SECTION), 10_000);
    await device.settle();
    nodes = await device.settle(await device.reveal(titles.someday));
    nodes = await tapExpecting(besideRow(nodes, titles.someday, statusLabel) ?? fail('no status control on the Someday row'),
        (current) => Boolean(withDescription(current, en['viewSections.moveToSection'])), 'the status menu with Move to section…');
    nodes = await tapExpecting(withDescription(nodes, en['viewSections.moveToSection']), (current) => Boolean(withDescription(current, SECTION)), 'core\'s move dialog');
    const [movesBefore, undosBefore] = [commands('somedayMove'), commands('somedayUndo')];
    const moved = en['viewSections.moved'].replace('{section}', SECTION).replace('{count}', '1');
    // RN's toast lasts 5.2 s and one screen read takes about a second, so Undo is tapped on the first read that shows the
    // toast (runs 22-25 tapped it about 7 s after the move, when the toast had already gone). The writes are counted after.
    requireAppFront();
    const [sl, st, sr, sb] = box(withDescription(nodes, SECTION) ?? fail(`no "${SECTION}" choice`));
    sh(`input tap ${Math.round((sl + sr) / 2)} ${Math.round((st + sb) / 2)}`);
    let undo;
    for (let read = 0; read < 4 && !undo; read += 1) {
        const current = await screen();
        undo = hasText(current, moved) ? current.find((node) => node.text === en['common.undo']) : undefined;
    }
    requireAppFront();
    const [ul, ut, ur, ub] = box(undo ?? fail('no "moved" toast with Undo'));
    sh(`input tap ${Math.round((ul + ur) / 2)} ${Math.round((ut + ub) / 2)}`);
    await waitFor('the Undo write', () => commands('somedayUndo') === undosBefore + 1, 10_000);
    check(commands('somedayMove') === movesBefore + 1, `(c) the move into "${SECTION}" is one write, and core's toast says "${moved}"`);
    seen = core();
    check(seen.stored[titles.someday][0].section === null && commands('somedayUndo') === undosBefore + 1, '(c) Undo is one write and puts the task back under No section');

    setProp('fail_commit', '1');
    const addLabel = en['viewSections.addTask'].replace('{section}', SECTION);
    nodes = await device.reveal(SECTION);
    nodes = await tapExpecting(withDescription(nodes, addLabel) ?? fail(`no ${addLabel}`), (current) => Boolean(tagged(current, 'menu-dialog-field')), 'the Add task prompt');
    await device.focusAtEnd(tagged(nodes, 'menu-dialog-field'));
    requireAppFront();
    sh(`input text '${titles.added}'`);
    nodes = await waitFor('the task title', (current) => tagged(current, 'menu-dialog-field')?.text === titles.added, 10_000);
    nodes = await tapExpecting(withDescription(nodes, en['common.save']), (current) => Boolean(owedRetry(current)), 'the injected failure');
    const captureId = JSON.parse(sh(`run-as ${PKG} cat no_backup/menu/pending`)).id;
    check(tagged(nodes, 'menu-dialog-field')?.enabled === 'false' && core().stored[titles.added].length === 0,
        `(c) the failed commit stored nothing; the prompt is locked to its exact request (capture ${captureId}, on disk)`);
    setProp('fail_commit', '');
    // The prompt keeps its exact request and offers RN's Retry (core's `common.retry`) over the failure banner's Try again.
    await tapExpecting(withDescription(await screen(), en['common.retry']) ?? fail('no Retry in the prompt'),
        (current) => !owedRetry(current) && !tagged(current, 'menu-dialog-field'), 'the prompt\'s Retry');
    seen = core();
    check(seen.stored[titles.added].length === 1 && seen.stored[titles.added][0].id === captureId && seen.stored[titles.added][0].section === seen.sections[0]
        && commands('somedayTask', 'failed') >= 1, `(c) Try again stored the task once, with the capture UUID, in "${SECTION}"`);
    await back(onInbox);

    // (d) Reference opens on core's list.
    await openTile(seen.tiles.find((tile) => tile.id === 'reference').label, en['nav.reference']);
    nodes = await waitFor('core\'s Reference list', (current) => rowTitles(current).length > 0 || hasText(current, seen.reference.empty), 20_000);
    const referenceRows = rowTitles(nodes);
    check(seen.reference.rows.length === 0 ? hasText(nodes, seen.reference.empty) : JSON.stringify(referenceRows) === JSON.stringify(seen.reference.rows.slice(0, referenceRows.length)),
        `(d) Reference shows core's list (${seen.reference.rows.length} rows in its first window)`);
    await back(onInbox);

    // (e) History: Done, then Archived, each with core's rows.
    await openTile(seen.tiles.find((tile) => tile.id === 'history').label, en['nav.history']);
    // The rows are read once they are core's or 20 s pass (never one dump while the list may still load); a mismatch names both.
    const doneShown = (current) => (tabSelected(current, en['nav.done']) ? rowTitles(current) : []);
    const doneMatch = (rows) => rows.length > 0 && JSON.stringify(rows) === JSON.stringify(seen.done.slice(0, rows.length));
    nodes = await screen();
    const firstDone = doneShown(nodes);
    for (const deadline = Date.now() + 20_000; !doneMatch(doneShown(nodes)) && Date.now() < deadline;) { await sleep(500); nodes = await screen(); }
    const doneRows = doneShown(nodes);
    if (doneMatch(doneRows) && !doneMatch(firstDone)) console.log(`note - Done's first dump showed ${JSON.stringify(firstDone)} before core's rows`);
    check(doneMatch(doneRows) && seen.done.includes(titles.done),
        `(e) Done opens first and shows core's first ${doneRows.length} rows in core's order, the run's Done capture among core's`
        + (doneMatch(doneRows) ? '' : ` (screen ${JSON.stringify(doneRows)}, core ${JSON.stringify(seen.done.slice(0, 8))}, run's ${titles.done})`));
    nodes = await tapExpecting(tab(nodes, en['nav.archived']), (current) => tabSelected(current, en['nav.archived']) && rowTitles(current).length > 0, 'the Archived tab');
    const archiveRows = rowTitles(nodes);
    check(JSON.stringify(archiveRows) === JSON.stringify(seen.archive.slice(0, archiveRows.length)) && archiveRows.includes(titles.archived),
        `(e) Archived shows core's first ${archiveRows.length} rows in core's order, the run's Archived capture on screen`
        + (JSON.stringify(archiveRows) === JSON.stringify(seen.archive.slice(0, archiveRows.length)) ? '' : ` (screen ${JSON.stringify(archiveRows)}, core ${JSON.stringify(seen.archive.slice(0, 8))}, run's ${titles.archived})`));

    // (f) Archived's Restore: the task goes to Inbox, one write.
    const restoresBefore = commands('archiveAction');
    const restoreLabel = en['trash.restore'];
    nodes = await swipeRight(titles.archived);
    await tapExpecting(withDescription(nodes, restoreLabel) ?? fail('no Restore behind the row'), (current) => !withDescription(current, titles.archived), 'the row to leave Archived');
    await waitFor('the Restore write', () => commands('archiveAction') === restoresBefore + 1, 10_000);
    check(core().stored[titles.archived][0].status === 'inbox' && commands('archiveAction') === restoresBefore + 1, '(f) Restore moved the task to Inbox in one write');

    // (g) Rotation and process death keep History on its Archived tab.
    const onArchived = (current) => inScreen(en['nav.history'])(current) && tabSelected(current, en['nav.archived']);
    sh('settings put system user_rotation 1');
    await waitFor('landscape History › Archived', onArchived, 20_000);
    sh('settings put system user_rotation 0');
    await waitFor('portrait History › Archived', onArchived, 20_000);
    const processId = pid();
    requireAppFront();
    sh('input keyevent KEYCODE_HOME');
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    await sleep(1500);
    sh(`run-as ${PKG} kill -9 ${processId}`);
    await waitFor('process death', () => pid() !== processId, 10_000);
    device.launch(ACTIVITY);
    await waitFor('History › Archived after process death', onArchived, 60_000);
    check(true, '(g) rotation and process death keep History on its Archived tab');
    console.log('Menu device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
