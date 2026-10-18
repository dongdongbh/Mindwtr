// File share check for the isolated native Android development app (O3 review item 5: RN's file shares).
//
//   node apps/android-native/scripts/check-share-files-device.mjs <adb-serial> [apk]
//
// Installs the debug APK with `install -r` (existing development data stays). Another app's share sheet is played by the debug
// build's own ShareTestProvider (files the check puts in files/share-test/, never another path) and ShareTestSender (a SEND or
// SEND_MULTIPLE to the app's alias, which `am start` cannot send with a list): (a) a PDF opens RN's capture screen titled with
// its name without the extension, listing the file under Attachments; Save stores the task once with one attachment, a copy in
// files/attachments with the file's bytes; (b) three files (one whose provider gives no name, no size and no type, RN's #1117
// fallbacks) are listed and saved; (c) seven files list six, and Cancel stores nothing; (d) a 51 MiB file and a blocked type
// beside a PDF: core's notice counts two skipped files, the PDF is listed, and no copy over the cap is left; (e) a file that
// cannot be read shows "Share unavailable"; (f) a file share's subject and text are left out, as RN's Android share module sends files only (the title is the file's name); (g) a share sent
// to a stopped app opens after the boot and saves; (h) a hostile share naming this app's own files (a file:// URI, this app's own
// provider, and that provider behind a `0@` user prefix, plain or encoded) shows "Share unavailable" and copies nothing. Each share's staged files are
// gone once it opened. Titles are 77 + a
// 12-digit run id + a number (check-projects-device.mjs --prune-old removes earlier runs'). It types nothing, never launches over
// another app, removes its test files and leaves the app on its Inbox. It needs host `bun`.
// Exit 0 = pass, 1 = fail, 2 = refused before touching the device, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { check, connect, evidenced, fail, hasText, inEditor, Stopped, tab, tabSelected, tagged } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-share-files-device.mjs <adb-serial> [apk]');
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
const SENDER = `${PKG}/tech.dongdongbh.mindwtr.pilot.ShareTestSender`;
const PROVIDER = `content://${PKG}.sharetest`;
const TAG = 'MindwtrNativeDev';
const UI_FILE = '/data/local/tmp/mindwtr-native-dev-ui.xml';
const DB = 'mindwtr-native-dev.db';
const MIB = 1024 * 1024;
const work = resolve(app, 'android/build/share-files-check');
const coreSrc = resolve(app, '../../packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));
const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const name = (n, extension) => `77${run}${n}.${extension}`;
const title = (n) => `77${run}${n}`;
const pushed = `/data/local/tmp/mindwtr-share-test-${run}`;

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, requireAppFront, pid, screen, waitFor, tapExpecting } = device;
const runAs = (command) => sh(`run-as ${PKG} sh -c '${command}'`);
const lines = (...needles) => device.logs(pid(), TAG).replace(/\\/g, '').split('\n').filter((line) => needles.every((needle) => line.includes(needle))).length;
const prepared = () => lines('native-share-files');
const captures = () => lines('native-android-dev-task-command', '"operation":"captureModal"', '"outcome":"saved"');

// ---- the test files: made here, pushed, then copied into the provider's folder ----
const local = {};
const makeFile = (fileName, bytes) => { local[fileName] = bytes; writeFileSync(resolve(work, 'files', fileName), bytes); };

