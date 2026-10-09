// Attachments check for the isolated native Android development app (pass A2), on this computer and the test phone only.
//
//   node apps/android-native/scripts/check-attachments-device.mjs <adb-serial> [apk]
//
// It pushes two test files to the phone's Download/mindwtr-test-a2/ (a PDF and a PNG; removed on exit), starts a local
// WebDAV folder (sync-harness.mjs, reached through `adb reverse`; never a real server) and a second device on this computer
// (the same native bundle in a Node VM, with a file bridge on a folder here). Then:
//   (1) the phone syncs to the local folder (Settings › Sync, as a user fills it); the second device joins it and adds a project;
//   (2) the task editor: Add file picks the PDF in the system's document picker, Add photo picks the PNG in the photo picker,
//       Add link saves a link; Save stores the three once (the pulled database) and the two files' bytes under
//       files/attachments/ (their SHA-256 equals the pushed files');
//   (3) Open on the PDF starts a viewer through the FileProvider (another app comes to the front; Back returns);
//   (4) Remove on the link, then Save: the link is soft-deleted (deletedAt), the others stay;
//   (5) the phone's Sync now uploads both files; the second device syncs and holds the same bytes;
//   (6) the project's Attachments card: Add link writes at once (the database), Remove soft-deletes it;
//   (7) a kill during an install: the second device adds a file to the project; the phone's sync dies once the installer's
//       journal is on disk (debug property install_stop=journal); the next boot's recovery rolls it back (no installer file,
//       no half file), and the next sync installs the whole file;
//   (8) a remote 404: a project file whose remote copy is gone is marked unrecoverable (cloudKey cleared, soft-deleted) and no
//       bytes are written; the PDF's remote copy removed, a sync keeps its local bytes;
//   (9) sync Off again.
// It installs with `install -r` (development data stays), touches only the development package, never launches over another
// app, clears its debug property, removes the port mapping and the pushed files, and puts the keyboard back. Leave the phone on
// its home screen. Exit 0 = pass, 1 = fail, 2 = refused, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, button, check, connect, evidenced, fail, inboxCount, inEditor, inList, isOn, mainList, Stopped, switchOn, tab, tabSelected, tagged, withDescription } from './device.mjs';
import { cleanupOnExit } from './check-net-device.mjs';
import { hostDevice, serveWebdav } from './sync-harness.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-attachments-device.mjs <adb-serial> [apk]');
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
const PHONE_DIR = '/sdcard/Download/mindwtr-test-a2';
const work = resolve(app, 'android/build/attachments-check');
const { en } = await import(resolve(repo, 'packages/core/src/i18n/locales/en.ts'));
const { getAttachmentDisplayTitle } = await import(resolve(repo, 'packages/core/src/attachment-link-utils.ts'));
/** A link's row title as core shows it (RN's getAttachmentDisplayTitle: no scheme). */
const linkRow = (uri) => getAttachmentDisplayTitle({ kind: 'link', title: uri, uri });

// This run's names: digits and plain letters only (the phone types them through an English layout).
const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const WEBDAV_PORT = Number(process.env.MINDWTR_ATTACHMENTS_WEBDAV_PORT ?? 18773);
const FOLDER = `/dav/mindwtr-a2-${run}`;
const USER = `a2user${run}`;
const PASSWORD = `pw${run}secret`;
const webdavFields = { url: `http://127.0.0.1:${WEBDAV_PORT}${FOLDER}`, username: USER, password: PASSWORD, allowInsecureHttp: true };
const names = { task: `94${run}`, project: `A2 project ${run}`, pdf: `a2doc${run}.pdf`, png: `a2pic${run}.png`, link: `https://example.com/a2/${run}` };

