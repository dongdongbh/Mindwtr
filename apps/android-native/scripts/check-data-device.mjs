// Settings › Data check (pass D1a) on the test phone, in the throwaway upgrade-harness package only.
//
//   MINDWTR_HARNESS_DIR=<dir> node apps/android-native/scripts/check-data-device.mjs <adb-serial>
//
// A restore replaces a whole library, so this check never runs in the development app: it reinstalls the harness's native
// build (tech.dongdongbh.mindwtr.upgradetest, as check-upgrade-device.mjs does before each scenario) and works only on rows it
// merges in itself (titles `d1…<run>`, tag d1test). The test backups are pushed to the phone's Download/mtd1/, the
// exports land there, and the folder is removed on exit. Steps (design D1 §7):
//   E3 Merge backup (the system document picker), Undo from its toast, then Restore backup from the E1 file;
//   E1 Export backup, CSV and TaskNotes through RN's folder picker (Use this folder, Allow); each file is pulled and read, the
//      CSV and TaskNotes files compared byte for byte with core's serializers, and the folder is a persisted grant;
//   E2 a cancelled folder picker falls back to the share sheet (Back, nothing is picked or sent);
//   Sync › Recovery snapshots: RN's rows, and Restore with RN's question;
//   E4 process death at each step of a merge (debug properties backup_stop, journal_stop, and commit_stop between the SQL
//      commit and core's reload, E4c): it lands at most once, the
//      journal and the operation folder end empty, a commit replayed at start meets its document even with a task that became
//      due meanwhile (E4a), and a result a death left unshown shows once;
//   E2b a death in the middle of a folder write: the half file is gone at the next start;
//   E5 while a merge waits (delay_before_ms), one row is busy and every other row is off (Getting Started's too).
// Pass D1b (design D1b §9), after E2b:
//   G1 Getting Started on a library without it: RN's toast with Open, 7 tasks and 2 Inbox samples, then a second tap adds nothing;
//   I1 each importer (Todoist ZIP, TickTick ZIP, DGT JSON, OmniFocus CSV, Mindwtr CSV) through its picker: the rows equal core's
//      own import of the fixture over the pulled library, then Undo leaves none;
//   I2 a TickTick file on the DGT row: core's invalid-file warning, no staged copy; I3 a 16 MiB + 1 byte file: core's limit text;
//   I4 process death before the journal (no row, no result) and after COMMIT (the rows once, the receipt, one replay line);
//   I5 the 60 000-row Mindwtr CSV whose Undo could not be admitted: refused, nothing lands;
//   I6 sentinels in a dropped rule, a renamed project and a skipped archive entry reach no result record, journal, receipt
//      or log;
//   G3 and G2 (each on a fresh install): a seed stopped before its send replays once; one stopped after its COMMIT is there
//      once with its receipt under the journal's request UUID.
// Pass D1c: D0 the data channel through the real bridge (a read chunk that starts with the error marker, a write chunk ending
//   inside a surrogate pair); L1 a multi-byte restore over another, byte for byte, with the v1.3.7/native-large-transfer line;
//   R1 a replay whose plan cannot be read keeps its entry, and the next start answers from the receipt with Undo; DL1-DL4 the
//   size-scaled deadlines, each delay between the old budget and the new one (a slow recovery boot, a large restore over a
//   small library, a replay before SQL then activation, a slow export).
// With D1_MEASURE=1 it runs pass D1c's step 0 instead (design §8): every Data workload in every shape at growing sizes, each
// sampled from before it starts, with the library measured before and after; then the limit data-transfer-limit.mjs proposes,
// and every workload again at that limit, which must pass. With D1C_PART=deadlines it runs only the DL rows
// (D1C_PART=deadlines-1 or deadlines-2: check-data-deadlines-device.mjs, check-data-deadlines2-device.mjs).
// With D1C_PART=large-import (check-data-large-import-device.mjs) it runs only the LI rows: the largest TickTick and Mindwtr CSV
// imports and their Undo.
// It clears every debug property it sets, puts rotation back, and leaves the phone on its home screen.
// Exit 0 = pass, 1 = fail, 2 = refused, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, button, check, connect, evidenced, fail, hasText, inboxCount, mainList, Stopped, tab, tagged, withDescription } from './device.mjs';
/** The tagged node, only once it sits wholly inside the main list (a row half under the gesture bar takes no tap). */
const shown = (nodes, tag) => {
    const node = tagged(nodes, tag);
    const list = mainList(nodes);
    if (!node || !list) return node;
    const [, top, , bottom] = box(node);
    const [, listTop, , listBottom] = box(list);
    return top >= listTop && bottom <= listBottom ? node : undefined;
};
import { cleanupOnExit } from './check-net-device.mjs';
import { boundaryVerdict, MEASURE_SHAPES, proposeTransferLimit, rowBound } from './data-transfer-limit.mjs';
import { importTexts } from './data-measure-fixtures.mjs';

const [serial] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-data-device.mjs <adb-serial>');
    process.exit(2);
}
const app = resolve(import.meta.dirname, '..');
const repo = resolve(app, '../..');
const PKG = 'tech.dongdongbh.mindwtr.upgradetest';
const harness = process.env.MINDWTR_HARNESS_DIR ?? '/home/dd/.mindwtr-harness';
const aapt2 = process.env.AAPT2 ?? '/home/dd/Android/Sdk/build-tools/36.1.0/aapt2';
let apk;
try {
    apk = JSON.parse(readFileSync(resolve(harness, 'apks/manifest.json'), 'utf8')).native153.path;
} catch {
    console.error(`REFUSED: no ${harness}/apks/manifest.json; run build-upgrade-harness.mjs first`);
    process.exit(2);
}
if (execFileSync(aapt2, ['dump', 'packagename', apk], { encoding: 'utf8' }).trim() !== PKG) {
    console.error(`REFUSED: ${apk} is not the throwaway ${PKG}`);
    process.exit(2);
}
const ACTIVITY = `${PKG}/${PKG}.MainActivity`;
/**
 * The native test builds other device checks and measurements leave in front: every id under this prefix (build.gradle.kts:
 * the dev build `.nativeclient.dev` and its benchmark builds `.nativeclient.dev.benchmark`). Never dd's own apps.
 */
const NATIVE_TEST_PREFIX = 'tech.dongdongbh.mindwtr.nativeclient';
const TAG = 'MindwtrNativeDev';
const UI_FILE = '/data/local/tmp/mindwtr-d1-ui.xml';
// A short folder name: an Android property value holds at most 91 characters, and the picker's starting URI names it.
const PHONE_DIR = '/sdcard/Download/mtd1';
// The folder picker's starting place (EXTRA_INITIAL_URI takes a document URI, not a tree URI).
const TREE = 'content://com.android.externalstorage.documents/document/primary%3ADownload%2Fmtd1';
const DB = 'files/SQLite/mindwtr.db';
const PROPS = ['backup_stop', 'journal_stop', 'commit_stop', 'delay_before_ms', 'export_tree', 'language', 'transfer_limit_mb', 'channel_roundtrip',
    'channel_fail', 'sql_read_delay_ms', 'sql_read_delay_skip', 'channel_write_delay_ms', 'budget_ms_per_mib', 'd1c_control', 'clipboard'];
const work = resolve(app, 'android/build/data-check');
const { en: localeEn } = await import(resolve(repo, 'packages/core/src/i18n/locales/en.ts'));
// The starter.* strings live in their own generated module (getting-started-seed.ts reads them), not in en.ts.
const { STARTER_SEED_STRINGS } = await import(resolve(repo, 'packages/core/src/i18n/starter-seed-strings.ts'));
const en = { ...localeEn, ...STARTER_SEED_STRINGS.en };
for (const key of ['starter.projectTitle', 'starter.sampleBuyMilk', 'starter.sampleReplySam']) if (!en[key]) throw new Error(`no English string for ${key}`);
const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;

// ---- The test backups (RN's backup format: serializeBackupData's pretty JSON of the library) ----
mkdirSync(work, { recursive: true });
const at = () => new Date().toISOString();
const task = (title, extra = {}) => ({ id: randomUUID(), title, status: 'next', tags: ['d1test'], contexts: [], createdAt: at(), updatedAt: at(), rev: 1, ...extra });
const backup = (tasks) => JSON.stringify({ tasks, projects: [], sections: [], areas: [], people: [], settings: {} }, null, 2);
const fixture = (name, tasks) => {
    writeFileSync(resolve(work, name), backup(tasks));
    return { name, tasks };
};

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE });
const { adbRaw, sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting } = device;
const runAs = (command) => sh(`run-as ${PKG} ${command}`);
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
// The phone's log ring drops old lines on a long run, so a count read twice could shrink and a `===` against an earlier
// count fail with nothing new logged. Every line read stays here (a line carries its millisecond stamp and thread, so a
// repeat is the same line); clearLogs empties the phone's log and this together.
const seenLogs = new Set();
const allLogs = () => {
    for (const line of adbRaw('logcat', '-d', '-s', `${TAG}:*`).toString('utf8').replace(/\\/g, '').split('\n')) if (line.trim()) seenLogs.add(line);
    return [...seenLogs].join('\n');
};
const clearLogs = () => {
    adbRaw('logcat', '-c');
    seenLogs.clear();
};
const until = async (description, holds, timeoutMs = 60_000, everyMs = 1_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try { if (await holds()) return; } catch { /* not ready yet */ }
        if (Date.now() > deadline) fail(`timed out waiting for ${description}`);
        await sleep(everyMs);
    }
};

