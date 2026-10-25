// "Continue without these files" check for the isolated native Android development app, on this computer and the test phone only.
//
//   node apps/android-native/scripts/check-continue-without-files-device.mjs <adb-serial> [apk]
//
// It starts a local WebDAV server (sync-harness.mjs, reached through `adb reverse`; never a real server) with two folders, A
// and B, and a second device on this computer (the same native bundle in a Node VM). Then:
//   (1) the phone syncs to folder A; the second device adds a project with a file there, and A then loses that file, so the
//       phone holds the attachment (a missing file) but never its bytes;
//   (2) the phone's WebDAV form switches to folder B, which has nothing: Save asks RN's question, listing the file;
//   (3) Cancel leaves the stored setting on folder A and writes nothing to B;
//   (4) Save again, then Continue: folder B is stored and written, and the project's attachment shows "Missing file";
//   (5) Remove on that attachment soft-deletes it (a file that exists nowhere goes by hand), and sync Off again.
// A leftover attachment of an earlier cut-off run (a file that exists nowhere would stall every later check's switch of sync
// location) is removed first the same way.
// A screenshot of the question is saved for the RN-vs-native pair. It installs with `install -r` (development data stays),
// touches only the development package, removes the port mapping, and leaves the phone on its home screen.
// Exit 0 = pass, 1 = fail, 2 = refused, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, check, connect, evidenced, fail, inboxCount, inEditor, inList, logStamp, linesAfter, Stopped, switchOn, tab, tabSelected, tagged, withDescription } from './device.mjs';
import { cleanupOnExit } from './check-net-device.mjs';
import { hostDevice, serveWebdav } from './sync-harness.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-continue-without-files-device.mjs <adb-serial> [apk]');
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
const TAG = 'MindwtrNativeDev';
const UI_FILE = '/data/local/tmp/mindwtr-native-dev-ui.xml';
const DB = 'mindwtr-native-dev.db';
const work = resolve(app, 'android/build/continue-without-files-check');
const { en } = await import(resolve(repo, 'packages/core/src/i18n/locales/en.ts'));

// This run's names: digits and plain letters only (the phone types them through an English layout).
const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const WEBDAV_PORT = Number(process.env.MINDWTR_CONTINUE_WEBDAV_PORT ?? 18774);
const USER = `cwfuser${run}`;
const PASSWORD = `pw${run}secret`;
const folderA = `/dav/mindwtr-cwf-a-${run}`;
const folderB = `/dav/mindwtr-cwf-b-${run}`;
const urlOf = (folder) => `http://127.0.0.1:${WEBDAV_PORT}${folder}`;
const fieldsA = { url: urlOf(folderA), username: USER, password: PASSWORD, allowInsecureHttp: true };
const names = { project: `CWF project ${run}`, file: `cwf${run}.bin` };
mkdirSync(work, { recursive: true });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting } = device;
const logs = () => device.logs(pid(), TAG);

