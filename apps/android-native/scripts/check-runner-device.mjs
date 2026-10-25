// CoreWork runner check for the isolated native Android development app (pass B2, E2 native).
//
//   node apps/android-native/scripts/check-runner-device.mjs <adb-serial> [apk]
//
// Installs the debug APK with `install -r` (existing development data stays) and checks, from the app's own files (the
// database, its pending-captures folder, its journal and RN's RKStorage, pulled through run-as and read with sqlite3):
// (1) the boot drain: a queue file written through run-as while the app is closed is stored once when the app starts, after
// the journal replay; (2) the capture intent: refused while GTD › Capture's Automation capture is off, turned on from that card
// (its token shown and copied), refused with a wrong token, and with the right token queued and stored at once by CoreWork, each
// capture once; (3) a context broadcast: CoreWork posts RN's notification (title and text core's), a deactivation posts none, and
// a tap on it opens the app; (4) a forced job run: a capture queued with its job held back (debug property), the app killed,
// more items written through run-as (a capture, a text item, a check-off, a defer, an audio item, a Pomodoro command and a damaged
// file), then JobScheduler's `cmd jobscheduler run -f` runs CoreWork in a new process: each item stored once, the check-off and
// the defer applied once and recorded in RKStorage, audio and Pomodoro left untouched, the damaged file removed; (5) a process
// death between an item's store write and its file delete (debug property `queue_stop`), for a capture and for a check-off: the
// next boot's journal replay stores nothing twice and removes the file; (6a) a check-off stored and saved whose RKStorage record
// write fails (debug property `fail_kv_set`): the drain is owed, the file is removed anyway, and CoreWork's retry replays the entry
// with no tap, the check-off written once; (6b) a drain whose file cannot be removed (the queue folder read-only) under a context
// trigger's job while the app shows: file and journal entry kept, a newer Mark Done on the screen is never sent and the owed retry
// shows, the trigger posts nothing, and the job's retry replays the journal first (the check-off written once), then posts;
// (7) a context broadcast with a 12 KB context is dropped with no crash. At the end Automation capture is off again. It grants
// the development app the notification permission (and keeps it). Titles are 80 + a 12-digit run id + one digit
// (check-projects-device.mjs --prune-old removes earlier runs'). It never launches over another app and leaves the device on its
// home screen. The capture token never reaches a disk: screens are read through `uiautomator dump /dev/tty` (no file on the
// phone), and no failure evidence is saved while the token is on screen. Exit 0 = pass, 1 = fail, 2 = refused before touching the
// device, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { check, connect, evidenced, fail, field, inEditor, owedRetry, Stopped, switchOn, tab, tagged, withDescription, withholdEvidenceWhen } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-runner-device.mjs <adb-serial> [apk]');
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
const CAPTURE = `${PKG}/tech.dongdongbh.mindwtr.androidwidget.CaptureIntentReceiver`;
const CONTEXT = `${PKG}/tech.dongdongbh.mindwtr.contextautomation.ContextAutomationReceiver`;
const TAG = 'MindwtrNativeDev';
// The screen streams to adb and is never written on the phone: GTD › Capture can show the capture token.
const UI_FILE = '/dev/tty';
// Where the other checks (and this one's earlier runs) wrote the screen; removed at the start and the end.
const SHARED_UI_FILE = '/data/local/tmp/mindwtr-native-dev-ui.xml';
const PROPS = ['core_work_delay_ms', 'queue_stop', 'fail_kv_set'];
const DB = 'mindwtr-native-dev.db';
const QUEUE = 'files/pending-captures';
const CONFIG = 'no_backup/android-capture-intent.json';
const LAST_APPLIED = 'mindwtr:pending-captures:last-applied:v1';
const work = resolve(app, 'android/build/runner-check');
const { en } = await import(resolve(app, '../../packages/core/src/i18n/locales/en.ts'));
// Digits only in titles; the context is a word core's quick-add reads (@r<run>).
const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const title = (digit) => `80${run}${digit}`;
const context = `r${run}`;

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, requireAppFront, pid, screen, waitFor, tapExpecting } = device;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
const logs = (processId) => (processId ? device.logs(processId, TAG).replace(/\\/g, '') : '');
const runAs = (command) => sh(`run-as ${PKG} sh -c '${command}'`);

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
/** The live tasks titled [text] as stored. */
const stored = (text) => sql(resolve(pull([`files/${DB}`], resolve(work, 'db')), DB),
    `SELECT id, status, rev, startTime, contexts FROM tasks WHERE title = '${text}' AND deletedAt IS NULL`);