// ---- The phone's storage ----
const pullDb = (label) => {
    const dir = resolve(work, `db-${label}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = runAs('ls files/SQLite').split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) if (present.includes(`mindwtr.db${suffix}`)) device.pull(`${DB}${suffix}`, resolve(dir, `mindwtr.db${suffix}`));
    return resolve(dir, 'mindwtr.db');
};
const sqlite = (file, sql) => {
    // A large library's rows pass spawnSync's 1 MiB default (batch2: ENOBUFS).
    const out = execFileSync('sqlite3', ['-json', file, sql], { encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
    return out ? JSON.parse(out) : [];
};
/** This run's live task titles (the d1… rows), sorted. */
const liveTitles = (label) => sqlite(pullDb(label), `SELECT title FROM tasks WHERE deletedAt IS NULL AND title LIKE 'd1%${run}'`).map((row) => row.title).sort();
const listing = (path) => runAs(`sh -c 'ls ${path} 2>/dev/null || true'`).split(/\s+/).filter(Boolean);
const snapshots = () => listing('files/snapshots').filter((name) => name.endsWith('.snapshot.json'));
const journal = () => listing('files/journal').filter((name) => name.endsWith('.json'));
const operations = () => listing('no_backup/backup-operations').filter((name) => name !== 'result.json');
const exportsOnPhone = () => sh(`ls ${PHONE_DIR} 2>/dev/null || true`).split(/\s+/).filter((name) => name.startsWith('mindwtr-backup'));

// ---- The app ----
const onInbox = (nodes) => !tagged(nodes, 'menu-screen') && Number.isFinite(inboxCount(nodes));
const onData = (nodes) => Boolean(tagged(nodes, 'settings-data'));
const onSync = (nodes) => Boolean(tagged(nodes, 'settings-sync'));
const sheetOpen = (nodes) => Boolean(tagged(nodes, 'more-sheet'));
const otherAppFront = () => !front().includes(`${PKG}/`);
const toTabs = async () => {
    let nodes = await screen();
    for (let step = 0; step < 8 && !(tab(nodes, en['tab.menu']) && !tagged(nodes, 'menu-screen') && !sheetOpen(nodes)); step += 1) {
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(900);
        nodes = await screen();
    }
    return nodes;
};
const openSettings = async () => {
    let nodes = await toTabs();
    nodes = await tapExpecting(tab(nodes, en['tab.menu']) ?? fail('no Menu tab'), sheetOpen, 'the More sheet');
    nodes = await device.settle(nodes);
    return tapExpecting(withDescription(nodes, en['nav.settings']) ?? fail('no Settings in the More sheet'), (current) => Boolean(tagged(current, 'settings-main')), 'Settings');
};
const withPrefix = (nodes, prefix) => nodes.find((node) => (node['content-desc'] ?? '').startsWith(prefix));
const openRow = async (label, arrived, what) => {
    let nodes = await openSettings();
    for (let step = 0; step < 6 && !withPrefix(nodes, `${label}. `); step += 1) nodes = await device.swipe(nodes, 'down');
    return tapExpecting(withPrefix(nodes, `${label}. `) ?? fail(`no ${what} row in Settings`), arrived, `Settings › ${what}`);
};
const openData = async () => {
    const nodes = await openRow(en['settings.data'], onData, 'Data');
    if (tagged(nodes, 'data-transfer-export')) return nodes;
    return tapExpecting(tagged(nodes, 'backup-disclosure') ?? fail('no Backup fold'), (current) => Boolean(tagged(current, 'data-transfer-merge')), 'the Backup fold open');
};
const launch = async () => {
    device.launch(ACTIVITY);
    await waitFor('the Inbox', onInbox, 90_000);
};
const relaunch = async () => {
    await device.stopApp();
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    await launch();
};
// ---- The system pickers (another app in front) ----
const anyScreen = async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            const xml = adbRaw('exec-out', 'uiautomator', 'dump', '/dev/tty').toString('utf8');
            if (xml.includes('<hierarchy')) {
                return [...xml.matchAll(/<node [^>]*>/g)].map(([node]) => Object.fromEntries([...node.matchAll(/([\w-]+)="([^"]*)"/g)]
                    .map(([, name, value]) => [name, value.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/&quot;/g, '"').replace(/&amp;/g, '&')])));
            }
        } catch { /* briefly unavailable */ }
        await sleep(500);
    }
    return fail('uiautomator dump failed in the picker');
};
const tapAny = async (node) => {
    const [x1, y1, x2, y2] = box(node);
    sh(`input tap ${Math.round((x1 + x2) / 2)} ${Math.round((y1 + y2) / 2)}`);
    await sleep(900);
};
/** RN's document picker (ACTION_OPEN_DOCUMENT): the file named [name], found in its list or through its search. */
const pickDocument = async (name) => {
    await until('the document picker', otherAppFront, 15_000, 500);
    await sleep(1500);
    for (let attempt = 0; attempt < 3; attempt += 1) {
        let nodes = await anyScreen();
        const hit = nodes.find((node) => node.text === name);
        if (hit) return tapAny(hit);
        const search = nodes.find((node) => /search/i.test(`${node['content-desc']} ${node['resource-id']}`) && node.clickable === 'true');
        if (search) {
            await tapAny(search);
            sh(`input text '${name}'`);
            sh('input keyevent KEYCODE_ENTER');
            await sleep(2500);
            nodes = await anyScreen();
            const found = nodes.filter((node) => node.text === name).at(-1);
            if (found) return tapAny(found);
        }
        await sleep(1500);
    }
    return fail(`the document picker did not show ${name}`);
};
/** RN's folder picker (ACTION_OPEN_DOCUMENT_TREE, opened in the test folder Download/mtd1): Use this folder, then Allow when it asks. */
const useTestFolder = async () => {
    await until('the folder picker', otherAppFront, 15_000, 500);
    await sleep(1500);
    let nodes = await anyScreen();
    // Opened somewhere else (the provider ignored the starting place): walk to Download › mtd1.
    for (const folder of ['Download', 'mtd1']) {
        if (nodes.some((node) => node['resource-id']?.endsWith('breadcrumb_text') && node.text === folder)) continue;
        if (folder === 'Download' && nodes.some((node) => node.text === 'mtd1' && node['resource-id']?.endsWith('breadcrumb_text'))) continue;
        const entry = nodes.find((node) => node.text === folder && node['resource-id']?.endsWith('android:id/title'));
        if (!entry) continue;
        await tapAny(entry);
        await sleep(1500);
        nodes = await anyScreen();
    }
    const use = nodes.find((node) => /use this folder/i.test(node.text ?? '') && node.enabled !== 'false');
    if (!use) fail(`the folder picker shows no "Use this folder" (${nodes.map((node) => node.text).filter(Boolean).slice(0, 12).join(' | ')})`);
    await tapAny(use);
    await sleep(1200);
    if (otherAppFront()) {
        nodes = await anyScreen();
        const allow = nodes.find((node) => /^allow$/i.test(node.text ?? ''));
        if (allow) await tapAny(allow);
    }
    await until('the app back in front', () => !otherAppFront(), 15_000, 500);
};

// ---- Data actions ----
/** The open question's action button (a dialog window has no test tags): core's Merge, Restore or Import word, its text or TalkBack name. */
const confirmButton = (nodes) => nodes.find((node) => [en['settings.mergeBackupAction'], en['markdown.referenceRestore'], en['settings.backupMobile.import']]
    .some((label) => [node.text, node['content-desc']].some((text) => (text ?? '').toUpperCase() === label.toUpperCase())));
const confirmQuestion = async (title) => {
    const nodes = await waitFor(`the question "${title}"`, (current) => hasText(current, title) && Boolean(confirmButton(current)), 60_000);
    await tap(confirmButton(nodes));
};
const merge = async (file) => {
    await openData();
    await tap(tagged(await screen(), 'data-transfer-merge'));
    await pickDocument(file.name);
    await until('the app back in front', () => !otherAppFront(), 15_000, 500);
};
// The question closed first: a question can carry the same title as its result (Merge Backup).
const toastWith = (title, timeoutMs = 120_000) => waitFor(`the toast "${title}"`, (nodes) => hasText(nodes, title) && !confirmButton(nodes), timeoutMs);
const undoButton = (nodes) => nodes.find((node) => node.text === en['settings.undoImport']);
const push = (file) => adbRaw('push', resolve(work, file.name), `${PHONE_DIR}/${file.name}`);
const exportFile = async (tag, suffix) => {
    const before = exportsOnPhone();
    await openData();
    await tap(tagged(await screen(), tag) ?? fail(`no ${tag} row`));
    await useTestFolder();
    await until(`the ${suffix} file in ${PHONE_DIR}`, () => exportsOnPhone().some((name) => !before.includes(name) && name.endsWith(suffix)), 60_000);
    const name = exportsOnPhone().find((name) => !before.includes(name) && name.endsWith(suffix));
    const local = resolve(work, name);
    writeFileSync(local, adbRaw('exec-out', 'cat', `${PHONE_DIR}/${name}`));
    return { name, local };
};
/** Whether the app holds a persisted URI grant naming [fragment] (`dumpsys activity permissions`, the app's UID block). */
const persistedGrant = (fragment) => {
    const uid = /uid:(\d+)/.exec(sh(`pm list packages -U ${PKG}`))?.[1] ?? fail(`no UID for ${PKG}`);
    const lines = sh('dumpsys activity permissions').split('\n');
    const start = lines.findIndex((line) => new RegExp(`UID ${uid}\\b`).test(line));
    if (start < 0) return false;
    const end = lines.findIndex((line, index) => index > start && /^\s*\* UID /.test(line));
    return lines.slice(start, end < 0 ? undefined : end).some((line) => line.includes(fragment));
};
const replayLines = () => allLogs().split('\n').filter((line) => line.includes('v1.3.5/android-backup-replay'));


// ---- Pass D1c's rows ----
const MIB = 1024 * 1024;
const limitMiB = 12; // DataTransferLimits.LIMIT_BYTES until step 0 sets the new limit
const fresh = async () => {
    if (sh(`pm list packages ${PKG}`).split('\n').some((line) => line.trim() === `package:${PKG}`)) sh(`pm uninstall ${PKG}`);
    adbRaw('install', '-g', apk);
    clearLogs();
    await launch();
};
const restore = async (file) => {
    await openData();
    await tap(tagged(await screen(), 'data-transfer-restore'));
    await pickDocument(file.name);
    await until('the app back in front', () => !otherAppFront(), 15_000, 500);
    await tap(confirmButton(await waitFor('the question', (current) => Boolean(confirmButton(current)), 300_000)));
};
const rowsLike = (label, prefix) => sqlite(pullDb(label), `SELECT count(*) AS n FROM tasks WHERE deletedAt IS NULL AND title LIKE '${prefix}%'`)[0].n;
const transfer = () => allLogs().split('\n').filter((line) => line.includes('v1.3.7/native-large-transfer')).at(-1) ?? '';
/** The library's file bytes as the app sizes its budgets by (the database and its write-ahead log), in started MiB. */
const libraryFileMiB = () => {
    const size = (name) => Number(runAs(`sh -c 'stat -c %s ${name} 2>/dev/null || echo 0'`).trim()) || 0;
    return Math.ceil((size(DB) + size(`${DB}-wal`)) / MIB);
};

/**
 * DL1-DL5 (design §3.4, reviews 3 #17 and the code review): each row first runs under a debug control that gives the code the
 * deadline or timeout it had before pass D1c, and must fail; then the same row with the fix, which must finish, taking longer
 * than the old budget. Each delay waits on timers in host-entry (a full library read, after `sql_read_delay_skip` reads, waits
 * `sql_read_delay_ms`; an export or snapshot write pauses `channel_write_delay_ms` after its first piece), so the deadlines and
 * core's storage timeout run while it waits. A 30 s per MiB rate (debug budget_ms_per_mib) and a 64 MiB transfer limit keep
 * the windows wide; the budget's base is 120 s.
 */
const deadlineRows = async (part) => {
    const BASE = 120_000;
    const RATE = 30_000;
    const budget = (mib) => BASE + mib * RATE;
    const delays = (ms, skip = 0) => { setProp('sql_read_delay_ms', String(ms)); setProp('sql_read_delay_skip', String(skip)); };
    const noDelays = () => { setProp('sql_read_delay_ms', ''); setProp('sql_read_delay_skip', ''); setProp('channel_write_delay_ms', ''); };
    const control = (name) => setProp('d1c_control', name);
    const small = fixture(`d1-dl-small-${run}.json`, Array.from({ length: 200 }, (_, index) => task(`d1dls${index}x${run}`)));
    const large = measureFixture(`d1-dl-large-${run}.json`, 8, 'rows', 'd1dll');
    push(small); push(large);
    const setup = async () => {
        await fresh();
        setProp('budget_ms_per_mib', String(RATE));
        setProp('transfer_limit_mb', '64');
        await merge(small);
        await confirmQuestion(en['settings.mergeBackup']);
        await toastWith(en['settings.mergeBackup']);
    };
    /** The start after a stop: whether the Inbox showed within [timeoutMs], and how long it took. */
    const start = async (timeoutMs) => {
        const started = Date.now();
        device.launch(ACTIVITY);
        try { await waitFor('the Inbox', onInbox, timeoutMs); return { inbox: true, ms: Date.now() - started }; }
        catch { return { inbox: false, ms: Date.now() - started }; }
    };
    const restoreTimed = async (file) => {
        await openData();
        await tap(tagged(await screen(), 'data-transfer-restore'));
        await pickDocument(file.name);
        await until('the app back in front', () => !otherAppFront(), 15_000, 500);
        const question = await waitFor('the question', (current) => Boolean(confirmButton(current)), 300_000);
        return question;
    };
    const outcomeToast = (nodes) => hasText(nodes, en['settings.backupMobile.restoreComplete']) || hasText(nodes, en['settings.backupMobile.restoreFailed']);

    // Two parts (check-data-deadlines-device: DL1-DL2; check-data-deadlines2-device: DL3-DL5), each within the batch's hour.
    if (part === 1) {
        // DL1: a merge stopped right after its COMMIT over the large library; the next start's three reads (the recovery load, the
        // commit's reload, activation's load) each take 60 s: past the old 30 s boot deadline and 15 s storage timeout, within the
        // library's budget.
        // A merge's plan holds the library twice, so at 30 s per MiB its frozen budget over the large library would pass the 15-min
        // ceiling and the merge would be refused before its commit (batch1). 10 s per MiB keeps it admitted, and the library's own
        // budget still holds three 60 s reads.
        const DL1_RATE = 10_000;
        const dl1 = async (name) => {
            await setup();
            setProp('budget_ms_per_mib', String(DL1_RATE));
            await restore(large);
            await toastWith(en['settings.backupMobile.restoreComplete'], 600_000);
            setProp('commit_stop', 'backupDocumentCommit');
            await merge(small);
            await tap(confirmButton(await waitFor('the question', (current) => Boolean(confirmButton(current)), 120_000)));
            // The process ends at its COMMIT; a failure toast instead means the merge never reached it.
            let refusal = '';
            await until(`the process to end at its COMMIT (DL1 ${name})`, async () => {
                if (!pid()) return true;
                const failed = (await screen().catch(() => [])).find((node) => node.text === en['settings.mergeBackupFailed']);
                if (failed) refusal = failed.text;
                return Boolean(refusal);
            }, 300_000, 500);
            setProp('commit_stop', '');
            check(!refusal, `(DL1 ${name}) the merge reached its COMMIT (no "${refusal}" toast)`);
            check(BASE + libraryFileMiB() * DL1_RATE > 60_000 * 3, '(DL1) the library\'s budget holds the three slow reads');
            delays(60_000);
        };
        await dl1('control');
        control('pre-d1c');
        const dl1control = await start(240_000);
        await device.stopApp();
        control('');
        check(!dl1control.inbox, `(DL1 control) with the old deadlines the slow recovery boot never reaches the Inbox (${dl1control.ms} ms)`);
        const dl1real = await start(900_000);
        noDelays();
        check(dl1real.inbox && dl1real.ms > 120_000, `(DL1) the slow recovery boot replays from the receipt and activates, taking ${dl1real.ms} ms, past the old budgets`);
        await until('(DL1) the journal to empty', () => journal().length === 0, 120_000);

        // DL2: a large restore over a small library; only its reload is slow, longer than the small library's storage budget and
        // within the budget the commit froze. The control keeps the small library's storage timeout through the reload.
        for (const name of ['control', 'real']) {
            await setup();
            await device.stopApp();
            await launch();
            const small0 = budget(libraryFileMiB());
            const question = await restoreTimed(large);
            delays(small0 + 60_000, 2);
            if (name === 'control') control('no-commit-storage');
            const started = Date.now();
            await tap(confirmButton(question));
            const nodes = await waitFor('the restore\'s outcome', outcomeToast, 900_000);
            const ms = Date.now() - started;
            noDelays(); control('');
            if (name === 'control') check(hasText(nodes, en['settings.backupMobile.restoreFailed']), `(DL2 control) with the small library's storage timeout the reload fails (${ms} ms)`);
            else check(hasText(nodes, en['settings.backupMobile.restoreComplete']) && ms > small0 && rowsLike('dl2', 'd1dll') === large.tasks.length,
                `(DL2) the large restore lands though its reload took ${ms} ms, past the small library's ${small0} ms`);
        }

    }
    if (part === 2) {
        // DL3 (review 4 #18): a large restore stopped with its entry journaled, nothing sent; before the restart the small library is
        // there and no receipt names the restore. At the start only activation's read is slow (after the recovery load, the
        // commit's stale check and its reload), longer than the small library's budget, within the large one's.
        for (const name of ['control', 'real']) {
            await setup();
            setProp('journal_stop', 'before:backupDocumentCommit');
            const question = await restoreTimed(large);
            await tap(confirmButton(question));
            await until(`the process to end (DL3 ${name})`, () => !pid(), 300_000, 500);
            setProp('journal_stop', '');
            const before = pullDb(`dl3-${name}-before`);
            check(sqlite(before, "SELECT count(*) AS n FROM tasks WHERE deletedAt IS NULL AND title LIKE 'd1dls%'")[0].n === 200
                && sqlite(before, `SELECT count(*) AS n FROM native_request_receipts WHERE method LIKE '["backupDocument","replace",%'`)[0].n === 0
                && journal().length === 1, `(DL3 ${name}) before the restart: the small library, no receipt for the restore, its entry journaled`);
            const small0 = budget(libraryFileMiB());
            delays(small0 + 60_000, 3);
            if (name === 'control') control('no-activation-storage');
            // The control's activation fails at the small library's storage timeout (small0, 180 s at 2 MiB of files), after
            // the boot and the replay (undelayed, under 5 min). Its wait must also outlast a fixed run, whose activation read
            // takes the delay (small0 + 60 s): so the delay plus 5 min for the boot and replay, and never under 600 s.
            const controlWait = Math.max(600_000, small0 + 60_000 + 300_000);
            const result = await start(name === 'control' ? controlWait : 900_000);
            await device.stopApp();
            noDelays(); control('');
            if (name === 'control') check(!result.inbox, `(DL3 control) with the small library's timeout after the replay, activation never finishes (${result.ms} ms)`);
            else {
                check(result.inbox && result.ms > small0, `(DL3) the replay restored the large library and activation finished in ${result.ms} ms, past the small library's ${small0} ms`);
                await launch();
                check(rowsLike('dl3-after', 'd1dll') === large.tasks.length && journal().length === 0, '(DL3) the large library is in, the journal empty');
            }
        }

        // DL4: an export paused 60 s while it is written: past the old 30 s deadline, within the library's budget.
        setProp('export_tree', TREE);
        for (const name of ['control', 'real']) {
            if (name === 'control') control('fixed-deadlines');
            setProp('channel_write_delay_ms', '60000');
            const before = exportsOnPhone();
            const started = Date.now();
            await openData();
            await tap(tagged(await screen(), 'data-transfer-export') ?? fail('no export row'));
            // The file is written before the folder picker opens (batch3: the picker waited behind the slow write), so wait for
            // either the picker or the export's failure toast, then answer the picker.
            let failedToast = false;
            await until(`the folder picker or the export's failure (DL4 ${name})`, async () => {
                if (otherAppFront()) return true;
                failedToast = hasText(await screen().catch(() => []), en['settings.backupMobile.failedToExportBackup']);
                return failedToast;
            }, 300_000, 1000);
            const pickedMs = Date.now() - started;
            let made = false;
            if (!failedToast) {
                await useTestFolder();
                try { await until(`the export (DL4 ${name})`, () => exportsOnPhone().some((file) => !before.includes(file) && file.endsWith('.json')), 120_000, 1000); made = true; } catch { /* no file */ }
            }
            const ms = Math.max(pickedMs, Date.now() - started);
            noDelays(); control('');
            if (name === 'control') check(failedToast && !made, `(DL4 control) with the old 30 s deadline the slow export fails and makes no file (${ms} ms)`);
            else check(made && pickedMs > 60_000, `(DL4) the slow export was written in ${pickedMs} ms, past the old 30 s, and the file made`);
            // The control's export outlived its old deadline while it waited, so the host stopped for good ("Core host stopped",
            // batch4): only a new process serves the next run.
            await device.stopApp();
            await launch();
        }
        setProp('export_tree', '');

        // DL5: the capture popup's recovery snapshot paused 60 s while it is written: past the old 30 s, within the library's budget.
        for (const name of ['control', 'real']) {
            if (name === 'control') control('fixed-deadlines');
            const titles = [`d1dl5a${name}${run}`, `d1dl5b${name}${run}`];
            const snapshotsBefore = snapshots();
            setProp('clipboard', titles.join('\\n'));
            let nodes = await device.openCapture();
            await sleep(500);
            setProp('clipboard', '');
            await device.focusAtEnd(tagged(nodes, 'capture-title') ?? fail('no capture field'));
            sh('input keyevent KEYCODE_PASTE');
            await waitFor('two lines in the field', (current) => (tagged(current, 'capture-title')?.text ?? '') === titles.join('\n'), 10_000);
            setProp('channel_write_delay_ms', '60000');
            const confirmTitle = en['quickAdd.bulkConfirmTitle'].replace('{{count}}', '2');
            nodes = await tapExpecting(button(await screen(), en['common.save']) ?? fail('no Save'), (current) => current.some((node) => node.text === confirmTitle), 'the several-lines question');
            const started = Date.now();
            await tap(button(nodes, en['quickAdd.bulkConfirmCreate']) ?? fail('no Create tasks'));
            let stored = false;
            // The control fails at its old 30 s deadline (and the drain after it); the real run's snapshot waits 60 s first.
            try { await until(`the lines (DL5 ${name})`, () => rowsLike(`dl5-${name}`, `d1dl5a${name}`) === 1, name === 'control' ? 150_000 : 300_000, 5000); stored = true; } catch { /* the control stores nothing */ }
            const ms = Date.now() - started;
            noDelays(); control('');
            const written = snapshots().filter((file) => !snapshotsBefore.includes(file));
            if (name === 'control') check(!stored && written.length === 0, `(DL5 control) with the old 30 s deadline the slow snapshot fails: no snapshot, no lines (${ms} ms)`);
            else check(stored && written.length === 1 && ms > 60_000, `(DL5) the slow snapshot was written (${written[0]}) and the lines stored, in ${ms} ms`);
            await device.stopApp();
            if (name === 'control') {
                // The control stopped the host and left its capture request on disk to be sent again: a fresh install and the
                // same large library, so the real run starts from a clean popup.
                await setup();
                await restore(large);
                await toastWith(en['settings.backupMobile.restoreComplete'], 600_000);
                await device.stopApp();
            }
            await launch();
        }
    }
    setProp('budget_ms_per_mib', '');
    setProp('transfer_limit_mb', '');
    sh(`rm -f ${PHONE_DIR}/${small.name} ${PHONE_DIR}/${large.name}`);
};