// ---- The test files (made here, pushed to the phone's Download folder) ----
mkdirSync(work, { recursive: true });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pdfBytes = Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n`
    + `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n% mindwtr a2 ${run}\n`);
const pngFile = resolve(work, names.png);
execFileSync('magick', ['-size', '96x96', `xc:#${run.slice(-6)}`, '-fill', 'white', '-draw', 'circle 48,48 48,20', pngFile]);
const pngBytes = readFileSync(pngFile);
writeFileSync(resolve(work, names.pdf), pdfBytes);
const extraBytes = (label) => Buffer.from(`mindwtr a2 ${label} ${run} ${'x'.repeat(2048)}`);

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting } = device;
const logs = () => device.logs(pid(), TAG);
const allLogs = () => device.adbRaw('logcat', '-d', '-s', `${TAG}:*`).toString('utf8');
const runAs = (command) => sh(`run-as ${PKG} ${command}`);

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
/** The stored attachments of the task or project titled [title] (all records, removed ones included). */
const stored = (table, title) => {
    const row = sqlite(pullFile(`files/${DB}`, 'db'), `SELECT attachments FROM ${table} WHERE title = ${quote(title)} AND deletedAt IS NULL`)[0];
    return row?.attachments ? JSON.parse(row.attachments) : [];
};
const live = (list) => list.filter((attachment) => !attachment.deletedAt);
/** The phone's files/attachments/ names, and one file's SHA-256 (toybox), or null when it is not there. */
const attachmentFiles = () => runAs('ls -a files/attachments 2>/dev/null || true').split(/\s+/).filter((name) => name && name !== '.' && name !== '..');
const phoneSha = (uri) => {
    const path = uri.replace(/^file:\/\/\/data\/user\/0\/[^/]+\//, '').replace(/^file:\/\/\/data\/data\/[^/]+\//, '');
    const out = runAs(`sha256sum ${path} 2>/dev/null || true`);
    return /^[0-9a-f]{64}/.exec(out)?.[0] ?? null;
};

// ---- UI (core's English) ----
const inPopup = (nodes) => Boolean(tagged(nodes, 'quick-capture'));
const sheetOpen = (nodes) => Boolean(tagged(nodes, 'more-sheet'));
const onSync = (nodes) => Boolean(tagged(nodes, 'settings-sync'));
const onInbox = (nodes) => !inPopup(nodes) && !tagged(nodes, 'menu-screen') && !tagged(nodes, 'global-search') && !inEditor(nodes)
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
        if (tab(nodes, en['tab.menu']) && !tagged(nodes, 'menu-screen') && !sheetOpen(nodes) && !inEditor(nodes) && !inPopup(nodes)) return nodes;
        await hideKeyboard();
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(1000);
    }
    return fail('the tabs did not come back');
};
const toInbox = async () => {
    let nodes = await toTabs();
    if (!tabSelected(nodes, en['tab.inbox'])) nodes = await tapExpecting(tab(nodes, en['tab.inbox']), (current) => tabSelected(current, en['tab.inbox']), 'the Inbox');
    if (!onInbox(nodes)) await device.toTop();
    return waitFor('the Inbox', onInbox, 30_000);
};
/** The node [find] picks, scrolled into the screen's main list (from the top, then down). */
const reveal = async (find, description, fromTop = true) => {
    let nodes = fromTop ? await device.toTop() : await screen();
    const inView = (current) => {
        const node = find(current);
        const list = mainList(current);
        return node && (!list || (box(node)[1] >= box(list)[1] && box(node)[3] <= box(list)[3] - 40)) ? node : null;
    };
    for (let step = 0; step < 14 && !inView(nodes); step += 1) nodes = await device.swipe(nodes, 'down');
    return inView(nodes) ?? fail(`no ${description} on screen`);
};
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
/** How many times [operation] answered (host-entry.ts taskResult's line; its context's quotes arrive escaped). */
const commands = (operation, outcome = 'saved') => logs().replace(/\\/g, '').split('\n')
    .filter((line) => line.includes(`"operation":"${operation}"`) && line.includes(`"outcome":"${outcome}"`)).length;
