


import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, button, check, connect, evidenced, fail, hasText, inboxCount, inEditor, inList, projectTitled, Stopped, tab, tabSelected, tagged, taskRow, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-backdate-device.mjs <adb-serial> [apk]');
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
const DB = 'mindwtr-native-dev.db';
const work = resolve(app, 'android/build/backdate-check');
const { en } = await import(resolve(app, '../../packages/core/src/i18n/locales/en.ts'));

const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const title = `63${run}`;
const archivedTitle = `65${run}`;

const PROJECT = `BD${run}`;
const projectTask = `64${run}`;
const LOG_LINE = 'Native completion time saved';

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting } = device;


const stored = (name = title) => {
    const dir = resolve(work, 'db');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = sh(`run-as ${PKG} ls files`).split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    const rows = JSON.parse(execFileSync('sqlite3', ['-json', resolve(dir, DB),
        `SELECT status, completedAt, rev, projectId FROM tasks WHERE title = '${name}' AND deletedAt IS NULL`], { encoding: 'utf8' }) || '[]');
    return rows.length === 1 ? rows[0] : fail(`expected one stored task ${name}, found ${rows.length}`);
};

const archiveDays = () => {
    const [row] = JSON.parse(execFileSync('sqlite3', ['-json', resolve(work, 'db', DB), 'SELECT data FROM settings WHERE id = 1'], { encoding: 'utf8' }) || '[]');
    const configured = row ? JSON.parse(row.data).gtd?.autoArchiveDays : undefined;
    return Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : 7;
};

const pastArchiveWindow = (iso) => {
    const days = archiveDays();
    return Date.parse(iso) < Date.now() - days * 86_400_000
        || fail(`${iso} is inside the ${days}-day auto-archive window, so core's #959 archive rule cannot run; set Settings > Archive after to 7 days`);
};

const localDay = (iso) => { const d = new Date(iso); return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), whole: d.getSeconds() === 0 && d.getMilliseconds() === 0 }; };
const monthBefore = ({ y, m }) => (m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 });
const saves = () => device.logs(pid(), TAG).split('\n').filter((line) => line.includes(LOG_LINE)).length;


const inPopup = (nodes) => Boolean(tagged(nodes, 'quick-capture'));
const sheetOpen = (nodes) => Boolean(tagged(nodes, 'more-sheet'));
const onInbox = (nodes) => !inPopup(nodes) && !tagged(nodes, 'menu-screen') && !inEditor(nodes) && Number.isFinite(inboxCount(nodes));
const inHistory = (nodes) => Boolean(tagged(nodes, 'menu-screen')) && hasText(nodes, en['nav.history']);
const center = (node) => { const [l, t, r, b] = box(node); return [Math.round((l + r) / 2), Math.round((t + b) / 2)]; };
const longPress = (node) => {
    requireAppFront();
    const [x, y] = center(node);
    sh(`input swipe ${x} ${y} ${x} ${y} 1000`);
};

const okButton = (nodes) => nodes.find((node) => node['resource-id'] === 'android:id/button1');
const prevMonth = (nodes) => nodes.find((node) => /previous month/i.test(node['content-desc'] ?? '') || /(^|\/)prev$/.test(node['resource-id'] ?? ''));
const nextMonth = (nodes) => nodes.find((node) => /next month/i.test(node['content-desc'] ?? '') || /(^|\/)next$/.test(node['resource-id'] ?? ''));
const inDateDialog = (nodes) => Boolean(okButton(nodes)) && Boolean(prevMonth(nodes));
const inTimeDialog = (nodes) => Boolean(okButton(nodes)) && !prevMonth(nodes)
    && nodes.some((node) => /TimePicker|NumberPicker/.test(node.class ?? '') || /(^|\/)(timePicker|hours|hour|minutes|minute)$/.test(node['resource-id'] ?? ''));
const dayCell = (nodes, day) => nodes.find((node) => node.text === String(day) && node.class !== 'android.widget.EditText')
    ?? nodes.find((node) => new RegExp(`^0?${day}\\b`).test(node['content-desc'] ?? ''));

