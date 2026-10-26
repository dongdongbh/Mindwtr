// Focus check for the isolated native Android development app.
//
//   node apps/android-native/scripts/check-focus-device.mjs <adb-serial> [apk]
//
// Installs the debug APK with `install -r` (existing development data stays),
// captures two tasks with titles unique to this run, sets both to Next in the
// editor, and checks Focus: (a) they appear under "Next actions"; (b) a due
// date of today, picked where the date picker marks today, moves one under
// "Today", and Save and Close return to Focus; (c) Complete from Focus (RN's
// swipe right, then its revealed button) removes it and stores `done` once; (d) rotation keeps the Focus tab and its
// rows; (e) process death restores the Focus tab; (h) the star moves a row under
// "Today's Focus" and stores it once, and a second tap takes it back (skipped
// when core refuses the star: its toast shows); (f) a failed Complete keeps
// its exact retry through rotation, Back, and a new screen, then stores once;
// (g) More adds rows to a section with more than 50, on a fresh process after the
// relaunch (skipped when the development data has none). It asserts through the app's own database copy
// (.db, -wal and -shm pulled together), the UI hierarchy, and logcat. It
// touches only the development package (it refuses any other APK), never
// launches over another app, leaves the app on its Inbox tab, and restores
// rotation and clears its debug properties on exit. Leave the device on its
// home screen before running. It needs host `sqlite3`.
// Exit 0 = pass, 1 = fail, 2 = refused before touching the device, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { besideRow, bootFailure, box, button, check, connect, described, draftText, evidenced, fail, field, inEditor, inList, isOn, Stopped, tab, tabSelected, taskRow, taskRows, withDescription, chipOn, inboxCount } from './device.mjs';
// Focus section titles as core renders them in English (core's dictionary, not literals).
const { en } = await import(resolve(import.meta.dirname, '../../../packages/core/src/i18n/locales/en.ts'));
const NEXT_ACTIONS = en['focus.nextActions'];
const TODAY = en['focus.schedule'];
const TODAYS_FOCUS = en['agenda.todaysFocus'];
const STAR = en['agenda.addToFocus'];
const UNSTAR = en['agenda.removeFromFocus'];
const CHANGE_STATUS = en['taskStatus.changeStatus'];

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-focus-device.mjs <adb-serial> [apk]');
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
const work = resolve(app, 'android/build/focus-check');
// Digits only: some phone keyboards hold typed letters in a composition strip.
const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const first = `71${run}`;
const second = `72${run}`;

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting, type, swipe, signature, toTop, completeUntil } = device;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);

// ---- device state ----
const launch = () => device.launch(ACTIVITY);
const logs = (processId) => device.logs(processId, TAG);
const count = (text, needle) => text.split('\n').filter((line) => line.includes(needle)).length;
const boots = (processId) => count(logs(processId), 'Core host boot started');
const recreations = (processId) => count(logs(processId), 'reason=activity-recreate');
const newScreens = (processId) => count(logs(processId), 'reason=new-screen');
// The log's `context` is itself a JSON string, so its quotes arrive escaped.
const completes = (processId, outcome) => logs(processId).replace(/\\/g, '').split('\n').filter((line) => line.includes('native-android-dev-task-command')
    && line.includes('"operation":"complete"') && line.includes(`"outcome":"${outcome}"`)).length;
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
const inboxTab = (nodes) => tab(nodes, 'Inbox');
/** Focus section titles as "<core title> · <core total>"; each title stays pinned above its rows. */
const headers = (nodes) => nodes.flatMap((node) => {
    const match = /^(.+) · (\d+)$/.exec(node.text ?? '');
    return match ? [{ title: match[1], total: Number(match[2]), top: box(node)[1] }] : [];
});
const sectionTotal = (nodes, title) => headers(nodes).find((header) => header.title === title)?.total;
const rowNode = (nodes, title) => nodes.find((node) => node.text === title && node.class !== 'android.widget.EditText');
/** The section a visible row is in: the nearest title at or above the row. */
const sectionOf = (nodes, title) => {
    const row = rowNode(nodes, title);
    if (!row) return undefined;
    const top = box(row)[1];
    return headers(nodes).filter((header) => header.top <= top).sort((a, b) => b.top - a.top)[0]?.title ?? passedSection;
};
const inbox = () => waitFor('the Inbox', (nodes) => tabSelected(nodes, 'Inbox') && !inEditor(nodes)
    && Number.isFinite(inboxCount(nodes)), 60_000);
