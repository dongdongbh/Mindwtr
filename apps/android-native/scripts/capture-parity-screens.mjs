// Side-by-side screenshots of the React Native app and the native Android app on one fixture.
//
//   node apps/android-native/scripts/build-upgrade-harness.mjs     (once: builds the APKs)
//   node apps/android-native/scripts/capture-parity-screens.mjs <adb-serial>
//
// Bun builds one fixture database through core's own store: 2 areas, 3 projects (one
// sequential, with sections), 20 tasks with contexts, dates, priorities, notes, and one
// starred task, and RN's quick-access tab set to Projects so both tab bars show the same
// tabs. The script installs the harness RN build (154), puts the fixture in as its
// database, and shoots Inbox, Focus, Projects, the task editor (Form tab) for one
// task opened from Focus, global search for "kitchen", Process Inbox's first step, the
// capture popup (empty, with text and core's preview, and with the contexts picker open),
// (PARITY_ONLY=d1b shoots only pass D1b's: Settings › Data with the Backup fold's end (Getting Started), the Import fold open,
// and in light mode the Todoist question and the invalid-import warning.)
// (PARITY_ONLY=s5 shoots only pass S5's: Settings › Sync with File chosen, at its top and at the folder card.)
// (PARITY_ONLY=r2b shoots only pass R2b's Pomodoro card on Focus, in light mode, with the Pomodoro feature and Link task on in the
// fixture: idle with Timer only, the task picker, a linked task, running, paused, the break, and folded. RN's run ends back at
// the idle card with Timer only, so the native build adopts the same session.)
// (PARITY_ONLY=r2 shoots only pass R2's screens, with the weekly review on in the fixture: Settings › Notifications from its
// top and its end, and its day picker.)
// RN's capture screen for each entry kind (a capture link with the keyboard up and down, a share, an assistant note, and a
// widget's quick capture), the Menu tab (the More sheet, Waiting, Someday, History's Done, Contexts, Trash with one trashed
// task, and Review), the Weekly Review's first step, the Calendar's week and month, the Board, and Settings'
// General, GTD (their switches drawn as RN's for the props it sets), Sync (off, then WebDAV chosen with the encryption card's
// Enable flow open, never saved; then File chosen with no folder picked, pass S5), AI (each card unfolded) and Calendar (pass C3: the cards and form, then the subscription
// list; the fixture's one ICS subscription is served on this computer through `adb reverse`, and its events show in the
// Calendar's week and month, the Weekly Review's calendar step and the Daily Review), in light
// and dark mode; and in light mode the attachments (a task's file and link in the editor, the Add link sheet, the project's).
// Then it installs
// the native upgradetest build (153) over it, on the same database, and shoots the same
// screens. It writes rn-*.png, native-*.png, and side-by-side pair-*.png (RN left) to
// /home/dd/.mindwtr-harness/parity/<timestamp>/.
//
// PARITY_ONLY=13a shoots only audit row 13a's, in light mode, against RN 155 (RN 154 predates RN's Daily Review fix 36c6cd6e4):
// a completion's "marked Done" toast with Undo and the task back after Undo, a Process Inbox Trash's toast with Undo and the item
// back in the Inbox, and the Daily Review with seven of the feed's events tomorrow, at its top and scrolled to the last event.
//
// PARITY_ONLY=c3-fixes shoots only C3's 10-10 fixes, in light mode: the Calendar's month with today's details while the same
// range reloads (the feed answers after 15 s: RN's Loading… line over the events kept), and Settings › Calendar's pills at
// system font scale 2.0 and 1.0 (RN's CompactText 1.2x cap). The font scale is restored at the end.
//
// It touches only tech.dongdongbh.mindwtr.upgradetest: it refuses any other APK, sends
// input only while that package is in front, and at the end uninstalls it and restores
// night mode and rotation. Leave the phone on its home screen. Exit 0 = shots taken,
// 1 = failed, 2 = refused, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, button, check, chipOn, connect, EDGE_SAFE_X, evidenced, fail, hasText, inEditor, inList, Stopped, switchOn, tab, tabSelected, withDescription } from './device.mjs';
import { icsCalendar, serveCalendar } from './calendar-feed-server.mjs';

