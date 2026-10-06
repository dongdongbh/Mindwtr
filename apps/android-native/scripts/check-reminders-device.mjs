// Reminder alarms check for the isolated native Android development app (pass B3, R1 native).
//
//   node apps/android-native/scripts/check-reminders-device.mjs <adb-serial> [apk]
//
// Installs the debug APK with `install -r` (existing development data stays) and checks, from `dumpsys alarm`, `dumpsys
// notification`, the shade, and the app's own files (the database, its journal and RN's RKStorage alarm map, pulled through
// run-as and read with sqlite3):
// (1) tasks queued while the app is closed (quick-add due times a few minutes ahead, and one with date-only start and due dates)
//     are planned at the next start: one alarm per timed task, at its due time, held in RN's alarm map under core's id; the
//     date-only task has none;
// (2) exact alarms: with Android's exact-alarm access off the alarms are inexact; allowing it (appops, development package only)
//     sends Android's grant broadcast, and CoreWork remakes every alarm exact, still one per task;
// (3) a reboot's loss: a force-stop drops every alarm (as a reboot does), and the reschedule receiver's path (its debug action,
//     the same CoreWork remake a reboot, a clock change or an update starts) arms each again, once; after a second force-stop
//     (as when the user revokes exact-alarm access: Android stops the app) a plain start remakes each too, once;
// (4) a process death after the plan's writeAhead is stored and before its alarm map is (debug property `reminder_stop`, both
//     at the writeAhead and after the alarms were made): the next start makes each pending alarm once, none lost, none twice;
// (5) a reminder fires once, on RN's channel `mindwtr_reminders_v2`, with core's title and text (core's own plan, run here on
//     the pulled database) and RN's buttons; the date-only task posts nothing;
// (6) Snooze (debug property `snooze_minutes` shortens RN's 10 minutes to 15 s): the notification goes, CoreWork makes core's
//     snooze alarm, and it fires again; then Done on it: CoreWork stores Done once (rev + 1) and the notification goes;
// (7) Done on a recurring task with the process killed after core's reply (debug property `journal_stop`): after the restart's
//     journal replay and CoreWork's retry, the task is done once and has exactly one next instance;
// (8) a delivered reminder whose task is completed before the next plan (a widget check-off while the app is closed) is withdrawn:
//     its notification goes (core's `withdrawn`), an expired one stays, remembered in the native reminder state; one completed
//     after that plan (its alarm already expired) is withdrawn too at the plan after the completion;
// (9) a tap on a task's reminder opens the app on that task's editor (core's routeNotificationOpen).
// At the end this run's open tasks are checked off through the queue, so no alarm of this run stays, and Android's exact-alarm
// access goes back to what it was. Titles are 87 + a 12-digit run id + one digit. It grants the development app the notification
// permission (kept, plan section 5). Visible notifications appear on the phone for a few minutes. It never launches over another
// app and leaves the device on its home screen. Exit 0 = pass, 1 = fail, 2 = refused before touching the device, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { check, connect, evidenced, fail, inEditor, Stopped, tab, tagged } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-reminders-device.mjs <adb-serial> [apk]');
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
const RESCHEDULE = `${PKG}/tech.dongdongbh.mindwtr.pilot.ReminderRescheduleReceiver`;
const DEBUG_RESCHEDULE = 'tech.dongdongbh.mindwtr.debug.RESCHEDULE_REMINDERS';
const FIRE = 'tech.dongdongbh.mindwtr.reminder.FIRE';
const CHANNEL = 'mindwtr_reminders_v2';
const TAG = 'MindwtrNativeDev';
const UI_FILE = '/data/local/tmp/mindwtr-native-dev-ui.xml';
const PROPS = ['reminder_stop', 'snooze_minutes', 'journal_stop'];
const DB = 'mindwtr-native-dev.db';
const QUEUE = 'files/pending-captures';
const MAP_KEY = 'mindwtr:local:alarms:v1';
const STATE_KEY = 'mindwtr:native:reminders:v1';
const STAGED = '/data/local/tmp/mindwtr-native-dev-reminders.db';
const work = resolve(app, 'android/build/reminders-check');
const coreSrc = resolve(app, '../../packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));
const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const title = (digit) => `87${run}${digit}`;

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, adbRaw, home, front, requireAppFront, pid, screen, waitFor } = device;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
const runAs = (command) => sh(`run-as ${PKG} sh -c '${command}'`);
const allLogs = () => execFileSync(adbBin, ['-s', serial, 'logcat', '-d', '-s', `${TAG}:*`], { encoding: 'utf8', maxBuffer: 64 << 20 }).replace(/\\/g, '');
const count = (text, ...needles) => text.split('\n').filter((line) => needles.every((needle) => line.includes(needle))).length;
const waitUntil = async (description, predicate, timeoutMs = 60_000, everyMs = 1000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await predicate();
        if (value) return value;
        if (Date.now() > deadline) fail(`timed out waiting for ${description}`);
        await sleep(everyMs);
    }
};

