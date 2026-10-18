// Settings › Notifications and the persistent capture notification (pass R2a) on the isolated native Android development app.
//
//   node apps/android-native/scripts/check-notifications-device.mjs <adb-serial> [apk]
//
// Installs the debug APK with `install -r` (existing development data stays). Through the app's own screens only, it first sets a
// known start (task reminders, the weekly review, the morning digest and the capture switch off), then checks:
// (1) Settings › Notifications shows core's rows; Task reminders, Weekly review, its day (Wednesday, from RN's day picker), the
//     morning digest and its time (07:45, from Android's time picker) are each stored in the database through the app (no
//     journal entry left), and after a process death and a new start the screen shows each stored value again;
// (2) Quick capture in notification bar: on posts RN's notification (id 41120, channel `mindwtr-persistent-capture`) and stores
//     RN's AsyncStorage key; removed as an OEM's kill removes it (debug broadcast, the notifier's mirror kept), a process death
//     and a start post it again, and so does a resume from the background; a tap on it opens RN's quick capture dialog; off with
//     the process killed between storing it and removing the notification (debug `journal_stop=after:notificationsSetting`):
//     the next start removes it, the switch shows off, and a later start pins nothing.
// Every switch, the day and the time it changed are put back through the app at the end, on failure too. It reads the app's database and RKStorage from copies only. It grants the development app the notification permission (kept). It never launches over another
// app and leaves the device on its home screen. Exit 0 = pass, 1 = fail, 2 = refused before touching the device, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { check, connect, evidenced, fail, inEditor, Stopped, switchOn, tab, tagged, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-notifications-device.mjs <adb-serial> [apk]');
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
const UI_FILE = '/data/local/tmp/mindwtr-native-dev-notifications-ui.xml';
const DB = 'mindwtr-native-dev.db';
const CAPTURE_ID = 41120;
const CAPTURE_CHANNEL = 'mindwtr-persistent-capture';
const KEYS = { capture: 'mindwtr:persistentCaptureNotification' };
const RESCHEDULE = `${PKG}/tech.dongdongbh.mindwtr.pilot.ReminderRescheduleReceiver`;
const DEBUG_RESCHEDULE = 'tech.dongdongbh.mindwtr.debug.RESCHEDULE_REMINDERS';
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
const work = resolve(app, 'android/build/notifications-check');
const { en } = await import(resolve(app, '../../packages/core/src/i18n/locales/en.ts'));

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, adbRaw, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting } = device;
const runAs = (command) => sh(`run-as ${PKG} sh -c '${command}'`);
const journal = () => runAs('ls files/journal 2>/dev/null || true').split(/\s+/).filter((name) => /^\d{16}\.json$/.test(name));
const waitUntil = async (description, predicate, timeoutMs = 60_000, everyMs = 1000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await predicate();
        if (value) return value;
        if (Date.now() > deadline) fail(`timed out waiting for ${description}`);
        await sleep(everyMs);
    }
};