// ---- The transfer limit measurement (D1_MEASURE=1) ----
/** `dumpsys meminfo`'s Native Heap and Java Heap sizes (kB) and its TOTAL PSS. */
const memory = () => {
    const text = sh(`dumpsys meminfo ${PKG}`);
    const kb = (pattern) => Number(pattern.exec(text)?.[1] ?? NaN);
    return { native: kb(/Native Heap:\s+(\d+)/), java: kb(/Java Heap:\s+(\d+)/), total: kb(/TOTAL PSS:\s+(\d+)/) };
};
/** The app's own line for the last Data operation (v1.3.7/native-large-transfer), parsed; null when none came. */
const lastTransferLine = (after) => {
    const lines = allLogs().split('\n').filter((line) => line.includes('v1.3.7/native-large-transfer'));
    const line = lines.slice(after).at(-1);
    if (!line) return null;
    const field = (name) => Number(new RegExp(`"${name}":(\\d+)`).exec(line)?.[1] ?? NaN);
    return { outcome: /"outcome":"(\w+)"/.exec(line)?.[1] ?? '', sourceMiB: field('sourceMiB'), libraryMiB: field('libraryMiB'),
        seconds: field('seconds'), nativePeakMiB: field('nativePeakMiB'), javaPeakMiB: field('javaPeakMiB') };
};
const transferLines = () => allLogs().split('\n').filter((line) => line.includes('v1.3.7/native-large-transfer')).length;
/** Pass D1c step 0's rule per run (design §8): finished, alive, Java heap at most 128 MiB, native heap at most 512 MiB. */
const MEASURE_JAVA_MIB = 128;
const MEASURE_NATIVE_MIB = 512;
const measured = [];
/**
 * One measured run: `dumpsys meminfo` sampled every second from before [act] starts (D1a sampled only after the question
 * opened) until [done] holds, the app dies, or 900 s pass; then the app's own log line, when the run was a Data operation.
 */
/** The library's SQLite bytes on the phone now (page count × page size, as core admits), in MiB, from a pulled copy. */
const libraryNowMiB = (label) => {
    const [{ bytes }] = sqlite(pullDb(label), 'SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()');
    return Math.round(bytes / MIB * 10) / 10;
};
/**
 * One measured run: `dumpsys meminfo` sampled every second from before [act] starts (D1a sampled only after the question
 * opened) until [done] holds, the app dies, or 900 s pass. The library is measured on the phone before and after (code review
 * P2: an import counts the library it left; an export, a capture or a start the library it read); [source] gives the
 * picked file's bytes and, for an import, its expanded bytes. [boundary] marks a rerun at the proposed limit.
 */
const measureRun = async (shape, workload, sizeMiB, act, done, { sourceBytes = 0, expandedBytes = null, boundary = false } = {}) => {
    const libraryBeforeMiB = pid() ? libraryNowMiB(`m-${workload}-before`) : null;
    const peak = { native: 0, java: 0, total: 0 };
    const linesBefore = transferLines();
    const logsBefore = allLogs().split('\n').length;
    const probesBefore = allLogs().split('\n').filter((line) => line.includes('Native Android memory probe')).length;
    const started = Date.now();
    let sampling = true;
    const sampler = (async () => {
        while (sampling) {
            try { if (pid()) { const now = memory(); for (const key of Object.keys(peak)) if (now[key] > peak[key]) peak[key] = now[key]; } } catch { /* sampling only */ }
            await sleep(1000);
        }
    })();
    let outcome = 'timeout';
    let toast = [];
    try {
        await act();
        for (let second = 0; second < 900; second += 1) {
            if (!pid()) { outcome = 'died'; break; }
            const nodes = await screen().catch(() => []);
            if (done(nodes)) { outcome = 'done'; toast = nodes; break; }
            const failed = nodes.find((node) => /failed|too large|too long/i.test(node.text ?? ''));
            if (failed) { outcome = `failed: ${failed.text}`; toast = nodes; break; }
            await sleep(1000);
        }
    } catch (error) {
        outcome = `error: ${error.message}`;
    } finally {
        sampling = false;
        await sampler;
    }
    const app = lastTransferLine(linesBefore);
    const probes = allLogs().split('\n').filter((line) => line.includes('Native Android memory probe')).slice(probesBefore)
        .map((line) => /at=(\S+) quickjsMiB=(\d+)/.exec(line)).filter(Boolean).map((match) => `${match[1]}=${match[2]}`);
    if (!pid()) await launch();
    const libraryAfterMiB = libraryNowMiB(`m-${workload}-after`);
    const nativeMiB = Math.round(peak.native / 1024);
    const javaMiB = Math.round(peak.java / 1024);
    const pass = outcome === 'done' && javaMiB <= MEASURE_JAVA_MIB && nativeMiB <= MEASURE_NATIVE_MIB
        && (!app || app.javaPeakMiB <= MEASURE_JAVA_MIB && app.nativePeakMiB <= MEASURE_NATIVE_MIB);
    // Refused for its size (core's limit words): at the boundary, the evidence that nothing larger is admitted.
    const tooLarge = en['settings.backupDiagnostics.tooLarge'].split('{{')[0];
    const refused = outcome.startsWith('failed') && toast.some((node) => (node.text ?? '').startsWith(tooLarge) || node.text === en['settings.importDiagnostics.limitExceeded']);
    const row = { shape, workload, sizeMiB, boundary, refused, sourceMiB: Math.round(sourceBytes / MIB * 10) / 10,
        expandedMiB: expandedBytes === null ? null : Math.round(expandedBytes / MIB * 10) / 10, libraryBeforeMiB, libraryAfterMiB, outcome,
        seconds: Math.round((Date.now() - started) / 1000), nativeMiB, javaMiB, pssMiB: Math.round(peak.total / 1024),
        appNativeMiB: app?.nativePeakMiB ?? null, appJavaMiB: app?.javaPeakMiB ?? null, probes, pass };
    if (!pass) {
        // The toast's words and the app's own lines for this row (step 0 run 4: a passing run kept no log, so a failed row had no cause).
        row.toastText = toast.map((node) => node.text).filter(Boolean).join(' | ');
        row.log = resolve(work, `row-${shape}-${workload}-${sizeMiB}${boundary ? '-b' : ''}-${run}.log`);
        try { writeFileSync(row.log, allLogs().split('\n').slice(logsBefore).join('\n')); } catch { /* evidence only */ }
    }
    measured.push(row);
    console.log(`measure ${JSON.stringify(row)}`);
    return { row, toast };
};
/** A backup of about [mib] MiB in [shape]: `notes` (D1a's: 64 KiB notes, few rows) or `rows` (about 1 KiB per task, RN's fields). */
const measureFixture = (name, mib, shape, prefix) => {
    const target = mib * 1024 * 1024;
    const note = 'x'.repeat(64 * 1024);
    const words = 'plan review call write send check draft order book'.split(' ');
    const make = (index) => shape === 'notes'
        ? task(`${prefix}${index}${run}`, { description: note })
        // Multi-byte text everywhere, so the channel's 1 MiB reads and 512 Ki-unit writes fall inside characters.
        : shape === 'emoji' ? task(`${prefix}${index}${run} 🦉`, { description: 'aé🦉日本語 '.repeat(40) })
        : task(`${prefix}${index}${run} ${words[index % words.length]} the weekly report`, {
            description: `${words[(index + 3) % words.length]} `.repeat(70).slice(0, 400), tags: ['d1test', 'work', `t${index % 7}`],
            contexts: ['@desk', `@c${index % 5}`], dueDate: '2026-12-01', checklist: [0, 1, 2].map((item) => ({ id: randomUUID(), title: `step ${item}`, isCompleted: item === 0 })),
        });
    // Rows are added until the pretty JSON reaches the target; the size of one row sets the count.
    const per = Buffer.byteLength(JSON.stringify(make(0), null, 2)) + 8;
    const tasks = Array.from({ length: Math.max(1, Math.round(target / per)) }, (_, index) => make(index));
    return fixture(name, tasks);
};
const measureFreshInstall = async (limitMiB = 1024) => {
    if (sh(`pm list packages ${PKG}`).split('\n').some((line) => line.trim() === `package:${PKG}`)) sh(`pm uninstall ${PKG}`);
    adbRaw('install', '-g', apk);
    clearLogs();
    setProp('transfer_limit_mb', String(limitMiB));
    await launch();
};
const restoreFile = async (file) => {
    await openData();
    await tap(tagged(await screen(), 'data-transfer-restore'));
    await pickDocument(file.name);
    await until('the app back in front', () => !otherAppFront(), 15_000, 500);
    await tap(confirmButton(await waitFor('the question', (current) => Boolean(confirmButton(current)), 900_000)));
};
const IMPORT_TITLES = { todoist: 'importTodoistData', ticktick: 'importTicktickData', dgt: 'importDgtGtdData', omnifocus: 'importOmnifocusData', 'mindwtr-csv': 'importMindwtrCsvData' };
const importFile = async (key, file) => {
    let nodes = await openData();
    for (let step = 0; step < 8 && !shown(nodes, 'import-disclosure'); step += 1) nodes = await device.swipe(nodes, 'down');
    if (!tagged(nodes, 'import-guide-link')) nodes = await tapExpecting(tagged(nodes, 'import-disclosure') ?? fail('no Import fold'), (current) => Boolean(tagged(current, 'import-guide-link')), 'the Import fold open');
    for (let step = 0; step < 6 && !shown(nodes, `data-transfer-import-${key}`); step += 1) nodes = await device.swipe(nodes, 'down');
    await tap(tagged(nodes, `data-transfer-import-${key}`) ?? fail(`no ${key} import row`));
    await pickDocument(file.name);
    await until('the app back in front', () => !otherAppFront(), 15_000, 500);
    // RN's invalid-file warning and its failure toast are both titled Import failed and last 4.2 s (step 0 run 4: the wait
    // for the question outlasted one unseen); measureRun's loop reads that toast at once.
    const asked = await waitFor('the question or the import\'s failure', (current) => Boolean(confirmButton(current)) || hasText(current, en['settings.backupMobile.importFailed']), 900_000);
    if (confirmButton(asked)) await tap(confirmButton(asked));
};
/** Each importer's largest file core admits (data-measure-fixtures.mjs, sized by encoded bytes); the expanded bytes are what core parses. */
const importFixtures = () => Object.entries(importTexts(run)).map(([key, entries]) => {
    const expandedBytes = entries.reduce((sum, [, text]) => sum + Buffer.byteLength(text), 0);
    const zipped = key === 'todoist' || key === 'ticktick' || key === 'mindwtr-csv';
    const name = zipped ? `d1-measure-${key}-${run}.zip` : entries[0][0];
    writeFileSync(resolve(work, name), zipped ? zipSync(Object.fromEntries(entries.map(([entry, text]) => [entry, strToU8(text)]))) : strToU8(entries[0][1]));
    const file = { name, tasks: [] };
    push(file);
    return { key, workload: `import-${key}`, file, expandedBytes, bytes: statSync(resolve(work, name)).size };
});
/** The capture popup's several lines (RN's paste path, check-capture-device's (d)): its recovery snapshot, then the lines. */
const captureLines = async (titles) => {
    setProp('clipboard', titles.join('\\n'));
    let nodes = await device.openCapture();
    await sleep(500);
    setProp('clipboard', '');
    await device.focusAtEnd(tagged(nodes, 'capture-title') ?? fail('no capture field'));
    sh('input keyevent KEYCODE_PASTE');
    await waitFor('the lines in the field', (current) => (tagged(current, 'capture-title')?.text ?? '') === titles.join('\n'), 10_000);
    const confirmTitle = en['quickAdd.bulkConfirmTitle'].replace('{{count}}', String(titles.length));
    nodes = await tapExpecting(button(await screen(), en['common.save']) ?? fail('no Save'), (current) => current.some((node) => node.text === confirmTitle), 'the several-lines question');
    await tap(button(nodes, en['quickAdd.bulkConfirmCreate']) ?? fail('no Create tasks'));
};
const bytesOf = (file) => statSync(resolve(work, file.name)).size;
/**
 * The Undo of the last restore or import, from Sync › Recovery snapshots (its newest row): the same snapshot restore its toast's
 * Undo starts, without depending on a toast that a measurement's library reads outlast (step 0 run 3: "Undo this change?"
 * never came, the toast had gone).
 */
