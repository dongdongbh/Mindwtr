// Background sync check for the isolated native Android development app (pass S4a): the scheduled sync job and a capture made
// while the app is closed, against a local WebDAV folder on this computer.
//
//   node apps/android-native/scripts/check-bgsync-device.mjs <adb-serial> [apk]
//
// Starts a WebDAV folder (sync-harness.mjs serveWebdav) on 127.0.0.1, maps the phone's port to it (`adb reverse`), and runs a
// second device on this computer (the same native bundle in a Node VM). Then:
//   (1) WebDAV set up through Settings › Sync; core's decision schedules the background job once: one unfinished job under
//       its name in WorkManager's database, 15 minutes out, network required; a resume reconciles it and still leaves one;
//       RN's worker (EXPO_BACKGROUND_WORKER) has none;
//   (2) the app closed (its process killed, never force-stopped), the second device writes a task; JobScheduler runs the job
//       (`cmd jobscheduler run -f`): core's run ("Mobile background sync started", then "finished" with outcome success) brings
//       the task into the phone's database with no screen and no foreground trigger, and the job queues its next run;
//   (3) a capture intent while the app is closed: the capture job stores it and sends it, the folder holds it before the job
//       reports success (its "finished" line comes first);
//   (3b) a capture while a scheduled run is still syncing with a slow server (every answer 25 s): the capture is in the phone's
//       database within 15 s, before that run ends; the capture job ends only after the uploads settle;
//   (4) the server down (503): a closed-app capture stays on the phone, core records the failure, nothing reaches the server;
//       a forced scheduled run inside the cooldown is skipped ("skipped during failure cooldown") and sends no request; the job
//       stays queued; the server back, the next capture's run uploads both and clears the failure record;
//   (5) a slow server (every answer 25 s) with the debug deadline at 15 s (`debug.mindwtr.native.bgsync_deadline_ms`): the run is
//       abandoned at its deadline (core's line, deadlineMs 15000), the job ends, nothing was written;
//   (6) Sync set Off: the job is cancelled;
//   (7) both channels (D8) install over each other and boot: the FOSS build offers only core's local OpenAI-compatible AI
//       provider (Settings › Advanced › AI, as RN's FOSS build), the Play build offers Gemini too; the Play build is left installed.
// Capture intents use a test token written to the capture intent's config while the app is closed (check-runner-device.mjs
// covers the card that makes it); it is deleted at the end. It installs with `install -r`, touches only the development package,
// never launches over another app, and on exit removes the port mapping, stops the server, clears its debug properties and
// leaves the phone on its home screen. Exit 0 = pass, 1 = fail, 2 = refused, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { check, connect, evidenced, fail, inboxCount, inEditor, linesAfter, logStamp, Stopped, switchOn, tab, tabSelected, tagged, withDescription } from './device.mjs';
import { cleanupOnExit } from './check-net-device.mjs';
import { hostDevice, serveWebdav, webdavDocument } from './sync-harness.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-bgsync-device.mjs <adb-serial> [apk]');
    process.exit(2);
}
const app = resolve(import.meta.dirname, '..');
const repo = resolve(app, '../..');
const apk = apkArg ?? resolve(app, 'android/app/build/outputs/apk/play/debug/app-play-debug.apk');
const bundle = resolve(app, 'android/app/src/main/assets/core-host.js');
const adbBin = process.env.ADB ?? '/home/dd/Android/Sdk/platform-tools/adb';
const aapt2 = process.env.AAPT2 ?? '/home/dd/Android/Sdk/build-tools/36.1.0/aapt2';
const PKG = 'tech.dongdongbh.mindwtr.nativeclient.dev';
const apkPackage = execFileSync(aapt2, ['dump', 'packagename', apk], { encoding: 'utf8' }).trim();
if (apkPackage !== PKG) {
    console.error(`REFUSED: ${apk} is package "${apkPackage}", not ${PKG}`);
    process.exit(2);
}
const ACTIVITY = `${PKG}/${PKG}.MainActivity`;
const CAPTURE = `${PKG}/tech.dongdongbh.mindwtr.androidwidget.CaptureIntentReceiver`;
const TAG = 'MindwtrNativeDev';
const UI_FILE = '/data/local/tmp/mindwtr-native-dev-ui.xml';
const DB = 'mindwtr-native-dev.db';
const CONFIG = 'no_backup/android-capture-intent.json';
const SYNC_WORK = 'mindwtr-core-background-sync';
const RN_WORK = 'EXPO_BACKGROUND_WORKER';
const PROPS = ['bgsync_deadline_ms', 'core_work_delay_ms'];
const work = resolve(app, 'android/build/bgsync-check');
const { en } = await import(resolve(repo, 'packages/core/src/i18n/locales/en.ts'));