// Section titles scroll with the rows (as in RN), so a scrolled list may show rows only.
const focusList = (description = 'Focus') => waitFor(description, (nodes) => tabSelected(nodes, 'Focus') && !inEditor(nodes)
    && (headers(nodes).length > 0 || taskRows(nodes).length > 0), 60_000);
const showTab = async (name) => {
    const nodes = await waitFor('the tabs', (current) => tab(current, name), 60_000);
    if (tabSelected(nodes, name)) return;
    await tapExpecting(tab(nodes, name), (current) => tabSelected(current, name), `the ${name} tab`, 10_000);
};
const hasError = (nodes) => nodes.some((node) => node.text?.includes('Injected commit failure'));
/** Taps the control labelled [label] until [done] holds; a tap can land while the list still moves, so tap again. */
const tapUntil = async (label, description, done) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const nodes = await screen();
        // The last tap took effect after the wait ran out: tapping again would be a second command
        // (after a failure, its exact retry), so stop here.
        if (attempt > 0 && done(nodes)) return nodes;
        const control = button(nodes, label);
        if (!control && attempt > 0) break; // the first tap took effect; only the wait is left
        await tap(control ?? fail(`no control labelled ${label}`));
        try { return await waitFor(description, done, 8_000); } catch { /* tap again */ }
    }
    return waitFor(description, done, 20_000);
};
const FOCUS_ONLY = en['agenda.collapseOtherSections'];
const EXPAND_SECTIONS = en['agenda.expandOtherSections'];
/**
 * Opens every section but Today's Focus with RN's toggle, whatever view the device kept (a folded
 * section hides its rows). "Focus only" folds them all first, so "Expand sections" then opens them all.
 */
const openSections = async () => {
    let nodes = await screen();
    if (button(nodes, FOCUS_ONLY)) nodes = await tapUntil(FOCUS_ONLY, 'Focus only', (current) => Boolean(button(current, EXPAND_SECTIONS)));
    if (button(nodes, EXPAND_SECTIONS)) await tapUntil(EXPAND_SECTIONS, 'every section open', (current) => Boolean(button(current, FOCUS_ONLY)));
};
/** The editor's draft as its controls announce it ("Due Date: 2026-09-15"); the first text field is the title. */
const editorShows = (nodes, title, values = {}) => inEditor(nodes) && field(nodes)?.text === title
    && Object.entries(values).every(([label, value]) => described(nodes, label) === value);
/** Taps the control announced [description] and waits for [expected] (tapped once more only if the first tap provably did nothing). */
const tapDescribed = async (description, expected, what = description) => {
    const nodes = await screen();
    return tapExpecting(withDescription(nodes, description) ?? fail(`no control announced "${description}"`), expected, what);
};
/** RN's status chips: "Status: <status>", selected when chosen. */
const chooseStatus = async (value) => {
    await tapDescribed(`Status: ${value}`, (nodes) => chipOn(nodes, `Status: ${value}`)
        // RN hides the status field for Reference (core's REFERENCE_HIDDEN_TASK_FIELDS), so the chips leave.
        || (value === 'Reference' && !nodes.some((node) => (node['content-desc'] ?? '').startsWith('Status: '))), `Status ${value} selected`);
};
/** The capture or editor Save took effect: the sheet or editor closed, or it is busy (Save disabled), or a failure shows. */
const saveTookEffect = (nodes) => !button(nodes, 'Save') || button(nodes, 'Save')?.enabled === 'false' || hasError(nodes);
const tapSave = async () => tapExpecting(button(await screen(), 'Save') ?? fail('no Save on screen'), saveTookEffect, 'the save to start');