// ---- the app's files, read from copies pulled through run-as ----
const pull = (name, dir) => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const [folder, file] = [name.slice(0, name.lastIndexOf('/')), name.slice(name.lastIndexOf('/') + 1)];
    const present = runAs(`ls ${folder} 2>/dev/null || true`).split(/\s+/);
    for (const suffix of ['', '-wal', '-shm', '-journal']) if (present.includes(`${file}${suffix}`)) device.pull(`${name}${suffix}`, resolve(dir, `${file}${suffix}`));
    return resolve(dir, file);
};
const bun = (script, env) => execFileSync('bun', ['-e', `import { Database } from 'bun:sqlite';\n${script}`], { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
/** The stored settings (the database's one settings row), read from a fresh copy. */
const settings = () => JSON.parse(bun(`const db = new Database(process.env.CHECK_DB, { readonly: true });
    console.log(db.query('SELECT data FROM settings WHERE id = 1').get()?.data ?? '{}');`, { CHECK_DB: pull(`files/${DB}`, resolve(work, 'db')) }));
/** RN's AsyncStorage values for [keys] (null: not stored). */
const kv = (keys) => JSON.parse(bun(`const db = new Database(process.env.CHECK_DB, { readonly: true });
    const keys = JSON.parse(process.env.CHECK_KEYS);
    console.log(JSON.stringify(Object.fromEntries(keys.map((key) => [key, db.query('SELECT value FROM catalystLocalStorage WHERE key = ?').get(key)?.value ?? null]))));`,
{ CHECK_DB: pull('databases/RKStorage', resolve(work, 'rkstorage')), CHECK_KEYS: JSON.stringify(keys) }));
// ---- the system's view ----
const notifications = () => sh('dumpsys notification --noredact').split(/\n(?=\s*NotificationRecord\()/)
    .filter((block) => block.includes(`pkg=${PKG}`))
    .map((block) => ({
        id: Number(/\bid=(-?\d+)/.exec(block)?.[1]),
        channel: /(?:mChannelId|channelId|channel)=([\w.-]+)/.exec(block)?.[1] ?? '',
        title: /android\.title=\w+ \((.*)\)/.exec(block)?.[1] ?? '',
        text: /android\.text=\w+ \((.*)\)/.exec(block)?.[1] ?? '',
    }));
const closeShade = () => sh('cmd statusbar collapse');
const tapInShade = async (text) => {
    sh('cmd statusbar expand-notifications');
    await sleep(1500);
    const node = (await screen()).find((item) => item.text === text) ?? fail(`"${text}" is not in the shade`);
    const [x1, y1, x2, y2] = node.bounds.match(/\d+/g).map(Number);
    sh(`input tap ${Math.round((x1 + x2) / 2)} ${Math.round((y1 + y2) / 2)}`);
};

// ---- the process and the screens ----
/** The process gone as after the system reclaimed it: a signal, never a force-stop (that drops every alarm). */
const killApp = async () => {
    if (front().includes(`${PKG}/`)) sh('input keyevent KEYCODE_HOME');
    for (let attempt = 0; attempt < 20 && pid(); attempt += 1) {
        try { runAs(`kill -9 ${pid()}`); } catch { /* gone meanwhile */ }
        await sleep(500);
    }
    if (pid()) fail('the app process did not end');
};
const onTabs = (nodes) => Boolean(tab(nodes, en['tab.menu'])) && !tagged(nodes, 'menu-screen') && !tagged(nodes, 'more-sheet') && !inEditor(nodes);
const toTabs = async () => {
    for (let step = 0; step < 8; step += 1) {
        const nodes = await screen();
        if (onTabs(nodes)) return nodes;
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(900);
    }
    return fail('the tabs did not come back');
};
const launch = async () => {
    device.launch(ACTIVITY);
    return waitFor('the tabs', onTabs, 60_000);
};
const row = (nodes, label) => nodes.find((node) => (node['content-desc'] ?? '').startsWith(`${label}: `));
const value = (nodes, label) => row(nodes, label)?.['content-desc'].slice(label.length + 2);
const openNotifications = async () => {
    let nodes = await toTabs();
    nodes = await tapExpecting(tab(nodes, en['tab.menu']), (current) => Boolean(tagged(current, 'more-sheet')), 'the More sheet');
    nodes = await device.settle(nodes);
    nodes = await tapExpecting(withDescription(nodes, en['nav.settings']) ?? fail('no Settings tile'), (current) => Boolean(tagged(current, 'settings-main')), 'Settings');
    const label = `${en['settings.notifications']}. ${en['settings.menuDesc.notifications']}`;
    return tapExpecting(withDescription(nodes, label) ?? fail('no Notifications row'), (current) => Boolean(tagged(current, 'settings-notifications')), 'Settings › Notifications');
};
/** On screen: listed with a non-empty box (a row past the fold is listed with an empty one). */
const visible = (node) => { if (!node) return false; const [x1, y1, x2, y2] = node.bounds.match(/\d+/g).map(Number); return x2 > x1 && y2 > y1 && y2 < 2150; };
/** Scrolls Notifications until [found] shows. */
const reveal = async (found) => {
    let nodes = await screen();
    // Up to the top first (a row above what shows), then down.
    for (let step = 0; step < 6 && !found(nodes); step += 1) nodes = await device.swipe(nodes, 'up');
    for (let step = 0; step < 6 && !found(nodes); step += 1) nodes = await device.swipe(nodes, 'down');
    return found(nodes) ? nodes : fail('not on the Notifications screen');
};
/** The switch labelled [label] flipped through the app, then [stored] (the settings) awaited. */
const flip = async (label, stored, description) => {
    const nodes = await reveal((current) => visible(withDescription(current, label)));
    const was = switchOn(nodes, label);
    // A first notification feature on adds core's exact-alarm row above the switch, which can push it below the fold (since
    // #1383's Default task reminders row, Weekly review goes off screen): the switch is read again where it now is.
    const shown = (current) => visible(withDescription(current, label));
    const after = await tapExpecting(withDescription(nodes, label), (current) => !shown(current) || switchOn(current, label) !== was, `${label} to switch`);
    if (!shown(after)) await reveal(shown);
    await waitFor(`${label} to switch`, (current) => shown(current) && switchOn(current, label) !== was, 10_000);
    await waitUntil(description, async () => stored(settings()), 20_000);
    await waitUntil('the journal to empty', async () => journal().length === 0, 20_000);
    check(true, description);
};

/** The switch labelled [label] set to [on] through the app (nothing when it already is); [stored] checks the settings after. */
const setSwitch = async (label, on, stored) => {
    const nodes = await reveal((current) => visible(withDescription(current, label)));
    if (switchOn(nodes, label) === on) return;
    await flip(label, stored, `${label} ${on ? 'on' : 'off'} is stored`);
};
const byId = (current, id) => current.find((node) => (node['resource-id'] ?? '').endsWith(`:id/${id}`));
/** The time row labelled [label] set to [time] ('HH:MM') through Android's time dialog: its keyboard mode, the fields typed, OK. */
const setTime = async (label, time) => {
    const nodes = await reveal((current) => visible(row(current, label)));
    if (value(nodes, label) === time) return;
    await tap(row(nodes, label));
    let dialog = await waitFor('the time dialog', (current) => current.some((node) => /toggle_mode|button1/.test(node['resource-id'] ?? '')), 15_000);
    if (byId(dialog, 'toggle_mode') && !byId(dialog, 'input_hour')) {
        await tap(byId(dialog, 'toggle_mode'));
        dialog = await waitFor('the time dialog\'s fields', (current) => Boolean(byId(current, 'input_hour')), 10_000);
    }
    const [hour, minute] = time.split(':').map(Number);
    const twelve = dialog.some((node) => node.text === 'AM' || node.text === 'PM');
    const shownHour = twelve ? String(hour % 12 === 0 ? 12 : hour % 12).padStart(2, '0') : String(hour).padStart(2, '0');
    for (const [id, text] of [['input_hour', shownHour], ['input_minute', String(minute).padStart(2, '0')]]) {
        await tap(byId(dialog, id) ?? fail(`no ${id} in the time dialog`));
        sh('input keyevent KEYCODE_MOVE_END');
        for (let i = 0; i < 3; i += 1) sh('input keyevent KEYCODE_DEL');
        sh(`input text ${text}`);
        dialog = await screen();
    }
    const half = dialog.find((node) => node.text === (hour < 12 ? 'AM' : 'PM') && node.class?.includes('RadioButton'));
    if (half && half.checked !== 'true') await tap(half);
    await tap(byId(await screen(), 'button1') ?? fail('no OK in the time dialog'));
};
/** The review day picked from RN's day picker. */
const setDay = async (day) => {
    let nodes = await reveal((current) => visible(row(current, en['settings.weeklyReviewDay'])));
    if (value(nodes, en['settings.weeklyReviewDay']) === day) return;
    nodes = await tapExpecting(row(nodes, en['settings.weeklyReviewDay']), (current) => Boolean(tagged(current, 'settings-picker')), 'the day picker');
    await tapExpecting(withDescription(nodes, day) ?? fail(`no ${day}`), (current) => !tagged(current, 'settings-picker'), 'the picker to close');
};

/** The start as found (each control's shown state), to put back at the end. */
let found = null;
const restore = async () => {
    try { closeShade(); } catch { /* device gone */ }
    try { setProp('journal_stop', ''); } catch { /* device gone */ }
    try {
        if (found) {
            if (!front().includes(`${PKG}/`)) await launch();
            await openNotifications();
            await setSwitch(en['settings.notificationsEnable'], found.reminders, () => true);
            await setSwitch(en['settings.weeklyReview'], true, () => true);
            await setDay(found.day);
            await setTime(en['settings.weeklyReviewTime'], found.weeklyTime);
            await setSwitch(en['settings.weeklyReview'], found.weekly, () => true);
            await setSwitch(en['settings.dailyDigestMorning'], true, () => true);
            await setTime(en['settings.dailyDigestMorningTime'], found.morningTime);
            await setSwitch(en['settings.dailyDigestMorning'], found.morning, () => true);
            await setSwitch(en['settings.persistentCaptureLabel'], found.capture, () => true);
            await toTabs();
        }
    } catch (error) { console.error(`RESTORE FAILED: the development settings are not as they were (${error.message}); put them back by hand`); process.exitCode = 1; }
    try { if (front().includes(`${PKG}/`)) sh('input keyevent KEYCODE_HOME'); } catch { /* device gone */ }
    try { sh('settings put system accelerometer_rotation 1'); } catch { /* device gone */ }
    try { sh(`rm -f ${UI_FILE}`); } catch { /* device gone */ }
};

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`);
    sh('settings put system accelerometer_rotation 0');
    await launch();
    // The start as found, then the known start, all through the app.
    let nodes = await openNotifications();
    const shown = async (label) => switchOn(await reveal((current) => visible(withDescription(current, label))), label);
    const at = async (label) => value(await reveal((current) => visible(row(current, label))), label);
    const start = { reminders: await shown(en['settings.notificationsEnable']), weekly: await shown(en['settings.weeklyReview']),
        day: await at(en['settings.weeklyReviewDay']), weeklyTime: await at(en['settings.weeklyReviewTime']), morning: await shown(en['settings.dailyDigestMorning']),
        morningTime: await at(en['settings.dailyDigestMorningTime']), capture: await shown(en['settings.persistentCaptureLabel']) };
    // Kept before anything changes, so a failure from here on still puts back what it changed.
    found = start;
    nodes = await openNotifications();
    await setSwitch(en['settings.notificationsEnable'], false, (stored) => stored.notificationsEnabled === false);
    await setSwitch(en['settings.weeklyReview'], true, (stored) => stored.weeklyReviewEnabled === true);
    await setDay('Sunday');
    await setSwitch(en['settings.weeklyReview'], false, (stored) => stored.weeklyReviewEnabled === false);
    await setSwitch(en['settings.dailyDigestMorning'], true, (stored) => stored.dailyDigestMorningEnabled === true);
    await setTime(en['settings.dailyDigestMorningTime'], '09:00');
    await setSwitch(en['settings.dailyDigestMorning'], false, (stored) => stored.dailyDigestMorningEnabled === false);
    await setSwitch(en['settings.persistentCaptureLabel'], false, () => kv([KEYS.capture])[KEYS.capture] === null);

    // (1) Each setting stored through the app, and read back after a restart.
    nodes = await openNotifications();
    check(Boolean(withDescription(nodes, en['settings.notificationsEnable'])) && !switchOn(nodes, en['settings.notificationsEnable']),
        '(1) Settings › Notifications shows core\'s Task reminders switch, off');
    await flip(en['settings.notificationsEnable'], (stored) => stored.notificationsEnabled === true, '(1) Task reminders on is stored');
    await flip(en['settings.weeklyReview'], (stored) => stored.weeklyReviewEnabled === true, '(1) Weekly review on is stored');
    nodes = await reveal((current) => visible(row(current, en['settings.weeklyReviewDay'])));
    check(value(nodes, en['settings.weeklyReviewDay']) === 'Sunday', '(1) the review day row shows Sunday (set at the start)');
    nodes = await tapExpecting(row(nodes, en['settings.weeklyReviewDay']), (current) => Boolean(tagged(current, 'settings-picker')), 'the day picker');
    await tapExpecting(withDescription(nodes, 'Wednesday') ?? fail('no Wednesday'), (current) => !tagged(current, 'settings-picker'), 'the picker to close');
    await waitUntil('the review day stored', async () => settings().weeklyReviewDay === 3, 20_000);
    check(true, '(1) the review day Wednesday is stored (3)');
    await flip(en['settings.dailyDigestMorning'], (stored) => stored.dailyDigestMorningEnabled === true, '(1) the morning digest on is stored');
    await setTime(en['settings.dailyDigestMorningTime'], '07:45');
    await waitUntil('the morning time stored', async () => settings().dailyDigestMorningTime === '07:45', 20_000);
    check(journal().length === 0, '(1) the morning time 07:45 from Android\'s time picker is stored, and no journal entry is left');
    await killApp();
    await launch();
    nodes = await openNotifications();
    check(switchOn(nodes, en['settings.notificationsEnable']), '(1) after a restart Task reminders shows on');
    nodes = await reveal((current) => visible(row(current, en['settings.dailyDigestMorningTime'])));
    check(value(nodes, en['settings.dailyDigestMorningTime']) === '07:45' && switchOn(nodes, en['settings.dailyDigestMorning']),
        '(1) after a restart the morning digest shows on, at 07:45');
    nodes = await reveal((current) => visible(row(current, en['settings.weeklyReviewDay'])));
    check(value(nodes, en['settings.weeklyReviewDay']) === 'Wednesday' && switchOn(nodes, en['settings.weeklyReview']),
        '(1) after a restart the weekly review shows on, on Wednesday');
    // Off again through the app, so no reminder of the development data fires while the check runs.
    await flip(en['settings.notificationsEnable'], (stored) => stored.notificationsEnabled === false, '(1) Task reminders off is stored');
    await flip(en['settings.dailyDigestMorning'], (stored) => stored.dailyDigestMorningEnabled === false, '(1) the morning digest off is stored');
    await flip(en['settings.weeklyReview'], (stored) => stored.weeklyReviewEnabled === false, '(1) Weekly review off is stored');

    // (2) The persistent capture notification.
    const capture = () => notifications().filter((item) => item.id === CAPTURE_ID && item.channel === CAPTURE_CHANNEL);
    await flip(en['settings.persistentCaptureLabel'], () => kv([KEYS.capture])[KEYS.capture] === 'true', '(2) the switch stores RN\'s key');
    await waitUntil('the capture notification', () => capture().length === 1, 15_000);
    check(capture()[0].title === en['captureNotification.title'] && capture()[0].text === en['captureNotification.text'],
        `(2) RN's notification is posted (id ${CAPTURE_ID}, channel ${CAPTURE_CHANNEL}) with core's words`);
    // Removed as an OEM's kill removes it (the notifier's mirror kept; debug broadcast), so only a restore can bring it back.
    const removeCapture = async () => {
        sh(`am broadcast -f 0x20 -n ${RESCHEDULE} -a ${DEBUG_RESCHEDULE} --ez cancelCaptureNotification true`);
        await waitUntil('the capture notification removed', () => capture().length === 0, 10_000);
    };
    await removeCapture();
    await killApp();
    await launch();
    await waitUntil('the capture notification after a restart', () => capture().length === 1, 20_000);
    check(true, '(2) removed, then a process death: the next start shows it again');
    sh('input keyevent KEYCODE_HOME');
    await sleep(1500);
    check(Boolean(pid()), '(2) the app is in the background, its process alive');
    await removeCapture();
    await launch();
    await waitUntil('the capture notification after a resume', () => capture().length === 1, 20_000);
    check(true, '(2) removed while in the background: the resume shows it again');
    await toTabs();
    sh('input keyevent KEYCODE_HOME');
    await sleep(1000);
    await tapInShade(en['captureNotification.title']);
    await waitUntil('the quick capture dialog', () => front().includes('QuickCaptureActivity'), 20_000);
    check(true, '(2) a tap on it opens RN\'s quick capture dialog');
    sh('input keyevent KEYCODE_BACK');
    await sleep(1500);
    if (!front().includes(`${PKG}/`)) await launch();
    await openNotifications();
    // Off with the process killed after core stored it and before the notification went (debug `journal_stop=after:notificationsSetting`):
    // the notifier's mirror still says on, so the next process start pins it again, and the boot removes it.
    setProp('journal_stop', 'after:notificationsSetting');
    let current = await reveal((shown) => visible(withDescription(shown, en['settings.persistentCaptureLabel'])));
    await tap(withDescription(current, en['settings.persistentCaptureLabel']));
    await waitUntil('the process to stop after the off was stored', () => !pid(), 20_000);
    setProp('journal_stop', '');
    check(kv([KEYS.capture])[KEYS.capture] === null && capture().length === 1, '(2) the off is stored and the notification is still pinned');
    await launch();
    await waitUntil('the capture notification to go after the restart', () => capture().length === 0, 30_000);
    await sleep(3000);
    check(capture().length === 0 && kv([KEYS.capture])[KEYS.capture] === null, '(2) the next start removes it, and it stays off');
    await openNotifications();
    current = await reveal((shown) => visible(withDescription(shown, en['settings.persistentCaptureLabel'])));
    check(!switchOn(current, en['settings.persistentCaptureLabel']), '(2) Settings › Notifications shows the switch off');
    await killApp();
    await launch();
    await sleep(3000);
    check(capture().length === 0, '(2) a later start pins nothing');

    console.log('Notifications device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
