// Calendar and Board check for the isolated native Android development app.
//
//   node apps/android-native/scripts/check-calendar-board-device.mjs <adb-serial> [apk]
//
// Installs the debug APK with `install -r` (existing development data stays), captures two tasks with titles unique to this run,
// and checks the screens against core's own views on a copy of the app's database: (a) the Calendar's month details open the
// composer, whose Save is dimmed whole until a task is chosen, which schedules this run's first capture as an existing task,
// stored once; (b) the day view shows its block and the block opens core's item sheet; (c) the block held and moved stores core's new start once (the move core accepts on a copy);
// (d) the week view shows core's block for it, and the next week, rotation and process death keep the open week; (e) the Board
// shows the second capture in core's Inbox column, and moving the card into Next stores that status once and changes no other
// row; (f) Duplicate with an injected failed commit stores nothing, and Try again stores exactly one copy and keeps the original.
// It opens the screens from the quick-access tab or the More sheet, whichever core's quickAccessView gives, and puts the saved
// calendar view mode back. It touches only the development package (it refuses any other APK), never launches over another app,
// restores rotation and clears its debug properties on exit. Leave the device on its home screen. It needs host `bun`.
// Exit 0 = pass, 1 = fail, 2 = refused before touching the device, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { blended, box, button, check, chipOn, connect, evidenced, fail, inboxCount, inEditor, mainList, owedRetry, Stopped, tab, tabSelected, tagged, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-calendar-board-device.mjs <adb-serial> [apk]');
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
const work = resolve(app, 'android/build/calendar-board-check');
const coreSrc = resolve(app, '../../packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));
// Digits for titles: the keyboard guard allows only an English layout, and digits never compose.
const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const titles = { calendar: `68${run}1`, board: `68${run}2` };

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
/**
 * Core's views on a copy, in the phone's time zone: the More sheet; the Calendar as it opens, today's month cell, the composer's
 * words; for this run's first capture its day view block, item sheet and week block, and the week after; with CHECK_PROBE, the
 * first of RN-sized moves core accepts for it (run on the copy); the Board's columns and this run's second capture in them; and
 * every task's revision, status and board order.
 */
const core = (probe = false) => JSON.parse(execFileSync('bun', ['-e', `
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
    const titles = JSON.parse(process.env.CHECK_TITLES);
    const more = value(host.getMoreMenu());
    const all = (read) => { const first = value(read({ offset: 0, limit: 100 })); let items = first.items;
        while (items.length < first.total) items = items.concat(value(read({ offset: items.length, limit: 100, revision: first.revision })).items); return { ...first, items }; };
    const calendar = (state) => all((page) => host.getCalendarView({ ...(state ? { state } : {}), ...page }));
    const spoken = (item) => item.accessibilityLabel ?? [item.title, item.detail].filter(Boolean).join(', ');
    const opened = calendar(null);
    const todayKey = opened.state.visibleMonth;
    const month = calendar({ viewMode: 'month', selectedDate: todayKey, visibleMonth: todayKey });
    const composer = value(host.openCalendarComposer({ day: todayKey })).composer;
    const store = useTaskStore.getState();
    const live = (title) => store._allTasks.filter((task) => task.title === title && !task.deletedAt);
    const task = live(titles.calendar)[0] ?? null;
    let scheduled = null;
    if (task?.startTime) {
        const start = new Date(task.startTime);
        const key = start.getFullYear() + '-' + String(start.getMonth() + 1).padStart(2, '0') + '-' + String(start.getDate()).padStart(2, '0');
        const dayState = { viewMode: 'day', selectedDate: key, visibleMonth: key };
        const day = calendar(dayState);
        const block = day.items.find((entry) => entry.type === 'item' && entry.lane === 'timed' && entry.item.taskId === task.id)?.item ?? null;
        const sheet = value(host.getCalendarItemSheet({ taskId: task.id, state: dayState }));
        const week = calendar({ viewMode: 'week', selectedDate: key, visibleMonth: key });
        const weekBlock = week.items.find((entry) => entry.type === 'item' && entry.lane === 'timed' && entry.item.taskId === task.id)?.item ?? null;
        const nextWeek = calendar(week.header.next.state);
        let move = null;
        if (process.env.CHECK_PROBE === '1' && block) {
            // RN-sized moves, nearest first; the first core accepts (on this copy) is the one the phone makes.
            for (const delta of [30, 60, -30, 90, -60, 120, -90]) {
                const startMinutes = block.timed.startMinutes + delta;
                if (startMinutes < 0 || startMinutes + block.timed.durationMinutes > 1440) continue;
                const result = await host.runCalendarAction({ requestId: crypto.randomUUID(), state: dayState,
                    action: { type: 'moveTask', taskId: task.id, day: key, startMinutes, durationMinutes: block.timed.durationMinutes, taskRevision: sheet.taskRevision } });
                if (result.ok && result.value.changed) { move = { delta, startTime: useTaskStore.getState()._tasksById.get(task.id).startTime }; break; }
            }
        }
        scheduled = { key, block: block && { spoken: spoken(block), timed: block.timed }, sheet: { title: sheet.title, buttons: sheet.buttons.map((button) => button.label) },
            weekBlock: weekBlock && spoken(weekBlock), weekTitle: week.header.title, next: { label: week.header.next.label, title: nextWeek.header.title }, move };
    }
    const board = value(host.getBoardView({ limit: 100 }));
    const columnCards = (column) => { let cards = column.cards; while (cards.length < column.count) cards = cards.concat(value(host.getBoardList({ list: 'cards',
        status: column.status, filters: board.filters, offset: cards.length, limit: 100, revision: board.revision })).items); return cards.map((card) => card.row.id); };
    const boardTask = live(titles.board)[0] ?? null;
    console.log(JSON.stringify({
        quickAccess: more.quickAccessView,
        tiles: Object.fromEntries([...more.primary, ...more.utilities].map((item) => [item.id, item.label])),
        modes: Object.fromEntries(opened.modes.map((mode) => [mode.mode, mode.label])),
        storedMode: opened.state.viewMode,
        today: month.items.find((entry) => entry.type === 'day' && entry.isToday)?.accessibilityLabel ?? null,
        addTask: opened.text.addTask,
        composer: { existing: composer.text.existingTask, save: composer.text.save },
        task: task && { id: task.id, startTime: task.startTime ?? null },
        scheduled,
        board: {
            columns: Object.fromEntries(board.columns.map((column) => [column.status, column.label])),
            inbox: columnCards(board.columns.find((column) => column.status === 'inbox')),
            duplicate: board.cardActions.swipes.left.label,
            task: boardTask && { id: boardTask.id, status: boardTask.status },
            copies: live(titles.board).map((copy) => copy.id),
        },
        rows: Object.fromEntries(store._allTasks.map((item) => [item.id, [item.rev ?? null, item.status, item.boardOrder ?? null, item.deletedAt ?? null]])),
    }));
    process.exit(0);
`], {
    encoding: 'utf8', maxBuffer: 64 << 20,
    env: { ...process.env, TZ: timeZone, CHECK_DB: pullDatabase(), CHECK_TITLES: JSON.stringify(titles), CHECK_PROBE: probe ? '1' : '' },
}).trim().split('\n').pop());

// ---- UI (core's English) ----
const inPopup = (nodes) => Boolean(tagged(nodes, 'quick-capture'));
const onInbox = (nodes) => !inPopup(nodes) && !tagged(nodes, 'menu-screen') && Number.isFinite(inboxCount(nodes));
const sheetOpen = (nodes) => Boolean(tagged(nodes, 'more-sheet'));
const onCalendar = (nodes) => Boolean(tagged(nodes, 'calendar'));
const onBoard = (nodes) => Boolean(tagged(nodes, 'board'));
const calendarTitle = (nodes) => tagged(nodes, 'calendar-title')?.text;
const tagSuffix = (node, tag) => (node['resource-id'] ?? '').split('/').pop() === tag;
/** A node tagged [tag] whose TalkBack text starts with [title], as core's labels do ("<title>, <detail>"). */
const labelled = (nodes, tag, title) => nodes.find((node) => tagSuffix(node, tag) && ((node['content-desc'] ?? '') === title || (node['content-desc'] ?? '').startsWith(`${title}, `)));
/** Opens the popup from + and saves [text]; the popup closes on Save, as in RN. */
const capture = async (text) => {
    let nodes = await screen();
    if (!inPopup(nodes)) nodes = await device.openCapture();
    await device.focusAtEnd(tagged(nodes, 'capture-title') ?? fail('no capture field'));
    requireAppFront();
    sh(`input text '${text}'`);
    await waitFor(`"${text}" in the capture field`, (current) => tagged(current, 'capture-title')?.text === text, 15_000);
    await tapExpecting(button(await screen(), en['common.save']) ?? fail('no Save'), onInbox, 'the capture to close the popup');
};
/** The More sheet from the Menu tab, then the tile labelled [label], until [done]. */
const openTile = async (label, done, description) => {
    let nodes = await screen();
    if (!sheetOpen(nodes)) nodes = await tapExpecting(tab(nodes, en['tab.menu']) ?? fail('no Menu tab'), sheetOpen, 'the More sheet');
    nodes = await device.settle(nodes);
    return tapExpecting(withDescription(nodes, label) ?? fail(`no ${label} tile`), done, description);
};
const hideKeyboard = async () => {
    if (!/mInputShown=true/.test(sh('dumpsys input_method'))) return;
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await sleep(600);
};
const back = async (done, description = 'Back') => {
    await hideKeyboard();
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    return waitFor(description, done, 15_000);
};
/** Types [text] into the field tagged [tag]. */
const typeInto = async (tag, text) => {
    const nodes = await waitFor(`the field ${tag}`, (current) => Boolean(tagged(current, tag)), 15_000);
    await device.focusAtEnd(tagged(nodes, tag));
    requireAppFront();
    sh(`input text '${text}'`);
    await waitFor(`"${text}" in ${tag}`, (current) => tagged(current, tag)?.text === text, 15_000);
};
/** The display's density (px per dp), as Compose reads it: the override when one is set. */
const pxPerDp = () => {
    const out = sh('wm density');
    const dpi = Number(/Override density: (\d+)/.exec(out)?.[1] ?? /Physical density: (\d+)/.exec(out)?.[1]);
    if (!dpi) fail(`no display density: ${out}`);
    return dpi / 160;
};
/**
 * RN's hold-then-drag: a finger down on [x, y], held past the long press, moved in steps to [x, toY], and lifted. Every step is
 * its own motion event (the finger never lifts); an x well inside the screen, never at an edge (gesture navigation).
 */
const holdAndDrag = async (x, y, toY) => {
    requireAppFront();
    const steps = 8;
    const moves = Array.from({ length: steps }, (_, index) => `input motionevent MOVE ${x} ${Math.round(y + ((toY - y) * (index + 1)) / steps)}`);
    sh(`input motionevent DOWN ${x} ${y}; sleep 0.8; ${moves.join('; ')}; sleep 0.3; input motionevent UP ${x} ${toY}`);
    await sleep(1200);
};
/** The node tagged [tag] labelled [title] when it lies fully inside the screen's main list. */
const inside = (nodes, tag, title) => {
    const node = labelled(nodes, tag, title);
    const list = mainList(nodes);
    if (!node || !list) return undefined;
    const [, top, , bottom] = box(list);
    return box(node)[1] >= top && box(node)[3] <= bottom ? node : undefined;
};
/**
 * Searches the Board for [title], as a user finds one card among thousands (10-15: the phone's 5,724 tasks made Inbox too long
 * to scroll through), then scrolls until the card whose label starts with [title] lies fully inside it. A column longer than
 * core's first window ends in More: a More fully on screen is tapped once, so the column's next window shows.
 */
const revealCard = async (title) => {
    let nodes = await device.toTop();
    if (tagged(nodes, 'board-search')?.text !== title) {
        await typeInto('board-search', title);
        await hideKeyboard();
        nodes = await waitFor(`the Board searched for ${title}`, (current) => Boolean(labelled(current, 'board-card', title)), 15_000);
        nodes = await device.toTop();
    }
    const tapped = new Set();
    for (let step = 0; step < 80 && !inside(nodes, 'board-card', title); step += 1) {
        const more = nodes.find((node) => node.text === en['common.more'] && !tapped.has(node.bounds) && mainList(nodes)
            && box(node)[1] >= box(mainList(nodes))[1] && box(node)[3] <= box(mainList(nodes))[3]);
        if (more) {
            tapped.add(more.bounds);
            await tap(more);
            await sleep(1500);
            nodes = await screen();
            continue;
        }
        const next = await device.swipe(nodes, 'down');
        if (device.signature(next) === device.signature(nodes)) break;
        nodes = next;
    }
    return inside(nodes, 'board-card', title) ? nodes : fail(`no Board card ${title} on screen`);
};
/** Scrolls the week's timeline (the screen's main list) until the block labelled [spoken] shows: down first, then up. */
const revealBlock = async (title, spoken) => {
    let nodes = await screen();
    const found = (current) => inside(current, 'calendar-block', title)?.['content-desc'] === spoken;
    for (const direction of ['down', 'up']) {
        for (let step = 0; step < 12 && !found(nodes); step += 1) {
            const next = await device.swipe(nodes, direction);
            if (device.signature(next) === device.signature(nodes)) break;
            nodes = next;
        }
        if (found(nodes)) return nodes;
    }
    return fail(`core's week block "${spoken}" is not on screen`);
};
/**
 * The card and the column below it ([header], core's label) both on screen, away from the Board's auto-scroll edges (72 from
 * the list's top and bottom), so a held drag from one to the other scrolls nothing. Slow drags move the list without a fling.
 */
const placeForDrop = async (title, header) => {
    const margin = Math.round(72 * pxPerDp()) + 30;
    let nodes = await revealCard(title);
    // A swipe that moved nothing: the list is at its end. A searched Board fits the screen, so its card cannot leave the top edge
    // zone (run6 10-15), and nothing scrolls there either.
    let stuck = false;
    // Eight swipes at most; the ninth pass only checks the last swipe's result (run 48 failed on a screen that fit).
    for (let attempt = 0; attempt < 9; attempt += 1) {
        const list = mainList(nodes);
        const card = labelled(nodes, 'board-card', title);
        const below = nodes.find((node) => tagSuffix(node, 'board-column') && (node['content-desc'] ?? '').startsWith(`${header} · `));
        if (!list || !card) break;
        const [lx1, listTop, lx2, listBottom] = box(list);
        if (below && (stuck || box(card)[1] >= listTop + margin) && box(below)[3] + 40 <= listBottom - margin) return { nodes, card, below };
        if (attempt === 8) break;
        const x = Math.round(lx1 + (lx2 - lx1) * 0.8);
        const middle = Math.round((listTop + listBottom) / 2);
        // Too high: the list moves down; the column below not in reach: the list moves up. At least 200 px: a shorter slow swipe
        // (S23 10-06: the card 9 px too high, 69 px swipes) never moved the list, and every pass saw the same screen.
        const need = box(card)[1] < listTop + margin ? -(listTop + margin - box(card)[1] + 60) : below ? box(below)[3] + 40 - (listBottom - margin) + 60 : 300;
        const by = Math.sign(need) * Math.max(Math.abs(need), 200);
        requireAppFront();
        sh(`input swipe ${x} ${middle} ${x} ${middle - by} 1500`);
        await sleep(800);
        const before = device.signature(nodes);
        nodes = await screen();
        stuck = device.signature(nodes) === before;
    }
    return fail(`the card ${title} and the ${header} column below it do not fit on screen together`);
};

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const timeZone = sh('getprop persist.sys.timezone') || undefined;
let restoreMode = null;
const restore = async () => {
    for (const name of PROPS) { try { setProp(name, ''); } catch { /* device gone */ } }
    try {
        // The saved calendar view mode goes back to what it was (a mode tap saves it, as in RN).
        if (restoreMode && front().includes(`${PKG}/`)) {
            const nodes = await screen();
            const mode = withDescription(nodes, restoreMode);
            if (mode && !chipOn(nodes, restoreMode)) { await tap(mode); await sleep(1500); }
        }
    } catch { /* the app is gone */ }
    // Leave the app on its Inbox tab: the other checks start there.
    try {
        for (let step = 0; step < 5 && front().includes(`${PKG}/`); step += 1) {
            const nodes = await screen();
            if (!tagged(nodes, 'menu-screen') && !sheetOpen(nodes) && !inEditor(nodes)) break;
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
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')}) / ${timeZone ?? 'no time zone'}`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    if (Number(sh('getprop ro.build.version.sdk')) < 30) throw new Stopped('the held drags need `input motionevent` (Android 11 or later)');
    for (const name of PROPS) setProp(name, '');
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    device.launch(ACTIVITY);
    requireAppFront();
    sh('settings put system accelerometer_rotation 0');
    sh('settings put system user_rotation 0');
    await waitFor('the Inbox', onInbox, 60_000);

    for (const title of Object.values(titles)) await capture(title);
    let seen = core();
    check(Boolean(seen.task) && Boolean(seen.board.task), 'the two captures are stored once each');
    restoreMode = seen.modes[seen.storedMode];

    // (a) The Calendar: today's month details, Add task, the composer's Existing task with this capture found and chosen, Save.
    if (seen.quickAccess === 'calendar') await tapExpecting(tab(await screen(), en['nav.calendar']) ?? fail('no Calendar tab'), onCalendar, 'the Calendar tab');
    else await openTile(seen.tiles.calendar, onCalendar, 'the Calendar');
    let nodes = await waitFor('the Calendar\'s modes', (current) => Boolean(withDescription(current, seen.modes.month)), 20_000);
    if (!chipOn(nodes, seen.modes.month)) nodes = await tapExpecting(withDescription(nodes, seen.modes.month), (current) => chipOn(current, seen.modes.month), 'the month view');
    nodes = await waitFor('today\'s cell', (current) => Boolean(seen.today && withDescription(current, seen.today)), 20_000);
    nodes = await tapExpecting(withDescription(nodes, seen.today), (current) => Boolean(tagged(current, 'calendar-add')), 'today\'s details');
    nodes = await tapExpecting(tagged(nodes, 'calendar-add'), (current) => Boolean(tagged(current, 'calendar-composer')), 'the composer');
    // Save fills beside its label, over the sheet in the 10dp gap to its left; RN dims the whole pill to half while core says saveDisabled.
    const savePill = async (name) => {
        const [left, top, , bottom] = box(tagged(await device.settle(await screen()), 'calendar-composer-save') ?? fail('no Save'));
        const [fill, sheet] = device.colors(resolve(work, `save-${name}.png`), [[left + 8, Math.round((top + bottom) / 2)], [left - 14, Math.round((top + bottom) / 2)]]);
        return { fill, sheet };
    };
    await hideKeyboard();
    const emptySave = await savePill('empty');
    nodes = await tapExpecting(withDescription(nodes, seen.composer.existing) ?? fail('no Existing task'), (current) => Boolean(tagged(current, 'calendar-composer-query')), 'Existing task');
    await typeInto('calendar-composer-query', titles.calendar);
    nodes = await waitFor('the capture among core\'s candidates', (current) => Boolean(withDescription(current, titles.calendar)), 15_000);
    await hideKeyboard();
    nodes = await tapExpecting(withDescription(await screen(), titles.calendar), (current) => chipOn(current, titles.calendar), 'the capture chosen');
    const fullSave = await savePill('chosen');
    check(blended(emptySave.fill, fullSave.fill, emptySave.sheet),
        `(a) the empty composer's Save is half its color over the sheet: #${emptySave.fill} (full #${fullSave.fill}, sheet #${emptySave.sheet})`);
    const createsBefore = commands('calendarCreate');
    await tapExpecting(tagged(await screen(), 'calendar-composer-save') ?? fail('no Save'), (current) => !tagged(current, 'calendar-composer'), 'the composer to close');
    await waitFor('the composer\'s write', () => commands('calendarCreate') === createsBefore + 1, 15_000);
    seen = core(true);
    check(Boolean(seen.task.startTime) && commands('calendarCreate') === createsBefore + 1, `(a) the composer scheduled ${titles.calendar} (core's start ${seen.task.startTime}), stored once`);

    // (b) The day view on that start shows core's block; the block opens core's item sheet.
    const scheduled = seen.scheduled ?? fail('core shows no day for the scheduled capture');
    const block = scheduled.block ?? fail('core shows no timed block for the capture');
    nodes = await waitFor(`core's block "${block.spoken}"`, (current) => Boolean(labelled(current, 'calendar-block', titles.calendar)), 20_000);
    check(labelled(nodes, 'calendar-block', titles.calendar)['content-desc'] === block.spoken, `(b) the day view shows core's block ("${block.spoken}")`);
    nodes = await tapExpecting(labelled(nodes, 'calendar-block', titles.calendar), (current) => Boolean(tagged(current, 'calendar-sheet')), 'the item sheet');
    check(scheduled.sheet.buttons.every((label) => Boolean(withDescription(nodes, label))) && nodes.some((node) => node.text === scheduled.sheet.title),
        `(b) the block opens core's item sheet (${scheduled.sheet.buttons.join(', ')})`);
    nodes = await tapExpecting(withDescription(nodes, en['common.cancel']) ?? fail('no Cancel'), (current) => !tagged(current, 'calendar-sheet'), 'the sheet to close');

    // (c) Held and moved by the minutes core accepts (tried on a copy): core's new start, stored once.
    const move = scheduled.move ?? fail('core accepts none of the moves tried for the capture');
    {
        const node = labelled(await screen(), 'calendar-block', titles.calendar) ?? fail('the block left the screen');
        const [x1, y1, x2, y2] = box(node);
        const x = Math.round((x1 + x2) / 2);
        const y = Math.round(y1 + Math.min(40, (y2 - y1) / 2));
        const before = commands('calendarAction');
        await holdAndDrag(x, y, Math.round(y + move.delta * 1.4 * pxPerDp()));
        await waitFor('the move\'s write', () => commands('calendarAction') === before + 1, 15_000);
        seen = core();
        check(seen.task.startTime === move.startTime && commands('calendarAction') === before + 1,
            `(c) the block moved ${move.delta} minutes stores core's start (${move.startTime}) once`);
    }

    // (d) The week view shows core's block; the next week, rotation and process death keep the open week.
    const week = seen.scheduled ?? fail('core shows no week for the capture');
    nodes = await tapExpecting(withDescription(await screen(), seen.modes.week), (current) => chipOn(current, seen.modes.week) && calendarTitle(current) === week.weekTitle, 'the week view');
    nodes = await revealBlock(titles.calendar, week.weekBlock ?? fail('core\'s week shows no block for the capture'));
    check(true, `(d) the week view shows core's block for the capture ("${week.weekBlock}")`);
    const onNext = (current) => onCalendar(current) && calendarTitle(current) === week.next.title;
    nodes = await tapExpecting(withDescription(nodes, week.next.label) ?? fail('no next week'), onNext, 'core\'s next week');
    sh('settings put system user_rotation 1');
    await waitFor('the week in landscape', onNext, 20_000);
    sh('settings put system user_rotation 0');
    await waitFor('the week in portrait', onNext, 20_000);
    const processId = pid();
    requireAppFront();
    sh('input keyevent KEYCODE_HOME');
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    await sleep(1500);
    sh(`run-as ${PKG} kill -9 ${processId}`);
    await waitFor('process death', () => pid() !== processId, 10_000);
    device.launch(ACTIVITY);
    nodes = await waitFor('the week after process death', onNext, 60_000);
    check(true, `(d) rotation and process death keep the Calendar on core's next week ("${week.next.title}")`);
    if (restoreMode !== seen.modes.week && withDescription(nodes, restoreMode)) {
        await tapExpecting(withDescription(nodes, restoreMode), (current) => chipOn(current, restoreMode), 'the saved view mode again');
    }
    restoreMode = null;
    if (seen.quickAccess === 'calendar') await tapExpecting(tab(await screen(), en['tab.inbox']), onInbox, 'the Inbox');
    else await back(onInbox);

    // (e) The Board shows the second capture in core's Inbox column; moving it into Next stores that status once, and no other row changes.
    seen = core();
    check(seen.board.inbox.includes(seen.board.task.id), `(e) core's Board has ${titles.board} in its ${seen.board.columns.inbox} column`);
    check(seen.board.inbox.at(-1) === seen.board.task.id, `(e) the capture is the last card of core's ${seen.board.columns.inbox} column, just above ${seen.board.columns.next}`);
    await openTile(seen.tiles.board, onBoard, 'the Board');
    {
        const { card, below: nextHeader } = await placeForDrop(titles.board, seen.board.columns.next);
        const [x1, y1, x2, y2] = box(card);
        const x = Math.round(x1 + Math.min(200, (x2 - x1) / 2));
        const before = commands('boardAction');
        const rows = seen.rows;
        await holdAndDrag(x, Math.round((y1 + y2) / 2), box(nextHeader)[3] + 40);
        await waitFor('the move\'s write', () => commands('boardAction') === before + 1, 15_000);
        seen = core();
        const changed = Object.keys(seen.rows).filter((id) => JSON.stringify(seen.rows[id]) !== JSON.stringify(rows[id]));
        check(seen.board.task.status === 'next' && commands('boardAction') === before + 1, `(e) the card moved into ${seen.board.columns.next}: status stored once`);
        check(changed.length === 1 && changed[0] === seen.board.task.id, `(e) only the moved card's row changed (${changed.length} changed)`);
    }

    // (f) Duplicate (RN's swipe right past half) under an injected failed commit stores nothing; Try again stores exactly one copy.
    nodes = await revealCard(titles.board);
    {
        const card = labelled(nodes, 'board-card', titles.board);
        const [x1, y1, x2, y2] = box(card);
        const y = Math.round((y1 + y2) / 2);
        const start = x1 + 150; // well inside the card: gesture navigation takes a swipe from the screen edge as Back
        setProp('fail_commit', '1');
        const failedBefore = commands('boardCreate', 'failed');
        const savedBefore = commands('boardCreate');
        requireAppFront();
        sh(`input swipe ${start} ${y} ${Math.min(start + Math.round((x2 - x1) * 0.7), x2 - 10)} ${y} 400`);
        nodes = await waitFor('the injected failure', (current) => Boolean(owedRetry(current)), 15_000);
        seen = core();
        check(seen.board.copies.length === 1 && commands('boardCreate', 'failed') === failedBefore + 1, '(f) the failed Duplicate stored no copy; its exact retry is owed');
        setProp('fail_commit', '');
        await tapExpecting(owedRetry(nodes), (current) => !owedRetry(current), 'Try again');
        await waitFor('the retried write', () => commands('boardCreate') === savedBefore + 1, 15_000);
        seen = core();
        check(seen.board.copies.length === 2 && seen.board.copies.includes(seen.board.task.id), '(f) Try again stored exactly one copy and kept the original');
        // RN opens the copy in the editor.
        await waitFor('the copy in the editor', inEditor, 20_000);
        await back((current) => !inEditor(current), 'the editor to close');
    }
    // The search is the Board's session state only; clear it so the next Board opens unfiltered.
    nodes = await screen();
    const clear = withDescription(nodes, en['filters.clear']);
    if (clear) await tapExpecting(clear, (current) => !tagged(current, 'board-search')?.text, 'the Board search cleared');
    console.log('Calendar and Board device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