/** Core's record of the last queued command applied to each task, in RN's RKStorage. */
const lastApplied = () => {
    const dir = pull(['databases/RKStorage'], resolve(work, 'rkstorage'));
    const [row] = sql(resolve(dir, 'RKStorage'), `SELECT value FROM catalystLocalStorage WHERE key = '${LAST_APPLIED}'`);
    return row ? JSON.parse(row.value) : {};
};
const queued = () => runAs(`ls ${QUEUE} 2>/dev/null || true`).split(/\s+/).filter(Boolean).sort();
/** The queue folder read-only (a file in it cannot be removed), then back to its own mode; the restore puts it back too. */
let queueMode = null;
const lockQueue = () => { queueMode = runAs(`stat -c %a ${QUEUE}`); runAs(`chmod 500 ${QUEUE}`); };
const unlockQueue = () => { if (queueMode) runAs(`chmod ${queueMode} ${QUEUE}`); queueMode = null; };
/**
 * One queue item, written as RN's writer does (a temporary name, then a rename): the ingest reads only `*.json`. The bytes are
 * checked before the rename: once renamed, the running app may drain the file at once (it watches the queue folder, pass W1).
 */
const enqueue = (name, text) => {
    const bytes = Buffer.from(text, 'utf8').toString('base64');
    runAs(`mkdir -p ${QUEUE} && echo ${bytes} | base64 -d > ${QUEUE}/${name}.tmp`);
    if (runAs(`cat ${QUEUE}/${name}.tmp 2>/dev/null || true`) !== text) fail(`the queue file ${name}.tmp was not written`);
    runAs(`mv ${QUEUE}/${name}.tmp ${QUEUE}/${name}.json`);
};
/**
 * One queue item written in place, not renamed in: the running app watches the queue folder for renamed items only (pass W1),
 * so this one waits for a drain the check starts itself.
 */
const enqueueUnseen = (name, text) => {
    const bytes = Buffer.from(text, 'utf8').toString('base64');
    runAs(`mkdir -p ${QUEUE} && echo ${bytes} | base64 -d > ${QUEUE}/${name}.json`);
    if (runAs(`cat ${QUEUE}/${name}.json 2>/dev/null || true`) !== text) fail(`the queue file ${name}.json was not written`);
};
const journal = () => runAs('ls files/journal 2>/dev/null || true').split(/\s+/).filter((name) => /^\d{16}\.json$/.test(name))
    .map((name) => JSON.parse(runAs(`cat files/journal/${name}`)));
const storedToken = () => {
    const raw = runAs(`cat ${CONFIG} 2>/dev/null || true`);
    return raw ? JSON.parse(raw).token : null;
};
// No screenshot or screen XML is saved while the stored token is on screen (read in memory, from adb's stream).
withholdEvidenceWhen(() => {
    const token = storedToken();
    if (!token) return null;
    const xml = execFileSync(adbBin, ['-s', serial, 'exec-out', 'uiautomator', 'dump', '/dev/tty'], { maxBuffer: 64 << 20 }).toString('utf8');
    return !xml.includes('<hierarchy') || xml.includes(token) ? 'the capture token may be on screen' : null;
});
const iso = (ms) => new Date(ms).toISOString();

// ---- process and broadcasts ----
/** The app's process gone, as after the system reclaimed it: a signal, never a force-stop (that cancels the app's scheduled work). */
const killApp = async () => {
    if (front().includes(`${PKG}/`)) sh('input keyevent KEYCODE_HOME');
    for (let attempt = 0; attempt < 20 && pid(); attempt += 1) {
        try { runAs(`kill -9 ${pid()}`); } catch { /* gone meanwhile */ }
        await sleep(500);
    }
    if (pid()) fail('the app process did not end');
};
/** An explicit broadcast to [component]; its result code (RN's receiver answers -1 once a capture is queued, 0 otherwise). */
const broadcast = (component, action, extras) => {
    const args = Object.entries(extras).map(([key, value]) => `--es ${key} '${value}'`).join(' ');
    const out = sh(`am broadcast -n ${component} -a ${action} ${args}`);
    return Number(/result=(-?\d+)/.exec(out)?.[1]);
};
const captureIntent = (text, token) => broadcast(CAPTURE, 'tech.dongdongbh.mindwtr.action.CAPTURE', { text, token });
const contextTrigger = (action, name) => broadcast(CONTEXT, `tech.dongdongbh.mindwtr.action.${action}`, { context: name });
/** A line in any process of the app since this check began (a job may run in a process that starts and ends by itself). */
const allLogs = () => execFileSync(adbBin, ['-s', serial, 'logcat', '-d', '-s', `${TAG}:*`], { encoding: 'utf8', maxBuffer: 64 << 20 }).replace(/\\/g, '');
const count = (text, ...needles) => text.split('\n').filter((line) => needles.every((needle) => line.includes(needle))).length;
// The runner's lines, through core's logger: the message, then its fields in context.
const INGESTED = ['Native Android core work', '"job":"ingest"', '"outcome":"success"'];
const CONTEXT_DONE = ['Native Android core work', '"job":"context","outcome":"success"'];
const POSTED = ['Native Android notification', '"kind":"context-automation","outcome":"posted"'];
/** Taps this run's context notification in the shade: the app opens and the notification goes (auto-cancelled). */
const tapNotification = async (step) => {
    sh('cmd statusbar expand-notifications');
    await sleep(1500);
    const nodes = await screen();
    const entry = nodes.find((node) => node.text === `@${context} next action`) ?? fail('the notification is not in the shade');
    const [x1, y1, x2, y2] = entry.bounds.match(/\d+/g).map(Number);
    sh(`input tap ${Math.round((x1 + x2) / 2)} ${Math.round((y1 + y2) / 2)}`);
    await waitUntil('the app in front', () => front().includes(`${PKG}/`), 20_000);
    check(true, `${step} a tap on the notification opens the app`);
    await sleep(1000);
    check(!sh(`dumpsys notification --noredact | grep -A 40 'pkg=${PKG}' || true`).includes(`@${context} next action`), `${step} the tapped notification is gone`);
};
const waitUntil = async (description, predicate, timeoutMs = 60_000, everyMs = 1000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = predicate();
        if (value) return value;
        if (Date.now() > deadline) fail(`timed out waiting for ${description}`);
        await sleep(everyMs);
    }
};

