import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, button, check, connect, EDGE_SAFE_X, evidenced, fail, hasText, inboxCount, inEditor, Stopped, tab, tabSelected, tagged, taskRow } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-swipe-tray-device.mjs <adb-serial> [apk]');
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
const UI_FILE = '/data/local/tmp/mindwtr-native-dev-ui.xml';
const DB = 'mindwtr-native-dev.db';
const work = resolve(app, 'android/build/swipe-tray-check');
const shots = process.env.MINDWTR_SHOTS ?? work;
const { en } = await import(resolve(app, '../../packages/core/src/i18n/locales/en.ts'));
const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const T = { focus: `81${run}`, organize: `82${run}`, dates: `83${run}`, trash: `84${run}`, done: `85${run}`, backdate: `86${run}` };

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { adbRaw, sh, home, front, requireAppFront, screen, waitFor, tap, tapExpecting } = device;

const stored = (name) => {
    const dir = resolve(work, 'db');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = sh(`run-as ${PKG} ls files`).split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    const rows = JSON.parse(execFileSync('sqlite3', ['-json', resolve(dir, DB),
        `SELECT status, startTime, dueDate, isFocusedToday, completedAt, deletedAt, rev FROM tasks WHERE title = '${name}'`], { encoding: 'utf8' }) || '[]');
    return rows.length === 1 ? rows[0] : fail(`expected one stored task ${name}, found ${rows.length}`);
};
const storedWhen = async (name, done, ms = 15_000) => {
    let row = stored(name);
    for (const deadline = Date.now() + ms; !done(row) && Date.now() < deadline; await sleep(700)) row = stored(name);
    return row;
};
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const inPopup = (nodes) => Boolean(tagged(nodes, 'quick-capture'));
const onInbox = (nodes) => !inPopup(nodes) && !tagged(nodes, 'menu-screen') && !inEditor(nodes) && Number.isFinite(inboxCount(nodes));
const trayButtons = (nodes) => nodes.filter((node) => /swipe-\w+$/.test(node['resource-id'] ?? ''))
    .sort((a, b) => box(a)[0] - box(b)[0]).map((node) => (node['resource-id'] ?? '').split('swipe-').pop());
const center = (node) => { const [l, t, r, b] = box(node); return [Math.round((l + r) / 2), Math.round((t + b) / 2)]; };
const longPress = (node) => {
    requireAppFront();
    const [x, y] = center(node);
    sh(`input swipe ${x} ${y} ${x} ${y} 1000`);
};
const okButton = (nodes) => nodes.find((node) => node['resource-id'] === 'android:id/button1');
const shoot = async (name) => {
    await sleep(900);
    requireAppFront();
    writeFileSync(resolve(shots, `${name}.png`), adbRaw('exec-out', 'screencap', '-p'));
    console.log(`shot - ${name}.png`);
};
const shut = async (title, side) => {
    const row = taskRow(await screen(), title) ?? fail(`no row ${title} on screen`);
    const [x1, y1, x2, y2] = box(row);
    const y = Math.round((y1 + y2) / 2);
    const from = Math.round((x1 + x2) / 2);
    requireAppFront();
    if (side === 'right') sh(`input swipe ${from} ${y} ${Math.max(from - 440, EDGE_SAFE_X)} ${y} 300`);
    else sh(`input tap ${from} ${y}`);
    const nodes = await waitFor('the tray to shut', (current) => trayButtons(current).length === 0, 8_000);
    if (side === 'left') check(onInbox(nodes) && Boolean(taskRow(nodes, title)), `a tap on ${title}'s open row shuts the tray and opens nothing, as RN's Swipeable does`);
};
const capture = async (text) => {
    let nodes = await screen();
    if (!inPopup(nodes)) nodes = await device.openCapture();
    await device.focusAtEnd(tagged(nodes, 'capture-title') ?? fail('no capture field'));
    requireAppFront();
    sh(`input text '${text}'`);
    await waitFor(`"${text}" in the capture field`, (current) => tagged(current, 'capture-title')?.text === text, 15_000);
    await tapExpecting(button(await screen(), en['common.save']) ?? fail('no Save'), onInbox, 'the capture to close the popup');
};
const showTab = async (name) => {
    const nodes = await waitFor('the tabs', (current) => tab(current, name), 60_000);
    if (tabSelected(nodes, name)) return;
    await tapExpecting(tab(nodes, name), (current) => tabSelected(current, name), `the ${name} tab`, 10_000);
};
const undoShown = (nodes) => hasText(nodes, en['common.undo']);
const datesOpen = (nodes) => Boolean(tagged(nodes, 'dates-sheet'));

