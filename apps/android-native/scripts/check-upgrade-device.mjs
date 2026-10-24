// Upgrade check: a real RN v1.3.2 install, replaced in place by the native
// upgradetest build, then by a newer RN recovery build.
//
//   node apps/android-native/scripts/build-upgrade-harness.mjs
//   node apps/android-native/scripts/check-upgrade-device.mjs <adb-serial> [--only=1,4,2,4b,2b,3,3b,5,5b,6,7,8,9,9b,9c,10,11] [--keep]
//
// Scenarios, each from a fresh RN v1.3.2 install:
//   1   happy upgrade: the native app shows the RN data, imports the capture RN
//       left queued once at its first boot, captures once, keeps every
//       pre-upgrade row and every other non-database file, and leaves a
//       .prewrite checkpoint that holds the pre-upgrade rows. In RKStorage only
//       RN's alarm map (the reminder alarms) and RN's prompt state may change, after the byte checkpoint the boot takes;
//       RN's About, heartbeat and prompt keys carry over (pass O1): RN's update dot shows on the native
//       Settings menu, the prompt state keeps RN's days and adds today, the anonymous id stays;
//   4   recovery (continues 1): the RN 154 build opens the database and keeps
//       the native edit and the native import. While the recovery source is v1.3.2 a failure is
//       reported as BLOCKED (RN startup snapshot bug) and does not fail the run;
//   2   json-ahead import: RN's JSON backup holds a task SQLite never took and
//       the json-ahead marker is set. The native app imports the task once,
//       clears the marker after a byte checkpoint of RKStorage, changes nothing
//       else, and imports nothing on a relaunch;
//   4b  recovery after the import (continues 2): RN 154 shows the imported task
//       once and, with its marker gone, imports nothing again;
//   2b  json-ahead marker with a corrupt backup: RN would abandon it (#964), but core's
//       stricter preflight (legacyCheck) refuses before the RN database opens: the
//       native app shows core's refusal and changes no file, the marker included; it
//       only adds the RKStorage byte checkpoint the passed guard takes;
//   3   damaged database, empty WAL: the native app changes no file;
//   3b  damaged database with WAL frames: the native app changes no file;
//   5   database missing, no JSON backup, other RN state present: the native app creates nothing;
//   5b  database missing with RN's JSON backup: the native app migrates it; every persisted
//       field of every entity and the settings equal core's plan for the backup;
//   6   an RN user's WebDAV sync: RN v1.3.2 configures WebDAV in its own Sync screen against a local
//       folder (sync-harness.mjs, through adb reverse); the native app finds RN's keys in RKStorage and
//       the password in RN's secret store, shows them on its Sync screen, and syncs with them. RN's background sync
//       worker (EXPO_BACKGROUND_WORKER in WorkManager's database) is gone after the native app's first start, and the
//       native background sync job is scheduled once (pass S4a).
//   7   an RN user's reminder alarms (task reminders turned on in RN's database): RN v1.3.2 sets its alarm for a task due in two hours (`dumpsys alarm`: one alarm to its
//       library's AlarmReceiver); the native app's first start cancels it, deletes RN's alarm database and map, and sets its own
//       alarm for the same task: RN's gone, the native one present, once each. Then the RN 154 recovery build over the native
//       app: it reads the native app's map under RN's key, holds none of its alarms, and sets its own alarm for the task, once.
//   8   an RN user's widget check-off still in its Undo file (files/mindwtr-widget-checkoff-pending.json,
//       RN's PendingCheckoffStore format) when the native app replaces RN: the native app's first boot
//       completes that task once, through the queue, and a relaunch writes nothing more.
//   9   an RN user's running Pomodoro timer, folded card and persistent capture notification (pass R2): RN v1.3.2, through its own
//       screens (Settings › GTD › Pomodoro turns the feature on, Settings › Notifications the capture switch), starts the timer
//       from its Focus card and folds it; its alarm is set. The native app's first start (pass R2b) adopts RN's session into its
//       own (native_pomodoro_session: same phase, end and minutes) and shows the card folded and running; it keeps RN's session,
//       fold and Pomodoro record byte for byte, cancels RN's alarm with RN's others (R1), arms its own Pomodoro alarm at the same
//       phase end, once (core's record in shared_prefs/mindwtr_pomodoro_alarms.xml names it), and shows no alert, since RN's was
//       not yet due; the persistent capture notification is shown. Then RN 154 over the native app holds no native reminder alarm.
//   9b  RN's alert due after the update (design R2b §3b K6): RN v1.3.2 with 1-minute focus and break starts the timer; the native
//       app is installed over it before the phase ends and opened only after RN's alarm time, so RN's receiver (gone) never
//       showed it. The native first start shows RN's focus alert once with core's words and records it in its ledger; the adopted
//       session settles the ended phase and arms nothing; a second start posts it no second time.
//   9c  an RN build with the alarm re-arm fix (RN 155, 45dff1573) installed over the native app mid-phase: RN v1.3.2 runs a
//       2-minute focus, the native app adopts it and arms its own alarm, then RN 155 arms its alarm again (the library no longer
//       held it), and RN's focus alert arrives at the phase end, once.
//   11  an RN user's File Sync folder (pass S5): RN v1.3.2 picks Download/mts5u<run> in its own Sync screen (File, Select
//       Folder, the system folder picker) and syncs into it. The native app shows RN's folder on its Sync screen, and its Sync
//       now writes into data.json (a capture RN left queued, which the native boot imports) with no new pick: RN's grant is
//       still held, and files/file-sync-root-authorities/ still holds RN's one authority lock file, under the same name.
// In 1, 2 and 5b the native app also publishes RN's home-screen widget payload (shared_prefs/mindwtr_widget.xml,
// pass W1): that one other file may change, and only as RN's format with its one `payload` key, the value equal to
// core's publication on a copy of the database the app left (host-side core with bun, widget-payload.mjs).
//
// RN writes every seed row through its own code: queued captures in
// files/pending-captures, which RN imports at launch (tasks, a +Project task,
// a widget check-off), and one switch in RN Settings. Faults are injected on
// the host and printed as INJECTED. The script touches only
// tech.dongdongbh.mindwtr.upgradetest: it refuses any other APK, uninstalls
// only that package (before each scenario and at the end; --keep leaves it
// installed), installs with -g so no permission dialog can appear, and sends
// input only while that package is in front. Exit 0 = pass, 1 = fail,
// 2 = refused, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { bootFailure, box, button, check, connect, draftText, evidenced, fail, field, hasText, Stopped, inboxCount, tab, tagged, withDescription } from './device.mjs';
import { serveWebdav, webdavDocument } from './sync-harness.mjs';
import { PUBLISHED, REFRESHED, WIDGET_PREFS, WIDGET_LIST_PREFS, widgetSelections, corePublication, count, firstDifference, isRnPayloadPrefsWrite, publicationContext, widgetPrefs } from './widget-payload.mjs';

const SCENARIOS = ['1', '4', '2', '4b', '2b', '3', '3b', '5', '5b', '6', '7', '8', '9', '9b', '9c', '10', '11'];
const USAGE = `usage: node check-upgrade-device.mjs <adb-serial> [--only=${SCENARIOS.join(',')}] [--keep]`;
const args = process.argv.slice(2);
const serials = args.filter((arg) => !arg.startsWith('--'));
const onlyArg = args.find((arg) => arg.startsWith('--only='));
const only = onlyArg?.slice('--only='.length).split(',');
if (serials.length !== 1 || args.some((arg) => arg.startsWith('--') && arg !== '--keep' && arg !== onlyArg)
    || (only && only.some((scenario) => !SCENARIOS.includes(scenario)))) {
    console.error(USAGE);
    process.exit(2);
}
const [serial] = serials;
const want = (scenario) => !only || only.includes(scenario)
    || (scenario === '1' && only.includes('4')) || (scenario === '2' && only.includes('4b'));
const PKG = 'tech.dongdongbh.mindwtr.upgradetest';
const V132 = 'ee82a9e3e9a1d4e0c406f5ffff80e768a1f1f812';
const app = resolve(import.meta.dirname, '..');
const harness = process.env.MINDWTR_HARNESS_DIR ?? '/home/dd/.mindwtr-harness';
const aapt2 = process.env.AAPT2 ?? '/home/dd/Android/Sdk/build-tools/36.1.0/aapt2';
let built;
try {
    built = JSON.parse(readFileSync(resolve(harness, 'apks/manifest.json'), 'utf8'));
} catch {
    console.error(`REFUSED: no ${harness}/apks/manifest.json; run build-upgrade-harness.mjs first`);
    process.exit(2);
}
if (built.rnSource !== V132 || !built.recoverySource || !built.rn155) {
    console.error('REFUSED: apks/manifest.json predates the pinned sources; rerun build-upgrade-harness.mjs');
    process.exit(2);
}
const APKS = { rn152: built.rn152.path, native153: built.native153.path, rn154: built.rn154.path, rn155: built.rn155.path };
// install -r would upgrade whatever package the APK names: allow only the throwaway one.
for (const apk of Object.values(APKS)) {
    const apkPackage = execFileSync(aapt2, ['dump', 'packagename', apk], { encoding: 'utf8' }).trim();
    if (apkPackage !== PKG) {
        console.error(`REFUSED: ${apk} is package "${apkPackage}", not ${PKG}`);
        process.exit(2);
    }
}

// Expo prebuild derives the Java namespace from the harness package, so the
// harness RN activity is not the store app's `tech.dongdongbh.mindwtr.MainActivity`.
const RN_ACTIVITY = `${PKG}/${PKG}.MainActivity`;
const NATIVE_ACTIVITY = `${PKG}/${PKG}.MainActivity`;
const TAG = 'MindwtrNativeDev';
const GUARD = 'releaseCheck=v1.3.3/native-android-legacy-json-ahead-guard';
// core's assertNativeLegacyBackupSafe refusal (legacy-json-import.ts), shown as the boot's failure.
const PREFLIGHT_REFUSAL = 'Legacy backup requires recovery before native upgrade';
const IMPORT = 'v1.3.3/native-android-legacy-json-import';
const MARKER = 'mindwtr-data:json-ahead-of-sqlite';
const RECONCILED = 'mindwtr-data:sqlite-json-reconcile-v1';
const JSON_BACKUP = 'mindwtr-data';
const ASYNC_STORAGE = 'databases/RKStorage';
// RN's About, heartbeat and prompt keys (core's UPDATE_BADGE_*, ANALYTICS_DISTINCT_ID_KEY, LOCAL_USER_PROMPT_STATE_KEY): pass O1.
const UPDATE_AVAILABLE = 'mindwtr-update-available';
const UPDATE_LAST_CHECK = 'mindwtr-update-last-check';
const DISTINCT_ID = 'mindwtr-analytics-distinct-id';
const PROMPT_STATE = 'mindwtr:local-user-prompts:v1';
// The native app's byte copy of RKStorage, taken once before its first RKStorage write.
const RN_CHECKPOINT = 'files/SQLite/RKStorage.prewrite';
// RN's reminder alarm map (core's REMINDER_ALARM_MAP_STORAGE_KEY): the native app's reminder alarms clear RN's and keep theirs there.
const ALARM_MAP = 'mindwtr:local:alarms:v1';
const AUTO_CLEAN_LABEL = 'Clean up quick add text'; // RN v1.3.2 English label of settings.quickAddAutoClean
const TMP = '/data/local/tmp/mindwtr-upgradetest';
const DB = 'files/SQLite/mindwtr.db';
const TABLES = ['tasks', 'projects', 'areas', 'people', 'sections', 'settings', 'saved_filters', 'schema_migrations', 'calendar_sync'];
const TASK_SQL = 'SELECT id, title, status, projectId, deletedAt FROM tasks ORDER BY id';
const work = resolve(app, 'android/build/upgrade-check');
// Digits only for typed titles: some keyboards hold letters in a composition strip.
const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const titlesFor = (n) => ({
    inbox: [1, 2, 3, 4].map((i) => `${n}${i}${run}`),
    project: `${n}5${run}`, done: `${n}6${run}`, queued: `${n}7${run}`, native: `${n}8${run}`, backupOnly: `${n}9${run}`,
    projectName: `Upgrade${n}${run}`,
});

const device = connect({ serial, pkg: PKG, uiFile: `${TMP}-ui.xml` });
const { adbRaw, sh, home, front, requireAppFront, pid, screen, waitFor, tap, type, pull } = device;
const runAs = (command) => sh(`run-as ${PKG} ${command}`);
const phoneZone = sh('getprop persist.sys.timezone');

// ---- device ----
const installed = () => sh(`pm list packages ${PKG}`).split('\n').some((line) => line.trim() === `package:${PKG}`);
const install = (apk, replace) => {
    console.log(`install ${replace ? '-r ' : ''}-g ${basename(apk)}`);
    // -g grants every runtime permission, so the app never shows a permission dialog.
    adbRaw('install', ...(replace ? ['-r'] : []), '-g', apk);
};
const fresh = () => {
    if (installed()) sh(`pm uninstall ${PKG}`);
    install(APKS.rn152, false);
};
const until = async (description, predicate, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try { if (await predicate()) return; } catch { /* not ready yet */ }
        await sleep(1000);
    }
    fail(`timed out waiting for ${description}`);
};
const stopApp = async () => {
    await device.stopApp();
};
const openLink = (url) => {
    const current = front();
    if (!current.includes(`${PKG}/`) && !current.includes(`${home}/`)) {
        throw new Stopped(`another app is in front; not opening a link over it: ${current.trim()}`);
    }
    sh(`am start -W -a android.intent.action.VIEW -d '${url}' ${PKG}`);
};
const pushPrivate = (local, remote) => {
    const staged = `${TMP}-${basename(local)}`;
    adbRaw('push', local, staged);
    try { runAs(`cp ${staged} ${remote}`); } finally { sh(`rm -f ${staged}`); }
};
/** Any app's screen (a system picker in front): uiautomator's nodes, streamed, never written on the phone. */
const anyNodes = () => [...adbRaw('exec-out', 'uiautomator', 'dump', '/dev/tty').toString('utf8').matchAll(/<node [^>]*>/g)]
    .map(([node]) => Object.fromEntries([...node.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value])));