// ---- the phone's clock and time zone: quick-add reads a due time in the phone's local time ----
const zone = sh('getprop persist.sys.timezone') || 'UTC';
const phoneNow = () => Number(sh('date +%s')) * 1000;
const local = (ms) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
};
const clock = (ms) => `${local(ms).date} ${local(ms).time}`;

// ---- the app's files ----
const pull = (names, dir) => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const name of names) {
        const [folder, file] = [name.slice(0, name.lastIndexOf('/')), name.slice(name.lastIndexOf('/') + 1)];
        const present = runAs(`ls ${folder} 2>/dev/null || true`).split(/\s+/);
        for (const suffix of ['', '-wal', '-shm', '-journal']) if (present.includes(`${file}${suffix}`)) device.pull(`${name}${suffix}`, resolve(dir, `${file}${suffix}`));
    }
    return dir;
};
const sql = (file, query) => {
    const out = execFileSync('sqlite3', ['-json', file, query], { encoding: 'utf8' }).trim();
    return out ? JSON.parse(out) : [];
};
const pullDb = () => resolve(pull([`files/${DB}`], resolve(work, 'db')), DB);
/** The live tasks titled [text] as stored, oldest first. */
const stored = (text) => sql(pullDb(), `SELECT id, status, rev, dueDate, recurrence FROM tasks WHERE title = '${text}' AND deletedAt IS NULL ORDER BY createdAt, id`);
/** RN's alarm map in RN's RKStorage, as core's plan last stored it. */
const storedValue = (key) => {
    const dir = pull(['databases/RKStorage'], resolve(work, 'rkstorage'));
    const [row] = sql(resolve(dir, 'RKStorage'), `SELECT value FROM catalystLocalStorage WHERE key = '${key}'`);
    return row ? JSON.parse(row.value) : {};
};
const alarmMap = () => storedValue(MAP_KEY);
/** The native host's own reminder state (core's): delivered reminders it may still withdraw, and Snoozes. */
const nativeState = () => storedValue(STATE_KEY);
// The native host marks each signature as its own (native-host-contract-reminders.ts), so an RN recovery build trusts none.
const signedAt = (entry) => Date.parse(JSON.parse(entry?.signature?.replace(/^native:/, '') ?? '{}').fireAt ?? '');
const journal = () => runAs('ls files/journal 2>/dev/null || true').split(/\s+/).filter((name) => /^\d{16}\.json$/.test(name))
    .map((name) => JSON.parse(runAs(`cat files/journal/${name}`)));
const enqueue = (item) => {
    const text = JSON.stringify(item);
    const bytes = Buffer.from(text, 'utf8').toString('base64');
    runAs(`mkdir -p ${QUEUE} && echo ${bytes} | base64 -d > ${QUEUE}/${item.id}.tmp && mv ${QUEUE}/${item.id}.tmp ${QUEUE}/${item.id}.json`);
};
const capture = (text, extra = {}) => enqueue({ id: randomUUID(), title: text, createdAt: new Date().toISOString(), source: 'android-capture-intent', ...extra });
const checkOff = (taskId) => enqueue({ kind: 'complete', id: randomUUID(), taskId, completedAt: new Date().toISOString(), source: 'android-widget' });

/** Core's alarm details for [keys], from core's own plan over the pulled database at [nowMs] (RN replays the same plan, its parity fixture). */
const coreDetails = (keys, nowMs) => {
    const db = pullDb();
    const language = (sh('getprop persist.sys.locale') || 'en').split('-')[0];
    return JSON.parse(execFileSync('bun', ['-e', `
        import { Database } from 'bun:sqlite';
        import { SqliteAdapter } from '${coreSrc}/sqlite-adapter.ts';
        import { buildReminderAlarmDetails, planReminderAlarms } from '${coreSrc}/mobile-reminder-alarms.ts';
        import { loadTranslations } from '${coreSrc}/i18n/i18n-loader.ts';
        const db = new Database(process.env.CHECK_DB);
        const client = {
            run: async (sql, params = []) => { db.query(sql).run(...params); },
            all: async (sql, params = []) => db.query(sql).all(...params),
            get: async (sql, params = []) => db.query(sql).get(...params) ?? undefined,
            exec: async (sql) => { db.exec(sql); },
        };
        const data = await new SqliteAdapter(client).getData();
        const plan = planReminderAlarms({ settings: data.settings, tasks: data.tasks, projects: data.projects, now: new Date(Number(process.env.CHECK_NOW)),
            translations: await loadTranslations(process.env.CHECK_LANG), maxOneShotReminders: 200, alarms: new Map() });
        const keys = JSON.parse(process.env.CHECK_KEYS);
        console.log(JSON.stringify(Object.fromEntries([...plan.recurring, ...plan.oneShot].filter((request) => keys.includes(request.key))
            .map((request) => [request.key, buildReminderAlarmDetails(request.key, request.config)]))));
    `], { encoding: 'utf8', env: { ...process.env, TZ: zone, CHECK_DB: db, CHECK_NOW: String(nowMs), CHECK_LANG: ['en', 'zh', 'de', 'fr', 'es', 'ja'].includes(language) ? language : 'en', CHECK_KEYS: JSON.stringify(keys) } }).trim());
};