// This run's names: digits only for what the phone types (the keyboard guard allows only an English layout).
const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const PORT = Number(process.env.MINDWTR_BGSYNC_WEBDAV_PORT ?? 18781);
const FOLDER = `/dav/mindwtr-bgsync-${run}`;
const USER = `native${run}`;
const PASSWORD = `pw${run}secret`;
const TOKEN = randomBytes(32).toString('hex');
const fields = { url: `http://127.0.0.1:${PORT}${FOLDER}`, username: USER, password: PASSWORD, allowInsecureHttp: true };
const title = (digit) => `84${run}${digit}`;

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting } = device;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
const runAs = (command) => sh(`run-as ${PKG} sh -c '${command}'`);
/** Every line of the app's tag since this check began, from any of its processes (a job runs in a process of its own). */
const allLogs = () => execFileSync(adbBin, ['-s', serial, 'logcat', '-d', '-s', `${TAG}:*`], { encoding: 'utf8', maxBuffer: 64 << 20 }).replace(/\\/g, '');
const count = (text, ...needles) => text.split('\n').filter((line) => needles.every((needle) => line.includes(needle))).length;

// ---- The phone's storage (run-as copies, read on this computer) ----
const pullFile = (remote, name) => {
    const dir = resolve(work, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const base = remote.split('/').pop();
    const folder = remote.slice(0, remote.length - base.length - 1);
    const present = runAs(`ls ${folder} 2>/dev/null || true`).split(/\s+/);
    // No -shm: the live process's index can name WAL frames this copy's -wal does not hold; without it, SQLite rebuilds it.
    for (const suffix of ['', '-wal', '-journal']) if (present.includes(`${base}${suffix}`)) device.pull(`${remote}${suffix}`, resolve(dir, `${base}${suffix}`));
    return resolve(dir, base);
};
const sqlite = (file, sql) => {
    const out = execFileSync('sqlite3', ['-json', file, sql], { encoding: 'utf8' }).trim();
    return out ? JSON.parse(out) : [];
};
const phoneTitles = () => sqlite(pullFile(`files/${DB}`, 'db'), 'SELECT title FROM tasks WHERE deletedAt IS NULL').map((row) => row.title);
const rkKey = (key) => sqlite(pullFile('databases/RKStorage', 'rk'), `SELECT value FROM catalystLocalStorage WHERE key = '${key}'`)[0]?.value ?? null;
const failureRecord = () => JSON.parse(rkKey('@mindwtr_background_sync_failure_state_v1') ?? 'null');
/** WorkManager's unfinished work under [name] (states ENQUEUED 0, RUNNING 1, BLOCKED 4), with its JobScheduler id. */
const unfinished = (name) => sqlite(pullFile('no_backup/androidx.work.workdb', 'workdb'),
    `SELECT s.id, s.state, s.initial_delay AS delay, s.required_network_type AS network, i.system_id AS job FROM WorkName n
     JOIN WorkSpec s ON s.id = n.work_spec_id LEFT JOIN SystemIdInfo i ON i.work_spec_id = s.id
     WHERE n.name = '${name}' AND s.state IN (0, 1, 4)`);
const serverTitles = () => (webdavDocument(dav, FOLDER)?.tasks ?? []).filter((task) => !task.deletedAt).map((task) => task.title);
// Only this run's folder counts: another app on the phone (step 0's or the merge bench's package, its sync still pointed at
// 127.0.0.1:18781) reaches this server through the same adb reverse.
const ownRequests = () => dav.state.requests.filter((request) => {
    const path = request.slice(request.indexOf(' ') + 1);
    return path === FOLDER || path.startsWith(`${FOLDER}/`);
});
const puts = () => ownRequests().filter((request) => request.startsWith('PUT')).length;

// ---- Process, broadcasts and the job ----
/** The app's process gone, as after the system reclaimed it: a signal, never a force-stop (that cancels the app's scheduled work). */
const killApp = async () => {
    if (front().includes(`${PKG}/`)) sh('input keyevent KEYCODE_HOME');
    for (let attempt = 0; attempt < 20 && pid(); attempt += 1) {
        try { runAs(`kill -9 ${pid()}`); } catch { /* gone meanwhile */ }
        await sleep(500);
    }
    if (pid()) fail('the app process did not end');
};
const captureIntent = (text) => Number(/result=(-?\d+)/.exec(sh(`am broadcast -n ${CAPTURE} -a tech.dongdongbh.mindwtr.action.CAPTURE --es text '${text}' --es token '${TOKEN}'`))?.[1]);
const until = async (description, holds, timeoutMs = 120_000, everyMs = 2_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await holds();
        if (value) return value;
        if (Date.now() > deadline) fail(`timed out waiting for ${description}`);
        await sleep(everyMs);
    }
};
const RUN_STARTED = 'Mobile background sync started';
const RUN_FINISHED = 'Mobile background sync finished';
const SYNC_JOB = ['Native Android core work', '"job":"backgroundSync"'];
const INGEST_JOB = ['Native Android core work', '"job":"ingest"', '"outcome":"success"'];
/**
 * The scheduled job run now by JobScheduler, the app closed: its JobScheduler id from WorkManager's database (a process start
 * may move it to a new id, so it is read again and forced again until core's run starts). Resolves to the log once the job ended.
 */
