// Task editor check for the isolated native Android development app.
//
//   node apps/android-native/scripts/check-editor-device.mjs <adb-serial> [apk]
//
// Installs the debug APK with `install -r` (existing development data stays),
// captures one task with a title unique to this run, and edits it through the
// editor (RN's Form tab over core's getTaskEditorModel and saveTaskDraft):
// (a) a save that changes the title, the due date, and a typed context;
// (e) clearing the due date; (b) a draft kept through rotation; (c) a draft
// kept through process death that still saves; (d) a failed commit that keeps
// its exact retry through rotation, Back, and a new screen, then stores once;
// (i) a save whose reply dies with the process is replayed from the journal and sent again on relaunch, and stored once;
// (g) a context chosen from core's suggestions and (h) a due date with a time,
// in one save; (j) a new day for a timed due date keeps its time; (f) status Reference, whose rule core applies (the due date
// goes), and a project from the Destination picker. It asserts through the
// app's own database copy (.db, -wal and -shm pulled together), the UI
// hierarchy, and logcat. It touches only the development
// package (it refuses any other APK), never launches over another app, and
// restores rotation and clears its debug properties on exit. Leave the device
// on its home screen before running. It needs host `sqlite3`.
// Exit 0 = pass, 1 = fail, 2 = refused before touching the device, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { bootFailure, button, check, connect, described, draftText, evidenced, fail, field, inEditor, inList, isOn, Stopped, tagged, taskRows, withDescription, chipOn, inboxCount } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-editor-device.mjs <adb-serial> [apk]');
    process.exit(2);
}
const app = resolve(import.meta.dirname, '..');
const apk = apkArg ?? resolve(app, 'android/app/build/outputs/apk/play/debug/app-play-debug.apk');
const adbBin = process.env.ADB ?? '/home/dd/Android/Sdk/platform-tools/adb';
const aapt2 = process.env.AAPT2 ?? '/home/dd/Android/Sdk/build-tools/36.1.0/aapt2';
const PKG = 'tech.dongdongbh.mindwtr.nativeclient.dev';
// Never install anything but the development package (install -r would upgrade it).
const apkPackage = execFileSync(aapt2, ['dump', 'packagename', apk], { encoding: 'utf8' }).trim();
if (apkPackage !== PKG) {
    console.error(`REFUSED: ${apk} is package "${apkPackage}", not ${PKG}`);
    process.exit(2);
}
const ACTIVITY = `${PKG}/${PKG}.MainActivity`;
const TAG = 'MindwtrNativeDev';
const UI_FILE = '/data/local/tmp/mindwtr-native-dev-ui.xml';
// `language` is cleared so the app shows core's text for the phone's language (English on the test phone).
const PROPS = ['fail_commit', 'delay_before_ms', 'delay_after_ms', 'language'];
const work = resolve(app, 'android/build/editor-check');
// Digits only: some phone keyboards hold typed letters in a composition strip.
const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const captured = `91${run}`;

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting, type, reveal } = device;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);

// ---- device state ----
const launch = () => device.launch(ACTIVITY);
const logs = (processId) => device.logs(processId, TAG);
const count = (text, needle) => text.split('\n').filter((line) => line.includes(needle)).length;
const boots = (processId) => count(logs(processId), 'Core host boot started');
const recreations = (processId) => count(logs(processId), 'reason=activity-recreate');
const newScreens = (processId) => count(logs(processId), 'reason=new-screen');
// The log's `context` is itself a JSON string, so its quotes arrive escaped.
const saves = (processId, outcome) => logs(processId).replace(/\\/g, '').split('\n').filter((line) => line.includes('native-android-dev-task-command')
    && line.includes('"operation":"saveTaskDraft"') && line.includes(`"outcome":"${outcome}"`)).length;
const setRotation = (rotation) => {
    requireAppFront();
    sh('settings put system accelerometer_rotation 0');
    sh(`settings put system user_rotation ${rotation}`);
};
/** Rotates and waits until the running host logs the recreated Activity. */
const rotate = async (rotation) => {
    const processId = pid();
    const before = recreations(processId);
    setRotation(rotation);
    await waitFor(`rotation ${rotation} recreation`, () => recreations(processId) > before, 15_000);
};
const goHome = async () => {
    requireAppFront();
    sh('input keyevent KEYCODE_HOME');
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
};

