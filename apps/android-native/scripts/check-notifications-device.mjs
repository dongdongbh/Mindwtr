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
// Then the Pomodoro card's completion alerts (pass R2b, PomodoroAlarms.kt), with Settings › GTD › Pomodoro set through the app:
// the feature on, focus and break 1 and 1 minutes, the completion alert on, no auto-start and no task link. Each alert is one
// AlarmManager alarm (`*walarm*:tech.dongdongbh.mindwtr.pomodoro.FIRE`) and one tray notification tagged with core's id, and the
// alarm book (shared_prefs/mindwtr_pomodoro_alarms.xml) holds core's record, `armed:<id>` and the ledger's `fired:<id>`:
// (3) the 1/1 preset sets 01:00; Start arms one alarm at the phase end under core's id; with the process killed it fires once at
//     that time, stamped with it, with core's words, and leaves no alarm; the next start shows RN's finished-phase line, arms
//     nothing and keeps the alert; a tap on the alert opens the app and removes it;
// (4) a Start journaled and the process killed before core committed it (debug `journal_stop=before:pomodoroTransitionCommit`):
//     the next start replays it on the stored session (its 1/1 minutes kept), the card runs, one alarm is armed and the journal
//     is empty; Pause cancels the alarm;
// (8) the completion alert turned off in Settings while an alert is armed: the alarm goes, and nothing shows after its time;
// (7) a force-stop mid-phase drops the alarm; the next start arms the same alert again at the same time;
// (5) with Auto-start breaks on and the app open, the focus phase ends: the focus alert shows once and the break's alarm is
//     armed under another id; Pause cancels it;
// (6) with Auto-start breaks on and the screen off: the focus alert arrives at the phase end, stamped with it; the auto-started
//     break gets no alarm while the app does not run (RN's background rule, design R2b §4b); the screen on again resumes the
//     app, which arms the break, and the break's alert arrives at its end;
// (9) a linked task (the picker's first Focus task): the process dies right after core committed the focus phase's end
//     (debug `journal_stop=after:pomodoroTransitionCommit`, so the journal replays it): the task's time grows by the focus
//     minutes exactly once, also after a further restart.
// Every switch, the day, the time and the Pomodoro settings it changed are put back through the app at the end, on failure too.
// It reads the app's database, RKStorage and alarm book from copies only. It grants the development app the notification
// permission (kept), and keeps the screen on while charging for the run (stay_on_while_plugged_in, put back). It never launches
// over another app and leaves the device on its home screen, with the screen on.
// Exit 0 = pass, 1 = fail, 2 = refused before touching the device, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { check, connect, evidenced, fail, inEditor, Stopped, switchOn, tab, tabSelected, tagged, withDescription } from './device.mjs';

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
const POMODORO_FIRE = 'tech.dongdongbh.mindwtr.pomodoro.FIRE';
const POMODORO_BOOK = 'shared_prefs/mindwtr_pomodoro_alarms.xml';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
/** PomodoroAlarmBook.scope and .identifier: this package's library scope, and core's id for one alert. */
const POMODORO_SCOPE = `${PKG}:${sha256(PKG)}`;
const pomodoroId = ({ sessionID, phase, fireAtMs }) => `mindwtr-native-pomodoro:${sha256(`${POMODORO_SCOPE}|${sessionID}|${phase}|${fireAtMs}`)}`;
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
/** Core's stored Pomodoro session (native_pomodoro_session: `{ sessionID, generation, session }`), and [taskId]'s time spent. */
const pomodoro = (taskId = '') => JSON.parse(bun(`const db = new Database(process.env.CHECK_DB, { readonly: true });
    const raw = db.query('SELECT state_json FROM native_pomodoro_session WHERE id = 1').get()?.state_json;
    const task = db.query('SELECT timeSpentMinutes FROM tasks WHERE id = ?').get(process.env.CHECK_TASK);
    console.log(JSON.stringify({ state: raw ? JSON.parse(raw) : null, minutes: task ? Number(task.timeSpentMinutes ?? 0) : null }));`,
{ CHECK_DB: pull(`files/${DB}`, resolve(work, 'db')), CHECK_TASK: taskId }));
// ---- the system's view ----
const notifications = () => sh('dumpsys notification --noredact').split(/\n(?=\s*NotificationRecord\()/)
    .filter((block) => block.includes(`pkg=${PKG}`))
    .map((block) => ({
        id: Number(/\bid=(-?\d+)/.exec(block)?.[1]),
        tag: /\btag=([^\s,)]+)/.exec(block)?.[1] ?? '',
        channel: /(?:mChannelId|channelId|channel)=([\w.-]+)/.exec(block)?.[1] ?? '',
        title: /android\.title=\w+ \((.*)\)/.exec(block)?.[1] ?? '',
        text: /android\.text=\w+ \((.*)\)/.exec(block)?.[1] ?? '',
        when: Number(/\bwhen=(\d+)/.exec(block)?.[1] ?? NaN),
    }));