const [serial] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node capture-parity-screens.mjs <adb-serial>');
    process.exit(2);
}
const PKG = 'tech.dongdongbh.mindwtr.upgradetest';
const RN_ACTIVITY = `${PKG}/${PKG}.MainActivity`;
const NATIVE_ACTIVITY = `${PKG}/${PKG}.MainActivity`;
const harness = process.env.MINDWTR_HARNESS_DIR ?? '/home/dd/.mindwtr-harness';
const aapt2 = process.env.AAPT2 ?? '/home/dd/Android/Sdk/build-tools/36.1.0/aapt2';
const coreSrc = resolve(import.meta.dirname, '../../../packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));
const out = resolve(harness, 'parity', new Date().toISOString().replace(/[:.]/g, '-'));
const R2_ONLY = process.env.PARITY_ONLY === 'r2';
const D1B_ONLY = process.env.PARITY_ONLY === 'd1b';
const S5_ONLY = process.env.PARITY_ONLY === 's5';
const R2B_ONLY = process.env.PARITY_ONLY === 'r2b';
const A13_ONLY = process.env.PARITY_ONLY === '13a';
let apks;
try {
    const built = JSON.parse(readFileSync(resolve(harness, 'apks/manifest.json'), 'utf8'));
    apks = { rn: (A13_ONLY ? built.rn155 : built.rn154).path, native: built.native153.path };
} catch {
    console.error(`REFUSED: no ${harness}/apks/manifest.json; run build-upgrade-harness.mjs first`);
    process.exit(2);
}
for (const apk of Object.values(apks)) {
    if (execFileSync(aapt2, ['dump', 'packagename', apk], { encoding: 'utf8' }).trim() !== PKG) {
        console.error(`REFUSED: ${apk} is not ${PKG}`);
        process.exit(2);
    }
}

// ---- the fixture, built through core's store in Bun ----
const T = {
    call: 'Call the plumber about the leak', receipts: 'Scan last month\'s receipts', gift: 'Gift idea for Sam\'s birthday',
    article: 'Read the article on habit tracking', dentist: 'Book a dentist appointment', bikes: 'Look into e-bike prices',
    tiles: 'Choose kitchen tiles', quote: 'Ask for a countertop quote', paint: 'Paint the kitchen walls',
    outline: 'Draft the report outline', numbers: 'Collect Q3 sales numbers', review: 'Review the slides with Priya',
    flights: 'Compare flight prices', hotel: 'Shortlist three hotels', passport: 'Renew passport',
    milk: 'Buy milk and eggs', invoice: 'Send the March invoice', backup: 'Back up the laptop',
    mom: 'Call Mom back', taxes: 'Gather tax documents',
    deck: 'Hear back from Sam about the deck', insurance: 'Renew car insurance',
};
/**
 * Pass C3: one ICS subscription (synced settings), served on this computer through `adb reverse`: a timed event today and an
 * all-day one tomorrow, for the Calendar, the reviews and Settings › Calendar. The device calendars stay off (never read here).
 */
const CALENDAR_PORT = Number(process.env.MINDWTR_CALENDAR_PORT ?? 18784);
const CALENDAR_EVENTS = { timed: 'Design review', allDay: 'Team offsite' };
/** Pass 13a: six more all-day events tomorrow, so the Daily Review's day holds seven, past core's five-event preview. */
const MORE_EVENTS = A13_ONLY ? ['Budget sync', 'Dentist check-up', 'School pickup', 'Gym class', 'Book club', 'Car service'] : [];
const CALENDAR_FEED = { id: 'parity-feed', name: 'Team calendar', url: `http://127.0.0.1:${CALENDAR_PORT}/parity.ics`, enabled: true };
/** One task in Trash (not among T's live tasks), for the Trash screen. */
const TRASHED = 'Old grocery list';
const fixture = resolve(out, 'fixture/mindwtr.db');
/** The fixture's file attachment: its bytes go to the app's files/attachments/ before the first launch (RN's managed copy). */
const ATTACHMENT_FILE = {
    title: 'Paint swatches.pdf',
    uri: `file:///data/user/0/${PKG}/files/attachments/parity-file.pdf`,
    bytes: Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
        + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'),
};
const buildFixture = () => execFileSync('bun', ['-e', `
    import { Database } from 'bun:sqlite';
    import { SqliteAdapter, createNativeHostContract, flushPendingSave, setStorageAdapter, useTaskStore } from '${coreSrc}/index.ts';
    const db = new Database(process.env.FIXTURE_DB, { create: true });
    const client = {
        run: async (sql, params = []) => { db.query(sql).run(...params); },
        all: async (sql, params = []) => db.query(sql).all(...params),
        get: async (sql, params = []) => db.query(sql).get(...params) ?? undefined,
        exec: async (sql) => { db.exec(sql); },
    };
    setStorageAdapter(new SqliteAdapter(client));
    const ready = await createNativeHostContract().activate({ writeSafetyReady: true });
    if (!ready.ok) throw new Error(ready.error.message);
    const T = JSON.parse(process.env.FIXTURE_TITLES);
    const store = () => useTaskStore.getState();
    const day = (offset) => { const d = new Date(Date.now() + offset * 86400000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    // One save at a time: core's incremental saves share this one connection.
    const add = async (title, props = {}) => {
        const result = await store().addTask(title, props);
        if (!result.success) throw new Error('addTask failed: ' + result.error);
        await flushPendingSave();
    };
    const home = await store().addArea('Home', { color: '#10b981' });
    const work = await store().addArea('Work', { color: '#3b82f6' });
    const kitchen = await store().addProject('Kitchen renovation', '#f59e0b', { areaId: home.id, isSequential: true });
    const report = await store().addProject('Quarterly report', '#3b82f6', { areaId: work.id });
    const trip = await store().addProject('Plan summer trip', '#8b5cf6', { areaId: home.id });
    const design = await store().addSection(kitchen.id, 'Design');
    const build = await store().addSection(kitchen.id, 'Build');
    await flushPendingSave();
    for (const title of [T.call, T.receipts, T.gift, T.article, T.dentist, T.bikes]) await add(title, { status: 'inbox' });
    await add(T.tiles, { status: 'next', projectId: kitchen.id, sectionId: design.id, contexts: ['@errands'], dueDate: day(2) });
    await add(T.quote, { status: 'next', projectId: kitchen.id, sectionId: design.id, contexts: ['@phone'] });
    await add(T.paint, { status: 'next', projectId: kitchen.id, sectionId: build.id, description: 'Two coats, the light grey from the sample.' });
    await add(T.outline, { status: 'next', projectId: report.id, contexts: ['@computer'], priority: 'high', dueDate: day(0), isFocusedToday: true });
    await add(T.numbers, { status: 'next', projectId: report.id, contexts: ['@computer'], priority: 'medium', dueDate: day(1) });
    await add(T.review, { status: 'waiting', projectId: report.id, contexts: ['@office'] });
    await add(T.flights, { status: 'next', projectId: trip.id, contexts: ['@computer'], priority: 'low' });
    await add(T.hotel, { status: 'next', projectId: trip.id, startTime: day(3), description: 'Near the old town, with breakfast.' });
    await add(T.passport, { status: 'someday', projectId: trip.id, viewSectionIds: { someday: 'someday-travel' } });
    await add(T.milk, { status: 'next', contexts: ['@errands'], areaId: home.id, dueDate: day(0) });
    await add(T.invoice, { status: 'next', contexts: ['@computer'], areaId: work.id, priority: 'urgent', dueDate: day(-1) });
    await add(T.backup, { status: 'next', contexts: ['@computer'], dueDate: day(6) });
    await add(T.mom, { status: 'next', contexts: ['@phone'] });
    await add(T.taxes, { status: 'someday', areaId: work.id, description: 'W-2, bank statements, receipts folder.' });
    await add(T.deck, { status: 'waiting', assignedTo: 'Sam', contexts: ['@office'], dueDate: day(4) });
    await add(T.insurance, { status: 'done', areaId: home.id });
    // The attachments shots (pass A2): a file (its bytes pushed into files/attachments/) and a link on T.paint, a link on the project.
    const at = new Date().toISOString();
    const paint = store()._allTasks.find((task) => task.title === T.paint);
    await store().updateTask(paint.id, { attachments: [
        { id: 'parity-file', kind: 'file', title: process.env.FIXTURE_FILE_TITLE, uri: process.env.FIXTURE_FILE_URI, mimeType: 'application/pdf',
            size: Number(process.env.FIXTURE_FILE_SIZE), localStatus: 'available', createdAt: at, updatedAt: at },
        { id: 'parity-link', kind: 'link', title: 'https://example.com/paint-colors', uri: 'https://example.com/paint-colors', createdAt: at, updatedAt: at },
    ] });
    // The project's Details values (pass PD): a link, notes, a tag, a due and a review date.
    await store().updateProject(kitchen.id, { attachments: [
        { id: 'parity-project-link', kind: 'link', title: 'https://example.com/kitchen-plan', uri: 'https://example.com/kitchen-plan', createdAt: at, updatedAt: at },
    ], supportNotes: '**Budget** first, then the tiles.\\n\\n- Ask for two quotes', tagIds: ['#home'], dueDate: day(14), reviewAt: new Date(Date.now() + 7 * 86_400_000).toISOString() });
    await flushPendingSave();
    const trashed = await store().addTask(process.env.FIXTURE_TRASHED, { status: 'inbox' });
    if (!trashed.success) throw new Error('addTask failed: ' + trashed.error);
    await flushPendingSave();
    if (!(await store().deleteTask(trashed.id)).success) throw new Error('deleteTask failed');
    await flushPendingSave();
    // RN's quick-access tab set to Projects (both tab bars show the same tabs), and one Someday section for the headings.
    await store().updateSettings({ appearance: { mobileQuickAccessView: 'projects' }, externalCalendars: [JSON.parse(process.env.FIXTURE_FEED)],
        gtd: { ...(store().settings.gtd ?? {}), viewSections: { someday: [{ id: 'someday-travel', title: 'Travel', order: 0 }] } } });
    // Pass R2's shots: the weekly review on (its day picker opens).
    if (process.env.FIXTURE_R2 === '1') await store().updateSettings({ weeklyReviewEnabled: true });
    // Pass R2b's shots: the Pomodoro card on Focus, with its Link task row.
    if (process.env.FIXTURE_R2B === '1') await store().updateSettings({ features: { ...(store().settings.features ?? {}), pomodoro: true },
        gtd: { ...(store().settings.gtd ?? {}), pomodoro: { ...(store().settings.gtd?.pomodoro ?? {}), linkTask: true } } });
    await flushPendingSave();
    if (store().persistenceFailure) throw new Error('save failed: ' + store().persistenceFailure.message);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    console.log(store()._allTasks.filter((task) => !task.deletedAt).length);
    process.exit(0);
`], { encoding: 'utf8', env: { ...process.env, FIXTURE_DB: fixture, FIXTURE_TITLES: JSON.stringify(T), FIXTURE_TRASHED: TRASHED,
    FIXTURE_FEED: JSON.stringify(CALENDAR_FEED), FIXTURE_FILE_TITLE: ATTACHMENT_FILE.title, FIXTURE_FILE_URI: ATTACHMENT_FILE.uri, FIXTURE_FILE_SIZE: String(ATTACHMENT_FILE.bytes.length), FIXTURE_R2: R2_ONLY ? '1' : '', FIXTURE_R2B: R2B_ONLY ? '1' : '' } }).trim().split('\n').pop();

// ---- the device ----
const device = connect({ serial, pkg: PKG, uiFile: '/data/local/tmp/mindwtr-parity-ui.xml' });
const { adbRaw, sh, home, front, requireAppFront, pid, screen, waitFor, tap } = device;
const runAs = (command) => sh(`run-as ${PKG} ${command}`);
const installed = () => sh(`pm list packages ${PKG}`).split('\n').some((line) => line.trim() === `package:${PKG}`);
const originalNight = /Night mode: (\w+)/.exec(sh('cmd uimode night'))?.[1] ?? 'auto';
const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const shots = [];
let calendarServer = null;

const stopApp = async () => {
    await device.stopApp();
};
const setNight = async (mode) => {
    sh(`cmd uimode night ${mode}`);
    await sleep(2500); // the app redraws (RN) or is recreated (native) in the new mode
};
/** Waits for [text] (a fixture title or a tab label), then saves a screenshot; a missing text is reported, not fatal. */
const shoot = async (name, ready) => {
    try { await waitFor(`${name} to show`, ready, 45_000); } catch { console.log(`warn - ${name}: expected content not found; shot taken anyway`); }
    await sleep(1200);
    requireAppFront();
    const file = resolve(out, `${name}.png`);
    writeFileSync(file, adbRaw('exec-out', 'screencap', '-p'));
    shots.push(name);
    console.log(`shot ${basename(file)}`);
};
/** Sends an intent (am start arguments) to the harness package only, from the app itself or the home screen. */
const openIntent = (args) => {
    const current = front();
    if (!current.includes(`${PKG}/`) && !current.includes(`${home}/`)) throw new Stopped(`another app is in front: ${current.trim()}`);
    sh(`am start -W ${args} ${PKG}`);
};
const openLink = (path) => openIntent(`-a android.intent.action.VIEW -d 'mindwtr-upgradetest://${path}'`);
/** The task whose editor is shot: opened from Focus, where it has a project, a context, a priority, and a due date. */
const EDITOR_TASK = T.outline;
/** Opens the editor for EDITOR_TASK from the Focus screen on show, shoots it, and closes it with Back (nothing was edited). */
const shootEditor = async (name, rn) => {
    const nodes = await waitFor(`${EDITOR_TASK} in Focus`, (current) => Boolean(inList(current, EDITOR_TASK)), 45_000);
    await tap(inList(nodes, EDITOR_TASK));
    const formShown = (current) => current.some((node) => node.class === 'android.widget.EditText' && node.text === EDITOR_TASK)
        && (rn || inEditor(current));
    // Both open on the View tab here (Edit | Preview tabs, no title field; RN's resolveTaskOpenTab for Focus); the Edit tab is the Form tab.
    const rnTabs = (current) => (rn ? hasText(current, 'Preview') : Boolean(withDescription(current, 'Preview'))) && Boolean(button(current, 'Edit'));
    const open = await waitFor(`the editor for ${EDITOR_TASK}`, (current) => formShown(current) || rnTabs(current), 30_000);
    if (!formShown(open)) await tap(button(open, 'Edit'));
    await shoot(name, formShown);
    const editorOpen = (current) => formShown(current) || rnTabs(current);
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await waitFor('the editor to close', (current) => !editorOpen(current), 15_000);
};
/** Core's en `inbox.processButton` with the fixture's six Inbox tasks: the button's spoken label in both apps. */
const PROCESS = 'Process Inbox (6)';
const SEARCH_QUERY = 'kitchen';
/** Closes the keyboard if it shows, so the shot matches RN's (its search opened by link leaves the keyboard down). */
const hideKeyboard = async () => {
    if (!/mInputShown=true/.test(sh('dumpsys input_method'))) return;
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await sleep(800);
};
/** Opens Process Inbox from the Inbox on show, shoots its first step (the fixture's first Inbox task), and closes it with Back. */
const shootProcess = async (name) => {
    const nodes = await waitFor('the Process Inbox button', (current) => current.some((node) => node['content-desc'] === PROCESS), 45_000);
    await tap(nodes.find((node) => node['content-desc'] === PROCESS));
    const shown = (current) => current.some((node) => node.class === 'android.widget.EditText' && node.text === T.call);
    await shoot(name, shown);
    await hideKeyboard();
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await waitFor('Process Inbox to close', (current) => !shown(current), 15_000);
};
/**
 * The capture popup from the tab bar's + (both apps label it core's nav.addTask): empty, then with a typed draft
 * and its preview, then with the contexts picker open. Back closes it (the first Back may only close the keyboard).
 */
const CAPTURE_TEXT = 'Call Sam @phone #home';
const shootPopup = async (prefix, suffix) => {
    const nodes = await waitFor('the + button', (current) => current.some((node) => node['content-desc'] === 'Add Task'), 30_000);
    await tap(nodes.find((node) => node['content-desc'] === 'Add Task'));
    const field = (current) => current.find((node) => node.class === 'android.widget.EditText');
    await shoot(`${prefix}-popup-empty-${suffix}`, (current) => Boolean(field(current)));
    // Add another switched on (a switch on shows where its track starts), its bounds printed, then off again (it is remembered).
    const another = 'Add another';
    await tap(withDescription(await device.screen(), another));
    await shoot(`${prefix}-popup-another-${suffix}`, (current) => switchOn(current, another));
    console.log(`bounds ${prefix}-popup-another-${suffix} ${withDescription(await device.screen(), another)?.bounds}`);
    await tap(withDescription(await device.screen(), another));
    await waitFor('Add another off', (current) => !switchOn(current, another), 15_000);
    requireAppFront();
    sh(`input text '${CAPTURE_TEXT.replace(/ /g, '%s')}'`);
    await shoot(`${prefix}-popup-text-${suffix}`, (current) => field(current)?.text === CAPTURE_TEXT && hasText(current, '@phone'));
    const chip = await waitFor('the contexts chip', (current) => current.some((node) => node['content-desc']?.startsWith('Contexts: ')), 15_000);
    await tap(chip.find((node) => node['content-desc']?.startsWith('Contexts: ')));
    await shoot(`${prefix}-popup-picker-${suffix}`, (current) => current.some((node) => node.text === 'Clear'));
    for (let attempt = 0; attempt < 3 && (await device.screen()).some((node) => node.class === 'android.widget.EditText'); attempt += 1) {
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(800);
    }
};
/**
 * RN's capture screen (capture-modal.tsx) for each entry kind, in both apps by the same intents: a capture link (a title with
 * tokens, so core's preview shows, a note, tags and a project), a share (a subject, and a body with a URL), an assistant note,
 * and a widget's quick capture. The link is shot with the keyboard up (RN focuses the field) and every kind with it down;
 * Cancel then writes nothing. Quick capture's Cancel puts the app behind the previous screen (#1169), so the app is launched
 * again. RN's capture links are read only on the mindwtr scheme (core's parser), which the harness RN app does not register,
 * so RN gets them by its component; RN's MainActivity turns the note into such a link itself.
 */
const MODAL = { title: 'Call Sam @phone #home', note: 'Ask about Saturday', subject: 'Quarterly numbers', body: 'The numbers are in https://example.com/q3', named: 'Water the plants' };
const shootModal = async (prefix, suffix, activity) => {
    const capture = (path) => (prefix === 'rn' ? openIntent(`-a android.intent.action.VIEW -d 'mindwtr://${path}' -n ${RN_ACTIVITY}`) : openLink(path));
    const kinds = [
        ['link', () => capture(`capture?title=${encodeURIComponent(MODAL.title)}&note=${encodeURIComponent(MODAL.note)}&tags=home,errands&project=${encodeURIComponent('Kitchen renovation')}`), MODAL.title],
        ['share', () => openIntent(`-a android.intent.action.SEND -t text/plain --es android.intent.extra.SUBJECT '${MODAL.subject}' --es android.intent.extra.TEXT '${MODAL.body}'`), MODAL.subject],
        ['note', () => openIntent(`-a com.google.android.gms.actions.CREATE_NOTE -t text/plain --es com.google.android.gms.actions.extra.NAME '${MODAL.named}'`), MODAL.named],
        ['quick', () => capture('capture-quick'), ''],
    ];
    for (const [kind, open, title] of kinds) {
        open();
        const shown = (current) => hasText(current, 'Add Task') && current.some((node) => node.class === 'android.widget.EditText' && (title === '' || node.text === title));
        if (kind === 'link') await shoot(`${prefix}-modal-link-keyboard-${suffix}`, shown);
        try { await waitFor(`the ${kind} capture screen`, shown, 30_000); } catch { console.log(`warn - ${prefix} ${kind}: the capture screen did not show`); }
        await sleep(1500);
        await hideKeyboard();
        await shoot(`${prefix}-modal-${kind}-${suffix}`, shown);
        // The link's screen with the ? open: core's syntax help, on RN's line height.
        if (kind === 'link') {
            const help = await waitFor('the ? button', (current) => Boolean(button(current, '?')), 15_000);
            await tap(button(help, '?'));
            await shoot(`${prefix}-modal-help-${suffix}`, (current) => current.some((node) => (node.text ?? '').includes('/due:')));
            await tap(button(await device.screen(), '?'));
            await sleep(800);
        }
        const nodes = await waitFor('Cancel on the capture screen', (current) => Boolean(button(current, 'Cancel')), 15_000);
        await tap(button(nodes, 'Cancel'));
        await sleep(1500);
        if (kind === 'quick') {
            await waitFor('the app to go behind', () => !front().includes(`${PKG}/`), 15_000);
            device.launch(activity);
            await sleep(2000);
        }
    }
};
/**
 * The Menu tab: RN's More sheet from the Menu tab (both apps label it core's tab.menu), then Waiting, Someday, and History's
 * Done (RN by its links, native from the sheet's tiles), each shot and closed with Back.
 */
const MENU_SCREENS = [
    { name: 'waiting', link: 'waiting', tile: 'Waiting For', text: T.deck },
    { name: 'someday', link: 'someday', tile: 'Someday/Maybe', text: T.passport },
    { name: 'done', link: 'history?tab=done', tile: 'History', text: T.insurance },
    { name: 'contexts', link: 'contexts', tile: en['nav.contexts'], text: '@phone' },
    { name: 'trash', link: 'trash', tile: en['nav.trash'], text: TRASHED },
    // RN's Review opens on its Due scope: the fixture has nothing due for review, so both show core's empty line.
    { name: 'review', link: 'review', tile: en['nav.review'], text: en['review.dueEmpty'] },
    // The Calendar is shot in its week and month views (a mode tap saves the mode, in both apps); the Board opens on its Inbox column.
    { name: 'calendar', link: 'calendar', tile: en['nav.calendar'], text: en['calendar.mobile.week'] },
    { name: 'board', link: 'board', tile: en['tab.board'], text: T.call },
];
/** Taps the Calendar's mode labelled [label] (both apps label the mode buttons with core's words) and waits for it to be on. */
const calendarMode = async (label) => {
    const nodes = await waitFor(`the ${label} mode`, (current) => Boolean(withDescription(current, label)), 15_000);
    if (!chipOn(nodes, label)) await tap(withDescription(nodes, label));
    return waitFor(`the ${label} view`, (current) => chipOn(current, label), 15_000);
};
const shootMenu = async (prefix, suffix, rn) => {
    const openSheet = async () => {
        const nodes = await waitFor('the Menu tab', (current) => Boolean(rn ? current.find((node) => node['content-desc'] === 'Menu') : tab(current, 'Menu')), 30_000);
        await tap(rn ? nodes.find((node) => node['content-desc'] === 'Menu') : tab(nodes, 'Menu'));
    };
    await openSheet();
    await shoot(`${prefix}-more-${suffix}`, (current) => current.some((node) => node['content-desc'] === 'Waiting For'));
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await sleep(1000);
    for (const screen of MENU_SCREENS) {
        if (rn) openLink(screen.link);
        else {
            await openSheet();
            const nodes = await waitFor(`the ${screen.tile} tile`, (current) => current.some((node) => node['content-desc'] === screen.tile), 15_000);
            await tap(nodes.find((node) => node['content-desc'] === screen.tile));
        }
        if (screen.name === 'calendar') {
            await calendarMode(en['calendar.mobile.week']);
            await shoot(`${prefix}-calendar-week-${suffix}`, (current) => chipOn(current, en['calendar.mobile.week']) && hasText(current, en['calendar.allDay']));
            await calendarMode(en['calendar.mobile.month']);
            await shoot(`${prefix}-calendar-month-${suffix}`, (current) => chipOn(current, en['calendar.mobile.month']));
            requireAppFront();
            sh('input keyevent KEYCODE_BACK');
            await sleep(1000);
            continue;
        }
        // A Trash row speaks its title (the row is one TalkBack node), so its title may be the node's description; so does a Board card.
        await shoot(`${prefix}-${screen.name}-${suffix}`, (current) => hasText(current, screen.text) || current.some((node) => node['content-desc'] === screen.text
            || (node['content-desc'] ?? '').startsWith(`${screen.text}, `)));
        // From Review: Start Review, then the Weekly Review's first step (the Inbox), closed with its X.
        if (screen.name === 'review') {
            const start = await waitFor('Start Review', (current) => Boolean(button(current, en['review.startReview'])), 15_000);
            await tap(button(start, en['review.startReview']));
            const choices = await waitFor('the Weekly Review choice', (current) => Boolean(button(current, en['review.openGuide'])), 15_000);
            await tap(button(choices, en['review.openGuide']));
            await shoot(`${prefix}-weekly-${suffix}`, (current) => hasText(current, T.call));
            // Pass C3: Next until the calendar step (its "Mindwtr tasks" heading), with the subscription's events.
            try {
                for (let step = 0; step < 6 && !hasText(await device.screen(), en['review.calendarTasks']); step += 1) {
                    await tap(button(await device.screen(), en['review.next']) ?? fail('no Next'));
                    await sleep(1500);
                }
                await shoot(`${prefix}-weekly-calendar-${suffix}`, (current) => hasText(current, CALENDAR_EVENTS.timed) || current.some((node) => (node['content-desc'] ?? '').includes(CALENDAR_EVENTS.timed)));
            } catch (error) { console.log(`warn - ${prefix} weekly calendar step: ${error.message}`); }
            const close = await waitFor('the review\'s Close', (current) => Boolean(button(current, en['common.close'])), 15_000);
            await tap(button(close, en['common.close']));
            await sleep(1000);
            // The Daily Review's first step (today: the subscription's event under Today's calendar).
            try {
                const again = await waitFor('Start Review', (current) => Boolean(button(current, en['review.startReview'])), 15_000);
                await tap(button(again, en['review.startReview']));
                const daily = await waitFor('the Daily Review choice', (current) => Boolean(button(current, en['dailyReview.title'])), 15_000);
                await tap(button(daily, en['dailyReview.title']));
                await shoot(`${prefix}-daily-${suffix}`, (current) => hasText(current, CALENDAR_EVENTS.timed) || current.some((node) => (node['content-desc'] ?? '').includes(CALENDAR_EVENTS.timed)));
                const closeDaily = await waitFor('the review\'s Close', (current) => Boolean(button(current, en['common.close'])), 15_000);
                await tap(button(closeDaily, en['common.close']));
                await sleep(1000);
            } catch (error) { console.log(`warn - ${prefix} daily review: ${error.message}`); }
        }
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(1000);
    }
};
/**
 * Settings from the More sheet's Settings tile (both apps, shot as settings-menu), then General, GTD and Sync (their menu rows, core's labels): each
 * shot with its first switch or RN's "Sync is off" box on screen, and closed with Back; Back again leaves Settings.
 */
const SETTINGS_SCREENS = [
    { name: 'general', row: `${en['settings.general']}. ${en['settings.menuDesc.general']}`, text: en['settings.mobile.showTaskAge'] },
    { name: 'gtd', row: `${en['settings.gtd']}. ${en['settings.menuDesc.gtd']}`, text: en['settings.featurePomodoro'] },
    // Sync is off on the fixture: the backend card, the setup guide, and RN's "Sync is off" box.
    { name: 'sync', row: `${en['settings.sync']}. ${en['settings.menuDesc.sync']}`, text: en['settings.syncOff'] },
];
const shootSettings = async (prefix, suffix, rn) => {
    const menu = await waitFor('the Menu tab', (current) => Boolean(rn ? current.find((node) => node['content-desc'] === 'Menu') : tab(current, 'Menu')), 30_000);
    await tap(rn ? menu.find((node) => node['content-desc'] === 'Menu') : tab(menu, 'Menu'));
    const sheet = await waitFor('the Settings tile', (current) => Boolean(withDescription(current, en['nav.settings'])), 15_000);
    await tap(withDescription(sheet, en['nav.settings']));
    await shoot(`${prefix}-settings-menu-${suffix}`, (current) => Boolean(withDescription(current, SETTINGS_SCREENS[0].row)));
    for (const screen of SETTINGS_SCREENS) {
        const rows = await waitFor(`the ${screen.name} row`, (current) => Boolean(withDescription(current, screen.row)), 30_000);
        await tap(withDescription(rows, screen.row));
        await shoot(`${prefix}-settings-${screen.name}-${suffix}`, (current) => hasText(current, screen.text));
        if (screen.name === 'sync') {
            await shootEncryption(prefix, suffix);
            await shootFilePanel(prefix, suffix);
        }
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(1000);
    }
    await shootData(prefix, suffix);
    await shootAI(prefix, suffix, rn);
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await sleep(1000);
};
/**
 * Pass D1a: Settings › Data folded and with the Backup fold open (both modes); in light mode also the Merge and Restore questions
 * for a pushed backup (cancelled, so nothing is written), the invalid-file warning, and Sync › Recovery snapshots open. A shot
 * that cannot be reached is reported, never fatal to the other shots. Ends on the Settings menu.
 */
const DATA_DIR = '/sdcard/Download/mindwtr-parity-d1';
const DATA_FILES = { valid: 'd1-parity-backup.json', invalid: 'd1-parity-invalid.json', todoist: 'd1b-parity-todoist.csv' };
const pushDataFiles = () => {
    const at = new Date().toISOString();
    const task = (title) => ({ id: `parity-${title}`, title, status: 'next', tags: [], contexts: [], createdAt: at, updatedAt: at, rev: 1 });
    writeFileSync(resolve(out, `fixture/${DATA_FILES.valid}`), JSON.stringify({ tasks: [task('Backup task one'), task('Backup task two')], projects: [], sections: [], areas: [], people: [], settings: {} }, null, 2));
    writeFileSync(resolve(out, `fixture/${DATA_FILES.invalid}`), 'not a Mindwtr backup');
    writeFileSync(resolve(out, `fixture/${DATA_FILES.todoist}`), 'TYPE,CONTENT,PRIORITY,INDENT,DATE,DESCRIPTION\nsection,Planning,,,,\ntask,Plan launch,1,1,,Write the brief\ntask,Follow up,4,2,,\n');
    sh(`mkdir -p ${DATA_DIR}`);
    for (const name of Object.values(DATA_FILES)) adbRaw('push', resolve(out, `fixture/${name}`), `${DATA_DIR}/${name}`);
};
const anyNodes = () => {
    const xml = adbRaw('exec-out', 'uiautomator', 'dump', '/dev/tty').toString('utf8');
    return [...xml.matchAll(/<node [^>]*>/g)].map(([node]) => Object.fromEntries([...node.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value])));
};
const tapNode = (node) => { const [x1, y1, x2, y2] = node.bounds.match(/\d+/g).map(Number); sh(`input tap ${Math.round((x1 + x2) / 2)} ${Math.round((y1 + y2) / 2)}`); };
/** The system document picker: the file named [name], found in its list or through its search. */
const pickParityFile = async (name) => {
    for (let wait = 0; wait < 30 && front().includes(`${PKG}/`); wait += 1) await sleep(500);
    await sleep(1500);
    let nodes = anyNodes();
    let hit = nodes.find((node) => node.text === name);
    if (!hit) {
        const search = nodes.find((node) => /search/i.test(`${node['content-desc']} ${node['resource-id']}`) && node.clickable === 'true');
        if (search) { tapNode(search); await sleep(800); sh(`input text '${name}'`); sh('input keyevent KEYCODE_ENTER'); await sleep(2500); nodes = anyNodes(); hit = nodes.filter((node) => node.text === name).at(-1); }
    }
    if (!hit) fail(`the document picker did not show ${name}`);
    tapNode(hit);
    for (let wait = 0; wait < 30 && !front().includes(`${PKG}/`); wait += 1) await sleep(500);
};
/** A Data row: RN's label text, or the native row's one TalkBack node ("label, description"). */
const dataRow = (nodes, label) => nodes.find((node) => node.text === label || (node['content-desc'] ?? '').startsWith(`${label}, `));
const shootData = async (prefix, suffix) => {
    try {
        const rows = await waitFor('the Data row', (current) => Boolean(withDescription(current, `${en['settings.data']}. ${en['settings.menuDesc.data']}`)), 30_000);
        await tap(withDescription(rows, `${en['settings.data']}. ${en['settings.menuDesc.data']}`));
        await shoot(`${prefix}-settings-data-${suffix}`, (current) => Boolean(dataRow(current, en['settings.backup'])));
        await tap(dataRow(await screen(), en['settings.backup']) ?? fail('no Backup fold'));
        await shoot(`${prefix}-settings-data-backup-${suffix}`, (current) => Boolean(dataRow(current, en['settings.exportBackup'])));
        if (suffix === 'light') {
            const question = async (row, file, name, ready) => {
                await tap(dataRow(await screen(), row) ?? fail(`no ${row} row`));
                await pickParityFile(file);
                await shoot(`${prefix}-settings-data-${name}-${suffix}`, ready);
                const cancel = (await screen()).find((node) => /^cancel$/i.test(node.text || node['content-desc'] || ''));
                if (cancel) await tap(cancel);
                await sleep(1500);
            };
            await question(en['settings.mergeBackup'], DATA_FILES.valid, 'merge-question', (current) => current.some((node) => /^cancel$/i.test(node.text || node['content-desc'] || '')));
            await question(en['settings.syncMobile.restoreBackup'], DATA_FILES.valid, 'restore-question', (current) => current.some((node) => /^cancel$/i.test(node.text || node['content-desc'] || '')));
            await tap(dataRow(await screen(), en['settings.mergeBackup']) ?? fail('no Merge row'));
            await pickParityFile(DATA_FILES.invalid);
            await shoot(`${prefix}-settings-data-invalid-${suffix}`, (current) => hasText(current, en['settings.backupMobile.invalidBackup']));
        }
    } catch (error) {
        console.log(`warn - ${prefix} Data screen: ${error.message}`);
    }
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await sleep(1000);
    if (suffix !== 'light') return;
    try {
        const syncRow = (current) => current.find((node) => (node['content-desc'] ?? '').startsWith(`${en['settings.sync']}. `));
        const rows = await waitFor('the Sync row', (current) => Boolean(syncRow(current)), 30_000);
        await tap(syncRow(rows));
        let nodes = await waitFor('Sync', (current) => hasText(current, en['settings.syncOff']) || Boolean(dataRow(current, en['settings.recoverySnapshots'])), 30_000);
        const snapshots = (current) => current.find((node) => node.text === en['settings.recoverySnapshots'] || (node['content-desc'] ?? '').startsWith(`${en['settings.recoverySnapshots']}, `));
        for (let step = 0; step < 20 && !snapshots(nodes); step += 1) nodes = await device.swipe(nodes, 'down');
        await tap(snapshots(nodes) ?? fail('no Recovery snapshots card'));
        await shoot(`${prefix}-settings-sync-snapshots-${suffix}`, (current) => hasText(current, en['settings.recoverySnapshotsEmpty']));
    } catch (error) {
        console.log(`warn - ${prefix} Recovery snapshots: ${error.message}`);
    }
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await sleep(1000);
};
/**
 * Pass S4b: the sync encryption card's Enable flow (RN's warnings, the passphrase fields, Generate, Enable, Cancel). WebDAV is
 * chosen but never saved (no URL), so nothing is stored; the card shows under its form. Reported, never fatal to other shots.
 */
