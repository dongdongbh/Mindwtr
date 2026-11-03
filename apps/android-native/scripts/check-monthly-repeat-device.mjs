import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { button, check, chipOn, connect, evidenced, fail, hasText, inboxCount, inEditor, inList, isOn, Stopped, tagged, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-monthly-repeat-device.mjs <adb-serial> [apk]');
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
const work = resolve(app, 'android/build/monthly-repeat-check');
const { en } = await import(resolve(app, '../../packages/core/src/i18n/locales/en.ts'));
const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const LOG_LINE = 'Monthly weekday recurrence advanced';

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting } = device;

const stored = (name) => {
    const dir = resolve(work, 'db');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = sh(`run-as ${PKG} ls files`).split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    return JSON.parse(execFileSync('sqlite3', ['-json', resolve(dir, DB),
        `SELECT id, status, dueDate, recurrence, rev FROM tasks WHERE title = '${name}' AND deletedAt IS NULL ORDER BY createdAt`], { encoding: 'utf8' }) || '[]')
        .map((row) => ({ ...row, recurrence: row.recurrence ? JSON.parse(row.recurrence) : null }));
};
const storedUntil = async (name, done, what) => {
    let rows = stored(name);
    for (const deadline = Date.now() + 15_000; !done(rows) && Date.now() < deadline; await sleep(700)) rows = stored(name);
    return done(rows) ? rows : fail(`${what} (stored ${JSON.stringify(rows)})`);
};
const advanced = () => device.logs(pid(), TAG).split('\n').filter((line) => line.includes(LOG_LINE)).length;

const inPopup = (nodes) => Boolean(tagged(nodes, 'quick-capture'));
const onInbox = (nodes) => !inPopup(nodes) && !tagged(nodes, 'menu-screen') && !inEditor(nodes) && Number.isFinite(inboxCount(nodes));
const dialogOpen = (nodes) => Boolean(tagged(nodes, 'monthly-custom'));
const shows = (nodes, words) => hasText(nodes, words) || Boolean(withDescription(nodes, words));
const monthly = `${en['taskEdit.recurrenceLabel']}: ${en['recurrence.monthly']}`;
const statusDone = `${en['taskEdit.statusLabel']}: ${en['status.done']}`;
const visible = (node) => (node && node.bounds !== '[0,0][0,0]' ? node : undefined);

const capture = async (text, shown) => {
    let nodes = await screen();
    if (!inPopup(nodes)) nodes = await device.openCapture();
    await device.focusAtEnd(tagged(nodes, 'capture-title') ?? fail('no capture field'));
    requireAppFront();
    sh(`input text '${text}'`);
    await waitFor(`"${shown}" in the capture field`, (current) => tagged(current, 'capture-title')?.text === shown, 15_000);
    await tapExpecting(button(await screen(), en['common.save']) ?? fail('no Save'), onInbox, 'the capture to close the popup');
};
const openEditor = async (title) => {
    const nodes = await device.reveal(title, 400);
    return tapExpecting(inList(nodes, title) ?? fail(`row ${title} is not in the Inbox`), inEditor, `the editor for ${title}`);
};
const findDescribed = async (nodes, description) => {
    const search = async (current) => {
        for (let step = 0; step < 8 && !visible(withDescription(current, description)); step += 1) current = await device.swipe(current, 'down');
        return current;
    };
    nodes = await search(nodes);
    if (!visible(withDescription(nodes, description))) {
        await tap(await device.revealNode((current) => visible(withDescription(current, en['taskEdit.scheduling'])), 'the Scheduling header'));
        await sleep(600);
        nodes = await search(await screen());
    }
    return [nodes, visible(withDescription(nodes, description)) ?? fail(`no control announced "${description}" in the editor`)];
};
const saveEditor = async () => {
    const nodes = await waitFor('Save enabled', (current) => button(current, en['common.save'])?.enabled === 'true', 10_000);
    await tapExpecting(button(nodes, en['common.save']), (current) => !inEditor(current), 'the editor to save and close');
};
const rotate = async (rotation) => {
    sh(`settings put system user_rotation ${rotation}`);
    await sleep(2_500);
};