/** The Pomodoro alerts in the tray: each under core's id as its tag. */
const pomodoroAlerts = () => notifications().filter((item) => item.tag.startsWith('mindwtr-native-pomodoro:'));
/** The Pomodoro alarms AlarmManager holds for this package (pending RTC ones: a block that ends the pending list can carry history). */
const pomodoroAlarms = () => sh('dumpsys alarm').split(/\n(?=\s*(?:RTC_WAKEUP|RTC|ELAPSED_WAKEUP|ELAPSED) #\d+: Alarm\{)/)
    .filter((block) => block.includes(`*walarm*:${POMODORO_FIRE}`) && block.includes(PKG))
    .map((block) => Number(/origWhen[= ](\d+)/.exec(block)?.[1] ?? NaN)).filter((at) => at > 1e12);
const unxml = (value) => value.replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/&amp;/g, '&');
/** The alarm book: core's record, the alerts armed (`armed:<id>`) and the ledger (`fired:<id>`), each with its occurrence. */
const book = () => {
    const entries = new Map([...runAs(`cat ${POMODORO_BOOK} 2>/dev/null || true`).matchAll(/<string name="([^"]*)">([^<]*)<\/string>/g)]
        .map(([, name, value]) => [unxml(name), unxml(value)]));
    const listed = (prefix) => [...entries].filter(([name]) => name.startsWith(prefix)).map(([name, value]) => ({ id: name.slice(prefix.length), ...JSON.parse(value) }));
    const record = entries.has('record') ? JSON.parse(entries.get('record')) : null;
    return { record, alarm: record?.libraries?.find((library) => library.scope === POMODORO_SCOPE)?.alarm ?? null, armed: listed('armed:'), fired: listed('fired:') };
};
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

// ---- Settings › GTD › Pomodoro, through the app ----
const GTD_ROW = `${en['settings.gtd']}. ${en['settings.menuDesc.gtd']}`;
const POMODORO = { feature: en['settings.featurePomodoro'], link: en['settings.pomodoroSettings'], focus: en['settings.pomodoroFocusMinutes'],
    break: en['settings.pomodoroBreakMinutes'], linkTask: en['settings.pomodoroLinkTask'], autoBreaks: en['settings.pomodoroAutoStartBreaks'],
    autoFocus: en['settings.pomodoroAutoStartFocus'], alert: en['settings.pomodoroCompletionAlert'] };
const POMODORO_SWITCHES = [POMODORO.linkTask, POMODORO.autoBreaks, POMODORO.autoFocus, POMODORO.alert];
/** The text field labelled [label]: an EditText named by it, or the one around its labelled node. */
const minuteField = (nodes, label) => {
    const named = nodes.find((node) => node.class === 'android.widget.EditText' && (node['content-desc'] === label || node.hint === label));
    if (named) return named;
    const labelled = withDescription(nodes, label);
    if (!labelled) return undefined;
    const [x1, y1, x2, y2] = labelled.bounds.match(/\d+/g).map(Number);
    const [cx, cy] = [(x1 + x2) / 2, (y1 + y2) / 2];
    return nodes.find((node) => {
        if (node.class !== 'android.widget.EditText') return false;
        const [l, t, r, b] = node.bounds.match(/\d+/g).map(Number);
        return l <= cx && cx <= r && t <= cy && cy <= b;
    });
};
const startsWith = (nodes, label) => nodes.find((node) => (node['content-desc'] ?? '').startsWith(label));
/** Settings › GTD from the tabs, the Pomodoro feature set to [feature], and (while on) its settings screen. */
const openGtd = async (feature) => {
    let nodes = await toTabs();
    nodes = await tapExpecting(tab(nodes, en['tab.menu']), (current) => Boolean(tagged(current, 'more-sheet')), 'the More sheet');
    nodes = await device.settle(nodes);
    nodes = await tapExpecting(withDescription(nodes, en['nav.settings']) ?? fail('no Settings tile'), (current) => Boolean(tagged(current, 'settings-main')), 'Settings');
    nodes = await tapExpecting(withDescription(nodes, GTD_ROW) ?? fail('no GTD row'), (current) => Boolean(withDescription(current, POMODORO.feature)), 'Settings › GTD');
    if (switchOn(nodes, POMODORO.feature) !== feature) {
        nodes = await tapExpecting(withDescription(nodes, POMODORO.feature), (current) => switchOn(current, POMODORO.feature) === feature, 'the Pomodoro feature');
        await waitUntil('the Pomodoro feature stored', async () => (settings().features?.pomodoro === true) === feature, 20_000);
    }
    if (!feature) return nodes;
    nodes = await waitFor('the Pomodoro settings row', (current) => Boolean(startsWith(current, POMODORO.link)), 15_000);
    return tapExpecting(startsWith(nodes, POMODORO.link), (current) => Boolean(minuteField(current, POMODORO.focus)), 'Settings › GTD › Pomodoro');
};
/** GTD › Pomodoro's minute fields typed ([focus], [brk]) and committed with the keyboard's Done (RN commits both on blur). */
const setMinutes = async (focus, brk) => {
    let nodes = await screen();
    if (minuteField(nodes, POMODORO.focus)?.text === focus && minuteField(nodes, POMODORO.break)?.text === brk) return;
    for (const [label, text] of [[POMODORO.focus, focus], [POMODORO.break, brk]]) {
        await tap(minuteField(nodes, label) ?? fail(`no ${label} field`));
        sh('input keyevent KEYCODE_MOVE_END');
        for (let i = 0; i < 4; i += 1) sh('input keyevent KEYCODE_DEL');
        sh(`input text ${text}`);
        nodes = await screen();
    }
    sh('input keyevent KEYCODE_ENTER');
    await waitUntil(`the minutes ${focus}/${brk} stored`, async () => {
        const durations = settings().gtd?.pomodoro?.customDurations;
        return String(durations?.focusMinutes) === focus && String(durations?.breakMinutes) === brk;
    }, 20_000);
    // The keyboard down again, so the switches below are on screen.
    if (sh('dumpsys input_method').includes('mInputShown=true')) sh('input keyevent KEYCODE_BACK');
    await sleep(800);
};
/** A GTD › Pomodoro switch set to [on]; [stored] reads the stored value (settings.gtd.pomodoro). */
const POMODORO_FIELDS = { [POMODORO.linkTask]: 'linkTask', [POMODORO.autoBreaks]: 'autoStartBreaks', [POMODORO.autoFocus]: 'autoStartFocus', [POMODORO.alert]: 'completionAlert' };
const storedSwitch = (label) => {
    const value = settings().gtd?.pomodoro?.[POMODORO_FIELDS[label]];
    // Core's defaults: the alert on (#528), the rest off.
    return label === POMODORO.alert ? value !== false : value === true;
};
const pomodoroSwitch = async (label) => reveal((current) => visible(withDescription(current, label)));
const setPomodoroSwitch = async (label, on) => {
    const nodes = await pomodoroSwitch(label);
    if (switchOn(nodes, label) === on) return;
    await tapExpecting(withDescription(nodes, label), (current) => switchOn(current, label) === on, label);
    await waitUntil(`${label} ${on ? 'on' : 'off'} stored`, async () => storedSwitch(label) === on, 20_000);
    await waitUntil('the journal to empty', async () => journal().length === 0, 20_000);
};

// ---- the Pomodoro card on Focus ----
const card = (nodes) => Boolean(tagged(nodes, 'pomodoro-card')) && !nodes.some((node) => node.text === en['common.loading']);
const toCard = async () => {
    const nodes = await toTabs();
    if (!tabSelected(nodes, en['tab.next'])) await tap(tab(nodes, en['tab.next']));
    return waitFor('the Pomodoro card', card, 30_000);
};
const clock = (nodes) => tagged(nodes, 'pomodoro-clock')?.text;
/** A card control once it takes taps: the card's controls are off while a transition and its alarm plan run (RN's busy rule). */
const control = async (tag) => tagged(await waitFor(`${tag} enabled`, (current) => tagged(current, tag)?.enabled === 'true', 30_000), tag);
const primary = (nodes) => tagged(nodes, 'pomodoro-primary')?.['content-desc'];
/** The card at rest on Focus at the 1/1 preset's full 01:00 (Reset first, and Switch to Focus while on the break). */
const idleCard = async () => {
    let nodes = await toCard();
    if (primary(nodes) === en['common.pause']) nodes = await tapExpecting(await control('pomodoro-primary'), (current) => primary(current) === en['common.start'], 'Pause');
    if (withDescription(nodes, en['pomodoro.switchToFocus'])) {
        nodes = await tapExpecting(await control('pomodoro-switch'), (current) => Boolean(withDescription(current, en['pomodoro.switchToBreak'])), 'Switch to Focus');
    }
    // The preset's transition waits for the card to be idle, so its effect is read from the stored session, never from the screen.
    const oneOne = () => { const durations = pomodoro().state?.session?.durations; return durations?.focusMinutes === 1 && durations?.breakMinutes === 1; };
    if (!oneOne()) {
        await tap(await control('pomodoro-preset-custom'));
        await waitUntil('the 1/1 minutes stored', oneOne, 20_000);
    }
    nodes = await waitFor('the card idle at 1/1', (current) => tagged(current, 'pomodoro-primary')?.enabled === 'true' && Boolean(clock(current)), 30_000);
    if (clock(nodes) !== '01:00') nodes = await tapExpecting(await control('pomodoro-reset'), (current) => clock(current) === '01:00', 'Reset');
    return waitFor('the card idle', (current) => tagged(current, 'pomodoro-primary')?.enabled === 'true', 30_000);
};
/** Start on the idle card: the session runs, and core's record names the focus alert (its time is the stored phase end). */
const startFocus = async (nodes) => {
    await tapExpecting(await control('pomodoro-primary'), (current) => primary(current) === en['common.pause'], 'Start');
    const state = await waitUntil('the running session stored', () => { const { state: s } = pomodoro(); return s?.session?.timerState?.isRunning && s; }, 15_000);
    const alert = { sessionID: state.sessionID, phase: 'focus', fireAtMs: Date.parse(state.session.phaseEndsAt) };
    await waitUntil('core\'s record of the focus alert', () => { const { alarm } = book(); return alarm?.fireAtMs === alert.fireAtMs && alarm.phase === 'focus'; }, 15_000);
    return { ...alert, id: pomodoroId(alert) };
};
// How late an alert may come: with no exact-alarm grant (Android 14's default) the app's alarm is inexact, as RN's is; the
// S23 gave it windows up to about 80 s.
const LATE_MS = 120_000;
const armedAt = (alert) => pomodoroAlarms().filter((at) => at === alert.fireAtMs).length;

/** The start as found (each control's shown state), to put back at the end. */
let found = null;
/** Android's stay-awake-while-charging setting as found (the card settles a phase at 0 only while the screen is on). */
let stayOn = null;
const restore = async () => {
    try { sh('input keyevent KEYCODE_WAKEUP'); sh('wm dismiss-keyguard'); } catch { /* device gone */ }
    try { closeShade(); } catch { /* device gone */ }
    try { setProp('journal_stop', ''); } catch { /* device gone */ }
    try {
        if (found) {
            if (!pid() || !front().includes(`${PKG}/`)) await launch();
            // A failure with the task picker open: its scrim would take the tab bar's taps.
            if (tagged(await screen(), 'pomodoro-picker')) { sh('input keyevent KEYCODE_BACK'); await sleep(1000); }
            if (found.pomodoro && settings().features?.pomodoro === true) {
                // The timer at rest, so no alert of this check fires later.
                const nodes = await toCard();
                if (primary(nodes) === en['common.pause']) await tapExpecting(await control('pomodoro-primary'), (current) => primary(current) === en['common.start'], 'Pause');
                // A due alert stays armed after a pause (RN's rule) until it fires, inexactly late without the exact-alarm grant.
                await waitUntil('no Pomodoro alarm left', () => pomodoroAlarms().length === 0, LATE_MS);
            }
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
            if (found.pomodoro) {
                await openGtd(true);
                if (found.pomodoro.focus !== null) await setMinutes(found.pomodoro.focus, found.pomodoro.brk);
                for (const [label, on] of found.pomodoro.switches) await setPomodoroSwitch(label, on);
                if (!found.pomodoro.feature) await openGtd(false);
            }
            await toTabs();
        }
    } catch (error) { console.error(`RESTORE FAILED: the development settings are not as they were (${error.message}); put them back by hand`); process.exitCode = 1; }
    try { if (front().includes(`${PKG}/`)) sh('input keyevent KEYCODE_HOME'); } catch { /* device gone */ }
    try { sh('settings put system accelerometer_rotation 1'); } catch { /* device gone */ }
    try { if (stayOn !== null) sh(`settings put global stay_on_while_plugged_in ${stayOn}`); } catch { /* device gone */ }
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
    // The screen stays on over the minute-long phases (USB, AC and wireless); put back at the end.
    stayOn = /^\d+$/.test(sh('settings get global stay_on_while_plugged_in')) ? sh('settings get global stay_on_while_plugged_in') : '0';
    sh('settings put global stay_on_while_plugged_in 7');
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
    // The Pomodoro settings as found (kept before any change), then its known start: 1/1 minutes, the alert on, nothing else.
    found.pomodoro = { feature: settings().features?.pomodoro === true, focus: null, brk: null, switches: [] };
    nodes = await openGtd(true);
    const minutesShown = { focus: minuteField(nodes, POMODORO.focus)?.text ?? '25', brk: minuteField(nodes, POMODORO.break)?.text ?? '5' };
    const switchesShown = [];
    for (const label of POMODORO_SWITCHES) switchesShown.push([label, switchOn(await pomodoroSwitch(label), label)]);
    Object.assign(found.pomodoro, minutesShown, { switches: switchesShown });
    await reveal((current) => Boolean(minuteField(current, POMODORO.focus)));
    await setMinutes('1', '1');
    for (const label of POMODORO_SWITCHES) await setPomodoroSwitch(label, label === POMODORO.alert);

    // NOTIFICATIONS_ONLY=pomodoro runs (3)-(9) only, after the same known start.
    if (process.env.NOTIFICATIONS_ONLY !== 'pomodoro') {
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
    }

    // (3) The card and its completion alert, delivered with the process gone.
    const shownOnce = (alert) => pomodoroAlerts().filter((item) => item.tag === alert.id);
    nodes = await idleCard();
    check(true, '(3) the 1/1 preset sets the clock to 01:00');
    const first = await startFocus(nodes);
    await waitUntil('one Pomodoro alarm at the phase end', () => armedAt(first) === 1, 15_000);
    check(book().armed.some((entry) => entry.id === first.id) && pomodoroAlarms().length === 1,
        `(3) Start arms one alarm at the phase end (${new Date(first.fireAtMs).toISOString()}) under core's id`);
    await killApp();
    await waitUntil('the focus alert', () => shownOnce(first).length === 1, Math.max(0, first.fireAtMs - Date.now()) + LATE_MS);
    const late = Date.now() - first.fireAtMs;
    const [focusAlert] = shownOnce(first);
    check(focusAlert.title === en['pomodoro.mobileTitle'] && focusAlert.text === en['pomodoro.focusComplete'] && focusAlert.when === first.fireAtMs && late > -2000,
        `(3) with the process gone the alert fires at the phase end (${late} ms after it), stamped with it, with core's words`);
    await sleep(15_000);
    let alarms = book();
    check(shownOnce(first).length === 1 && pomodoroAlarms().length === 0 && alarms.fired.some((entry) => entry.id === first.id)
        && !alarms.armed.some((entry) => entry.id === first.id), '(3) no second alert, no alarm left, and the ledger holds the alert');
    nodes = await launch();
    nodes = await toCard();
    await waitFor('the finished-phase line', (current) => tagged(current, 'pomodoro-event')?.text === en['pomodoro.focusComplete'], 30_000);
    await sleep(3000);
    check(pomodoroAlarms().length === 0 && shownOnce(first).length === 1, '(3) the next start shows RN\'s finished-phase line, arms nothing, and keeps the alert');
    sh('input keyevent KEYCODE_HOME');
    await sleep(1000);
    await tapInShade(en['pomodoro.focusComplete']);
    await waitUntil('the app in front', () => front().includes(`${PKG}/`), 20_000);
    await waitUntil('the alert to go', () => shownOnce(first).length === 0, 10_000);
    check(true, '(3) a tap on the alert opens the app, and the alert goes');

    // (4) A journaled Start replayed by the next start.
    nodes = await idleCard();
    await waitUntil('the journal to empty', () => journal().length === 0, 20_000);
    setProp('journal_stop', 'before:pomodoroTransitionCommit');
    await tap(await control('pomodoro-primary'));
    await waitUntil('the process to stop at the journaled Start', () => !pid(), 20_000);
    setProp('journal_stop', '');
    check(journal().length === 1 && pomodoro().state?.session?.timerState?.isRunning !== true, '(4) the Start is in the journal and core never committed it');
    await launch();
    nodes = await toCard();
    await waitFor('the replayed Start', (current) => primary(current) === en['common.pause'], 30_000);
    await waitUntil('the journal to empty', () => journal().length === 0, 20_000);
    const replayed = pomodoro().state;
    check(replayed?.session?.timerState?.isRunning === true && replayed.session.durations?.focusMinutes === 1 && replayed.session.durations?.breakMinutes === 1,
        '(4) the replay ran on the stored session: running, its 1/1 minutes kept');
    const replayAlert = { sessionID: replayed.sessionID, phase: 'focus', fireAtMs: Date.parse(replayed.session.phaseEndsAt) };
    await waitUntil('the replayed Start\'s alarm', () => armedAt(replayAlert) === 1, 15_000);
    check(pomodoroAlarms().length === 1 && book().armed.some((entry) => entry.id === pomodoroId(replayAlert)), '(4) one alarm is armed, and the journal is empty');
    nodes = await screen();
    await tapExpecting(await control('pomodoro-primary'), (current) => primary(current) === en['common.start'], 'Pause');
    await waitUntil('the alarm to go', () => pomodoroAlarms().length === 0, 15_000);
    check(true, '(4) Pause cancels it');

    // (8) The completion alert turned off while an alert is armed.
    nodes = await idleCard();
    const silenced = await startFocus(nodes);
    await waitUntil('the alarm', () => armedAt(silenced) === 1, 15_000);
    await openGtd(true);
    await setPomodoroSwitch(POMODORO.alert, false);
    await waitUntil('the alarm to go', () => pomodoroAlarms().length === 0, 15_000);
    check(!book().armed.some((entry) => entry.id === silenced.id), '(8) the alert turned off in Settings cancels the armed alarm');
    await sleep(Math.max(0, silenced.fireAtMs - Date.now()) + LATE_MS);
    check(shownOnce(silenced).length === 0 && pomodoroAlarms().length === 0, '(8) nothing shows after the phase end');
    await setPomodoroSwitch(POMODORO.alert, true);
    nodes = await toCard();
    await sleep(3000);
    check(shownOnce(silenced).length === 0 && pomodoroAlarms().length === 0, '(8) the alert on again on an ended phase: still nothing shows, nothing is armed');

    // (7) A force-stop mid-phase.
    nodes = await idleCard();
    const stopped = await startFocus(nodes);
    await waitUntil('the alarm', () => armedAt(stopped) === 1, 15_000);
    await device.stopApp();
    check(pomodoroAlarms().length === 0 && book().armed.some((entry) => entry.id === stopped.id), '(7) a force-stop drops the alarm (the book still lists it)');
    await launch();
    await waitUntil('the alarm armed again', () => armedAt(stopped) === 1, 20_000);
    check(pomodoroAlarms().length === 1 && book().alarm?.fireAtMs === stopped.fireAtMs, '(7) the next start arms the same alert again, at the same time');
    nodes = await toCard();
    await tapExpecting(await control('pomodoro-primary'), (current) => primary(current) === en['common.start'], 'Pause');
    await waitUntil('the alarm to go', () => pomodoroAlarms().length === 0, 15_000);

    // (5) Auto-start breaks with the app open: the focus alert still shows when the break starts at once.
    await openGtd(true);
    await setPomodoroSwitch(POMODORO.autoBreaks, true);
    nodes = await idleCard();
    const open = await startFocus(nodes);
    // The auto-started break of [focus]'s session once stored: it starts when core settles the focus phase (its end is read, not assumed).
    const breakOf = async (focus, timeoutMs) => {
        const state = await waitUntil('the auto-started break stored', () => {
            const { state: s } = pomodoro();
            return s?.sessionID === focus.sessionID && s.session?.timerState?.phase === 'break' && s.session.timerState.isRunning && s;
        }, timeoutMs, 2000);
        const alert = { sessionID: state.sessionID, phase: 'break', fireAtMs: Date.parse(state.session.phaseEndsAt) };
        return { ...alert, id: pomodoroId(alert) };
    };
    // The app stays open on Focus: the card settles the phase at 0, and the break's alarm is armed.
    const openBreak = await breakOf(open, Math.max(0, open.fireAtMs - Date.now()) + 30_000);
    await waitUntil('the break\'s alarm', () => armedAt(openBreak) === 1, 30_000, 2000);
    await waitUntil('the focus alert', () => shownOnce(open).length === 1, Math.max(0, open.fireAtMs - Date.now()) + LATE_MS);
    await sleep(3000);
    check(shownOnce(open).length === 1 && shownOnce(open)[0].text === en['pomodoro.focusComplete'], '(5) the break starts and the focus alert shows, once');
    check(openBreak.id !== open.id && book().armed.some((entry) => entry.id === openBreak.id) && pomodoroAlarms().length === 1,
        '(5) the break\'s alarm is armed at its end under another id');
    nodes = await toCard();
    await tapExpecting(await control('pomodoro-primary'), (current) => primary(current) === en['common.start'], 'Pause');
    await waitUntil('the break\'s alarm to go', () => pomodoroAlarms().length === 0, 15_000);
    check(true, '(5) Pause cancels the break\'s alarm');

    // (6) The screen off: the phase running then alerts at its end; the auto-started break alerts only once the app runs again.
    nodes = await idleCard();
    const dark = await startFocus(nodes);
    await waitUntil('the alarm', () => armedAt(dark) === 1, 15_000);
    sh('input keyevent KEYCODE_SLEEP');
    await waitUntil('the screen off', () => /mWakefulness=Asleep|mWakefulness=Dozing/.test(sh('dumpsys power')), 15_000);
    await waitUntil('the focus alert', () => shownOnce(dark).length === 1, Math.max(0, dark.fireAtMs - Date.now()) + LATE_MS);
    const darkLate = Date.now() - dark.fireAtMs;
    check(shownOnce(dark)[0].when === dark.fireAtMs && darkLate > -2000 && darkLate < LATE_MS,
        `(6) with the screen off the focus alert arrives at the phase end (${darkLate} ms after it), stamped with it`);
    await sleep(15_000);
    check(pomodoroAlarms().length === 0 && !book().armed.some((entry) => entry.sessionID === dark.sessionID && entry.phase === 'break'),
        '(6) the auto-started break gets no alarm while the screen is off and the app does not run (RN\'s background rule)');
    sh('input keyevent KEYCODE_WAKEUP');
    sh('wm dismiss-keyguard');
    const darkBreak = await breakOf(dark, 30_000);
    await waitUntil('the break\'s alarm once the app runs', () => armedAt(darkBreak) === 1, 30_000);
    check(Date.now() < darkBreak.fireAtMs, '(6) the screen on again resumes the app, which arms the break\'s alert at its end');
    await waitUntil('the break\'s alert', () => shownOnce(darkBreak).length === 1, Math.max(0, darkBreak.fireAtMs - Date.now()) + LATE_MS);
    check(shownOnce(darkBreak)[0].text === en['pomodoro.breakComplete'] && shownOnce(darkBreak)[0].when === darkBreak.fireAtMs,
        '(6) the break\'s alert arrives at its end, stamped with it');
    await waitFor('the break settled', (current) => primary(current) === en['common.start'], 30_000);

    // (9) A linked task's time after a process death right after the focus phase's end.
    await openGtd(true);
    await setPomodoroSwitch(POMODORO.linkTask, true);
    nodes = await idleCard();
    nodes = await tapExpecting(await control('pomodoro-link'), (current) => Boolean(tagged(current, 'pomodoro-picker')), 'the task picker');
    nodes = await waitFor('a Focus task in the picker', (current) => Boolean(tagged(current, 'pomodoro-task')), 20_000);
    await tapExpecting(await control('pomodoro-task'), (current) => !tagged(current, 'pomodoro-picker') && Boolean(tagged(current, 'pomodoro-done')), 'the first Focus task');
    const linked = await waitUntil('the linked task stored', () => pomodoro().state?.session?.selectedTaskId, 15_000);
    const before = pomodoro(linked).minutes ?? fail('the linked task is not in the database');
    nodes = await waitFor('the card', card, 15_000);
    const credited = await startFocus(nodes);
    await waitUntil('the journal to empty', () => journal().length === 0, 20_000);
    // The next commit is the phase end the open card settles: the process dies after core committed it, before the journal settled.
    setProp('journal_stop', 'after:pomodoroTransitionCommit');
    await waitUntil('the process to stop after the phase end committed', () => !pid(), Math.max(0, credited.fireAtMs - Date.now()) + 30_000, 500);
    setProp('journal_stop', '');
    check(journal().length === 1, '(9) the focus phase\'s end is committed and its journal entry left, as a process death right after it leaves it');
    await launch();
    await toCard();
    await waitUntil('the journal to empty', () => journal().length === 0, 20_000);
    const once = pomodoro(linked);
    check(once.minutes === before + 1 && once.state.session.sessionHistory?.totalCompletedFocusSessions >= 1,
        `(9) the replay gives the task its 1 focus minute once (${before} -> ${once.minutes})`);
    await killApp();
    await launch();
    await toCard();
    await sleep(3000);
    check(pomodoro(linked).minutes === before + 1, '(9) a further restart gives nothing more');
    nodes = await idleCard();
    nodes = await tapExpecting(await control('pomodoro-link'), (current) => Boolean(tagged(current, 'pomodoro-picker')), 'the task picker');
    await tapExpecting(await control('pomodoro-timer-only'), (current) => !tagged(current, 'pomodoro-picker') && !tagged(current, 'pomodoro-done'), 'Timer only');
    closeShade();

    console.log('Notifications device check passed');
} catch (error) {
    evidenced(error);
    try {
        console.log(`evidence - the app's Pomodoro log lines:\n${sh('logcat -d -v time -s MindwtrNativeDev:* AndroidRuntime:E').split('\n').filter((line) => /omodoro|journal|Exception|FATAL/i.test(line)).slice(-40).join('\n')}`);
    } catch { /* device gone */ }
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