const runCommand = async (tag, operation, description, timeoutMs = 120_000) => {
    const before = commands(operation);
    await tapTag(tag, () => commands(operation) > before, description, timeoutMs);
};
const syncNow = async (description) => {
    await openSync();
    await runCommand('sync-now', 'syncNow', description);
};
const capture = async (text) => {
    await toInbox();
    const nodes = await device.openCapture();
    await device.focusAtEnd(tagged(nodes, 'capture-title') ?? fail('no capture field'));
    requireAppFront();
    sh(`input text '${text}'`);
    await waitFor(`"${text}" in the capture field`, (current) => tagged(current, 'capture-title')?.text === text, 15_000);
    await tapExpecting(button(await screen(), en['common.save']) ?? fail('no Save'), onInbox, 'the capture to close the popup');
};
const until = async (description, holds, timeoutMs = 120_000, everyMs = 2_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await holds()) return;
        if (Date.now() > deadline) fail(`timed out waiting for ${description}`);
        await sleep(everyMs);
    }
};

// ---- The editor's attachments ----
/** The editor's attachment rows: the titles core lists (each row carries the test tag `attachment-row`). */
const rowTitles = (nodes) => nodes.filter((node) => /(^|\/)attachment-row$/.test(node['resource-id'] ?? ''))
    .map((row) => { const [l, t, r, b] = box(row); return nodes.find((node) => node.text && node.class === 'android.widget.TextView'
        && box(node)[0] >= l && box(node)[1] >= t && box(node)[2] <= r && box(node)[3] <= b)?.text; }).filter(Boolean);
