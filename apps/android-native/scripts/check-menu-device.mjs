


import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const titles = { waitingPerson: `60${run}1`, waiting: `60${run}2`, someday: `60${run}3`, added: `60${run}4`, done: `60${run}5`, archived: `60${run}6` };

const SECTION = '6000';
const PERSON = '6061';

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { adbRaw, sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting } = device;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
const commands = (operation, outcome = 'saved') => device.logs(pid(), TAG).replace(/\\/g, '').split('\n').filter((line) => line.includes('native-android-dev-task-command')
    && line.includes(`"operation":"${operation}"`) && line.includes(`"outcome":"${outcome}"`)).length;


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
        live.filter((task) => task.title === title).map((task) => ({ id: task.id, status: task.status, section: task.viewSectionIds?.someday ?? null,
            areaId: task.areaId ?? null, projectId: task.projectId ?? null }))]));
    console.log(JSON.stringify({
        tiles: [...more.primary, ...more.utilities].map((item) => ({ id: item.id, label: item.label })),
        waiting: { rows: waiting.rows.map((row) => row.title), stats: waiting.stats },
        person: person.rows.map((row) => row.title),
        done: done.items.map(titleOf).filter(Boolean),
        archive: archive.items.map(titleOf).filter(Boolean),
        reference: { rows: reference.items.map(titleOf).filter(Boolean), empty: reference.empty.message },
        sections: sections.map((section) => section.id),
        areas: store.areas.filter((area) => !area.deletedAt).map((area) => ({ id: area.id, name: area.name })),
        projects: store.projects.filter((project) => !project.deletedAt && project.status === 'active').map((project) => ({ id: project.id, title: project.title })),
        stored,
    }));
    process.exit(0);
`], { encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, CHECK_DB: pullDatabase(), CHECK_TITLES: JSON.stringify(titles), CHECK_SECTION: SECTION, CHECK_PERSON: PERSON } })
    .trim().split('\n').pop());


const inPopup = (nodes) => Boolean(tagged(nodes, 'quick-capture'));
const onInbox = (nodes) => !inPopup(nodes) && !tagged(nodes, 'menu-screen') && Number.isFinite(inboxCount(nodes));
const inScreen = (title) => (nodes) => Boolean(tagged(nodes, 'menu-screen')) && hasText(nodes, title);
const sheetOpen = (nodes) => Boolean(tagged(nodes, 'more-sheet'));


const rowLabel = (nodes, row) => row.text || row['content-desc']
    || nodes.find((node) => node !== row && node.bounds === row.bounds && (node.text || node['content-desc']))?.['content-desc'] || '';
const rowTitles = (nodes) => taskRows(nodes).sort((a, b) => box(a)[1] - box(b)[1]).map((node) => rowLabel(nodes, node));

const capture = async (text, shown) => {
    let nodes = await screen();
    if (!inPopup(nodes)) nodes = await device.openCapture();
    await device.focusAtEnd(tagged(nodes, 'capture-title') ?? fail('no capture field'));
    requireAppFront();
    sh(`input text '${text}'`);
    await waitFor(`"${shown}" in the capture field`, (current) => tagged(current, 'capture-title')?.text === shown, 15_000);
    await tapExpecting(button(await screen(), en['common.save']) ?? fail('no Save'), onInbox, 'the capture to close the popup');
};

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

const swipeRight = async (title) => {
    const row = withDescription(await screen(), title) ?? fail(`no row ${title}`);
    const [x1, y1, , y2] = box(row);
    const y = Math.round((y1 + y2) / 2);
    requireAppFront();

    const from = Math.max(x1 + 10, EDGE_SAFE_X);
    sh(`input swipe ${from} ${y} ${from + 440} ${y} 400`);
    await sleep(700);
    return screen();
};

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const restore = async () => {
    for (const name of PROPS) { try { setProp(name, ''); } catch {                   } }

    try {
        for (let step = 0; step < 3 && front().includes(`${PKG}/`); step += 1) {
            const nodes = await screen();
            if (!tagged(nodes, 'menu-screen') && !sheetOpen(nodes)) break;
            sh('input keyevent KEYCODE_BACK');
            await sleep(800);
        }
        const nodes = await screen();
        if (front().includes(`${PKG}/`) && tab(nodes, en['tab.inbox']) && !tabSelected(nodes, en['tab.inbox'])) await tap(tab(nodes, en['tab.inbox']));
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
    await waitFor('the Inbox', onInbox, 60_000);


    await capture(`${titles.waitingPerson}%s/waiting%s%${PERSON}`, `${titles.waitingPerson} /waiting %${PERSON}`);
    await capture(`${titles.waiting}%s/waiting`, `${titles.waiting} /waiting`);
    await capture(`${titles.someday}%s/someday`, `${titles.someday} /someday`);
    await capture(`${titles.done}%s/done`, `${titles.done} /done`);
    await capture(`${titles.done}0%s+mp${run}`, `${titles.done}0 +mp${run}`);
    await capture(`${titles.archived}%s/archived`, `${titles.archived} /archived`);
    let seen = core();
    check(Object.values(titles).filter((title) => title !== titles.added).every((title) => seen.stored[title].length === 1), 'the five captures are stored once each');


    let nodes = await tapExpecting(tab(await screen(), en['tab.menu']) ?? fail('no Menu tab'), sheetOpen, 'the More sheet');
    nodes = await device.settle(nodes);
    for (const tile of seen.tiles) {
        const node = withDescription(nodes, tile.label) ?? fail(`the sheet lacks core's "${tile.label}"`);
        const built = ['waiting', 'someday', 'reference', 'history', 'projects', 'review', 'contexts', 'trash', 'calendar', 'board', 'settings'].includes(tile.id);
        if (!built && node.enabled !== 'false') fail(`"${tile.label}" is not built here but is enabled`);
    }
    check(true, `(a) the sheet shows core's ${seen.tiles.length} destinations; the unbuilt ones are disabled`);


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


    await waitFor(`the "${SECTION}" heading`, (current) => hasText(current, SECTION), 10_000);
    await device.settle();
    nodes = await device.settle(await device.reveal(titles.someday));
    nodes = await tapExpecting(besideRow(nodes, titles.someday, statusLabel) ?? fail('no status control on the Someday row'),
        (current) => Boolean(withDescription(current, en['viewSections.moveToSection'])), 'the status menu with Move to section…');
    nodes = await tapExpecting(withDescription(nodes, en['viewSections.moveToSection']), (current) => Boolean(withDescription(current, SECTION)), 'core\'s move dialog');
    const [movesBefore, undosBefore] = [commands('somedayMove'), commands('somedayUndo')];
    const moved = en['viewSections.moved'].replace('{section}', SECTION).replace('{count}', '1');


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


    const openStatusMenu = async () => {
        nodes = await device.settle(await device.reveal(titles.someday));
        return tapExpecting(besideRow(nodes, titles.someday, statusLabel) ?? fail('no status control on the Someday row'),
            (current) => Boolean(withDescription(current, en['task.copyTaskId'])), 'the status menu');
    };
    nodes = await openStatusMenu();
    check(hasText(nodes, en['task.destination']) && [en['task.moveToProjectOrArea'], en['viewSections.moveToSection'], en['task.copyTaskLink'], en['task.copyTaskId']]
        .every((label) => withDescription(nodes, label) && hasText(nodes, label)), '(c2) the status menu shows Destination, Move to project or area…, Move to section…, Copy Mindwtr link and Copy task ID, as RN writes them');
    mkdirSync(work, { recursive: true });
    writeFileSync(resolve(work, 'status-menu.png'), adbRaw('exec-out', 'screencap', '-p'));
    await tap(withDescription(nodes, en['task.copyTaskId']));
    await waitFor('RN\'s copied toast', (current) => hasText(current, en['list.taskCopied']), 10_000);
    check(true, `(c2) Copy task ID shows "${en['list.taskCopied']}"`);
    nodes = await openStatusMenu();
    nodes = await tapExpecting(withDescription(nodes, en['task.moveToProjectOrArea']), (current) => Boolean(tagged(current, 'destination-search')), 'core\'s destination picker');
    writeFileSync(resolve(work, 'destination-picker.png'), adbRaw('exec-out', 'screencap', '-p'));
    check(hasText(nodes, en['task.destination']) && hasText(nodes, en['common.none']) && hasText(nodes, en['nav.projects']), '(c2) the picker shows Destination, None and Projects');


    const plain = (name) => /^[A-Za-z0-9 ]{2,40}$/.test(name);
    const target = seen.areas.filter((entry) => plain(entry.name)).map((entry) => ({ kind: 'area', id: entry.id, name: entry.name, label: en['taskEdit.areaLabel'] }))
        .concat(seen.projects.filter((entry) => plain(entry.title)).map((entry) => ({ kind: 'project', id: entry.id, name: entry.title, label: en['nav.projects'] })))[0]
        ?? fail('(c2) the development data has no area and no active project with a plain name to move the task to');
    const rowLabel = `${target.label}: ${target.name}`;
    nodes = await tapExpecting(tagged(nodes, 'destination-search'), () => /mInputShown=true/.test(sh('dumpsys input_method')), 'the keyboard for the picker\'s search');
    sh(`input text '${target.name.replace(/ /g, '%s')}'`);
    nodes = await waitFor(`the picker's row "${rowLabel}"`, (current) => Boolean(withDescription(current, rowLabel)) && hasText(current, en['common.cancel']), 10_000);
    await sleep(600);
    nodes = await device.settle(await screen());
    const keyboard = sh('dumpsys window windows').split(/\n  Window #/).find((part) => part.includes('InputMethod')) ?? fail('no keyboard window');
    const keyboardTop = Number(/ frame=\[\d+,(\d+)\]/.exec(keyboard)?.[1] ?? /mFrame=\[\d+,(\d+)\]/.exec(keyboard)?.[1] ?? NaN)
        + Number(/mGivenContentInsets=\[\d+,(\d+)\]/.exec(keyboard)?.[1] ?? NaN);
    writeFileSync(resolve(work, 'destination-search-keyboard.png'), adbRaw('exec-out', 'screencap', '-p'));

    const bottoms = [withDescription(nodes, rowLabel), nodes.find((node) => node.text === en['common.cancel'])].map((node) => node ? box(node)[3] : NaN);
    check(Number.isFinite(keyboardTop) && bottoms.every((bottom) => bottom <= keyboardTop),
        `(c2) with the keyboard up (top ${keyboardTop}), the found row and Cancel sit above it (bottoms ${bottoms.join(', ')})`);
    const destinationsBefore = commands('taskDestinationMove');
    await tap(withDescription(nodes, rowLabel));
    await waitFor('the move', () => commands('taskDestinationMove') === destinationsBefore + 1, 10_000);
    seen = core();
    const placed = seen.stored[titles.someday][0];
    check(target.kind === 'area' ? placed.areaId === target.id && placed.projectId === null : placed.projectId === target.id && placed.areaId === null,
        `(c2) the ${target.kind} "${target.name}" is stored on the task in one write`);
    nodes = await openStatusMenu();
    nodes = await tapExpecting(withDescription(nodes, en['task.moveToProjectOrArea']), (current) => Boolean(tagged(current, 'destination-search')), 'core\'s destination picker');
    await tap(nodes.find((node) => node.text === en['common.none']) ?? fail('no None row'));
    await waitFor('the move back', () => commands('taskDestinationMove') === destinationsBefore + 2, 10_000);
    seen = core();
    check(seen.stored[titles.someday][0].areaId === null && seen.stored[titles.someday][0].projectId === null, '(c2) None puts the task back with no area and no project, one write more');

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

    await tapExpecting(withDescription(await screen(), en['common.retry']) ?? fail('no Retry in the prompt'),
        (current) => !owedRetry(current) && !tagged(current, 'menu-dialog-field'), 'the prompt\'s Retry');
    seen = core();
    check(seen.stored[titles.added].length === 1 && seen.stored[titles.added][0].id === captureId && seen.stored[titles.added][0].section === seen.sections[0]
        && commands('somedayTask', 'failed') >= 1, `(c) Try again stored the task once, with the capture UUID, in "${SECTION}"`);
    await back(onInbox);


    await openTile(seen.tiles.find((tile) => tile.id === 'reference').label, en['nav.reference']);
    nodes = await waitFor('core\'s Reference list', (current) => rowTitles(current).length > 0 || hasText(current, seen.reference.empty), 20_000);
    const referenceRows = rowTitles(nodes);
    check(seen.reference.rows.length === 0 ? hasText(nodes, seen.reference.empty) : JSON.stringify(referenceRows) === JSON.stringify(seen.reference.rows.slice(0, referenceRows.length)),
        `(d) Reference shows core's list (${seen.reference.rows.length} rows in its first window)`);
    await back(onInbox);


    await openTile(seen.tiles.find((tile) => tile.id === 'history').label, en['nav.history']);

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


    const restoresBefore = commands('archiveAction');
    const restoreLabel = en['trash.restore'];
    nodes = await swipeRight(titles.archived);
    await tapExpecting(withDescription(nodes, restoreLabel) ?? fail('no Restore behind the row'), (current) => !withDescription(current, titles.archived), 'the row to leave Archived');
    await waitFor('the Restore write', () => commands('archiveAction') === restoresBefore + 1, 10_000);
    check(core().stored[titles.archived][0].status === 'inbox' && commands('archiveAction') === restoresBefore + 1, '(f) Restore moved the task to Inbox in one write');


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