const forceSyncJob = async (step) => {
    const jobsBefore = count(allLogs(), ...SYNC_JOB);
    const startedBefore = count(allLogs(), RUN_STARTED) + count(allLogs(), 'skipped during failure cooldown');
    await until(`${step}: JobScheduler to run the sync job`, async () => {
        const [queued] = unfinished(SYNC_WORK);
        if (!queued?.job && queued?.job !== 0) return false;
        console.log(`info - ${step}: cmd jobscheduler run -f ${PKG} ${queued.job}: ${sh(`cmd jobscheduler run -f ${PKG} ${queued.job}`)}`);
        await sleep(4_000);
        return count(allLogs(), RUN_STARTED) + count(allLogs(), 'skipped during failure cooldown') > startedBefore;
    }, 90_000, 1_000);
    await until(`${step}: the sync job to end`, () => count(allLogs(), ...SYNC_JOB) > jobsBefore, 300_000, 2_000);
    return allLogs();
};
/** The lines of the last process that logged [needle] (a job's own process). */
const processOf = (text, needle) => {
    const line = text.split('\n').filter((entry) => entry.includes(needle)).at(-1) ?? '';
    const processId = /^\S+\s+\S+\s+(\d+)/.exec(line)?.[1];
    return processId ? text.split('\n').filter((entry) => new RegExp(`^\\S+\\s+\\S+\\s+${processId}\\s`).test(entry)) : [];
};

// ---- Settings › Sync (core's English), as check-sync-device.mjs drives it ----
const sheetOpen = (nodes) => Boolean(tagged(nodes, 'more-sheet'));
const onSync = (nodes) => Boolean(tagged(nodes, 'settings-sync'));
const onInbox = (nodes) => !tagged(nodes, 'quick-capture') && !tagged(nodes, 'menu-screen') && !tagged(nodes, 'global-search') && !inEditor(nodes)
    && tabSelected(nodes, en['tab.inbox']) && Number.isFinite(inboxCount(nodes));