// ---- UI ----
// The labels are core's English (en.ts): taskEdit.*Label, task.destination, status.*, common.notSet, common.clear, calendar.changeTime.
// The Inbox count: the Process Inbox button's spoken count, or 0 for RN's empty Inbox (device.mjs inboxCount).
const header = inboxCount;
const inbox = () => waitFor('the Inbox', (nodes) => !inEditor(nodes) && Number.isFinite(header(nodes)), 60_000);
/** The editor's draft as its controls announce it ("Due Date: <core's label>"); the first text field is the title. */
const editorShows = (nodes, title, values = {}) => inEditor(nodes) && field(nodes)?.text === title
    && Object.entries(values).every(([label, value]) => described(nodes, label) === value);
/** Closes the keyboard if it shows: Back then only closes the keyboard, never the editor. */
const hideKeyboard = async () => {
    if (!/mInputShown=true/.test(sh('dumpsys input_method'))) return;
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await sleep(600);
};
/**
 * Taps the control announced [description], scrolling the form down a few steps if it is below the fold,
 * and waits for [expected] (tapped once more only if the first tap provably did nothing; device.mjs tapExpecting).
 */
const tapDescribed = async (description, expected, what = description) => {
    // Compose lists a control scrolled out of view with empty bounds: scroll until it is on screen too.
    const shown = (nodes) => [withDescription(nodes, description)].find((node) => node && node.bounds !== '[0,0][0,0]');
    let nodes = await screen();
    for (let step = 0; step < 4 && !shown(nodes); step += 1) nodes = await device.swipe(nodes, 'down');
    return tapExpecting(shown(nodes) ?? fail(`no control announced "${description}" on screen`), expected, what);
};
/** RN's date dialog is up: Android's own date picker (datetimepicker, display "default") with its OK. */
const datePicker = (nodes) => Boolean(button(nodes, 'OK')) && nodes.some((node) => node['resource-id'] === 'android:id/datePicker');

const openEditor = async (title) => {
    await inbox();
    // The Inbox grows with every run and pages by 50: reveal scrolls to the end, loading more as it goes (one pass; a
    // fresh pass per page went back to the top and never got past its first 20 swipes).
    const nodes = await reveal(title, 400);
    // Only a row fully inside the list: a clipped one's middle can sit on the tab bar's capture button.
    const row = inList(nodes, title) ?? fail(`row ${title} is not in the Inbox`);
    await tap(row);
    // The Inbox list opens the Form tab (RN's defaultEditTab="task", resolveTaskOpenTab).
    return waitFor(`the editor for ${title} on its Form tab`, (current) => editorShows(current, title) && isOn(withDescription(current, 'Edit')));
};
/** RN's status chips: "Status: <status>", selected when chosen. */
const chooseStatus = async (value) => {
    await tapDescribed(`Status: ${value}`, (nodes) => chipOn(nodes, `Status: ${value}`)
        // RN hides the status field for Reference (core's REFERENCE_HIDDEN_TASK_FIELDS), so the chips leave.
        || (value === 'Reference' && !nodes.some((node) => (node['content-desc'] ?? '').startsWith('Status: '))), `Status ${value} selected`);
};
const month = () => sh('date +%Y-%m');
/** The instant core stores for 00:00 on [day] of this month in the phone's time zone, with that day's own offset (DST). */
const phoneMidnight = (day) => {
    const [year, mon] = month().split('-').map(Number);
    const zone = sh('getprop persist.sys.timezone') || 'UTC';
    // The zone's offset at a UTC instant: its wall clock there, read back as if it were UTC, minus the instant.
    const offsetAt = (instant) => {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
            day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(instant).map(({ type, value }) => [type, value]));
        return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - instant;
    };
    const guess = Date.UTC(year, mon - 1, day);
    // Two steps settle a midnight on either side of a DST change.
    const first = guess - offsetAt(guess);
    return new Date(guess - offsetAt(first)).toISOString();
};
/** Picks [day] of the month the date picker opens on (the current month) and confirms. */
const pickDay = async (day) => {
    const dayPattern = new RegExp(`(^|\\D)${day}(\\D|$)`);
    const cell = (nodes) => nodes.find((node) => node.clickable === 'true' && dayPattern.test(`${node.text} ${node['content-desc']}`));
    const picker = await waitFor('the date picker', (nodes) => button(nodes, 'OK') && cell(nodes));
    await tapExpecting(cell(picker), (nodes) => button(nodes, 'OK')?.enabled === 'true', 'OK enabled', 10_000);
    await tapExpecting(button(await screen(), 'OK'), (nodes) => !datePicker(nodes), 'the date picker to close', 10_000);
};
/**
 * The due date control (RN's compact "Due Date: Not set" row, or the date button with core's label): picks
 * [day] and waits for core's new label. Returns the stored value a date-only pick writes and the label shown.
 */