const shootEncryption = async (prefix, suffix) => {
    const labelled = (nodes, label) => nodes.find((node) => node.text === label || node['content-desc'] === label);
    try {
        await tap(labelled(await screen(), en['settings.syncBackendWebdav']) ?? fail('no WebDAV chip'));
        // The form and the card come in below the chips; their first words differ between the apps, so scroll for Enable.
        await sleep(1500);
        let nodes = await screen();
        for (let step = 0; step < 20 && !labelled(nodes, en['settings.syncEncryptionEnable']); step += 1) nodes = await device.swipe(nodes, 'down');
        if (!labelled(nodes, en['settings.syncEncryptionEnable'])) writeFileSync(resolve(out, `${prefix}-encryption-failed.xml`), adbRaw('exec-out', 'uiautomator', 'dump', '/dev/tty'));
        await tap(labelled(nodes, en['settings.syncEncryptionEnable']) ?? fail('no Enable encryption'));
        nodes = await waitFor('the Enable flow', (current) => hasText(current, en['settings.syncEncryptionWarningLost']), 15_000);
        // The flow's top (its warnings) a little below the top of the screen.
        for (let step = 0; step < 3 && !hasText(nodes, en['settings.syncEncryptionDesc']); step += 1) nodes = await device.swipe(nodes, 'up');
        await shoot(`${prefix}-settings-encryption-${suffix}`, (current) => hasText(current, en['settings.syncEncryptionWarningLost']));
    } catch (error) {
        console.log(`warn - ${prefix} encryption card: ${error.message}`);
    }
};
/**
 * Pass S5: the File Sync panel, File chosen and no folder picked yet (the how-to box, Sync folder with Select Folder, Sync now).
 * Nothing is picked or stored. Reported, never fatal to other shots.
 */