const restoreNewestSnapshot = async () => {
    let nodes = await openRow(en['settings.sync'], onSync, 'Sync');
    for (let step = 0; step < 10 && !shown(nodes, 'recovery-snapshots-disclosure'); step += 1) nodes = await device.swipe(nodes, 'down');
    const rows = (current) => current.filter((node) => (node['resource-id'] ?? '').includes('recovery-snapshot-data.'));
    if (!rows(nodes).length) nodes = await tapExpecting(tagged(nodes, 'recovery-snapshots-disclosure') ?? fail('no Recovery snapshots card'), (current) => rows(current).length > 0, 'the snapshot rows');
    const newest = [...snapshots()].sort().at(-1) ?? fail('no recovery snapshot on disk');
    for (let step = 0; step < 6 && !rows(nodes).some((row) => row['resource-id'].endsWith(newest)); step += 1) nodes = await device.swipe(nodes, 'down');
    await tap(rows(nodes).find((row) => row['resource-id'].endsWith(newest)) ?? fail(`no row for the newest snapshot ${newest}`));
    await confirmQuestion(en['settings.backupMobile.restoreRecoverySnapshot']);
};
/**
 * That Undo, and its toast: Restore complete, or a failure named with the toast's words. Step 0 run 5 waited for the success
 * toast alone and dropped the wait's failure, so a refused Undo (its commit past the 15 min budget: "Restore failed") read as
 * an Undo that never ran, and every later row ran on the import's library.
 */
const undoNewest = async () => {
    await restoreNewestSnapshot();
    const nodes = await waitFor('the Undo\'s toast', (current) => hasText(current, en['settings.backupMobile.restoreComplete'])
        || hasText(current, en['settings.backupMobile.restoreFailed']), 900_000);
    if (!hasText(nodes, en['settings.backupMobile.restoreComplete'])) fail(`the Undo failed: ${nodes.map((node) => node.text).filter(Boolean).join(' | ')}`);
};
/** An export's folder picker: it opens once the file is written, which takes minutes for a large library (step 0 run 3). */
const exportToFolder = async (tag) => {
    await openData();
    await tap(tagged(await screen(), tag) ?? fail(`no ${tag} row`));
    let failed = false;
    await until('the folder picker or the export\'s failure', async () => {
        if (otherAppFront()) return true;
        const nodes = await screen().catch(() => []);
        failed = ['settings.backupMobile.failedToExportBackup', 'settings.exportCsvFailed', 'settings.exportTaskNotesFailed'].some((key) => hasText(nodes, en[key]));
        return failed;
    }, 900_000, 1000);
    // measureRun's loop reads the failure toast.
    if (!failed) await useTestFolder();
};
/** A new process on the Inbox, where the capture popup opens (the measurement's other steps end on Settings › Data). */
const toInbox = async () => {
    await device.stopApp();
    await launch();
};

/**
 * The recovery boot (code review 2): [stopped] starts an operation that dies with its commit journaled and never sent. Only
 * with that process gone and its one entry pending is the next start measured; otherwise the row says why it was not.
 */
const measureRecoveryBoot = async (shape, mib, stopped, options) => {
    setProp('journal_stop', 'before:backupDocumentCommit');
    let reason = null;
    try {
        await stopped();
        await until('the process to end at its journaled commit', () => !pid(), 900_000, 1000);
    } catch (error) { reason = `no stop: ${error.message}`; }
    setProp('journal_stop', '');
    if (!reason && journal().length !== 1) reason = `no pending entry (${journal().length})`;
    if (reason) {
        if (pid()) await device.stopApp();
        measured.push({ shape, workload: 'recovery-boot', sizeMiB: mib, boundary: Boolean(options.boundary), outcome: reason, pass: false });
        console.log(`measure recovery-boot not measured: ${reason}`);
        await launch();
        return null;
    }
    return measureRun(shape, 'recovery-boot', mib, async () => { device.launch(ACTIVITY); }, (nodes) => onInbox(nodes), options);
};

/**
 * The largest run the app admits at the limit (code review 2 #4): [attempt] at [startMiB], then 10 % smaller after each size
 * refusal, at most 8 times. The admitted row carries the refused attempt above it ([refusedAboveMiB], by [aboveOf]), so its
 * bytes prove it is the boundary.
 */
const atAdmittedBoundary = async (startMiB, attempt, aboveOf = (refusedRow) => rowBound(refusedRow)) => {
    let size = startMiB;
    let refusedRow = null;
    for (let tries = 0; tries < 8 && size >= 0.5; tries += 1) {
        const result = await attempt(size);
        if (!result) return null;
        if (!result.row.refused) {
            if (refusedRow) result.row.refusedAboveMiB = aboveOf(refusedRow, result.row);
            return result;
        }
        refusedRow = result.row;
        size = Math.floor(size * 9) / 10;
    }
    return null;
};

/**
 * Every workload again at the proposed limit [limitMiB] (transfer_limit_mb), each at its own admitted boundary, sized by the
 * library on the phone: a fresh restore as large as admitted (then its Undo, stopped before its send, for the recovery boot;
 * then the same restore again for the exports, the capture and the start, which read that library); a merge and a second
 * restore filling what a half-full library leaves, and that restore's Undo; each import over the largest base library it is
 * admitted on.
 */
const boundarySequence = async (shape, limitMiB, imports) => {
    const options = { boundary: true };
    const restoreAt = (workload, prefix) => async (size) => {
        const file = measureFixture(`d1-mb-${shape}-${workload}-${size}-${run}.json`, size, shape, prefix);
        push(file);
        return measureRun(shape, workload, limitMiB, () => restoreFile(file), (nodes) => hasText(nodes, en['settings.backupMobile.restoreComplete']), { ...options, sourceBytes: bytesOf(file) });
    };
    await measureFreshInstall(limitMiB);
    const fresh = await atAdmittedBoundary(limitMiB, restoreAt('restore-fresh', 'd1mf'));
    if (!fresh) return;
    const filled = measureFixture(`d1-mb-${shape}-filled-${run}.json`, fresh.row.sourceMiB, shape, 'd1mf');
    push(filled);
    // The Undo of that restore, stopped before its send: the start reads the full library, then replays the Undo.
    await measureRecoveryBoot(shape, limitMiB, restoreNewestSnapshot, options);
    await restoreFile(filled);
    await toastWith(en['settings.backupMobile.restoreComplete'], 900_000);
    setProp('export_tree', TREE);
    for (const [workload, tag, suffix] of [['export-json', 'data-transfer-export', '.json'], ['export-csv', 'data-transfer-export-csv', '.csv']]) {
        const before = exportsOnPhone();
        await measureRun(shape, workload, limitMiB, () => exportToFolder(tag),
            () => exportsOnPhone().some((name) => !before.includes(name) && name.endsWith(suffix)), options);
        sh(`rm -f ${PHONE_DIR}/mindwtr-backup*`);
    }
    setProp('export_tree', '');
    await toInbox();
    await measureRun(shape, 'capture', limitMiB, () => captureLines([`d1mbcap1${run}`, `d1mbcap2${run}`]), () => rowsLike('mb-capture', 'd1mbcap1') === 1, options);
    await measureRun(shape, 'cold-start', limitMiB, async () => { await device.stopApp(); device.launch(ACTIVITY); }, (nodes) => onInbox(nodes), options);

    // A half-full library, then a merge and a second restore each as large as admitted over it, and that restore's Undo.
    await measureFreshInstall(limitMiB);
    const base = measureFixture(`d1-mb-${shape}-base-${run}.json`, Math.max(1, Math.floor(limitMiB / 2)), shape, 'd1mh');
    push(base);
    await restoreFile(base);
    await toastWith(en['settings.backupMobile.restoreComplete'], 900_000);
    const room = () => Math.max(1, Math.floor(limitMiB - libraryNowMiB('mb-room') - 0.5));
    await atAdmittedBoundary(room(), async (size) => {
        const file = measureFixture(`d1-mb-${shape}-merge-${size}-${run}.json`, size, shape, 'd1mm');
        push(file);
        return measureRun(shape, 'merge-over', limitMiB, async () => {
            await merge(file);
            await tap(confirmButton(await waitFor('the question', (current) => Boolean(confirmButton(current)), 900_000)));
        }, (nodes) => hasText(nodes, en['settings.mergeBackup']) && !confirmButton(nodes), { ...options, sourceBytes: bytesOf(file) });
    });
    const over = await atAdmittedBoundary(room(), restoreAt('restore-over', 'd1mo'));
    if (over) {
        await measureRun(shape, 'undo', limitMiB, restoreNewestSnapshot,
            (nodes) => hasText(nodes, en['settings.backupMobile.restoreComplete']) && !confirmButton(nodes), options);
    } else measured.push({ shape, workload: 'undo', sizeMiB: limitMiB, boundary: true, outcome: 'its restore was not admitted', pass: false });

    // Each import over the largest base library it is admitted on: the refused attempt above it would have left its base
    // plus this import's growth.
    for (const item of imports) {
        await atAdmittedBoundary(Math.max(1, Math.floor(limitMiB / 2)), async (size) => {
            await measureFreshInstall(limitMiB);
            const file = measureFixture(`d1-mb-${shape}-${item.key}-base-${size}-${run}.json`, size, shape, 'd1mi');
            push(file);
            await restoreFile(file);
            await toastWith(en['settings.backupMobile.restoreComplete'], 900_000);
            return measureRun(shape, item.workload, limitMiB, () => importFile(item.key, item.file),
                (nodes) => hasText(nodes, en['settings.backupMobile.importComplete']) && !confirmButton(nodes),
                { ...options, sourceBytes: item.bytes, expandedBytes: item.expandedBytes });
        }, (refusedRow, admitted) => (refusedRow.libraryBeforeMiB ?? 0) + ((admitted.libraryAfterMiB ?? 0) - (admitted.libraryBeforeMiB ?? 0)));
    }
};

/**
 * Pass D1c step 0 (design §8, the coordinator's rulings, code review P2). Every workload of MEASURE_WORKLOADS in every shape
 * of MEASURE_SHAPES, at growing sizes: a fresh library restores A, merges B over it, restores A again, undoes that, exports
 * JSON, CSV and TaskNotes, takes the capture popup's snapshot, runs each importer's largest file (undone after), and starts
 * cold; a shape stops growing once its fresh restore fails. At the largest size that restored, a restore stopped before its
 * send measures the recovery boot. The limit: half of the smallest bound over the whole matrix (data-transfer-limit.mjs),
 * then every workload and shape again at that limit's admitted boundary, which must pass.
 */