const pickDay = async (day, forward = false) => {
    let nodes = await waitFor('the date dialog', inDateDialog, 15_000);
    await tap((forward ? nextMonth(nodes) : prevMonth(nodes)) ?? fail(`no ${forward ? 'next' : 'previous'} month in the date dialog`));
    await sleep(800);
    nodes = await screen();
    await tap(dayCell(nodes, day) ?? fail(`no day ${day} in the date dialog`));
    await sleep(500);
    await tap(okButton(await screen()) ?? fail('no OK in the date dialog'));
    nodes = await waitFor('the time dialog', inTimeDialog, 15_000);
    await tapExpecting(okButton(nodes), (current) => !okButton(current), 'the time dialog to close');
};


const capture = async (text = title, shown = text) => {
    let nodes = await screen();
    if (!inPopup(nodes)) nodes = await device.openCapture();
    await device.focusAtEnd(tagged(nodes, 'capture-title') ?? fail('no capture field'));
    requireAppFront();
    sh(`input text '${text}'`);
    await waitFor(`"${shown}" in the capture field`, (current) => tagged(current, 'capture-title')?.text === shown, 15_000);
    await tapExpecting(button(await screen(), en['common.save']) ?? fail('no Save'), onInbox, 'the capture to close the popup');
};
const completeOnFifteenth = async (name) => {
    const before = stored(name);
    const nodes = await device.reveal(name);
    longPress(await device.revealAction(nodes, name));
    const doneItem = (current) => hasText(current, en['taskStatus.changeStatus'])
        ? current.find((node) => node.text === en['status.done'] && node.class !== 'android.widget.EditText') : undefined;
    longPress(doneItem(await waitFor('the status menu', (current) => Boolean(doneItem(current)), 10_000)));
    await pickDay(15);
    let done = stored(name);
    for (const deadline = Date.now() + 15_000; done.status !== 'done' && Date.now() < deadline; await sleep(700)) done = stored(name);
    await waitFor(`the row ${name} to leave the Inbox`, (current) => onInbox(current) && !taskRow(current, name), 15_000);
    return { before, done };
};
const tapCompletedDate = (nodes, name) => {
    const [left, , , bottom] = box(taskRow(nodes, name) ?? fail(`no row ${name} on screen`));
    requireAppFront();
    sh(`input tap ${left + 60} ${bottom + 24}`);
};
const openHistoryDone = async () => {
    let nodes = await screen();
    nodes = await tapExpecting(tab(nodes, en['tab.menu']) ?? fail('no Menu tab'), sheetOpen, 'the More sheet');
    nodes = await device.settle(nodes);
    nodes = await tapExpecting(withDescription(nodes, en['nav.history']) ?? fail('no History tile'), inHistory, 'History');
    if (!tabSelected(nodes, en['nav.done'])) nodes = await tapExpecting(tab(nodes, en['nav.done']), (current) => tabSelected(current, en['nav.done']), 'the Done tab');
    await device.reveal(title);
    return waitFor(`the done row ${title}`, (current) => Boolean(taskRow(current, title)), 20_000);
};

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const restore = async () => {
    try {
        for (let step = 0; step < 5 && front().includes(`${PKG}/`); step += 1) {
            const nodes = await screen();
            if (onInbox(nodes)) break;
            sh('input keyevent KEYCODE_BACK');
            await sleep(800);
        }
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
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    device.launch(ACTIVITY);
    requireAppFront();
    sh('settings put system accelerometer_rotation 0');
    sh('settings put system user_rotation 0');
    await waitFor('the Inbox', onInbox, 60_000);
    await capture();
    await capture(archivedTitle);
    await capture(`${projectTask}%s/next%s+${PROJECT}`, `${projectTask} /next +${PROJECT}`);
    const captured = stored();
    const archivedCaptured = stored(archivedTitle);
    check(archivedCaptured.status === 'inbox' && !archivedCaptured.completedAt, `the capture ${archivedTitle} is stored in Inbox, not done`);
    const days = archiveDays();
    check(days > 0, `the dev data's auto-archive window is ${days} days, so core's #959 archive rule can run`);
    const projectCaptured = stored(projectTask);
    check(projectCaptured.status === 'next' && Boolean(projectCaptured.projectId), `the capture ${projectTask} is a Next task in the new project ${PROJECT}`);
    check(captured.status === 'inbox' && !captured.completedAt, `the capture ${title} is stored in Inbox, not done`);
    const today = localDay(new Date().toISOString());


    const logsBefore = saves();
    const { done } = await completeOnFifteenth(title);
    const doneDay = localDay(done.completedAt ?? new Date(0).toISOString());
    const wantA = monthBefore(today);
    check(done.status === 'done' && doneDay.y === wantA.y && doneDay.m === wantA.m && doneDay.d === 15 && doneDay.whole
        && done.rev === captured.rev + 1,
        `(a) Done at the picked time: stored done at ${done.completedAt} (the 15th of month ${wantA.m + 1}, whole minute), one write`);
    console.log(`note - "${LOG_LINE}" lines in logcat: ${saves() - logsBefore} after (a)`);
    const second = await completeOnFifteenth(archivedTitle);
    check(second.done.status === 'done' && localDay(second.done.completedAt).m === wantA.m && localDay(second.done.completedAt).d === 15
        && second.done.rev === second.before.rev + 1,
        `(b2 setup) ${archivedTitle} is stored done at ${second.done.completedAt} (the 15th of month ${wantA.m + 1}), one write`);


    let nodes = await openHistoryDone();
    tapCompletedDate(nodes, title);
    await pickDay(today.d, true);
    let edited = stored();
    for (const deadline = Date.now() + 15_000; edited.rev === done.rev && Date.now() < deadline; await sleep(700)) edited = stored();
    const editedDay = localDay(edited.completedAt);
    check(edited.status === 'done' && editedDay.y === today.y && editedDay.m === today.m && editedDay.d === today.d && editedDay.whole

        && new Date(edited.completedAt).toTimeString().slice(0, 5) === new Date(done.completedAt).toTimeString().slice(0, 5) && edited.rev === done.rev + 1,
        `(b) the done row's date moved its completion time to today, ${edited.completedAt}, at the same minute, and kept it done, one write`
        + ` (stored ${JSON.stringify(edited)}, before ${JSON.stringify(done)})`);


    const wantB2 = monthBefore(wantA);
    await device.reveal(archivedTitle);
    tapCompletedDate(await waitFor(`the done row ${archivedTitle}`, (current) => Boolean(taskRow(current, archivedTitle)), 15_000), archivedTitle);
    await pickDay(1);
    let archived = stored(archivedTitle);
    for (const deadline = Date.now() + 15_000; archived.rev === second.done.rev && Date.now() < deadline; await sleep(700)) archived = stored(archivedTitle);
    const archivedDay = localDay(archived.completedAt);
    pastArchiveWindow(archived.completedAt);
    check(archived.status === 'archived' && archivedDay.y === wantB2.y && archivedDay.m === wantB2.m && archivedDay.d === 1 && archivedDay.whole
        && archived.rev === second.done.rev + 1,
        `(b2) the done row's date moved ${archivedTitle} to ${archived.completedAt} (the 1st of month ${wantB2.m + 1}), past the ${days}-day window,`
        + ` and archived it in one write, as RN's updateTask does (#959) (stored ${JSON.stringify(archived)}, before ${JSON.stringify(second.done)})`);
    await waitFor(`the row ${archivedTitle} to leave History > Done`, (current) => tabSelected(current, en['nav.done']) && !taskRow(current, archivedTitle), 15_000);
    nodes = await device.reveal(archivedTitle);
    check(tabSelected(nodes, en['nav.done']) && !inList(nodes, archivedTitle), `(b2) ${archivedTitle} is gone from History > Done`);
    nodes = await tapExpecting(tab(nodes, en['nav.archived']) ?? fail('no Archived tab'), (current) => tabSelected(current, en['nav.archived']), 'the Archived tab');
    nodes = await device.reveal(archivedTitle);
    check(tabSelected(nodes, en['nav.archived']) && Boolean(inList(nodes, archivedTitle)), `(b2) ${archivedTitle} shows on History > Archived`);
    await tapExpecting(tab(nodes, en['nav.done']) ?? fail('no Done tab'), (current) => tabSelected(current, en['nav.done']), 'the Done tab');


    await device.reveal(title);
    nodes = await waitFor(`the row ${title} again`, (current) => Boolean(taskRow(current, title)), 15_000);
    nodes = await tapExpecting(taskRow(nodes, title), inEditor, 'the editor');
    const badgeLabel = en['task.aria.changeStatus'].replace('{{status}}', en['status.done']);
    if (!withDescription(nodes, badgeLabel)) {
        nodes = await tapExpecting(withDescription(nodes, en['taskEdit.tab.view']) ?? tab(nodes, en['taskEdit.tab.view']) ?? fail('no View tab'),
            (current) => Boolean(withDescription(current, badgeLabel)), 'the View tab\'s Done badge');
    }
    longPress(withDescription(nodes, badgeLabel));

    await pickDay(5);
    check(stored().completedAt === edited.completedAt, '(c) the editor\'s pick changed only the draft');
    nodes = await waitFor('Save enabled', (current) => button(current, en['common.save'])?.enabled === 'true', 10_000);
    await tapExpecting(button(nodes, en['common.save']), (current) => !inEditor(current), 'the editor to save and close');
    let saved = stored();
    for (const deadline = Date.now() + 15_000; localDay(saved.completedAt).d !== 5 && Date.now() < deadline; await sleep(700)) saved = stored();
    const savedDay = localDay(saved.completedAt);


    pastArchiveWindow(saved.completedAt);
    check(saved.status === 'archived' && savedDay.y === wantA.y && savedDay.m === wantA.m && savedDay.d === 5 && savedDay.whole && saved.rev === edited.rev + 1,
        `(c) the editor's Save stored the picked completion ${saved.completedAt} (the 5th of month ${wantA.m + 1}) in one write, ${saved.status}`
        + ` as core's ${days}-day auto-archive rule says (archived)`);
    console.log(`note - "${LOG_LINE}" lines in logcat: ${saves() - logsBefore} after (a) and (b)`);


    for (let step = 0; step < 6; step += 1) {
        nodes = await screen();
        if (tab(nodes, en['nav.projects']) && !tagged(nodes, 'menu-screen') && !inEditor(nodes) && !sheetOpen(nodes)) break;
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(900);
    }
    nodes = await tapExpecting(tab(await screen(), en['nav.projects']) ?? fail('no Projects tab'), (current) => tabSelected(current, en['nav.projects']), 'the Projects tab');
    nodes = await device.reveal(PROJECT);
    nodes = await tapExpecting(nodes.find((node) => node.text === PROJECT) ?? fail(`no project ${PROJECT}`), (current) => projectTitled(current, PROJECT) && !inEditor(current),
        `the project ${PROJECT}`, 30_000);
    nodes = await device.reveal(projectTask);
    const trayDone = await device.revealAction(nodes, projectTask);
    longPress(trayDone);
    await pickDay(15);
    const prompted = (current) => Boolean(tagged(current, 'next-action-prompt'));
    nodes = await waitFor('the project next-action prompt', prompted, 20_000);
    const projectDone = stored(projectTask);
    check(projectDone.status === 'done' && localDay(projectDone.completedAt).d === 15 && localDay(projectDone.completedAt).m === wantA.m,
        `(d) the project's only Next task is stored done at the picked ${projectDone.completedAt}, and RN's next-action prompt shows`);
    await tapExpecting(tagged(nodes, 'next-action-skip') ?? fail('no Skip in the prompt'), (current) => !prompted(current), 'Skip to close the prompt');
    check(true, '(d) Skip closes the prompt');
    console.log('Backdated completion device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