const shootFilePanel = async (prefix, suffix) => {
    const labelled = (nodes, label) => nodes.find((node) => node.text === label || node['content-desc'] === label);
    try {
        let nodes = await screen();
        for (let step = 0; step < 20 && !labelled(nodes, en['settings.syncBackendFile']); step += 1) nodes = await device.swipe(nodes, 'up');
        await tap(labelled(nodes, en['settings.syncBackendFile']) ?? fail('no File chip'));
        await sleep(1500);
        // Two places both apps reach alike: the top (the chips and the how-to box), then the folder card, brought up with short
        // slow drags (a swipe flings RN's ScrollView past it) until Select Folder sits in the screen's upper half.
        for (let step = 0; step < 20; step += 1) {
            const next = await device.swipe(await screen(), 'up');
            if (device.signature(next) === device.signature(nodes)) break;
            nodes = next;
        }
        await shoot(`${prefix}-settings-sync-file-${suffix}`, (current) => Boolean(labelled(current, en['settings.syncBackendFile'])));
        const placed = (current) => { const node = labelled(current, en['settings.selectFolder']); return node && box(node)[1] > 250 && box(node)[3] < 1200; };
        nodes = await screen();
        for (let step = 0; step < 12 && !placed(nodes); step += 1) {
            requireAppFront();
            sh('input swipe 540 1500 540 1000 900');
            await sleep(800);
            nodes = await screen();
        }
        await shoot(`${prefix}-settings-sync-file-folder-${suffix}`, placed);
    } catch (error) {
        console.log(`warn - ${prefix} File Sync panel: ${error.message}`);
    }
};
/**
 * Settings › Advanced › AI (pass C1): the assistant card unfolded, then folded again and the speech card unfolded, each shot at
 * the top of the screen. A card's heading is RN's touchable row (tapped on its description) or the native FoldRow (one node,
 * "title, description"). Back twice returns to the Settings menu.
 */