const originalNight = /Night mode: (\w+)/.exec(sh('cmd uimode night'))?.[1] ?? 'auto';
const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const setNight = async (mode) => {
    sh(`cmd uimode night ${mode}`);
    await sleep(3000);
};
const restore = async () => {
    try {
        for (let step = 0; step < 5 && front().includes(`${PKG}/`); step += 1) {
            const nodes = await screen();
            if (onInbox(nodes)) break;
            sh('input keyevent KEYCODE_BACK');
            await sleep(800);
        }
    } catch { }
    try { sh(`cmd uimode night ${['yes', 'no', 'auto'].includes(originalNight) ? originalNight : 'auto'}`); } catch { }
    for (const [name, value] of [['user_rotation', originalRotation], ['accelerometer_rotation', originalAccelerometer]]) {
        try { sh(value === 'null' ? `settings delete system ${name}` : `settings put system ${name} ${value}`); } catch { }
    }
    try { sh(`rm -f ${UI_FILE}`); } catch { }
};

try {
    mkdirSync(work, { recursive: true });
    mkdirSync(shots, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    sh('cmd uimode night no');
    device.launch(ACTIVITY);
    requireAppFront();
    sh('settings put system accelerometer_rotation 0');
    sh('settings put system user_rotation 0');
    await waitFor('the Inbox', onInbox, 60_000);
    for (const title of Object.values(T)) await capture(title);
    for (const title of Object.values(T)) check(stored(title).status === 'inbox', `the capture ${title} is stored in Inbox`);

    let nodes = await device.reveal(T.focus);
    await device.revealAction(nodes, T.focus, 'done');
    nodes = await screen();
    check(trayButtons(nodes).join(',') === 'done,focus' && hasText(nodes, en['common.done']) && hasText(nodes, en['digest.focus']),
        `(a) a swipe right shows Done, Focus (got ${trayButtons(nodes).join(',')})`);
    await shoot('swipe-tray-right-light');
    await shut(T.focus, 'right');
    await device.revealAction(await screen(), T.focus, 'delete');
    nodes = await screen();
    check(trayButtons(nodes).join(',') === 'organize,dates,delete' && hasText(nodes, en['nav.sectionOrganize']) && hasText(nodes, en['task.dates'])
        && hasText(nodes, en['common.delete']), `(a) a swipe left shows Organize, Dates…, Delete (got ${trayButtons(nodes).join(',')})`);
    await shoot('swipe-tray-left-light');
    await shut(T.focus, 'left');

    const focusBefore = stored(T.focus);
    await tap(await device.revealAction(await screen(), T.focus, 'focus'));
    const focused = await storedWhen(T.focus, (row) => row.isFocusedToday === 1);
    check(focused.isFocusedToday === 1 && focused.status === 'next' && focused.rev === focusBefore.rev + 1,
        `(b) Focus starred the Inbox task and made it Next in one write (stored ${JSON.stringify(focused)})`);

    await showTab('Focus');
    nodes = await device.reveal(T.focus);
    await device.revealAction(nodes, T.focus, 'focus');
    nodes = await screen();
    check(hasText(nodes, en['agenda.removeFromFocus']), '(c) a starred row\'s Focus reads Remove from focus');
    await shoot('swipe-tray-focused-light');
    await tap(nodes.find((node) => (node['resource-id'] ?? '').endsWith('swipe-focus')) ?? fail('no Focus button'));
    const unfocused = await storedWhen(T.focus, (row) => !row.isFocusedToday);
    check(!unfocused.isFocusedToday && unfocused.status === 'next' && unfocused.rev === focused.rev + 1, `(c) Remove from focus unstarred it in one write`);
    await showTab('Inbox');
    await waitFor('the Inbox', onInbox, 20_000);

    const organizeBefore = stored(T.organize);
    nodes = await device.reveal(T.organize);
    await tap(await device.revealAction(nodes, T.organize, 'organize'));
    await waitFor('the status menu', (current) => hasText(current, en['taskStatus.changeStatus']), 10_000);
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await waitFor('the status menu to close', (current) => !hasText(current, en['taskStatus.changeStatus']), 10_000);
    check(stored(T.organize).rev === organizeBefore.rev, '(d) Organize opened the status menu; Back stored nothing');

    const datesBefore = stored(T.dates);
    nodes = await device.reveal(T.dates);
    await tap(await device.revealAction(nodes, T.dates, 'dates'));
    nodes = await waitFor('the Dates sheet', datesOpen, 10_000);
    check(hasText(nodes, en['filters.taskDates']) && tagged(nodes, 'dates-startTime') && tagged(nodes, 'dates-dueDate'),
        '(e) Dates… opens the Task dates sheet with Start and Due');
    await shoot('swipe-tray-dates-light');
    const startTomorrow = `${en['taskEdit.startDateLabel']}: ${en['quickDate.tomorrow']}`;
    const chip = (current) => current.find((node) => node['content-desc'] === startTomorrow);
    await tap(chip(nodes) ?? fail(`no "${startTomorrow}" chip`));
    await waitFor('Tomorrow chosen', (current) => chip(current)?.selected === 'true', 10_000);
    check(stored(T.dates).rev === datesBefore.rev, '(e) a quick date changes only the sheet');
    await tapExpecting(tagged(await screen(), 'dates-save') ?? fail('no Save'), (current) => !datesOpen(current), 'the sheet to save and close');
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dated = await storedWhen(T.dates, (row) => Boolean(row.startTime));
    check(String(dated.startTime ?? '').startsWith(dayOf(tomorrow)) && dated.status === 'next' && dated.rev === datesBefore.rev + 1,
        `(e) Save stored the start ${dated.startTime} (tomorrow, ${dayOf(tomorrow)}) and made the task Next in one write`);

    nodes = await device.reveal(T.trash);
    await tap(await device.revealAction(nodes, T.trash, 'delete'));
    const trashed = await storedWhen(T.trash, (row) => Boolean(row.deletedAt));
    check(Boolean(trashed.deletedAt), '(f) Delete moved the task to Trash');
    nodes = await waitFor('the Undo toast', undoShown, 10_000);
    await tap(nodes.find((node) => node.text === en['common.undo']));
    const back = await storedWhen(T.trash, (row) => !row.deletedAt);
    check(!back.deletedAt && back.status === 'inbox', '(f) the toast\'s Undo restored it to the Inbox');

    nodes = await device.reveal(T.done);
    await tap(await device.revealAction(nodes, T.done, 'done'));
    const done = await storedWhen(T.done, (row) => row.status === 'done');
    check(done.status === 'done' && Boolean(done.completedAt), '(g) Done completed the task');
    await waitFor('the Done toast\'s Undo', undoShown, 10_000);
    check(true, '(g) RN\'s Undo toast shows');

    nodes = await device.reveal(T.backdate);
    longPress(await device.revealAction(nodes, T.backdate, 'done'));
    nodes = await waitFor('the date dialog', (current) => Boolean(okButton(current)), 15_000);
    await tap(okButton(nodes));
    await sleep(800);
    nodes = await waitFor('the time dialog', (current) => Boolean(okButton(current)), 15_000);
    await tapExpecting(okButton(nodes), (current) => !okButton(current), 'the time dialog to close');
    const backdated = await storedWhen(T.backdate, (row) => row.status === 'done');
    const at = new Date(backdated.completedAt ?? 0);
    check(backdated.status === 'done' && at.getSeconds() === 0 && at.getMilliseconds() === 0,
        `(h) the long-press on the tray's Done completed it at the picked minute ${backdated.completedAt}`);

    await waitFor('the Inbox', onInbox, 20_000);
    await setNight('yes');
    await waitFor('the Inbox (dark)', onInbox, 30_000);
    nodes = await device.reveal(T.organize);
    await device.revealAction(nodes, T.organize, 'done');
    await shoot('swipe-tray-right-dark');
    await shut(T.organize, 'right');
    await device.revealAction(await screen(), T.organize, 'delete');
    await shoot('swipe-tray-left-dark');
    await shut(T.organize, 'left');
    await tap(await device.revealAction(await screen(), T.organize, 'dates'));
    await waitFor('the Dates sheet (dark)', datesOpen, 10_000);
    await shoot('swipe-tray-dates-dark');
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await waitFor('the sheet to close', (current) => !datesOpen(current), 10_000);
    check(stored(T.organize).rev === organizeBefore.rev, 'the dark Dates sheet closed with Back, nothing stored');
    console.log('Swipe tray device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