// ---- Settings › GTD › Capture (core's English) ----
const sheetOpen = (nodes) => Boolean(tagged(nodes, 'more-sheet'));
const inSearch = (nodes) => Boolean(tagged(nodes, 'global-search')) && !inEditor(nodes);
const results = (nodes) => nodes.filter((node) => (node['resource-id'] ?? '').endsWith('search-result')).map((node) => node['content-desc'] || node.text);
const onSettings = (id) => (nodes) => Boolean(tagged(nodes, `settings-${id}`)) && !tagged(nodes, 'settings-picker');
const withPrefix = (nodes, prefix) => nodes.find((node) => (node['content-desc'] ?? '').startsWith(prefix));
const settingsScreen = (nodes) => nodes.some((node) => /(^|\/)settings-[\w-]+$/.test(node['resource-id'] ?? ''));
const toTabs = async () => {
    for (let step = 0; step < 8; step += 1) {
        const nodes = await screen();
        if (tab(nodes, en['tab.menu']) && !tagged(nodes, 'menu-screen') && !sheetOpen(nodes) && !settingsScreen(nodes) && !inEditor(nodes)
            && !tagged(nodes, 'quick-capture') && !tagged(nodes, 'global-search')) return nodes;
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(1000);
    }
    return fail('the tabs did not come back');
};
const reveal = async (find, description) => {
    let nodes = await device.toTop();
    for (let step = 0; step < 8 && !find(nodes); step += 1) nodes = await device.swipe(nodes, 'down');
    return find(nodes) ?? fail(`no ${description}`);
};
const switchNode = (nodes) => withDescription(nodes, en['settings.automationCapture']);
const automationOn = (nodes) => switchOn(nodes, en['settings.automationCapture']);
const tokenShown = (nodes) => nodes.find((node) => (node['resource-id'] ?? '').endsWith('android-capture-intent-token'))?.text;
/** The app in front, on GTD › Capture defaults, with Automation capture in view. */
const openCaptureSettings = async () => {
    if (!front().includes(`${PKG}/`)) device.launch(ACTIVITY);
    let nodes = await toTabs();
    nodes = await tapExpecting(tab(nodes, en['tab.menu']) ?? fail('no Menu tab'), sheetOpen, 'the More sheet');
    await tapExpecting(withDescription(await device.settle(nodes), en['nav.settings']) ?? fail('no Settings tile'), onSettings('main'), 'Settings');
    await tapExpecting(await reveal((current) => withPrefix(current, `${en['settings.gtd']}. `), 'GTD row'), onSettings('gtd'), 'Settings › GTD');
    await tapExpecting(await reveal((current) => withDescription(current, en['settings.captureSettings']), 'Capture defaults row'), onSettings('gtd-capture'), 'GTD › Capture defaults');
    await reveal(switchNode, 'Automation capture switch');
    return screen();
};
/**
 * Automation capture switched to [on] from its card; the stored token follows (on keeps or makes one, off deletes it). While on,
 * the card's token row is scrolled into view.
 */
const setAutomationCapture = async (on) => {
    let nodes = await openCaptureSettings();
    if (automationOn(nodes) !== on) nodes = await tapExpecting(switchNode(nodes), (current) => automationOn(current) === on, `Automation capture ${on ? 'on' : 'off'}`);
    await waitUntil(`the stored token to follow the switch (${on ? 'on' : 'off'})`, () => Boolean(storedToken()) === on, 15_000);
    const copyShown = (current) => Boolean(tokenShown(current)) && Boolean(withDescription(current, en['settings.automationCaptureCopyToken']));
    for (let step = 0; step < 6 && on && !copyShown(nodes); step += 1) nodes = await device.swipe(await screen(), 'down');
    if (on && !copyShown(nodes)) fail('the token row did not show');
    return nodes;
};