const shootAI = async (prefix, suffix, rn) => {
    const rows = await waitFor('the Advanced row', (current) => Boolean(withDescription(current, `${en['settings.advanced']}. ${en['settings.menuDesc.advanced']}`)), 30_000);
    await tap(withDescription(rows, `${en['settings.advanced']}. ${en['settings.menuDesc.advanced']}`));
    const advanced = await waitFor('the AI row', (current) => Boolean(withDescription(current, `${en['settings.ai']}. ${en['settings.menuDesc.ai']}`)), 30_000);
    await tap(withDescription(advanced, `${en['settings.ai']}. ${en['settings.menuDesc.ai']}`));
    const heading = (current, title, description) => (rn ? current.find((node) => node.text === description) : withDescription(current, `${title}, ${description}`));
    const cards = [[en['settings.ai'], en['settings.aiDesc'], en['settings.aiEnable']], [en['settings.speechTitle'], en['settings.speechDesc'], en['settings.speechEnable']]];
    for (const [index, [title, description, inside]] of cards.entries()) {
        // The speech card is shot alone: the assistant card folds again first (unfolded, it pushes the speech card below the fold).
        if (index === 1) {
            await tap(heading(await screen(), cards[0][0], cards[0][1]) ?? fail('no assistant card heading'));
            await waitFor('the assistant card folded', (current) => !hasText(current, cards[0][2]), 15_000);
        }
        const shown = await waitFor(`the ${title} card`, (current) => Boolean(heading(current, title, description)), 30_000);
        await tap(heading(shown, title, description));
        await shoot(`${prefix}-settings-ai-${index === 0 ? 'assistant' : 'speech'}-${suffix}`, (current) => hasText(current, inside));
    }
    for (let step = 0; step < 2; step += 1) {
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(1000);
    }
};
/**
 * Pass C3: Settings › Advanced › Calendar at its top (the push and device calendar cards, the subscription form) and scrolled
 * to the subscription list. Shot before the Menu screens: RN 154's Calendar reads the device copy this screen writes. Starts and
 * ends on the tabs; a shot that cannot be reached is reported, never fatal.
 */
const shootCalendarSettings = async (prefix, suffix, rn) => {
    const back = async () => { requireAppFront(); sh('input keyevent KEYCODE_BACK'); await sleep(1000); };
    try {
        const menu = await waitFor('the Menu tab', (current) => Boolean(rn ? current.find((node) => node['content-desc'] === 'Menu') : tab(current, 'Menu')), 30_000);
        await tap(rn ? menu.find((node) => node['content-desc'] === 'Menu') : tab(menu, 'Menu'));
        const sheet = await waitFor('the Settings tile', (current) => Boolean(withDescription(current, en['nav.settings'])), 15_000);
        await tap(withDescription(sheet, en['nav.settings']));
        const rows = await waitFor('the Advanced row', (current) => Boolean(withDescription(current, `${en['settings.advanced']}. ${en['settings.menuDesc.advanced']}`)), 30_000);
        await tap(withDescription(rows, `${en['settings.advanced']}. ${en['settings.menuDesc.advanced']}`));
        const advanced = await waitFor('the Calendar row', (current) => Boolean(withDescription(current, `${en['settings.calendar']}. ${en['settings.menuDesc.calendar']}`)), 30_000);
        await tap(withDescription(advanced, `${en['settings.calendar']}. ${en['settings.menuDesc.calendar']}`));
        await shoot(`${prefix}-settings-calendar-${suffix}`, (current) => hasText(current, en['settings.externalCalendarUrl']));
        let nodes = await screen();
        for (let step = 0; step < 6 && !hasText(nodes, CALENDAR_FEED.name); step += 1) nodes = await device.swipe(nodes, 'down');
        await shoot(`${prefix}-settings-calendar-list-${suffix}`, (current) => hasText(current, CALENDAR_FEED.name));
        for (let step = 0; step < 3; step += 1) await back();
    } catch (error) {
        console.log(`warn - ${prefix} settings calendar: ${error.message}`);
        for (let step = 0; step < 3; step += 1) await back();
    }
};
/**
 * Pass A2's attachments, light mode: the editor's Attachments field on T.paint (a file and a link), its Add link sheet, and the
 * project's Attachments (RN: inside the project's Details; native: the card above the tasks). Ends on the tabs. A shot that
 * cannot be reached is reported, never fatal to the other shots.
 */
const shootAttachments = async (prefix, rn) => {
    const PROJECT = 'Kitchen renovation';
    const back = async () => { requireAppFront(); sh('input keyevent KEYCODE_BACK'); await sleep(1000); };
    const toTabs = async () => {
        for (let step = 0; step < 5 && !tab(await screen(), 'Inbox'); step += 1) await back();
    };
    const scrollTo = async (ready, unfold) => {
        let nodes = await screen();
        for (let step = 0; step < 20 && !ready(nodes); step += 1) {
            const next = await device.swipe(nodes, 'down');
            if (device.signature(next) === device.signature(nodes)) {
                // Details unfolds only when it hides the field (an open Details would fold again).
                const fold = unfold && !button(next, en['attachments.addFile']) && button(next, en['taskEdit.details']);
                if (!fold) break;
                await tap(fold);
                unfold = false;
            }
            nodes = await screen();
        }
        return nodes;
    };
    try {
        if (rn) openLink('projects');
        else { const nodes = await waitFor('the native tabs', (current) => Boolean(tab(current, 'Projects')), 60_000); await tap(tab(nodes, 'Projects')); }
        const projects = await waitFor(PROJECT, (current) => Boolean(inList(current, PROJECT)), 45_000);
        await tap(inList(projects, PROJECT));
        const projectOpen = await waitFor(T.paint, (current) => Boolean(inList(current, T.paint)), 30_000);
        await tap(inList(projectOpen, T.paint));
        // As shootEditor: the Edit tab is the Form tab (its title field shows the task's title).
        const formShown = (current) => current.some((node) => node.class === 'android.widget.EditText' && node.text === T.paint) && (rn || inEditor(current));
        const opened = await waitFor(`the editor for ${T.paint}`, (current) => formShown(current) || Boolean(button(current, 'Edit')), 30_000);
        if (!formShown(opened)) await tap(button(opened, 'Edit'));
        await waitFor('the Edit tab', formShown, 15_000);
        const fieldShown = (current) => hasText(current, ATTACHMENT_FILE.title) && Boolean(button(current, en['attachments.addLink']));
        await scrollTo(fieldShown, true);
        await shoot(`${prefix}-attachments-editor-light`, fieldShown);
        await tap(button(await screen(), en['attachments.addLink']));
        // The sheet's hint line (RN's field reports its placeholder as the EditText's own text, which hasText skips).
        const sheetShown = (current) => current.some((node) => node.text === en['attachments.linkBatchHint']
            || node.text === en['attachments.linkPlaceholder'] || node['content-desc'] === en['attachments.linkBatchHint']);
        await waitFor('the link sheet', sheetShown, 15_000);
        await hideKeyboard();
        await shoot(`${prefix}-attachments-link-sheet-light`, sheetShown);
        const cancel = button(await screen(), en['common.cancel']);
        if (cancel) await tap(cancel); else await back();
        await sleep(800);
        await back();
        const discard = button(await screen(), en['common.discard']);
        if (discard) await tap(discard);
        // A link's row shows core's display title (no scheme) in both apps.
        const projectShown = (current) => current.some((node) => (node.text ?? '').endsWith('example.com/kitchen-plan')) && hasText(current, en['attachments.title']);
        await waitFor(`${PROJECT}'s screen`, (current) => Boolean(inList(current, T.paint)) || projectShown(current), 15_000);
        // Both apps: the project's Attachments sit inside its folded Details.
        {
            const details = button(await screen(), en['taskEdit.details']);
            if (details) await tap(details);
        }
        await scrollTo(projectShown, false);
        await shoot(`${prefix}-attachments-project-light`, projectShown);
    } catch (error) {
        console.log(`warn - ${prefix} attachments: ${error.message}`);
        // The screen as it was, for the next run's fix.
        try { writeFileSync(resolve(out, `${prefix}-attachments-failed.xml`), adbRaw('exec-out', 'uiautomator', 'dump', '/dev/tty')); } catch { /* best effort */ }
    }
    await toTabs();
};
/**
 * Pass PD's Project details, light and dark: the open project with Details unfolded (Status, Type, Sequential Scope, Sections),
 * then scrolled to its end (Area, Tags, Notes, Attachments, the dates). Ends on the tabs; a shot that cannot be reached is reported.
 */