/** The editor's Attachments field on screen: scrolled to, its Details section opened when it is folded. */
const revealAttachments = async () => {
    let nodes = await screen();
    for (let step = 0; step < 14 && !tagged(nodes, 'attachment-add-file'); step += 1) {
        const next = await device.swipe(nodes, 'down');
        if (device.signature(next) === device.signature(nodes)) break;
        nodes = next;
    }
    if (!tagged(nodes, 'attachment-add-file')) {
        await tap(withDescription(nodes, en['taskEdit.details']) ?? fail('no Details section'));
        await sleep(800);
    }
    return reveal((current) => tagged(current, 'attachment-add-file'), 'Add file', false);
};
const otherAppFront = () => !front().includes(`${PKG}/`);
const backToApp = async () => {
    for (let step = 0; step < 6 && !front().includes(`${PKG}/`); step += 1) {
        sh('input keyevent KEYCODE_BACK');
        await sleep(1200);
    }
    if (!front().includes(`${PKG}/`)) throw new Stopped(`the app did not come back to the front: ${front().trim()}`);
};
/** Nodes of whatever app is in front (the system pickers), without the app-in-front guard. */
const anyScreen = async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            const xml = device.adbRaw('exec-out', 'uiautomator', 'dump', '/dev/tty').toString('utf8');
            if (xml.includes('<hierarchy')) {
                return [...xml.matchAll(/<node [^>]*>/g)].map(([tag]) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)]
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
/** The system document picker (ACTION_OPEN_DOCUMENT): the file named [name], found in the list or through its search. */
const pickDocument = async (name) => {
    await until('the document picker', otherAppFront, 15_000, 500);
    await sleep(1500);
    for (let attempt = 0; attempt < 3; attempt += 1) {
        let nodes = await anyScreen();
        const hit = nodes.find((node) => node.text === name);
        if (hit) return tapAny(hit);
        // The picker's search: its button, the query, Enter, then the result.
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
/** The system photo picker (PickVisualMedia): the newest photo, which is this run's PNG (pushed last; its name is checked after). */
const pickNewestPhoto = async () => {
    await until('the photo picker', otherAppFront, 15_000, 500);
    await sleep(2000);
    const nodes = await anyScreen();
    // The thumbnail's description ("Photo taken on …") sits on a non-clickable child of the clickable cell; both share its bounds.
    const photo = nodes.filter((node) => /^(Photo|Image)\b/i.test(node['content-desc'] ?? ''))
        .sort((a, b) => box(a)[1] - box(b)[1] || box(a)[0] - box(b)[0])[0];
    if (!photo) return fail('the photo picker shows no photo');
    return tapAny(photo);
};

let dav = null;
let second = null;
const cleanup = cleanupOnExit([
    () => sh('setprop debug.mindwtr.native.install_stop \'\''),
    () => execFileSync(adbBin, ['-s', serial, 'reverse', '--remove', `tcp:${WEBDAV_PORT}`], { stdio: 'ignore' }),
    () => { void dav?.close(); },
    () => second?.stop(),
    () => sh(`rm -rf ${PHONE_DIR}`),
    () => sh(`rm -f ${UI_FILE}`),
]);

try {
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${sha256(readFileSync(apk))}\nrun: ${run}`);
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    // The test files; the media scanner indexes them. The PNG is dated far ahead (removed on exit) so the photo picker, which
    // lists the newest first, shows it before any photo another check or the user left (run 2: "29.png" was newer).
    sh(`mkdir -p ${PHONE_DIR}`);
    execFileSync(adbBin, ['-s', serial, 'push', resolve(work, names.pdf), `${PHONE_DIR}/${names.pdf}`], { stdio: 'ignore' });
    execFileSync(adbBin, ['-s', serial, 'push', pngFile, `${PHONE_DIR}/${names.png}`], { stdio: 'ignore' });
    sh(`touch -t 203712312359 ${PHONE_DIR}/${names.png}`);
    for (const file of [names.pdf, names.png]) sh(`am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://${PHONE_DIR}/${file} >/dev/null 2>&1 || true`);
    await until('the media store to list the PNG', () => sh(`content query --uri content://media/external/images/media --projection _display_name --where "_display_name='${names.png}'"`)
        .includes(names.png), 30_000, 1_000);
    check(true, `the test files are in ${PHONE_DIR} (PDF ${pdfBytes.length} bytes, PNG ${pngBytes.length} bytes) and the PNG is in the media store`);

    dav = await serveWebdav({ port: WEBDAV_PORT, username: USER, password: PASSWORD });
    execFileSync(adbBin, ['-s', serial, 'reverse', `tcp:${WEBDAV_PORT}`, `tcp:${WEBDAV_PORT}`], { stdio: 'ignore' });
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    sh('setprop debug.mindwtr.native.install_stop \'\'');
    await device.stopApp();
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    device.launch(ACTIVITY);
    await waitFor('the Inbox', onInbox, 60_000);

    // (1) The phone and the second device on one local WebDAV folder; the second device adds the project.
    let nodes = await openSync();
    if (!nodes.some((node) => node.text === en['settings.syncOff'])) {
        await tapTag('sync-backend-off', (current) => current.some((node) => node.text === en['settings.syncOff']), 'Sync off');
    }
    await tapTag('sync-backend-webdav', (current) => Boolean(tagged(current, 'sync-url')), 'the WebDAV form');
    await fill('sync-url', webdavFields.url);
    await insecureOn();
    await fill('sync-username', USER);
    await fill('sync-password', PASSWORD);
    await runCommand('sync-save', 'saveSyncBackend', 'Save');
    await until('the phone\'s data in the folder', () => dav.state.files.has(`${FOLDER}/data.json`), 60_000);
    second = await hostDevice({ bundle, name: 'second', filesRoot: resolve(work, `second-${run}`),
        log: (line) => { if (/error|fail/i.test(line)) console.log(`note - ${line.slice(0, 240)}`); } });
    await second.boot();
    await second.configure('webdav', webdavFields);
    // core's createProject names the project by its request UUID.
    const projectId = (await second.call('createProject', names.project, '', randomUUID())).id;
    await second.syncNow('webdav', { ...webdavFields, password: null });
    await syncNow('Sync now (the second device\'s project)');
    await until('the project on the phone', () => sqlite(pullFile(`files/${DB}`, 'db'), `SELECT id FROM projects WHERE id = ${quote(projectId)}`).length === 1, 30_000);
    check(true, '(1) the phone synced to the local WebDAV folder and has the second device\'s project');

    // (2) The editor: Add file, Add photo, Add link, Save.
    await capture(names.task);
    nodes = await device.reveal(names.task);
    await tapExpecting(inList(nodes, names.task) ?? fail('no task row'), inEditor, 'the editor');
    await revealAttachments();
    await tapExpecting(tagged(await screen(), 'attachment-add-file'), otherAppFront, 'the document picker', 15_000).catch(() => null);
    await pickDocument(names.pdf);
    await until('the app back with the PDF row', async () => front().includes(`${PKG}/`) && rowTitles(await screen()).includes(names.pdf), 30_000, 1_000);
    check(true, `(2) Add file picked ${names.pdf} in the system's document picker; the editor lists it`);
    await revealAttachments();
    await tap(tagged(await screen(), 'attachment-add-photo') ?? fail('no Add photo'));
    await pickNewestPhoto();
    await until('the app back with a photo row', async () => front().includes(`${PKG}/`) && rowTitles(await screen()).length >= 2, 30_000, 1_000);
    const photoRow = rowTitles(await screen()).find((title) => title !== names.pdf);
    // The photo picker names a pick by its media ID ("31.png": its DISPLAY_NAME, which RN's expo-image-picker reads too), so the
    // pick is told by its bytes: the draft's new copy under files/attachments/ must be this run's PNG.
    const pngSha = sha256(pngBytes);
    if (!attachmentFiles().some((name) => phoneSha(`file:///data/user/0/${PKG}/files/attachments/${name}`) === pngSha)) {
        // Not this run's PNG (the picker's newest is someone's photo): discard the draft, so its copies go, and stop.
        await backToApp();
        await hideKeyboard();
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        const discard = button(await waitFor('the discard question', (current) => Boolean(button(current, en['common.discard'])), 10_000), en['common.discard']);
        await tapExpecting(discard, (current) => !inEditor(current), 'the draft discarded');
        throw new Stopped(`the photo picker's newest photo ("${photoRow}") is not this run's PNG ${names.png}; the draft was discarded`);
    }
    check(true, `(2) Add photo picked ${names.png} in the photo picker (its bytes; the picker names it "${photoRow}"); the editor lists it`);
    await revealAttachments();
    await tapExpecting(tagged(await screen(), 'attachment-add-link') ?? fail('no Add link'), (current) => Boolean(tagged(current, 'attachment-link-sheet')), 'the link sheet');
    await typeInto(tagged(await screen(), 'attachment-link-input'), names.link);
    await waitFor('the link typed', (current) => tagged(current, 'attachment-link-input')?.text === names.link, 10_000);
    await hideKeyboard();
    await tapExpecting(tagged(await screen(), 'attachment-link-save') ?? fail('no link Save'), (current) => !tagged(current, 'attachment-link-sheet'), 'the link saved');
    nodes = await waitFor('three rows', (current) => rowTitles(current).length === 3, 15_000);
    check(rowTitles(nodes).includes(linkRow(names.link)), `(2) Add link lists ${names.link} (as "${linkRow(names.link)}")`);
    const savesBefore = commands('saveTaskDraft');
    await tapExpecting(button(await screen(), en['common.save']) ?? fail('no Save'), (current) => !inEditor(current) && commands('saveTaskDraft') > savesBefore, 'the editor saved');
    let saved = stored('tasks', names.task);
    const pdf = saved.find((attachment) => attachment.title === names.pdf);
    const png = saved.find((attachment) => attachment.title === photoRow);
    const link = saved.find((attachment) => attachment.kind === 'link');
    check(saved.length === 3 && pdf && png && link?.uri === names.link && live(saved).length === 3, `(2) Save stored the three attachments once (${saved.map((a) => a.title).join(', ')})`);
    check(pdf.uri.endsWith(`/files/attachments/${pdf.id}.pdf`) && png.uri.endsWith(`/files/attachments/${png.id}.png`), '(2) the files are managed copies named by their IDs');
    check(phoneSha(pdf.uri) === sha256(pdfBytes) && phoneSha(png.uri) === sha256(pngBytes), '(2) their bytes under files/attachments/ equal the pushed files\' (SHA-256)');
    check(pdf.mimeType === 'application/pdf' && pdf.size === pdfBytes.length, `(2) the PDF's type and size are the picker's (${pdf.mimeType}, ${pdf.size})`);

    // (3) Open the PDF: a viewer comes to the front through the FileProvider; Back returns.
    nodes = await device.reveal(names.task);
    await tapExpecting(inList(nodes, names.task), inEditor, 'the editor again');
    await revealAttachments();
    await tap(withDescription(await screen(), names.pdf) ?? fail('no PDF row title'));
    await until('a viewer for the PDF', otherAppFront, 20_000, 500);
    const viewer = front().trim();
    check(!viewer.includes(PKG), `(3) Open handed the PDF to another app (${viewer.replace(/.*u0 /, '').split(' ')[0]})`);
    await backToApp();

    // (4) Remove the link, Save: soft-deleted.
    nodes = await screen();
    const linkTitle = withDescription(nodes, linkRow(names.link)) ?? fail('no link row');
    const [, lt, , lb] = box(linkTitle);
    const remove = nodes.find((node) => node['content-desc'] === en['attachments.remove'] && box(node)[1] <= (lt + lb) / 2 && box(node)[3] >= (lt + lb) / 2);
    await tapExpecting(remove ?? fail('no Remove beside the link'), (current) => !withDescription(current, linkRow(names.link)), 'the link removed from the draft');
    await tapExpecting(button(await screen(), en['common.save']) ?? fail('no Save'), (current) => !inEditor(current), 'the editor saved again');
    await until('the removal stored', () => stored('tasks', names.task).find((a) => a.id === link.id)?.deletedAt, 15_000, 1_000);
    saved = stored('tasks', names.task);
    check(live(saved).length === 2 && saved.length === 3, '(4) Remove soft-deleted the link (deletedAt) and kept the two files');

    // (5) Sync now uploads both files; the second device holds the same bytes.
    await syncNow('Sync now (the task\'s files)');
    await until('both files on the WebDAV folder', () => {
        const now = stored('tasks', names.task);
        return [pdf.id, png.id].every((id) => now.find((a) => a.id === id)?.cloudKey);
    }, 120_000, 3_000);
    saved = stored('tasks', names.task);
    const remoteBytes = (attachment) => dav.state.files.get(`${FOLDER}/${attachment.cloudKey}`)?.body;
    check(sha256(remoteBytes(saved.find((a) => a.id === pdf.id)) ?? Buffer.alloc(0)) === sha256(pdfBytes)
        && sha256(remoteBytes(saved.find((a) => a.id === png.id)) ?? Buffer.alloc(0)) === sha256(pngBytes), '(5) the folder holds both files\' bytes under their cloudKeys');
    await second.syncNow('webdav', { ...webdavFields, password: null });
    await second.syncNow('webdav', { ...webdavFields, password: null });
    const secondCopy = (id, ext) => { try { return sha256(readFileSync(resolve(second.files.dir, 'attachments', `${id}${ext}`))); } catch { return null; } };
    check(secondCopy(pdf.id, '.pdf') === sha256(pdfBytes) && secondCopy(png.id, '.png') === sha256(pngBytes), '(5) the second device downloaded both files byte for byte');

    // (6) The project's Attachments (in its Details): Add link writes at once; Remove soft-deletes it.
    nodes = await toTabs();
    nodes = await tapExpecting(tab(nodes, en['nav.projects']), (current) => tabSelected(current, en['nav.projects']), 'Projects');
    nodes = await device.reveal(names.project);
    // The project's Attachments sit inside its Details panel (RN's ProjectDetailModal), folded when the project opens.
    nodes = await tapExpecting(inList(nodes, names.project) ?? fail('no project row'), (current) => Boolean(tagged(current, 'project-details-toggle')), 'the project and its Details');
    await tapExpecting(tagged(nodes, 'project-details-toggle'), (current) => Boolean(tagged(current, 'project-attachment-add-link')), 'the project Details and its Attachments');
    await tapExpecting(tagged(await screen(), 'project-attachment-add-link'), (current) => Boolean(tagged(current, 'attachment-link-sheet')), 'the project link sheet');
    const projectLink = `${names.link}/project`;
    await typeInto(tagged(await screen(), 'attachment-link-input'), projectLink);
    await hideKeyboard();
    await tapExpecting(tagged(await screen(), 'attachment-link-save'), (current) => !tagged(current, 'attachment-link-sheet'), 'the project link saved');
    await until('the project link stored', () => live(stored('projects', names.project)).some((a) => a.uri === projectLink), 15_000, 1_000);
    check(true, '(6) the project card\'s Add link wrote the link at once');
    nodes = await waitFor('the project link row', (current) => Boolean(withDescription(current, linkRow(projectLink))), 15_000);
    const [, pt, , pb] = box(withDescription(nodes, linkRow(projectLink)));
    const projectRemove = nodes.filter((node) => node.text === en['attachments.remove'] && box(node)[1] <= (pt + pb) / 2 && box(node)[3] >= (pt + pb) / 2)[0];
    await tapExpecting(projectRemove ?? fail('no Remove beside the project link'), (current) => !withDescription(current, linkRow(projectLink)), 'the project link removed');
    await until('the project link soft-deleted', () => stored('projects', names.project).find((a) => a.uri === projectLink)?.deletedAt, 15_000, 1_000);
    check(true, '(6) Remove soft-deleted the project link (deletedAt)');

    // (7) A kill during an install recovers at the next boot.
    const addProjectFile = async (label) => {
        const file = resolve(second.files.cache, `a2-${label}-${run}.bin`);
        writeFileSync(file, extraBytes(label));
        const reply = await second.call('menuCommand', 'attachmentAddFile', JSON.stringify({ requestId: randomUUID(), owner: { kind: 'project', projectId },
            source: 'file', picked: { uri: `file://${file}`, name: `a2-${label}-${run}.bin`, mimeType: 'application/octet-stream', size: extraBytes(label).length } }));
        if (reply.kind !== 'saved') fail(`the second device's ${label} file was not added (${JSON.stringify(reply)})`);
        await second.syncNow('webdav', { ...webdavFields, password: null });
        return reply.ids[0];
    };
    const killedId = await addProjectFile('install');
    sh('setprop debug.mindwtr.native.install_stop journal');
    const processBefore = pid();
    // An automatic sync may reach the install first (the app dies on its way to Settings › Sync): either death counts.
    await openSync().then(() => tapTag('sync-now', () => pid() !== processBefore, 'the sync to die at the install', 120_000)).catch(() => null);
    await until('the app process to die at the install journal', () => pid() !== processBefore, 120_000, 1_000);
    sh('setprop debug.mindwtr.native.install_stop \'\'');
    check(allLogs().includes('Native Android install stop at=journal'), '(7) the sync\'s install died once its journal was on disk');
    const leftover = attachmentFiles().filter((name) => name.startsWith('.mindwtr-install-'));
    check(leftover.some((name) => name.endsWith('.journal')), `(7) the journal is on disk after the death (${leftover.join(', ')})`);
    if (pid()) await device.stopApp();
    await until('home screen', () => front().includes(`${home}/`) || otherAppFront(), 10_000, 500);
    if (!front().includes(`${home}/`)) sh('input keyevent KEYCODE_HOME');
    device.launch(ACTIVITY);
    await waitFor('the Inbox after the restart', onInbox, 60_000);
    const recovery = /Native Android install recovery (.+)/.exec(logs())?.[1] ?? '';
    check(/restored=1/.test(recovery), `(7) the boot's recovery rolled the install back (${recovery})`);
    // The startup sync's pre-sync pass may already have installed the file again (it runs about a second after the
    // recovery): what proves the rollback is no installer file left and a target that is absent or the whole file, never part.
    const afterBoot = attachmentFiles();
    const target = afterBoot.find((name) => name.startsWith(killedId));
    const whole = Boolean(target) && phoneSha(`file:///data/user/0/${PKG}/files/attachments/${target}`) === sha256(extraBytes('install'));
    check(!afterBoot.some((name) => name.startsWith('.mindwtr-install-')) && (!target || whole),
        `(7) no installer file and no half file is left; the target is ${target ? 'the whole file (the startup sync installed it again)' : 'absent'}`);
    if (!target) await syncNow('Sync now (the install again)');
    // The file lands in the pre-sync pass; its record's uri is saved once that sync's merge ends, seconds later. When the
    // startup sync did the install, nothing above waited for that save (10-07 to 10-09: the record still read uri '', missing).
    const installedWhole = () => {
        const installed = live(stored('projects', names.project)).find((a) => a.id === killedId);
        return Boolean(installed?.uri) && phoneSha(installed.uri) === sha256(extraBytes('install'));
    };
    await until('(7) the whole file (SHA-256) in its stored record', installedWhole, 120_000, 3_000);
    check(true, '(7) the next sync installed the whole file (SHA-256)');

    // (8) A remote 404 is terminal and writes no bytes; a removed remote copy never deletes local bytes.
    const goneId = await addProjectFile('gone');
    const gone = (await second.call('menuRead', 'attachmentList', JSON.stringify({ owner: { kind: 'project', projectId } }))).rows.find((row) => row.id === goneId);
    const goneKey = [...dav.state.files.keys()].find((path) => path.includes(goneId));
    check(Boolean(gone && goneKey), '(8) the second device uploaded a second project file');
    dav.state.files.delete(goneKey);
    const pdfKey = `${FOLDER}/${stored('tasks', names.task).find((a) => a.id === pdf.id).cloudKey}`;
    dav.state.files.delete(pdfKey);
    await syncNow('Sync now (the 404)');
    await until('the 404 to settle', () => stored('projects', names.project).find((a) => a.id === goneId)?.deletedAt, 120_000, 3_000);
    const unrecoverable = stored('projects', names.project).find((a) => a.id === goneId);
    check(!unrecoverable.cloudKey && unrecoverable.localStatus === 'missing' && !attachmentFiles().some((name) => name.startsWith(goneId)),
        '(8) the 404 marked the file unrecoverable (cloudKey cleared, missing, soft-deleted) and wrote no bytes');
    check(phoneSha(pdf.uri) === sha256(pdfBytes), '(8) the PDF\'s remote copy gone, the sync kept its local bytes');

    // (9) Sync Off again.
    await openSync();
    await tapTag('sync-backend-off', (current) => current.some((node) => node.text === en['settings.syncOff']), 'Sync off');
    await toTabs();
    console.log('Attachments device check passed');
} catch (error) {
    try {
        console.log(`evidence - app log (attachments):\n${logs().split('\n').filter((line) => /attachment|Attachment|install|Core action|sync state/.test(line))
            .slice(-60).map((line) => line.slice(0, 300)).join('\n')}`);
    } catch { /* the app is gone */ }
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    // A failed run leaves the phone's backend on a folder about to stop: set Sync Off, as step (9) does, so the next check's
    // app does not keep syncing against it (check-encryption-device.mjs does the same).
    if (process.exitCode === 1 && dav) {
        try {
            if (!front().includes(`${PKG}/`)) device.launch(ACTIVITY);
            await openSync();
            await tapTag('sync-backend-off', (current) => current.some((node) => node.text === en['settings.syncOff']), 'Sync off after a failure');
            console.log('info - Sync set Off after the failure');
        } catch (error) {
            console.log(`warn - Sync could not be set Off after the failure: ${error.message}`);
        }
    }
    cleanup();
    await sleep(500);
    process.exit(process.exitCode ?? 0);
}