/**
 * With the app stopped: the database pulled, edited through Bun's SQLite (it has FTS5, which the tasks table's triggers need),
 * pushed back over the app's, its WAL removed. [recurringId] repeats daily; task reminders are set to [reminders] (null: the key
 * removed, as an unset setting). Answers the setting as it was.
 */
const editDb = (recurringId, reminders) => {
    if (pid()) fail('the app must be stopped to edit its database');
    const db = pullDb();
    const before = execFileSync('bun', ['-e', `
        import { Database } from 'bun:sqlite';
        const db = new Database(process.env.CHECK_DB);
        const { value } = db.query("SELECT json_extract(data, '$.notificationsEnabled') AS value FROM settings WHERE id = 1").get() ?? {};
        if (process.env.CHECK_ID) db.query("UPDATE tasks SET recurrence = ? WHERE id = ?").run(JSON.stringify({ rule: 'daily', strategy: 'strict' }), process.env.CHECK_ID);
        const setting = JSON.parse(process.env.CHECK_SETTING);
        if (setting === null) db.query("UPDATE settings SET data = json_remove(data, '$.notificationsEnabled') WHERE id = 1").run();
        else db.query("UPDATE settings SET data = json_set(data, '$.notificationsEnabled', json(?)) WHERE id = 1").run(String(setting));
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        db.close();
        console.log(value === undefined || value === null ? 'null' : String(Boolean(value)));
    `], { encoding: 'utf8', env: { ...process.env, CHECK_DB: db, CHECK_ID: recurringId ?? '', CHECK_SETTING: JSON.stringify(reminders) } }).trim();
    const next = `files/${DB}.reminders-new`;
    adbRaw('push', db, STAGED);
    try {
        runAs(`cp ${STAGED} ${next}`);
        if (Number(runAs(`stat -c %s ${next}`)) !== statSync(db).size) fail('the staged database has the wrong size');
        if (pid()) fail('the app started while its database was being replaced');
        runAs(`rm -f files/${DB}-wal files/${DB}-shm && mv -f ${next} files/${DB}`);
    } finally {
        sh(`rm -f ${STAGED}`);
    }
    return JSON.parse(before);
};
/** Task reminders as the development data had them before this run (undefined: not changed yet). */
let reminderSetting;