const pickDueDay = async (day) => {
    const before = described(await screen(), 'Due Date');
    await tapDescribed(`Due Date: ${before}`, datePicker, 'the date picker');
    await pickDay(day);
    const value = `${month()}-${String(day).padStart(2, '0')}`;
    const nodes = await waitFor(`core's new due date label for day ${day}`, (current) => ![undefined, before, 'Not set'].includes(described(current, 'Due Date')));
    return { value, label: described(nodes, 'Due Date') };
};
/** A text field: tap it, move to the end, and type [digits] (digits only: some keyboards hold letters in a composition strip). */
const typeInto = async (node, digits, expected, erase = 0) => {
    // A tap on a focused field moves its cursor to the tap point, which can sit before a trailing ", "
    // (editor check failure 2026-09-23T20-52-16); tap only to focus it, at the field's far end, then Ctrl+End
    // once the keyboard is up (device.mjs focusAtEnd). A plain End is Compose's line end, which stops before
    // trailing whitespace (failure 2026-09-23T21-14-34).
    await device.focusAtEnd(node);
    requireAppFront();
    if (erase > 0) sh(`input keyevent ${Array(erase).fill('KEYCODE_DEL').join(' ')}`);
    sh(`input text ${digits}`);
    await waitFor(`the text ${expected}`, (nodes) => nodes.some((current) => current.class === 'android.widget.EditText' && current.text === expected), 10_000);
};
const appendTitle = async (digits, expected) => typeInto(field(await screen()), digits, expected);
/** The Contexts field, scrolled into view first: on the S23 the open keyboard leaves it below the form's visible part. */
const contextsField = async () => {
    await hideKeyboard();
    let nodes = await screen();
    for (let step = 0; step < 4 && !tagged(nodes, 'editor-contexts'); step += 1) nodes = await device.swipe(nodes, 'down');
    return tagged(nodes, 'editor-contexts') ?? fail('no Contexts field on screen');
};
/** An editor save took effect: the editor closed, or it is busy (Save disabled), or core's failure shows. */
const saveTookEffect = (nodes) => !inEditor(nodes) || button(nodes, 'Save')?.enabled === 'false'
    || nodes.some((node) => /^[A-Z_]+: /.test(node.text ?? '') || node.text?.includes('Injected commit failure'));
/** Save; a save queued behind typed text runs once core has resolved it. */
const save = async () => {
    const nodes = await waitFor('Save enabled', (current) => button(current, 'Save')?.enabled === 'true', 10_000);
    await tapExpecting(button(nodes, 'Save'), saveTookEffect, 'the save to start');
};