// ---- core on a copy of the app's database ----
const pullDatabase = () => {
    const dir = resolve(work, 'db');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = runAs('ls files').split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    return resolve(dir, DB);
};
/** The live tasks titled [titles], each with its attachments' titles and URIs. */
const stored = (titles) => JSON.parse(execFileSync('bun', ['-e', `
    import { Database } from 'bun:sqlite';
    import { SqliteAdapter, createNativeHostContract, setStorageAdapter, useTaskStore } from '${coreSrc}/index.ts';
    const db = new Database(process.env.CHECK_DB);
    setStorageAdapter(new SqliteAdapter({
        run: async (sql, params = []) => { db.query(sql).run(...params); },
        all: async (sql, params = []) => db.query(sql).all(...params),
        get: async (sql, params = []) => db.query(sql).get(...params) ?? undefined,
        exec: async (sql) => { db.exec(sql); },
    }));
    const ready = await createNativeHostContract().activate({ writeSafetyReady: true });
    if (!ready.ok) throw new Error(ready.error.message);
    const titles = JSON.parse(process.env.CHECK_TITLES);
    const tasks = useTaskStore.getState()._allTasks;
    console.log(JSON.stringify(Object.fromEntries(titles.map((title) => [title, tasks.filter((task) => task.title === title && !task.deletedAt)
        .map((task) => ({ description: task.description ?? null, attachments: (task.attachments ?? []).filter((item) => !item.deletedAt).map((item) => ({ title: item.title, uri: item.uri })) }))]))));
    process.exit(0);
`], { encoding: 'utf8', env: { ...process.env, CHECK_DB: pullDatabase(), CHECK_TITLES: JSON.stringify(titles) } }).trim().split('\n').pop());
/** A managed copy's SHA-256 on the phone. */
const deviceSha = (uri) => runAs(`sha256sum ${uri.replace(/^file:\/\/\/data\/user\/0\/[^/]+\//, '').replace(/^file:\/\/\/data\/data\/[^/]+\//, '')}`).split(/\s+/)[0];
const staged = () => runAs('ls cache/shared-entries 2>/dev/null || true').split(/\s+/).filter(Boolean);
/** The largest file in files/attachments, in bytes. */
const largestCopy = () => Math.max(0, ...runAs('ls -l files/attachments 2>/dev/null || true').split('\n').map((line) => Number(line.trim().split(/\s+/)[4])).filter(Number.isFinite));

// ---- the share and the screen ----
/** Sends a share of the provider's [uris] ("mode/name"), as another app's share sheet does; waits until core prepared it. [fromApp] false: the app is stopped. */
const share = async ({ action = 'SEND', type = '*/*', uris, raw = [], subject, text }, expected, description, timeoutMs = 30_000, fromApp = true) => {
    if (fromApp) requireAppFront();
    // A stopped app's new process logs from zero.
    const before = fromApp ? prepared() : 0;
    const extras = [`--es action android.intent.action.${action}`, `--es type '${type}'`, `--esal uris ${[...uris.map((uri) => `${PROVIDER}/${uri}`), ...raw].join(',')}`,
        ...(subject ? [`--es subject '${subject}'`] : []), ...(text ? [`--es text '${text}'`] : [])];
    // An app that sends a file:// URI dies of FileUriExposedException before the share leaves it, so the shell sends that one.
    const fileUri = uris.length === 0 && raw.length === 1 && raw[0].startsWith('file://') ? raw[0] : null;
    sh(fileUri
        ? `am start -W -a android.intent.action.${action} -t '${type}' --eu android.intent.extra.STREAM '${fileUri}' -n ${PKG}/${PKG}.MainActivity`
        // Each sender start opens its own task: after the cold start (g) the sender is the app task's root, and a plain start of the
        // same intent only brings that task to the front, so the sender never runs and no share is sent.
        : `am start -W --activity-multiple-task -n ${SENDER} ${extras.join(' ')}`);
    const deadline = Date.now() + timeoutMs;
    while (prepared() === before) {
        if (Date.now() > deadline) fail(`core never prepared the share for ${description}`);
        await sleep(500);
    }
    return waitFor(description, expected, timeoutMs);
};
const modal = (text) => (nodes) => Boolean(tagged(nodes, 'capture-modal')) && tagged(nodes, 'capture-modal-title')?.text === text;
const rows = (nodes) => nodes.filter((node) => /(^|\/)capture-modal-attachment$/.test(node['resource-id'] ?? '')).map((node) => node.text);
const atInbox = (nodes) => tabSelected(nodes, en['tab.inbox']) && !tagged(nodes, 'capture-modal') && !inEditor(nodes);
const save = async (nodes) => {
    const before = captures();
    await tapExpecting(tagged(nodes, 'capture-modal-save') ?? fail('no Save on the capture screen'), atInbox, 'the share to save');
    await waitFor('the capture command', () => captures() === before + 1, 15_000);
};
const cancel = (nodes) => tapExpecting(tagged(nodes, 'capture-modal-cancel') ?? fail('no Cancel on the capture screen'), atInbox, 'the capture screen to close');
const noStaged = async (step) => {
    const deadline = Date.now() + 10_000;
    while (staged().length > 0 && Date.now() < deadline) await sleep(500);
    check(staged().length === 0, `${step} the share's staged files are gone (${staged().join(' ') || 'none'})`);
};

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const restore = async () => {
    try {
        if (front().includes(`${PKG}/`)) {
            let nodes = await screen();
            for (let step = 0; step < 2 && tagged(nodes, 'capture-modal'); step += 1) { sh('input keyevent KEYCODE_BACK'); await sleep(800); nodes = await screen(); }
            if (tab(nodes, en['tab.inbox']) && !tabSelected(nodes, en['tab.inbox'])) await device.tap(tab(nodes, en['tab.inbox']));
        }
    } catch { /* the app is gone */ }
    try { runAs('rm -rf files/share-test'); } catch { /* device gone */ }
    try { sh(`rm -rf ${pushed} ${UI_FILE}`); } catch { /* device gone */ }
    try { sh(`settings put system accelerometer_rotation ${originalAccelerometer === 'null' ? 1 : originalAccelerometer}`); } catch { /* device gone */ }
};