const originalAccelerometer = sh('settings get system accelerometer_rotation');
/** This run's queue items that no drain takes (audio, Pomodoro), removed at the end whatever happens. */
const leftovers = [];
const restore = async () => {
    for (const name of PROPS) { try { setProp(name, ''); } catch { /* device gone */ } }
    try { if (leftovers.length > 0) runAs(`rm -f ${leftovers.map((name) => `${QUEUE}/${name}`).join(' ')}`); } catch { /* device gone */ }
    try { unlockQueue(); } catch { /* device gone */ }
    // An owed retry a stopped step (6) left: Try again first (the faults are off now), so the Menu is usable. The search screen's
    // Back leaves the app while a retry is owed, so the app is launched again as often as that happens.
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            if (!front().includes(`${PKG}/`)) device.launch(ACTIVITY);
            const nodes = await toTabs();
            if (!owedRetry(nodes)) break;
            await device.tap(owedRetry(nodes));
            await sleep(5000);
        } catch { /* launched again above */ }
    }
    // Automation capture off, as a development app nobody set up has it: through its card, else as the card's Off does it
    // (CaptureIntentConfigStore.setEnabled(false) deletes the config file), so a failed step never leaves it on.
    try {
        if (storedToken()) await setAutomationCapture(false);
    } catch (error) { console.log(`note - the card did not turn Automation capture off (${error.message}); deleting its config as Off does`); }
    try {
        if (storedToken()) runAs(`rm -f ${CONFIG}`);
        if (storedToken()) throw new Error('the config is still there');
    } catch (error) { console.error(`RESTORE FAILED: Automation capture is still on: ${error.message}; turn it off by hand`); process.exitCode = 1; }
    try { await toTabs(); } catch { /* the app is gone */ }
    try { if (front().includes(`${PKG}/`)) sh('input keyevent KEYCODE_HOME'); } catch { /* device gone */ }
    try { sh(`settings put system accelerometer_rotation ${originalAccelerometer === 'null' ? 1 : originalAccelerometer}`); } catch { /* device gone */ }
    try { sh(`rm -f ${SHARED_UI_FILE}`); } catch { /* device gone */ }
};

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    for (const name of PROPS) setProp(name, '');
    sh(`rm -f ${SHARED_UI_FILE}`);
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    // RN's notification permission (Android 13+), granted once for the development app and kept (plan section 5).
    sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`);
    sh('logcat -c');

    // (1) The boot drain: an item queued while the app is closed is stored when the app starts, after the journal replay.
    {
        await killApp();
        const id = randomUUID();
        enqueue(id, JSON.stringify({ id, title: title(1), createdAt: iso(Date.now()), source: 'android-capture-intent' }));
        device.launch(ACTIVITY);
        requireAppFront();
        const processId = await waitUntil('the boot\'s queue drain', () => {
            const current = pid();
            return logs(current).includes('Native Android queue drain') ? current : null;
        });
        const text = logs(processId);
        check(text.indexOf('Native Android journal replay') >= 0 && text.indexOf('"outcome":"drained"') > text.indexOf('Native Android journal replay'),
            '(1) the boot drained the queue after its journal replay');
        const rows = stored(title(1));
        check(rows.length === 1 && rows[0].id === id && !queued().includes(`${id}.json`), `(1) the queued capture is stored once, under its own id, and its file is gone`);
    }

    // (2) The capture intent: off, then on from GTD › Capture's card, a wrong token, the right token.
    {
        await setAutomationCapture(false);
        check(storedToken() === null, '(2) Automation capture is off: no token is stored');
        sh('input keyevent KEYCODE_HOME');
        const before = queued();
        const someToken = randomBytes(32).toString('hex');
        check(captureIntent(title(2), someToken) === 0, '(2a) off: the receiver answers RESULT_CANCELED');
        await sleep(3000);
        check(JSON.stringify(queued()) === JSON.stringify(before) && stored(title(2)).length === 0, '(2a) off: nothing is queued or stored');

        let nodes = await setAutomationCapture(true);
        const token = tokenShown(nodes);
        check(/^[0-9a-f]{64}$/.test(token ?? '') && storedToken() === token, '(2b) on: the card shows the stored 64-hex token');
        // Android's own clipboard notice can cover the screen for a moment: several quick reads, each of every window it shows.
        await device.tap(withDescription(nodes, en['settings.automationCaptureCopyToken']) ?? fail('no Copy token'));
        const windows = new Set();
        let copied = false;
        for (let read = 0; read < 8 && !copied; read += 1) {
            const shot = await screen();
            for (const node of shot) windows.add(node.package);
            copied = shot.some((node) => (node.text ?? '').includes(en['settings.automationCaptureCopied']));
        }
        check(copied, `(2b) Copy token shows core's toast (windows read: ${[...windows].join(', ')})`);
        sh('input keyevent KEYCODE_HOME');

        let wrong = randomBytes(32).toString('hex');
        if (wrong === token) wrong = randomBytes(32).toString('hex');
        check(captureIntent(title(3), wrong) === 0, '(2c) a wrong token: the receiver answers RESULT_CANCELED');
        await sleep(3000);
        check(JSON.stringify(queued()) === JSON.stringify(before) && stored(title(3)).length === 0, '(2c) a wrong token: nothing is queued or stored');

        const jobs = count(allLogs(), ...INGESTED);
        check(captureIntent(`${title(4)} @${context} /next`, token) === -1, '(2d) the right token: the receiver answers RESULT_OK');
        check(captureIntent(title(5), token) === -1, '(2d) a second capture: RESULT_OK');
        await waitUntil('CoreWork\'s drain of both captures', () => stored(title(4)).length === 1 && stored(title(5)).length === 1);
        const [task] = stored(title(4));
        check(task.status === 'next' && JSON.parse(task.contexts ?? '[]').includes(`@${context}`),
            `(2d) CoreWork stored the capture at once, read as quick-add: next, @${context}`);
        await sleep(2000);
        check(stored(title(4)).length === 1 && stored(title(5)).length === 1, '(2d) each capture is stored once');
        // The ingest job ends once its capture sync settled (pass S4a), which can be after the store write.
        await waitUntil('CoreWork\'s ingest job to end', () => count(allLogs(), ...INGESTED) > jobs, 300_000, 2_000);
        check(stored(title(4)).length === 1 && stored(title(5)).length === 1, '(2d) each capture is stored once, by CoreWork\'s ingest job');
        check(queued().length === before.length, '(2d) their queue files are gone');
    }

    // (3) Context automation: RN's notification from core; a deactivation posts none; a tap opens the app.
    {
        const posted = () => count(allLogs(), ...POSTED);
        const contextJobs = () => count(allLogs(), ...CONTEXT_DONE);
        const [postedBefore, jobsBefore] = [posted(), contextJobs()];
        contextTrigger('ACTIVATE_CONTEXT', context);
        await waitUntil('the context notification', () => posted() > postedBefore);
        const shown = sh(`dumpsys notification --noredact | grep -A 40 'pkg=${PKG}' || true`);
        check(shown.includes(`android.title=String (@${context} next action)`) && shown.includes(`android.text=String (${title(4)})`),
            `(3) CoreWork posted core's notification: "@${context} next action", "${title(4)}"`);
        check(/channel=mindwtr_reminders_v2|mChannelId=mindwtr_reminders_v2|channelId=mindwtr_reminders_v2/.test(sh(`dumpsys notification --noredact | grep -B 5 -A 60 'pkg=${PKG}' || true`)),
            '(3) on RN\'s reminder channel');
        // A deactivation reaches core too, which posts nothing for it (as in RN).
        contextTrigger('DEACTIVATE_CONTEXT', context);
        await waitUntil('the deactivation\'s job', () => contextJobs() >= jobsBefore + 2);
        check(posted() === postedBefore + 1, '(3) a deactivation posts nothing');
        // The tap: RN's notification opens the app (and goes, auto-cancelled).
        await tapNotification('(3)');
        sh('input keyevent KEYCODE_HOME');
    }

    // (4) A forced job run: CoreWork held back, the app killed, items written through run-as, then JobScheduler runs the job in a
    // new process.
    {
        const token = storedToken() ?? fail('Automation capture went off');
        const [done] = stored(title(4));
        const [deferred] = stored(title(5));
        await killApp();
        // Items an earlier run left (only audio or Pomodoro ones can stay) are not this run's.
        const earlier = queued();
        setProp('core_work_delay_ms', '3600000');
        try {
            check(captureIntent(title(6), token) === -1, '(4) a capture with its job held back: RESULT_OK');
        } finally {
            setProp('core_work_delay_ms', '');
        }
        await sleep(1500);
        await killApp();
        const now = Date.now();
        const ids = { capture: randomUUID(), text: randomUUID(), complete: randomUUID(), defer: randomUUID(), audio: randomUUID(), pomodoro: randomUUID() };
        leftovers.push(`${ids.audio}.json`, `${ids.pomodoro}.json`);
        enqueue(ids.capture, JSON.stringify({ id: ids.capture, title: title(7), createdAt: iso(now), source: 'android-capture-intent' }));
        enqueue(ids.text, JSON.stringify({ kind: 'text', id: ids.text, title: title(8), createdAt: iso(now), source: 'apple-watch' }));
        enqueue(ids.complete, JSON.stringify({ kind: 'complete', id: ids.complete, taskId: done.id, completedAt: iso(now - 5000), source: 'android-widget' }));
        enqueue(ids.defer, JSON.stringify({ kind: 'defer', id: ids.defer, taskId: deferred.id, startDate: '2026-12-01', createdAt: iso(now - 4000), source: 'apple-watch' }));
        enqueue(ids.audio, JSON.stringify({ kind: 'audio', id: ids.audio, audioPath: 'file:///nonexistent.wav', source: 'apple-watch' }));
        enqueue(ids.pomodoro, JSON.stringify({ kind: 'pomodoro', id: ids.pomodoro, action: 'start', source: 'apple-watch' }));
        enqueue(`damaged-${run}`, '{"id":');
        check(queued().length === earlier.length + 8, '(4) eight files wait: the held capture and the seven written through run-as');
        const jobIds = () => [...new Set([...sh('dumpsys jobscheduler').matchAll(new RegExp(`JOB #u\\d+a\\d+/(\\d+): \\w+ ${PKG.replace(/\./g, '\\.')}/androidx\\.work\\.impl\\.background\\.systemjob\\.SystemJobService`, 'g'))]
            .map((m) => m[1]))];
        // A Quick Settings tile the shade bound (step 3 opened it) is rebound by SystemUI 5 s after its process dies, which
        // starts the app again while the files above are written: end that process too, so the job meets no running app.
        await killApp();
        const held = jobIds();
        check(held.length >= 1 && !pid(),`(4) JobScheduler holds CoreWork's job (${held.join(', ')}), and the app is not running`);
        const jobs = count(allLogs(), ...INGESTED);
        try {
            // A WorkManager that starts can move its jobs to new ids: each round forces the ids JobScheduler holds then.
            await waitUntil('the forced job', () => {
                if (count(allLogs(), ...INGESTED) > jobs) return true;
                for (const id of jobIds()) console.log(`info - cmd jobscheduler run -f ${PKG} ${id}: ${sh(`cmd jobscheduler run -f ${PKG} ${id}`)}`);
                return false;
            }, 60_000, 15_000);
        } catch (error) {
            const state = sh('dumpsys jobscheduler').split('\n').filter((line) => line.includes(PKG) && /JOB #|START|STOP|Pending/.test(line)).slice(-12).join('\n');
            const system = execFileSync(adbBin, ['-s', serial, 'logcat', '-d'], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n')
                .filter((line) => /JobScheduler|WM-|MindwtrNativeDev|ActivityManager.*mindwtr/.test(line)).slice(-25).join('\n');
            console.log(`evidence - JobScheduler:\n${state}\nevidence - log:\n${system}`);
            throw error;
        }
        check(!front().includes(`${PKG}/`), '(4) the job ran in the background, with no screen');
        const once = [title(6), title(7), title(8)].map((text) => stored(text));
        check(once.every((rows) => rows.length === 1) && once[1][0].id === ids.capture && once[2][0].id === ids.text,
            '(4) the three captures are stored once each, the written ones under their own ids');
        const [doneAfter] = stored(title(4));
        const [deferredAfter] = stored(title(5));
        check(doneAfter.status === 'done' && doneAfter.rev === done.rev + 1, `(4) the check-off applied once (rev ${done.rev} → ${doneAfter.rev})`);
        check(deferredAfter.startTime === '2026-12-01' && deferredAfter.rev === deferred.rev + 1, `(4) the defer applied once (rev ${deferred.rev} → ${deferredAfter.rev})`);
        const record = lastApplied();
        check(record[done.id]?.id === ids.complete && record[deferred.id]?.id === ids.defer, '(4) RKStorage records both commands under core\'s key');
        check(JSON.stringify(queued()) === JSON.stringify([...earlier, `${ids.audio}.json`, `${ids.pomodoro}.json`].sort()),
            '(4) the audio item and the Pomodoro command wait untouched; every other file is gone, the damaged one too');
        runAs(`rm -f ${QUEUE}/${ids.audio}.json ${QUEUE}/${ids.pomodoro}.json`);
    }

    // The log since a step began (the device's clock): a long step can roll older lines out of logcat, so counts start at zero.
    let stepStart = '';
    const beginStep = () => { stepStart = sh("date +'%m-%d %H:%M:%S.000'"); };
    const lines = () => execFileSync(adbBin, ['-s', serial, 'logcat', '-d', '-T', stepStart, '-s', `${TAG}:*`], { encoding: 'utf8', maxBuffer: 64 << 20 }).replace(/\\/g, '');
    // (5) A process death between an item's write and its file delete: the next boot's replay stores nothing twice.
    for (const kind of ['capture', 'complete']) {
        const target = kind === 'complete' ? stored(title(7))[0] : null;
        await killApp();
        const id = randomUUID();
        enqueue(id, JSON.stringify(kind === 'capture'
            ? { id, title: title(9), createdAt: iso(Date.now()), source: 'android-capture-intent' }
            : { kind: 'complete', id, taskId: target.id, completedAt: iso(Date.now() - 1000), source: 'android-widget' }));
        setProp('queue_stop', 'delete');
        // The killed job's own boot replays an empty journal (sent=0); the app can start again by itself (the job's retry, a
        // widget) and replay before the launch below, so the replay is looked for in every line since the trigger.
        if (journal().length) fail(`(5 ${kind}) the journal is not empty before the trigger`);
        beginStep();
        let stoppedAt = 0;
        try {
            // Any CoreWork job boots the host, and the boot drains the queue: a deactivation writes nothing itself.
            const stops = count(allLogs(), 'Native Android queue stop at=delete');
            contextTrigger('DEACTIVATE_CONTEXT', context);
            await waitUntil('the stop before the delete', () => count(allLogs(), 'Native Android queue stop at=delete') > stops);
            stoppedAt = Date.now();
        } finally {
            setProp('queue_stop', '');
        }
        await waitUntil('the stopped process to end', () => !pid() || Date.now() - stoppedAt > 5000, 10_000);
        const entries = journal();
        check(queued().includes(`${id}.json`) && entries.some((entry) => entry.method === 'ingest'),
            `(5 ${kind}) the process died after the write, before the delete: the file and the drain's journal entry are on disk`);
        let atStop;
        if (kind === 'capture') {
            atStop = stored(title(9));
            check(atStop.length === 1 && atStop[0].id === id, '(5 capture) the task is stored once, under the capture\'s id');
        } else {
            [atStop] = stored(title(7));
            check(atStop.status === 'done' && atStop.rev === target.rev + 1 && lastApplied()[target.id]?.id === id, '(5 complete) Done is stored once and recorded');
        }
        if (!pid()) device.launch(ACTIVITY);
        await waitUntil('the replay to remove the file', () => !queued().includes(`${id}.json`) && journal().length === 0, 90_000);
        const replayed = lines().split('\n').filter((line) => line.includes('Native Android journal replay sent=')).find((line) => /sent=[1-9]\d* dropped=[1-9]\d* left=0 owed=none/.test(line));
        check(Boolean(replayed), `(5 ${kind}) a boot replayed the drain's entry and dropped it: ${replayed?.split('journal replay ')[1]}`);
        if (kind === 'capture') {
            const rows = stored(title(9));
            check(rows.length === 1 && rows[0].id === id && rows[0].rev === atStop[0].rev, '(5 capture) still one task, written once: no duplicate');
        } else {
            const [end] = stored(title(7));
            check(end.status === 'done' && end.rev === atStop.rev, `(5 complete) still done, written once (rev ${atStop.rev})`);
            check(allLogs().includes('stale-queued-command-skipped') && allLogs().includes('"outcome":"replayed"'), '(5 complete) core found the replay in its record');
        }
    }

    // (6a) A check-off stored and saved whose record write fails (debug fail_kv_set), drained by a CoreWork job while the app
    // shows: owed, and its file is removed anyway, so nothing can apply it again; the job's retry recovers with no tap.
    const replayLine = 'journal replay sent=1 dropped=1 left=0 owed=none';
    const clearOwedRetry = async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const nodes = await toTabs();
            if (!owedRetry(nodes)) return;
            await device.tap(owedRetry(nodes));
            if (await waitFor('the owed retry to clear', (current) => !owedRetry(current), 20_000).then(() => true, () => false)) return;
        }
        fail('the owed retry did not clear');
    };
    {
        const token = storedToken() ?? fail('Automation capture went off');
        // A next action in the run's context, so a trigger has a notification to post once it may.
        check(captureIntent(`${title(2)} @${context} /next`, token) === -1, '(6) a next action in the context: RESULT_OK');
        await waitUntil('its drain', () => stored(title(2)).length === 1);
        const [target] = stored(title(8));
        check(target.status !== 'done', '(6a) the check-off\'s task is open');
        if (!front().includes(`${PKG}/`)) device.launch(ACTIVITY);
        await toTabs();
        const id = randomUUID();
        beginStep();
        const [failedBefore, replaysBefore] = [0, 0];
        setProp('fail_kv_set', '1');
        try {
            enqueue(id, JSON.stringify({ kind: 'complete', id, taskId: target.id, completedAt: iso(Date.now() - 1000), source: 'android-widget' }));
            contextTrigger('DEACTIVATE_CONTEXT', context);
            await waitUntil('the owed drain', () => count(lines(), 'Native Android queue drain', '"error":"SAVE_FAILED"') > failedBefore);
        } finally {
            setProp('fail_kv_set', '');
        }
        const [atFailure] = stored(title(8));
        check(atFailure.status === 'done' && atFailure.rev === target.rev + 1 && lastApplied()[target.id]?.id !== id,
            `(6a) the drain answered SAVE_FAILED: the check-off is stored and saved (rev ${target.rev} → ${atFailure.rev}), with no record`);
        check(!queued().includes(`${id}.json`), '(6a) its file is removed anyway: nothing can apply it again after a reopen');
        await waitUntil('the retry to replay the owed entry', () => count(lines(), replayLine) > replaysBefore && journal().length === 0, 300_000, 5000);
        const [end] = stored(title(8));
        check(end.rev === target.rev + 1, `(6a) CoreWork's retry replayed the owed entry with no tap; the check-off was written once (rev ${end.rev})`);
        await clearOwedRetry();
    }

    // (6b) A drain owed because its file cannot be removed (the queue folder made read-only through run-as), under a context
    // trigger's job while the app shows: a newer edit waits behind it, the trigger posts nothing, and once the folder is writable
    // again the job's retry replays the journal first, then posts. (A failed save, `fail_commit`, would also fail every read, so
    // no screen could show the edit that waits.)
    {
        const [target] = stored(title(1));
        const [other] = stored(title(2));
        check(target.status !== 'done' && other.status !== 'done', '(6b) the check-off\'s task and the task Mark Done tries are open');
        await toTabs();
        const id = randomUUID();
        beginStep();
        const [jobsBefore, postedBefore, replaysBefore, retriesBefore] = [0, 0, 0, 0];
        // Unseen: a drain of its own would remove the file before the folder is made read-only.
        enqueueUnseen(id, JSON.stringify({ kind: 'complete', id, taskId: target.id, completedAt: iso(Date.now() - 1000), source: 'android-widget' }));
        lockQueue();
        try {
            contextTrigger('ACTIVATE_CONTEXT', context);
            await waitUntil('the trigger\'s job to wait for the owed drain', () => count(lines(), 'Native Android core work', '"job":"context","outcome":"retry"') > retriesBefore);
            const [atFailure] = stored(title(1));
            check(atFailure.status === 'done' && atFailure.rev === target.rev + 1 && lastApplied()[target.id]?.id === id,
                `(6b) the check-off is stored, saved and recorded (rev ${target.rev} → ${atFailure.rev}), but its file cannot go: owed`);
            check(queued().includes(`${id}.json`) && journal().some((entry) => entry.method === 'ingest'), '(6b) its file and the drain\'s journal entry stay');
            check(count(lines(), ...POSTED) === postedBefore, '(6b) the trigger posted nothing from unfinished state');

            // A newer edit on the screen waits behind the owed drain: Mark Done on another task is never sent.
            let nodes = await tapExpecting(withDescription(await toTabs(), en['search.title']) ?? fail('no Search button'), inSearch, 'the search screen');
            await device.focusAtEnd(field(nodes) ?? fail('no search field'));
            requireAppFront();
            sh(`input text ${title(2)}`);
            nodes = await waitFor(`the result ${title(2)}`, (current) => JSON.stringify(results(current)) === JSON.stringify([title(2)]), 20_000);
            await device.tap(withDescription(nodes, en['review.markDone']) ?? fail('no Mark Done on the result'));
            await sleep(3000);
            const [otherAfter] = stored(title(2));
            check(otherAfter.status === other.status && otherAfter.rev === other.rev && !journal().some((entry) => entry.method === 'complete'),
                '(6b) Mark Done on another task was never sent while the drain is owed');
            // While a retry is owed, the search screen's Back is off (SearchScreen's BackHandler), so Back leaves the app, as for any
            // owed command there; the app then reopens on the tabs with the owed retry.
            for (let step = 0; step < 4 && front().includes(`${PKG}/`) && inSearch(await screen()); step += 1) {
                sh('input keyevent KEYCODE_BACK');
                await sleep(1500);
            }
            if (!front().includes(`${PKG}/`)) device.launch(ACTIVITY);
            requireAppFront();
            await toTabs();
            await waitFor('the owed retry on the tabs', (current) => Boolean(owedRetry(current)), 10_000);
            check(true, '(6b) the screen offers the owed retry');
        } finally {
            unlockQueue();
        }
        // The job's own retry recovers with no tap: the journal's replay first, then the drain, then the trigger's notification.
        // Wait for the post itself: other jobs (step 6a's deactivation retrying behind this owed drain) also end in success, and
        // WorkManager runs this job's retry on its own back-off.
        await waitUntil('the trigger\'s retry to recover and post', () => count(lines(), ...POSTED) > postedBefore, 400_000, 5000);
        await sleep(2000);
        const text = lines();
        check(count(text, replayLine) > replaysBefore && text.indexOf(replayLine) < text.lastIndexOf(POSTED[0]) && count(text, ...CONTEXT_DONE) > jobsBefore,
            '(6b) a job\'s retry replayed the owed journal entry, and the trigger\'s job then finished');
        check(count(text, ...POSTED) === postedBefore + 1, '(6b) the trigger posted its notification once, after the recovery');
        const [recovered] = stored(title(1));
        check(recovered.status === 'done' && recovered.rev === target.rev + 1 && !queued().includes(`${id}.json`) && journal().length === 0,
            `(6b) recovered: the check-off written once (rev ${recovered.rev}), its file and entry gone`);
        // The screen's Try again: nothing is left to replay or drain, so the owed retry clears.
        await clearOwedRetry();
        check(!owedRetry(await screen()), '(6b) Try again cleared the owed retry');
        await tapNotification('(6b)');
        await toTabs();
    }

    // (7) A context broadcast with a 12 KB context: dropped before WorkManager sees it (core's 2,000-character bound), no crash.
    {
        const processId = pid();
        const dropped = () => count(allLogs(), 'Native Android context trigger dropped reason=too-long');
        const crashes = () => count(execFileSync(adbBin, ['-s', serial, 'logcat', '-d', '-b', 'crash'], { encoding: 'utf8', maxBuffer: 64 << 20 }), PKG);
        const [before, crashesBefore] = [dropped(), crashes()];
        contextTrigger('ACTIVATE_CONTEXT', 'x'.repeat(12 * 1024));
        await waitUntil('the dropped trigger', () => dropped() > before, 20_000);
        await sleep(2000);
        check(pid() === processId && crashes() === crashesBefore, '(7) a 12 KB context is dropped; the app keeps running, with no crash');
    }

    // Automation capture goes back off through its card: the token is deleted.
    await setAutomationCapture(false);
    check(storedToken() === null, 'Automation capture is off again, its token deleted');
    console.log('Runner device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