// ---- The phone's storage ----
const pullFile = (remote, name) => {
    const dir = resolve(work, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const base = remote.split('/').pop();
    const folder = remote.slice(0, remote.length - base.length - 1);
    const present = sh(`run-as ${PKG} ls ${folder}`).split(/\s+/);
    for (const suffix of ['', '-wal', '-shm', '-journal']) if (present.includes(`${base}${suffix}`)) device.pull(`${remote}${suffix}`, resolve(dir, `${base}${suffix}`));
    return resolve(dir, base);
};
const sqlite = (file, sql) => {
    const out = execFileSync('sqlite3', ['-json', file, sql], { encoding: 'utf8' }).trim();
    return out ? JSON.parse(out) : [];
};
const quote = (text) => `'${text.replace(/'/g, "''")}'`;
const projectAttachments = () => {
    const row = sqlite(pullFile(`files/${DB}`, 'db'), `SELECT attachments FROM projects WHERE title = ${quote(names.project)} AND deletedAt IS NULL`)[0];
    return row?.attachments ? JSON.parse(row.attachments) : [];
};
/** RN's AsyncStorage on the phone (databases/RKStorage): the stored sync settings. */
const storedUrl = () => Object.fromEntries(sqlite(pullFile('databases/RKStorage', 'rk'), 'SELECT key, value FROM catalystLocalStorage')
    .map((row) => [row.key, row.value]))['@mindwtr_webdav_url'];

// ---- UI (core's English) ----
const sheetOpen = (nodes) => Boolean(tagged(nodes, 'more-sheet'));
const onSync = (nodes) => Boolean(tagged(nodes, 'settings-sync'));
const onInbox = (nodes) => !tagged(nodes, 'quick-capture') && !tagged(nodes, 'menu-screen') && !inEditor(nodes)
    && tabSelected(nodes, en['tab.inbox']) && Number.isFinite(inboxCount(nodes));
const withPrefix = (nodes, prefix) => nodes.find((node) => (node['content-desc'] ?? '').startsWith(prefix));
const question = (nodes) => nodes.some((node) => node.text === en['settings.syncMissingFilesTitle']);
// The dialog is its own window, so its buttons carry no resource ids: they are found by their words, drawn in capitals as
// RN's Android Alert draws them.
const continueButton = (nodes) => nodes.find((node) => node.text === en['settings.syncMissingFilesContinue'].toUpperCase());
const cancelButton = (nodes) => nodes.find((node) => node.text === en['common.cancel'].toUpperCase());
const hideKeyboard = async () => {
    if (!/mInputShown=true/.test(sh('dumpsys input_method'))) return;
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await sleep(600);
};
const toTabs = async () => {
    for (let step = 0; step < 8; step += 1) {
        const nodes = await screen();
        if (tab(nodes, en['tab.menu']) && !tagged(nodes, 'menu-screen') && !sheetOpen(nodes) && !inEditor(nodes)) return nodes;
        await hideKeyboard();
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(1000);
    }
    return fail('the tabs did not come back');
};
const reveal = (find, description, fromTop = true) => device.revealNode(find, description, fromTop);
const openSync = async () => {
    const nodes = await screen();
    if (onSync(nodes)) return nodes;
    let current = await toTabs();
    current = await tapExpecting(tab(current, en['tab.menu']) ?? fail('no Menu tab'), sheetOpen, 'the More sheet');
    await tapExpecting(withDescription(await device.settle(current), en['nav.settings']) ?? fail('no Settings tile'),
        (next) => Boolean(tagged(next, 'settings-main')), 'Settings');
    return tapExpecting(await reveal((next) => withPrefix(next, `${en['settings.sync']}. `), 'Sync row'), onSync, 'Settings › Sync', 30_000);
};
const typeInto = async (node, text) => {
    await tap(node);
    await sleep(300);
    requireAppFront();
    sh('input keycombination KEYCODE_CTRL_LEFT KEYCODE_A');
    sh('input keyevent KEYCODE_DEL');
    sh(`input text '${text}'`);
    await sleep(500);
};
const fill = async (tag, text) => typeInto(await reveal((current) => tagged(current, tag), tag), text);
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
const commands = (operation, since = '') => linesAfter(logs().replace(/\\/g, ''), since)
    .filter((line) => line.includes(`"operation":"${operation}"`) && line.includes('"outcome":"saved"')).length;
const runCommand = async (tag, operation, description, timeoutMs = 240_000) => {
    const since = logStamp(logs());
    await tapTag(tag, () => commands(operation, since) > 0, description, timeoutMs);
};
/** Projects of earlier runs that still hold a live file attachment. */
const leftovers = () => sqlite(pullFile(`files/${DB}`, 'db'),
    "SELECT p.title AS project, j.value->>'title' AS file FROM projects p, json_each(p.attachments) j WHERE p.deletedAt IS NULL "
    + "AND p.title LIKE 'CWF project %' AND j.value->>'kind' = 'file' AND j.value->>'deletedAt' IS NULL");
/** Projects showing its list (Back from an open project: the tab keeps the last project open). */
const projectList = async () => {
    let nodes = await toTabs();
    nodes = await tapExpecting(tab(nodes, en['nav.projects']), (current) => tabSelected(current, en['nav.projects']), 'Projects');
    // An open project shows its title field and Details controls (scrolled: not always its Details toggle).
    const inProject = (current) => current.some((node) => /(^|\/)project-(title-input|details-[a-z]+|attachment-add-link)$/.test(node['resource-id'] ?? ''));
    for (let step = 0; step < 4 && inProject(nodes); step += 1) {
        await hideKeyboard();
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(1000);
        nodes = await screen();
    }
    return inProject(nodes) ? fail('the project list did not come back') : nodes;
};
/** Opens [project] in Projects with its Details, and taps Remove beside [file]; answers once the row is gone. */
const removeProjectFile = async (project, file) => {
    await projectList();
    let nodes = await device.reveal(project);
    nodes = await tapExpecting(inList(nodes, project) ?? fail(`no project row ${project}`), (current) => Boolean(tagged(current, 'project-details-toggle')), 'the project');
    if (!tagged(nodes, 'project-attachment-add-link')) {
        nodes = await tapExpecting(tagged(nodes, 'project-details-toggle'), (current) => Boolean(tagged(current, 'project-attachment-add-link')), 'the project Details');
    }
    const row = await reveal((current) => current.find((node) => node.text === file), file, false);
    nodes = await screen();
    const [, top, , bottom] = box(row);
    const remove = nodes.find((node) => node.text === en['attachments.remove'] && box(node)[1] <= (top + bottom) / 2 && box(node)[3] >= (top + bottom) / 2);
    await tapExpecting(remove ?? fail(`no Remove beside ${file}`), (current) => !current.some((node) => node.text === file), `${file} removed`);
};
const until = async (description, holds, timeoutMs = 120_000, everyMs = 2_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await holds()) return;
        if (Date.now() > deadline) fail(`timed out waiting for ${description}`);
        await sleep(everyMs);
    }
};

