// Capture popup check for the isolated native Android development app.
//
//   node apps/android-native/scripts/check-capture-device.mjs <adb-serial> [apk]
//
// Installs the debug APK with `install -r` (existing development data stays) and checks RN's capture popup
// (the tab bar's +) against core's own quick capture on a copy of the app's database: (0) on an empty draft Save is dimmed to
// half, the whole pill (read from screenshots), and inert, as RN's; (a) a capture with a
// context and a tag stores exactly what core's submitQuickCapture stores for the same draft; (b) "Add another"
// keeps the popup open for a second capture, then goes off again; (c) a project picked in More's picker (created
// through the picker's own Create row on the first run) is stored; (d) two lines ask core's question, write core's
// recovery snapshot (it parses and holds the tasks the data had before the batch), and store one task per line in one
// write; (e) an unreadable date command shows core's notice and stores nothing; (f) a failed commit keeps its
// exact retry, and Try again stores it once; (g) Save & edit on a task with no project opens its editor over Focus, as RN's
// openTaskScreen does; (h) the keyboard's own Done key saves the popup, as Save does (RN's b13f04019), with no line added;
// (i) More with the keyboard up waits for the keyboard to go, so the field stays on screen above the panel (RN's #1120,
// d73c7f2c1). It touches only the development package (it refuses any other
// APK), never launches over another app, clears its debug properties and leaves "Add another" off on exit.
// Leave the device on its home screen before running. It needs host `bun`.
// Exit 0 = pass, 1 = fail, 2 = refused before touching the device, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, button, check, connect, draftText, evidenced, fail, inboxCount, inEditor, owedRetry, Stopped, switchOn, tab, tabSelected, tagged, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-capture-device.mjs <adb-serial> [apk]');
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
const PROPS = ['fail_commit', 'delay_before_ms', 'delay_after_ms', 'language', 'clipboard'];
const DB = 'mindwtr-native-dev.db';
const work = resolve(app, 'android/build/capture-check');
const coreSrc = resolve(app, '../../packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));
// Digits for titles and tokens: the keyboard guard allows only an English layout, and digits never compose.
const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
// The picker's project: one fixed name, created once through the picker, then picked, so runs add no projects.
const PROJECT = '5600';
const titles = { a: `53${run}`, b1: `54${run}`, b2: `55${run}`, c: `56${run}`, d1: `57${run}1`, d2: `57${run}2`, e: `58${run}`, f: `59${run}`, g: `56${run}1`,
    h: `56${run}2`, i: `56${run}3` };

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { adbRaw, sh, home, front, requireAppFront, pid, screen, waitFor, tapExpecting } = device;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
const commands = (operation, outcome) => device.logs(pid(), TAG).replace(/\\/g, '').split('\n').filter((line) => line.includes('native-android-dev-task-command')
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
 * On a copy: the stored tasks titled [titles], and, for [text], what core's own popup stores (a fresh open,
 * then submitQuickCapture with a new ID on the copy), the id of the project titled PROJECT, and how many tasks
 * (tombstones too, as a backup holds them) the data has.
 */
const core = (text = '', ...names) => JSON.parse(execFileSync('bun', ['-e', `
    import { Database } from 'bun:sqlite';
    import { SqliteAdapter, createNativeHostContract, flushPendingSave, generateUUID, getStorageAdapter, setStorageAdapter, useTaskStore } from '${coreSrc}/index.ts';
    const db = new Database(process.env.CHECK_DB);
    setStorageAdapter(new SqliteAdapter({
        run: async (sql, params = []) => { db.query(sql).run(...params); },
        all: async (sql, params = []) => db.query(sql).all(...params),
        get: async (sql, params = []) => db.query(sql).get(...params) ?? undefined,
        exec: async (sql) => { db.exec(sql); },
    }));
    const host = createNativeHostContract();
    const ready = await host.activate({ writeSafetyReady: true });
    if (!ready.ok) throw new Error(ready.error.message);
    const value = (result) => { if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message); return result.value; };
    const shape = (task) => task && ({ title: task.title, status: task.status, contexts: [...(task.contexts ?? [])].sort(), tags: [...(task.tags ?? [])].sort(),
        projectId: task.projectId ?? null, areaId: task.areaId ?? null, priority: task.priority ?? null, dueDate: task.dueDate ?? null });
    const live = () => useTaskStore.getState()._allTasks.filter((task) => !task.deletedAt);
    const stored = Object.fromEntries(JSON.parse(process.env.CHECK_TITLES).map((title) => [title, live().filter((task) => task.title === title).map(shape)]));
    const opened = value(host.openQuickCapture());
    const project = useTaskStore.getState()._allProjects.find((item) => !item.deletedAt && item.title === '${PROJECT}')?.id ?? null;
    const dataTasks = (await getStorageAdapter().getData()).tasks.length;
    let expected = null;
    if (process.env.CHECK_TEXT) {
        const saved = value(await host.submitQuickCapture({ text: process.env.CHECK_TEXT, options: opened.options, captureId: generateUUID() }));
        await flushPendingSave();
        expected = shape(live().find((task) => task.id === saved.taskId));
    }
    console.log(JSON.stringify({ stored, expected, project, dataTasks }));
    process.exit(0);
`], { encoding: 'utf8', env: { ...process.env, CHECK_DB: pullDatabase(), CHECK_TEXT: text, CHECK_TITLES: JSON.stringify(names) } }).trim().split('\n').pop());
const snapshots = () => { try { return sh(`run-as ${PKG} ls files/snapshots`).split(/\s+/).filter((name) => name.endsWith('.snapshot.json')); } catch { return []; } };

// ---- UI (core's English) ----
const inPopup = (nodes) => Boolean(tagged(nodes, 'quick-capture'));
const onInbox = (nodes) => !inPopup(nodes) && Number.isFinite(inboxCount(nodes));
const hasError = (nodes) => nodes.some((node) => node.text?.includes('Injected commit failure'));
const title = (nodes) => tagged(nodes, 'capture-title')?.text ?? '';
/** Opens the popup from + and types [text] ('%s' is a space for `input text`) at the field's end. */
const typeCapture = async (text, expected) => {
    let nodes = await screen();
    if (!inPopup(nodes)) nodes = await device.openCapture();
    await device.focusAtEnd(tagged(nodes, 'capture-title') ?? fail('no capture field'));
    requireAppFront();
    sh(`input text '${text}'`);
    return waitFor(`"${expected}" in the capture field`, (current) => title(current) === expected, 15_000);
};
const save = async (expected, description) => tapExpecting(button(await screen(), en['common.save']) ?? fail('no Save'), expected, description);
const close = async () => {
    // Settle first: Close moves while the sheet slides with the keyboard.
    const nodes = await device.settle();
    if (inPopup(nodes)) await tapExpecting(withDescription(nodes, en['common.close']) ?? fail('no Close'), onInbox, 'the popup to close');
};
/** The picker's search field (core's picker title is its label while it is empty). */
// The picker's search field. Android puts its label either on the EditText or on a child node inside it
// (run 31: the child [108,1045][972,1142] says "Project", the EditText says nothing).
const pickerField = (nodes) => {
    const within = (inner, outer) => { const [l, t, r, b] = box(outer); const [x1, y1, x2, y2] = box(inner); return l <= x1 && t <= y1 && r >= x2 && b >= y2; };
    const labels = nodes.filter((node) => node['content-desc'] === en['taskEdit.projectLabel']);
    return nodes.find((node) => node.class === 'android.widget.EditText' && labels.some((label) => label === node || within(label, node)));
};
const addAnother = (nodes) => withDescription(nodes, en['quickAdd.addAnother']);
const keyboardShown = () => /mInputShown=true/.test(sh('dumpsys input_method'));
/**
 * The keyboard's own Done key. The field asks for it (imeOptions IME_ACTION_DONE without IME_FLAG_NO_ENTER_ACTION), and the
 * check's keyboard (Samsung Keyboard, en_US, requireEnglishKeyboard) draws it at the bottom right of its keys: 91% across,
 * 77% down the keyboard window below its top inset. A miss leaves the popup open, so the step fails rather than passes.
 */
const tapKeyboardDone = () => {
    const ime = sh('dumpsys input_method');
    const options = [...ime.matchAll(/imeOptions=0x([0-9a-f]+)/g)].map((match) => parseInt(match[1], 16)).filter((value) => value !== 0).pop() ?? 0;
    if ((options & 0xff) !== 6 || (options & 0x40000000) !== 0) fail(`the capture field does not ask the keyboard for Done (imeOptions 0x${options.toString(16)})`);
    const window = sh('dumpsys window windows').split(/\n  Window #/).find((part) => part.includes('InputMethod')) ?? fail('no keyboard window');
    const top = Number(/ frame=\[0,(\d+)\]/.exec(window)?.[1] ?? fail('no keyboard frame')) + Number(/mGivenContentInsets=\[0,(\d+)\]/.exec(window)?.[1] ?? fail('no keyboard insets'));
    const [width, height] = sh('wm size').match(/(\d+)x(\d+)/).slice(1).map(Number);
    sh(`input tap ${Math.round(width * 0.913)} ${Math.round(top + (height - top) * 0.772)}`);
};
/**
 * The Save pill's fill beside its label (inside its 16dp padding) and the sheet's own color at the same height, read from a
 * screenshot with ImageMagick.
 */
const savePill = (nodes, name) => {
    const label = nodes.find((node) => node.text === en['common.save'] && node.class === 'android.widget.TextView') ?? fail('no Save label');
    const [left, top, , bottom] = box(label);
    const y = Math.round((top + bottom) / 2);
    const file = resolve(work, `save-${name}.png`);
    writeFileSync(file, adbRaw('exec-out', 'screencap', '-p'));
    const at = (x) => execFileSync('magick', [file, '-format', `%[hex:p{${x},${y}}]`, 'info:'], { encoding: 'utf8' }).trim().slice(0, 6).toUpperCase();
    return { fill: at(left - 8), sheet: at(8), label };
};
const channels = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
const addAnotherOn = (nodes) => switchOn(nodes, en['quickAdd.addAnother']);

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const restore = async () => {
    for (const name of PROPS) { try { setProp(name, ''); } catch { /* device gone */ } }
    try {
        if (front().includes(`${PKG}/`)) {
            // "Add another" is RN's device preference: leave it off, as a fresh install has it.
            const nodes = await screen();
            if (inPopup(nodes) && addAnotherOn(nodes)) await tapExpecting(addAnother(nodes), (current) => !addAnotherOn(current), 'Add another off', 10_000);
            await close();
        }
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

    // (0) An empty draft: Save is dimmed to half, the whole pill, and inert, as RN's (opacity 0.5, disabled while the text is blank).
    let nodes = await device.settle(await device.openCapture());
    const empty = savePill(nodes, 'empty');
    const saves = commands('quickCapture', 'saved');
    await device.tap(empty.label);
    await sleep(1500);
    nodes = await screen();
    check(inPopup(nodes) && title(nodes) === '' && commands('quickCapture', 'saved') === saves, '(0) a tap on the empty draft\'s Save does nothing');

    // (a) A context and a tag: core's preview shows them, and the stored task is exactly what core stores for this draft.
    const textA = `${titles.a} @c${run} #t${run}`;
    nodes = await typeCapture(textA.replace(/ /g, '%s'), textA);
    const full = savePill(await device.settle(nodes), 'typed');
    const half = channels(full.fill).map((value, i) => (value + channels(empty.sheet)[i]) / 2);
    check(channels(empty.fill).every((value, i) => Math.abs(value - half[i]) <= 4) && full.fill !== empty.fill,
        `(0) the empty draft's Save is half its color over the sheet: #${empty.fill} (full #${full.fill}, sheet #${empty.sheet})`);
    nodes = await waitFor('core\'s preview', (current) => current.some((node) => node.text === `@c${run}`) && current.some((node) => node.text === `#t${run}`), 15_000);
    await save(onInbox, 'the capture to close the popup');
    let seen = core(textA, titles.a);
    check(seen.stored[titles.a].length === 1 && JSON.stringify(seen.stored[titles.a][0]) === JSON.stringify(seen.expected),
        `(a) stored once, exactly as core's popup stores it: ${JSON.stringify(seen.stored[titles.a][0])}`);

    // (b) Add another: the popup stays for the next capture, then the switch goes off again.
    nodes = await device.openCapture();
    await tapExpecting(addAnother(nodes) ?? fail('no Add another switch'), addAnotherOn, 'Add another on');
    await typeCapture(titles.b1, titles.b1);
    // RN keeps the field focused (and the keyboard up) for the next capture.
    const nextCapture = (current) => inPopup(current) && title(current) === '' && tagged(current, 'capture-title')?.focused === 'true';
    await save(nextCapture, 'the popup to stay, empty, the field focused');
    await typeCapture(titles.b2, titles.b2);
    nodes = await save(nextCapture, 'the popup to stay again, the field focused');
    nodes = await device.settle(nodes);
    await tapExpecting(addAnother(nodes), (current) => !addAnotherOn(current), 'Add another off');
    await close();
    seen = core('', titles.b1, titles.b2);
    check(seen.stored[titles.b1].length === 1 && seen.stored[titles.b2].length === 1, '(b) Add another: two captures, each stored once, and the popup stayed between them');

    // (c) More's project picker: search PROJECT; pick it, or create it through the picker's Create row (first run).
    // The stored capture carries that project.
    await typeCapture(titles.c, titles.c);
    const projectChip = `${en['taskEdit.projectLabel']}: ${en['taskEdit.projectLabel']}`;
    nodes = await tapExpecting(withDescription(await screen(), en['common.more']) ?? fail('no More'), (current) => Boolean(withDescription(current, projectChip)), 'More open');
    nodes = await tapExpecting(withDescription(nodes, projectChip), (current) => Boolean(pickerField(current)), 'the project picker');
    await device.focusAtEnd(pickerField(nodes) ?? fail('no project search'));
    requireAppFront();
    sh(`input text '${PROJECT}'`);
    const createRow = `${en['projects.create']}: ${PROJECT}`;
    nodes = await waitFor('the project search', (current) => Boolean(withDescription(current, createRow) ?? withDescription(current, PROJECT)), 15_000);
    const created = Boolean(withDescription(nodes, createRow));
    await tapExpecting(withDescription(nodes, createRow) ?? withDescription(nodes, PROJECT),
        (current) => Boolean(withDescription(current, `${en['taskEdit.projectLabel']}: ${PROJECT}`)), `${PROJECT} ${created ? 'created' : 'picked'}`);
    await save(onInbox, 'the capture to close the popup');
    seen = core('', titles.c);
    check(seen.project && seen.stored[titles.c].length === 1 && seen.stored[titles.c][0].projectId === seen.project,
        `(c) the project ${PROJECT} (${created ? 'created by the picker' : 'picked'}) is stored with the capture`);

    // (d) Two lines: core's question, core's recovery snapshot on disk, one task per line in one write.
    const snapshotsBefore = snapshots();
    const tasksBefore = core('').dataTasks;
    const linesBefore = commands('quickCaptureLines', 'saved');
    // Several lines reach RN's popup only by paste (Enter saves). The debug build puts the check's two lines on the
    // clipboard when the popup opens; the paste key (KEYCODE_PASTE) on the focused field runs the real paste path.
    // (The long-press Paste menu is a floating window uiautomator does not dump; run 35.)
    setProp('clipboard', `${titles.d1}\\n${titles.d2}`);
    nodes = await device.openCapture();
    await sleep(500);
    setProp('clipboard', '');
    await device.focusAtEnd(tagged(nodes, 'capture-title') ?? fail('no capture field'));
    requireAppFront();
    sh('input keyevent KEYCODE_PASTE');
    await waitFor('two lines in the field', (current) => title(current) === `${titles.d1}\n${titles.d2}`, 10_000);
    const confirmTitle = en['quickAdd.bulkConfirmTitle'].replace('{{count}}', '2');
    nodes = await save((current) => current.some((node) => node.text === confirmTitle), 'core\'s several-lines question');
    await tapExpecting(button(nodes, en['quickAdd.bulkConfirmCreate']) ?? fail('no Create tasks'), onInbox, 'the lines to be created');
    seen = core('', titles.d1, titles.d2);
    const written = snapshots().filter((name) => !snapshotsBefore.includes(name));
    check(written.length === 1 && snapshots().length <= 5, `(d) core's recovery snapshot written before the batch (${written[0] ?? 'none'}), at most 5 kept`);
    const snapshotTasks = JSON.parse(sh(`run-as ${PKG} cat files/snapshots/${written[0]}`)).tasks?.length;
    check(snapshotTasks === tasksBefore, `(d) the snapshot parses and holds the ${tasksBefore} tasks the data had before the batch (it holds ${snapshotTasks})`);
    check(seen.stored[titles.d1].length === 1 && seen.stored[titles.d2].length === 1 && commands('quickCaptureLines', 'saved') === linesBefore + 1,
        '(d) one task per line, in one write');

    // (e) An unreadable date command: core's notice, nothing stored, the draft stays.
    const textE = `${titles.e} /due:${run}x`;
    await typeCapture(textE.replace(/ /g, '%s'), textE);
    nodes = await save((current) => current.some((node) => node.text?.startsWith(en['quickAdd.invalidDateCommand'])), 'core\'s invalid date notice');
    check(title(nodes) === textE && core('', titles.e).stored[titles.e].length === 0, '(e) the notice shows, nothing is stored, and the draft stays');
    await close();

    // (f) A failed commit keeps its exact retry; Try again stores it once.
    setProp('fail_commit', '1');
    await typeCapture(titles.f, titles.f);
    nodes = await save(hasError, 'the injected failure');
    check(tagged(nodes, 'capture-title')?.enabled === 'false' && owedRetry(nodes)?.enabled === 'true', '(f) the draft is locked and Try again offers the exact retry');
    check(core('', titles.f).stored[titles.f].length === 0, '(f) the failed commit stored nothing');
    setProp('fail_commit', '');
    await tapExpecting(owedRetry(await screen()), (current) => !hasError(current) && onInbox(current), 'the retry from Try again');
    check(core('', titles.f).stored[titles.f].length === 1 && commands('quickCapture', 'failed') >= 1, '(f) Try again stored the capture once');

    // (g) Save & edit goes where RN's openTaskScreen goes: a task with no project to Focus, with its editor open there.
    await typeCapture(titles.g, titles.g);
    nodes = await tapExpecting(button(await screen(), en['quickAdd.saveAndEdit']) ?? fail('no Save & edit'), (current) => inEditor(current), 'the saved task\'s editor');
    nodes = await tapExpecting(withDescription(nodes, en['common.close']) ?? fail('no Close in the editor'),
        (current) => !inEditor(current) && tabSelected(current, en['tab.next']), 'Focus under the editor');
    check(core('', titles.g).stored[titles.g].length === 1, '(g) Save & edit stored the capture once and opened its editor over Focus');
    await tapExpecting(tab(nodes, en['tab.inbox']) ?? fail('no Inbox tab'), onInbox, 'the Inbox again');

    // (h) The keyboard's Done key saves the popup, as Save does: the popup closes and the title is stored once, with no line.
    await typeCapture(titles.h, titles.h);
    for (let wait = 0; wait < 15 && !keyboardShown(); wait += 1) await sleep(200);
    check(keyboardShown(), '(h) the keyboard is up for the typed capture');
    tapKeyboardDone();
    await waitFor('the popup to close on the keyboard\'s Done', onInbox, 15_000);
    check(core('', titles.h).stored[titles.h].length === 1, '(h) the keyboard\'s Done key stored the capture once, its title without a line');

    // (i) More with the keyboard up: the keyboard goes first, then the panel opens with the field still on screen above it.
    await typeCapture(titles.i, titles.i);
    for (let wait = 0; wait < 15 && !keyboardShown(); wait += 1) await sleep(200);
    check(keyboardShown(), '(i) the keyboard is up before More');
    nodes = await tapExpecting(withDescription(await screen(), en['common.more']) ?? fail('no More'), (current) => Boolean(withDescription(current, projectChip)), 'More open');
    nodes = await device.settle(nodes);
    const [screenWidth, screenHeight] = sh('wm size').match(/(\d+)x(\d+)/).slice(1).map(Number);
    const [, fieldTop, , fieldBottom] = box(tagged(nodes, 'capture-title') ?? fail('no capture field with More open'));
    const [, chipTop] = box(withDescription(nodes, projectChip));
    check(!keyboardShown() && fieldTop >= 0 && fieldBottom <= chipTop && fieldBottom <= screenHeight && screenWidth > 0,
        `(i) More waited for the keyboard: it is down, and the field [${fieldTop},${fieldBottom}] sits on screen above the panel (${chipTop})`);
    check(title(nodes) === titles.i, '(i) the typed title is kept');
    await save(onInbox, 'the capture to close the popup');
    check(core('', titles.i).stored[titles.i].length === 1, '(i) the capture typed before More is stored once');
    console.log('Capture device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