/**
 * Scrolls Focus from the top until [title] is on screen. An enabled
 * "More <section>" (core's `common.more`) on the way is tapped, since sections page by 50.
 */
/**
 * Scrolls from the top until the row is fully in the list. Section titles scroll with the
 * rows (as in RN), so it remembers the last title it scrolled past for `sectionOf`.
 */
let passedSection;
const scanForRow = async (title) => {
    let nodes = await toTop();
    passedSection = undefined;
    // A budget in proportion to what Focus can list: every open task may be a row (about two per swipe in
    // landscape, five in portrait) and each 50 rows add one More. The loop still stops at the list's end.
    // A fixed 80 ran out as the development data grew (run 21); open / 5 ran out in landscape (run 25).
    const open = sqlite("SELECT COUNT(*) AS n FROM tasks WHERE deletedAt IS NULL AND status NOT IN ('done', 'archived', 'inbox')")[0].n;
    const budget = Math.ceil(open / 2) + Math.ceil(open / 50) + 20;
    let triedMore;
    for (let step = 0; step < budget; step += 1) {
        if (inList(nodes, title)) return nodes;
        passedSection = headers(nodes).sort((a, b) => b.top - a.top)[0]?.title ?? passedSection;
        // The dump can report the More pill's labelled node as not clickable (its click sits on a same-bounds node,
        // run 32), so it is found by its label and tapped at its center; a pill that stays put after the tap is
        // treated as disabled (a retry is owed) and the scroll goes on.
        const listBox = box(nodes.find((node) => node.scrollable === 'true') ?? { bounds: '[0,0][0,99999]' });
        // A tap that slipped onto the tab bar's Menu opens the More sheet over the list: close it and go on (run 37).
        if (nodes.some((node) => /(^|\/)more-sheet$/.test(node['resource-id'] ?? ''))) {
            requireAppFront();
            sh('input keyevent KEYCODE_BACK');
            await sleep(800);
            nodes = await screen();
            continue;
        }
        // Only a pill wholly inside the list is tapped, after the list settles (the tab bar sits right under it); one
        // cut by the edge is scrolled up first by the swipe below.
        const more = nodes.find((node) => node['content-desc']?.startsWith('More ') && node.enabled !== 'false'
            && box(node)[1] >= listBox[1] && box(node)[3] <= listBox[3] - 20);
        // While a retry is owed the pill is locked by design: never tap it then (a tap that falls through can
        // land on the tab bar and open the Menu sheet, run 33).
        if (more && more['content-desc'] !== triedMore && !hasError(nodes)) {
            triedMore = more['content-desc'];
            // Tap the pill where it rests: a tap while the list still moves can miss it (run 36).
            nodes = await device.settle(nodes);
            const resting = nodes.find((node) => node['content-desc'] === more['content-desc']) ?? more;
            await tap(resting);
            try {
                nodes = await waitFor('Load more to finish', (current) => !current.some((node) => node['content-desc'] === more['content-desc']
                    && node.bounds === more.bounds), 15_000);
                triedMore = undefined;
                continue;
            } catch { nodes = await screen(); }
        }
        const next = await swipe(nodes, 'down');
        if (signature(next) === signature(nodes)) break;
        nodes = next;
    }
    return { missing: `row ${title} is not in Focus (${open} open tasks, ${budget} steps)` };
};
/** Scans Focus for [title]; a scan that missed (a moving list, a missed More tap) is repeated once from the top. */
const findRow = async (title) => {
    const first = await scanForRow(title);
    if (!first.missing) return first;
    const second = await scanForRow(title);
    return second.missing ? fail(second.missing) : second;
};
const expectSection = async (title, section, label) => {
    const nodes = await findRow(title);
    check(sectionOf(nodes, title) === section, `${label} ${title} is under "${section}"${sectionOf(nodes, title) === section ? '' : ` (found under "${sectionOf(nodes, title)}")`}`);
    return nodes;
};