const tapNode = (node) => { const [x1, y1, x2, y2] = box(node); sh(`input tap ${Math.round((x1 + x2) / 2)} ${Math.round((y1 + y2) / 2)}`); };
/** The system folder picker (ACTION_OPEN_DOCUMENT_TREE): walk [path] from where it opened, Use this folder, then Allow. */
const pickFolder = async (path) => {
    for (let wait = 0; wait < 30 && front().includes(`${PKG}/`); wait += 1) await sleep(500);
    await sleep(1500);
    let nodes = anyNodes();
    for (const folder of path) {
        if (nodes.some((node) => node['resource-id']?.endsWith('breadcrumb_text') && node.text === folder)) continue;
        const entry = nodes.find((node) => node.text === folder && node['resource-id']?.endsWith('android:id/title'))
            ?? fail(`the folder picker shows no ${folder} (${nodes.map((node) => node.text).filter(Boolean).slice(0, 12).join(' | ')})`);
        tapNode(entry);
        await sleep(1500);
        nodes = anyNodes();
    }
    tapNode(nodes.find((node) => /use this folder/i.test(node.text ?? '') && node.enabled !== 'false') ?? fail('the folder picker shows no Use this folder'));
    await sleep(1200);
    const allow = anyNodes().find((node) => /^allow$/i.test(node.text ?? ''));
    if (allow) tapNode(allow);
    for (let wait = 0; wait < 30 && !front().includes(`${PKG}/`); wait += 1) await sleep(500);
};
/** Whether the app holds a persisted URI grant for the tree ending in [fragment] (`dumpsys activity permissions`, the app's UID block). */
const persistedGrant = (fragment) => {
    const uid = /uid:(\d+)/.exec(sh(`pm list packages -U ${PKG}`))?.[1] ?? fail(`no UID for ${PKG}`);
    const lines = sh('dumpsys activity permissions').split('\n');
    const start = lines.findIndex((line) => new RegExp(`UID ${uid}\\b`).test(line));
    if (start < 0) return false;
    const end = lines.findIndex((line, index) => index > start && /^\s*\* UID /.test(line));
    // Only a persisted grant counts: the picker's answer also leaves a transient one, listed until Android drops it.
    const block = lines.slice(start, end < 0 ? undefined : end);
    const entry = block.findIndex((line) => line.includes('UriPermission{') && line.includes(`${fragment} `));
    return entry >= 0 && /\bpersisted=0x[1-9a-f]/.test(block.slice(entry + 1, entry + 4).join(' '));
};

// RN's own capture queue: one JSON file per item, imported through RN's store at launch.
const queue = (items) => {
    runAs('mkdir -p files/pending-captures');
    for (const item of items) {
        const local = resolve(work, `${item.id}.json`);
        writeFileSync(local, JSON.stringify(item));
        pushPrivate(local, `files/pending-captures/${item.id}.json`);
    }
};
const drained = (items, description) => until(`RN to import ${description}`, () => {
    const present = runAs('ls files/pending-captures');
    return items.every((item) => !present.includes(item.id));
}, 90_000);
// path -> sha256 of every file the app keeps outside cache/ and code_cache/. A find
// error (an unreadable folder) exits non-zero, and adb then throws: never a silent gap.
const snapshot = () => new Map(runAs(
    `sh -c 'set --; for dir in files shared_prefs databases no_backup; do if [ -e "$dir" ]; then set -- "$@" "$dir"; fi; done; find "$@" -type f -exec sha256sum {} +'`,
).split('\n').filter(Boolean).map((line) => {
    const [hash, path] = line.split(/\s+/, 2);
    return [path, hash];
}));
// androidx profileinstaller rewrites this marker after every package update, and Samsung's One UI framework counts launches
// in the IDS file (`IDSCount`, S23 2026-09-27); neither holds user data.
// WorkManager keeps its own database, which RN's WorkManager (expo-background-task) and the native app's (CoreWork) both open at
// process start: the same library's state, never user data.
const PLATFORM_STATE = new Set(['files/profileInstalled', 'shared_prefs/android.app.ActivityThread.IDS.xml']);
const isPlatformState = (path) => PLATFORM_STATE.has(path) || /^no_backup\/androidx\.work\.workdb(-wal|-shm|-journal)?$/.test(path);
// The app's diagnostics log (RN's and native's): release-check lines are forced, so any boot may append to it. Never user data.
const isLog = (path) => /^files\/logs\/mindwtr\.log(\.\d+)?$/.test(path);
// The native app's reminder ledger (Reminders.kt ReminderLedger): its own new file, written once it holds an alarm; RN never has
// it. Allowed only as a new file whose every entry is an alarm id armed or fired at a time (checkLedger reads it).
const LEDGER = 'shared_prefs/mindwtr_reminder_ledger.xml';
const checkLedger = (label, after) => {
    if (!after.has(LEDGER)) return;
    const entries = [...runAs(`cat ${LEDGER}`).matchAll(/<string name="([^"]*)">([^<]*)<\/string>/g)];
    const other = runAs(`cat ${LEDGER}`).replace(/<\?xml[^>]*>|<\/?map\s*\/?>|<string name="[^"]*">[^<]*<\/string>/g, '').trim();
    check(entries.length > 0 && entries.every(([, id, value]) => /^\d+$/.test(id) && /^(armed|fired):\d+$/.test(value)) && other === '',
        `(${label}) the native reminder ledger holds only alarm ids and their times (${entries.length})`);
};
// The native app's owed-upload count (pass S4a, CoreWork.owedUploads): its own new file, written when a drain stores queued items
// (a capture RN left), so a closed-app capture job that dies still sends them. Allowed only as a new file holding that one count.
const OWED_UPLOADS = 'shared_prefs/mindwtr-background-sync.xml';
const checkOwedUploads = (label, after) => {
    if (!after.has(OWED_UPLOADS)) return;
    const text = runAs(`cat ${OWED_UPLOADS}`);
    const other = text.replace(/<\?xml[^>]*>|<\/?map\s*\/?>|<int name="owedUploads" value="\d+" \/>/g, '').trim();
    check(/<int name="owedUploads" value="\d+" \/>/.test(text) && other === '', `(${label}) the native owed-upload count file holds only its count`);
};
const differences = (before, after, { changedOk = () => false, newOk = () => false } = {}) => [
    ...[...before].filter(([path, hash]) => !isPlatformState(path) && !isLog(path) && !changedOk(path) && after.get(path) !== hash)
        .map(([path]) => `${after.has(path) ? 'changed' : 'removed'} ${path}`),
    ...[...after.keys()].filter((path) => !before.has(path) && !isPlatformState(path) && !isLog(path) && !newOk(path) && path !== LEDGER && path !== OWED_UPLOADS).map((path) => `new ${path}`),
];
const isDatabase = (path) => /^files\/SQLite\/mindwtr\.db(-wal|-shm)?$/.test(path);

// The native app writes one other file on purpose (pass W1): RN's home-screen widget payload, RN's WidgetPayloadStore. A check
// allows that write only with verifyWidgetPayload: RN's format with its one `payload` key, and the value core's own publication
// for the database the app left, with the inputs the app logged.
const widgetPrefsNow = () => widgetPrefs(runAs(`cat ${WIDGET_PREFS} 2>/dev/null || true`));
const isWidgetPayload = (path) => path === WIDGET_PREFS;
/**
 * Before the app stops: leaves it (the app publishes what changed as it leaves; while it is in front a change waits up to five
 * minutes, as RN's), waits until that publication is stored and drawn, and returns its logged inputs.
 */
const widgetsPublished = async (label) => {
    let context = null;
    if (front().includes(`${PKG}/`)) sh('input keyevent KEYCODE_HOME');
    await sleep(2500);
    await until(`(${label}) the widget payload to be stored`, () => {
        const text = device.logs(pid(), TAG);
        context = publicationContext(text);
        return context !== null && count(text, REFRESHED) >= count(text, PUBLISHED);
    }, 30_000);
    return context;
};
const verifyWidgetPayload = (label, before, context) => {
    const after = widgetPrefsNow();
    check(isRnPayloadPrefsWrite(before, after),
        `(${label}) ${WIDGET_PREFS} is RN's widget payload store, its one key \`payload\` (before: ${before.entries.join(', ') || 'no file'}; after: ${after.entries.join(', ')})`);
    const expected = corePublication({ listSelections: widgetSelections(runAs(`cat ${WIDGET_LIST_PREFS} 2>/dev/null || true`)), db: pullDatabase(`${label}-widgets`), language: context.language, context, zone: phoneZone, out: resolve(work, `${label}-widgets.json`) });
    const difference = firstDifference(JSON.parse(after.payload), JSON.parse(expected));
    check(difference === null, `(${label}) the payload equals core's publication on a copy of the database the native app left (${context.language}, ${context.locale}, `
        + `${context.scheme}, ${after.payload.length} characters)${difference ? `: ${difference}` : ''}`);
};
const isAsyncStorage = (path) => /^databases\/RKStorage(-wal|-shm|-journal)?$/.test(path);
const isRnCheckpoint = (path) => path.startsWith(`${RN_CHECKPOINT}/`);