const runSequence = async (shape, mib, { imports }) => {
    const boundary = false;
    const a = measureFixture(`d1-m-${shape}-${mib}-a-${run}.json`, mib, shape, 'd1ma');
    push(a);
    await measureFreshInstall();
    const fresh = await measureRun(shape, 'restore-fresh', mib, () => restoreFile(a), (nodes) => hasText(nodes, en['settings.backupMobile.restoreComplete']), { sourceBytes: bytesOf(a), boundary });
    if (fresh.row.outcome !== 'done') return false;
    // TaskNotes keeps its own 12 MiB library bound (step 0 run 4), so it is measured on the fresh library, the smallest here.
    setProp('export_tree', TREE);
    const zipsBefore = exportsOnPhone();
    await measureRun(shape, 'export-tasknotes', mib, () => exportToFolder('data-transfer-export-tasknotes'),
        () => exportsOnPhone().some((name) => !zipsBefore.includes(name) && name.endsWith('.zip')), { boundary });
    sh(`rm -f ${PHONE_DIR}/mindwtr-backup*`);
    setProp('export_tree', '');
    const b = measureFixture(`d1-m-${shape}-${mib}-b-${run}.json`, mib, shape, 'd1mb');
    push(b);
    await measureRun(shape, 'merge-over', mib, async () => {
        await merge(b);
        await tap(confirmButton(await waitFor('the question', (current) => Boolean(confirmButton(current)), 900_000)));
    }, (nodes) => hasText(nodes, en['settings.mergeBackup']) && !confirmButton(nodes), { sourceBytes: bytesOf(b), boundary });
    const a2 = a;
    const over = await measureRun(shape, 'restore-over', mib, () => restoreFile(a2), (nodes) => hasText(nodes, en['settings.backupMobile.restoreComplete']), { sourceBytes: bytesOf(a2), boundary });
    if (over.row.outcome === 'done') {
        await measureRun(shape, 'undo', mib, restoreNewestSnapshot,
            (nodes) => hasText(nodes, en['settings.backupMobile.restoreComplete']) && !confirmButton(nodes), { boundary });
    } else measured.push({ shape, workload: 'undo', sizeMiB: mib, boundary, outcome: 'its restore did not land', pass: false });
    setProp('export_tree', TREE);
    for (const [workload, tag, suffix] of [['export-json', 'data-transfer-export', '.json'], ['export-csv', 'data-transfer-export-csv', '.csv']]) {
        const before = exportsOnPhone();
        await measureRun(shape, workload, mib, () => exportToFolder(tag),
            () => exportsOnPhone().some((name) => !before.includes(name) && name.endsWith(suffix)), { boundary });
        sh(`rm -f ${PHONE_DIR}/mindwtr-backup*`);
    }
    setProp('export_tree', '');
    const lines = [`d1mcap1${mib}${run}`, `d1mcap2${mib}${run}`];
    await toInbox();
    await measureRun(shape, 'capture', mib, () => captureLines(lines), () => rowsLike(`m-capture-${mib}`, `d1mcap1${mib}`) === 1, { boundary });
    await device.stopApp();
    await launch();
    for (const item of imports) {
        const imported = await measureRun(shape, item.workload, mib, () => importFile(item.key, item.file),
            (nodes) => hasText(nodes, en['settings.backupMobile.importComplete']) && !confirmButton(nodes), { sourceBytes: item.bytes, expandedBytes: item.expandedBytes, boundary });
        // Undone, so the next importer meets the same library (not measured); an Undo that did not land stops the run.
        if (imported.row.outcome === 'done') await undoNewest();
        if (!pid()) await launch();
    }
    await measureRun(shape, 'cold-start', mib, async () => { await device.stopApp(); device.launch(ACTIVITY); }, (nodes) => onInbox(nodes), { boundary });
    // A restore stopped with its commit journaled, never sent: the next start's recovery boot replays it.
    await measureRecoveryBoot(shape, mib, () => restoreFile(a2), { boundary });
    sh(`rm -f ${PHONE_DIR}/${a.name} ${PHONE_DIR}/${b.name}`);
    return true;
};
/**
 * TickTick's and Mindwtr CSV's largest files (one ZIP entry of about 80k and 100k rows) on a fresh library at step 0's raised
 * limit: each imports every row (QuickJS refused the one push that took them all, so step 0 read "No importable records"), the
 * toast's recovery snapshot is the newest on disk and in Sync › Recovery snapshots, and its Undo brings the library back.
 * Each import starts on its own fresh install: an Undo leaves the imported rows as tombstones, so on one library the second
 * import's snapshot held the first's 79k (44 MiB) and its Undo passed the 15 min commit budget (batch2: BudgetTooLarge).
 */
const largeImports = async () => {
    const live = (label) => sqlite(pullDb(label), 'SELECT count(*) AS n FROM tasks WHERE deletedAt IS NULL')[0].n;
    for (const item of importFixtures().filter(({ key }) => key === 'ticktick' || key === 'mindwtr-csv')) {
        await measureFreshInstall();
        const before = live(`li-${item.key}-before`);
        await importFile(item.key, item.file);
        const toast = await waitFor(`the ${item.key} import's toast`, (current) => hasText(current, en['settings.backupMobile.importComplete'])
            || hasText(current, en['settings.backupMobile.importFailed']), 900_000);
        const words = toast.map((node) => node.text).filter(Boolean).join(' | ');
        check(hasText(toast, en['settings.backupMobile.importComplete']), `(LI ${item.key}) the ${(item.expandedBytes / MIB).toFixed(1)} MiB entry imports: ${words}`);
        const imported = Number(/Imported (\d+) task/.exec(words)?.[1] ?? NaN);
        const snapshot = /data\.[\dT.-]+\.snapshot\.json/.exec(words)?.[0];
        const after = live(`li-${item.key}-after`);
        // The fixture's own rows (data-measure-fixtures.mjs: one task per line after the header), not the importer's count.
        const rows = { ticktick: 79_477, 'mindwtr-csv': 99_999 }[item.key];
        check(imported === rows && after === before + rows, `(LI ${item.key}) every one of the fixture's ${rows} rows is a live task: ${imported} imported, ${before} -> ${after}`);
        check(snapshot && [...snapshots()].sort().at(-1) === snapshot, `(LI ${item.key}) the toast's recovery snapshot ${snapshot} is the newest on disk`);
        await undoNewest();
        const undone = live(`li-${item.key}-undo`);
        check(undone === before, `(LI ${item.key}) the Undo brings the library back: ${after} -> ${undone} (before: ${before})`);
    }
};
const measure = async () => {
    console.log(`heap limits: dalvik.vm.heapgrowthlimit=${sh('getprop dalvik.vm.heapgrowthlimit')} heapsize=${sh('getprop dalvik.vm.heapsize')}; ${sh('grep MemTotal /proc/meminfo')}`);
    const shapes = (process.env.D1_MEASURE_SHAPES ?? MEASURE_SHAPES.join(',')).split(',');
    const sizesOf = (shape) => (process.env[`D1_MEASURE_SIZES_${shape.toUpperCase()}`] ?? process.env.D1_MEASURE_SIZES ?? (shape === 'notes' ? '16,32,64,96,128' : '8,16,32,48,64')).split(',').map(Number);
    const imports = importFixtures();
    for (const shape of shapes) {
        for (const mib of sizesOf(shape)) if (!(await runSequence(shape, mib, { imports }))) break;
    }
    const proposal = proposeTransferLimit(measured, { shapes });
    for (const [cell, bound] of Object.entries(proposal.bounds)) console.log(`bound ${cell}: ${bound} MiB`);
    if (proposal.limitMiB === null || proposal.limitMiB < 1) {
        console.log(proposal.limitMiB === null ? `T: none: the matrix misses ${proposal.missing.join(', ')}` : `T: none: the smallest bound is ${proposal.smallestMiB} MiB`);
    } else {
        console.log(`T candidate: ${proposal.limitMiB} MiB (half of the smallest bound, ${proposal.smallestMiB} MiB); boundary reruns at ${proposal.limitMiB} MiB`);
        for (const shape of shapes) await boundarySequence(shape, proposal.limitMiB, imports);
        const verdict = boundaryVerdict(measured, proposal.limitMiB, { shapes });
        console.log(verdict.established ? `T established: ${proposal.limitMiB} MiB`
            : `T not established at ${proposal.limitMiB} MiB: failed ${verdict.failed.join(', ') || 'none'}; below its boundary ${verdict.belowBoundary.join(', ') || 'none'}; missing ${verdict.missing.join(', ') || 'none'}`);
    }
    setProp('transfer_limit_mb', '');
    writeFileSync(resolve(work, `measure-${run}.json`), JSON.stringify(measured, null, 2));
};

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const cleanup = cleanupOnExit([
    ...PROPS.map((name) => () => setProp(name, '')),
    () => sh(`rm -rf ${PHONE_DIR}`),
    () => sh(`rm -f ${UI_FILE}`),
    () => { if (front().includes(`${PKG}/`)) sh('input keyevent KEYCODE_HOME'); },
    () => sh(originalRotation === 'null' ? 'settings delete system user_rotation' : `settings put system user_rotation ${originalRotation}`),
    () => sh(originalAccelerometer === 'null' ? 'settings delete system accelerometer_rotation' : `settings put system accelerometer_rotation ${originalAccelerometer}`),
]);