/** Opens the editor from the Inbox, scrolling and loading more until the row appears. */
const openFromInbox = async (title) => {
    await inbox();
    // The Inbox grows with every run and pages by 50: reveal scrolls to the end, loading more as it goes (one pass; a
    // fresh pass per page went back to the top and never got past its first 20 swipes).
    const nodes = await device.reveal(title, 400);
    // Only a row fully inside the list: a clipped one's middle can sit on the tab bar's capture button.
    const row = inList(nodes, title) ?? fail(`row ${title} is not in the Inbox`);
    await tap(row);
    // The Inbox list opens the Form tab (RN's defaultEditTab="task").
    return waitFor(`the editor for ${title} on its Form tab`, (current) => editorShows(current, title) && isOn(withDescription(current, 'Edit')));
};
/** RN opens a task from Focus on its View tab (resolveTaskOpenTab); the Edit tab then shows the Form this check edits. */
const openFromFocus = async (title) => {
    const nodes = await findRow(title);
    await tap(inList(nodes, title));
    const open = await waitFor(`the editor for ${title} on its View tab`, (current) => inEditor(current) && isOn(withDescription(current, 'Preview')) && hasTitle(current, title));
    return tapExpecting(withDescription(open, 'Edit'), (current) => editorShows(current, title) && isOn(withDescription(current, 'Edit')), 'the Form tab');
};
const hasTitle = (nodes, title) => nodes.some((node) => node.text === title && node.class !== 'android.widget.EditText');

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
const ids = {};
const stored = (title) => sqlite(`SELECT status, dueDate, rev, isFocusedToday FROM tasks WHERE id = '${ids[title]}' AND deletedAt IS NULL`)[0];
const expectStored = (title, expected, message) => {
    const row = stored(title);
    const wrong = Object.entries(expected).filter(([name, value]) => row?.[name] !== value);
    check(wrong.length === 0, `${message}${wrong.length ? ` (stored ${JSON.stringify(row)})` : ''}`);
    return row;
};

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const restore = async () => {
    for (const name of PROPS) { try { setProp(name, ''); } catch { /* device gone */ } }
    // Leave the app on its Inbox tab: the other checks start there.
    try {
        const tab = front().includes(`${PKG}/`) ? inboxTab(await screen()) : undefined;
        if (tab && tab.selected !== 'true') await tap(tab);
    } catch { /* the app is gone */ }
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

    // Setup: upgrade-install over existing development data, boot, capture two tasks, set both to Next.
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) {
        throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    }
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    launch();
    await showTab('Inbox');
    setRotation(0);
    await sleep(1500);
    let nodes = await inbox();
    let processId = pid();
    check(sqlite(`SELECT id FROM tasks WHERE title IN ('${first}', '${second}')`).length === 0, 'this run\'s titles are not in the database yet');
    for (const title of [first, second]) {
        const total = inboxCount(await inbox());
        await type(title);
        await tapSave();
        await waitFor(`the capture of ${title}`, (current) => inboxCount(current) === total + 1 && draftText(current) === '');
        const found = sqlite(`SELECT id FROM tasks WHERE title = '${title}' AND deletedAt IS NULL`);
        check(found.length === 1, `captured ${title} once`);
        ids[title] = found[0].id;
        await openFromInbox(title);
        await chooseStatus('Next');
        await tapSave();
        await inbox();
        expectStored(title, { status: 'next', dueDate: null }, `${title} stored as next`);
    }

    // (a) Both appear under core's "Next actions" in Focus.
    await showTab('Focus');
    await focusList();
    await openSections();
    await expectSection(first, NEXT_ACTIONS, '(a)');
    await expectSection(second, NEXT_ACTIONS, '(a)');

    // (b) The editor opens from Focus, and Close and Save both return to Focus.
    await openFromFocus(first);
    await tapExpecting(button(await screen(), 'Close'), (current) => !inEditor(current), 'the editor to close');
    await focusList('Focus after Close');
    check(true, '(b) Close returned to Focus');
    // Due today, picked where the picker marks today: the row moves under "Today".
    await openFromFocus(first);
    const today = sh('date +%Y-%m-%d');
    const day = Number(sh('date +%d'));
    await tapDescribed('Due Date: Not set', (current) => Boolean(button(current, 'OK')), 'the date picker');
    const label = (node) => `${node.text ?? ''} ${node['content-desc'] ?? ''}`;
    // RN's system date dialog opens on today, chosen (a field with no date starts there).
    const todayCell = (current) => current.find((node) => node.clickable === 'true' && node.selected === 'true' && /\d/.test(label(node)));
    nodes = await waitFor('the date picker', (current) => button(current, 'OK') && todayCell(current));
    check(new RegExp(`(^|\\D)${day}(\\D|$)`).test(label(todayCell(nodes))), `(b) the picker marks today, day ${day} ("${label(todayCell(nodes)).trim()}")`);
    await tapExpecting(todayCell(nodes), (current) => button(current, 'OK')?.enabled === 'true', 'OK enabled', 10_000);
    // The row shows core's label for the day; the stored value is checked after Save.
    await tapExpecting(button(await screen(), 'OK'), (current) => ![undefined, 'Not set'].includes(described(current, 'Due Date')), 'core\'s due date label');
    const beforeDue = stored(first);
    await tapSave();
    await focusList('Focus after Save');
    check(true, '(b) Save returned to Focus');
    const due = expectStored(first, { status: 'next', dueDate: today, rev: beforeDue.rev + 1 }, `(b) due date ${today} stored in one write`);
    nodes = await expectSection(first, TODAY, '(b)');

    // (#1275) A long-press on the revealed action button opens RN's status menu; Back closes it and nothing is stored.
    {
        const action = await device.revealAction(await screen(), first);
        requireAppFront();
        const [l, t, r, b] = box(action);
        sh(`input swipe ${Math.round((l + r) / 2)} ${Math.round((t + b) / 2)} ${Math.round((l + r) / 2)} ${Math.round((t + b) / 2)} 900`);
        await waitFor('the status menu', (current) => current.some((node) => node.text === CHANGE_STATUS), 10_000);
        sh('input keyevent KEYCODE_BACK');
        await waitFor('the status menu to close', (current) => !current.some((node) => node.text === CHANGE_STATUS), 10_000);
        expectStored(first, { status: 'next', rev: due.rev }, '(#1275) long-press on the revealed action opens the status menu and stores nothing');
    }

    // (c) Complete from Focus: the row leaves, core's Today total drops by one, and done is stored once.
    const todayTotal = sectionTotal(nodes, TODAY);
    const savedBefore = completes(processId, 'saved');
    // Core's Today total drops by one; a section core counts as empty is hidden, as in RN.
    const todayAfter = (current) => sectionTotal(current, TODAY) ?? (headers(current).length > 0 ? 0 : undefined);
    nodes = await completeUntil(first, `${first} to leave Focus`,
        (current) => !rowNode(current, first) && todayAfter(current) === todayTotal - 1);
    check(true, `(c) ${first} left Focus; Today total ${todayTotal} -> ${todayTotal - 1}`);
    expectStored(first, { status: 'done', dueDate: today, rev: due.rev + 1 }, '(c) done stored in one write');
    check(completes(processId, 'saved') === savedBefore + 1, '(c) task-command log shows one operation=complete saved');

    // (d) Rotation keeps the Focus tab and its rows, on the same process and host.
    await rotate(1);
    await focusList('Focus after rotation');
    await expectSection(second, NEXT_ACTIONS, '(d) landscape: Focus tab kept;');
    await rotate(0);
    await focusList('Focus after rotating back');
    await expectSection(second, NEXT_ACTIONS, '(d) portrait: Focus tab kept;');
    check(pid() === processId && boots(processId) === 1, '(d) same process, one host boot');

    // (e) Home, process death, relaunch: the Focus tab comes back.
    await goHome();
    await sleep(1500);
    sh(`run-as ${PKG} kill -9 ${processId}`);
    await waitFor('process death', () => pid() !== processId, 10_000);
    launch();
    await focusList('the restored Focus tab');
    processId = pid();
    check(boots(processId) === 1, '(e) Focus tab restored after process death, one host boot');
    nodes = await expectSection(second, NEXT_ACTIONS, '(e)');

    // (h) The star: core stores the target state, and the row moves under core's "Today's Focus"; a second tap takes it back.
    const beforeStar = stored(second);
    await tap(besideRow(nodes, second, STAR) ?? fail(`no "${STAR}" star beside ${second}`));
    // A Next task with no start date can only be refused at core's focus limit: its toast shows core's "Max N focus items."
    const limitToast = new RegExp(`^${en['agenda.maxFocusItems'].split('{{count}}').map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\d+')}$`);
    nodes = await waitFor('the star to be stored or refused', (current) => stored(second)?.isFocusedToday === 1
        || current.some((node) => limitToast.test(node.text ?? '')), 15_000);
    if (stored(second).isFocusedToday !== 1) {
        console.log('skip - (h) core refused the star at its focus limit, and its toast showed core\'s text');
        expectStored(second, { rev: beforeStar.rev }, '(h) a refused star stored nothing');
    } else {
        expectStored(second, { isFocusedToday: 1, status: 'next', rev: beforeStar.rev + 1 }, '(h) the star stored isFocusedToday once');
        nodes = await expectSection(second, TODAYS_FOCUS, '(h)');
        await tap(besideRow(nodes, second, UNSTAR) ?? fail(`no "${UNSTAR}" star beside ${second}`));
        await waitFor('the star removal to be stored', () => stored(second)?.isFocusedToday === 0, 15_000);
        expectStored(second, { isFocusedToday: 0, rev: beforeStar.rev + 2 }, '(h) the second tap stored the removal once');
        nodes = await expectSection(second, NEXT_ACTIONS, '(h) unstarred:');
    }

    // (f) A failed Complete from Focus keeps only its exact retry across rotation, Back, and a new screen.
    const beforeFailure = stored(second);
    setProp('fail_commit', '1');
    nodes = await completeUntil(second, 'the failed Complete', hasError);
    const failedFocus = async (description, labelText) => {
        // At the top of the list nothing overlaps the pinned failure text, so the tree reports it there.
        await toTop();
        await waitFor(description, (current) => tabSelected(current, 'Focus') && hasError(current));
        const current = await findRow(second);
        // After a scroll, Compose can report a partly scrolled-out row's full bounds over the pinned failure
        // text, so the accessibility tree omits that text although it stays on screen (screenshot-verified,
        // U04 follow-up). The failure was asserted above; here the owed retry itself is the evidence.
        check(tabSelected(current, 'Focus'), `(f${labelText}) Focus tab kept`);
        check(Boolean(taskRow(current, second)), `(f${labelText}) the row with the owed retry is still shown`);
        // Every row locks with the owed retry; only the failed row's swipe stays on (the same rule, check-boot-gates.mjs).
        const rows = taskRows(current);
        check(rows.length > 0 && rows.every((node) => node.enabled === 'false'), `(f${labelText}) ${rows.length} rows locked`);
        check(tab(current, 'Inbox')?.enabled === 'true', `(f${labelText}) tabs still work`);
    };
    await failedFocus('the failure', '');
    expectStored(second, { status: 'next', rev: beforeFailure.rev }, '(f) failed commit stored nothing');
    await rotate(1);
    await failedFocus('the failure after rotation', ' landscape');
    await rotate(0);
    await failedFocus('the failure after rotating back', ' portrait');
    // Back is left to the system while the retry is owed, so it leaves the app.
    for (let attempt = 0; attempt < 2 && front().includes(`${PKG}/`); attempt += 1) {
        sh('input keyevent KEYCODE_BACK');
        await sleep(1500);
    }
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    launch();
    await failedFocus('the failure after Back and reopen', ' after Back and reopen');
    // Android 12+ keeps a root Activity on Back, so also finish it: the new screen gets
    // a new ViewModel and must restore Focus, its rows, and the retry from the process.
    const newScreensBefore = newScreens(processId);
    requireAppFront();
    sh(`am start -W -f 0x10008000 -n ${ACTIVITY}`); // NEW_TASK | CLEAR_TASK
    await waitFor('a new screen on the running host', () => newScreens(processId) > newScreensBefore, 15_000);
    await failedFocus('the failure on a new screen', ' on a new screen');
    check(pid() === processId && boots(processId) === 1, '(f) same process and host');
    expectStored(second, { status: 'next', rev: beforeFailure.rev }, '(f) still nothing stored before the retry');
    // Reads wait while the retry is owed, so no read failure can have replaced the Done retry.
    check(!logs(processId).includes('lock=storage'), '(f) no read failed while the retry was owed (log has no lock=storage)');
    setProp('fail_commit', '');
    nodes = await completeUntil(second, 'the retry', (current) => !hasError(current) && !rowNode(current, second));
    expectStored(second, { status: 'done', rev: beforeFailure.rev + 1 }, '(f) retry stored done once');
    check(completes(processId, 'failed') >= 1 && completes(processId, 'saved') >= 1, '(f) task-command log shows the failed and the saved complete');

    // Relaunch: boot validation passes on the final data.
    requireAppFront();
    sh(`am force-stop ${PKG}`);
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    launch();
    await showTab('Inbox');
    nodes = await inbox();
    processId = pid();
    check(boots(processId) === 1 && !bootFailure(nodes), 'relaunch: boot validation passed');
    expectStored(first, { status: 'done' }, `relaunch: ${first} done`);
    expectStored(second, { status: 'done' }, `relaunch: ${second} done`);
    // (g) More on a section with more than 50 rows. Run on a fresh process: the steps above tap every More
    // they pass while looking for a row, and a refresh keeps that depth, so no More would be left to try.
    await showTab('Focus');
    nodes = await toTop();
    passedSection = undefined;
    // Only a More fully inside the list: one under the tab bar would be a tap on the bar.
    const moreInList = (current) => {
        const list = current.find((node) => node.scrollable === 'true');
        const [, top, , bottom] = list ? box(list) : [0, 0, 0, Infinity];
        return current.find((node) => node['content-desc']?.startsWith('More ') && box(node)[1] >= top && box(node)[3] <= bottom);
    };
    let more;
    for (let step = 0; step < 80 && !more; step += 1) {
        more = moreInList(nodes);
        if (more) break;
        passedSection = headers(nodes).sort((a, b) => b.top - a.top)[0]?.title ?? passedSection;
        const next = await swipe(nodes, 'down');
        if (signature(next) === signature(nodes)) break;
        nodes = next;
    }
    if (!more) {
        console.log('skip - (g) no Focus section has more than 50 rows in the development data');
    } else {
        const section = more['content-desc'].slice('More '.length);
        const moreTop = box(more)[1];
        // Row titles; a row the window added sits where More was.
        const rowTitles = (current) => taskRows(current).map((node) => ({ title: node.text, top: box(node)[1] }));
        const before = new Set(rowTitles(nodes).map(({ title }) => title));
        const addedRow = (current) => rowTitles(current).find(({ title, top }) => !before.has(title) && top >= moreTop - 5);
        nodes = await tapUntil(more['content-desc'], `rows after More ${section}`, addedRow);
        const added = addedRow(nodes).title;
        check(sectionOf(nodes, added) === section, `(g) More added ${added} to "${section}"`);
        // A resume reads Focus again from offset 0 and keeps the loaded depth.
        await goHome();
        launch();
        await focusList('Focus after resume');
        await sleep(2000);
        check(rowNode(await screen(), added), `(g) ${added} still loaded after a resume refresh`);
    }

    console.log('Focus device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