const withPrefix = (nodes, prefix) => nodes.find((node) => (node['content-desc'] ?? '').startsWith(prefix));
const hideKeyboard = async () => {
    if (!/mInputShown=true/.test(sh('dumpsys input_method'))) return;
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await sleep(600);
};
const toTabs = async () => {
    for (let step = 0; step < 8; step += 1) {
        const nodes = await screen();
        if (tab(nodes, en['tab.menu']) && !tagged(nodes, 'menu-screen') && !sheetOpen(nodes) && !inEditor(nodes) && !tagged(nodes, 'quick-capture')) return nodes;
        await hideKeyboard();
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(1000);
    }
    return fail('the tabs did not come back');
};
const reveal = (find, description) => device.revealNode(find, description);
const openSync = async () => {
    const nodes = await screen();
    if (onSync(nodes)) return nodes;
    let current = await toTabs();
    current = await tapExpecting(tab(current, en['tab.menu']) ?? fail('no Menu tab'), sheetOpen, 'the More sheet');
    await tapExpecting(withDescription(await device.settle(current), en['nav.settings']) ?? fail('no Settings tile'),
        (next) => Boolean(tagged(next, 'settings-main')), 'Settings');
    return tapExpecting(await reveal((next) => withPrefix(next, `${en['settings.sync']}. `), 'Sync row'), onSync, 'Settings › Sync', 30_000);
};
const fill = async (tag, text) => {
    await tap(await reveal((current) => tagged(current, tag), tag));
    await sleep(300);
    requireAppFront();
    sh('input keycombination KEYCODE_CTRL_LEFT KEYCODE_A');
    sh('input keyevent KEYCODE_DEL');
    sh(`input text '${text}'`);
    await sleep(500);
};
const tapTag = async (tag, expected, description, timeoutMs = 30_000) => {
    await hideKeyboard();
    return tapExpecting(await reveal((current) => tagged(current, tag), tag), expected, description, timeoutMs);
};
const insecureOn = async () => {
    const label = en['settings.allowInsecureHttp'];
    await hideKeyboard();
    const node = await reveal((current) => withDescription(current, label), 'Allow insecure HTTP');
    if (!switchOn(await screen(), label)) await tapExpecting(node, (current) => switchOn(current, label), 'insecure HTTP on');
};
/** Save's answers logged after [since] (a logStamp): a count across the whole log can shrink as the ring drops old lines. */
const saved = (since) => count(linesAfter(allLogs(), since).join('\n'), '"operation":"saveSyncBackend"', '"outcome":"saved"');
/** Settings › Advanced › AI with its assistant card open (core's rows read "<title>. <description>"). */
const openAICard = async () => {
    let nodes = await toTabs();
    nodes = await tapExpecting(tab(nodes, en['tab.menu']) ?? fail('no Menu tab'), sheetOpen, 'the More sheet');
    await tapExpecting(withDescription(await device.settle(nodes), en['nav.settings']) ?? fail('no Settings tile'),
        (next) => Boolean(tagged(next, 'settings-main')), 'Settings');
    await tapExpecting(await reveal((next) => withPrefix(next, `${en['settings.advanced']}. `), 'Advanced row'), (next) => Boolean(tagged(next, 'settings-advanced')), 'Settings › Advanced');
    await tapExpecting(await reveal((next) => withPrefix(next, `${en['settings.ai']}. `), 'AI row'), (next) => Boolean(tagged(next, 'settings-ai')), 'Settings › AI', 30_000);
    nodes = await screen();
    if (!tagged(nodes, 'ai-enabled')) nodes = await tapTag('ai-assistant-card', (current) => Boolean(tagged(current, 'ai-enabled')), 'the assistant card open');
    await reveal((current) => tagged(current, 'ai-provider-openai'), 'the provider chips');
    return screen();
};