try {
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\nrun: ${run}`);
    // A native test build another check left in front (step 0 runs outside the batch runner, which would press Home first):
    // it goes the way the checks stop an app (device.stopApp), and the phone shows Home. Any other app in front still stops
    // the check; dd's own apps are never touched.
    const leftInFront = /(tech\.dongdongbh\.mindwtr\.nativeclient[\w.]*)\//.exec(front())?.[1];
    if (leftInFront?.startsWith(NATIVE_TEST_PREFIX)) {
        await connect({ serial, pkg: leftInFront, uiFile: UI_FILE }).stopApp();
        sh('input keyevent KEYCODE_HOME');
        await sleep(1000);
    }
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    for (const name of PROPS) setProp(name, '');
    setProp('language', 'en');
    sh(`rm -rf ${PHONE_DIR}`);
    sh(`mkdir -p ${PHONE_DIR}`);
    steps: {
    if (process.env.D1C_PART === 'deadlines-1' || process.env.D1C_PART === 'deadlines-2') {
        sh('settings put system accelerometer_rotation 0');
        await deadlineRows(process.env.D1C_PART === 'deadlines-1' ? 1 : 2);
        console.log('Settings › Data deadline rows passed');
        break steps;
    }
    if (process.env.D1C_PART === 'large-import') {
        sh('settings put system accelerometer_rotation 0');
        await largeImports();
        console.log('Settings › Data large imports passed');
        break steps;
    }
    if (process.env.D1_MEASURE === '1') {
        sh('settings put system accelerometer_rotation 0');
        await measure();
        console.log('Transfer limit measurement finished');
        break steps;
    }
    // The throwaway package, fresh (as each check-upgrade-device scenario starts).
    if (sh(`pm list packages ${PKG}`).split('\n').some((line) => line.trim() === `package:${PKG}`)) sh(`pm uninstall ${PKG}`);
    adbRaw('install', '-g', apk);
    clearLogs();
    sh('settings put system accelerometer_rotation 0');
    sh('settings put system user_rotation 0');
    await launch();
    check(snapshots().length === 0 && journal().length === 0, 'a fresh library: no recovery snapshot, an empty journal');

    // ---- D0 (pass D1c): the data channel through the real QuickJS bridge: a read chunk that starts with the bridge's error
    // marker, and a write chunk that ends inside a surrogate pair, come back byte for byte ----
    setProp('channel_roundtrip', '1');
    await relaunch();
    await until('the channel round trip', () => allLogs().includes('Native Android channel roundtrip ok='), 60_000, 500);
    check(allLogs().includes('Native Android channel roundtrip ok=true'), '(D0) the file came back through the bridge byte for byte');
    setProp('channel_roundtrip', '');

    // ---- E3: Merge backup, Undo, Restore backup ----
    const a = fixture(`d1-merge-a-${run}.json`, [task(`d1a${run}`), task(`d1b${run}`, { description: '日本語 🦉' })]);
    push(a);
    await merge(a);
    await confirmQuestion(en['settings.mergeBackup']);
    let nodes = await toastWith(en['settings.mergeBackup']);
    check(Boolean(undoButton(nodes)), '(E3) the merge result shows RN\'s Undo');
    // Undo straight away (RN's toast lasts 5.6 s): RN's "Undo this change?" with the snapshot's label, then Restore.
    await tap(undoButton(nodes));
    await confirmQuestion(en['settings.undoImportConfirmTitle']);
    await toastWith(en['settings.backupMobile.restoreComplete']);
    check(liveTitles('undo').length === 0, '(E3) Undo restored the snapshot taken before the merge: no merged row is live');
    check(snapshots().length === 1, `(E3) one recovery snapshot (the merge's; a snapshot restore takes none): ${snapshots().join(' ')}`);
    check(journal().length === 0 && operations().length === 0, '(E3) the journal and the operation folder are empty');
    // The same file again: Undo deleted its rows here, and RN's merge keeps a local delete ("items you deleted here stay deleted").
    await merge(a);
    await confirmQuestion(en['settings.mergeBackup']);
    await toastWith(en['settings.mergeBackup']);
    check(liveTitles('remerge').length === 0, '(E3) merging the undone file again keeps its rows deleted, as RN\'s merge does');
    const a2 = fixture(`d1-merge-a2-${run}.json`, [task(`d1a${run}`), task(`d1b${run}`, { description: '日本語 🦉' })]);
    push(a2);
    await merge(a2);
    await confirmQuestion(en['settings.mergeBackup']);
    await toastWith(en['settings.mergeBackup']);
    check(JSON.stringify(liveTitles('merge')) === JSON.stringify([`d1a${run}`, `d1b${run}`]), '(E3) Merge backup added both rows once');

    // ---- E1: the three exports into the folder RN's picker grants ----
    setProp('export_tree', TREE);
    const json = await exportFile('data-transfer-export', '.json');
    const exported = JSON.parse(readFileSync(json.local, 'utf8'));
    const db = pullDb('export');
    const ids = sqlite(db, 'SELECT id FROM tasks ORDER BY id').map((row) => row.id);
    check(JSON.stringify(exported.tasks.map((item) => item.id).sort()) === JSON.stringify(ids), `(E1) ${json.name} holds every task the library holds (${ids.length})`);
    check(exported.tasks.find((item) => item.title === `d1b${run}` && !item.deletedAt)?.description === '日本語 🦉', '(E1) the export keeps the description text byte for byte');
    check(allLogs().includes('"releaseCheck":"v1.3.5/android-backup-export"') && allLogs().includes('"route":"saf"'), '(E1) the export line says route=saf');
    const csv = await exportFile('data-transfer-export-csv', '.csv');
    const csvText = readFileSync(csv.local, 'utf8');
    // Core's header (mindwtr-csv-columns.ts) starts with its Title column; one line per live row of this run.
    check(csvText.startsWith('Title,Description,Status,') && [`d1a${run}`, `d1b${run}`].every((title) => csvText.includes(`\n${title},`)),
        `(E1) ${csv.name} is Mindwtr CSV with this run's rows`);
    const zip = await exportFile('data-transfer-export-tasknotes', '-tasknotes.zip');
    const entries = execFileSync('unzip', ['-Z1', zip.local], { encoding: 'utf8' });
    check(entries.includes(`d1a${run}`), `(E1) ${zip.name} holds a TaskNotes file per task`);
    // The three exports are core's bytes: data-export-expected.ts loads the database pulled after the JSON export through core's
    // store (bun) and runs core's serializers; the library does not change between the three exports.
    const expected = JSON.parse(execFileSync('bun', [resolve(app, 'scripts/data-export-expected.ts'), db], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    check(readFileSync(json.local, 'utf8') === expected.json, `(E1) ${json.name} is byte for byte core's serializeBackupData of the library`);
    check(csvText === expected.csv, `(E1) ${csv.name} is byte for byte core's serializeMindwtrCsv`);
    const zipPaths = entries.split('\n').filter(Boolean).sort();
    check(JSON.stringify(zipPaths) === JSON.stringify(expected.tasknotes.map((file) => file.path).sort())
        && expected.tasknotes.every((file) => execFileSync('unzip', ['-p', zip.local, file.path], { encoding: 'utf8' }) === file.content),
        `(E1) ${zip.name} holds core's serializeTaskNotesExport files byte for byte (${zipPaths.length})`);
    // RN's folder grant: Expo takes the picked tree as a persistable grant; so does the native app (design §5).
    check(persistedGrant('Download%2Fmtd1'), '(E1) the picked folder is a persisted grant of the app, as RN\'s Expo takes it');

    // ---- E2: no folder picked: RN's share fallback; nothing is created ----
    setProp('export_tree', '');
    const beforeShare = exportsOnPhone();
    await openData();
    await tap(tagged(await screen(), 'data-transfer-export'));
    await until('the folder picker', otherAppFront, 15_000, 500);
    await sleep(1200);
    // Back walks up the picker's folders first (it reopens in the last folder, Download/mtd1); it cancels at the top.
    const pickerFront = () => front().includes('documentsui');
    for (let step = 0; step < 8 && pickerFront(); step += 1) { sh('input keyevent KEYCODE_BACK'); await sleep(1200); }
    await until('the share sheet', () => sh('dumpsys activity activities').includes('act=android.intent.action.CHOOSER'), 15_000, 500);
    check(true, '(E2) a cancelled folder picker opens the share sheet');
    for (let step = 0; step < 3 && otherAppFront(); step += 1) { sh('input keyevent KEYCODE_BACK'); await sleep(1200); }
    requireAppFront();
    check(JSON.stringify(exportsOnPhone()) === JSON.stringify(beforeShare), '(E2) nothing was written into the folder, and no target was picked');

    // ---- E3: Restore backup from the E1 file replaces the library ----
    const b = fixture(`d1-merge-b-${run}.json`, [task(`d1c${run}`)]);
    push(b);
    await merge(b);
    await confirmQuestion(en['settings.mergeBackup']);
    await toastWith(en['settings.mergeBackup']);
    check(liveTitles('before-restore').includes(`d1c${run}`), '(E3) a second merge added its row');
    const appLock = (label) => sqlite(pullDb(label), "SELECT json_extract(data, '$.security') AS security FROM settings WHERE id = 1")[0]?.security ?? null;
    const lockBefore = appLock('lock-before');
    await openData();
    await tap(tagged(await screen(), 'data-transfer-restore'));
    await pickDocument(json.name);
    await until('the app back in front', () => !otherAppFront(), 15_000, 500);
    await confirmQuestion(en['settings.backupMobile.restoreBackup']);
    nodes = await toastWith(en['settings.backupMobile.restoreComplete']);
    check(Boolean(undoButton(nodes)), '(E3) the restore result shows Undo too (RN\'s 32c840ec9)');
    check(JSON.stringify(liveTitles('restore')) === JSON.stringify([`d1a${run}`, `d1b${run}`]), '(E3) Restore backup gave the exported library: the later row is gone');
    check(appLock('lock-after') === lockBefore, `(E3) the restore left App Lock as it was (${lockBefore})`);

    // ---- Sync › Recovery snapshots: RN's rows and question ----
    nodes = await openRow(en['settings.sync'], onSync, 'Sync');
    for (let step = 0; step < 10 && !shown(nodes, 'recovery-snapshots-disclosure'); step += 1) nodes = await device.swipe(nodes, 'down');
    nodes = await tapExpecting(tagged(nodes, 'recovery-snapshots-disclosure') ?? fail('no Recovery snapshots card'),
        (current) => current.some((node) => (node['resource-id'] ?? '').includes('recovery-snapshot-data.')), 'the snapshot rows');
    // A dump holds only the rows on screen: gather them while scrolling down, then come back to the newest (the first row).
    const snapshotRows = (current) => current.filter((node) => (node['resource-id'] ?? '').includes('recovery-snapshot-data.'));
    const onDisk = snapshots();
    const newest = [...onDisk].sort().at(-1);
    const seen = new Map();
    for (let step = 0; step < 6; step += 1) {
        for (const row of snapshotRows(nodes)) seen.set(row['resource-id'], row['content-desc'] ?? '');
        if (seen.size >= onDisk.length) break;
        nodes = await device.swipe(nodes, 'down');
    }
    check(seen.size === Math.min(5, onDisk.length) && [...seen].every(([id, spoken]) => spoken.includes(id.slice(id.indexOf('recovery-snapshot-') + 'recovery-snapshot-'.length))),
        `(snapshots) one row per snapshot on disk, TalkBack names each with its file: ${seen.size} of ${onDisk.length}`);
    for (let step = 0; step < 6 && !snapshotRows(nodes).some((row) => row['resource-id'].endsWith(newest)); step += 1) nodes = await device.swipe(nodes, 'up');
    await tap(snapshotRows(nodes).find((row) => row['resource-id'].endsWith(newest)) ?? fail(`no row for the newest snapshot ${newest}`));
    await confirmQuestion(en['settings.backupMobile.restoreRecoverySnapshot']);
    nodes = await toastWith(en['settings.backupMobile.restoreComplete']);
    check(!undoButton(nodes), '(snapshots) a snapshot restore offers no Undo, as RN');

    // ---- E5: a merge held before its commit: one busy row, the others off ----
    const c = fixture(`d1-merge-c-${run}.json`, [task(`d1d${run}`)]);
    push(c);
    setProp('delay_before_ms', '8000');
    await merge(c);
    nodes = await waitFor('the question', (current) => Boolean(confirmButton(current)), 60_000);
    await tap(confirmButton(nodes));
    const rowTags = ['data-transfer-export', 'data-transfer-export-csv', 'data-transfer-export-tasknotes', 'data-transfer-restore', 'data-transfer-merge'];
    nodes = await waitFor('the merge to wait', (current) => rowTags.every((tag) => tagged(current, tag)?.enabled === 'false'), 30_000);
    check(true, '(E5) while the merge runs every data row is off (RN\'s isBackupBusy), the merge row with RN\'s spinner (screenshot)');
    const starterWhileBusy = tagged(nodes, 'add-getting-started-content');
    check(!starterWhileBusy || starterWhileBusy.enabled === 'false', '(E5) Getting Started is off too while the merge runs');
    writeFileSync(resolve(work, 'e5-busy.png'), adbRaw('exec-out', 'screencap', '-p'));
    await toastWith(en['settings.mergeBackup']);
    setProp('delay_before_ms', '');

    // ---- E4: process death at each step ----
    const crash = async (label, props, file, { landed, expectReplay }) => {
        for (const [name, value] of Object.entries(props)) setProp(name, value);
        push(file);
        await merge(file);
        const question = await waitFor('the question', (current) => Boolean(confirmButton(current)), 60_000);
        await tap(confirmButton(question));
        await until(`the process to end (${label})`, () => !pid(), 90_000, 500);
        for (const name of Object.keys(props)) setProp(name, '');
        const replays = replayLines().length;
        await launch();
        // The leftover result shows once, for RN's 5.6 s, right after the start: watch for it before the slow database reads.
        if (landed) await toastWith(en['settings.mergeBackup'], 60_000);
        const mine = file.tasks.map((item) => item.title);
        const settledAs = (titles) => mine.every((title) => titles.filter((seen) => seen === title).length === (landed ? 1 : 0));
        let titles = [];
        await until(`(E4 ${label}) the library to settle`, () => settledAs(titles = liveTitles(label)), 30_000, 2_000).catch(() => undefined);
        check(settledAs(titles), `(E4 ${label}) the merge ${landed ? 'landed once' : 'did not land'}`);
        await until(`(E4 ${label}) the journal and the operation folder to empty`, () => journal().length === 0 && operations().length === 0, 30_000);
        if (expectReplay) check(replayLines().length > replays && replayLines().at(-1).includes('"outcome":"committed"'), `(E4 ${label}) the start replayed the commit: ${replayLines().at(-1)?.slice(replayLines().at(-1).indexOf('{'))}`);
        check(true, `(E4 ${label}) the journal and the operation folder are empty`);
    };
    await crash('after-snapshot', { backup_stop: 'after-snapshot' }, fixture(`d1-crash-1-${run}.json`, [task(`d1e${run}`)]), { landed: false });
    await crash('mid-plan', { backup_stop: 'mid-plan' }, fixture(`d1-crash-2-${run}.json`, [task(`d1f${run}`)]), { landed: false });
    await crash('before-commit', { journal_stop: 'before:backupDocumentCommit' }, fixture(`d1-crash-3-${run}.json`, [task(`d1g${run}`)]), { landed: true, expectReplay: true });
    // E4c: the data and its receipt are committed in SQL; the process dies before core reloads or replies.
    await crash('after-sql-commit', { commit_stop: 'backupDocumentCommit' }, fixture(`d1-crash-8-${run}.json`, [task(`d1n${run}`)]), { landed: true, expectReplay: true });
    await crash('after-commit', { journal_stop: 'after:backupDocumentCommit' }, fixture(`d1-crash-4-${run}.json`, [task(`d1h${run}`)]), { landed: true, expectReplay: true });
    await crash('after-settle', { backup_stop: 'after-settle' }, fixture(`d1-crash-5-${run}.json`, [task(`d1i${run}`)]), { landed: true });

    // A plan changed on disk while the process was dead is never sent (the identity check): the start shows RN's Merge failed
    // with core's reason before the record goes, and nothing lands (review 2, #7).
    setProp('journal_stop', 'before:backupDocumentCommit');
    const changed = fixture(`d1-crash-9-${run}.json`, [task(`d1o${run}`)]);
    push(changed);
    await merge(changed);
    await tap(confirmButton(await waitFor('the question', (current) => Boolean(confirmButton(current)), 60_000)));
    await until('the process to end (changed plan)', () => !pid(), 90_000, 500);
    setProp('journal_stop', '');
    const [changedOp] = operations();
    runAs(`sh -c 'echo x >> no_backup/backup-operations/${changedOp}/plan.json'`);
    await launch();
    await toastWith(en['settings.mergeBackupFailed'], 60_000);
    check(true, '(E4 changed plan) the start showed RN\'s Merge failed for a plan changed on disk');
    await until('(E4 changed plan) the journal and the operation folder to empty', () => journal().length === 0 && operations().length === 0, 30_000);
    check(!liveTitles('changed-plan').includes(`d1o${run}`), '(E4 changed plan) the changed plan was never sent: nothing landed');

    // settle-fail: the merge shows its result, but its entry and plan stay until the next start replays them from the receipt.
    setProp('backup_stop', 'settle-fail');
    const f = fixture(`d1-crash-6-${run}.json`, [task(`d1j${run}`)]);
    push(f);
    await merge(f);
    await confirmQuestion(en['settings.mergeBackup']);
    await toastWith(en['settings.mergeBackup']);
    setProp('backup_stop', '');
    check(journal().length === 1 && operations().length === 1, '(E4 settle-fail) the entry and its plan stay while the journal owns them');
    await relaunch();
    await until('(E4 settle-fail) the replay to empty them', () => journal().length === 0 && operations().length === 0, 30_000);
    check(liveTitles('settle-fail').filter((title) => title === `d1j${run}`).length === 1, '(E4 settle-fail) the replay answered from the receipt: the row is there once');

    // E4a: a task that becomes due while the commit waits in the journal; the recovery boot replays before the promotion.
    const due = fixture(`d1-due-${run}.json`, [task(`d1k${run}`, { status: 'inbox', startTime: new Date(Date.now() + 45_000).toISOString() })]);
    push(due);
    await merge(due);
    await confirmQuestion(en['settings.mergeBackup']);
    await toastWith(en['settings.mergeBackup']);
    const g = fixture(`d1-crash-7-${run}.json`, [task(`d1l${run}`)]);
    setProp('journal_stop', 'before:backupDocumentCommit');
    push(g);
    await merge(g);
    await confirmQuestion(en['settings.mergeBackup']);
    await until('the process to end (E4a)', () => !pid(), 90_000, 500);
    setProp('journal_stop', '');
    await sleep(Math.max(0, Date.parse(due.tasks[0].startTime) - Date.now()) + 5_000);
    const replays = replayLines().length;
    await launch();
    check(replayLines().length > replays && replayLines().at(-1).includes('"outcome":"committed"'), '(E4a) the commit replayed after a task became due landed, not stale');
    check(liveTitles('due').includes(`d1l${run}`), '(E4a) its row is in the library');
    let promoted;
    await until('(E4a) the due task to be promoted', () => (promoted = sqlite(pullDb('due-status'), `SELECT status FROM tasks WHERE title = 'd1k${run}'`)[0]?.status) === 'next', 30_000)
        .catch(() => undefined);
    check(promoted === 'next', `(E4a) normal activation ran after the replay: the due task is promoted (${promoted})`);

    // ---- E2b: a death in the middle of a folder write ----
    setProp('export_tree', TREE);
    setProp('backup_stop', 'mid-export');
    const beforeKill = exportsOnPhone();
    await openData();
    await tap(tagged(await screen(), 'data-transfer-export'));
    await useTestFolder().catch(() => undefined);
    await until('the process to end mid-export', () => !pid(), 60_000, 500);
    setProp('backup_stop', '');
    check(exportsOnPhone().length > beforeKill.length, '(E2b) the half-written file is in the folder after the death');
    await launch();
    await until('(E2b) the half file to go', () => exportsOnPhone().length === beforeKill.length, 30_000);
    check(allLogs().includes('v1.3.5/android-export-cleanup'), '(E2b) the start removed it and logged android-export-cleanup');
    setProp('export_tree', '');

    // ---- Pass D1b: Getting Started and the five imports ----
    const freshInstall = async () => {
        if (sh(`pm list packages ${PKG}`).split('\n').some((line) => line.trim() === `package:${PKG}`)) sh(`pm uninstall ${PKG}`);
        adbRaw('install', '-g', apk);
        await launch();
    };
    const starterRows = (label) => {
        const db = pullDb(label);
        const projects = sqlite(db, 'SELECT id, title FROM projects WHERE deletedAt IS NULL').filter((row) => row.title === en['starter.projectTitle']);
        const tasks = sqlite(db, 'SELECT title, projectId, status FROM tasks WHERE deletedAt IS NULL');
        return {
            projects: projects.length,
            tasks: projects.length === 1 ? tasks.filter((row) => row.projectId === projects[0].id).length : 0,
            samples: tasks.filter((row) => !row.projectId && row.status === 'inbox' && [en['starter.sampleBuyMilk'], en['starter.sampleReplySam']].includes(row.title)).length,
        };
    };
    const seededLines = (outcome) => allLogs().split('\n').filter((line) => line.includes('v1.3.7/native-getting-started') && line.includes(`"outcome":"${outcome}"`)).length;
    const gettingStartedRow = async () => {
        let nodes = await openData();
        for (let step = 0; step < 6 && !shown(nodes, 'add-getting-started-content'); step += 1) nodes = await device.swipe(nodes, 'down');
        return tagged(nodes, 'add-getting-started-content') ?? fail('no Getting Started row');
    };

    // G1: the row seeds once; RN's toast offers Open; a second tap adds nothing.
    check(starterRows('g1-before').projects === 0, '(G1) the library has no Getting Started project before the tap');
    const created = seededLines('created');
    await tap(await gettingStartedRow());
    nodes = await waitFor('RN\'s Getting Started toast', (current) => hasText(current, en['onboarding.toastReady']), 60_000);
    const open = nodes.find((node) => node.text === en['common.open']);
    check(Boolean(open), '(G1) the toast offers RN\'s Open');
    await tap(open);
    // The project screen shows its title in an editable field, which hasText skips.
    await waitFor('the Getting Started project', (current) => tagged(current, 'project-title-input')?.text === en['starter.projectTitle'], 30_000);
    let seeded = starterRows('g1-after');
    check(seeded.projects === 1 && seeded.tasks === 7 && seeded.samples === 2, `(G1) one project with 7 tasks and 2 Inbox samples: ${JSON.stringify(seeded)}`);
    check(seededLines('created') === created + 1, '(G1) the log shows outcome=created once');
    const unchanged = seededLines('unchanged');
    await tap(await gettingStartedRow());
    await waitFor('RN\'s Getting Started toast again', (current) => hasText(current, en['onboarding.toastReady']), 60_000);
    seeded = starterRows('g1-again');
    check(seeded.projects === 1 && seeded.tasks === 7 && seeded.samples === 2, `(G1) a second tap adds nothing: ${JSON.stringify(seeded)}`);
    await until('(G1) the second seed\'s log line', () => seededLines('unchanged') === unchanged + 1, 15_000);
    check(true, '(G1) the second tap logs outcome=unchanged');

    // The import fixtures (titles d1…<run>; dates relative to now): written here, pushed to the test folder.
    const binary = (name, bytes) => { writeFileSync(resolve(work, name), bytes); return { name, tasks: [] }; };
    const csvLine = (cells) => cells.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',');
    const tickTime = new Date().toISOString().replace(/\.\d{3}Z$/, '+0000');
    const ticktickHeaders = ['Folder Name', 'List Name', 'Title', 'Kind', 'Tags', 'Content', 'Is Check list', 'Start Date', 'Due Date', 'Repeat', 'Priority', 'Status', 'Created Time', 'Completed Time', 'Timezone', 'Is All Day', 'taskId', 'parentId'];
    const omniHeaders = ['Task ID', 'Type', 'Name', 'Status', 'Project', 'Context', 'Start Date', 'Planned Date', 'Due Date', 'Completion Date', 'Duration', 'Flagged', 'Notes', 'Tags'];
    const imports = [
        { key: 'todoist', file: binary(`d1-todoist-${run}.zip`, zipSync({ [`d1tdproj${run}.csv`]: strToU8(['TYPE,CONTENT,PRIORITY,INDENT,DATE,DESCRIPTION', `task,d1tda${run},1,1,,`, `task,d1tdb${run},4,1,,Second task`].join('\n')) })), title: en['settings.backupMobile.importTodoistData'] },
        { key: 'ticktick', file: binary(`d1-ticktick-${run}.zip`, zipSync({ 'backup.csv': strToU8([csvLine(ticktickHeaders),
            csvLine(['D1 folder', `d1ttlist${run}`, `d1tta${run}`, 'TEXT', '', 'Notes', 'N', '', '', '', '0', '0', tickTime, '', 'UTC', 'false', '1', '']),
            csvLine(['D1 folder', `d1ttlist${run}`, `d1ttb${run}`, 'TEXT', '', '', 'N', '', '', '', '1', '0', tickTime, '', 'UTC', 'false', '2', ''])].join('\n')) })), title: en['settings.backupMobile.importTicktickData'] },
        { key: 'dgt', file: binary(`d1-dgt-${run}.json`, strToU8(JSON.stringify({ version: 3, FOLDER: [{ ID: 1, TITLE: `d1dgtfolder${run}`, ORDINAL: 0 }],
            TASK: [{ ID: 10, TYPE: 1, TITLE: `d1dgtproj${run}`, FOLDER: 1, ORDINAL: 0 }, { ID: 11, TYPE: 0, TITLE: `d1dga${run}`, PARENT: 10, STATUS: 0 }, { ID: 12, TYPE: 0, TITLE: `d1dgb${run}`, STATUS: 1 }] }))), title: en['settings.backupMobile.importDgtGtdData'] },
        { key: 'omnifocus', file: binary(`d1-omnifocus-${run}.csv`, strToU8([csvLine(omniHeaders),
            csvLine(['p1', 'Project', `d1ofproj${run}`, 'Active', '', '', '', '', '', '', '', '0', '', '']),
            csvLine(['a1', 'Action', `d1ofa${run}`, 'Available', `d1ofproj${run}`, '', '', '', '', '', '', '0', '', '']),
            csvLine(['a2', 'Action', `d1ofb${run}`, 'Available', '', '', '', '', '', '', '', '1', '', ''])].join('\n'))), title: en['settings.backupMobile.importOmnifocusData'] },
        { key: 'mindwtr-csv', file: binary(`d1-mindwtr-${run}.csv`, strToU8(`Title,Project\nd1mca${run},d1mcproj${run}\nd1mcb${run},\n`)), title: en['settings.backupMobile.importMindwtrCsvData'] },
    ];
    for (const item of imports) push(item.file);
    const openImports = async () => {
        let nodes = await openData();
        for (let step = 0; step < 8 && !shown(nodes, 'import-disclosure'); step += 1) nodes = await device.swipe(nodes, 'down');
        if (tagged(nodes, 'import-guide-link')) return nodes;
        return tapExpecting(tagged(nodes, 'import-disclosure') ?? fail('no Import fold'), (current) => Boolean(tagged(current, 'import-guide-link')), 'the Import fold open');
    };
    const importRow = async (key) => {
        let nodes = await openImports();
        for (let step = 0; step < 6 && !shown(nodes, `data-transfer-import-${key}`); step += 1) nodes = await device.swipe(nodes, 'down');
        return tagged(nodes, `data-transfer-import-${key}`) ?? fail(`no ${key} import row`);
    };
    const importPick = async (key, file) => {
        await tap(await importRow(key));
        await pickDocument(file.name);
        await until('the app back in front', () => !otherAppFront(), 15_000, 500);
    };
    const taggedRows = (db) => sqlite(db, `SELECT t.title AS title, t.status AS status, p.title AS project FROM tasks t LEFT JOIN projects p ON p.id = t.projectId WHERE t.deletedAt IS NULL AND t.title LIKE 'd1%${run}'`)
        .sort((left, right) => left.title.localeCompare(right.title));
    const staged = () => listing('no_backup/backup-import');
    const committedLines = (operation) => allLogs().split('\n').filter((line) => line.includes('v1.3.4/native-backup-document') && line.includes(`"operation":"${operation}"`)).length;
    const receiptCount = (label, operation) => sqlite(pullDb(label), `SELECT count(*) AS n FROM native_request_receipts WHERE method LIKE '["backupDocument","${operation}",%'`)[0].n;

    // I1: each importer's rows are core's own import of the fixture over the library just before; Undo leaves none.
    for (const item of imports) {
        const before = pullDb(`i1-${item.key}-before`);
        const beforeRows = JSON.stringify(taggedRows(before));
        const expected = JSON.parse(execFileSync('bun', [resolve(app, 'scripts/data-import-expected.ts'), before, item.key, resolve(work, item.file.name), run], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
        await importPick(item.key, item.file);
        await confirmQuestion(item.title);
        nodes = await toastWith(en['settings.backupMobile.importComplete']);
        check(Boolean(undoButton(nodes)), `(I1 ${item.key}) the result shows RN's Undo`);
        const after = taggedRows(pullDb(`i1-${item.key}-after`));
        check(after.length > JSON.parse(beforeRows).length && JSON.stringify(after) === JSON.stringify(expected),
            `(I1 ${item.key}) the imported rows are core's import of the fixture: ${JSON.stringify(after)}`);
        await tap(undoButton(nodes));
        await confirmQuestion(en['settings.undoImportConfirmTitle']);
        await toastWith(en['settings.backupMobile.restoreComplete']);
        check(JSON.stringify(taggedRows(pullDb(`i1-${item.key}-undo`))) === beforeRows, `(I1 ${item.key}) Undo gave the library back as it was`);
        check(journal().length === 0 && operations().length === 0 && staged().length === 0, `(I1 ${item.key}) the journal, the operation folder and the staging folder are empty`);
    }

    // I2: a TickTick file on the DGT row: core's invalid-file warning; the staged copy goes.
    await importPick('dgt', imports[1].file);
    await waitFor('the invalid-file warning', (current) => hasText(current, en['settings.backupMobile.importFailed']), 60_000);
    check(staged().length === 0 && !confirmButton(await screen()), '(I2) a TickTick file on the DGT row asks nothing and leaves no staged copy');

    // I3: a file one byte past core's 16 MiB import cap (pass D1c: the cap holds whatever the transfer limit) is refused while
    // it is copied: core's limit text, no copy left.
    const big = binary(`d1-big-${run}.csv`, Buffer.alloc(16 * 1024 * 1024 + 1, 'x'));
    push(big);
    // A transfer limit above 16 MiB (code review P3): only the import's own staging cap can refuse this file here.
    setProp('transfer_limit_mb', '32');
    await importPick('mindwtr-csv', big);
    await waitFor('the limit refusal', (current) => hasText(current, en['settings.backupMobile.importFailed']) && hasText(current, en['settings.importDiagnostics.limitExceeded']), 60_000);
    setProp('transfer_limit_mb', '');
    check(staged().length === 0 && !confirmButton(await screen()), '(I3) under a 32 MiB transfer limit, a 16 MiB + 1 byte import is refused while copied, with core\'s limit text and no staged copy');
    sh(`rm -f ${PHONE_DIR}/${big.name}`);

    // I4: a Todoist import stopped before the journal; then one stopped right after its COMMIT. Each time the files are read
    // while the process is dead (the disk as the next start finds it), then the start is watched, dump by dump, until the
    // Inbox shows and the leftovers are cleaned: a result toast in any dump is caught however briefly it shows.
    const importCrash = async (label, props, file) => {
        push(file);
        for (const [name, value] of Object.entries(props)) setProp(name, value);
        await importPick('todoist', file);
        await tap(confirmButton(await waitFor('the question', (current) => Boolean(confirmButton(current)), 60_000)));
        await until(`the process to end (I4 ${label})`, () => !pid(), 120_000, 500);
        for (const name of Object.keys(props)) setProp(name, '');
    };
    const hasResult = () => listing('no_backup/backup-operations').includes('result.json');
    const resultToast = (nodes) => hasText(nodes, en['settings.backupMobile.importComplete']) || hasText(nodes, en['settings.backupMobile.importFailed']);
    /**
     * Starts the app and reads every screen until the app logs that its start's leftover step is over (a debug build's
     * `Native Android data leftover done result=…`) and [settled] holds; then, when that step handed a toast over, until the
     * toast is seen. Answers the step's result (`none`, `result`, `failure`) and whether any dump showed a result toast.
     */
    const leftoverDone = () => allLogs().split('\n').filter((line) => line.includes('Native Android data leftover done result='));
    const watchStart = async (settled) => {
        const before = leftoverDone().length;
        device.launch(ACTIVITY);
        let toast = false;
        let found = null;
        const deadline = Date.now() + 120_000;
        for (;;) {
            const nodes = await screen().catch(() => []);
            if (resultToast(nodes)) toast = true;
            const done = leftoverDone();
            if (found === null && done.length > before) found = /result=(\w+)/.exec(done.at(-1))[1];
            if (found !== null && onInbox(nodes) && settled() && (found === 'none' || toast)) return { found, toast };
            if (Date.now() > deadline) fail(`timed out watching the start (leftover step ${found ?? 'not done'}, toast ${toast})`);
            await sleep(300);
        }
    };
    const todoistCsv = (titles) => strToU8(['TYPE,CONTENT,PRIORITY,INDENT,DATE,DESCRIPTION', ...titles.map((title) => `task,${title},1,1,,`)].join('\n'));
    for (const [label, stop] of [['after-snapshot', 'after-snapshot'], ['mid-plan', 'mid-plan']]) {
        const titles = [`d1i4${label.replace('-', '')}${run}`];
        const lines = committedLines('todoist');
        const replays = replayLines().length;
        await importCrash(label, { backup_stop: stop }, binary(`d1-i4-${label}-${run}.zip`, zipSync({ [`d1i4proj${run}.csv`]: todoistCsv(titles) })));
        // Dead: no journal entry, no result record. Since pass D1c the operation's folder exists from before its prepare (its
        // snapshot name's reservation), so either stop leaves one folder with no manifest; the next start deletes it.
        check(journal().length === 0 && !hasResult(), `(I4 ${label}) while stopped: no journal entry and no result record`);
        const folders = operations();
        check(folders.length === 1 && !listing(`no_backup/backup-operations/${folders[0]}`).includes('manifest.json'),
            `(I4 ${label}) while stopped: one unpublished operation folder, no manifest (${folders.join(' ')})`);
        check(!taggedRows(pullDb(`i4-${label}`)).some((row) => titles.includes(row.title)), `(I4 ${label}) nothing landed`);
        const start = await watchStart(() => operations().length === 0 && journal().length === 0);
        check(start.found === 'none' && !start.toast, `(I4 ${label}) the start's leftover step found no result and showed no toast: ${JSON.stringify(start)}`);
        check(!hasResult() && committedLines('todoist') === lines && replayLines().length === replays, `(I4 ${label}) no result record, no commit line and no replay line`);
    }
    {
        const titles = [`d1i4aftercommit${run}`];
        const lines = committedLines('todoist');
        const replays = replayLines().length;
        const receipts = receiptCount('i4-receipts-before', 'todoist');
        await importCrash('after-commit', { commit_stop: 'backupDocumentCommit' }, binary(`d1-i4-after-commit-${run}.zip`, zipSync({ [`d1i4proj${run}.csv`]: todoistCsv(titles) })));
        // Dead right after COMMIT: the rows and the receipt are in SQLite, the entry still journaled, no result record yet.
        check(journal().length === 1 && operations().length === 1 && !hasResult(), '(I4 after-commit) while stopped: the entry and its folder, no result record');
        const landed = taggedRows(pullDb('i4-after-commit')).filter((row) => titles.includes(row.title));
        check(landed.length === 1, `(I4 after-commit) while stopped: the import landed exactly once: ${JSON.stringify(landed)}`);
        check(receiptCount('i4-receipts-after', 'todoist') === receipts + 1, '(I4 after-commit) while stopped: its receipt is in SQLite');
        check(committedLines('todoist') === lines, '(I4 after-commit) no commit line: the stop came right after COMMIT');
        const start = await watchStart(() => journal().length === 0 && operations().length === 0 && !hasResult());
        check(start.found === 'result' && start.toast, `(I4 after-commit) the start showed the leftover result: ${JSON.stringify(start)}`);
        check(taggedRows(pullDb('i4-after-replay')).filter((row) => titles.includes(row.title)).length === 1, '(I4 after-commit) still exactly once after the replay');
        const replayed = replayLines().slice(replays);
        check(replayed.length === 1 && replayed[0].includes('"operation":"todoist"') && replayed[0].includes('"outcome":"committed"'), `(I4 after-commit) one replay line, todoist committed: ${replayed.join(' | ')}`);
        await device.stopApp();
        check(!hasResult() && journal().length === 0, '(I4 after-commit) stopped again: no result record is left to show');
        const again = await watchStart(() => true);
        check(again.found === 'none' && !again.toast, `(I4 after-commit) a second start's leftover step found nothing to show: ${JSON.stringify(again)}`);
    }

    // I5: Codex's 60 000-row Mindwtr CSV grows the library past what its Undo could admit: refused before COMMIT, nothing lands.
    const expansion = binary(`d1-expansion-${run}.csv`, strToU8(`Title\n${Array.from({ length: 60_000 }, (_, index) => `d1x${index}x${run}`).join('\n')}\n`));
    push(expansion);
    const csvReceipts = receiptCount('i5-before', 'csv');
    // The 12 MiB limit this row was built for (pass D1c raises the default; the Undo-size refusal is what it checks).
    setProp('transfer_limit_mb', '12');
    await importPick('mindwtr-csv', expansion);
    await confirmQuestion(en['settings.backupMobile.importMindwtrCsvData']);
    await waitFor('the Undo-size refusal', (current) => hasText(current, en['settings.backupMobile.importFailed']) && hasText(current, en['settings.importDiagnostics.limitExceeded']), 600_000);
    check(!taggedRows(pullDb('i5')).some((row) => row.title.startsWith('d1x')), '(I5) the 60 000-row import landed nothing');
    check(receiptCount('i5-after', 'csv') === csvReceipts, '(I5) and wrote no receipt');
    await until('(I5) the journal and the operation folder to empty', () => journal().length === 0 && operations().length === 0, 60_000);
    setProp('transfer_limit_mb', '');
    sh(`rm -f ${PHONE_DIR}/${expansion.name}`);

    // I6: sentinels in a dropped repeat rule, a renamed project and a skipped archive entry's name. The durable files are read
    // while the process is dead at the two points they exist: right after the commit's reply (journal entry, plan, manifest and
    // receipt on disk) and right after the result record is written (before its toast).
    const S1 = `TOKEN=d1sentinelone${run}`;
    const S2 = `d1sentineltwo${run}`;
    const S3 = `d1sentinelthree${run}`;
    const holders = (sentinel) => runAs(`sh -c 'grep -rl "${sentinel}" files no_backup databases 2>/dev/null || true'`).split(/\s+/).filter(Boolean);
    const receiptReplies = (label) => JSON.stringify(sqlite(pullDb(label), 'SELECT reply FROM native_request_receipts'));
    // A project titled S2 made by a Mindwtr CSV import: an unrelated id, so the Todoist file named S2 collides by title.
    const seed = binary(`d1-seed-${run}.csv`, strToU8(`Title,Project\nd1s2seed${run},${S2}\n`));
    push(seed);
    await importPick('mindwtr-csv', seed);
    await confirmQuestion(en['settings.backupMobile.importMindwtrCsvData']);
    await toastWith(en['settings.backupMobile.importComplete']);
    // The colliding Todoist import, stopped once its result record is written: it renamed the project (the warning ran).
    const renamed = binary(`d1-renamed-${run}.zip`, zipSync({ [`${S2}.csv`]: todoistCsv([`d1s2b${run}`]) }));
    push(renamed);
    setProp('backup_stop', 'after-settle');
    await importPick('todoist', renamed);
    await confirmQuestion(en['settings.backupMobile.importTodoistData']);
    await until('the process to end (I6 rename)', () => !pid(), 120_000, 500);
    setProp('backup_stop', '');
    const renamedProjects = sqlite(pullDb('i6-rename'), 'SELECT title FROM projects WHERE deletedAt IS NULL').map((row) => row.title).filter((title) => title.startsWith(S2));
    check(renamedProjects.length === 2 && renamedProjects.some((title) => title !== S2), `(I6) the Todoist import collided and renamed its project: ${renamedProjects.join(' | ')}`);
    check(hasResult(), '(I6 rename) while stopped: the result record is on disk');
    const renameRecord = runAs('cat no_backup/backup-operations/result.json');
    check(renameRecord.includes('renamed-container:1') && !renameRecord.includes(S2), `(I6 rename) while stopped: the result record holds the rename's code, not the name: ${renameRecord.slice(renameRecord.indexOf('"warnings"'), renameRecord.indexOf('"warnings"') + 80)}`);
    check(!receiptReplies('i6-rename-receipts').includes(S2), '(I6 rename) while stopped: no receipt reply names the project');
    check(holders(S2).every((path) => path.startsWith('files/SQLite/') || path.startsWith('files/snapshots/')), `(I6 rename) while stopped: the name is only in the library and its snapshots: ${holders(S2).join(' ')}`);
    check((await watchStart(() => !hasResult())).found === 'result', '(I6 rename) the start showed its result once');
    // The dropped rule and the skipped entry, stopped right after the commit's reply: the journal entry, the plan, the manifest
    // and the receipt are all on disk.
    const rule = binary(`d1-rule-${run}.zip`, zipSync({ 'tasks.csv': strToU8(`Title,Recurrence\nd1s1a${run},${S1}\n`), [`${S3}.zip`]: zipSync({ 'inner.csv': strToU8('Title\nx') }) }));
    push(rule);
    setProp('journal_stop', 'after:backupDocumentCommit');
    await importPick('mindwtr-csv', rule);
    await confirmQuestion(en['settings.backupMobile.importMindwtrCsvData']);
    await until('the process to end (I6 rule)', () => !pid(), 120_000, 500);
    setProp('journal_stop', '');
    check(journal().length === 1 && operations().length === 1, '(I6 rule) while stopped: the journal entry and its plan are on disk');
    check(receiptReplies('i6-rule-receipts').includes('unsupported-recurrence:1'), '(I6 rule) while stopped: the receipt holds the dropped rule\'s code');
    check(holders(S1).length === 0 && holders(S3).length === 0, `(I6 rule) while stopped: the dropped rule and the skipped entry's name are nowhere on disk: ${[...holders(S1), ...holders(S3)].join(' ')}`);
    check((await watchStart(() => journal().length === 0 && operations().length === 0 && !hasResult())).found === 'result', '(I6 rule) the start replayed and showed the result');
    check(holders(S1).length === 0 && holders(S3).length === 0, '(I6 rule) after the replay too');
    check(![S1, S2, S3].some((sentinel) => allLogs().includes(sentinel)), '(I6) no log line names a sentinel');

    // G3: a seed stopped with its entry on disk, before core saw it: the next start replays it once.
    await freshInstall();
    const g3Created = seededLines('created');
    setProp('journal_stop', 'before:gettingStarted');
    await tap(await gettingStartedRow());
    await until('the process to end (G3)', () => !pid(), 60_000, 500);
    setProp('journal_stop', '');
    await launch();
    await until('(G3) the replay to seed', () => { seeded = starterRows('g3'); return seeded.tasks === 7; }, 60_000, 2_000).catch(() => undefined);
    check(seeded.projects === 1 && seeded.tasks === 7 && seeded.samples === 2, `(G3) the replay seeded once: ${JSON.stringify(seeded)}`);
    check(journal().length === 0 && seededLines('created') === g3Created + 1, '(G3) the journal is empty and the replay logged outcome=created once');

    // G2: a seed stopped right after its COMMIT: the rows and the receipt are in one transaction, so the next start answers from
    // the receipt (gettingStarted:<hash> under the journal's request UUID) and writes and logs nothing.
    await freshInstall();
    const g2Lines = seededLines('created') + seededLines('unchanged');
    setProp('commit_stop', 'gettingStarted');
    await tap(await gettingStartedRow());
    await until('the process to end (G2)', () => !pid(), 60_000, 500);
    setProp('commit_stop', '');
    const requestId = /requestId\\*":\\*"([0-9a-f-]{36})/.exec(runAs("sh -c 'cat files/journal/*.json'"))?.[1] ?? fail('(G2) no journaled request UUID');
    await launch();
    await until('(G2) the journal to empty', () => journal().length === 0, 60_000);
    seeded = starterRows('g2');
    check(seeded.projects === 1 && seeded.tasks === 7 && seeded.samples === 2, `(G2) the seed is there once: ${JSON.stringify(seeded)}`);
    const receipt = sqlite(pullDb('g2-receipt'), `SELECT method FROM native_request_receipts WHERE request_id = '${requestId}'`);
    check(receipt.length === 1 && receipt[0].method.startsWith('gettingStarted:'), `(G2) its receipt is gettingStarted:<hash> under the journal's request UUID: ${JSON.stringify(receipt)}`);
    check(seededLines('created') + seededLines('unchanged') === g2Lines, '(G2) no seed line: the stop came right after COMMIT and the replay answered from the receipt');

    // ---- Pass D1c: larger transfers, a replay whose plan cannot be read, and the size-scaled deadlines ----
    // L1: a share of the limit restored over another, every row multi-byte: each row lands byte for byte, and the new
    // log line names the operation, its sizes and a Java peak far below the file.
    await fresh();
    // A fifth of the limit each: SQLite keeps multi-byte rows with their full-text index, larger than their JSON.
    const share = Math.max(2, Math.floor(limitMiB / 5));
    const l1a = measureFixture(`d1-l1-a-${run}.json`, share, 'emoji', 'd1la');
    const l1b = measureFixture(`d1-l1-b-${run}.json`, share, 'emoji', 'd1lb');
    push(l1a); push(l1b);
    await restore(l1a);
    await toastWith(en['settings.backupMobile.restoreComplete'], 600_000);
    await restore(l1b);
    await toastWith(en['settings.backupMobile.restoreComplete'], 600_000);
    const l1db = pullDb('l1');
    const l1rows = sqlite(l1db, "SELECT title, description FROM tasks WHERE deletedAt IS NULL AND title LIKE 'd1lb%' ORDER BY title");
    const l1expected = [...l1b.tasks].map((item) => ({ title: item.title, description: item.description })).sort((left, right) => (left.title < right.title ? -1 : left.title > right.title ? 1 : 0));
    check(JSON.stringify(l1rows) === JSON.stringify(l1expected), `(L1) every multi-byte row of the restored file is in the library byte for byte (${l1rows.length} of ${l1expected.length})`);
    check(rowsLike('l1-a', 'd1la') === 0, '(L1) the restore replaced the first library');
    const l1line = transfer();
    check(/"operation":"replace"/.test(l1line) && /"outcome":"committed"/.test(l1line) && Number(/"javaPeakMiB":(\d+)/.exec(l1line)?.[1] ?? 999) < 128,
        `(L1) the v1.3.7/native-large-transfer line says replace, committed, a Java peak under 128 MiB: ${l1line.slice(-260)}`);
    sh(`rm -f ${PHONE_DIR}/${l1a.name} ${PHONE_DIR}/${l1b.name}`);

    // R1: a merge stopped right after its COMMIT; the next start's replay cannot read its plan (a debug read failure): the
    // entry stays, nothing shows; the start after answers the first success from the receipt, writes nothing again, and offers Undo.
    await fresh();
    const r1 = fixture(`d1-r1-${run}.json`, [task(`d1r1a${run}`), task(`d1r1b${run}`)]);
    push(r1);
    const committedBefore = allLogs().split('\n').filter((line) => line.includes('v1.3.4/native-backup-document')).length;
    setProp('commit_stop', 'backupDocumentCommit');
    await merge(r1);
    await tap(confirmButton(await waitFor('the question', (current) => Boolean(confirmButton(current)), 120_000)));
    await until('the process to end (R1)', () => !pid(), 120_000, 500);
    setProp('commit_stop', '');
    const receiptsAfterCommit = sqlite(pullDb('r1-commit'), `SELECT count(*) AS n FROM native_request_receipts WHERE method LIKE '["backupDocument","merge",%'`)[0].n;
    check(receiptsAfterCommit === 1 && journal().length === 1, `(R1) the stop came after COMMIT: one receipt, the entry still journaled (${receiptsAfterCommit}, ${journal().length})`);
    setProp('channel_fail', 'read-once');
    // The replay keeps its entry, so this start never resumes normal activation: no Inbox wait.
    device.launch(ACTIVITY);
    await sleep(20_000);
    setProp('channel_fail', '');
    check(journal().length === 1 && !hasText(await screen(), en['settings.mergeBackup']), '(R1) the replay that could not read its plan kept the entry and showed nothing');
    await relaunch();
    const r1toast = await toastWith(en['settings.mergeBackup'], 300_000);
    check(Boolean(undoButton(r1toast)), '(R1) the next start shows the merge\'s result with RN\'s Undo');
    await until('(R1) the journal to empty', () => journal().length === 0, 60_000);
    const receiptsAfterReplay = sqlite(pullDb('r1-replay'), `SELECT count(*) AS n FROM native_request_receipts WHERE method LIKE '["backupDocument","merge",%'`)[0].n;
    const committedAfter = allLogs().split('\n').filter((line) => line.includes('v1.3.4/native-backup-document')).length;
    check(receiptsAfterReplay === 1 && committedAfter === committedBefore && rowsLike('r1-rows', `d1r1`) === 2,
        `(R1) the replay answered from the receipt: one receipt, no second commit line, the two rows once (${receiptsAfterReplay}, ${committedAfter - committedBefore})`);
    sh(`rm -f ${PHONE_DIR}/${r1.name}`);

    console.log('Settings › Data device check passed');
    }
} catch (error) {
    evidenced(error);
    // The app's own log lines (this tag) beside the screen evidence: a refusal's class name shows why an operation stopped.
    try {
        const logFile = resolve(work, `logcat-${run}.txt`);
        writeFileSync(logFile, allLogs());
        console.error(`app log: ${logFile}`);
    } catch { /* evidence only */ }
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    cleanup();
}