// ---- database (host sqlite3 on pulled copies) ----
const sql = (db, statement, json = true) => execFileSync('sqlite3', [...(json ? ['-json'] : []), db, statement], { encoding: 'utf8', maxBuffer: 256 << 20 }).trim();
const rows = (db, statement) => { const text = sql(db, statement); return text ? JSON.parse(text) : []; };
const pullDatabase = (name) => {
    const dir = resolve(work, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    // .db, -wal and -shm together: committed rows can live only in -wal.
    const present = runAs('ls files/SQLite').split(/\s+/);
    for (const file of ['mindwtr.db', 'mindwtr.db-wal', 'mindwtr.db-shm']) {
        if (present.includes(file)) pull(`files/SQLite/${file}`, resolve(dir, file));
    }
    return resolve(dir, 'mindwtr.db');
};
const counts = (db) => Object.fromEntries(TABLES.map((table) => [table, Number(sql(db, `SELECT COUNT(*) FROM ${table}`, false))]));
const settingsOf = (db) => rows(db, "SELECT json_extract(data, '$.quickAddAutoClean') AS autoClean FROM settings WHERE id = 1")[0] ?? {};
// Every column of every core table as an SQL literal (quote() keeps the type and the exact bytes).
const tableRows = (db, table, names) => rows(db, `SELECT ${names.map((name) => `quote("${name}") AS "${name}"`).join(', ')} FROM "${table}"`);
const allRows = (db) => Object.fromEntries(TABLES.map((table) => {
    const columns = rows(db, `PRAGMA table_info("${table}")`);
    const names = columns.map((column) => column.name);
    const keys = columns.filter((column) => column.pk > 0).map((column) => column.name);
    return [table, { names, keys: keys.length ? keys : names, rows: tableRows(db, table, names) }];
}));
const rowCount = (snapshotRows) => Object.values(snapshotRows).reduce((total, table) => total + table.rows.length, 0);
// Names only (never values) of the top-level JSON keys that differ, for a changed JSON column.
const changedKeys = (before, after) => {
    try {
        const parse = (literal) => JSON.parse(literal.slice(1, -1).replaceAll("''", "'"));
        const [a, b] = [parse(before), parse(after)];
        return ` (keys ${[...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => !isDeepStrictEqual(a[key], b[key])).join(', ')})`;
    } catch {
        return '';
    }
};
// Core's saveData writes an absent settings.savedFilters as []: the same value, so not a change.
const sameCell = (table, name, before, after) => {
    if (before === after) return true;
    if (table !== 'settings' || name !== 'data') return false;
    try {
        const parse = (literal) => JSON.parse(literal.slice(1, -1).replaceAll("''", "'"));
        const [a, b] = [parse(before), parse(after)];
        for (const doc of [a, b]) if (Array.isArray(doc.savedFilters) && doc.savedFilters.length === 0) delete doc.savedFilters;
        return isDeepStrictEqual(a, b);
    } catch {
        return false;
    }
};
// Pre-upgrade rows that are gone, or differ in any pre-upgrade column. Only columns a later
// schema added may differ, and they are not read. New rows are allowed.
const rowChanges = (pre, db) => Object.entries(pre).flatMap(([table, { names, keys, rows: preRows }]) => {
    const keyOf = (row) => keys.map((name) => row[name]).join('|');
    const now = new Map(tableRows(db, table, names).map((row) => [keyOf(row), row]));
    return preRows.flatMap((row) => {
        const current = now.get(keyOf(row));
        if (!current) return [`${table} ${keyOf(row)} missing`];
        return names.filter((name) => !sameCell(table, name, row[name], current[name]))
            .map((name) => `${table} ${keyOf(row)} ${name}${changedKeys(row[name], current[name])}`);
    });
});
const readState = (db) => ({ counts: counts(db), rows: allRows(db), tasks: rows(db, TASK_SQL) });
const shortList = (items) => (items.length ? `: ${items.slice(0, 10).join('; ')}${items.length > 10 ? ` (+${items.length - 10} more)` : ''}` : '');

// ---- AsyncStorage (host sqlite3 on pulled copies of RKStorage; never opened on the phone) ----
const pullAsyncStorage = (name) => {
    const dir = resolve(work, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = runAs('ls databases').split(/\s+/);
    for (const file of ['RKStorage', 'RKStorage-wal', 'RKStorage-journal']) {
        if (present.includes(file)) pull(`databases/${file}`, resolve(dir, file));
    }
    return resolve(dir, 'RKStorage');
};
const asyncStorage = (name) => new Map(rows(pullAsyncStorage(name), 'SELECT key, value FROM catalystLocalStorage').map(({ key, value }) => [key, value]));
/** WorkManager's unfinished work under [name] (ENQUEUED 0, RUNNING 1, BLOCKED 4), from a pulled copy of its database. */
const unfinishedWork = (label, name) => {
    const dir = resolve(work, label);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    // WorkManager keeps its database in no_backup/ (RN's and the native app's alike).
    const present = runAs('ls no_backup').split(/\s+/);
    for (const file of ['androidx.work.workdb', 'androidx.work.workdb-wal']) {
        if (present.includes(file)) pull(`no_backup/${file}`, resolve(dir, file));
    }
    return rows(resolve(dir, 'androidx.work.workdb'), `SELECT s.id FROM WorkName n JOIN WorkSpec s ON s.id = n.work_spec_id WHERE n.name = '${name}' AND s.state IN (0, 1, 4)`);
};
// RN's background sync worker (expo-background-task's) and the native job that replaces it (pass S4a, CoreWork.SYNC_WORK).
const RN_SYNC_WORK = 'EXPO_BACKGROUND_WORKER';
const NATIVE_SYNC_WORK = 'mindwtr-core-background-sync';
// INJECTED: runs `statements` on a host copy of RKStorage, then pushes it back as one main file.
const rewriteAsyncStorage = (name, statements) => {
    const copy = pullAsyncStorage(name);
    sql(copy, `${statements} PRAGMA wal_checkpoint(TRUNCATE);`, false);
    pushPrivate(copy, ASYNC_STORAGE);
    runAs(`rm -f ${ASYNC_STORAGE}-wal ${ASYNC_STORAGE}-shm ${ASYNC_STORAGE}-journal`);
};
// rewriteAsyncStorage, but the statements' rows stay in RKStorage-wal, as RN leaves its recent AsyncStorage writes: the native
// boot must copy RN's -wal before anything opens RKStorage (an open can checkpoint the WAL away when it closes).
const rewriteAsyncStorageInWal = (name, statements) => {
    const copy = pullAsyncStorage(name);
    sql(copy, 'PRAGMA wal_checkpoint(TRUNCATE);', false);
    const staged = resolve(work, `${name}-staged`);
    rmSync(staged, { recursive: true, force: true });
    mkdirSync(staged, { recursive: true });
    // Copied while the connection is open: closing it would checkpoint the frames into the file and delete the -wal.
    execFileSync('bun', ['-e', `
        import { Database } from 'bun:sqlite';
        import { copyFileSync } from 'node:fs';
        const db = new Database(process.env.COPY);
        db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
        db.exec(process.env.STATEMENTS);
        copyFileSync(process.env.COPY, process.env.STAGED + '/RKStorage');
        copyFileSync(process.env.COPY + '-wal', process.env.STAGED + '/RKStorage-wal');
        db.close();
    `], { env: { ...process.env, COPY: copy, STATEMENTS: statements, STAGED: staged }, stdio: 'inherit' });
    runAs(`rm -f ${ASYNC_STORAGE}-wal ${ASYNC_STORAGE}-shm ${ASYNC_STORAGE}-journal`);
    pushPrivate(resolve(staged, 'RKStorage'), ASYNC_STORAGE);
    pushPrivate(resolve(staged, 'RKStorage-wal'), `${ASYNC_STORAGE}-wal`);
};
// Names (never values) of the AsyncStorage rows that differ, other than the marker, a newly set reconcile flag, and RN's alarm map
// (the reminder alarms clear RN's and keep theirs under RN's key: each scenario that allows it also checks RKStorage's checkpoint).
// RN's prompt state changes at every native first paint (today counted, as RN's first paint does): pass O1.
const asyncChanges = (before, after) => [...new Set([...before.keys(), ...after.keys()])].filter((name) => name !== MARKER && name !== ALARM_MAP
    && name !== PROMPT_STATE && before.get(name) !== after.get(name) && !(name === RECONCILED && !before.has(name) && after.get(name) === '1'));
// The RKStorage checkpoint must hold exactly the pre-import RKStorage files, byte for byte.
const checkpointMatches = (before, after) => ['', '-wal', '-journal', '-shm'].every((suffix) =>
    before.get(`${ASYNC_STORAGE}${suffix}`) === after.get(`${RN_CHECKPOINT}/RKStorage${suffix}`))
    && [...after.keys()].filter(isRnCheckpoint).every((path) => before.has(`databases/${path.slice(RN_CHECKPOINT.length + 1)}`));
// Loads a pulled database through core's own SqliteAdapter (Bun runs core's TypeScript) and compares it,
// every persisted field of every entity plus the settings, with core's plan for the RN backup: the
// same row writers and normalizations the native host confirms with. Prints the first mismatching table or "match".
const coreSrc = resolve(app, '../../packages/core/src');
const importMismatch = (db, state, backupFile) => execFileSync('bun', ['-e', `
    import { Database } from 'bun:sqlite';
    import { readFileSync } from 'node:fs';
    import { SqliteAdapter } from '${coreSrc}/sqlite-adapter.ts';
    import { legacyImportMismatch, planLegacyJsonImport } from '${coreSrc}/legacy-json-import.ts';
    const db = new Database(process.env.CHECK_DB);
    const client = {
        run: async (sql, params = []) => { db.query(sql).run(...params); },
        all: async (sql, params = []) => db.query(sql).all(...params),
        get: async (sql, params = []) => db.query(sql).get(...params) ?? undefined,
        exec: async (sql) => { db.exec(sql); },
    };
    const saved = await new SqliteAdapter(client).getData();
    const empty = { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} };
    const state = { ...JSON.parse(process.env.CHECK_STATE), backupJson: readFileSync(process.env.CHECK_BACKUP, 'utf8') };
    const plan = planLegacyJsonImport(state, empty, false);
    // Core's startup after the import adds its own settings: the daily tombstone cleanup stamps
    // migrations, load migrations add versioned defaults (gtd.focusGroupByDefaultsVersion), and a
    // missing deviceId is generated (RN's migrate keeps only synced settings). So every PLANNED
    // setting must survive with its value; keys core adds later are allowed.
    const kept = (planned, stored) => (planned && typeof planned === 'object' && !Array.isArray(planned)
        ? Boolean(stored) && typeof stored === 'object' && Object.keys(planned).every((key) => kept(planned[key], stored[key]))
        : JSON.stringify(planned) === JSON.stringify(stored));
    if (plan.merged) {
        delete saved.settings.migrations;
        delete plan.merged.settings.migrations;
        if (kept(plan.merged.settings, saved.settings)) saved.settings = plan.merged.settings;
    }
    console.log(plan.merged ? legacyImportMismatch(plan.merged, saved) ?? 'match' : 'no-plan');
`], { encoding: 'utf8', env: { ...process.env, CHECK_DB: db, CHECK_STATE: JSON.stringify(state), CHECK_BACKUP: backupFile } }).trim();
const liveInbox = (tasks) => tasks.filter((task) => task.status === 'inbox' && !task.deletedAt).map((task) => task.title).sort();

// ---- UI ----
// The Inbox count: the Process Inbox button's spoken count, or 0 for RN's empty Inbox (device.mjs inboxCount).
const header = inboxCount;
// A failed boot shows only its message (tagged `boot-failure`) and no command control.
const unavailable = bootFailure;
const nativeScreen = () => waitFor('the native screen', (nodes) => Number.isFinite(header(nodes)) || unavailable(nodes) !== undefined, 60_000);
const autoCleanSwitch = (nodes) => nodes.find((node) => node.class === 'android.widget.Switch' && node['content-desc'] === AUTO_CLEAN_LABEL);
const nativeGuardLog = () => device.logs(pid(), TAG).split('\n').find((line) => line.includes(GUARD)) ?? '';
// The JS host's log `context` is a JSON string, so its quotes arrive escaped.
const importLines = () => device.logs(pid(), TAG).replace(/\\/g, '').split('\n').filter((line) => line.includes(IMPORT));
const importLine = (label, fields) => {
    const lines = importLines();
    check(lines.length === 1 && Object.entries(fields).every(([name, value]) => lines[0].includes(`"${name}":"${value}"`)),
        `(${label}) one import line with ${JSON.stringify(fields)}: ${lines.map((line) => line.slice(line.indexOf('{'))).join(' | ')}`);
};
// The boot's preflight line (ProcessCoreHost, v1.3.5): core's legacyCheck ran before the RN database opened, or was not needed.
const preflightLine = (label, outcome) => {
    const lines = device.logs(pid(), TAG).replace(/\\/g, '').split('\n').filter((line) => line.includes('v1.3.5/native-android-legacy-preflight'));
    check(lines.length === 1 && lines[0].includes(`"outcome":"${outcome}"`), `(${label}) one preflight line with outcome ${outcome}: ${lines.map((line) => line.slice(line.indexOf('{'))).join(' | ')}`);
};
// Installs the native build over the prepared RN state and checks it fails closed.
const expectBlocked = async (label, reason, message) => {
    install(APKS.native153, true);
    device.launch(NATIVE_ACTIVITY);
    const nodes = await nativeScreen();
    check((unavailable(nodes) ?? '').startsWith(message), `(${label}) native app shows: ${unavailable(nodes)}`);
    check(nativeGuardLog().includes(`${GUARD} outcome=blocked reason=${reason}`), `(${label}) guard logged outcome=blocked reason=${reason}`);
    check(!field(nodes) && !nodes.some((node) => node.package === PKG && node.clickable === 'true'), `(${label}) no capture field and no control is offered`);
    await stopApp();
};

// ---- RN seeding ----
const seed = async (n) => {
    const t = titlesFor(n);
    const now = () => new Date().toISOString();
    const capture = (title) => ({ id: randomUUID(), title, createdAt: now(), source: 'android-quick-capture' });
    const inbox = t.inbox.map(capture);
    const inProject = capture(`${t.project} +${t.projectName}`); // quick-add syntax: RN creates the project
    const toComplete = capture(t.done);
    queue([...inbox, inProject, toComplete]);
    device.launch(RN_ACTIVITY);
    await drained([...inbox, inProject, toComplete], 'six queued captures');
    await stopApp();
    // A widget check-off, applied through RN's store on the next launch.
    const checkoff = { id: randomUUID(), kind: 'complete', taskId: toComplete.id, completedAt: now(), source: 'android-widget' };
    queue([checkoff]);
    device.launch(RN_ACTIVITY);
    await drained([checkoff], 'the widget check-off');
    // One synced setting (GTD group), changed in RN's own Settings screen.
    openLink('mindwtr-upgradetest://settings?settingsScreen=gtd-capture');
    let nodes = await waitFor('RN Settings > Capture', (current) => Boolean(autoCleanSwitch(current)), 60_000);
    check(autoCleanSwitch(nodes).checked === 'false', `(${n}) RN shows "${AUTO_CLEAN_LABEL}" off by default`);
    await tap(autoCleanSwitch(nodes));
    nodes = await waitFor('the switch to turn on', (current) => autoCleanSwitch(current)?.checked === 'true', 10_000);
    requireAppFront();
    sh('input keyevent KEYCODE_HOME');
    await until('RN to save the setting', () => settingsOf(pullDatabase(`${n}-poll`)).autoClean === 1, 30_000);
    await stopApp();

    const db = pullDatabase(`${n}-seeded`);
    const tasks = rows(db, TASK_SQL);
    const byId = new Map(tasks.map((task) => [task.id, task]));
    check(inbox.every((item) => byId.get(item.id)?.title === item.title && byId.get(item.id)?.status === 'inbox'),
        `(${n}) RN imported ${inbox.length} Inbox tasks through its capture queue`);
    const project = rows(db, `SELECT id FROM projects WHERE title = '${t.projectName}' AND deletedAt IS NULL`)[0];
    check(Boolean(project) && byId.get(inProject.id)?.title === t.project && byId.get(inProject.id)?.projectId === project.id,
        `(${n}) RN created project ${t.projectName} and filed a task in it`);
    check(byId.get(toComplete.id)?.status === 'done', `(${n}) RN applied the widget check-off (status done)`);
    check(settingsOf(db).autoClean === 1, `(${n}) RN saved quickAddAutoClean = true in the settings row`);
    return t;
};

// INJECTED: every committed row moved into the main file, optionally new WAL frames that
// touch only the settings row, then the tasks root page overwritten in the main file.
const damageDatabase = (label, withWal) => {
    const db = pullDatabase(`${label}-damaged`);
    sql(db, 'PRAGMA wal_checkpoint(TRUNCATE);', false);
    const pageSize = Number(sql(db, 'PRAGMA page_size', false));
    const root = Number(sql(db, "SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'tasks'", false));
    if (withWal) {
        // no_ckpt_on_close keeps the frames in -wal when sqlite3 exits.
        execFileSync('sqlite3', [db, '.dbconfig no_ckpt_on_close on', 'PRAGMA wal_autocheckpoint = 0;',
            "UPDATE settings SET data = json_set(data, '$.harnessWalProbe', 1) WHERE id = 1;"], { stdio: 'ignore' });
        check(statSync(`${db}-wal`).size > 32, `INJECTED (${label}): -wal holds ${statSync(`${db}-wal`).size} bytes of frames for the settings row`);
    }
    const bytes = readFileSync(db);
    bytes.fill(0xa5, (root - 1) * pageSize, root * pageSize);
    writeFileSync(db, bytes);
    const probe = resolve(work, `${label}-probe`);
    rmSync(probe, { recursive: true, force: true });
    mkdirSync(probe, { recursive: true });
    copyFileSync(db, resolve(probe, 'mindwtr.db'));
    if (withWal) copyFileSync(`${db}-wal`, resolve(probe, 'mindwtr.db-wal'));
    let quickCheck; // sqlite3 prints the problems, then exits 1 on the damaged page
    try { quickCheck = sql(resolve(probe, 'mindwtr.db'), 'PRAGMA quick_check', false); } catch (error) { quickCheck = String(error.stdout ?? error.message).trim(); }
    check(quickCheck !== 'ok', `INJECTED (${label}): tasks root page ${root} overwritten; quick_check on a host copy says: ${quickCheck.split('\n')[1] ?? quickCheck}`);
    pushPrivate(db, DB);
    if (withWal) pushPrivate(`${db}-wal`, `${DB}-wal`);
    runAs(withWal ? `rm -f ${DB}-shm` : `rm -f ${DB}-wal ${DB}-shm`);
};

// ---- scenarios ----
const scenarioUpgrade = async () => {
    console.log('\n# 1 happy upgrade');
    fresh();
    const t = await seed('1');
    // RN is stopped and never runs again before the native app: the native app's first boot imports this capture (its queue
    // drain, after the journal replay), once, under its own id.
    const queued = { id: randomUUID(), title: t.queued, createdAt: new Date().toISOString(), source: 'android-quick-capture' };
    queue([queued]);
    const queuedPath = `files/pending-captures/${queued.id}.json`;
    // Pass O1: RN's About, analytics and review state under RN's keys (INJECTED, as RN's About, heartbeat and first paint write
    // them): an update RN found, the heartbeat's anonymous id, and the prompt state with RN's first-seen day and active days.
    const phoneToday = sh('date +%Y-%m-%d');
    const rnPrompts = { firstSeenAt: new Date(Date.now() - 40 * 86_400_000).toISOString(), firstSeenDayKey: '2026-01-02', activeDayKeys: ['2026-01-02', '2026-01-03'] };
    const rnAbout = { [UPDATE_AVAILABLE]: 'true', [UPDATE_LAST_CHECK]: String(Date.now()), [DISTINCT_ID]: 'rn-upgrade-distinct-id', [PROMPT_STATE]: JSON.stringify(rnPrompts) };
    rewriteAsyncStorageInWal('1-about', `INSERT OR REPLACE INTO catalystLocalStorage (key, value) VALUES ${Object.entries(rnAbout)
        .map(([key, value]) => `('${key}', '${value.replace(/'/g, "''")}')`).join(', ')};`);
    const before = snapshot();
    check(before.has(`${ASYNC_STORAGE}-wal`), '(1) RN\'s About rows are in RKStorage-wal before the upgrade');
    const widgetsBefore = widgetPrefsNow();
    const pre = readState(pullDatabase('1-pre'));
    const preAsync = asyncStorage('1-pre-rkstorage');
    const expected = [...pre.tasks.filter((task) => task.status === 'inbox' && !task.deletedAt).map((task) => task.title), t.queued].sort();
    console.log(`pre-upgrade rows: ${JSON.stringify(pre.counts)}; ${before.size} files hashed`);

    install(APKS.native153, true);
    device.launch(NATIVE_ACTIVITY);
    let nodes = await nativeScreen();
    check(!unavailable(nodes), `(1) native boot succeeded ${unavailable(nodes) ?? ''}`);
    check(header(nodes) === expected.length, `(1) native Inbox counts ${expected.length}: RN's ${expected.length - 1} Inbox tasks and the capture RN left queued`);
    for (const title of expected) check(hasText(nodes, title), `(1) native Inbox shows RN task ${title}`);
    check(!hasText(nodes, t.done), '(1) the completed RN task is not in the native Inbox');
    check(nativeGuardLog().includes(`${GUARD} outcome=clear`), '(1) guard logged outcome=clear');
    await type(t.native);
    await tap(button(await screen(), 'Save'));
    nodes = await waitFor('the native capture', (current) => header(current) === expected.length + 1 && draftText(current) === '');
    check(hasText(nodes, t.native), '(1) native capture is listed');
    // RN's update dot carries over: the native Settings menu's About row has it.
    await tap(tab(nodes, en['tab.menu']) ?? fail('no Menu tab'));
    nodes = await waitFor('the More sheet', (current) => Boolean(tagged(current, 'more-sheet')), 10_000);
    await tap(withDescription(nodes, en['nav.settings']) ?? fail('no Settings tile'));
    nodes = await waitFor('native Settings', (current) => Boolean(tagged(current, 'settings-main')), 20_000);
    const aboutRow = (current) => current.find((node) => (node['content-desc'] ?? '').startsWith(`${en['settings.about']}. `));
    for (let step = 0; step < 6 && !aboutRow(nodes); step += 1) nodes = await device.swipe(nodes, 'down');
    check(aboutRow(nodes)?.['content-desc'].includes(en['settings.updateAvailable']), `(1) RN's update dot carries over to the native Settings menu: ${aboutRow(nodes)?.['content-desc']}`);
    const published = await widgetsPublished('1');
    await stopApp();

    const after = snapshot();
    const post = pullDatabase('1-post');
    check(rows(post, TASK_SQL).filter((task) => task.title === t.native && !task.deletedAt).length === 1, '(1) native capture stored exactly once');
    const changes = rowChanges(pre.rows, post);
    check(changes.length === 0, `(1) all ${rowCount(pre.rows)} pre-upgrade rows of every core table, settings included, are unchanged in every pre-upgrade column${shortList(changes)}`);
    const checkpoint = resolve(work, '1-post/mindwtr.db.prewrite');
    check(runAs('ls files/SQLite').split(/\s+/).includes('mindwtr.db.prewrite'), '(1) .prewrite checkpoint exists beside the RN database');
    pull(`${DB}.prewrite`, checkpoint);
    check(isDeepStrictEqual(counts(checkpoint), pre.counts), '(1) .prewrite has the pre-upgrade row count of every core table');
    const checkpointChanges = rowChanges(pre.rows, checkpoint);
    check(checkpointChanges.length === 0, `(1) .prewrite holds every pre-upgrade row exactly${shortList(checkpointChanges)}`);
    const imported = rows(post, TASK_SQL).filter((task) => task.title === t.queued && !task.deletedAt);
    check(imported.length === 1 && imported[0].id === queued.id && !after.has(queuedPath), '(1) the native boot imported the capture RN left queued once, under its id, and removed its file');
    // The RKStorage writes the native app makes here on purpose: the reminder alarms clear RN's alarm map and keep their own under
    // RN's key, and the first paint counts today in RN's prompt state, after the boot's byte copy of RKStorage. No other row may change.
    const asyncChanged = (() => {
        const postAsync = asyncStorage('1-post-rkstorage');
        return [...new Set([...preAsync.keys(), ...postAsync.keys()])].filter((name) => preAsync.get(name) !== postAsync.get(name));
    })();
    check(asyncChanged.every((name) => name === ALARM_MAP || name === PROMPT_STATE), `(1) RKStorage: only RN's alarm map ${ALARM_MAP} and RN's prompt state changed${shortList(asyncChanged)}`);
    // Pass O1: the native first paint counted today as RN's does, on RN's state: RN's first-seen time and days kept, today added.
    const postAbout = asyncStorage('1-post-about');
    const prompts = JSON.parse(postAbout.get(PROMPT_STATE) ?? '{}');
    check(prompts.firstSeenAt === rnPrompts.firstSeenAt && prompts.firstSeenDayKey === rnPrompts.firstSeenDayKey
        && isDeepStrictEqual(prompts.activeDayKeys, [...rnPrompts.activeDayKeys, phoneToday]), `(1) RN's prompt state carries over with today added: ${JSON.stringify(prompts)}`);
    check([UPDATE_AVAILABLE, UPDATE_LAST_CHECK, DISTINCT_ID].every((key) => postAbout.get(key) === rnAbout[key]),
        '(1) RN\'s update dot, its last check and the heartbeat\'s anonymous id are kept as RN left them (a debug build sends no heartbeat)');
    const rnFiles = ['', '-wal', '-journal', '-shm'].filter((suffix) => before.has(`${ASYNC_STORAGE}${suffix}`)).map((suffix) => `RKStorage${suffix}`);
    check(checkpointMatches(before, after), `(1) ${RN_CHECKPOINT} holds the pre-upgrade RKStorage files byte for byte (${rnFiles.join(', ')}), taken at boot before anything opened RKStorage`);
    const changed = differences(before, after, {
        changedOk: (path) => isDatabase(path) || path === queuedPath || isAsyncStorage(path) || isWidgetPayload(path),
        newOk: (path) => isDatabase(path) || path === `${DB}.prewrite` || isAsyncStorage(path) || isRnCheckpoint(path) || isWidgetPayload(path),
    });
    checkLedger('1', after);
    checkOwedUploads('1', after);
    check(changed.length === 0, `(1) every other non-database file is unchanged but RN's widget payload (${[...before.keys()].filter((path) => !isDatabase(path)).length} files)${shortList(changed)}`);
    verifyWidgetPayload('1', widgetsBefore, published);
    return { t, pre, queued };
};

const scenarioPendingCheckoff = async () => {
    console.log('\n# 8 widget check-off pending at the upgrade');
    fresh();
    const title = `91${run}`;
    const capture = { id: randomUUID(), title, createdAt: new Date().toISOString(), source: 'android-quick-capture' };
    queue([capture]);
    device.launch(RN_ACTIVITY);
    await drained([capture], 'one queued capture');
    await stopApp();
    const taskSql = `SELECT status, rev FROM tasks WHERE id = '${capture.id}' AND deletedAt IS NULL`;
    const [before] = rows(pullDatabase('8-pre'), taskSql);
    check(before?.status === 'inbox', `(8) RN imported ${title}`);
    // RN's PendingCheckoffStore file, tapped a minute ago: past its Undo window, never swept because RN stopped.
    const pendingPath = 'files/mindwtr-widget-checkoff-pending.json';
    const local = resolve(work, '8-pending.json');
    writeFileSync(local, JSON.stringify({ version: 1, pending: [{ id: capture.id, at: Date.now() - 60_000 }] }));
    pushPrivate(local, pendingPath);
    install(APKS.native153, true);
    device.launch(NATIVE_ACTIVITY);
    const nodes = await nativeScreen();
    check(!unavailable(nodes), `(8) native boot succeeded ${unavailable(nodes) ?? ''}`);
    await until('the native boot to store the check-off', () => rows(pullDatabase('8-poll'), taskSql)[0]?.status === 'done', 60_000);
    await sleep(3000);
    await stopApp();
    const [after] = rows(pullDatabase('8-post'), taskSql);
    check(after.status === 'done' && after.rev === before.rev + 1, `(8) the native boot completed the RN check-off once (rev ${before.rev} to ${after.rev})`);
    check(JSON.parse(runAs(`cat ${pendingPath}`)).pending.length === 0, '(8) RN\'s pending file is empty');
    check(!runAs('ls files/pending-captures').split(/\s+/).some((name) => name.endsWith('.json')), '(8) nothing is left in the queue');
    device.launch(NATIVE_ACTIVITY);
    await nativeScreen();
    await sleep(3000);
    await stopApp();
    check(rows(pullDatabase('8-relaunch'), taskSql)[0].rev === after.rev, '(8) a relaunch writes nothing more');
};

const scenarioRecovery = async ({ t, pre, queued }) => {
    console.log('\n# 4 recovery: RN 154 over the native build');
    install(APKS.rn154, true);
    device.launch(RN_ACTIVITY);
    openLink('mindwtr-upgradetest://inbox');
    const nodes = await waitFor('the RN Inbox with the native task', (current) => hasText(current, t.native), 90_000);
    for (const title of [t.native, ...t.inbox]) check(hasText(nodes, title), `(4) RN recovery Inbox shows ${title}`);
    await drained([queued], 'the queued capture');
    const rnPid = pid();
    await stopApp();
    const db = pullDatabase('4-post');
    check(rows(db, TASK_SQL).filter((task) => task.title === t.native && !task.deletedAt).length === 1, '(4) the native-created task is present once');
    check(rows(db, TASK_SQL).filter((task) => task.title === t.queued && !task.deletedAt).length === 1, '(4) the capture the native app imported is present once: RN imports it no second time');
    const changes = rowChanges(pre.rows, db);
    check(changes.length === 0, `(4) every pre-upgrade row, settings included, is unchanged${shortList(changes)}`);
    // Findings, not assertions: RN warnings or errors while it opened a database the native app wrote.
    const log = resolve(work, '4-rn-logcat.txt');
    writeFileSync(log, adbRaw('logcat', '-d', `--pid=${rnPid}`, '*:W').toString('utf8'));
    const suspicious = readFileSync(log, 'utf8').split('\n').filter((line) => /sqlite|schema|migrat|merge|corrupt/i.test(line));
    console.log(`RN recovery warnings mentioning sqlite/schema/migration/merge/corrupt: ${suspicious.length} (full log ${log})`);
    for (const line of suspicious.slice(0, 20)) console.log(`  ${line}`);
};

// Seeds through RN, then INJECTS into RN's own JSON backup one task SQLite never took, and the
// json-ahead marker: the state RN leaves after a save reached only its JSON backup (#964).
const scenarioJsonAhead = async () => {
    console.log('\n# 2 json-ahead import');
    fresh();
    const t = await seed('2');
    const seeded = asyncStorage('2-seeded-rkstorage');
    check(seeded.has(JSON_BACKUP), `(2) RN wrote its AsyncStorage ${JSON_BACKUP} backup`);
    const backup = JSON.parse(seeded.get(JSON_BACKUP));
    const source = backup.tasks.find((task) => task.status === 'inbox' && !task.deletedAt);
    check(Boolean(source), '(2) the backup holds an RN Inbox task to model the injected task on');
    const now = new Date().toISOString();
    const description = `Imported ü 😀 ${run}`;
    const extra = { ...source, id: randomUUID(), title: t.backupOnly, description, createdAt: now, updatedAt: now, rev: 1 };
    backup.tasks.push(extra);
    const backupFile = resolve(work, '2-backup.json');
    writeFileSync(backupFile, JSON.stringify(backup));
    rewriteAsyncStorage('2-rkstorage', `UPDATE catalystLocalStorage SET value = CAST(readfile('${backupFile}') AS TEXT) WHERE key = '${JSON_BACKUP}'; `
        + `INSERT OR REPLACE INTO catalystLocalStorage (key, value) VALUES ('${MARKER}', '1');`);
    console.log(`INJECTED (2): one Inbox task (rev 1, fresh timestamps, a non-ASCII description) in AsyncStorage ${JSON_BACKUP} that SQLite never took, and ${MARKER} = '1'`);
    const before = snapshot();
    const widgetsBefore = widgetPrefsNow();
    const pre = readState(pullDatabase('2-pre'));
    const preAsync = asyncStorage('2-pre-rkstorage');
    check(pre.tasks.every((task) => task.id !== extra.id), '(2) SQLite does not hold the backup-only task before the upgrade');
    const expected = [...liveInbox(pre.tasks), t.backupOnly].sort();

    install(APKS.native153, true);
    device.launch(NATIVE_ACTIVITY);
    let nodes = await nativeScreen();
    check(!unavailable(nodes), `(2) native boot succeeded ${unavailable(nodes) ?? ''}`);
    check(header(nodes) === expected.length, `(2) native Inbox counts ${expected.length} tasks: the RN Inbox plus the imported one`);
    check(hasText(nodes, t.backupOnly), '(2) native Inbox shows the task only the JSON backup held');
    check(nativeGuardLog().includes(`${GUARD} outcome=clear`), '(2) guard logged outcome=clear');
    importLine('2', { outcome: 'imported', path: 'json-ahead', rnState: 'updated' });
    preflightLine('2', 'passed');
    const published = await widgetsPublished('2');
    await stopApp();

    const after = snapshot();
    const postDb = pullDatabase('2-post');
    const stored = rows(postDb, `SELECT title, description, rev, updatedAt FROM tasks WHERE id = '${extra.id}'`);
    check(stored.length === 1 && stored[0].title === t.backupOnly, '(2) SQLite holds the imported task exactly once');
    check(stored[0].description === description, '(2) the imported description is byte-exact (non-ASCII and an emoji)');
    const changes = rowChanges(pre.rows, postDb);
    check(changes.length === 0, `(2) all ${rowCount(pre.rows)} pre-import rows are unchanged in every pre-import column${shortList(changes)}`);
    const postAsync = asyncStorage('2-post-rkstorage');
    check(!postAsync.has(MARKER), '(2) the json-ahead marker is gone');
    const asyncChanged = asyncChanges(preAsync, postAsync);
    check(asyncChanged.length === 0, `(2) no other AsyncStorage row changed, ${JSON_BACKUP} included${shortList(asyncChanged)}`);
    check(checkpointMatches(before, after), `(2) ${RN_CHECKPOINT} holds the pre-import RKStorage files byte for byte`);
    const changed = differences(before, after, {
        changedOk: (path) => isDatabase(path) || isAsyncStorage(path) || isWidgetPayload(path),
        newOk: (path) => isDatabase(path) || path === `${DB}.prewrite` || isAsyncStorage(path) || isRnCheckpoint(path) || isWidgetPayload(path),
    });
    check(changed.length === 0, `(2) every other file is unchanged but RN's widget payload${shortList(changed)}`);
    verifyWidgetPayload('2', widgetsBefore, published);
    pull(`${DB}.prewrite`, resolve(work, '2-post/mindwtr.db.prewrite'));
    check(rowChanges(pre.rows, resolve(work, '2-post/mindwtr.db.prewrite')).length === 0, '(2) .prewrite holds every pre-import row');

    // A relaunch must not import again: the marker is gone and the reconcile flag is set.
    device.launch(NATIVE_ACTIVITY);
    nodes = await nativeScreen();
    check(!unavailable(nodes) && header(nodes) === expected.length && hasText(nodes, t.backupOnly), '(2) relaunch shows the same Inbox');
    check(importLines().length === 0, '(2) relaunch logs no import line');
    await stopApp();
    const relaunch = snapshot();
    const again = pullDatabase('2-relaunch');
    const storedAgain = rows(again, `SELECT rev, updatedAt FROM tasks WHERE id = '${extra.id}'`);
    check(storedAgain.length === 1 && storedAgain[0].rev === stored[0].rev && storedAgain[0].updatedAt === stored[0].updatedAt
        && counts(again).tasks === counts(postDb).tasks, `(2) relaunch imported nothing: the task keeps rev ${stored[0].rev}, ${counts(postDb).tasks} task rows`);
    // Rows, not file bytes: every first paint rewrites RN's prompt state (the same day: the same value), as RN's first paint does.
    const relaunchAsync = asyncStorage('2-relaunch-rkstorage');
    check(isDeepStrictEqual(relaunchAsync, postAsync), `(2) relaunch left every RKStorage row unchanged${shortList(asyncChanges(postAsync, relaunchAsync))}`);
    return { t, id: extra.id, stored: stored[0], post: readState(again) };
};

// Continues 2: RN 154 over the native build that imported the backup.
const scenarioRecoveryAfterImport = async ({ t, id, stored, post }) => {
    console.log('\n# 4b recovery after the json-ahead import: RN 154 over the native build');
    install(APKS.rn154, true);
    device.launch(RN_ACTIVITY);
    openLink('mindwtr-upgradetest://inbox');
    const nodes = await waitFor('the RN Inbox with the imported task', (current) => hasText(current, t.backupOnly), 90_000);
    check(nodes.filter((node) => node.text === t.backupOnly).length === 1, '(4b) RN recovery Inbox shows the imported task once');
    await stopApp();
    const db = pullDatabase('4b-post');
    const row = rows(db, `SELECT rev, updatedAt FROM tasks WHERE id = '${id}'`);
    check(row.length === 1 && row[0].rev === stored.rev && row[0].updatedAt === stored.updatedAt, '(4b) the imported task is stored once, unchanged');
    check(!asyncStorage('4b-rkstorage').has(MARKER), '(4b) RKStorage has no json-ahead marker, so RN had nothing to recover again');
    check(counts(db).tasks === post.counts.tasks, `(4b) RN added no task (${post.counts.tasks} task rows)`);
    const changes = rowChanges(post.rows, db);
    check(changes.length === 0, `(4b) every row the native app left is unchanged${shortList(changes)}`);
};

/** The open question's action button (a dialog window has no test tags): core's Merge, Restore or Import word, its text or TalkBack name. */
const confirmButton = (nodes) => nodes.find((node) => [en['settings.mergeBackupAction'], en['markdown.referenceRestore'], en['settings.backupMobile.import']]
    .some((label) => [node.text, node['content-desc']].some((text) => (text ?? '').toUpperCase() === label.toUpperCase())));
// 10 (pass D1a): RN's recovery snapshots carry over. RN keeps them in its document folder's `snapshots` (this app's
// files/snapshots); the native app lists them in place with RN's label, restores one, ignores RN's half-written pending file,
// and writes its own in the same format.
const scenarioRecoverySnapshots = async () => {
    console.log('\n# 10 RN recovery snapshots in the native Recovery snapshots card');
    fresh();
    await seed('10');
    // RN's folder grant (design §5): RN's Export backup takes the picked folder as a persistable grant (Expo's SAF); the
    // native upgrade keeps it.
    const grantDir = `mtu${run}`.slice(0, 16);
    sh(`mkdir -p /sdcard/Download/${grantDir}`);
    try {
        openLink('mindwtr-upgradetest://settings?settingsScreen=data');
        const exportRow = (current) => current.find((node) => node.text === en['settings.exportBackup']);
        let rnNodes = await waitFor('RN\'s Settings › Data', (current) => Boolean(exportRow(current)) || current.some((node) => node.text === en['settings.backup']), 60_000);
        if (!exportRow(rnNodes)) {
            await tap(rnNodes.find((node) => node.text === en['settings.backup']));
            rnNodes = await waitFor('RN\'s Backup fold', (current) => Boolean(exportRow(current)), 20_000);
        }
        await tap(exportRow(rnNodes));
        await pickFolder(['Download', grantDir]);
        await until('RN\'s backup in the picked folder', () => sh(`ls /sdcard/Download/${grantDir}`).includes('mindwtr-backup'), 30_000);
        check(persistedGrant(`Download%2F${grantDir}`), '(10) before: RN holds the folder its export picked as a persisted grant');
    } catch (error) {
        sh(`rm -rf /sdcard/Download/${grantDir}`);
        throw error;
    }
    const at = new Date(Date.now() - 3_600_000);
    const name = `data.${at.toISOString().replace(/Z$/, '').replace(/:/g, '-')}.snapshot.json`;
    const kept = [{ id: randomUUID(), title: `91${run}`, status: 'next', tags: [], contexts: [], createdAt: at.toISOString(), updatedAt: at.toISOString(), rev: 1 }];
    // RN's format: serializeBackupData's pretty JSON of the library (v1.3.2 writes it the same way).
    const local = resolve(work, name);
    writeFileSync(local, JSON.stringify({ tasks: kept, projects: [], sections: [], areas: [], people: [], settings: {} }, null, 2));
    const stray = resolve(work, 'data.pending.snapshot.tmp');
    writeFileSync(stray, '{"tasks": [');
    runAs('mkdir -p files/snapshots');
    pushPrivate(local, `files/snapshots/${name}`);
    pushPrivate(stray, 'files/snapshots/data.pending.snapshot.tmp');
    console.log(`INJECTED (10): RN's snapshot ${name} (one task) and a half-written data.pending.snapshot.tmp in files/snapshots`);

    install(APKS.native153, true);
    device.launch(NATIVE_ACTIVITY);
    let nodes = await nativeScreen();
    check(!unavailable(nodes), `(10) native boot succeeded ${unavailable(nodes) ?? ''}`);
    await tap(tab(nodes, en['tab.menu']) ?? fail('no Menu tab'));
    nodes = await waitFor('the More sheet', (current) => Boolean(tagged(current, 'more-sheet')), 10_000);
    await tap(withDescription(nodes, en['nav.settings']) ?? fail('no Settings tile'));
    nodes = await waitFor('native Settings', (current) => Boolean(tagged(current, 'settings-main')), 20_000);
    let row = nodes.find((node) => (node['content-desc'] ?? '').startsWith(`${en['settings.sync']}. `));
    for (let step = 0; step < 6 && !row; step += 1) {
        nodes = await device.swipe(nodes, 'down');
        row = nodes.find((node) => (node['content-desc'] ?? '').startsWith(`${en['settings.sync']}. `));
    }
    await tap(row ?? fail('no Sync row in native Settings'));
    nodes = await waitFor('native Settings > Sync', (current) => Boolean(tagged(current, 'settings-sync')), 30_000);
    for (let step = 0; step < 10 && !tagged(nodes, 'recovery-snapshots-disclosure'); step += 1) nodes = await device.swipe(nodes, 'down');
    await tap(tagged(nodes, 'recovery-snapshots-disclosure') ?? fail('no Recovery snapshots card'));
    nodes = await waitFor('RN\'s snapshot row', (current) => Boolean(tagged(current, `recovery-snapshot-${name}`)), 15_000);
    const rowsShown = nodes.filter((node) => (node['resource-id'] ?? '').includes('recovery-snapshot-data.'));
    check(rowsShown.length === 1, `(10) the card lists RN's one snapshot, not its pending file (${rowsShown.length} rows)`);
    // The row is one TalkBack node: RN's "Restore <label> (<file name>)", the file name shown under the label.
    check((tagged(nodes, `recovery-snapshot-${name}`)['content-desc'] ?? '').includes(`(${name})`), `(10) the row names the file under RN's label: ${tagged(nodes, `recovery-snapshot-${name}`)['content-desc']}`);
    await tap(tagged(nodes, `recovery-snapshot-${name}`));
    nodes = await waitFor('RN\'s question', (current) => Boolean(confirmButton(current))
        && current.some((node) => node.text === en['settings.backupMobile.restoreRecoverySnapshot']), 30_000);
    await tap(confirmButton(nodes));
    await waitFor('the restore result', (current) => current.some((node) => node.text === en['settings.backupMobile.restoreComplete']), 60_000);
    await stopApp();
    const live = rows(pullDatabase('10-post'), "SELECT title FROM tasks WHERE deletedAt IS NULL ORDER BY title").map((r) => r.title);
    check(isDeepStrictEqual(live, kept.map((task) => task.title)), `(10) the restore gave RN's snapshot's library: ${live.join(' ')}`);
    check(runAs('ls files/snapshots').split(/\s+/).includes('data.pending.snapshot.tmp'), '(10) RN\'s pending file stays as RN left it');
    check(persistedGrant(`Download%2F${grantDir}`), '(10) after: the native app still holds RN\'s folder grant');
    sh(`rm -rf /sdcard/Download/${grantDir}`);
};

const scenarioCorruptBackup = async () => {
    console.log("\n# 2b json-ahead marker with a corrupt backup: core's preflight refuses");
    fresh();
    await seed('7'); // digit prefixes keep seed titles digits-only
    rewriteAsyncStorage('2b-rkstorage', `UPDATE catalystLocalStorage SET value = '{"tasks": [' WHERE key = '${JSON_BACKUP}'; `
        + `INSERT OR REPLACE INTO catalystLocalStorage (key, value) VALUES ('${MARKER}', '1');`);
    console.log(`INJECTED (2b): AsyncStorage ${JSON_BACKUP} cut to text that does not parse, and ${MARKER} = '1'`);
    const before = snapshot();
    for (const path of [DB, `${DB}-wal`, ASYNC_STORAGE]) if (before.has(path)) console.log(`sha256 ${path} ${before.get(path)}`);

    // RN would abandon the marker (#964); the native upgrade refuses a backup that needs lossy repair (core's
    // assertNativeLegacyBackupSafe, audit C), before anything opens the RN database.
    install(APKS.native153, true);
    device.launch(NATIVE_ACTIVITY);
    const nodes = await nativeScreen();
    check((unavailable(nodes) ?? '').startsWith(PREFLIGHT_REFUSAL), `(2b) native app shows: ${unavailable(nodes)}`);
    check(nativeGuardLog().includes(`${GUARD} outcome=clear`), "(2b) the guard passed, so core's preflight refused");
    check(importLines().length === 0, '(2b) no import line: the import never ran');
    check(!field(nodes) && !nodes.some((node) => node.package === PKG && node.clickable === 'true'), '(2b) no capture field and no control is offered');
    await stopApp();

    const after = snapshot();
    check(after.get(DB) === before.get(DB) && after.get(`${DB}-wal`) === before.get(`${DB}-wal`), '(2b) database and -wal bytes are unchanged');
    check(asyncStorage('2b-post-rkstorage').has(MARKER), '(2b) the json-ahead marker stays for RN');
    // The guard passed, so the boot took RN's RKStorage byte copy (95b15aad1) before core's preflight refused.
    check(checkpointMatches(before, after), `(2b) ${RN_CHECKPOINT} holds the pre-upgrade RKStorage files byte for byte`);
    const changed = differences(before, after, { newOk: isRnCheckpoint });
    check(changed.length === 0, `(2b) every file is unchanged and none is new but RN's RKStorage checkpoint, so no .prewrite and no write (${before.size} files)${shortList(changed)}`);
};

const scenarioUnreadable = async (label, withWal) => {
    console.log(`\n# ${label} damaged database, ${withWal ? 'WAL holds frames' : 'empty WAL'}`);
    fresh();
    await seed(withWal ? '6' : '3'); // digit prefixes keep seed titles digits-only
    damageDatabase(label, withWal);
    const before = snapshot();
    for (const path of [DB, `${DB}-wal`]) if (before.has(path)) console.log(`sha256 ${path} ${before.get(path)}`);
    if (withWal) check(before.has(`${DB}-wal`), `(${label}) the phone holds the damaged database and its -wal`);

    await expectBlocked(label, 'database-unreadable', "The previous app version's database failed its integrity check");
    const after = snapshot();
    check(after.get(DB) === before.get(DB), `(${label}) database bytes are unchanged`);
    check(after.get(`${DB}-wal`) === before.get(`${DB}-wal`), `(${label}) -wal bytes are unchanged (${withWal ? 'frames kept, no checkpoint' : 'still absent'})`);
    const changed = differences(before, after);
    check(changed.length === 0, `(${label}) every file is unchanged and none is new, so no .prewrite and no task write (${before.size} files)${shortList(changed)}`);
};

const scenarioMissing = async () => {
    console.log('\n# 5 database missing, no JSON backup, while other RN state exists');
    fresh();
    await seed('5');
    runAs(`rm -f ${DB} ${DB}-wal ${DB}-shm`);
    rewriteAsyncStorage('5-rkstorage', "DELETE FROM catalystLocalStorage WHERE key IN ('mindwtr-data', 'focus-gtd-data', 'gtd-todo-data', 'gtd-data');");
    console.log(`INJECTED (5): deleted ${DB} and its -wal and -shm, and RN's AsyncStorage JSON backup; shared_prefs, files/ and other AsyncStorage rows stay`);
    const before = snapshot();
    check(![...before.keys()].some((path) => path.startsWith(DB)) && before.has(ASYNC_STORAGE), '(5) no database file, RN AsyncStorage present');

    await expectBlocked('5', 'database-missing', "The previous app version's database is missing");
    const changed = differences(before, snapshot());
    check(changed.length === 0, `(5) nothing was created or changed, so no empty database (${before.size} files)${shortList(changed)}`);
};

const scenarioMissingWithBackup = async () => {
    console.log('\n# 5b database missing, RN JSON backup present: migrate');
    fresh();
    const t = await seed('8');
    const seeded = asyncStorage('5b-seeded-rkstorage');
    check(seeded.has(JSON_BACKUP), `(5b) RN wrote its AsyncStorage ${JSON_BACKUP} backup`);
    // INJECTED: fields the RN seed never sets, so the content check covers notes, dates, people, areas and settings keys.
    const backup = JSON.parse(seeded.get(JSON_BACKUP));
    const at = new Date(Date.now() - 60_000).toISOString();
    const stamp = { rev: 1, revBy: 'harness', createdAt: at, updatedAt: at };
    const areaId = randomUUID();
    const personId = randomUUID();
    backup.areas = [...(backup.areas ?? []), { id: areaId, name: `Area${run}`, color: '#123456', order: 0, ...stamp }];
    backup.people = [...(backup.people ?? []), { id: personId, name: `Person${run}`, note: 'Harness note ü', ...stamp }];
    const rich = {
        id: randomUUID(), title: t.backupOnly, status: 'inbox', description: `Notes ü 😀 ${run}\nsecond line`, priority: 'high',
        dueDate: '2030-01-15', startTime: '2029-12-01T09:30', reviewAt: '2030-02-01', tags: ['#harness'], contexts: ['@desk'],
        checklist: [{ id: randomUUID(), title: 'Step', isCompleted: true }], areaId, assignedTo: `Person${run}`, ...stamp,
    };
    backup.tasks.push(rich);
    // Synced keys: the RN merge keeps them (it drops unknown and device-local keys, as RN's own migration does).
    const settingsProbe = { weekStart: 'monday', dateFormat: 'dmy' };
    backup.settings = { ...backup.settings, ...settingsProbe };
    const backupFile = resolve(work, '5b-backup.json');
    writeFileSync(backupFile, JSON.stringify(backup));
    rewriteAsyncStorage('5b-rkstorage', `UPDATE catalystLocalStorage SET value = CAST(readfile('${backupFile}') AS TEXT) WHERE key = '${JSON_BACKUP}';`);
    runAs(`rm -f ${DB} ${DB}-wal ${DB}-shm`);
    console.log(`INJECTED (5b): added to AsyncStorage ${JSON_BACKUP} one task with notes, dates, tags, a checklist and an assignee, one area, one person and two synced settings; deleted ${DB} and its -wal and -shm`);
    const preAsync = asyncStorage('5b-pre-rkstorage');
    const before = snapshot();
    const widgetsBefore = widgetPrefsNow();
    const expected = liveInbox(backup.tasks);

    install(APKS.native153, true);
    device.launch(NATIVE_ACTIVITY);
    const nodes = await nativeScreen();
    check(!unavailable(nodes), `(5b) native boot succeeded ${unavailable(nodes) ?? ''}`);
    check(header(nodes) === expected.length, `(5b) native Inbox counts the backup's ${expected.length} Inbox tasks`);
    for (const title of expected) check(hasText(nodes, title), `(5b) native Inbox shows backup task ${title}`);
    check(nativeGuardLog().includes(`${GUARD} outcome=clear`), '(5b) guard logged outcome=clear');
    const flagWasSet = preAsync.has(RECONCILED);
    importLine('5b', { outcome: 'imported', path: 'migrate', rnState: flagWasSet ? 'unchanged' : 'updated' });
    preflightLine('5b', 'passed');
    const published = await widgetsPublished('5b');
    await stopApp();

    const after = snapshot();
    const postDb = pullDatabase('5b-post');
    for (const [table, items] of [['tasks', backup.tasks], ['projects', backup.projects ?? []], ['areas', backup.areas], ['sections', backup.sections ?? []], ['people', backup.people]]) {
        const ids = rows(postDb, `SELECT id FROM ${table}`).map((item) => item.id).sort();
        check(isDeepStrictEqual(ids, items.map((item) => item.id).sort()), `(5b) SQLite ${table} are exactly the backup's ${items.length}`);
    }
    const state = { jsonAhead: preAsync.has(MARKER), reconciled: flagWasSet, backupVersion: preAsync.get('mindwtr-data:startup-backup-version') ?? null };
    const mismatch = importMismatch(postDb, state, backupFile);
    check(mismatch === 'match', `(5b) every persisted field of every entity, and the settings, equal core's migration of the backup: ${mismatch}`);
    // The same facts read straight from the columns, without core.
    const [stored] = rows(postDb, `SELECT description, dueDate, startTime, reviewAt, assignedTo FROM tasks WHERE id = '${rich.id}'`);
    check(isDeepStrictEqual(stored, { description: rich.description, dueDate: rich.dueDate, startTime: rich.startTime, reviewAt: rich.reviewAt, assignedTo: rich.assignedTo }),
        '(5b) the rich task keeps its notes, dates and assignee byte-exact');
    check(rows(postDb, `SELECT note FROM people WHERE id = '${personId}'`)[0]?.note === 'Harness note ü', '(5b) the person keeps its note');
    check(isDeepStrictEqual(rows(postDb, "SELECT json_extract(data, '$.weekStart') AS weekStart, json_extract(data, '$.dateFormat') AS dateFormat FROM settings WHERE id = 1")[0],
        settingsProbe), '(5b) the settings row keeps the backup settings');
    const postAsync = asyncStorage('5b-post-rkstorage');
    check(postAsync.get(RECONCILED) === '1', '(5b) the reconcile flag is set');
    const asyncChanged = asyncChanges(preAsync, postAsync);
    check(asyncChanged.length === 0, `(5b) no other AsyncStorage row changed, ${JSON_BACKUP} included${shortList(asyncChanged)}`);
    // The boot copies RKStorage once the guard passes, before anything opens it, whether or not RN had set the flag.
    check(checkpointMatches(before, after), `(5b) ${RN_CHECKPOINT} holds the pre-upgrade RKStorage files`);
    const changed = differences(before, after, {
        changedOk: (path) => isAsyncStorage(path) || isWidgetPayload(path),
        newOk: (path) => isDatabase(path) || path === `${DB}.prewrite` || isAsyncStorage(path) || isRnCheckpoint(path) || isWidgetPayload(path),
    });
    check(changed.length === 0, `(5b) every other file is unchanged but RN's widget payload${shortList(changed)}`);
    checkLedger('5b', after);
    checkOwedUploads('5b', after);
    verifyWidgetPayload('5b', widgetsBefore, published);
};

// ---- 6: an RN user's sync configuration ----
const SYNC_PORT = Number(process.env.MINDWTR_SYNC_WEBDAV_PORT ?? 18773);
const { en } = await import(resolve(app, '../../packages/core/src/i18n/locales/en.ts'));
// RN v1.3.2's English labels for its WebDAV panel (en.ts at the tag; the ones this check reads are unchanged since).
const RN_WEBDAV = 'WebDAV';
const RN_SAVE_WEBDAV = 'Save WebDAV';
const RN_SKIP_ONBOARDING = 'Skip for now'; // v1.3.2's onboarding.skipForNow
const scenarioSync = async () => {
    console.log('\n# 6 RN sync configuration');
    fresh();
    const folder = `/dav/mindwtr-upgrade-${run}`;
    const user = `rnuser${run}`;
    const password = `rnpw${run}secret`;
    const url = `http://127.0.0.1:${SYNC_PORT}${folder}`;
    const dav = await serveWebdav({ port: SYNC_PORT, username: user, password });
    adbRaw('reverse', `tcp:${SYNC_PORT}`, `tcp:${SYNC_PORT}`);
    try {
        // RN's own Sync screen (its settings link), WebDAV, the form as a user types it, Save.
        device.launch(RN_ACTIVITY);
        // An empty RN opens on its onboarding, which holds the link back: skip it as a user would.
        let first = [];
        for (const deadline = Date.now() + 20_000; Date.now() < deadline && !first.some((node) => node.text === RN_SKIP_ONBOARDING); await sleep(1_000)) {
            first = await screen();
        }
        const skip = first.find((node) => node.text === RN_SKIP_ONBOARDING);
        if (skip) await tap(skip);
        await sleep(2_000);
        openLink('mindwtr-upgradetest://settings?settingsScreen=sync');
        let nodes = await waitFor('RN Settings > Sync', (current) => current.some((node) => node.text === RN_WEBDAV), 60_000);
        await tap(nodes.find((node) => node.text === RN_WEBDAV));
        // The URL and username fields; the password field and Save can sit below the fold (run 2026-09-30).
        nodes = await waitFor('RN\'s WebDAV form', (current) => current.filter((node) => node.class === 'android.widget.EditText').length >= 2, 20_000);
        const inputs = () => screen().then((current) => current.filter((node) => node.class === 'android.widget.EditText'));
        const hideKeyboard = async () => { if (/mInputShown=true/.test(sh('dumpsys input_method'))) { sh('input keyevent KEYCODE_BACK'); await sleep(600); } };
        // The keyboard goes down after each field: while it shows, RN's ScrollView spends the next tap on closing it, and the
        // text would go to the field before.
        const typeInto = async (input, text) => {
            await tap(input);
            requireAppFront();
            sh(`input text '${text}'`);
            await sleep(500);
            await hideKeyboard();
        };
        /** Scrolls RN's form down until [find] sees what it needs, whole enough to tap (not cut by the header). */
        const reveal = async (what, find) => {
            const shown = (current) => current.filter((node) => { const [, top, , bottom] = box(node); return bottom - top >= 40; });
            let current = await screen();
            // Short slow drags: RN's ScrollView flings a long one past a whole field.
            for (let step = 0; step < 12 && !find(shown(current)); step += 1) {
                requireAppFront();
                sh('input swipe 540 1000 540 600 900'); // above a keyboard that may still show
                await sleep(700);
                current = await screen();
            }
            return find(shown(current)) ?? fail(`no ${what} in RN's WebDAV form`);
        };
        await typeInto((await inputs())[0], url);
        const insecure = (await screen()).find((node) => node.class === 'android.widget.Switch');
        if (insecure?.checked !== 'true') await tap(insecure ?? fail('no Allow insecure switch in RN\'s WebDAV form'));
        await typeInto((await inputs())[1], user);
        await hideKeyboard();
        // The password field: RN's secure text field.
        await typeInto(await reveal('password field', (current) => current.find((node) => node.class === 'android.widget.EditText' && node.password === 'true')), password);
        await hideKeyboard();
        // A tap while the password field still holds focus can only blur it (RN's ScrollView keeps no taps then): tap Save
        // again when nothing reached the server.
        const requestsBefore = dav.state.requests.length;
        for (let attempt = 0; attempt < 2 && dav.state.requests.length === requestsBefore; attempt += 1) {
            await tap(await reveal(`"${RN_SAVE_WEBDAV}"`, (current) => current.find((node) => node.text === RN_SAVE_WEBDAV)));
            for (const deadline = Date.now() + 10_000; Date.now() < deadline && dav.state.requests.length === requestsBefore;) await sleep(500);
        }
        await until('RN\'s first sync into the local folder', () => webdavDocument(dav, folder) !== null, 60_000);
        await sleep(2_000);
        await stopApp();
        const rnKeys = asyncStorage('6-rn-rkstorage');
        check(rnKeys.get('@mindwtr_sync_backend') === 'webdav' && rnKeys.get('@mindwtr_webdav_url') === url && rnKeys.get('@mindwtr_webdav_username') === user,
            '(6) RN stored its WebDAV backend, URL and username in RKStorage');
        check(/name="key_v1-mindwtr_webdav_password"/.test(runAs('cat shared_prefs/SecureStore.xml')), '(6) RN sealed the password in its secret store');
        check(unfinishedWork('6-rn-workdb', RN_SYNC_WORK).length === 1, '(6) RN scheduled its background sync worker for the WebDAV backend');

        // The native app over it: RN's keys found in place, shown on its Sync screen, and used for a sync.
        install(APKS.native153, true);
        device.launch(NATIVE_ACTIVITY);
        await nativeScreen();
        await until('the native app to start sync', () => device.logs(pid(), TAG).includes('Native Android sync started'), 30_000);
        // Pass S4a: the first native start cancelled RN's worker, and core's decision scheduled the native job, once.
        await until('the native background sync job', () => unfinishedWork('6-native-workdb', NATIVE_SYNC_WORK).length === 1, 30_000);
        check(unfinishedWork('6-native-workdb', RN_SYNC_WORK).length === 0, '(6) the native app\'s first start cancelled RN\'s background sync worker');
        check(unfinishedWork('6-native-workdb', NATIVE_SYNC_WORK).length === 1, '(6) the native background sync job is scheduled once');
        nodes = await screen();
        const sheet = (current) => Boolean(tagged(current, 'more-sheet'));
        await tap(tab(nodes, en['tab.menu']) ?? fail('no Menu tab'));
        nodes = await waitFor('the More sheet', sheet, 10_000);
        await tap(withDescription(nodes, en['nav.settings']) ?? fail('no Settings tile'));
        nodes = await waitFor('native Settings', (current) => Boolean(tagged(current, 'settings-main')), 20_000);
        let row = nodes.find((node) => (node['content-desc'] ?? '').startsWith(`${en['settings.sync']}. `));
        for (let step = 0; step < 6 && !row; step += 1) {
            nodes = await device.swipe(nodes, 'down');
            row = nodes.find((node) => (node['content-desc'] ?? '').startsWith(`${en['settings.sync']}. `));
        }
        await tap(row ?? fail('no Sync row in native Settings'));
        nodes = await waitFor('native Settings > Sync with RN\'s WebDAV form', (current) => Boolean(tagged(current, 'sync-url')), 30_000);
        // Compose reports a selected button chip as checked.
        check(tagged(nodes, 'sync-backend-webdav')?.checked === 'true', '(6) the native Sync screen shows RN\'s backend (WebDAV chosen)');
        check(tagged(nodes, 'sync-url')?.text === url, `(6) it shows RN's URL (${tagged(nodes, 'sync-url')?.text})`);
        let now = nodes;
        for (let step = 0; step < 6 && !tagged(now, 'sync-now'); step += 1) now = await device.swipe(now, 'down');
        check(tagged(now, 'sync-username')?.text === user, '(6) it shows RN\'s username');
        const beforeSync = dav.state.authorized.length;
        await tap(tagged(now, 'sync-now') ?? fail('no Sync now'));
        await waitFor('the native Sync now to complete', (current) => current.some((node) => node.text === en['settings.syncCompleted']), 60_000);
        check(dav.state.authorized.slice(beforeSync).some((request) => request.startsWith(`GET ${folder}/data.json`)),
            '(6) the native app synced with RN\'s password from RN\'s secret store (the folder answered its signed-in reads)');
        await stopApp();
    } finally {
        try { adbRaw('reverse', '--remove', `tcp:${SYNC_PORT}`); } catch { /* device gone */ }
        await dav.close();
    }
};

// ---- 11: an RN user's File Sync folder ----
const RN_FILE = 'File'; // v1.3.2's settings.syncBackendFile
const RN_SELECT_FOLDER = 'Select Folder'; // v1.3.2's settings.selectFolder
/** The folder lock's authority files (RN's SyncFileLockModule: files/file-sync-root-authorities/<sha256>.lock). */
const authorityLocks = () => runAs('ls files/file-sync-root-authorities 2>/dev/null || true').split(/\s+/).filter((name) => name.endsWith('.lock')).sort();
const scenarioFileSync = async () => {
    console.log('\n# 11 RN File Sync folder');
    fresh();
    const dir = `mts5u${run}`.slice(0, 16);
    const folder = `/sdcard/Download/${dir}`;
    const folderNames = () => sh(`ls -a ${folder}`).split(/\s+/).filter((name) => name && name !== '.' && name !== '..');
    sh(`mkdir -p ${folder}`);
    try {
        // RN's own Sync screen: File, Select Folder, the system picker in this run's folder.
        device.launch(RN_ACTIVITY);
        let first = [];
        for (const deadline = Date.now() + 20_000; Date.now() < deadline && !first.some((node) => node.text === RN_SKIP_ONBOARDING); await sleep(1_000)) {
            first = await screen();
        }
        const skip = first.find((node) => node.text === RN_SKIP_ONBOARDING);
        if (skip) await tap(skip);
        await sleep(2_000);
        openLink('mindwtr-upgradetest://settings?settingsScreen=sync');
        let nodes = await waitFor('RN Settings > Sync', (current) => current.some((node) => node.text === RN_FILE), 60_000);
        await tap(nodes.find((node) => node.text === RN_FILE));
        // Select Folder sits below the panel's how-to box.
        nodes = await waitFor('RN\'s File panel', (current) => current.some((node) => node.text === 'Folder / File Sync'), 20_000);
        for (let step = 0; step < 8 && !nodes.some((node) => node.text === RN_SELECT_FOLDER && box(node)[3] < 2000); step += 1) {
            requireAppFront();
            sh('input swipe 540 1600 540 900 900');
            await sleep(700);
            nodes = await screen();
        }
        await tap(nodes.find((node) => node.text === RN_SELECT_FOLDER) ?? fail('no Select Folder in RN\'s File panel'));
        await pickFolder(['Download', dir]);
        await until('RN\'s first sync into the picked folder', () => folderNames().includes('data.json') && folderNames().includes('.mindwtr.lock'), 60_000);
        await sleep(2_000);
        await stopApp();
        const rnKeys = asyncStorage('11-rn-rkstorage');
        const path = rnKeys.get('@mindwtr_sync_path') ?? '';
        check(rnKeys.get('@mindwtr_sync_backend') === 'file' && path.includes(`/tree/primary%3ADownload%2F${dir}/`),
            `(11) RN stored its File Sync backend and the picked folder in RKStorage (${path})`);
        check(persistedGrant(`Download%2F${dir}`), '(11) RN holds the picked folder as a persisted grant');
        const locks = authorityLocks();
        check(locks.length === 1, `(11) RN's folder lock made one authority lock file (${locks.join(', ')})`);

        // The native app over it: RN's folder on its Sync screen, and a Sync now that writes into it with no new pick.
        const queued = { id: randomUUID(), title: `97${run}`, createdAt: new Date().toISOString(), source: 'android-quick-capture' };
        queue([queued]);
        install(APKS.native153, true);
        device.launch(NATIVE_ACTIVITY);
        nodes = await nativeScreen();
        check(!unavailable(nodes), `(11) native boot succeeded ${unavailable(nodes) ?? ''}`);
        await tap(tab(nodes, en['tab.menu']) ?? fail('no Menu tab'));
        nodes = await waitFor('the More sheet', (current) => Boolean(tagged(current, 'more-sheet')), 10_000);
        await tap(withDescription(nodes, en['nav.settings']) ?? fail('no Settings tile'));
        nodes = await waitFor('native Settings', (current) => Boolean(tagged(current, 'settings-main')), 20_000);
        let row = nodes.find((node) => (node['content-desc'] ?? '').startsWith(`${en['settings.sync']}. `));
        for (let step = 0; step < 6 && !row; step += 1) {
            nodes = await device.swipe(nodes, 'down');
            row = nodes.find((node) => (node['content-desc'] ?? '').startsWith(`${en['settings.sync']}. `));
        }
        await tap(row ?? fail('no Sync row in native Settings'));
        nodes = await waitFor('native Settings > Sync with RN\'s folder', (current) => Boolean(tagged(current, 'sync-select-folder')), 30_000);
        // Compose reports a selected button chip as checked.
        check(tagged(nodes, 'sync-backend-file')?.checked === 'true', '(11) the native Sync screen shows RN\'s backend (File chosen)');
        // Core's folder label (getSyncFolderLabel, as RN shows it): the stored path's decoded leaf.
        const label = decodeURIComponent(path).split('/').pop();
        let now = nodes;
        for (let step = 0; step < 6 && !(tagged(now, 'sync-now') && now.some((node) => node.text === label)); step += 1) now = await device.swipe(now, 'down');
        check(now.some((node) => node.text === label), `(11) it shows RN's stored folder path (${label})`);
        await tap(tagged(now, 'sync-now') ?? fail('no Sync now'));
        await until('the native capture in RN\'s data.json', () => {
            const document = JSON.parse(sh(`cat ${folder}/data.json`));
            return document.tasks.some((task) => task.id === queued.id && task.title === queued.title && !task.deletedAt);
        }, 120_000);
        check(front().includes(`${PKG}/`), '(11) the native Sync now wrote its capture into RN\'s data.json with no new pick');
        check(!folderNames().some((name) => /\.mindwtr-et-|mindwtr-write-test|\.tmp$/.test(name)), `(11) no scratch file is left (${folderNames().join(', ')})`);
        await stopApp();
        check(persistedGrant(`Download%2F${dir}`), '(11) the native app still holds RN\'s folder grant');
        const after = authorityLocks();
        check(isDeepStrictEqual(after, locks), `(11) the native lock used RN's authority lock file, same name (${after.join(', ')})`);
    } finally {
        sh(`rm -rf ${folder}`);
    }
};

// ---- 7: RN's reminder alarms at the upgrade ----
const RN_RECEIVER = 'com.emekalites.react.alarm.notification.AlarmReceiver';
const NATIVE_FIRE = 'tech.dongdongbh.mindwtr.reminder.FIRE';
/** This package's pending alarms (`dumpsys alarm`): RN's (its library's receiver) and the native app's (its FIRE action), with when each fires. */
const packageAlarms = () => sh('dumpsys alarm').split(/\n(?=\s*(?:RTC_WAKEUP|RTC|ELAPSED_WAKEUP|ELAPSED) #\d+: Alarm\{)/)
    .filter((block) => block.includes(PKG))
    .map((block) => ({ rn: block.includes(RN_RECEIVER), native: block.includes(`*walarm*:${NATIVE_FIRE}`), at: Number(/origWhen[= ](\d+)/.exec(block)?.[1] ?? NaN) }))
    // Reminder alarms are RTC (an epoch time); a block that ends dumpsys's pending list can carry the delivery history's lines.
    .filter((alarm) => (alarm.rn || alarm.native) && alarm.at > 1e12);
// RN's library sets the minute and second but keeps the current milliseconds (AlarmUtil's Calendar), so its alarm is in that minute.
const rnMinute = (alarm) => Math.floor(alarm.at / 60_000) * 60_000;
/** The process gone without a force-stop (a force-stop would drop the alarms this scenario is about). */
const killWithoutStop = async () => {
    if (front().includes(`${PKG}/`)) sh('input keyevent KEYCODE_HOME');
    for (let attempt = 0; attempt < 20 && pid(); attempt += 1) {
        try { runAs(`kill -9 ${pid()}`); } catch { /* gone meanwhile */ }
        await sleep(500);
    }
    if (pid()) fail('the app process did not end');
};
const scenarioAlarms = async () => {
    console.log('\n# 7 reminder alarms: RN\'s cancelled, the native app\'s set, once each');
    fresh();
    const zone = sh('getprop persist.sys.timezone') || 'UTC';
    const dueAt = Math.ceil((Number(sh('date +%s')) * 1000 + 2 * 3600_000) / 60_000) * 60_000;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
        minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(dueAt)).map((part) => [part.type, part.value]));
    const title = `77${run}`;
    const item = { id: randomUUID(), title: `${title} /next /due:${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`, createdAt: new Date().toISOString(), source: 'android-quick-capture' };
    // RN's first launch makes its database with task reminders off (its default); they are turned on in that database, as RN's
    // Settings › Notifications would, before RN reads it again.
    device.launch(RN_ACTIVITY);
    await until('RN\'s settings row', () => rows(pullDatabase('7-first'), 'SELECT id FROM settings WHERE id = 1').length === 1, 60_000);
    await stopApp();
    const db = pullDatabase('7-reminders-on');
    execFileSync('bun', ['-e', `
        import { Database } from 'bun:sqlite';
        const db = new Database(process.env.CHECK_DB);
        db.query("UPDATE settings SET data = json_set(data, '$.notificationsEnabled', json('true')) WHERE id = 1").run();
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        db.close();
    `], { env: { ...process.env, CHECK_DB: db } });
    pushPrivate(db, DB);
    runAs(`rm -f ${DB}-wal ${DB}-shm`);
    // RN's start may apply its AsyncStorage JSON backup over SQLite (its startup snapshot): the backup gets the same switch.
    if (asyncStorage('7-backup').has(JSON_BACKUP)) {
        rewriteAsyncStorage('7-backup-on', `UPDATE catalystLocalStorage SET value = json_set(value, '$.settings.notificationsEnabled', json('true')) WHERE key = '${JSON_BACKUP}';`);
    }
    queue([item]);
    device.launch(RN_ACTIVITY);
    await drained([item], 'the timed capture');
    const rnAlarmed = () => packageAlarms().some((alarm) => alarm.rn && rnMinute(alarm) === dueAt);
    try {
        await until('RN\'s alarm for the task', rnAlarmed, 30_000);
    } catch {
        // RN 1.3.2 subscribes to its store only after its first reminder cycle, so a capture its startup import adds while that
        // cycle runs gets no alarm (fixed in RN since, v1.3.5/reminder-startup-subscribe). Its next start arms the stored task.
        console.log('info - RN 1.3.2 armed no alarm for the task its startup imported (its startup race); RN started once more');
        await killWithoutStop();
        device.launch(RN_ACTIVITY);
    }
    try {
        await until('RN\'s alarm for the task', rnAlarmed, 60_000);
    } catch (error) {
        console.log(`evidence - due ${dueAt} (${item.title}); this package's alarm lines:\n${sh('dumpsys alarm').split('\n').filter((line) => line.includes(PKG) || /origWhen/.test(line)).slice(0, 30).join('\n')}`);
        console.log(`evidence - RN's map: ${asyncStorage('7-evidence').get('mindwtr:local:alarms:v1')}`);
        console.log(`evidence - RN's task: ${JSON.stringify(rows(pullDatabase('7-evidence'), `SELECT title, dueDate, status FROM tasks WHERE id = '${item.id}'`))}`);
        console.log(`evidence - RN's reminders switch: ${JSON.stringify(rows(pullDatabase('7-evidence-settings'), "SELECT json_extract(data, '$.notificationsEnabled') AS on_ FROM settings WHERE id = 1"))}`);
        throw error;
    }
    await killWithoutStop();
    const before = packageAlarms();
    console.log(`info - this package's alarms before the upgrade: ${JSON.stringify(before.map(({ rn, native, at }) => ({ rn, native, at })))}; due ${dueAt}`);
    const rnMap = JSON.parse(asyncStorage('7-rn').get('mindwtr:local:alarms:v1') ?? '{}');
    check(before.filter((alarm) => alarm.rn && rnMinute(alarm) === dueAt).length === 1 && !before.some((alarm) => alarm.native),
        `(7) before: RN holds one alarm for ${title} at its due time, to its library's AlarmReceiver; the native app none`);
    check(Number.isInteger(rnMap[`task:${item.id}`]?.id) && runAs('ls databases').split(/\s+/).includes('rnandb'), '(7) RN\'s alarm map and alarm database name it');
    sh('logcat -c');
    install(APKS.native153, true);
    device.launch(NATIVE_ACTIVITY);
    check(!unavailable(await nativeScreen()), '(7) native boot succeeded');
    await until('the native alarm', () => packageAlarms().some((alarm) => alarm.native && alarm.at === dueAt), 60_000);
    await sleep(3000);
    const after = packageAlarms();
    check(!after.some((alarm) => alarm.rn), '(7) after: RN\'s alarm is gone');
    check(after.filter((alarm) => alarm.native && alarm.at === dueAt).length === 1, '(7) after: the native app holds one alarm for the task, at its due time');
    check(!runAs('ls databases').split(/\s+/).some((name) => name.startsWith('rnandb')), '(7) RN\'s alarm database is deleted');
    const nativeMap = JSON.parse(asyncStorage('7-native').get('mindwtr:local:alarms:v1') ?? '{}');
    const entry = nativeMap[`task:${item.id}`];
    check(Number.isInteger(entry?.id) && !entry.pending && entry.id !== rnMap[`task:${item.id}`].id,
        `(7) the alarm map is the native plan's: the task under core's id ${entry?.id}, not RN's row ${rnMap[`task:${item.id}`].id}`);
    check(adbRaw('logcat', '-d', '-s', `${TAG}:*`).toString('utf8').includes('rnCancelled=1'), '(7) the native start logged one RN alarm cancelled');
    await killWithoutStop();
    // RN recovery over the native app: the map under RN's key is the native app's, whose alarms RN does not hold.
    install(APKS.rn154, true);
    device.launch(RN_ACTIVITY);
    await until('RN recovery\'s alarm for the task', () => packageAlarms().some((alarm) => alarm.rn && rnMinute(alarm) === dueAt), 90_000);
    await sleep(3000);
    check(packageAlarms().filter((alarm) => alarm.rn && rnMinute(alarm) === dueAt).length === 1, '(7) RN recovery over the native app sets its own alarm for the task, once');
    await killWithoutStop();
};

// ---- 9: RN's Pomodoro session, its fold and the persistent capture notification at the upgrade ----
const POMODORO_KEYS = { session: '@mindwtr_pomodoro_state', fold: '@mindwtr_pomodoro_collapsed', rnAlarm: 'mindwtr:local:pomodoro-alarm:v1',
    capture: 'mindwtr:persistentCaptureNotification' };
const captureShown = () => sh('dumpsys notification --noredact').split(/\n(?=\s*NotificationRecord\()/)
    .filter((block) => block.includes(`pkg=${PKG}`) && /\bid=41120\b/.test(block) && block.includes('mindwtr-persistent-capture')).length;
const RN_POMODORO_FEATURE = 'Pomodoro timer'; // v1.3.2's settings.featurePomodoro
const RN_FOCUS_MINUTES = 'Focus minutes'; // v1.3.2's settings.pomodoroFocusMinutes
const RN_BREAK_MINUTES = 'Break minutes'; // v1.3.2's settings.pomodoroBreakMinutes
const RN_CAPTURE_SWITCH = 'Quick capture in notification bar'; // v1.3.2's settings.persistentCaptureLabel
// The native Pomodoro's alarms (PomodoroAlarms.kt): its broadcast, and its book (core's record, `armed:`, the `fired:` ledger).
const POMODORO_FIRE = 'tech.dongdongbh.mindwtr.pomodoro.FIRE';
const pomodoroAlarms = () => sh('dumpsys alarm').split(/\n(?=\s*(?:RTC_WAKEUP|RTC|ELAPSED_WAKEUP|ELAPSED) #\d+: Alarm\{)/)
    .filter((block) => block.includes(PKG) && block.includes(`*walarm*:${POMODORO_FIRE}`))
    .map((block) => Number(/origWhen[= ](\d+)/.exec(block)?.[1] ?? NaN)).filter((at) => at > 1e12);
const unxml = (value) => value.replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/&amp;/g, '&');
const pomodoroBook = () => new Map([...runAs('cat shared_prefs/mindwtr_pomodoro_alarms.xml 2>/dev/null || true')
    .matchAll(/<string name="([^"]*)">([^<]*)<\/string>/g)].map(([, name, value]) => [unxml(name), unxml(value)]));
/** This package's alarm in core's record (the library scope is the package and its SHA-256). */
const pomodoroRecorded = (book) => JSON.parse(book.get('record') ?? '{"libraries":[]}').libraries
    .find((library) => library.scope === `${PKG}:${createHash('sha256').update(PKG).digest('hex')}`)?.alarm ?? null;
const nativeSession = (name) => JSON.parse(rows(pullDatabase(name), 'SELECT state_json FROM native_pomodoro_session WHERE id = 1')[0]?.state_json ?? 'null');
/** The Pomodoro alerts with [text] in the tray, each with its tag and the time Android last posted it. */
const pomodoroShown = (text) => sh('dumpsys notification --noredact').split(/\n(?=\s*NotificationRecord\()/)
    .filter((block) => block.includes(`pkg=${PKG}`) && block.includes(text))
    .map((block) => ({ tag: /\btag=([^\s,)]+)/.exec(block)?.[1] ?? '', posted: /\bmUpdateTimeMs=(\d+)/.exec(block)?.[1] ?? /\bpostTime=(\d+)/.exec(block)?.[1] ?? '' }));
const rnField = (nodes, label) => nodes.find((node) => node.class === 'android.widget.EditText' && (node['content-desc'] === label || node.hint === label));
/**
 * A fresh RN v1.3.2 set up through its own screens, as a user would: its onboarding skipped, Settings › GTD › Pomodoro's feature
 * turned on (and its minute fields typed when [minutes] is given), and Settings › Notifications' capture switch turned on.
 */
const rnPomodoroSetup = async (n, minutes) => {
    fresh();
    device.launch(RN_ACTIVITY);
    await until('RN\'s settings row', () => rows(pullDatabase(`${n}-first`), 'SELECT id FROM settings WHERE id = 1').length === 1, 60_000);
    // An empty RN opens on its onboarding, which holds the link back: skip it as a user would (as 6 does).
    let first = [];
    for (const deadline = Date.now() + 20_000; Date.now() < deadline && !first.some((node) => node.text === RN_SKIP_ONBOARDING); await sleep(1_000)) {
        first = await screen();
    }
    const skip = first.find((node) => node.text === RN_SKIP_ONBOARDING);
    if (skip) await tap(skip);
    await sleep(2_000);
    const stored = () => rows(pullDatabase(`${n}-settings`), "SELECT json_extract(data, '$.features.pomodoro') AS pomodoro, "
        + "json_extract(data, '$.gtd.pomodoro.customDurations.focusMinutes') AS focus, json_extract(data, '$.gtd.pomodoro.customDurations.breakMinutes') AS brk "
        + 'FROM settings WHERE id = 1')[0] ?? {};
    openLink('mindwtr-upgradetest://settings?settingsScreen=gtd-pomodoro');
    let nodes = await waitFor('RN\'s Settings › GTD › Pomodoro', (current) => current.some((node) => node.text === RN_POMODORO_FEATURE), 60_000);
    await tap(button(nodes, RN_POMODORO_FEATURE) ?? nodes.find((node) => node.text === RN_POMODORO_FEATURE));
    nodes = await waitFor('RN\'s Pomodoro settings', (current) => Boolean(rnField(current, RN_FOCUS_MINUTES)), 20_000);
    await until('RN to store the Pomodoro feature', () => stored().pomodoro === 1, 30_000);
    if (minutes) {
        // RN commits both fields on a field's blur: the break field's tap blurs the focus field, a tap on the focus field again blurs the last.
        for (const label of [RN_FOCUS_MINUTES, RN_BREAK_MINUTES]) {
            await tap(rnField(nodes, label));
            sh('input keyevent KEYCODE_MOVE_END');
            for (let i = 0; i < 4; i += 1) sh('input keyevent KEYCODE_DEL');
            sh(`input text ${minutes}`);
            nodes = await screen();
        }
        await tap(rnField(nodes, RN_FOCUS_MINUTES));
        sh('input keyevent KEYCODE_BACK');
        await until(`RN to store ${minutes}/${minutes} minutes`, () => stored().focus === Number(minutes) && stored().brk === Number(minutes), 30_000);
    }
    openLink('mindwtr-upgradetest://settings?settingsScreen=notifications');
    const captureSwitch = (current) => current.find((node) => node.class === 'android.widget.Switch' && node['content-desc'] === RN_CAPTURE_SWITCH);
    nodes = await waitFor('RN\'s Settings › Notifications', (current) => Boolean(captureSwitch(current)), 30_000);
    if (captureSwitch(nodes).checked !== 'true') await tap(captureSwitch(nodes));
    await until('RN to store the capture switch', () => asyncStorage(`${n}-capture`).get(POMODORO_KEYS.capture) === 'true', 20_000);
};
/** RN's Focus card at the [preset] (its label, as `1/1`), started; RN's session and its alarm record once stored. */
const rnStart = async (n, preset) => {
    openLink('mindwtr-upgradetest://focus');
    let nodes = await waitFor('RN\'s Pomodoro card', (current) => current.some((node) => node.text === 'Pomodoro Timer') && current.some((node) => node.text === 'Start')
        && (!preset || current.some((node) => node.text === preset)), 60_000);
    if (preset) {
        await tap(nodes.find((node) => node.text === preset));
        nodes = await waitFor(`RN's ${preset} clock`, (current) => current.some((node) => node.text === `${preset.split('/')[0].padStart(2, '0')}:00`), 15_000);
    }
    await tap(nodes.find((node) => node.text === 'Start'));
    await until('RN\'s running session', () => JSON.parse(asyncStorage(`${n}-rn-run`).get(POMODORO_KEYS.session) ?? '{}').timerState?.isRunning === true, 20_000);
    await until('RN\'s Pomodoro alarm record', () => JSON.parse(asyncStorage(`${n}-rn-alarm`).get(POMODORO_KEYS.rnAlarm) ?? '{}').id !== undefined, 30_000);
};
const scenarioPomodoro = async () => {
    console.log('\n# 9 Pomodoro session, fold and persistent capture notification carried over');
    await rnPomodoroSetup('9');
    await rnStart('9');
    let nodes = await waitFor('RN\'s fold button', (current) => current.some((node) => node['content-desc'] === 'Collapse timer'), 15_000);
    await tap(nodes.find((node) => node['content-desc'] === 'Collapse timer'));
    await until('RN\'s fold stored', () => asyncStorage('9-rn-fold').get(POMODORO_KEYS.fold) === 'true', 20_000);
    const rnState = asyncStorage('9-rn');
    const session = JSON.parse(rnState.get(POMODORO_KEYS.session));
    const fireAtMs = Date.parse(session.phaseEndsAt);
    const rnAt = (alarm) => alarm.rn && Math.abs(alarm.at - fireAtMs) < 60_000;
    await until('RN\'s Pomodoro alarm', () => packageAlarms().some(rnAt), 30_000);
    try {
        await until('RN\'s persistent capture notification', () => captureShown() >= 1, 20_000);
    } catch (error) {
        console.log(`evidence - this package's notification records:\n${sh('dumpsys notification --noredact').split('\n').filter((line) => line.includes(PKG) && /NotificationRecord|channel/.test(line)).slice(0, 12).join('\n')}`);
        console.log(`evidence - RN's switch key: ${asyncStorage('9-capture-evidence').get(POMODORO_KEYS.capture)}`);
        throw error;
    }
    check(true, '(9) before: RN shows the persistent capture notification');
    check(packageAlarms().filter(rnAt).length === 1 && JSON.parse(rnState.get(POMODORO_KEYS.rnAlarm)).fireAtMs === fireAtMs,
        `(9) before: RN runs the timer to ${session.phaseEndsAt}, folded, with one alarm and its record`);
    await killWithoutStop();
    sh('logcat -c');
    install(APKS.native153, true);
    device.launch(NATIVE_ACTIVITY);
    check(!unavailable(await nativeScreen()), '(9) native boot succeeded');
    // The first start adopts RN's session, then plans the running phase's alert.
    await until('the native Pomodoro alarm', () => pomodoroAlarms().includes(fireAtMs), 60_000);
    await sleep(3000);
    const after = asyncStorage('9-native');
    check(!packageAlarms().some(rnAt) && pomodoroAlarms().length === 1,
        '(9) after: RN\'s Pomodoro alarm is cancelled with RN\'s others; the native app arms one Pomodoro alarm at the same phase end');
    const recorded = pomodoroRecorded(pomodoroBook());
    const adopted = nativeSession('9-native-db');
    check(recorded?.phase === 'focus' && recorded.fireAtMs === fireAtMs && recorded.sessionID === adopted?.sessionID,
        '(9) core\'s alarm record names the adopted session\'s focus phase and its end');
    check(adopted?.session?.timerState?.isRunning === true && adopted.session.phaseEndsAt === session.phaseEndsAt
        && JSON.stringify(adopted.session.durations) === JSON.stringify(session.durations),
        '(9) the native session is RN\'s, adopted: running, the same phase end and minutes');
    check(after.get(POMODORO_KEYS.rnAlarm) === rnState.get(POMODORO_KEYS.rnAlarm) && after.get(POMODORO_KEYS.session) === rnState.get(POMODORO_KEYS.session)
        && after.get(POMODORO_KEYS.fold) === 'true', '(9) RN\'s session, fold and Pomodoro record are kept as RN stored them, byte for byte');
    check(pomodoroShown(en['pomodoro.focusComplete']).length === 0, '(9) no Pomodoro alert shows (RN\'s was not due yet)');
    nodes = await waitFor('the native tabs', (current) => Boolean(tab(current, 'Focus')), 30_000);
    await tap(tab(nodes, 'Focus'));
    await waitFor('the folded running card', (current) => Boolean(tagged(current, 'pomodoro-card')) && Boolean(tagged(current, 'pomodoro-fold'))
        && current.some((node) => node.text === 'FOCUS · RUNNING'), 30_000);
    check(true, '(9) the native Focus card shows RN\'s timer, folded and running');
    await until('the persistent capture notification', () => captureShown() >= 1, 20_000);
    check(after.get(POMODORO_KEYS.capture) === 'true', '(9) the persistent capture notification shows, and RN\'s key is kept');
    await killWithoutStop();
    install(APKS.rn154, true);
    device.launch(RN_ACTIVITY);
    await until('RN recovery\'s Focus', () => asyncStorage('9-rn154').get(POMODORO_KEYS.session) !== undefined, 60_000);
    await sleep(10_000);
    // RN's controller recomputes the remaining time on hydration and stores it (1500 s -> 1470 s after 30 s): the same session,
    // only nearer its end.
    const recovered = JSON.parse(asyncStorage('9-recovery').get(POMODORO_KEYS.session) ?? '{}');
    // Computed at RN's hydration, before now: at least what is left now, and no more than RN stored.
    const leftNow = Math.floor((Date.parse(session.phaseEndsAt) - Date.now()) / 1000) - 2;
    const same = (path) => JSON.stringify(path(recovered)) === JSON.stringify(path(session));
    check(!packageAlarms().some((alarm) => alarm.native), '(9) RN recovery over the native app: no native reminder alarm');
    check(same((x) => x.durations) && same((x) => x.timerState?.phase) && same((x) => x.timerState?.isRunning) && same((x) => x.phaseEndsAt)
        && same((x) => x.selectedTaskId) && same((x) => x.sessionHistory?.totalCompletedFocusSessions) && same((x) => x.timerState?.completedFocusSessions)
        && recovered.timerState.remainingSeconds <= session.timerState.remainingSeconds
        && recovered.timerState.remainingSeconds >= leftNow,
        `(9) RN recovery keeps RN's session: same phase, durations, phase end, task and totals; remaining ${session.timerState.remainingSeconds} s -> ${recovered.timerState?.remainingSeconds} s (at least ${leftNow} s left now)`);
    // RN 154 predates RN's re-arm fix (45dff1573): its record matches its phase, so it arms nothing (9c runs the fixed build).
    // Android keeps a package's alarms across an update: the native one stays, and fires into no receiver of RN's.
    console.log(`info - RN recovery's Pomodoro alarms at the phase end: ${packageAlarms().filter(rnAt).length}; the native Pomodoro alarms left: ${pomodoroAlarms().length}`);
    await killWithoutStop();
};

// ---- 9b: RN's Pomodoro alert, due after the update, shows once in the native app ----
const scenarioPomodoroDue = async () => {
    console.log('\n# 9b RN\'s Pomodoro alert due after the update shows once');
    await rnPomodoroSetup('9b', '1');
    await rnStart('9b', '1/1');
    const rnRecord = JSON.parse(asyncStorage('9b-rn').get(POMODORO_KEYS.rnAlarm));
    check(rnRecord.fireAtMs - Date.now() > 20_000, `(9b) before: RN armed its alert for ${new Date(rnRecord.fireAtMs).toISOString()}, still ahead`);
    await killWithoutStop();
    install(APKS.native153, true);
    // Not opened until after RN's time: RN's alarm fires into RN's receiver, which the native app no longer has.
    await sleep(Math.max(0, rnRecord.fireAtMs - Date.now()) + 15_000);
    check(pomodoroShown(en['pomodoro.focusComplete']).length === 0, '(9b) at RN\'s alarm time nothing showed (RN\'s receiver is gone)');
    device.launch(NATIVE_ACTIVITY);
    check(!unavailable(await nativeScreen()), '(9b) native boot succeeded');
    await until('the owed focus alert', () => pomodoroShown(en['pomodoro.focusComplete']).length === 1, 30_000);
    await sleep(5000);
    const [owed] = pomodoroShown(en['pomodoro.focusComplete']);
    const book = pomodoroBook();
    check(pomodoroShown(en['pomodoro.focusComplete']).length === 1 && owed.tag.startsWith('rn:') && book.has(`fired:${owed.tag}`),
        `(9b) the native start shows RN's owed focus alert once, with core's words, and its ledger holds it (${owed.tag})`);
    check(pomodoroAlarms().length === 0 && nativeSession('9b-native-db')?.session?.timerState?.isRunning === false,
        '(9b) the adopted session settles the ended phase and arms nothing');
    await killWithoutStop();
    device.launch(NATIVE_ACTIVITY);
    check(!unavailable(await nativeScreen()), '(9b) native second boot succeeded');
    await sleep(8000);
    const again = pomodoroShown(en['pomodoro.focusComplete']);
    check(again.length === 1 && again[0].posted === owed.posted && pomodoroAlarms().length === 0,
        `(9b) a second start posts it no second time (last posted ${owed.posted}, now ${again[0]?.posted}) and arms nothing`);
    await killWithoutStop();
};

// ---- 9c: RN with its re-arm fix over the native app mid-phase: RN's alert arrives ----
const scenarioPomodoroRnFix = async () => {
    console.log('\n# 9c RN 155 (alarm re-arm fix) over the native app mid-phase');
    await rnPomodoroSetup('9c', '2');
    await rnStart('9c', '2/2');
    const session = JSON.parse(asyncStorage('9c-rn').get(POMODORO_KEYS.session));
    const fireAtMs = Date.parse(session.phaseEndsAt);
    const rnAt = (alarm) => alarm.rn && Math.abs(alarm.at - fireAtMs) < 60_000;
    await until('RN\'s Pomodoro alarm', () => packageAlarms().some(rnAt), 30_000);
    await killWithoutStop();
    install(APKS.native153, true);
    device.launch(NATIVE_ACTIVITY);
    check(!unavailable(await nativeScreen()), '(9c) native boot succeeded');
    await until('the native Pomodoro alarm', () => pomodoroAlarms().includes(fireAtMs), 60_000);
    check(!packageAlarms().some(rnAt), '(9c) the native app cancelled RN\'s alarm and armed its own at the phase end');
    await killWithoutStop();
    install(APKS.rn155, true);
    device.launch(RN_ACTIVITY);
    await until('RN 155\'s Pomodoro alarm again', () => packageAlarms().some(rnAt), 60_000);
    check(packageAlarms().filter(rnAt).length === 1 && Date.now() < fireAtMs,
        '(9c) RN 155 arms its Pomodoro alarm again before the phase end, once (its record matched, its library held none)');
    await killWithoutStop();
    await until('RN\'s focus alert', () => pomodoroShown(en['pomodoro.focusComplete']).length === 1, Math.max(0, fireAtMs - Date.now()) + 60_000);
    await sleep(10_000);
    check(pomodoroShown(en['pomodoro.focusComplete']).length === 1, '(9c) RN\'s focus alert arrives at the phase end, once');
    await killWithoutStop();
};

let blocked4 = '';
try {
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    for (const [name, apk] of Object.entries(APKS)) console.log(`${name}: ${apk} sha256 ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    console.log(`RN source ${built.rnSource}; recovery source ${built.recoverySource}`);
    const current = front();
    if (!current.includes(`${PKG}/`) && !current.includes(`${home}/`)) throw new Stopped(`another app is in front: ${current.trim()}`);
    if (want('1')) {
        const upgraded = await scenarioUpgrade();
        if (want('4') && built.recoverySource !== V132) await scenarioRecovery(upgraded);
        else if (want('4')) {
            // v1.3.2 applies its stale AsyncStorage startup snapshot, and the capture drain then
            // drops the canonical SQLite load. Report it; the RN fix repoints RECOVERY_COMMIT.
            try {
                await scenarioRecovery(upgraded);
                console.log('(4) passed although the recovery source is still v1.3.2');
            } catch (error) {
                if (error instanceof Stopped) throw error;
                blocked4 = `(4) BLOCKED by the RN startup snapshot bug (task mobile-drain-after-canonical): ${error.message}`;
                console.log(blocked4);
            }
        }
    }
    if (want('2')) {
        const imported = await scenarioJsonAhead();
        if (want('4b')) await scenarioRecoveryAfterImport(imported);
    }
    if (want('2b')) await scenarioCorruptBackup();
    if (want('3')) await scenarioUnreadable('3', false);
    if (want('3b')) await scenarioUnreadable('3b', true);
    if (want('5')) await scenarioMissing();
    if (want('5b')) await scenarioMissingWithBackup();
    if (want('6')) await scenarioSync();
    if (want('7')) await scenarioAlarms();
    if (want('8')) await scenarioPendingCheckoff();
    if (want('9')) await scenarioPomodoro();
    if (want('9b')) await scenarioPomodoroDue();
    if (want('9c')) await scenarioPomodoroRnFix();
    if (want('10')) await scenarioRecoverySnapshots();
    if (want('11')) await scenarioFileSync();
    console.log(`\nUpgrade device check passed${blocked4 ? '; scenario 4 BLOCKED (see above)' : ''}`);
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    try { sh(`rm -f ${TMP}-*`); } catch { /* device gone */ }
    if (!args.includes('--keep')) {
        try { if (installed()) sh(`pm uninstall ${PKG}`); } catch { /* device gone */ }
    }
}