const shootProjectDetails = async (prefix, suffix, rn) => {
    const PROJECT = 'Kitchen renovation';
    const back = async () => { requireAppFront(); sh('input keyevent KEYCODE_BACK'); await sleep(1000); };
    try {
        if (rn) openLink('projects');
        else {
            const nodes = await waitFor('the native tabs', (current) => Boolean(tab(current, 'Projects')), 60_000);
            await tap(tab(nodes, 'Projects'));
            // The tab keeps an open project (the attachments shots leave one): Back to the list.
            if (button(await screen(), 'Back')) await back();
        }
        const projects = await waitFor(PROJECT, (current) => Boolean(inList(current, PROJECT)), 45_000);
        await tap(inList(projects, PROJECT));
        const details = await waitFor('the Details toggle', (current) => Boolean(button(current, en['taskEdit.details'])) || current.some((node) => node.text === en['taskEdit.details']), 30_000);
        await shoot(`${prefix}-project-folded-${suffix}`, (current) => hasText(current, en['taskEdit.details']));
        await tap(button(details, en['taskEdit.details']) ?? details.find((node) => node.text === en['taskEdit.details']));
        await shoot(`${prefix}-project-details-${suffix}`, (current) => hasText(current, en['projects.statusLabel']));
        let nodes = await screen();
        const end = (current) => hasText(current, en['projects.reviewAt']) && hasText(current, en['attachments.title']);
        for (let step = 0; step < 8 && !end(nodes); step += 1) nodes = await device.swipe(nodes, 'down');
        await shoot(`${prefix}-project-details-end-${suffix}`, end);
    } catch (error) {
        console.log(`warn - ${prefix} project details: ${error.message}`);
        try { writeFileSync(resolve(out, `${prefix}-project-details-failed.xml`), adbRaw('exec-out', 'uiautomator', 'dump', '/dev/tty')); } catch { /* best effort */ }
    }
    for (let step = 0; step < 4 && !tab(await screen(), 'Inbox'); step += 1) await back();
    if (!rn) { const nodes = await screen(); if (button(nodes, 'Back')) await back(); }
};
/** Pass R2: Settings › Notifications (top, end) and its day picker. */
const shootR2 = async (prefix, suffix, rn) => {
    if (rn) openLink('focus');
    else {
        const tabs = await waitFor('the native tabs', (current) => Boolean(tab(current, 'Focus')), 60_000);
        if (!tabSelected(tabs, 'Focus')) await tap(tab(tabs, 'Focus'));
    }
    const menu = await waitFor('the Menu tab', (current) => Boolean(rn ? current.find((node) => node['content-desc'] === 'Menu') : tab(current, 'Menu')), 30_000);
    await tap(rn ? menu.find((node) => node['content-desc'] === 'Menu') : tab(menu, 'Menu'));
    const sheet = await waitFor('the Settings tile', (current) => Boolean(withDescription(current, en['nav.settings'])), 15_000);
    await tap(withDescription(sheet, en['nav.settings']));
    const label = `${en['settings.notifications']}. ${en['settings.menuDesc.notifications']}`;
    const rows = await waitFor('the Notifications row', (current) => Boolean(withDescription(current, label)), 30_000);
    await tap(withDescription(rows, label));
    await shoot(`${prefix}-settings-notifications-${suffix}`, (current) => hasText(current, en['settings.notificationsEnable']));
    let nodes = await screen();
    for (let step = 0; step < 3; step += 1) nodes = await device.swipe(nodes, 'down');
    await shoot(`${prefix}-settings-notifications-end-${suffix}`, (current) => hasText(current, en['settings.dailyDigestEveningTime']));
    for (let step = 0; step < 3; step += 1) nodes = await device.swipe(nodes, 'up');
    let day = await waitFor('the Review day row', (current) => current.some((node) => node.text === en['settings.weeklyReviewDay']
        || (node['content-desc'] ?? '').startsWith(`${en['settings.weeklyReviewDay']}: `)), 15_000);
    // The row can sit at the screen's bottom edge: one drag brings it up.
    day = await device.swipe(day, 'down');
    await tap(day.find((node) => (node['content-desc'] ?? '').startsWith(`${en['settings.weeklyReviewDay']}: `)) ?? day.find((node) => node.text === en['settings.weeklyReviewDay']));
    await shoot(`${prefix}-notifications-day-picker-${suffix}`, (current) => hasText(current, 'Wednesday'));
    // Back until the tabs show (the picker, Notifications, Settings), never past them.
    for (let step = 0; step < 6; step += 1) {
        const current = await screen();
        if (rn ? current.some((node) => node['content-desc'] === 'Menu') && !hasText(current, en['settings.notificationsEnable']) && !hasText(current, 'Wednesday')
            : Boolean(tab(current, 'Inbox')) && !hasText(current, en['settings.notificationsEnable']) && !hasText(current, 'Wednesday')) break;
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(900);
    }
};
/** Pass S5 only: Settings › Sync from the Menu sheet, the File panel's two shots, then Back to the tabs. */
const shootS5 = async (prefix, suffix, rn) => {
    if (rn) openLink('focus');
    const menu = await waitFor('the Menu tab', (current) => Boolean(rn ? current.find((node) => node['content-desc'] === 'Menu') : tab(current, 'Menu')), 60_000);
    await tap(rn ? menu.find((node) => node['content-desc'] === 'Menu') : tab(menu, 'Menu'));
    const sheet = await waitFor('the Settings tile', (current) => Boolean(withDescription(current, en['nav.settings'])), 15_000);
    await tap(withDescription(sheet, en['nav.settings']));
    const sync = SETTINGS_SCREENS.find((screen) => screen.name === 'sync');
    const rows = await waitFor('the Sync row', (current) => Boolean(withDescription(current, sync.row)), 30_000);
    await tap(withDescription(rows, sync.row));
    await waitFor('Settings › Sync', (current) => hasText(current, en['settings.syncBackendFile']) || Boolean(withDescription(current, en['settings.syncBackendFile'])), 30_000);
    await shootFilePanel(prefix, suffix);
    for (let step = 0; step < 4; step += 1) {
        const current = await screen();
        if (rn ? current.some((node) => node['content-desc'] === 'Menu') && !withDescription(current, sync.row) && !hasText(current, en['settings.selectFolder'])
            : Boolean(tab(current, 'Inbox')) && !withDescription(current, sync.row) && !hasText(current, en['settings.selectFolder'])) break;
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(900);
    }
};
/**
 * Pass R2b: the Pomodoro card on Focus in each state. Both apps label the card's controls with core's en words (RN as text,
 * native as the node's description). It ends at the idle card with Timer only, as it began.
 */
const shootR2b = async (prefix, rn) => {
    const labeled = (nodes, label) => nodes.findLast((node) => node.text === label || node['content-desc'] === label);
    const press = async (label) => {
        const nodes = await waitFor(`"${label}"`, (current) => Boolean(labeled(current, label)), 30_000);
        await tap(labeled(nodes, label));
        await sleep(700);
    };
    if (rn) openLink('focus');
    else {
        const tabs = await waitFor('the native tabs', (current) => Boolean(tab(current, 'Focus')), 60_000);
        if (!tabSelected(tabs, 'Focus')) await tap(tab(tabs, 'Focus'));
    }
    const shown = (...texts) => (current) => texts.every((text) => Boolean(labeled(current, text)));
    await shoot(`${prefix}-pomodoro-idle-light`, shown(en['pomodoro.mobileTitle'], '25:00', en['common.start']));
    await press(en['pomodoro.selectedTask']);
    await shoot(`${prefix}-pomodoro-picker-light`, shown(T.outline, en['pomodoro.timerOnly']));
    await press(T.outline);
    await shoot(`${prefix}-pomodoro-linked-light`, shown(en['pomodoro.markTaskDone']));
    // A running card redraws each second, so uiautomator never sees the screen idle: the running shot waits a fixed time, and
    // Pause is tapped where Start was (the same button).
    const toggle = labeled(await screen(), en['common.start']);
    await tap(toggle);
    await sleep(2500);
    requireAppFront();
    writeFileSync(resolve(out, `${prefix}-pomodoro-running-light.png`), adbRaw('exec-out', 'screencap', '-p'));
    shots.push(`${prefix}-pomodoro-running-light`);
    console.log(`shot ${prefix}-pomodoro-running-light.png`);
    await tap(toggle);
    await sleep(1000);
    await shoot(`${prefix}-pomodoro-paused-light`, shown(en['common.start']));
    await press(en['pomodoro.switchToBreak']);
    await shoot(`${prefix}-pomodoro-break-light`, shown('05:00', en['pomodoro.switchToFocus']));
    await press(en['pomodoro.collapse']);
    await shoot(`${prefix}-pomodoro-collapsed-light`, shown(en['pomodoro.expand']));
    // Back to the start: expanded, Focus, the full 25:00, Timer only.
    await press(en['pomodoro.expand']);
    await press(en['pomodoro.switchToFocus']);
    await press(en['common.reset']);
    await press(en['pomodoro.selectedTask']);
    await press(en['pomodoro.timerOnly']);
    await waitFor('the idle card again', (current) => shown('25:00', en['common.start'])(current) && !labeled(current, en['pomodoro.markTaskDone']), 30_000);
};
/**
 * Pass 13a, in light mode: (1) Done on Focus's T.milk (RN's swipe action) shows the "marked Done" toast with Undo, and Undo brings
 * the row back; (2) Process Inbox's Trash on its first item shows the toast with Undo, and Undo puts the item back in the Inbox;
 * (3) the Daily Review lists all seven of tomorrow's events (shot at its top and at the last one).
 */