let dav = null;
let second = null;
const originalAccelerometer = sh('settings get system accelerometer_rotation');
const cleanup = cleanupOnExit([
    () => execFileSync(adbBin, ['-s', serial, 'reverse', '--remove', `tcp:${PORT}`], { stdio: 'ignore' }),
    () => { void dav?.close(); },
    () => second?.stop(),
    () => { for (const name of PROPS) setProp(name, ''); },
    () => runAs(`rm -f ${CONFIG}`),
    () => sh(`rm -f ${UI_FILE}`),
    () => { if (front().includes(`${PKG}/`)) sh('input keyevent KEYCODE_HOME'); },
    () => sh(`settings put system accelerometer_rotation ${originalAccelerometer === 'null' ? 1 : originalAccelerometer}`),
]);

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}\nrun: ${run}`);
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    for (const name of PROPS) setProp(name, '');
    dav = await serveWebdav({ port: PORT, username: USER, password: PASSWORD });
    execFileSync(adbBin, ['-s', serial, 'reverse', `tcp:${PORT}`, `tcp:${PORT}`], { stdio: 'inherit' });
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    sh('logcat -c');
    await waitFor('home screen', () => front().includes(`${home}/`) || front().includes(`${PKG}/`), 10_000);
    device.launch(ACTIVITY);
    await waitFor('the Inbox', onInbox, 60_000);
    second = await hostDevice({ bundle, name: 'second', log: (line) => { if (/error|fail/i.test(line)) console.log(`note - ${line.slice(0, 240)}`); } });
    await second.boot();

    // (1) WebDAV through Settings › Sync; core's decision schedules the job once.
    let nodes = await openSync();
    if (!nodes.some((node) => node.text === en['settings.syncOff'])) {
        await tapTag('sync-backend-off', (current) => current.some((node) => node.text === en['settings.syncOff']), 'Sync off');
    }
    await tapTag('sync-backend-webdav', (current) => Boolean(tagged(current, 'sync-url')), 'the WebDAV form');
    await fill('sync-url', fields.url);
    await insecureOn();
    await fill('sync-username', USER);
    await fill('sync-password', PASSWORD);
    const since = logStamp(allLogs());
    // A Save runs a verification sync and then a normal sync; on the test phone's ~5,600-task library that measured ~95 s (10-13).
    await tapTag('sync-save', () => saved(since) > 0, 'Save', 240_000);
    await until('the phone\'s data in the WebDAV folder', () => webdavDocument(dav, FOLDER) !== null, 30_000);
    await until('core\'s schedule decision', () => allLogs().includes('Native Android background sync schedule=on'), 30_000, 1_000);
    let queued = await until('the scheduled job in WorkManager', () => (unfinished(SYNC_WORK).length > 0 ? unfinished(SYNC_WORK) : null), 20_000);
    check(queued.length === 1 && queued[0].state === 0 && Number(queued[0].delay) === 15 * 60_000 && queued[0].network === 1,
        `(1) Save scheduled one sync job, 15 minutes out, network required (${JSON.stringify(queued)})`);
    check(unfinished(RN_WORK).length === 0, '(1) RN\'s background worker has no unfinished job');
    const reconciles = count(allLogs(), 'Native Android background sync schedule=on');
    sh('input keyevent KEYCODE_HOME');
    await sleep(2_000);
    // The app comes back where it was left (Settings › Sync).
    device.launch(ACTIVITY);
    await waitFor('the app in front again', () => front().includes(`${PKG}/`), 30_000);
    // Leaving and resuming each reconcile (core's triggers).
    await until('the leave\'s and the resume\'s reconcile', () => count(allLogs(), 'Native Android background sync schedule=on') >= reconciles + 2, 30_000, 1_000);
    const afterResume = unfinished(SYNC_WORK);
    check(afterResume.length === 1 && afterResume[0].id === queued[0].id, '(1) a resume reconciles and keeps the same one job (KEEP)');

    // (2) The scheduled run with the app closed.
    await second.configure('webdav', fields);
    await second.capture(title(1).replace(/^84/, 'Host '));
    const hostTitle = title(1).replace(/^84/, 'Host ');
    await second.syncNow('webdav', { ...fields, password: null });
    check(serverTitles().includes(hostTitle), '(2) the second device wrote its task to the folder');
    await killApp();
    let text = await forceSyncJob('(2)');
    const job2 = processOf(text, RUN_STARTED).join('\n');
    check(count(job2, RUN_STARTED) === 1 && count(job2, RUN_FINISHED, '"outcome":"success"') === 1, '(2) core\'s run started and finished with outcome success in the job\'s process');
    check(count(job2, ...SYNC_JOB, '"outcome":"success"') === 1, '(2) the job ended with success');
    check(!job2.includes('Native Android sync started') && !job2.includes('Native Android sync automatic cycle'), '(2) no foreground trigger started in the job\'s process (no screen)');
    check(!front().includes(`${PKG}/`), '(2) no screen of the app showed');
    check(phoneTitles().includes(hostTitle), `(2) the second device's task is in the phone's database ("${hostTitle}")`);
    queued = unfinished(SYNC_WORK);
    check(queued.length === 1 && queued[0].id !== afterResume[0].id && Number(queued[0].delay) === 15 * 60_000, '(2) the job queued its next run, 15 minutes after this one');

    // (3) A capture intent while the app is closed: stored, then sent before the job reports success.
    await killApp();
    runAs(`mkdir -p no_backup && echo ${Buffer.from(JSON.stringify({ enabled: true, token: TOKEN })).toString('base64')} | base64 -d > ${CONFIG}`);
    const ingestsBefore = count(allLogs(), ...INGEST_JOB);
    check(captureIntent(title(3)) === -1, '(3) the capture intent answers RESULT_OK');
    await until('(3) the capture job to end', () => count(allLogs(), ...INGEST_JOB) > ingestsBefore, 180_000);
    text = allLogs();
    const job3 = processOf(text, INGEST_JOB[1]);
    const finishedAt = job3.findIndex((line) => line.includes(RUN_FINISHED) && line.includes('"outcome":"success"'));
    const ingestAt = job3.findIndex((line) => line.includes(INGEST_JOB[1]));
    check(finishedAt >= 0 && finishedAt < ingestAt, '(3) core\'s capture run finished (success) before the capture job reported success');
    check(serverTitles().includes(title(3)), `(3) the folder holds the capture "${title(3)}"`);

    // (3b) A capture during a slow scheduled run: stored at once, the sync waited for after.
    dav.state.delayMs = 25_000;
    await killApp();
    const syncJobs3b = count(allLogs(), ...SYNC_JOB);
    const started3b = count(allLogs(), RUN_STARTED);
    await until('(3b) JobScheduler to run the sync job', async () => {
        const [queued] = unfinished(SYNC_WORK);
        if (queued?.job !== undefined && queued?.job !== null) sh(`cmd jobscheduler run -f ${PKG} ${queued.job}`);
        await sleep(4_000);
        return count(allLogs(), RUN_STARTED) > started3b;
    }, 90_000, 1_000);
    const ingests3b = count(allLogs(), ...INGEST_JOB);
    const sentAt = Date.now();
    check(captureIntent(title(7)) === -1, '(3b) a capture while the scheduled run syncs with the slow server: RESULT_OK');
    await until('(3b) the capture in the phone\'s database', () => phoneTitles().includes(title(7)), 15_000, 1_000);
    const landedMs = Date.now() - sentAt;
    check(count(allLogs(), ...SYNC_JOB) === syncJobs3b && count(allLogs(), ...INGEST_JOB) === ingests3b,
        `(3b) the capture was stored ${Math.round(landedMs / 1000)} s after the intent, while the scheduled run and the capture job were still waiting on the server`);
    await until('(3b) both jobs to end', () => count(allLogs(), ...SYNC_JOB) > syncJobs3b && count(allLogs(), ...INGEST_JOB) > ingests3b, 420_000, 3_000);
    check(serverTitles().includes(title(7)), '(3b) once the server answered, the capture reached the folder before its job ended');
    dav.state.delayMs = 0;

    // (4) The server down: the capture stays on the phone, the failure is recorded, a scheduled run sits out the cooldown.
    dav.state.down = true;
    await killApp();
    const putsBefore = puts();
    const ingests4 = count(allLogs(), ...INGEST_JOB);
    check(captureIntent(title(4)) === -1, '(4) a capture with the server down: RESULT_OK');
    await until('(4) the capture job to end', () => count(allLogs(), ...INGEST_JOB) > ingests4, 180_000);
    check(count(allLogs(), RUN_FINISHED, '"outcome":"failed"') >= 1, '(4) core\'s capture run finished with outcome failed');
    check(phoneTitles().includes(title(4)) && !serverTitles().includes(title(4)) && puts() === putsBefore, '(4) the capture stays on the phone; nothing reached the server');
    check(failureRecord()?.consecutiveFailures === 1, `(4) core recorded the failure in RN's RKStorage key (${JSON.stringify(failureRecord())})`);
    await killApp();
    const requestsBefore = ownRequests().length;
    text = await forceSyncJob('(4)');
    check(count(text, 'Mobile background sync skipped during failure cooldown') >= 1, '(4) the scheduled run inside the cooldown was skipped (core\'s line)');
    check(ownRequests().length === requestsBefore, '(4) the skipped run sent no request');
    check(unfinished(SYNC_WORK).length === 1, '(4) the job stays queued (its next run)');
    dav.state.down = false;
    await killApp();
    const ingests4b = count(allLogs(), ...INGEST_JOB);
    check(captureIntent(title(5)) === -1, '(4) the server back, another capture: RESULT_OK');
    await until('(4) the capture job to end', () => count(allLogs(), ...INGEST_JOB) > ingests4b, 180_000);
    check(serverTitles().includes(title(4)) && serverTitles().includes(title(5)), '(4) its run uploaded the capture kept during the outage and the new one');
    check(failureRecord() === null, '(4) the success cleared the failure record');

    // (5) The deadline: every answer 25 s (under core's 30 s request timeout), the debug deadline 15 s.
    dav.state.delayMs = 25_000;
    setProp('bgsync_deadline_ms', '15000');
    await killApp();
    const puts5 = puts();
    const ingests5 = count(allLogs(), ...INGEST_JOB);
    const startedAt = Date.now();
    check(captureIntent(title(6)) === -1, '(5) a capture with a slow server: RESULT_OK');
    await until('(5) the capture job to end', () => count(allLogs(), ...INGEST_JOB) > ingests5, 180_000);
    const elapsed = Date.now() - startedAt;
    text = allLogs();
    const abandoned = text.split('\n').filter((line) => line.includes('did not finish before its deadline and was abandoned')).at(-1) ?? '';
    check(abandoned.includes('"deadlineMs":"15000"') && abandoned.includes('"stage":"timer"'), `(5) core abandoned the run at its deadline (${abandoned.slice(abandoned.indexOf('{'))})`);
    check(count(text, RUN_FINISHED, '"outcome":"abandoned"') + count(text, 'took longer than a minute', '"outcome":"abandoned"') >= 1, '(5) the run ended as abandoned');
    check(elapsed < 120_000, `(5) the job ended ${Math.round(elapsed / 1000)} s after the capture, not after the slow server's answers`);
    check(puts() === puts5 && phoneTitles().includes(title(6)), '(5) the abandoned run wrote nothing; the capture stays on the phone');
    setProp('bgsync_deadline_ms', '');
    dav.state.delayMs = 0;

    // (6) Sync Off cancels the job.
    device.launch(ACTIVITY);
    await waitFor('the Inbox', onInbox, 60_000);
    nodes = await openSync();
    await tapTag('sync-backend-off', (current) => current.some((node) => node.text === en['settings.syncOff']), 'Sync off');
    await until('the job cancelled', () => unfinished(SYNC_WORK).length === 0, 30_000);
    check(allLogs().includes('Native Android background sync schedule=off'), '(6) Sync Off: core\'s decision cancelled the job');
    await toTabs();

    // (7) Both channels install over each other and boot.
    const fossApk = resolve(app, 'android/app/build/outputs/apk/foss/debug/app-foss-debug.apk');
    for (const [channel, file] of [['FOSS', fossApk], ['Play', apk]]) {
        console.log(`info - ${channel} apk sha256: ${createHash('sha256').update(readFileSync(file)).digest('hex')}`);
        if (front().includes(`${PKG}/`)) sh('input keyevent KEYCODE_HOME');
        execFileSync(adbBin, ['-s', serial, 'install', '-r', file], { stdio: 'inherit' });
        await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
        device.launch(ACTIVITY);
        await waitFor(`the ${channel} build's Inbox`, onInbox, 60_000);
        nodes = await openAICard();
        const gemini = Boolean(tagged(nodes, 'ai-provider-gemini'));
        check(channel === 'FOSS' ? !gemini : gemini, `(7) the ${channel} build boots, and Settings › AI ${channel === 'FOSS' ? 'offers only the local OpenAI-compatible provider' : 'offers Gemini'}`);
        await toTabs();
    }
    console.log('DEVICE_RESULT pass');
} catch (error) {
    // Sync Off again, so a failed run leaves no WebDAV backend (and no scheduled job) on a dead port for the next check.
    try {
        dav.state.down = false;
        dav.state.delayMs = 0;
        if (!front().includes(`${PKG}/`)) device.launch(ACTIVITY);
        await openSync();
        await tapTag('sync-backend-off', (current) => current.some((node) => node.text === en['settings.syncOff']), 'Sync off');
        await toTabs();
    } catch (offError) { console.log(`warn - Sync could not be set Off after the failure: ${offError.message}`); }
    try {
        console.log(`evidence - app log (background sync):\n${allLogs().split('\n').filter((line) => /background sync|core work|queue drain|\[sync\]|sync started|Core action/.test(line))
            .slice(-60).map((line) => line.slice(0, 300)).join('\n')}`);
    } catch { /* the phone is gone */ }
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    cleanup();
    await sleep(500);
    process.exit(process.exitCode ?? 0);
}