const chooseNth = async (ordinal, weekday, label, rotateFirst = false) => {
    let nodes = await tapExpecting(tagged(await screen(), 'monthly-custom-mode-nth') ?? fail('no "The {ordinal} {weekday}" chip'),
        (current) => Boolean(tagged(current, `monthly-custom-ordinal-${ordinal}`)), 'the ordinal buttons');
    await tap(tagged(nodes, `monthly-custom-ordinal-${ordinal}`));
    await sleep(400);
    nodes = await screen();
    nodes = await tapExpecting(tagged(nodes, `monthly-custom-weekday-${weekday}`) ?? fail(`no ${weekday} button`),
        (current) => shows(current, label), `the chip to read "${label}"`);
    check(isOn(tagged(nodes, `monthly-custom-weekday-${weekday}`)) && isOn(tagged(nodes, `monthly-custom-ordinal-${ordinal}`)),
        `the dialog marks ${ordinal} and ${weekday}, and its chip reads "${label}"`);
    if (rotateFirst) {
        await rotate(1);
        nodes = await waitFor('the dialog after rotating', (current) => dialogOpen(current) && shows(current, label), 15_000);
        check(true, `the open dialog keeps "${label}" across a rotation`);
        await rotate(0);
        nodes = await waitFor('the dialog after rotating back', (current) => dialogOpen(current) && shows(current, label), 15_000);
    }
    await tapExpecting(visible(tagged(nodes, 'monthly-custom-save')) ?? fail('no Save in the dialog'), (current) => !dialogOpen(current) && inEditor(current), 'the dialog to close');
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
    } catch {}
    for (const [name, value] of [['user_rotation', originalRotation], ['accelerometer_rotation', originalAccelerometer]]) {
        try { sh(value === 'null' ? `settings delete system ${name}` : `settings put system ${name} ${value}`); } catch {}
    }
    try { sh(`rm -f ${UI_FILE}`); } catch {}
};

const cases = [
    { name: '(a)', title: `67${run}`, due: '2027-02-09', ordinal: '2', weekday: 'TU', rule: 'FREQ=MONTHLY;BYDAY=2TU', next: '2027-03-09',
        label: en['recurrence.onNthWeekday'].replace('{ordinal}', en['recurrence.ordinal.second']).replace('{weekday}', 'Tuesday') },
    { name: '(b)', title: `68${run}`, due: '2027-01-29', ordinal: '-1', weekday: 'WEEKDAY', rule: 'FREQ=MONTHLY;BYDAY=FR,MO,TH,TU,WE;BYSETPOS=-1', next: '2027-02-26',
        label: en['recurrence.onNthWeekday'].replace('{ordinal}', en['recurrence.ordinal.last']).replace('{weekday}', en['recurrence.weekdayMonFri']), rotate: true },
];

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
    for (const entry of cases) {
        await capture(`${entry.title}%s/due:${entry.due}`, `${entry.title} /due:${entry.due}`);
        const [row] = await storedUntil(entry.title, (rows) => rows.length === 1, `the capture ${entry.title}`);
        check(row.dueDate === entry.due && !row.recurrence, `${entry.name} the capture ${entry.title} is stored due ${entry.due}, not repeating`);
    }
    const logsBefore = advanced();

    for (const entry of cases) {
        let nodes = await openEditor(entry.title);
        let chip;
        [nodes, chip] = await findDescribed(nodes, monthly);
        nodes = await tapExpecting(chip, (current) => chipOn(current, monthly) && Boolean(visible(withDescription(current, en['recurrence.custom']))), 'Monthly on');
        nodes = await tapExpecting(visible(withDescription(nodes, en['recurrence.custom'])), dialogOpen, 'the custom monthly dialog');
        check(shows(nodes, en['recurrence.customTitle']) && shows(nodes, en['recurrence.onLabel']),
            `${entry.name} Custom opens RN's dialog, "${en['recurrence.customTitle']}" with "${en['recurrence.onLabel']}"`);
        await chooseNth(entry.ordinal, entry.weekday, entry.label, entry.rotate);
        nodes = await screen();
        check(chipOn(nodes, en['recurrence.custom']), `${entry.name} Save marks Custom in the editor`);
        await saveEditor();
        const [saved] = await storedUntil(entry.title, (rows) => rows[0]?.recurrence?.rrule?.startsWith(entry.rule), `${entry.name} the rule saved`);
        check(saved.recurrence.rule === 'monthly' && saved.recurrence.strategy === 'strict'
            && saved.recurrence.rrule === `${entry.rule};X-MINDWTR-SERIES-ID=${saved.recurrence.seriesId}` && saved.dueDate === entry.due,
            `${entry.name} stored the rule RN stores: ${JSON.stringify(saved.recurrence)}`);

        nodes = await openEditor(entry.title);
        [nodes, chip] = await findDescribed(nodes, statusDone);
        await tapExpecting(chip, (current) => chipOn(current, statusDone), 'Status Done');
        await saveEditor();
        const rows = await storedUntil(entry.title, (current) => current.length === 2, `${entry.name} the next occurrence`);
        const next = rows.find((row) => row.id !== saved.id);
        const original = rows.find((row) => row.id === saved.id);
        check(['done', 'archived'].includes(original.status) && next.dueDate === entry.next && next.recurrence?.rrule === saved.recurrence.rrule,
            `${entry.name} completing it stores the next occurrence due ${entry.next} with the same rule (stored ${JSON.stringify(rows.map(({ status, dueDate }) => ({ status, dueDate })))})`);
        await waitFor('the Inbox', onInbox, 15_000);
    }
    const lines = advanced() - logsBefore;
    check(lines >= 1, `the last-weekday completion logged "${LOG_LINE}" (${lines} line(s))`);
    console.log('Custom monthly repeat device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