let dav = null;
let second = null;
const cleanup = cleanupOnExit([
    () => execFileSync(adbBin, ['-s', serial, 'reverse', '--remove', `tcp:${WEBDAV_PORT}`], { stdio: 'ignore' }),
    () => { void dav?.close(); },
    () => second?.stop(),
    () => sh(`rm -f ${UI_FILE}`),
]);

try {
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${sha256(readFileSync(apk))}\nrun: ${run}`);
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    dav = await serveWebdav({ port: WEBDAV_PORT, username: USER, password: PASSWORD });
    try { execFileSync(adbBin, ['-s', serial, 'reverse', '--remove', `tcp:${WEBDAV_PORT}`], { stdio: 'ignore' }); } catch { /* none mapped */ }
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    await device.stopApp();
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    device.launch(ACTIVITY);
    await waitFor('the Inbox', onInbox, 60_000);

    for (const { project, file } of leftovers()) {
        console.log(`note - removing an earlier run's attachment ${file} (${project})`);
        await removeProjectFile(project, file);
    }
    check(leftovers().length === 0, 'no earlier run left a file attachment that exists nowhere');

    // (1) Folder A: the phone, then the second device's project file, which A then loses.
    let nodes = await openSync();
    if (!nodes.some((node) => node.text === en['settings.syncOff'])) {
        console.log('note - a backend left by an earlier run is set Off before the check maps its port');
        await tapTag('sync-backend-off', (current) => current.some((node) => node.text === en['settings.syncOff']), 'Sync off');
    }
    execFileSync(adbBin, ['-s', serial, 'reverse', `tcp:${WEBDAV_PORT}`, `tcp:${WEBDAV_PORT}`], { stdio: 'ignore' });
    await tapTag('sync-backend-webdav', (current) => Boolean(tagged(current, 'sync-url')), 'the WebDAV form');
    await fill('sync-url', fieldsA.url);
    await insecureOn();
    await fill('sync-username', USER);
    await fill('sync-password', PASSWORD);
    await runCommand('sync-save', 'saveSyncBackend', 'Save (folder A)');
    await until('the phone\'s data in folder A', () => dav.state.files.has(`${folderA}/data.json`), 60_000);
    second = await hostDevice({ bundle, name: 'second', filesRoot: resolve(work, `second-${run}`),
        log: (line) => { if (/error|fail/i.test(line)) console.log(`note - ${line.slice(0, 240)}`); } });
    await second.boot();
    await second.configure('webdav', fieldsA);
    const projectId = (await second.call('createProject', names.project, '', randomUUID())).id;
    const bytes = Buffer.from(`mindwtr cwf ${run} ${'x'.repeat(2048)}`);
    const source = resolve(second.files.cache, names.file);
    writeFileSync(source, bytes);
    const added = await second.call('menuCommand', 'attachmentAddFile', JSON.stringify({ requestId: randomUUID(), owner: { kind: 'project', projectId },
        source: 'file', picked: { uri: `file://${source}`, name: names.file, mimeType: 'application/octet-stream', size: bytes.length } }));
    if (added.kind !== 'saved') fail(`the second device's file was not added (${JSON.stringify(added)})`);
    const fileId = added.ids[0];
    await second.syncNow('webdav', { ...fieldsA, password: null });
    const blob = [...dav.state.files.keys()].find((path) => path.startsWith(`${folderA}/`) && path.includes(fileId));
    check(Boolean(blob), '(1) the second device uploaded the project file to folder A');
    dav.state.files.delete(blob);
    await openSync();
    await runCommand('sync-now', 'syncNow', 'Sync now (folder A, the file gone)');
    await until('the project file on the phone', () => projectAttachments().some((a) => a.id === fileId), 60_000, 3_000);
    const kept = projectAttachments().find((a) => a.id === fileId);
    check(!kept.deletedAt && Boolean(kept.cloudKey) && kept.localStatus !== 'available',
        '(1) the phone holds the attachment as a missing file (live, keyed, no bytes) after folder A lost it');

    // (2) Folder B, which has nothing: Save asks RN's question, listing the file.
    await openSync();
    await fill('sync-url', urlOf(folderB));
    await hideKeyboard();
    nodes = await tapExpecting(await reveal((current) => tagged(current, 'sync-save'), 'sync-save'), question, 'the missing-files question', 240_000);
    check(nodes.some((node) => (node.text ?? '').includes(names.file) && (node.text ?? '').includes(names.project)),
        `(2) the question lists "${names.file} (${names.project})"`);
    check(Boolean(continueButton(nodes)) && Boolean(cancelButton(nodes)),
        '(2) the question offers CONTINUE WITHOUT THESE FILES and CANCEL (RN\'s Android Alert capitals)');
    const shot = resolve(work, `native-question-${run}.png`);
    writeFileSync(shot, device.adbRaw('exec-out', 'screencap', '-p'));
    console.log(`info - native question screenshot: ${shot}`);

    // (3) Cancel: the stored setting stays on folder A, and folder B gets nothing.
    await tapExpecting(cancelButton(nodes), (current) => !question(current), 'Cancel');
    await sleep(2_000);
    check(storedUrl() === fieldsA.url && ![...dav.state.files.keys()].some((path) => path.startsWith(`${folderB}/`) && path.endsWith('data.json')),
        '(3) Cancel left the stored URL on folder A and wrote no document to folder B');

    // (4) Save again, then Continue: folder B is stored and written; the attachment shows "Missing file".
    nodes = await tapTag('sync-save', question, 'the missing-files question again', 240_000);
    await tapExpecting(continueButton(nodes), (current) => !question(current), 'Continue without these files');
    await until('folder B stored and written', () => storedUrl() === urlOf(folderB) && dav.state.files.has(`${folderB}/data.json`), 240_000, 3_000);
    check(true, '(4) Continue stored folder B and wrote the library there');
    const after = projectAttachments().find((a) => a.id === fileId);
    check(Boolean(after) && !after.deletedAt && Boolean(after.cloudKey), '(4) the attachment is still live and keyed after Continue');
    check(/Sync activation continued without attachment files/.test(logs()), '(4) the app log has the activation-continue-without-files line');
    await projectList();
    nodes = await device.reveal(names.project);
    nodes = await tapExpecting(inList(nodes, names.project) ?? fail('no project row'), (current) => Boolean(tagged(current, 'project-details-toggle')), 'the project');
    nodes = await tapExpecting(tagged(nodes, 'project-details-toggle'), (current) => Boolean(tagged(current, 'project-attachment-add-link')), 'the project Details');
    nodes = await waitFor(`"${en['attachments.missing']}" beside the file`, (current) => current.some((node) => node.text === en['attachments.missing'])
        && current.some((node) => (node.text ?? '') === names.file || (node['content-desc'] ?? '').includes(names.file)), 20_000);
    check(!nodes.some((node) => node.text === en['attachments.download']), `(4) the attachment shows "${en['attachments.missing']}", not "${en['attachments.download']}"`);

    // (5) Remove by hand, then sync Off again.
    await removeProjectFile(names.project, names.file);
    await until('the attachment soft-deleted', () => projectAttachments().find((a) => a.id === fileId)?.deletedAt, 30_000, 2_000);
    check(true, '(5) Remove soft-deleted the attachment whose file exists nowhere');
    await openSync();
    await tapTag('sync-backend-off', (current) => current.some((node) => node.text === en['settings.syncOff']), 'Sync off');
    await toTabs();
    console.log('Continue without files device check passed');
} catch (error) {
    try {
        console.log(`evidence - app log (sync):\n${logs().split('\n').filter((line) => /sync|Sync|attachment/.test(line))
            .slice(-60).map((line) => line.slice(0, 300)).join('\n')}`);
    } catch { /* the app is gone */ }
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    if (process.exitCode === 1 && dav) {
        try {
            if (!front().includes(`${PKG}/`)) device.launch(ACTIVITY);
            await openSync();
            await tapTag('sync-backend-off', (current) => current.some((node) => node.text === en['settings.syncOff']), 'Sync off after a failure');
        } catch (error) {
            console.log(`warn - Sync could not be set Off after the failure: ${error.message}`);
        }
    }
    cleanup();
    await sleep(500);
}
