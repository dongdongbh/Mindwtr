


import { execFileSync } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { check, connect, evidenced, fail, inEditor, Stopped, tab, tagged } from './device.mjs';

const replacementOnly = process.argv.includes('--replacement-only');
const [serial, apkArg] = process.argv.slice(2).filter((arg) => arg !== '--replacement-only');
if (!serial) {
    console.error('usage: node check-reminders-device.mjs <adb-serial> [apk] [--replacement-only]');
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


const zone = sh('getprop persist.sys.timezone') || 'UTC';
const phoneNow = () => Number(sh('date +%s')) * 1000;
const local = (ms) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
};
const clock = (ms) => `${local(ms).date} ${local(ms).time}`;


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

const stored = (text) => sql(pullDb(), `SELECT id, status, rev, dueDate, recurrence FROM tasks WHERE title = '${text}' AND deletedAt IS NULL ORDER BY createdAt, id`);

const storedValue = (key) => {
    const dir = pull(['databases/RKStorage'], resolve(work, 'rkstorage'));
    const [row] = sql(resolve(dir, 'RKStorage'), `SELECT value FROM catalystLocalStorage WHERE key = '${key}'`);
    return row ? JSON.parse(row.value) : {};
};
const alarmMap = () => storedValue(MAP_KEY);

const nativeState = () => storedValue(STATE_KEY);

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


