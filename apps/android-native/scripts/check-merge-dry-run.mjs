// Commands during a sync merge (D9), without a phone: the real native bundle (core-host.js) as two devices in Node VMs
// (sync-harness.mjs hostDevice, bound as the Android host binds it) against a local WebDAV folder.
//
//   node apps/android-native/scripts/build-bundle.mjs
//   node apps/android-native/scripts/check-merge-dry-run.mjs [rounds=3]
//
// Device A holds a 2,000-task library. Each round the other device's edits reach the folder (400 tasks retitled), A syncs,
// and while that sync runs A's screens send commands while it waits on the network: a quick capture, the same capture again with the
// same capture id (a retry), and Done on a daily task. After A's follow-up cycles and device B's sync, every device and
// the folder hold: every remote edit, each capture exactly once, the daily task done once with exactly one next occurrence,
// and the same library on both devices. Exit 0 = pass, 1 = fail.
import { randomInt, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { hostDevice, serveWebdav, webdavDocument } from './sync-harness.mjs';

const app = resolve(import.meta.dirname, '..');
const bundle = process.env.MINDWTR_BUNDLE ?? resolve(app, 'android/app/src/main/assets/core-host.js');
const rounds = Number(process.argv[2] ?? 3);
const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const PORT = Number(process.env.MINDWTR_MERGE_WEBDAV_PORT ?? 18776);
const FOLDER = `/dav/mindwtr-merge-${run}`;
const USER = `merge${run}`;
const PASSWORD = `pw${run}secret`;
const webdav = { url: `http://127.0.0.1:${PORT}${FOLDER}`, username: USER, password: PASSWORD, allowInsecureHttp: true };
const AT = '2026-01-01T00:00:00.000Z';
const DAILY = `Daily ${run}`;

let failures = 0;
const check = (ok, message) => {
    if (!ok) failures += 1;
    console.log(`${ok ? 'ok' : 'NOT OK'} - ${message}`);
};
const live = (doc) => (doc?.tasks ?? []).filter((task) => !task.deletedAt);

const dav = await serveWebdav({ port: PORT, username: USER, password: PASSWORD });
// The library, as another device wrote it: 2,000 tasks and one daily task in the Inbox.
const tasks = Array.from({ length: 2000 }, (_, i) => ({
    id: `merge-${i}`, title: `Task ${i}`, status: ['inbox', 'next', 'waiting', 'someday'][i % 4], tags: [`#t${i % 7}`], contexts: [`@c${i % 4}`],
    createdAt: AT, updatedAt: AT, rev: 1, revBy: 'seed',
}));
tasks.push({ id: `daily-${run}`, title: DAILY, status: 'inbox', tags: [], contexts: [], recurrence: { rule: 'daily', strategy: 'strict' },
    dueDate: '2026-01-02T09:00:00.000Z', createdAt: AT, updatedAt: AT, rev: 1, revBy: 'seed' });
const put = (doc) => dav.state.files.set(`${FOLDER}/data.json`, { body: Buffer.from(JSON.stringify(doc, null, 2)), etag: `"seed-${randomUUID()}"` });
dav.state.files.set('/dav', { dir: true });
dav.state.files.set(FOLDER, { dir: true });
put({ tasks, projects: [], sections: [], areas: [], people: [], settings: {} });

const log = (line) => { if (/Sync failed|error/i.test(line)) console.log(`note - ${line.slice(0, 200)}`); };
const a = await hostDevice({ bundle, name: 'A', log });
const b = await hostDevice({ bundle, name: 'B', log });
const captured = [];
try {
    await a.boot();
    await b.boot();
    await a.configure('webdav', webdav);
    await a.syncNow('webdav', { ...webdav, password: null });
    check(live(webdavDocument(dav, FOLDER)).length >= 2001 && a.tasks().length >= 2001, `A joined the folder and holds the library (${a.tasks().length} tasks)`);
    check(a.lines.some((line) => line.includes('[sync] Sync step')), 'A syncs');
    let completed = false;
    for (let round = 1; round <= rounds; round += 1) {
        // The other device's edits.
        const doc = webdavDocument(dav, FOLDER);
        for (const task of live(doc).filter((row) => row.id.startsWith('merge-')).slice(0, 400)) {
            task.title = `${task.title.replace(/ \(remote \d+\)$/, '')} (remote ${round})`;
            task.rev = (task.rev ?? 0) + 1;
            task.revBy = 'remote';
            task.updatedAt = new Date().toISOString();
        }
        put(doc);
        // A's sync, and A's screens while it runs.
        const linesBefore = a.lines.length;
        let syncing = true;
        const syncing$ = a.syncNow('webdav', { ...webdav, password: null }).finally(() => { syncing = false; });
        const during = [];
        await sleep(20 + randomInt(80));
        if (!completed) {
            await a.call('complete', `daily-${run}`, '');
            completed = true;
            during.push(syncing);
        }
        const title = `Captured ${run} ${round}`;
        const opened = await a.call('captureOpen');
        const input = JSON.stringify({ text: title, options: opened.options, captureId: randomUUID(), openAfterSave: false });
        await a.call('captureSubmit', input);
        during.push(syncing);
        await a.call('captureSubmit', input);
        during.push(syncing);
        captured.push(title);
        await syncing$;
        check(during.some(Boolean), `round ${round}: commands answered while the sync ran (${during.map((d) => (d ? 'during' : 'after')).join(', ')})`);
        check(a.lines.slice(linesBefore).some((line) => line.includes('Sync step')), `round ${round}: A synced`);
    }
    // A's follow-up cycles (a local edit aborts a cycle and asks for another), then B.
    for (let i = 0; i < 6; i += 1) {
        await a.syncNow('webdav', { ...webdav, password: null });
        await sleep(200);
    }
    await b.configure('webdav', webdav);
    await b.syncNow('webdav', { ...webdav, password: null });
    await a.syncNow('webdav', { ...webdav, password: null });
    const remote = live(webdavDocument(dav, FOLDER));
    const byTitle = (title) => remote.filter((task) => task.title === title);
    check(remote.filter((task) => task.title.endsWith(` (remote ${rounds})`)).length === 400, 'the folder holds every remote edit of the last round');
    for (const title of captured) check(byTitle(title).length === 1, `"${title}" is in the folder exactly once (its retry stored nothing)`);
    const daily = byTitle(DAILY);
    check(daily.filter((task) => task.status === 'done').length === 1 && daily.filter((task) => task.status !== 'done').length === 1,
        `the daily task is done once, with exactly one next occurrence (${daily.map((task) => task.status).join(', ')})`);
    // A capture during the sync's read is a later write, never a failed read.
    const failedReads = a.lines.filter((line) => /Incomplete \w+ load/.test(line));
    check(failedReads.length === 0, `no read failed for a write during the sync (${failedReads.length} "Incomplete … load")`);
    const [rowsA, rowsB] = [a.tasks(), b.tasks()];
    check(JSON.stringify(rowsA) === JSON.stringify(rowsB), `A's and B's databases hold the same live tasks (${rowsA.length} rows)`);
    for (const title of captured) check(rowsA.filter((row) => row.title === title).length === 1, `A's database holds "${title}" once`);
} catch (error) {
    check(false, `stopped: ${error.stack ?? error}`);
} finally {
    a.stop();
    b.stop();
    await dav.close();
}
console.log(failures ? `Merge dry run: ${failures} failed` : 'Merge dry run passed');
process.exit(failures ? 1 : 0);