// ---- the system's view: this app's reminder alarms and notifications ----
/** This app's pending reminder alarms: when each fires (ms) and whether it is exact (`dumpsys alarm`). */
const alarms = () => sh('dumpsys alarm').split(/\n(?=\s*(?:RTC_WAKEUP|RTC|ELAPSED_WAKEUP|ELAPSED) #\d+: Alarm\{)/)
    .filter((block) => block.includes(`*walarm*:${FIRE}`) && block.includes(PKG))
    .map((block) => ({ at: Number(/origWhen[= ](\d+)/.exec(block)?.[1] ?? NaN), exact: /\bwindow[= ]0\b/.test(block), block }));
const alarmsAt = (ms) => alarms().filter((alarm) => alarm.at === ms);
/**
 * This app's notifications (`dumpsys notification --noredact`): id, channel, title, text and button labels. A reminder's id is the
 * alarm it was posted for (CoreNotifications' extra): every reminder of a task shares one slot (tag, id 1), the latest replacing the last.
 */
const notifications = () => sh('dumpsys notification --noredact').split(/\n(?=\s*NotificationRecord\()/)
    .filter((block) => block.includes(`pkg=${PKG}`))
    .map((block) => ({
        id: Number(/tech\.dongdongbh\.mindwtr\.reminderAlarmId=\w+ \((-?\d+)\)/.exec(block)?.[1] ?? /\bid=(-?\d+)/.exec(block)?.[1]),
        channel: /(?:mChannelId|channelId|channel)=([\w.-]+)/.exec(block)?.[1] ?? '',
        title: /android\.title=\w+ \((.*)\)/.exec(block)?.[1] ?? '',
        text: /android\.text=\w+ \((.*)\)/.exec(block)?.[1] ?? '',
        actions: [...block.matchAll(/^\s*\[\d+\] "([^"]*)"/gm)].map((m) => m[1]),
    }));
const shown = (text) => notifications().filter((item) => item.title === text);

// ---- the shade ----
const closeShade = () => sh('cmd statusbar collapse');
/**
 * Taps [label] (a button) on the notification titled [text] in the shade, expanding it first when its buttons are folded; or the
 * notification itself when [label] is null.
 */
const tapInShade = async (text, label) => {
    sh('cmd statusbar expand-notifications');
    await sleep(1500);
    let nodes = await screen();
    const center = (node) => node.bounds.match(/\d+/g).map(Number).reduce((acc, value, index) => { acc[index % 2] += value / 2; return acc; }, [0, 0]);
    const titleNode = nodes.find((node) => node.text === text) ?? fail(`the notification "${text}" is not in the shade`);
    if (!label) {
        const [x, y] = center(titleNode);
        sh(`input tap ${Math.round(x)} ${Math.round(y)}`);
        return;
    }
    const near = (current) => {
        const titleAt = current.find((node) => node.text === text);
        if (!titleAt) return null;
        const [, y] = center(titleAt);
        return current.find((node) => (node.text ?? '').toUpperCase() === label && node.clickable === 'true' && center(node)[1] > y && center(node)[1] < y + 500)
            ?? current.find((node) => (node.text ?? '').toUpperCase() === label && center(node)[1] > y && center(node)[1] < y + 500);
    };
    let button = near(nodes);
    if (!button) {
        // Folded: Android's expand button on that notification's row, else a downward drag on its title.
        const [x, y] = center(titleNode);
        const expand = nodes.find((node) => /expand_button|expand_button_touch/.test(node['resource-id'] ?? '') && Math.abs(center(node)[1] - y) < 120);
        if (expand) sh(`input tap ${Math.round(center(expand)[0])} ${Math.round(center(expand)[1])}`);
        else sh(`input swipe ${Math.round(x)} ${Math.round(y)} ${Math.round(x)} ${Math.round(y + 400)} 300`);
        await sleep(1200);
        nodes = await screen();
        button = near(nodes);
    }
    if (!button) fail(`no ${label} button on "${text}" in the shade`);
    const [x, y] = center(button);
    sh(`input tap ${Math.round(x)} ${Math.round(y)}`);
};

// ---- the process ----
/** The app's process gone, as after the system reclaimed it: a signal, never a force-stop (that drops every alarm and job). */
const killApp = async () => {
    if (front().includes(`${PKG}/`)) sh('input keyevent KEYCODE_HOME');
    for (let attempt = 0; attempt < 20 && pid(); attempt += 1) {
        try { runAs(`kill -9 ${pid()}`); } catch { /* gone meanwhile */ }
        await sleep(500);
    }
    if (pid()) fail('the app process did not end');
};
const CYCLE = 'Native Android reminder cycle';
const cycles = () => count(allLogs(), CYCLE);
/** Launches the app and waits for its first reminder plan after the boot (the start's cycle). */
const launchAndPlan = async () => {
    const before = cycles();
    device.launch(ACTIVITY);
    await waitUntil('the start\'s reminder plan', () => cycles() > before, 60_000);
};
const toTabs = async () => {
    for (let step = 0; step < 8; step += 1) {
        const nodes = await screen();
        if (tab(nodes, en['tab.menu']) && !tagged(nodes, 'menu-screen') && !tagged(nodes, 'more-sheet') && !inEditor(nodes) && !tagged(nodes, 'global-search')) return nodes;
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(1000);
    }
    return fail('the tabs did not come back');
};

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const exactMode = /SCHEDULE_EXACT_ALARM: (\w+)/.exec(sh(`appops get ${PKG} SCHEDULE_EXACT_ALARM`))?.[1] ?? 'default';
/** This run's tasks that may still hold an alarm, checked off at the end. */
const openTasks = new Set();
const restore = async () => {
    for (const name of PROPS) { try { setProp(name, ''); } catch { /* device gone */ } }
    try { closeShade(); } catch { /* device gone */ }
    try {
        if (openTasks.size > 0) {
            await killApp();
            for (const id of openTasks) checkOff(id);
            await launchAndPlan();
            await sleep(4000);
            const map = alarmMap();
            const left = [...openTasks].filter((id) => Object.keys(map).some((key) => key.startsWith(`task:${id}`)));
            if (left.length > 0) console.error(`RESTORE: ${left.length} of this run's tasks still hold an alarm: ${left.join(', ')}`);
        }
    } catch (error) { console.error(`RESTORE: this run's tasks were not checked off (${error.message}); they may still post a reminder`); }
    try {
        if (reminderSetting !== undefined && reminderSetting !== true) {
            await killApp();
            editDb(null, reminderSetting);
            await launchAndPlan();
            reminderSetting = undefined;
        }
    } catch (error) { console.error(`RESTORE FAILED: task reminders are still on in the development data (${error.message})`); process.exitCode = 1; }
    try { sh(`appops set ${PKG} SCHEDULE_EXACT_ALARM ${exactMode}`); } catch { /* device gone */ }
    try { if (front().includes(`${PKG}/`)) sh('input keyevent KEYCODE_HOME'); } catch { /* device gone */ }
    try { sh(`settings put system accelerometer_rotation ${originalAccelerometer === 'null' ? 1 : originalAccelerometer}`); } catch { /* device gone */ }
    try { sh(`rm -f ${UI_FILE} ${STAGED}`); } catch { /* device gone */ }
};

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')}), zone ${zone}`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    for (const name of PROPS) setProp(name, '');
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`);
    // Exact alarms off for (1) and (2) (Android 14 gives a new install none); this run sets the access back at the end.
    sh(`appops set ${PKG} SCHEDULE_EXACT_ALARM deny`);
    await sleep(1500);
    await killApp();
    sh('logcat -c');

    // (1) Tasks queued while the app is closed are planned at the next start.
    const t0 = Math.ceil((phoneNow() + 4 * 60_000) / 60_000) * 60_000;
    const due = { A: t0, C: t0 + 60_000, D: t0 + 120_000, G: t0 + 120_000 };
    const names = { A: title(1), B: title(2), C: title(3), D: title(4), G: title(5), E: title(6), F: title(7), H: title(8) };
    due.H = due.D;
    for (const key of ['A', 'C', 'D', 'G', 'H']) capture(`${names[key]} /due:${clock(due[key])}`);
    const tomorrow = local(t0 + 24 * 3600_000).date;
    capture(names.B, { dueDate: tomorrow, startDate: tomorrow });
    await launchAndPlan();
    const ids = {};
    for (const key of ['A', 'B', 'C', 'D', 'G', 'H']) {
        const rows = stored(names[key]);
        if (rows.length !== 1) fail(`(1) ${names[key]} is stored ${rows.length} times`);
        ids[key] = rows[0].id;
        openTasks.add(ids[key]);
    }
    check(['A', 'C', 'D', 'G', 'H'].every((key) => Date.parse(stored(names[key])[0].dueDate) === due[key]), `(1) the timed tasks are due at ${clock(t0)}, +1 and +2 minutes (${zone})`);
    // C repeats daily, and task reminders are on: both set in the database while the app is closed, as a synced edit would
    // arrive (Settings › Notifications comes with pass R2). The setting goes back at the end.
    {
        await killApp();
        reminderSetting = editDb(ids.C, true);
        await launchAndPlan();
        check(JSON.parse(stored(names.C)[0].recurrence ?? 'null')?.rule === 'daily', `(1) ${names.C} repeats daily; task reminders are on (they were ${reminderSetting ?? 'unset'})`);
    }
    await sleep(3000);
    let map = alarmMap();
    const keyOf = (key) => `task:${ids[key]}`;
    check(['A', 'C', 'D', 'G', 'H'].every((key) => Number.isInteger(map[keyOf(key)]?.id) && !map[keyOf(key)].pending && signedAt(map[keyOf(key)]) === due[key]),
        '(1) RN\'s alarm map holds each timed task under core\'s id, at its due time, none pending');
    check(!Object.keys(map).some((key) => key.includes(ids.B)), '(1) the task with only date-only dates holds no alarm');
    const onePerTask = (step, exact) => {
        const atT = alarmsAt(due.A);
        const atC = alarmsAt(due.C);
        const atDG = alarmsAt(due.D);
        check(atT.length === 1 && atC.length === 1 && atDG.length === 3,
            `${step} dumpsys alarm: one alarm at ${clock(due.A)}, one at +1 and three at +2 minutes (found ${atT.length}, ${atC.length}, ${atDG.length})`);
        if (exact !== undefined) check([...atT, ...atC, ...atDG].every((alarm) => alarm.exact === exact), `${step} each is ${exact ? 'exact' : 'inexact (exact alarms not allowed)'}`);
    };
    onePerTask('(1)', false);

    // (2) Exact alarms allowed: Android's grant broadcast, then CoreWork remakes every alarm exact.
    {
        const before = count(allLogs(), 'Native Android core work', '"job":"reminders","outcome":"success"');
        sh(`appops set ${PKG} SCHEDULE_EXACT_ALARM allow`);
        await waitUntil('the grant broadcast\'s remake', () => count(allLogs(), 'Native Android core work', '"job":"reminders","outcome":"success"') > before, 90_000);
        check(count(allLogs(), 'reminders reschedule action=android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED') >= 1,
            '(2) allowing exact alarms sends Android\'s grant broadcast to the reschedule receiver');
        onePerTask('(2)', true);
    }

    // (3) A reboot drops every alarm; the reschedule receiver's path arms each again, once.
    {
        sh(`am force-stop ${PKG}`);
        await sleep(1500);
        check(alarms().length === 0, '(3) a force-stop dropped every alarm, as a reboot does');
        const before = count(allLogs(), 'Native Android core work', '"job":"reminders","outcome":"success"');
        sh(`am broadcast -f 0x20 -n ${RESCHEDULE} -a ${DEBUG_RESCHEDULE}`);
        await waitUntil('the reschedule job', () => count(allLogs(), 'Native Android core work', '"job":"reminders","outcome":"success"') > before, 90_000, 2000);
        check(!front().includes(`${PKG}/`), '(3) the remake ran in the background, with no screen');
        onePerTask('(3)', true);
        map = alarmMap();
        check(['A', 'C', 'D', 'G', 'H'].every((key) => !map[keyOf(key)]?.pending), '(3) the map holds each again, none pending');
        // Revoking exact-alarm access stops the app and drops its exact alarms, as a force-stop does; no broadcast comes after it.
        // The process's first plan remakes every alarm.
        sh(`am force-stop ${PKG}`);
        await sleep(1500);
        check(alarms().length === 0, '(3) a second force-stop dropped every alarm');
        await launchAndPlan();
        await sleep(2000);
        check(allLogs().split('\n').filter((line) => line.includes(CYCLE)).at(-1)?.includes('"rebuild":true'), '(3) the start\'s first plan remade every alarm');
        onePerTask('(3 start)', true);
    }

    // (4) A process death after the writeAhead and before the alarm map: the next start makes each pending alarm once.
    for (const [key, at] of [['E', 'write-ahead'], ['F', 'scheduled']]) {
        await killApp();
        const when = t0 + 24 * 3600_000 + (key === 'E' ? 0 : 60_000);
        capture(`${names[key]} /due:${clock(when)}`);
        setProp('reminder_stop', at);
        const stopLine = `Native Android reminder stop at=${at}`;
        const before = count(allLogs(), stopLine);
        let running = '';
        try {
            // A boot with no screen (the reschedule receiver's job): Android restarts no activity after the process dies, so the
            // reads below see the state the death left. The boot's own plan stops first.
            sh(`am broadcast -f 0x20 -n ${RESCHEDULE} -a ${DEBUG_RESCHEDULE}`);
            // The process that logs the stop is the one seen last before its line; it is gone once pid() names another or none.
            await waitUntil(`the stop at ${at}`, () => {
                if (count(allLogs(), stopLine) === before) {
                    running = pid() || running;
                    return false;
                }
                return Boolean(running) && pid() !== running;
            }, 60_000, 100);
        } finally {
            setProp('reminder_stop', '');
        }
        // Read at once: the system may restart the app by itself, and its plan must not have run before these reads.
        const cyclesAtStop = cycles();
        const pending = alarmMap();
        const madeAtStop = alarmsAt(when).length;
        if (cycles() !== cyclesAtStop) fail(`(4 ${at}) a restarted app planned before the reads; rerun the check`);
        const [task] = stored(names[key]);
        ids[key] = task.id;
        openTasks.add(task.id);
        const entryAtStop = pending[`task:${task.id}`];
        check(entryAtStop?.pending === true && signedAt(entryAtStop) === when, `(4 ${at}) the writeAhead holds the new alarm, pending`);
        check(madeAtStop === (at === 'scheduled' ? 1 : 0), `(4 ${at}) the alarm is ${at === 'scheduled' ? 'made' : 'not made yet'} when the process dies`);
        if (pid()) {
            await waitUntil('the restarted app\'s plan', () => cycles() > cyclesAtStop, 60_000);
        } else {
            await waitFor('the home screen or the app', () => front().includes(`${home}/`) || front().includes(`${PKG}/`), 15_000);
            await launchAndPlan();
        }
        await sleep(2000);
        const entry = alarmMap()[`task:${task.id}`];
        check(entry && !entry.pending && entry.id === entryAtStop.id, `(4 ${at}) the next start keeps core's id and stores the map: no longer pending`);
        check(alarmsAt(when).length === 1, `(4 ${at}) exactly one alarm: none lost, none twice`);
    }
    onePerTask('(4)', true);
    await killApp();

    // (5) The first reminder fires once, on RN's channel, with core's title and text and RN's buttons.
    const expected = coreDetails(['A', 'C', 'D', 'G', 'H'].map(keyOf), t0 - 60_000);
    check(Object.keys(expected).length === 5, '(5) core\'s plan on the pulled database names the five reminders');
    setProp('snooze_minutes', '0.25');
    {
        const wait = due.A + 3000 - phoneNow();
        console.log(`info - waiting ${Math.round(wait / 1000)} s for ${clock(due.A)}`);
        await sleep(Math.max(0, wait));
        const [first] = await waitUntil(`the reminder for ${names.A}`, () => (shown(names.A).length > 0 ? shown(names.A) : null), 60_000);
        const details = expected[keyOf('A')];
        check(first.channel === CHANNEL, `(5) it is on RN's channel ${CHANNEL}`);
        check(first.title === details.title && first.text === details.message, `(5) title and text are core's: "${first.title}", "${first.text}"`);
        check(JSON.stringify(first.actions) === JSON.stringify(['COMPLETE', 'SNOOZE', 'DISMISS']), `(5) RN's buttons: ${first.actions.join(', ')}`);
        check(first.id === map[keyOf('A')].id, '(5) under core\'s alarm id');
        await sleep(8000);
        check(shown(names.A).length === 1, '(5) it fired once, and the plan after it (expired) kept it in the tray');
        check(shown(names.B).length === 0, '(5) the date-only task posts nothing');
    }

    // (6) Snooze, then Done on the snoozed reminder.
    {
        const jobs = () => count(allLogs(), 'Native Android core work', '"job":"reminderSnooze","outcome":"success"');
        const before = jobs();
        await tapInShade(names.A, 'SNOOZE');
        await waitUntil('Snooze\'s job', () => jobs() > before, 60_000);
        closeShade();
        check(shown(names.A).length === 0, '(6) Snooze took the notification away');
        const snoozed = alarms().filter((alarm) => alarm.at > phoneNow() && alarm.at < phoneNow() + 20_000);
        check(snoozed.length === 1, '(6) CoreWork made one snooze alarm, about 15 s ahead');
        const [again] = await waitUntil('the snoozed reminder', () => (shown(names.A).length > 0 ? shown(names.A) : null), 60_000);
        check(again.id >= 2 ** 30 && again.title === expected[keyOf('A')].title, `(6) the snoozed reminder fired again under core's snooze id (${again.id})`);
        const [beforeDone] = stored(names.A);
        const done = () => count(allLogs(), 'Native Android core work', '"job":"reminderDone","outcome":"success"');
        const doneBefore = done();
        await tapInShade(names.A, 'COMPLETE');
        await waitUntil('Done\'s job', () => done() > doneBefore, 60_000);
        closeShade();
        const [after] = stored(names.A);
        check(after.status === 'done' && after.rev === beforeDone.rev + 1, `(6) Done stored once (rev ${beforeDone.rev} → ${after.rev})`);
        check(shown(names.A).length === 0 && journal().length === 0, '(6) the notification is gone and the journal is empty');
        openTasks.delete(ids.A);
    }

    // (7) Done on a recurring reminder, the process killed after core's reply: one next instance after the replay and the retry.
    {
        await waitUntil(`the reminder for ${names.C}`, () => shown(names.C).length > 0, 120_000);
        const [beforeDone] = stored(names.C);
        const replays = () => allLogs().split('\n').filter((line) => line.includes('Native Android journal replay sent='));
        const done = () => count(allLogs(), 'Native Android core work', '"job":"reminderDone","outcome":"success"');
        const [replaysBefore, doneBefore] = [replays().length, done()];
        setProp('journal_stop', 'after:reminderDone');
        const stops = () => count(allLogs(), 'Native Android journal stop at=after op=reminderDone');
        const before = stops();
        try {
            await tapInShade(names.C, 'COMPLETE');
            await waitUntil('the stop after core\'s reply', () => stops() > before, 60_000, 200);
        } finally {
            setProp('journal_stop', '');
        }
        closeShade();
        const atStop = stored(names.C);
        check(atStop.length === 2 && atStop[0].status === 'done' && atStop[0].rev === beforeDone.rev + 1 && atStop[1].status !== 'done',
            '(7) core replied: the task is done once, with one next instance, and the process died before the entry settled');
        // Android may restart the process at once (CoreWork's job service), and its boot replays the entry: on disk, or replayed.
        check(journal().some((entry) => entry.method === 'reminderDone') || replays().length > replaysBefore,
            '(7) the Done request outlived the process: the journal holds it, or the next boot replayed it');
        if (!pid()) {
            await waitFor('the home screen or the app', () => front().includes(`${home}/`) || front().includes(`${PKG}/`), 15_000);
            device.launch(ACTIVITY);
        }
        await waitUntil('the next boot\'s journal replay', () => replays().length > replaysBefore, 60_000);
        const replay = replays().slice(replaysBefore).find((line) => !line.includes('sent=0')) ?? '';
        check(/sent=1 dropped=1 left=0 owed=none/.test(replay), `(7) the next boot replayed the Done request once and dropped it after core's reply: ${replay.split('journal replay ')[1] ?? 'none'}`);
        await waitUntil('CoreWork\'s retry of the Done job', () => done() > doneBefore, 180_000, 2000);
        await sleep(3000);
        const after = stored(names.C);
        check(after.length === 2 && after[0].rev === atStop[0].rev && after[1].id === atStop[1].id && journal().length === 0,
            `(7) after the replay and CoreWork's retry (answered from core's receipt): still done once and exactly one next instance, the journal empty`);
        openTasks.delete(ids.C);
        openTasks.add(after[1].id);
        sh('input keyevent KEYCODE_HOME');
    }

    // (8) A delivered reminder whose task is completed before the next plan is withdrawn: the app is closed when D fires (no plan
    // runs after it), a widget check-off completes D, and the next start drains it before its plan, which withdraws D's alarm and
    // removes its notification. That plan lets G's and H's alarms expire and remembers them (core's native state); H completed
    // after it is withdrawn at the plan after its completion (RN keeps such a notification: reported in the pass result).
    // (9) A tap on a reminder opens its task.
    {
        await killApp();
        await waitUntil(`the reminders for ${names.D}, ${names.G} and ${names.H}`,
            () => shown(names.D).length > 0 && shown(names.G).length > 0 && shown(names.H).length > 0, 150_000);
        await killApp();
        check(alarmMap()[keyOf('D')]?.id === map[keyOf('D')].id, '(8) D fired with the app closed: its alarm is still held');
        checkOff(ids.D);
        const withdrawals = () => allLogs().split('\n').filter((line) => line.includes(CYCLE) && /"withdrawn":[1-9]/.test(line)).length;
        const withdrawnBefore = withdrawals();
        await launchAndPlan();
        await waitUntil('the start\'s plan to withdraw the delivered reminder', () => shown(names.D).length === 0, 30_000);
        check(stored(names.D)[0].status === 'done', `(8) the check-off completed ${names.D} at the start`);
        check(withdrawals() > withdrawnBefore, '(8) core\'s plan withdrew its alarm, and its delivered reminder is gone');
        check(shown(names.G).length === 1 && shown(names.H).length === 1, '(8) the other delivered reminders (only expired) stay');
        await sleep(2000);
        const remembered = nativeState();
        check(['G', 'H'].every((key) => remembered[keyOf(key)]?.kind === 'delivered' && remembered[keyOf(key)].id === map[keyOf(key)].id)
            && !alarmMap()[keyOf('H')], '(8) their alarms expired from the map, and core\'s native state remembers both under their ids');
        openTasks.delete(ids.D);
        await killApp();
        checkOff(ids.H);
        await launchAndPlan();
        await waitUntil(`the plan to withdraw ${names.H}`, () => shown(names.H).length === 0, 30_000);
        check(stored(names.H)[0].status === 'done' && !nativeState()[keyOf('H')], `(8) ${names.H}, completed after its alarm expired, is withdrawn from the tray and forgotten`);
        check(shown(names.G).length === 1, '(8) G stays');
        openTasks.delete(ids.H);
        await toTabs();
        sh('input keyevent KEYCODE_HOME');
        await sleep(1000);
        await tapInShade(names.G, null);
        await waitUntil('the app in front', () => front().includes(`${PKG}/`), 20_000);
        await waitFor(`the editor of ${names.G}`, (current) => inEditor(current) && current.some((node) => node.text === names.G), 30_000);
        check(true, `(9) a tap on the reminder opened the app on ${names.G}'s editor`);
        check(shown(names.G).length === 0, '(9) the tapped notification is gone (auto-cancel)');
        await toTabs();
    }

    console.log('Reminders device check passed');
} catch (error) {
    evidenced(error);
    try {
        console.error(`evidence - the app's reminder lines:\n${allLogs().split('\n').filter((line) => /[Rr]eminder|Local Notifications|core work|journal/.test(line)).slice(-25).join('\n')}`);
    } catch { /* device gone */ }
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