try {
    rmSync(work, { recursive: true, force: true });
    mkdirSync(resolve(work, 'files'), { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    makeFile(name(1, 'pdf'), randomBytes(40_000));
    makeFile(name(2, 'png'), randomBytes(3_000));
    makeFile(name(3, 'csv'), Buffer.from('a,b\n1,2\n'));
    makeFile(name(4, 'pdf'), randomBytes(5_000));
    for (let n = 1; n <= 7; n += 1) makeFile(name(`5-${n}`, 'pdf'), randomBytes(100));
    makeFile(name(6, 'bin'), Buffer.alloc(51 * MIB));
    makeFile(name(7, 'exe'), randomBytes(100));
    makeFile(name(8, 'pdf'), randomBytes(100));
    makeFile(name(10, 'pdf'), randomBytes(100));
    makeFile(name(13, 'pdf'), randomBytes(2_000));
    // adb nests a pushed folder inside a target that exists, so the target must not exist yet.
    sh(`rm -rf ${pushed}`);
    execFileSync(adbBin, ['-s', serial, 'push', resolve(work, 'files'), pushed], { stdio: 'ignore' });
    runAs(`mkdir -p files/share-test && cp ${pushed}/* files/share-test/`);
    device.launch(ACTIVITY);
    requireAppFront();
    sh('settings put system accelerometer_rotation 0');
    await waitFor('the tabs', (nodes) => Boolean(tab(nodes, en['tab.inbox'])), 60_000);

    // (a) One PDF: RN's capture screen titled with its name, the file under Attachments; Save stores it with a managed copy.
    let nodes = await share({ type: 'application/pdf', uris: [`file/${name(1, 'pdf')}`] }, modal(title(1)), 'the capture screen with the PDF');
    check(JSON.stringify(rows(nodes)) === JSON.stringify([name(1, 'pdf')]) && hasText(nodes, en['attachments.title']), `(a) the PDF is listed under Attachments (${rows(nodes)})`);
    await save(nodes);
    let tasks = stored([title(1)]);
    const [one] = tasks[title(1)];
    check(tasks[title(1)].length === 1 && one.attachments.length === 1 && one.attachments[0].uri.includes('/files/attachments/'),
        `(a) the task is stored once with its PDF copied into files/attachments (${JSON.stringify(tasks[title(1)])})`);
    check(deviceSha(one.attachments[0].uri) === createHash('sha256').update(local[name(1, 'pdf')]).digest('hex'), '(a) the copy has the shared bytes');
    await noStaged('(a)');

    // (b) Three files, one whose provider gives no name, size or type (RN's fallbacks: the URI's name, octet-stream).
    nodes = await share({ action: 'SEND_MULTIPLE', uris: [`file/${name(2, 'png')}`, `nometa/${name(3, 'csv')}`, `file/${name(4, 'pdf')}`] },
        modal(title(2)), 'the capture screen with three files');
    check(JSON.stringify(rows(nodes)) === JSON.stringify([name(2, 'png'), name(3, 'csv'), name(4, 'pdf')]), `(b) the three files are listed (${rows(nodes)})`);
    await save(nodes);
    tasks = stored([title(2)]);
    check(tasks[title(2)].length === 1 && tasks[title(2)][0].attachments.length === 3, `(b) the task is stored with three attachments (${JSON.stringify(tasks[title(2)])})`);
    await noStaged('(b)');

    // (c) Seven files: RN's six are listed; Cancel stores nothing.
    nodes = await share({ action: 'SEND_MULTIPLE', type: 'application/pdf', uris: [1, 2, 3, 4, 5, 6, 7].map((n) => `file/${name(`5-${n}`, 'pdf')}`) },
        modal(title('5-1')), 'the capture screen with seven files');
    check(rows(nodes).length === 6 && !rows(nodes).includes(name('5-7', 'pdf')), `(c) six of seven files are listed (${rows(nodes)})`);
    await cancel(nodes);
    check(stored([title('5-1')])[title('5-1')].length === 0, '(c) Cancel stored nothing');
    await noStaged('(c)');

    // (d) A file over 50 MiB (its provider gives no size) and a blocked type beside a PDF: one notice for both, the PDF listed.
    nodes = await share({ action: 'SEND_MULTIPLE', uris: [`nosize/${name(6, 'bin')}`, `file/${name(7, 'exe')}`, `file/${name(8, 'pdf')}`] },
        modal(title(8)), 'the capture screen with the PDF only', 60_000);
    const skipped = en['share.filesSkipped'].replace('{{count}}', '2');
    check(JSON.stringify(rows(nodes)) === JSON.stringify([name(8, 'pdf')]), `(d) only the PDF is listed (${rows(nodes)})`);
    check(hasText(nodes, skipped) || Boolean(await waitFor('the skipped notice', (current) => hasText(current, skipped), 5_000)), '(d) core\'s notice counts the two skipped files');
    nodes = await screen();
    await cancel(nodes);
    check(largestCopy() <= 50 * MIB, `(d) no copy over 50 MiB is left in files/attachments (largest ${largestCopy()} bytes)`);
    await noStaged('(d)');

    // (e) A file that cannot be read: RN's "Share unavailable", and no capture screen.
    nodes = await share({ type: 'application/pdf', uris: [`gone/${name(9, 'pdf')}`] }, (current) => hasText(current, en['share.unavailable']), 'the share failure notice');
    check(!tagged(nodes, 'capture-modal'), '(e) an unreadable file shows "Share unavailable" and opens nothing');
    await noStaged('(e)');

    // (f) A subject and text with the file: RN's Android share module sends the files only, so the file's name is the title.
    nodes = await share({ type: 'application/pdf', uris: [`file/${name(10, 'pdf')}`], subject: title(11), text: title(12) }, modal(title(10)), 'the capture screen titled with the file');
    check(!tagged(nodes, 'capture-modal-description') && rows(nodes).length === 1, '(f) a file share\'s subject and text are left out, as RN\'s Android share leaves them');
    await cancel(nodes);

    // (g) A share sent to a stopped app opens after the boot, and saves.
    sh(`am force-stop ${PKG}`);
    await sleep(1000);
    nodes = await share({ type: 'application/pdf', uris: [`file/${name(13, 'pdf')}`] }, modal(title(13)), 'the capture screen after a cold start', 90_000, false);
    await save(nodes);
    tasks = stored([title(13)]);
    check(tasks[title(13)].length === 1 && tasks[title(13)][0].attachments.length === 1, '(g) the cold-started share is stored with its file');
    await noStaged('(g)');

    // (h) A hostile share naming this app's own files: never opened, so nothing is copied, and RN's "Share unavailable".
    const managed = tasks[title(13)][0].attachments[0].uri.split('/files/attachments/')[1];
    const own = `${PKG}.FileSystemFileProvider/attachments/${managed}`;
    for (const [label, uri] of [['a file:// URI', `file:///data/user/0/${PKG}/files/${DB}`], ['this app\'s own provider', `content://${own}`],
        ['its provider behind a 0@ user prefix', `content://0@${own}`], ['its provider behind an encoded user prefix', `content://0%40${own}`]]) {
        const copies = runAs('ls files/attachments').split(/\s+/).filter(Boolean).length;
        nodes = await share({ type: 'application/pdf', uris: [], raw: [uri] }, (current) => hasText(current, en['share.unavailable']), `the refusal of ${label}`);
        check(!tagged(nodes, 'capture-modal') && runAs('ls files/attachments').split(/\s+/).filter(Boolean).length === copies,
            `(h) ${label} shows "Share unavailable" and copies nothing`);
        await noStaged('(h)');
        // The next refusal must show its own notice.
        await waitFor('the notice to go', (current) => !hasText(current, en['share.unavailable']), 20_000);
    }
    console.log('Share files device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