const editDb = (recurringId, reminders, repeatId) => {
    if (pid()) fail('the app must be stopped to edit its database');
    const db = pullDb();
    const before = execFileSync('bun', ['-e', `
        import { Database } from 'bun:sqlite';
        const db = new Database(process.env.CHECK_DB);
        const { value } = db.query("SELECT json_extract(data, '$.notificationsEnabled') AS value FROM settings WHERE id = 1").get() ?? {};
        if (process.env.CHECK_ID) db.query("UPDATE tasks SET recurrence = ? WHERE id = ?").run(JSON.stringify({ rule: 'daily', strategy: 'strict' }), process.env.CHECK_ID);
        if (process.env.CHECK_REPEAT_ID) db.query("UPDATE tasks SET repeatReminderMinutes = 5 WHERE id = ?").run(process.env.CHECK_REPEAT_ID);
        const setting = JSON.parse(process.env.CHECK_SETTING);
        if (setting === null) db.query("UPDATE settings SET data = json_remove(data, '$.notificationsEnabled') WHERE id = 1").run();
        else db.query("UPDATE settings SET data = json_set(data, '$.notificationsEnabled', json(?)) WHERE id = 1").run(String(setting));
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        db.close();
        console.log(value === undefined || value === null ? 'null' : String(Boolean(value)));
    `], { encoding: 'utf8', env: { ...process.env, CHECK_DB: db, CHECK_ID: recurringId ?? '', CHECK_REPEAT_ID: repeatId ?? '', CHECK_SETTING: JSON.stringify(reminders) } }).trim();
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

let reminderSetting;


const alarms = () => sh('dumpsys alarm').split(/\n(?=\s*(?:RTC_WAKEUP|RTC|ELAPSED_WAKEUP|ELAPSED) #\d+: Alarm\{)/)
    .filter((block) => block.includes(`*walarm*:${FIRE}`) && block.includes(PKG))
    .map((block) => ({ at: Number(/origWhen[= ](\d+)/.exec(block)?.[1] ?? NaN), exact: /\bwindow[= ]0\b/.test(block), block }));
const alarmsAt = (ms) => alarms().filter((alarm) => alarm.at === ms);


const notifications = () => sh('dumpsys notification --noredact').split(/\n(?=\s*NotificationRecord\()/)
    .filter((block) => block.includes(`pkg=${PKG}`))
    .map((block) => ({
        id: Number(/tech\.dongdongbh\.mindwtr\.reminderAlarmId=\w+ \((-?\d+)\)/.exec(block)?.[1] ?? /\bid=(-?\d+)/.exec(block)?.[1]),
        slotId: Number(/\bid=(-?\d+)/.exec(block)?.[1]),
        tag: /\btag=([^\s,)]+)/.exec(block)?.[1] ?? '',
        channel: /(?:mChannelId|channelId|channel)=([\w.-]+)/.exec(block)?.[1] ?? '',
        title: /android\.title=\w+ \((.*)\)/.exec(block)?.[1] ?? '',
        text: /android\.text=\w+ \((.*)\)/.exec(block)?.[1] ?? '',
        actions: [...block.matchAll(/^\s*\[\d+\] "([^"]*)"/gm)].map((m) => m[1]),
    }));
const shown = (text) => notifications().filter((item) => item.title === text);


const closeShade = () => sh('cmd statusbar collapse');


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
    for (let attempt = 0; !button && attempt < 3; attempt += 1) {


        const [x, y] = center(nodes.find((node) => node.text === text) ?? fail(`the notification "${text}" is no longer in the shade`));
        const expand = nodes.filter((node) => /\/expand_button$/.test(node['resource-id'] ?? '') && node.clickable === 'true'
            && node['content-desc'] === 'Expand' && Math.abs(center(node)[1] - y) < 140)
            .sort((left, right) => Math.abs(center(left)[1] - y) - Math.abs(center(right)[1] - y))[0];
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


const JOB_EVENT = new RegExp(`(START|STOP): #(\\S+) ${PKG.replaceAll('.', '\\.')}/androidx\\.work`, 'g');
const runningJobs = () => {
    const last = new Map();
    for (const [, event, job] of sh('dumpsys jobscheduler').matchAll(JOB_EVENT)) last.set(job, event);
    return [...last.values()].filter((event) => event === 'START').length;
};
const closeApp = async () => {
    if (front().includes(`${PKG}/`)) sh('input keyevent KEYCODE_HOME');
    await waitUntil('the app\'s running background jobs to finish', () => runningJobs() === 0, 120_000);
    const seen = pid();
    for (let attempt = 0; attempt < 20 && seen && pid() === seen; attempt += 1) {
        try { runAs(`kill -9 ${seen}`); } catch {                      }
        await sleep(500);
    }
    if (seen && pid() === seen) fail('the app process did not end');
};
const killApp = async () => {
    for (let round = 0; round < 6; round += 1) {
        await closeApp();
        await sleep(2000);
        if (!pid()) return;
    }
    fail('the app kept starting again after it was closed');
};
const CYCLE = 'Native Android reminder cycle';
const cycles = () => count(allLogs(), CYCLE);

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

const openTasks = new Set();
const restore = async () => {
    for (const name of PROPS) { try { setProp(name, ''); } catch {                   } }
    try { closeShade(); } catch {                   }
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
    try { if (!replacementOnly) sh(`appops set ${PKG} SCHEDULE_EXACT_ALARM ${exactMode}`); } catch {                   }
    try { if (front().includes(`${PKG}/`)) sh('input keyevent KEYCODE_HOME'); } catch {                   }
    try { if (!replacementOnly) sh(`settings put system accelerometer_rotation ${originalAccelerometer === 'null' ? 1 : originalAccelerometer}`); } catch {                   }
    try { sh(`rm -f ${UI_FILE} ${STAGED}`); } catch {                   }
};


const replacementCheck = async () => {
    check(/android\.permission\.POST_NOTIFICATIONS: granted=true/.test(sh(`dumpsys package ${PKG}`)), 'native Dev already has notification permission');
    console.log(`info - existing native Dev exact-alarm access: ${exactMode} (left unchanged)`);

    sh(`am force-stop ${PKG}`);
    await waitUntil('native Dev stopped before seeding', () => !pid());
    const at = Math.ceil((phoneNow() + 90_000) / 60_000) * 60_000;
    const names = [title(1), title(2)];
    for (const name of names) capture(`${name} /due:${clock(at)}`);
    await launchAndPlan();
    const ids = names.map((name) => stored(name)[0].id);
    ids.forEach((id) => openTasks.add(id));
    sh(`am force-stop ${PKG}`);
    await waitUntil('native Dev stopped before the database edit', () => !pid());
    reminderSetting = editDb(null, true, ids[0]);
    await launchAndPlan();
    const key = `task:${ids[0]}`;
    const map = alarmMap();
    const oldId = map[key]?.id;
    const latestId = map[`${key}:r1`]?.id;
    check(Number.isInteger(oldId) && Number.isInteger(latestId) && oldId !== latestId, 'base and due-repeat have distinct alarm ids');
    const expected = coreDetails([key, `${key}:r1`, `task:${ids[1]}`], at - 1000);
    const plannedAlarm = (alarmKey, id, fireAtMs) => ({ key: alarmKey, id, fireAtMs, repeat: 'once',
        details: expected[alarmKey], channelName: 'Mindwtr reminders', replacing: null });
    const postNative = (alarm, cancelId = 0) => {
        const text = JSON.stringify(alarm).replaceAll("'", "'\\''");
        sh(`am broadcast -f 0x20 -n ${RESCHEDULE} -a ${DEBUG_RESCHEDULE} --ei cancelReminderId ${cancelId} --es replacementAlarm '${text}'`);
    };
    console.log('info - injecting core-planned details through the native notification API; natural inexact alarm timing is not tested');
    postNative(plannedAlarm(key, oldId, at));
    postNative(plannedAlarm(`task:${ids[1]}`, map[`task:${ids[1]}`].id, at));
    sh('input keyevent KEYCODE_HOME');
    const [first] = await waitUntil('the injected base reminder', () => shown(names[0]).length ? shown(names[0]) : null);
    await waitUntil('the other task reminder', () => shown(names[1]).length === 1, 30_000);
    check(first.id === oldId && first.slotId === 1 && first.tag !== 'null', 'base notification uses its task tag and slot id 1');
    check(shown(names[1])[0].tag !== first.tag, 'different tasks have different notification slots');
    const marker = 'releaseCheck=v1.3.5/native-reminder-replacement operation=cancelled taggedRemoved=0';
    const cancellations = count(allLogs(), marker);

    postNative(plannedAlarm(`${key}:r1`, latestId, at + 300_000), oldId);
    await waitUntil('the immediate old alarm cancellation diagnostic', () => count(allLogs(), marker) > cancellations);
    const latest = await waitUntil('the due-repeat replacement after old-owner cancellation', () => shown(names[0]).find((item) => item.id === latestId));
    check(shown(names[0]).length === 1 && latest.tag === first.tag && latest.slotId === 1, 'due-repeat replaced the base notification in the same task slot');
    check(latest.channel === CHANNEL && latest.actions.join(',') === 'COMPLETE,SNOOZE,DISMISS', 'replacement retains the reminder channel and all latest actions');
    sh('cmd statusbar expand-notifications');
    await sleep(1500);
    writeFileSync(resolve(work, 'replacement-shade.png'), adbRaw('exec-out', 'screencap', '-p'));
    closeShade();
    check(shown(names[0]).length === 1 && shown(names[0])[0].id === latestId, 'cancelling the old alarm leaves its replacement visible');
    setProp('snooze_minutes', '0.25');
    const snoozes = () => count(allLogs(), 'Native Android core work', '"job":"reminderSnooze","outcome":"success"');
    const beforeSnooze = snoozes();
    await tapInShade(names[0], 'SNOOZE');
    await waitUntil('the latest Snooze action', () => snoozes() > beforeSnooze);
    closeShade();
    check(shown(names[0]).length === 0 && shown(names[1]).length === 1, 'Snooze removes only its current task slot');
    const [snoozeKey, snooze] = Object.entries(nativeState()).find(([, item]) => item.kind === 'snooze' && item.details?.data?.taskId === ids[0])
        ?? fail('Snooze did not persist its task alarm');
    check(snooze.armed && snooze.id >= 2 ** 30 && alarmsAt(snooze.fireAtMs).length === 1, 'Snooze persisted and armed one alarm under its new id');
    postNative({ key: snoozeKey, id: snooze.id, fireAtMs: snooze.fireAtMs, repeat: 'once', details: snooze.details, channelName: 'Mindwtr reminders' });
    const snoozed = await waitUntil('the injected snoozed reminder', () => shown(names[0]).find((item) => item.id === snooze.id));
    check(snoozed.tag === first.tag && shown(names[0]).length === 1, 'Snooze returns in the same task slot under its new alarm id');
    const beforeDone = stored(names[0])[0];
    await tapInShade(names[0], 'COMPLETE');
    await waitUntil('the latest Done action', () => stored(names[0])[0].status === 'done');
    closeShade();
    check(stored(names[0])[0].rev === beforeDone.rev + 1 && shown(names[0]).length === 0 && shown(names[1]).length === 1,
        'Done stores once and removes only its task notification');
    openTasks.delete(ids[0]);
    check(count(allLogs(), marker) > cancellations, 'fresh native cancellation diagnostic ran without removing the replacement');
    writeFileSync(resolve(work, 'replacement-check.log'), allLogs().split('\n').filter((line) => line.includes('releaseCheck=v1.3.5/native-reminder-replacement')).join('\n'));
    console.log('Reminder replacement device check passed');
};

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')}), zone ${zone}`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    for (const name of PROPS) setProp(name, '');
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    if (replacementOnly) {
        await replacementCheck();
    } else {
    sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`);

    sh(`appops set ${PKG} SCHEDULE_EXACT_ALARM deny`);
    await sleep(1500);
    await killApp();
    sh('logcat -c');


    const t0 = Math.ceil((phoneNow() + 4 * 60_000) / 60_000) * 60_000;
    const due = { A: t0, C: t0 + 60_000, D: t0 + 180_000, G: t0 + 180_000 };
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
    check(['A', 'C', 'D', 'G', 'H'].every((key) => Date.parse(stored(names[key])[0].dueDate) === due[key]), `(1) the timed tasks are due at ${clock(t0)}, +1 and +3 minutes (${zone})`);


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
            `${step} dumpsys alarm: one alarm at ${clock(due.A)}, one at +1 and three at +3 minutes (found ${atT.length}, ${atC.length}, ${atDG.length})`);
        if (exact !== undefined) check([...atT, ...atC, ...atDG].every((alarm) => alarm.exact === exact), `${step} each is ${exact ? 'exact' : 'inexact (exact alarms not allowed)'}`);
    };
    onePerTask('(1)', false);


    {
        const before = count(allLogs(), 'Native Android core work', '"job":"reminders","outcome":"success"');
        sh(`appops set ${PKG} SCHEDULE_EXACT_ALARM allow`);
        await waitUntil('the grant broadcast\'s remake', () => count(allLogs(), 'Native Android core work', '"job":"reminders","outcome":"success"') > before, 90_000);
        check(count(allLogs(), 'reminders reschedule action=android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED') >= 1,
            '(2) allowing exact alarms sends Android\'s grant broadcast to the reschedule receiver');
        onePerTask('(2)', true);
    }


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


        sh(`am force-stop ${PKG}`);
        await sleep(1500);
        check(alarms().length === 0, '(3) a second force-stop dropped every alarm');
        await launchAndPlan();
        await sleep(2000);
        check(allLogs().split('\n').filter((line) => line.includes(CYCLE)).at(-1)?.includes('"rebuild":true'), '(3) the start\'s first plan remade every alarm');
        onePerTask('(3 start)', true);
    }


    for (const [key, at] of [['E', 'write-ahead'], ['F', 'scheduled']]) {
        await killApp();
        const when = t0 + 24 * 3600_000 + (key === 'E' ? 0 : 60_000);
        capture(`${names[key]} /due:${clock(when)}`);
        setProp('reminder_stop', at);
        const stopLine = `Native Android reminder stop at=${at}`;
        const before = count(allLogs(), stopLine);
        let running = '';
        try {


            sh(`am broadcast -f 0x20 -n ${RESCHEDULE} -a ${DEBUG_RESCHEDULE}`);

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


    {
        await closeApp();
        await waitUntil(`the reminders for ${names.D}, ${names.G} and ${names.H}`,
            () => shown(names.D).length > 0 && shown(names.G).length > 0 && shown(names.H).length > 0, 150_000);
        await closeApp();
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
    }
} catch (error) {
    evidenced(error);
    try {
        console.error(`evidence - the app's reminder lines:\n${allLogs().split('\n').filter((line) => /[Rr]eminder|Local Notifications|core work|journal/.test(line)).slice(-25).join('\n')}`);
    } catch {                   }
    try {
        const system = execFileSync(adbBin, ['-s', serial, 'logcat', '-b', 'main,system,events', '-d', '-v', 'time'], { encoding: 'utf8', maxBuffer: 256 << 20 });
        console.error(`evidence - system process starts and deaths:\n${system.split('\n').filter((line) => line.includes(PKG) && /Start proc|am_proc_start|am_proc_died|am_kill|Killing|has died/.test(line)).slice(-12).join('\n')}`);
        console.error(`evidence - shade: ${JSON.stringify(notifications().map(({ id, tag, title }) => ({ id, tag, title })))}`);
        console.error(`evidence - group keys: ${sh('dumpsys notification --noredact').split(/\n(?=\s*NotificationRecord\()/).filter((block) => block.includes(`pkg=${PKG}`))
            .map((block) => /groupKey=(\S+)/.exec(block)?.[1] ?? '?').join(', ')}`);
        console.error(`evidence - alarms at ${phoneNow()}: ${JSON.stringify(alarms().map(({ at, exact }) => ({ at, exact })))}`);
    } catch {}
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    try {
        const system = execFileSync(adbBin, ['-s', serial, 'logcat', '-b', 'events', '-d', '-v', 'epoch'], { encoding: 'utf8', maxBuffer: 256 << 20 });
        const app = execFileSync(adbBin, ['-s', serial, 'logcat', '-d', '-v', 'epoch', '-s', `${TAG}:*`], { encoding: 'utf8', maxBuffer: 256 << 20 }).split('\n');
        for (const line of system.split('\n').filter((entry) => entry.includes('am_proc_start') && entry.includes(`,${PKG},`))) {
            const at = Number(line.trim().split(/\s+/)[0]);
            const [, pidText, , , reason] = /\[(?:\d+),(\d+),(\d+),([^,]+),([^,]+),/.exec(line) ?? [];
            const first = (marker) => app.find((entry) => entry.includes(marker) && entry.trim().split(/\s+/)[1] === pidText);
            const after = (marker) => { const hit = first(marker); return hit ? `${Math.round((Number(hit.trim().split(/\s+/)[0]) - at) * 1000)} ms` : 'none'; };
            console.log(`info - process ${pidText} for ${reason}: journal open ${after('Native Android journal open')}, replay ${after('Native Android journal replay')}`);
        }
        console.log(`info - jobs at the end: ${sh(`dumpsys jobscheduler ${PKG}`).split('\n').filter((line) => /JOB #|Pending|Running|Ready/.test(line)).slice(0, 12).join(' | ')}`);
    } catch (error) { console.log(`info - no boot timing (${error.message})`); }
    await restore();
}
