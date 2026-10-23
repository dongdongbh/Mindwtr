// Replay and restart around a sliced sync's local saves (D9b design §7), without a phone: the real native bundle
// (core-host.js) in Node VMs (sync-harness.mjs hostDevice, bound as the Android host binds it, booted as a journaling host)
// on a database file, against a local WebDAV folder.
//
//   node apps/android-native/scripts/build-bundle.mjs
//   node apps/android-native/scripts/check-merge-replay.mjs [scratch dir]       (ONLY=<case id> runs one case)
//
// First a clean cycle: the other device's edits reach the folder and A syncs with nothing else running. It must commit both
// local saves with no requeue: nothing the save-1 publish starts writes through the adapter before save 2. A's store
// subscribers are the phone's: the widget publisher and the reminder planner run on stand-ins for their native bridges.
//
// Then each case. Device A holds a 2,000-task library and a daily task. The other device's edits reach the folder (400 tasks
// retitled, plus a project in an area that does not exist and a task in a project that does not exist: the merge repairs
// both). A syncs, and the sync is held (no timer pumps) at one point: inside its first local save's sliced preparation,
// between that save and the remote write, before its second local save, or after it. There the screens send three journaled
// commands: Done on the daily task (with the revision the view showed), a quick capture (with its capture id), and a General
// setting (with its request UUID; it answers changed:true once, and a replay answers that from its durable receipt, where
// re-running it would answer changed:false). A fault hits the setting's own write:
//   before-receipt  its receipt insert fails (the save rolls back; the store's next save carries it again, and an answer
//                   changed:true must find its receipt on disk), then the journal re-sends it, live or after a restart;
//   after-receipt   the process dies between its receipt insert and its COMMIT, and restarts;
//   after-commit    the process dies right after its COMMIT, before it answers, and restarts;
//   after-ack       it answered; the journal re-sends it anyway (an acknowledgment the journal lost), live, or after a restart.
// A restart opens the same database file, key-value store, secrets and files, boots as StartOrder does, and the journal
// re-sends all three commands before sync starts.
// After A's follow-up cycles and device B's sync, A's database, B's database and the folder hold: every remote edit, the
// capture once, the daily task done once with exactly one next occurrence, both repairs, the setting, no pending remote write;
// the repaired rows keep their revisions over two more cycles (a repair writes once). Exit 0 = pass, 1 = fail.
import { randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { hostDevice, serveWebdav, webdavDocument } from './sync-harness.mjs';

const app = resolve(import.meta.dirname, '..');
const bundle = process.env.MINDWTR_BUNDLE ?? resolve(app, 'android/app/src/main/assets/core-host.js');
const scratch = resolve(process.argv[2] ?? '/home/dd/scratch/native-merge/replay');
const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const PORT = Number(process.env.MINDWTR_MERGE_WEBDAV_PORT ?? 18777);
const USER = `replay${run}`;
const PASSWORD = `pw${run}secret`;
const DAY = 24 * 60 * 60 * 1000;
// Relative to now, so the library never ages into a migration (auto-archive, tombstone purge) between runs.
const AT = new Date(Date.now() - 3 * DAY).toISOString();

const POINTS = [
    { name: 'inside the first local save\'s preparation', step: 'write-local', nth: 1, preparation: true },
    { name: 'between the first local save and the remote write', step: 'write-remote', nth: 1 },
    { name: 'before the second local save', step: 'write-local', nth: 2 },
    { name: 'after the second local save', line: /Sync cycle ran in slices/ },
];
const FAULTS = [
    { name: 'before-receipt', restart: false },
    { name: 'before-receipt', restart: true },
    { name: 'after-receipt', restart: false },
    { name: 'after-receipt', restart: true },
    { name: 'after-commit', restart: true },
    { name: 'after-ack', restart: false },
    { name: 'after-ack', restart: true },
];

let failures = 0;
const startedAt = Date.now();
const check = (ok, message) => {
    if (!ok) failures += 1;
    console.log(`${ok ? 'ok' : 'NOT OK'} - ${message} [${Math.round((Date.now() - startedAt) / 1000)} s]`);
};
const live = (doc) => (doc?.tasks ?? []).filter((task) => !task.deletedAt);
const stepOf = (line) => /Sync step .*"step":"([\w-]+)"/.exec(line)?.[1] ?? null;
const slicesOf = (line) => (/Sync cycle ran in slices (\{.*\})/.exec(line) ? JSON.parse(/Sync cycle ran in slices (\{.*\})/.exec(line)[1]) : null);
const revisionOf = (row) => `${row.rev ?? 0}:${row.revBy ?? ''}:${row.updatedAt}`;
const RECEIPT_INSERT = /^INSERT INTO native_request_receipts/;

const dav = await serveWebdav({ port: PORT, username: USER, password: PASSWORD });
dav.state.files.set('/dav', { dir: true });
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

/** One folder and one device A on disk, joined to it, with B ready; [body] runs the case. */
const withLibrary = async (id, body) => {
    const folder = `/dav/mindwtr-replay-${run}-${id}`;
    const webdav = { url: `http://127.0.0.1:${PORT}${folder}`, username: USER, password: PASSWORD, allowInsecureHttp: true };
    const settings = { ...webdav, password: null };
    const daily = `Daily ${run} ${id}`;
    const put = (doc) => dav.state.files.set(`${folder}/data.json`, { body: Buffer.from(JSON.stringify(doc, null, 2)), etag: `"seed-${randomUUID()}"` });
    dav.state.files.set(folder, { dir: true });
    const tasks = Array.from({ length: 2000 }, (_, i) => ({
        id: `replay-${i}`, title: `Task ${i}`, status: ['inbox', 'next', 'waiting', 'someday'][i % 4], tags: [`#t${i % 7}`], contexts: [`@c${i % 4}`],
        createdAt: AT, updatedAt: AT, rev: 1, revBy: 'seed',
    }));
    tasks.push({ id: `daily-${id}`, title: daily, status: 'inbox', tags: [], contexts: [], recurrence: { rule: 'daily', strategy: 'strict' },
        dueDate: new Date(Date.now() + DAY).toISOString(), createdAt: AT, updatedAt: AT, rev: 1, revBy: 'seed' });
    put({ tasks, projects: [], sections: [], areas: [], people: [], settings: {} });

    // A's process: its database file, RKStorage, secrets and files outlive it.
    const disk = { database: resolve(scratch, `${id}.db`), filesRoot: resolve(scratch, `${id}-files`), keyValue: new Map(), secrets: new Map() };
    mkdirSync(disk.filesRoot, { recursive: true });
    const seen = { steps: [], lines: [], sections: [], prepareSlices: 0, watch: null, sql: null };
    const log = (line) => {
        seen.lines.push(line);
        if (/Sync failed/i.test(line)) console.log(`note - ${line.slice(0, 200)}`);
        const step = stepOf(line);
        if (step) seen.steps.push(step);
        seen.watch?.(line, step);
    };
    const start = async (beforeSync = async () => {}) => {
        const device = await hostDevice({
            bundle, name: `A${id}`, log, ...disk, nativeSubscribers: true,
            trace: (section) => {
                if (section) seen.sections.push(section);
                if (section === 'sync:prepareSave') seen.prepareSlices += 1;
            },
            onSql: (sql, phase, json) => seen.sql?.(sql, phase, json),
        });
        await device.call('boot', '', '', 'journaled');
        await beforeSync(device);
        // The phone's StartOrder starts the reminder subscriber before sync; the widget publisher started at boot.
        await device.call('remindersStart');
        await device.call('language', 'en', 'en-US');
        await device.call('syncNetwork', JSON.stringify({ isConnected: true, isInternetReachable: true }));
        await device.call('syncStart', 'active');
        return device;
    };
    const ctx = { id, folder, webdav, settings, daily, put, seen, start, a: await start(), b: await hostDevice({ bundle, name: `B${id}`, log: () => {} }) };
    try {
        await ctx.a.configure('webdav', webdav);
        await ctx.a.syncNow('webdav', settings);
        check(ctx.a.tasks().length >= 2001, `${id}: A joined the folder (${ctx.a.tasks().length} tasks)`);
        await body(ctx);
    } catch (error) {
        check(false, `${id}: stopped: ${error.stack ?? error}`);
    } finally {
        try { ctx.a.stop(); } catch { /* killed */ }
        ctx.b.stop();
    }
};

/** The other device's edits, with two references the merge must repair. */
const remoteEdits = (ctx) => {
    const doc = webdavDocument(dav, ctx.folder);
    for (const task of live(doc).filter((row) => row.id.startsWith('replay-')).slice(0, 400)) {
        task.title = `${task.title} (remote)`;
        task.rev = (task.rev ?? 0) + 1;
        task.revBy = 'remote';
        task.updatedAt = new Date().toISOString();
    }
    const now = new Date().toISOString();
    doc.projects.push({ id: `fix-project-${ctx.id}`, title: `Fix project ${ctx.id}`, status: 'active', color: '#888888', order: 0, tagIds: [],
        areaId: `gone-area-${ctx.id}`, createdAt: now, updatedAt: now, rev: 1, revBy: 'remote' });
    doc.tasks.push({ id: `fix-task-${ctx.id}`, title: `Fix task ${ctx.id}`, status: 'next', tags: [], contexts: [], projectId: `gone-project-${ctx.id}`,
        createdAt: now, updatedAt: now, rev: 1, revBy: 'remote' });
    ctx.put(doc);
};

const cleanCycle = () => withLibrary('clean', async (ctx) => {
    remoteEdits(ctx);
    const from = ctx.seen.lines.length;
    await ctx.a.syncNow('webdav', ctx.settings);
    const lines = ctx.seen.lines.slice(from).map(slicesOf).filter(Boolean);
    check(lines.length === 1, `clean: one sliced cycle (${lines.length})`);
    const [cycle] = lines;
    check(cycle?.requeue === 'none' && /^prepared(,prepared)+$/.test(cycle?.storePublish ?? ''),
        `clean: both local saves committed with their prepared publish and no requeue: no store subscriber wrote through the adapter between them (${JSON.stringify(cycle)})`);
    check(Number(cycle?.slices) > 10, `clean: the cycle gave the engine back (${cycle?.slices} slices, longest ${cycle?.longestSliceMs} ms)`);
    // The phone's store subscribers ran: the widget publisher and the reminder planner published from this cycle's store.
    const kinds = new Set(ctx.a.published.map(([kind]) => kind));
    check(kinds.has('widget') && kinds.has('alarms') && Number(cycle?.storeListeners) > 2,
        `clean: the widget and reminder subscribers were live (${[...kinds].join(', ')}; ${cycle?.storeListeners} store listeners)`);
});

const runCase = (point, fault) => withLibrary(caseId(point, fault), async (ctx) => {
    const label = `${ctx.id} ${point.name}, ${fault.name}, ${fault.restart ? 'restart' : 'live'}`;
    const { seen, settings, daily, id } = ctx;
    remoteEdits(ctx);

    const [dailyRow] = ctx.a.query('SELECT rev, revBy, updatedAt FROM tasks WHERE id = ?', `daily-${id}`);
    const dailyRevision = revisionOf(dailyRow);
    const capture = `Captured ${run} ${id}`;
    const opened = await ctx.a.call('captureOpen');
    const captureInput = JSON.stringify({ text: capture, options: opened.options, captureId: randomUUID(), openAfterSave: false });
    const settingRequest = randomUUID();
    const settingInput = JSON.stringify({ requestId: settingRequest, edit: { type: 'showTaskAge', value: true } });
    const sendSetting = (device) => device.call('menuCommand', 'generalSetting', settingInput).then((value) => ({ value }), (error) => ({ error: String(error.message ?? error) }));
    const sendTasks = (device) => Promise.all([device.call('complete', `daily-${id}`, dailyRevision), device.call('captureSubmit', captureInput)]);

    // A's sync, held at the point.
    let held = null;
    const reached = new Promise((done) => {
        const base = seen.steps.filter((s) => s === point.step).length;
        seen.watch = (line, step) => {
            const hit = point.step ? step === point.step && seen.steps.filter((s) => s === point.step).length - base === point.nth : point.line.test(line);
            if (!hit) return;
            seen.watch = null;
            setImmediate(() => { ctx.a.freeze(); held = seen.steps.at(-1); done(); });
        };
    });
    seen.prepareSlices = 0;
    const documentWrites = () => dav.state.requests.filter((request) => request === `PUT ${ctx.folder}/data.json`).length;
    const writesBefore = documentWrites();
    const sectionsBefore = seen.sections.length;
    const syncing = ctx.a.syncNow('webdav', settings).catch((error) => ({ stopped: String(error.message ?? error) }));
    await Promise.race([reached, syncing]);
    check(held !== null, `${label}: the sync reached the point (last step ${held ?? seen.steps.at(-1)})`);
    if (held === null) return;
    // Not past it: before the remote write nothing is written to the folder; before save 2 the folder holds the write.
    const remoteWritten = documentWrites() - writesBefore;
    check(point.name.includes('remote write') || point.name.includes('preparation') ? remoteWritten === 0 : remoteWritten === 1,
        `${label}: the hold is where it should be (${remoteWritten} document writes)`);
    if (point.preparation) {
        // Into the save's sliced preparation, one pump turn at a time: the commands land between its slices, before its gate.
        let inside = false;
        for (let turn = 0; turn < 2000; turn += 1) {
            if (seen.prepareSlices > 0 && !ctx.a.inTransaction()) { inside = true; break; }
            ctx.a.pumpOnce();
            await new Promise((done) => setImmediate(done));
        }
        const gated = seen.sections.slice(sectionsBefore).includes('sync:commitPublish');
        check(inside && !gated, `${label}: the commands land inside the save's sliced preparation, before its gate (after ${seen.prepareSlices} slices)`);
    }

    // The setting's own write meets the fault.
    let receiptSeen = false;
    let commitSeen = false;
    seen.sql = (sql, phase, json) => {
        if (RECEIPT_INSERT.test(sql) && phase === 'before' && json.includes(settingRequest)) {
            receiptSeen = true;
            if (fault.name === 'before-receipt') { seen.sql = null; return 'fail'; }
            return undefined;
        }
        if (!receiptSeen) return undefined;
        if (fault.name === 'after-receipt' && phase === 'before') { seen.sql = null; return fault.restart ? 'kill' : 'fail'; }
        if (fault.name === 'after-commit' && sql === 'COMMIT' && phase === 'after') { commitSeen = true; seen.sql = null; return 'kill'; }
        return undefined;
    };
    const tasksFirst = sendTasks(ctx.a).catch(() => null);
    const firstSetting = await sendSetting(ctx.a);
    seen.sql = null;
    check(receiptSeen && (fault.name !== 'after-commit' || commitSeen), `${label}: the setting's write reached the fault`);
    // A failed receipt insert rolls the save back; the store's next save carries the receipt again. Either way an answer
    // changed:true comes only once its receipt is durable.
    if (!fault.restart || fault.name === 'after-ack') {
        // The same connection: no transaction may be open, or the read could see uncommitted rows.
        const durable = !ctx.a.inTransaction()
            && ctx.a.query('SELECT request_id FROM native_request_receipts WHERE request_id = ?', settingRequest).length === 1;
        check(firstSetting.value?.changed === true ? durable : Boolean(firstSetting.error),
            `${label}: the setting answered ${JSON.stringify(firstSetting)} with its receipt ${durable ? 'durable' : 'not on disk'}`);
    }
    if (fault.name === 'after-ack') check(firstSetting.value?.changed === true, `${label}: the setting answered changed:true`);
    if (!fault.restart) {
        // A command whose save failed waits for the store's retry, which needs the timer pump.
        const heldAt = seen.lines.length;
        ctx.a.thaw();
        const firstTasks = await tasksFirst;
        const replay = await sendSetting(ctx.a);
        check(replay.value?.changed === true, `${label}: the journal's re-sent setting answered changed:true (${JSON.stringify(replay)})`);
        const replayTasks = await sendTasks(ctx.a);
        check(replayTasks.every(Boolean), `${label}: the journal's re-sent Done and capture answered`);
        if (firstTasks) check(JSON.stringify(replayTasks) === JSON.stringify(firstTasks), `${label}: they answered their first replies again`);
        await syncing;
        if (point.step) {
            const requeue = seen.lines.slice(heldAt).map(slicesOf).find(Boolean)?.requeue;
            check(requeue === 'local-data-changed' || requeue === 'stale-db', `${label}: the held cycle requeued quietly for the commands (${requeue})`);
        }
    } else {
        ctx.a.kill();
        await syncing;
        // StartOrder: load, then the journal's replay, then sync.
        ctx.a = await ctx.start(async (device) => {
            const replay = await sendSetting(device);
            check(replay.value?.changed === true, `${label}: after the restart the journal's re-sent setting answered changed:true (${JSON.stringify(replay)})`);
            check((await sendTasks(device)).every(Boolean), `${label}: after the restart the journal's re-sent Done and capture answered`);
        });
        await ctx.a.sync('openSyncSettings');
        // The dead process's remote fence stays until its heartbeat is overdue; then the restarted A takes it over.
        const since = Date.now();
        let took = false;
        while (Date.now() - since < 180_000) {
            const result = JSON.stringify(await ctx.a.syncNow('webdav', settings));
            if (!result.includes('holding this sync location')) { took = true; break; }
            await sleep(5_000);
        }
        check(took, `${label}: the restarted A took over the dead process's sync fence (${Math.round((Date.now() - since) / 1000)} s)`);
    }

    // A's follow-up cycles (a requeue asks for another after a quiet period), then B, then A.
    for (let i = 0; i < 3; i += 1) {
        await ctx.a.syncNow('webdav', settings);
        await sleep(2_500);
    }
    await ctx.a.syncNow('webdav', settings);
    await ctx.b.boot();
    await ctx.b.configure('webdav', ctx.webdav);
    await ctx.b.syncNow('webdav', settings);
    await ctx.a.syncNow('webdav', settings);

    const remote = live(webdavDocument(dav, ctx.folder));
    const remoteAll = webdavDocument(dav, ctx.folder);
    const holders = [['A', ctx.a.query("SELECT id, title, status, projectId FROM tasks WHERE COALESCE(deletedAt, '') = ''")],
        ['B', ctx.b.query("SELECT id, title, status, projectId FROM tasks WHERE COALESCE(deletedAt, '') = ''")], ['the folder', remote]];
    for (const [who, rows] of holders) {
        const named = (title) => rows.filter((row) => row.title === title);
        check(rows.filter((row) => row.title.endsWith(' (remote)')).length === 400, `${label}: ${who} holds every remote edit`);
        check(named(capture).length === 1, `${label}: ${who} holds the capture once (${named(capture).length})`);
        const statuses = named(daily).map((row) => row.status).sort();
        check(statuses.length === 2 && statuses.filter((s) => s === 'done').length === 1,
            `${label}: ${who} holds the daily task done once with one next occurrence (${statuses.join(', ')})`);
        check(rows.some((row) => row.id === `fix-task-${id}` && !row.projectId), `${label}: ${who} holds the repaired task (no missing project)`);
    }
    const projectOf = (rows) => rows.find((row) => row.id === `fix-project-${id}`);
    check(!projectOf(ctx.a.query('SELECT id, areaId FROM projects'))?.areaId && projectOf(remoteAll.projects) && !projectOf(remoteAll.projects).areaId,
        `${label}: A and the folder hold the repaired project (no missing area)`);
    const settingsA = JSON.parse(ctx.a.query('SELECT data FROM settings')[0]?.data ?? '{}');
    check(settingsA.appearance?.showTaskAge === true || settingsA.showTaskAge === true || JSON.stringify(settingsA).includes('"showTaskAge":true'),
        `${label}: A stores the setting`);
    check(!settingsA.pendingRemoteWriteAt, `${label}: A holds no pending remote write (${settingsA.pendingRemoteWriteAt ?? 'none'})`);
    const repairRevisions = () => [
        revisionOf(ctx.a.query('SELECT rev, revBy, updatedAt FROM tasks WHERE id = ?', `fix-task-${id}`)[0]),
        revisionOf(ctx.a.query('SELECT rev, revBy, updatedAt FROM projects WHERE id = ?', `fix-project-${id}`)[0]),
    ].join(' ');
    const before = repairRevisions();
    await ctx.a.syncNow('webdav', settings);
    await ctx.b.syncNow('webdav', settings);
    await ctx.a.syncNow('webdav', settings);
    check(repairRevisions() === before, `${label}: the repaired rows keep their revisions over more cycles (${before})`);
    const [rowsA, rowsB] = [ctx.a.tasks(), ctx.b.tasks()];
    check(JSON.stringify(rowsA) === JSON.stringify(rowsB), `${label}: A's and B's databases hold the same live tasks (${rowsA.length} rows)`);
    const failed = seen.lines.filter((line) => /Sync failed|Incomplete \w+ load|SQLITE_BUSY/.test(line));
    check(failed.length === 0, `${label}: A logged no failed sync, before or after a restart (${failed.length})`);
});

const caseId = (point, fault) => `${POINTS.indexOf(point)}${fault.name.slice(0, 2)}${fault.name.split('-')[1][0]}${fault.restart ? 'r' : 'l'}`;
const ids = ['clean', ...POINTS.flatMap((point) => FAULTS.map((fault) => caseId(point, fault)))];
if (process.env.ONLY && !ids.includes(process.env.ONLY)) {
    console.error(`ONLY=${process.env.ONLY} names no case; the cases are: ${ids.join(' ')}`);
    process.exit(2);
}
try {
    if (!process.env.ONLY || process.env.ONLY === 'clean') await cleanCycle();
    for (const point of POINTS) for (const fault of FAULTS) {
        if (process.env.ONLY && process.env.ONLY !== caseId(point, fault)) continue;
        await runCase(point, fault);
    }
} finally {
    await dav.close();
}
console.log(failures ? `Merge replay check: ${failures} failed` : 'Merge replay check passed');
process.exit(failures ? 1 : 0);