const shoot13a = async (prefix, rn) => {
    const labeled = (nodes, label) => nodes.findLast((node) => node.text === label || node['content-desc'] === label);
    const undoShown = (current) => Boolean(labeled(current, en['common.undo']));
    // A toast lasts 5.2 s and one UI dump takes 1-2 s: the shot and the Undo tap use the dump that found it, with no wait between.
    const shootAndUndo = async (name, nodes) => {
        requireAppFront();
        writeFileSync(resolve(out, `${name}.png`), adbRaw('exec-out', 'screencap', '-p'));
        shots.push(name);
        console.log(`shot ${name}.png`);
        await tap(labeled(nodes, en['common.undo']));
    };
    const showTab = async (name) => {
        if (rn) { openLink(name.toLowerCase()); return; }
        const tabs = await waitFor('the native tabs', (current) => Boolean(tab(current, name)), 60_000);
        if (!tabSelected(tabs, name)) await tap(tab(tabs, name));
    };
    // (1) Done from Focus, then Undo.
    await showTab('Focus');
    const row = await waitFor(`${T.milk} in Focus`, (current) => Boolean(inList(current, T.milk)), 45_000);
    const [x1, y1, , y2] = box(inList(row, T.milk));
    const y = Math.round((y1 + y2) / 2);
    requireAppFront();
    sh(`input swipe ${Math.max(x1 + 10, EDGE_SAFE_X)} ${y} ${Math.max(x1 + 10, EDGE_SAFE_X) + 440} ${y} 400`);
    const doneAction = en['task.aria.action'].replace('{{action}}', en['status.done']);
    const action = (current) => current.find((node) => (node['content-desc'] === doneAction || (node['resource-id'] ?? '').endsWith('swipe-action'))
        && box(node)[1] <= y && box(node)[3] >= y);
    await tap(action(await waitFor('the Done action', (current) => Boolean(action(current)), 8_000)));
    const marked = `${T.milk} marked Done`;
    const toast = (current) => undoShown(current) && current.some((node) => (node.text ?? '').includes(marked) || (node['content-desc'] ?? '').includes(marked));
    await shootAndUndo(`${prefix}-complete-toast-light`, await waitFor(`"${marked}" with Undo`, toast, 10_000));
    await waitFor(`${T.milk} back in Focus`, (current) => Boolean(inList(current, T.milk)), 15_000);
    check(true, `(13a-1) ${prefix}: Undo after Done brought ${T.milk} back to Focus`);
    await shoot(`${prefix}-complete-undone-light`, (current) => Boolean(inList(current, T.milk)) && !undoShown(current));
    // (2) Trash in Process Inbox, then Undo.
    await showTab('Inbox');
    const inbox = await waitFor('the Process Inbox button', (current) => current.some((node) => node['content-desc'] === PROCESS), 45_000);
    await tap(inbox.find((node) => node['content-desc'] === PROCESS));
    const first = (current) => current.some((node) => node.class === 'android.widget.EditText' && node.text === T.call);
    await hideKeyboard();
    const step = await waitFor('Process Inbox\'s Trash', (current) => first(current) && Boolean(labeled(current, en['inbox.trash'])), 30_000);
    await tap(labeled(step, en['inbox.trash']));
    await shootAndUndo(`${prefix}-inbox-trash-toast-light`, await waitFor('the Trash toast with Undo', (current) => undoShown(current) && !first(current), 10_000));
    await sleep(1500);
    for (let close = 0; close < 3 && (await screen()).some((node) => node.class === 'android.widget.EditText'); close += 1) {
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(1000);
    }
    await showTab('Inbox');
    await waitFor(`${T.call} back in the Inbox`, (current) => Boolean(inList(current, T.call)), 15_000);
    check(true, `(13a-2) ${prefix}: Undo after Trash put ${T.call} back in the Inbox`);
    await shoot(`${prefix}-inbox-trash-undone-light`, (current) => Boolean(inList(current, T.call)));
    // (3) The Daily Review with all seven of tomorrow's events.
    if (rn) openLink('review');
    else {
        const menu = await waitFor('the Menu tab', (current) => Boolean(tab(current, 'Menu')), 30_000);
        await tap(tab(menu, 'Menu'));
        const sheet = await waitFor('the Review tile', (current) => current.some((node) => node['content-desc'] === en['nav.review']), 15_000);
        await tap(sheet.find((node) => node['content-desc'] === en['nav.review']));
    }
    const start = await waitFor('Start Review', (current) => Boolean(button(current, en['review.startReview'])), 15_000);
    await tap(button(start, en['review.startReview']));
    const choice = await waitFor('the Daily Review choice', (current) => Boolean(button(current, en['dailyReview.title'])), 15_000);
    await tap(button(choice, en['dailyReview.title']));
    const event = (title) => (current) => hasText(current, title) || current.some((node) => (node['content-desc'] ?? '').includes(title));
    await shoot(`${prefix}-daily-events-top-light`, event(CALENDAR_EVENTS.timed));
    const last = MORE_EVENTS.at(-1);
    let nodes = await screen();
    for (let swipe = 0; swipe < 8 && !event(last)(nodes); swipe += 1) nodes = await device.swipe(nodes, 'down');
    check(event(last)(nodes), `(13a-3) ${prefix}: the Daily Review lists "${last}", tomorrow's seventh event`);
    await shoot(`${prefix}-daily-events-end-light`, event(last));
    const close = await waitFor('the review\'s Close', (current) => Boolean(button(current, en['common.close'])), 15_000);
    await tap(button(close, en['common.close']));
    await sleep(1000);
};
const c3FixesOnly = process.env.PARITY_ONLY === 'c3-fixes';
const originalFontScale = sh('settings get system font_scale');
/** Opens the Calendar (RN: its link; native: the Menu sheet's tile). */
const openCalendar = async (rn) => {
    if (rn) { openLink('calendar'); return; }
    const menu = await waitFor('the Menu tab', (current) => Boolean(tab(current, 'Menu')), 30_000);
    await tap(tab(menu, 'Menu'));
    const sheet = await waitFor('the Calendar tile', (current) => current.some((node) => node['content-desc'] === en['nav.calendar']), 15_000);
    await tap(sheet.find((node) => node['content-desc'] === en['nav.calendar']));
};
/** C3 fix 2: the month with today's details, then a return to the app reloads the same range while the feed answers slowly. */
const shootCalendarReload = async (prefix, rn) => {
    await openCalendar(rn);
    await calendarMode(en['calendar.mobile.month']);
    const today = await waitFor('Today', (current) => Boolean(withDescription(current, en['calendar.today'])), 15_000);
    await tap(withDescription(today, en['calendar.today']));
    // Today's details pane lists the fixture's tasks first: scroll inside the pane (the bottom of the screen) to its events.
    const eventShown = (current) => hasText(current, CALENDAR_EVENTS.timed) || current.some((node) => (node['content-desc'] ?? '').includes(CALENDAR_EVENTS.timed));
    let nodes = await screen();
    const [, , width, height] = box(nodes.find((node) => node.bounds) ?? { bounds: '[0,0][1080,2340]' });
    for (let step = 0; step < 6 && !eventShown(nodes); step += 1) {
        requireAppFront();
        sh(`input swipe ${Math.round(width / 2)} ${Math.round(height * 0.93)} ${Math.round(width / 2)} ${Math.round(height * 0.8)} 400`);
        await sleep(800);
        nodes = await screen();
    }
    await waitFor(`${CALENDAR_EVENTS.timed} in today's details`, eventShown, 30_000);
    calendarServer.state.mode('parity', 'slow');
    requireAppFront();
    sh('input keyevent KEYCODE_HOME');
    await sleep(1500);
    // The launcher's intent: the task comes back as it was (RN's AppState and native's resume reload the Calendar's range).
    sh(`monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`);
    await shoot(`${prefix}-calendar-reload-light`, (current) => hasText(current, en['calendar.mobile.loading']));
    calendarServer.state.mode('parity', 'ok');
    await sleep(16_000);
};
/** C3 fix 3: Settings › Calendar at system font scale [scale], scrolled to its pills (Add, Test, Choose local .ics file). */
const shootPillsFontScale = async (prefix, rn, activity, scale = '2.0') => {
    await stopApp();
    sh(`settings put system font_scale ${scale}`);
    device.launch(activity);
    if (rn) openLink('inbox');
    const back = async () => { requireAppFront(); sh('input keyevent KEYCODE_BACK'); await sleep(1000); };
    const menu = await waitFor('the Menu tab', (current) => Boolean(rn ? current.find((node) => node['content-desc'] === 'Menu') : tab(current, 'Menu')), 60_000);
    await tap(rn ? menu.find((node) => node['content-desc'] === 'Menu') : tab(menu, 'Menu'));
    const sheet = await waitFor('the Settings tile', (current) => Boolean(withDescription(current, en['nav.settings'])), 15_000);
    await tap(withDescription(sheet, en['nav.settings']));
    const advancedRow = (current) => withDescription(current, `${en['settings.advanced']}. ${en['settings.menuDesc.advanced']}`);
    let rows = await screen();
    for (let step = 0; step < 6 && !advancedRow(rows); step += 1) rows = await device.swipe(rows, 'down');
    await tap(advancedRow(rows) ?? fail('no Advanced row'));
    const calendarRow = (current) => withDescription(current, `${en['settings.calendar']}. ${en['settings.menuDesc.calendar']}`);
    const advanced = await waitFor('the Calendar row', (current) => Boolean(calendarRow(current)), 30_000);
    await tap(calendarRow(advanced));
    const pill = en['settings.calendarMobile.chooseLocalIcsFile'];
    const pillShown = (current) => hasText(current, pill) || Boolean(withDescription(current, pill));
    let nodes = await waitFor('Settings › Calendar', (current) => hasText(current, en['settings.deviceCalendars']) || hasText(current, en['settings.externalCalendarUrl']) || pillShown(current), 30_000);
    for (let step = 0; step < 8 && !pillShown(nodes); step += 1) nodes = await device.swipe(nodes, 'down');
    await shoot(`${prefix}-settings-calendar-pills-font${scale.replace('.0', '')}-light`, pillShown);
    for (let step = 0; step < 3; step += 1) await back();
    sh(`settings put system font_scale ${originalFontScale === 'null' ? '1.0' : originalFontScale}`);
    await stopApp();
};
/**
 * Pass D1b: Settings › Data with the Backup fold open at its end (RN's Getting Started row), the Import fold open (the guide
 * link and the five importers), and in light mode the Todoist question for a pushed Todoist CSV and the warning for that file on
 * the DGT row (both cancelled or dismissed, so nothing is written). Back to the tabs at the end.
 */
const shootD1b = async (prefix, suffix, rn) => {
    if (rn) openLink('inbox');
    const menu = await waitFor('the Menu tab', (current) => Boolean(rn ? current.find((node) => node['content-desc'] === 'Menu') : tab(current, 'Menu')), 60_000);
    await tap(rn ? menu.find((node) => node['content-desc'] === 'Menu') : tab(menu, 'Menu'));
    const sheet = await waitFor('the Settings tile', (current) => Boolean(withDescription(current, en['nav.settings'])), 15_000);
    await tap(withDescription(sheet, en['nav.settings']));
    try {
        const rows = await waitFor('the Data row', (current) => Boolean(withDescription(current, `${en['settings.data']}. ${en['settings.menuDesc.data']}`)), 30_000);
        await tap(withDescription(rows, `${en['settings.data']}. ${en['settings.menuDesc.data']}`));
        await shoot(`${prefix}-settings-data-${suffix}`, (current) => Boolean(dataRow(current, en['settings.backup'])));
        await tap(dataRow(await screen(), en['settings.backup']) ?? fail('no Backup fold'));
        let nodes = await waitFor('the Backup fold open', (current) => Boolean(dataRow(current, en['settings.exportBackup'])), 15_000);
        for (let step = 0; step < 4 && !dataRow(nodes, en['settings.gettingStartedContentAction']); step += 1) nodes = await device.swipe(nodes, 'down');
        await shoot(`${prefix}-settings-data-backup-end-${suffix}`, (current) => Boolean(dataRow(current, en['settings.gettingStartedContentAction'])));
        nodes = await screen();
        for (let step = 0; step < 4 && !dataRow(nodes, en['settings.importData']); step += 1) nodes = await device.swipe(nodes, 'down');
        await tap(dataRow(nodes, en['settings.importData']) ?? fail('no Import fold'));
        nodes = await waitFor('the Import fold open', (current) => Boolean(dataRow(current, en['settings.syncMobile.importFromTodoist'])), 15_000);
        for (let step = 0; step < 4 && !dataRow(nodes, en['settings.syncMobile.importFromMindwtrCsv']); step += 1) nodes = await device.swipe(nodes, 'down');
        await shoot(`${prefix}-settings-data-import-${suffix}`, (current) => Boolean(dataRow(current, en['settings.syncMobile.importFromTodoist'])));
        if (suffix === 'light') {
            await tap(dataRow(await screen(), en['settings.syncMobile.importFromTodoist']) ?? fail('no Todoist row'));
            await pickParityFile(DATA_FILES.todoist);
            await shoot(`${prefix}-settings-data-todoist-question-${suffix}`, (current) => current.some((node) => /^cancel$/i.test(node.text || node['content-desc'] || '')));
            const cancel = (await screen()).find((node) => /^cancel$/i.test(node.text || node['content-desc'] || ''));
            if (cancel) await tap(cancel);
            await sleep(1500);
            await tap(dataRow(await screen(), en['settings.syncMobile.importFromDgtGtd']) ?? fail('no DGT row'));
            await pickParityFile(DATA_FILES.todoist);
            await shoot(`${prefix}-settings-data-import-invalid-${suffix}`, (current) => hasText(current, en['settings.backupMobile.importFailed']));
            await sleep(5000);
        }
    } catch (error) {
        console.log(`warn - ${prefix} D1b Data shots: ${error.message}`);
    }
    for (let step = 0; step < 6; step += 1) {
        const current = await screen();
        if (rn ? current.some((node) => node['content-desc'] === 'Menu') && !withDescription(current, en['nav.settings']) && !dataRow(current, en['settings.backup'])
            : Boolean(tab(current, 'Inbox')) && !dataRow(current, en['settings.backup'])) break;
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(900);
    }
};
const SCREENS = [
    { name: 'inbox', link: 'inbox', tab: 'Inbox', text: T.call },
    { name: 'focus', link: 'focus', tab: 'Focus', text: T.outline },
    { name: 'projects', link: 'projects', tab: 'Projects', text: 'Kitchen renovation' },
];