// ---- database ----
const sqlite = (sql) => {
    const dir = resolve(work, 'db');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = sh(`run-as ${PKG} ls files`).split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) {
        const name = `mindwtr-native-dev.db${suffix}`;
        if (present.includes(name)) device.pull(`files/${name}`, resolve(dir, name));
    }
    return JSON.parse(execFileSync('sqlite3', ['-json', resolve(dir, 'mindwtr-native-dev.db'), sql], { encoding: 'utf8' }) || '[]');
};
const FIELDS = 'title, status, dueDate, startTime, description, projectId, contexts, rev';
let taskId = '';
// contexts is stored as JSON text; it is compared as the list it holds.
const stored = () => {
    const found = sqlite(`SELECT ${FIELDS} FROM tasks WHERE id = '${taskId}' AND deletedAt IS NULL`)[0];
    return found && { ...found, contexts: JSON.parse(found.contexts ?? '[]') };
};
const expectStored = (expected, message) => {
    const row = stored();
    const wrong = Object.entries(expected).filter(([name, value]) => JSON.stringify(row?.[name]) !== JSON.stringify(value));
    check(wrong.length === 0, `${message}${wrong.length ? ` (stored ${JSON.stringify(row)})` : ''}`);
    return row;
};

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const restore = () => {
    for (const name of PROPS) { try { setProp(name, ''); } catch { /* device gone */ } }
    for (const [name, value] of [['user_rotation', originalRotation], ['accelerometer_rotation', originalAccelerometer]]) {
        try { sh(value === 'null' ? `settings delete system ${name}` : `settings put system ${name} ${value}`); } catch { /* device gone */ }
    }
    try { sh(`rm -f ${UI_FILE}`); } catch { /* device gone */ }
};

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})${sh('getprop ro.boot.qemu.avd_name') ? ` / AVD ${sh('getprop ro.boot.qemu.avd_name')}` : ''}`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    for (const name of PROPS) setProp(name, '');

    // Setup: upgrade-install over existing development data, boot, capture one task.
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) {
        throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    }
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    launch();
    await inbox();
    setRotation(0);
    await sleep(1500);
    let nodes = await inbox();
    let processId = pid();
    check(sqlite(`SELECT id FROM tasks WHERE title LIKE '${captured}%'`).length === 0, 'this run\'s titles are not in the database yet');
    const total = header(nodes);
    await type(captured);
    await tapExpecting(button(await screen(), 'Save'), (current) => draftText(current) === '' || button(current, 'Save')?.enabled === 'false', 'the capture to start');
    await waitFor('the capture', (current) => header(current) === total + 1 && draftText(current) === '');
    const ids = sqlite(`SELECT id FROM tasks WHERE title = '${captured}' AND deletedAt IS NULL`);
    check(ids.length === 1, 'captured one task to edit');
    taskId = ids[0].id;
    let row = expectStored({ title: captured, status: 'inbox', dueDate: null, contexts: [] }, 'captured task starts plain');

    // (a) Title, due date, and a typed context change; exactly those are stored, in one write. Core prefixes the context.
    const context = `78${run}`;
    await openEditor(captured);
    const { value: due } = await pickDueDay(15);
    const titleA = `${captured}7`;
    await appendTitle('7', titleA);
    await typeInto(await contextsField(), context, context);
    await save();
    await inbox();
    row = expectStored({
        title: titleA, status: 'inbox', dueDate: due, contexts: [`@${context}`],
        startTime: null, description: null, projectId: null, rev: row.rev + 1,
    }, '(a) stored exactly the edited title, due date, and @context in one write');

    // (e) Clearing the due date stores null. Done before the restart steps: an Inbox task
    // with a past date is moved to Next by core at startup and would leave the Inbox.
    await openEditor(titleA);
    await tapDescribed('Clear Due Date', (current) => described(current, 'Due Date') === 'Not set', 'Due Date: Not set');
    await save();
    await inbox();
    row = expectStored({ title: titleA, dueDate: null, contexts: [`@${context}`], rev: row.rev + 1 }, '(e) cleared due date stored as null');

    // (b) Rotation mid-edit keeps the draft; nothing is written.
    await openEditor(titleA);
    const { value: dueB, label: dueBLabel } = await pickDueDay(16);
    const titleB = `${titleA}8`;
    await appendTitle('8', titleB);
    await rotate(1);
    nodes = await waitFor('the draft after rotation', (current) => editorShows(current, titleB));
    check(pid() === processId, '(b) landscape: same process, draft title kept');
    await rotate(0);
    nodes = await waitFor('the draft after rotating back', (current) => editorShows(current, titleB, { 'Due Date': dueBLabel }));
    check(boots(processId) === 1, '(b) portrait: draft title and due date kept, one host boot');
    expectStored({ title: titleA, dueDate: null, rev: row.rev }, '(b) an unsaved draft wrote nothing');

    // (c) Home, process death, relaunch: the draft comes back and saves against its restored base.
    await goHome();
    await sleep(1500);
    sh(`run-as ${PKG} kill -9 ${processId}`);
    await waitFor('process death', () => pid() !== processId, 10_000);
    launch();
    nodes = await waitFor('the restored editor', (current) => editorShows(current, titleB, { 'Due Date': dueBLabel }), 60_000);
    processId = pid();
    check(boots(processId) === 1, '(c) editor draft restored after process death, one host boot');
    const booted = stored();
    if (booted.rev !== row.rev) console.log(`note - (c) core wrote the task at startup: status ${row.status} -> ${booted.status}, rev ${row.rev} -> ${booted.rev}`);
    await save();
    await inbox();
    row = expectStored({ title: titleB, status: booted.status, dueDate: dueB, rev: booted.rev + 1 }, '(c) restored draft saved once');

    // (d) A failed commit keeps the draft and only its exact retry, across rotation, Back, and a new screen.
    await openEditor(titleB);
    const titleD = `${titleB}9`;
    await appendTitle('9', titleD);
    setProp('fail_commit', '1');
    await save();
    const hasError = (current) => current.some((node) => node.text?.includes('Injected commit failure'));
    const failedEditor = (current, label) => {
        check(field(current)?.text === titleD && field(current)?.enabled === 'false', `(d${label}) draft kept and locked`);
        check(button(current, 'Save')?.enabled === 'true', `(d${label}) exact retry allowed`);
        check(button(current, 'Close')?.enabled === 'false', `(d${label}) leaving the editor blocked`);
    };
    nodes = await waitFor('save failure', (current) => inEditor(current) && hasError(current));
    failedEditor(nodes, '');
    expectStored({ title: titleB, rev: row.rev }, '(d) failed commit stored nothing');
    await rotate(1);
    failedEditor(await waitFor('failed state after rotation', (current) => inEditor(current) && hasError(current)), ' landscape');
    await rotate(0);
    failedEditor(await waitFor('failed state after rotating back', (current) => inEditor(current) && hasError(current)), ' portrait');
    // Back is left to the system while the retry is owed, so it leaves the app.
    for (let attempt = 0; attempt < 2 && front().includes(`${PKG}/`); attempt += 1) {
        sh('input keyevent KEYCODE_BACK');
        await sleep(1500);
    }
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    launch();
    failedEditor(await waitFor('failed state after Back and reopen', (current) => inEditor(current) && hasError(current)), ' after Back and reopen');
    // Android 12+ keeps a root Activity on Back, so also finish it: the new screen
    // gets a new ViewModel and must restore the editor and its retry from the process.
    const newScreensBefore = newScreens(processId);
    requireAppFront();
    sh(`am start -W -f 0x10008000 -n ${ACTIVITY}`); // NEW_TASK | CLEAR_TASK
    await waitFor('a new screen on the running host', () => newScreens(processId) > newScreensBefore, 15_000);
    failedEditor(await waitFor('failed state on the new screen', (current) => inEditor(current) && hasError(current)), ' on a new screen');
    check(pid() === processId && boots(processId) === 1, '(d) same process and host');
    expectStored({ title: titleB, rev: row.rev }, '(d) still nothing stored before the retry');
    setProp('fail_commit', '');
    await save();
    nodes = await inbox();
    check(!hasError(nodes) && taskRows(nodes).some((node) => node.enabled === 'true'),
        '(d) retry cleared the failure: rows work again');
    row = expectStored({ title: titleD, dueDate: dueB, rev: row.rev + 1 }, '(d) retry stored the edit once');

    // (i) A save whose acknowledgment dies with the process: the commit lands, core's reply is held back, and the
    // process is killed. The exact request was on disk before the call, so the relaunch sends it again before the
    // draft unlocks, and core writes nothing twice: the editor closes and the task holds the edit from one write.
    await openEditor(titleD);
    const titleI = `${titleD}6`;
    await appendTitle('6', titleI);
    // The due date goes too: a past date would let core's startup pass move this Inbox task to Next on the relaunch.
    await hideKeyboard();
    await tapDescribed('Clear Due Date', (current) => described(current, 'Due Date') === 'Not set', 'Due Date: Not set');
    setProp('delay_after_ms', '20000');
    await save();
    await waitFor('the commit while its reply is held back', () => stored()?.title === titleI && stored()?.dueDate === null, 15_000);
    await goHome(); // onStop saves the editor's key, as a user leaving the app would
    sh(`run-as ${PKG} kill -9 ${processId}`);
    setProp('delay_after_ms', '');
    await waitFor('process death', () => pid() !== processId, 10_000);
    launch();
    nodes = await inbox();
    processId = pid();
    check(boots(processId) === 1 && !inEditor(nodes), '(i) the relaunch sent the saved request again and closed the editor');
    // The boot's journal replay sends the request first (its entry was on disk); the editor's own re-send then unlocks the draft.
    // Both answer saved, and core writes once (the revision below).
    check(logs(processId).includes('Native Android journal replay sent=1 dropped=1 left=0 owed=none') && saves(processId, 'saved') === 2,
        '(i) the boot replayed the journaled save, and the editor\'s re-send answered saved too, in the new process');
    row = expectStored({ title: titleI, status: 'inbox', dueDate: null, rev: row.rev + 1 }, '(i) the edit is stored from one write');

    // (g) A context from core's suggestions, and (h) a due date with a time (RN's clock button), in one save.
    await openEditor(titleI);
    const stored0 = `@${context}`;
    const prefix = `78${run.slice(0, 6)}`;
    // Erase the stored context and type its first digits: core suggests the stored one.
    await typeInto(await contextsField(), prefix, prefix, stored0.length + 2);
    nodes = await waitFor(`core's suggestion ${stored0}`, (current) => current.some((node) => node.text === stored0 && node.class !== 'android.widget.EditText'));
    await tapExpecting(nodes.find((node) => node.text === stored0 && node.class !== 'android.widget.EditText'),
        (current) => tagged(current, 'editor-contexts')?.text === `${stored0}, `, 'the suggestion in the field');
    const second = `79${run.slice(0, 6)}`;
    await typeInto(await contextsField(), second, `${stored0}, ${second}`);
    await hideKeyboard();
    const { label: dateOnlyLabel } = await pickDueDay(16);
    // RN's clock opens the time picker on core's time for the field: midnight for a date-only due.
    await tapDescribed(`Change time Due Date`, (current) => button(current, 'OK') && !datePicker(current), 'the time picker');
    await tapExpecting(button(await screen(), 'OK'), (current) => ![undefined, dateOnlyLabel].includes(described(current, 'Due Date')), 'core\'s label with the time');
    const dueH = phoneMidnight(16);
    await save();
    await inbox();
    row = expectStored({ title: titleI, contexts: [stored0, `@${second}`], dueDate: dueH, rev: row.rev + 1 },
        '(g) the suggestion replaced the typed digits and (h) the due date got its time (core\'s instant for 00:00), in one write');

    // (j) A new day keeps the time: core moves the due date to the 17th at the same 00:00 (RN keeps the hour).
    await openEditor(titleI);
    await pickDueDay(17);
    await save();
    await inbox();
    row = expectStored({ title: titleI, dueDate: phoneMidnight(17), rev: row.rev + 1 }, '(j) a day pick kept the due date\'s time');

    // (f) Status Reference and a project from the Destination picker: core applies its reference rule (the due date goes).
    await openEditor(titleI);
    await chooseStatus('Reference');
    nodes = await tapDescribed(`Destination: ${described(await screen(), 'Destination')}`, (current) => Boolean(button(current, 'Cancel')), 'the Destination picker');
    const choice = nodes.find((node) => (node['resource-id'] ?? '').endsWith('destination-project'));
    const projectTitle = choice ? nodes.find((node) => node.text && (() => { const [l, t, r, b] = node.bounds.match(/\d+/g).map(Number); const [cl, ct, cr, cb] = choice.bounds.match(/\d+/g).map(Number); return l >= cl && t >= ct && r <= cr && b <= cb; })())?.text : undefined;
    if (choice) {
        await tapExpecting(choice, (current) => described(current, 'Destination') === projectTitle, `Destination: ${projectTitle}`);
    } else {
        console.log('note - (f) the development data has no project to choose; the picker closes with Cancel');
        await tapExpecting(button(nodes, 'Cancel'), (current) => !button(current, 'Cancel'), 'the picker to close');
    }
    await save();
    await inbox();
    row = expectStored({ title: titleI, status: 'reference', dueDate: null, rev: row.rev + 1 }, '(f) core stored Reference and cleared the due date');
    if (choice) {
        const chosen = sqlite(`SELECT title FROM projects WHERE id = (SELECT projectId FROM tasks WHERE id = '${taskId}')`)[0];
        check(chosen?.title === projectTitle, `(f) the Destination picker stored the project "${projectTitle}"`);
    }
    check(saves(processId, 'saved') >= 3, // the (i) re-send, (g)/(h), and (f) saves in this process; (d)'s failure was in the one before
        'task-command log shows operation=saveTaskDraft saves');

    // Relaunch: boot validation passes and the final values stand.
    requireAppFront();
    sh(`am force-stop ${PKG}`);
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    launch();
    nodes = await inbox();
    processId = pid();
    check(boots(processId) === 1 && !bootFailure(nodes), 'relaunch: boot validation passed');
    expectStored({ title: titleI, status: 'reference', dueDate: null, contexts: [stored0, `@${second}`], rev: row.rev },
        'relaunch: final values stored');
    console.log('Editor device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    restore();
}