try {
    mkdirSync(resolve(out, 'fixture'), { recursive: true });
    const current = front();
    if (!current.includes(`${PKG}/`) && !current.includes(`${home}/`)) throw new Stopped(`another app is in front: ${current.trim()}`);
    check(Number(buildFixture()) === Object.keys(T).length, `fixture built through core: ${Object.keys(T).length} tasks (${fixture})`);
    pushDataFiles();
    sh('settings put system accelerometer_rotation 0');
    sh('settings put system user_rotation 0');
    calendarServer = await serveCalendar(CALENDAR_PORT, icsCalendar({ ...CALENDAR_EVENTS, moreAllDay: MORE_EVENTS, name: CALENDAR_FEED.name }));
    adbRaw('reverse', `tcp:${CALENDAR_PORT}`, `tcp:${CALENDAR_PORT}`);

    // RN 154, fresh, with the fixture as its database before its first launch.
    if (installed()) sh(`pm uninstall ${PKG}`);
    adbRaw('install', '-g', apks.rn);
    runAs('mkdir -p files/SQLite');
    adbRaw('push', fixture, '/data/local/tmp/mindwtr-parity.db');
    try { runAs('cp /data/local/tmp/mindwtr-parity.db files/SQLite/mindwtr.db'); } finally { sh('rm -f /data/local/tmp/mindwtr-parity.db'); }
    writeFileSync(resolve(out, 'fixture/parity-file.pdf'), ATTACHMENT_FILE.bytes);
    adbRaw('push', resolve(out, 'fixture/parity-file.pdf'), '/data/local/tmp/mindwtr-parity-file.pdf');
    try { runAs('mkdir -p files/attachments'); runAs('cp /data/local/tmp/mindwtr-parity-file.pdf files/attachments/parity-file.pdf'); } finally { sh('rm -f /data/local/tmp/mindwtr-parity-file.pdf'); }
    device.launch(RN_ACTIVITY);
    if (c3FixesOnly) {
        await setNight('no');
        // Settings › Calendar first: RN's Calendar reads the subscriptions RN's Settings › Calendar copies to the device.
        await shootPillsFontScale('rn', true, RN_ACTIVITY);
        await shootPillsFontScale('rn', true, RN_ACTIVITY, '1.0');
        device.launch(RN_ACTIVITY);
        await shootCalendarReload('rn', true);
    }
    for (const mode of c3FixesOnly ? [] : ['no', 'yes']) {
        await setNight(mode);
        // RN's activity handles uiMode itself, so AppCompat's own colors (a switch's default thumb) stay as they were at launch:
        // start RN again in dark mode, as a user who opens it in dark mode sees it.
        if (mode === 'yes') {
            await stopApp();
            device.launch(RN_ACTIVITY);
        }
        if (R2B_ONLY) { if (mode === 'no') await shootR2b('rn', true); continue; }
        if (A13_ONLY) { if (mode === 'no') await shoot13a('rn', true); continue; }
        if (R2_ONLY) { await shootR2('rn', mode === 'yes' ? 'dark' : 'light', true); continue; }
        if (S5_ONLY) { await shootS5('rn', mode === 'yes' ? 'dark' : 'light', true); continue; }
        if (D1B_ONLY) { await shootD1b('rn', mode === 'yes' ? 'dark' : 'light', true); continue; }
        for (const screen of SCREENS) {
            openLink(screen.link);
            await shoot(`rn-${screen.name}-${mode === 'yes' ? 'dark' : 'light'}`, (nodes) => hasText(nodes, screen.text));
        }
        openLink('focus');
        await shootEditor(`rn-editor-${mode === 'yes' ? 'dark' : 'light'}`, true);
        openLink(`global-search?q=${SEARCH_QUERY}`);
        await shoot(`rn-search-${mode === 'yes' ? 'dark' : 'light'}`, (nodes) => hasText(nodes, 'Kitchen renovation'));
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(1000);
        openLink('inbox');
        await shootProcess(`rn-process-${mode === 'yes' ? 'dark' : 'light'}`);
        openLink('inbox');
        await shootPopup('rn', mode === 'yes' ? 'dark' : 'light');
        openLink('inbox');
        await shootModal('rn', mode === 'yes' ? 'dark' : 'light', RN_ACTIVITY);
        openLink('inbox');
        await shootCalendarSettings('rn', mode === 'yes' ? 'dark' : 'light', true);
        openLink('inbox');
        await shootMenu('rn', mode === 'yes' ? 'dark' : 'light', true);
        openLink('inbox');
        await shootSettings('rn', mode === 'yes' ? 'dark' : 'light', true);
        if (mode === 'no') await shootAttachments('rn', true);
        await shootProjectDetails('rn', mode === 'yes' ? 'dark' : 'light', true);
    }
    await stopApp();

    // The native build over it: the same database, the same screens (tabs are tapped; it has no links).
    adbRaw('install', '-r', '-d', '-g', apks.native);
    await setNight('no');
    device.launch(NATIVE_ACTIVITY);
    if (c3FixesOnly) {
        await shootPillsFontScale('native', false, NATIVE_ACTIVITY);
        await shootPillsFontScale('native', false, NATIVE_ACTIVITY, '1.0');
        device.launch(NATIVE_ACTIVITY);
        await shootCalendarReload('native', false);
    }
    for (const mode of c3FixesOnly ? [] : ['no', 'yes']) {
        if (mode === 'yes') await setNight('yes');
        if (R2B_ONLY) { if (mode === 'no') await shootR2b('native', false); continue; }
        if (A13_ONLY) { if (mode === 'no') await shoot13a('native', false); continue; }
        if (R2_ONLY) { await shootR2('native', mode === 'yes' ? 'dark' : 'light', false); continue; }
        if (S5_ONLY) { await shootS5('native', mode === 'yes' ? 'dark' : 'light', false); continue; }
        if (D1B_ONLY) { await shootD1b('native', mode === 'yes' ? 'dark' : 'light', false); continue; }
        for (const screen of SCREENS) {
            const nodes = await waitFor('the native tabs', (current) => Boolean(tab(current, screen.tab)), 60_000);
            if (!tabSelected(nodes, screen.tab)) await tap(tab(nodes, screen.tab));
            await shoot(`native-${screen.name}-${mode === 'yes' ? 'dark' : 'light'}`, (current) => tabSelected(current, screen.tab) && hasText(current, screen.text));
        }
        const nodes = await waitFor('the native tabs', (current) => Boolean(tab(current, 'Focus')), 60_000);
        if (!tabSelected(nodes, 'Focus')) await tap(tab(nodes, 'Focus'));
        await shootEditor(`native-editor-${mode === 'yes' ? 'dark' : 'light'}`, false);
        // Search from the header's button, the query typed (letters: the parity fixture's titles are words).
        const search = await waitFor('the header Search button', (current) => current.some((node) => node['content-desc'] === 'Search'), 30_000);
        await tap(search.find((node) => node['content-desc'] === 'Search'));
        await waitFor('the search field', (current) => current.some((node) => node.class === 'android.widget.EditText'), 15_000);
        requireAppFront();
        sh(`input text ${SEARCH_QUERY}`);
        // A Pinyin keyboard holds typed letters in its own composition strip and sends none to the field
        // (run 21: the field stayed empty with "kitchen" above the keys). Enter commits the held letters as typed.
        await sleep(800);
        const typed = (current) => current.some((node) => node.class === 'android.widget.EditText' && node.text === SEARCH_QUERY);
        if (!typed(await device.screen())) {
            requireAppFront();
            sh('input keyevent KEYCODE_ENTER');
        }
        await waitFor(`"${SEARCH_QUERY}" in the search field`, typed, 10_000);
        await waitFor('the search results', (current) => hasText(current, 'Kitchen renovation'), 30_000);
        await hideKeyboard();
        await shoot(`native-search-${mode === 'yes' ? 'dark' : 'light'}`, (current) => hasText(current, 'Kitchen renovation'));
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        const inboxTab = await waitFor('the native tabs', (current) => Boolean(tab(current, 'Inbox')), 30_000);
        if (!tabSelected(inboxTab, 'Inbox')) await tap(tab(inboxTab, 'Inbox'));
        await shootProcess(`native-process-${mode === 'yes' ? 'dark' : 'light'}`);
        await shootPopup('native', mode === 'yes' ? 'dark' : 'light');
        await shootModal('native', mode === 'yes' ? 'dark' : 'light', NATIVE_ACTIVITY);
        await shootCalendarSettings('native', mode === 'yes' ? 'dark' : 'light', false);
        await shootMenu('native', mode === 'yes' ? 'dark' : 'light', false);
        await shootSettings('native', mode === 'yes' ? 'dark' : 'light', false);
        if (mode === 'no') await shootAttachments('native', false);
        await shootProjectDetails('native', mode === 'yes' ? 'dark' : 'light', false);
    }
    await stopApp();

    // RN on the left, native on the right.
    const magick = ['magick', 'convert'].find((tool) => { try { execFileSync('which', [tool], { stdio: 'ignore' }); return true; } catch { return false; } });
    for (const name of shots.filter((shot) => shot.startsWith('rn-')).map((shot) => shot.slice(3))) {
        if (!magick || !shots.includes(`native-${name}`)) continue;
        execFileSync(magick, [resolve(out, `rn-${name}.png`), resolve(out, `native-${name}.png`), '+append', resolve(out, `pair-${name}.png`)]);
    }
    console.log(magick ? `pairs written (RN left, native right) with ${magick}` : 'no ImageMagick: rn-* and native-* are the pairs');
    console.log(`Parity screens in ${out}`);
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    try { adbRaw('reverse', '--remove', `tcp:${CALENDAR_PORT}`); } catch { /* device gone */ }
    void calendarServer?.close();
    try { if (installed()) sh(`pm uninstall ${PKG}`); } catch { /* device gone */ }
    try { sh(`cmd uimode night ${['yes', 'no', 'auto'].includes(originalNight) ? originalNight : 'auto'}`); } catch { /* device gone */ }
    try { sh(originalFontScale === 'null' ? 'settings delete system font_scale' : `settings put system font_scale ${originalFontScale}`); } catch { /* device gone */ }
    for (const [name, value] of [['user_rotation', originalRotation], ['accelerometer_rotation', originalAccelerometer]]) {
        try { sh(value === 'null' ? `settings delete system ${name}` : `settings put system ${name} ${value}`); } catch { /* device gone */ }
    }
    try { sh('rm -f /data/local/tmp/mindwtr-parity-ui.xml /data/local/tmp/mindwtr-parity.db'); } catch { /* device gone */ }
    try { sh(`rm -rf ${DATA_DIR}`); } catch { /* device gone */ }
}
