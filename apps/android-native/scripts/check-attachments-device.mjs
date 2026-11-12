


import { execFileSync } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, button, check, connect, evidenced, fail, inboxCount, inEditor, inList, isOn, linesAfter, logStamp, Stopped, switchOn, tab, tabSelected, tagged, withDescription } from './device.mjs';
import { cleanupOnExit } from './check-net-device.mjs';
import { projectFiles, removeNowhereFiles } from './nowhere-files.mjs';
import { hostDevice, serveWebdav, webdavDocument } from './sync-harness.mjs';

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

const linkRow = (uri) => getAttachmentDisplayTitle({ kind: 'link', title: uri, uri });


const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const WEBDAV_PORT = Number(process.env.MINDWTR_ATTACHMENTS_WEBDAV_PORT ?? 18773);
const FOLDER = `/dav/mindwtr-a2-${run}`;
const USER = `a2user${run}`;
const PASSWORD = `pw${run}secret`;
const webdavFields = { url: `http://127.0.0.1:${WEBDAV_PORT}${FOLDER}`, username: USER, password: PASSWORD, allowInsecureHttp: true };
const names = { task: `94${run}`, project: `A2 project ${run}`, pdf: `a2doc${run}.pdf`, png: `a2pic${run}.png`, link: `https://example.com/a2/${run}` };


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

const stored = (table, title) => {
    const row = sqlite(pullFile(`files/${DB}`, 'db'), `SELECT attachments FROM ${table} WHERE title = ${quote(title)} AND deletedAt IS NULL`)[0];
    return row?.attachments ? JSON.parse(row.attachments) : [];
};
const live = (list) => list.filter((attachment) => !attachment.deletedAt);

const attachmentFiles = () => runAs('ls -a files/attachments 2>/dev/null || true').split(/\s+/).filter((name) => name && name !== '.' && name !== '..');
const phoneSha = (uri) => {
    const path = uri.replace(/^file:\/\/\/data\/user\/0\/[^/]+\//, '').replace(/^file:\/\/\/data\/data\/[^/]+\//, '');
    const out = runAs(`sha256sum ${path} 2>/dev/null || true`);
    return /^[0-9a-f]{64}/.exec(out)?.[0] ?? null;
};


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


const commands = (operation, outcome = 'saved', since = '') => linesAfter(logs().replace(/\\/g, ''), since)
    .filter((line) => line.includes(`"operation":"${operation}"`) && line.includes(`"outcome":"${outcome}"`)).length;
const stamp = () => logStamp(logs());

const runCommand = async (tag, operation, description, timeoutMs = 240_000) => {
    const since = stamp();
    await tapTag(tag, () => commands(operation, 'saved', since) > 0, description, timeoutMs);
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

const { removeProjectFile } = projectFiles({ device, en, toTabs, hideKeyboard });
const until = async (description, holds, timeoutMs = 120_000, everyMs = 2_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await holds()) return;
        if (Date.now() > deadline) fail(`timed out waiting for ${description}`);
        await sleep(everyMs);
    }
};


const rowTitles = (nodes) => nodes.filter((node) => /(^|\/)attachment-row$/.test(node['resource-id'] ?? ''))
    .map((row) => { const [l, t, r, b] = box(row); return nodes.find((node) => node.text && node.class === 'android.widget.TextView'
        && box(node)[0] >= l && box(node)[1] >= t && box(node)[2] <= r && box(node)[3] <= b)?.text; }).filter(Boolean);

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

const anyScreen = async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            const xml = device.adbRaw('exec-out', 'uiautomator', 'dump', '/dev/tty').toString('utf8');
            if (xml.includes('<hierarchy')) {
                return [...xml.matchAll(/<node [^>]*>/g)].map(([tag]) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)]
                    .map(([, name, value]) => [name, value.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/&quot;/g, '"').replace(/&amp;/g, '&')])));
            }
        } catch {                           }
        await sleep(500);
    }
    return fail('uiautomator dump failed in the picker');
};
const tapAny = async (node) => {
    const [x1, y1, x2, y2] = box(node);
    sh(`input tap ${Math.round((x1 + x2) / 2)} ${Math.round((y1 + y2) / 2)}`);
    await sleep(900);
};

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

const pickNewestPhoto = async () => {
    await until('the photo picker', otherAppFront, 15_000, 500);
    await sleep(2000);
    const nodes = await anyScreen();

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


    sh(`mkdir -p ${PHONE_DIR}`);
    execFileSync(adbBin, ['-s', serial, 'push', resolve(work, names.pdf), `${PHONE_DIR}/${names.pdf}`], { stdio: 'ignore' });
    execFileSync(adbBin, ['-s', serial, 'push', pngFile, `${PHONE_DIR}/${names.png}`], { stdio: 'ignore' });
    sh(`touch -t 203712312359 ${PHONE_DIR}/${names.png}`);
    for (const file of [names.pdf, names.png]) sh(`am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://${PHONE_DIR}/${file} >/dev/null 2>&1 || true`);
    await until('the media store to list the PNG', () => sh(`content query --uri content://media/external/images/media --projection _display_name --where "_display_name='${names.png}'"`)
        .includes(names.png), 30_000, 1_000);
    check(true, `the test files are in ${PHONE_DIR} (PDF ${pdfBytes.length} bytes, PNG ${pngBytes.length} bytes) and the PNG is in the media store`);

    dav = await serveWebdav({ port: WEBDAV_PORT, username: USER, password: PASSWORD });


    try { execFileSync(adbBin, ['-s', serial, 'reverse', '--remove', `tcp:${WEBDAV_PORT}`], { stdio: 'ignore' }); } catch {                   }
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    sh('setprop debug.mindwtr.native.install_stop \'\'');
    await device.stopApp();
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    device.launch(ACTIVITY);
    await waitFor('the Inbox', onInbox, 60_000);

    await removeNowhereFiles({ query: (sql) => sqlite(pullFile(`files/${DB}`, 'db'), sql), removeProjectFile });
    check(true, 'no file that exists nowhere is left from an earlier run (it would stall a switch of sync location)');


    let nodes = await openSync();
    if (!nodes.some((node) => node.text === en['settings.syncOff'])) {
        console.log('note - a backend left by an earlier run is set Off before the check maps its port');
        await tapTag('sync-backend-off', (current) => current.some((node) => node.text === en['settings.syncOff']), 'Sync off');
    }
    execFileSync(adbBin, ['-s', serial, 'reverse', `tcp:${WEBDAV_PORT}`, `tcp:${WEBDAV_PORT}`], { stdio: 'ignore' });
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

    const projectId = (await second.call('createProject', names.project, '', randomUUID())).id;
    await second.syncNow('webdav', { ...webdavFields, password: null });
    await syncNow('Sync now (the second device\'s project)');
    await until('the project on the phone', () => sqlite(pullFile(`files/${DB}`, 'db'), `SELECT id FROM projects WHERE id = ${quote(projectId)}`).length === 1, 30_000);
    check(true, '(1) the phone synced to the local WebDAV folder and has the second device\'s project');


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


    const pngSha = sha256(pngBytes);
    if (!attachmentFiles().some((name) => phoneSha(`file:///data/user/0/${PKG}/files/attachments/${name}`) === pngSha)) {

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
    const savesSince = stamp();
    await tapExpecting(button(await screen(), en['common.save']) ?? fail('no Save'), (current) => !inEditor(current) && commands('saveTaskDraft', 'saved', savesSince) > 0, 'the editor saved');
    let saved = stored('tasks', names.task);
    const pdf = saved.find((attachment) => attachment.title === names.pdf);
    const png = saved.find((attachment) => attachment.title === photoRow);
    const link = saved.find((attachment) => attachment.kind === 'link');
    check(saved.length === 3 && pdf && png && link?.uri === names.link && live(saved).length === 3, `(2) Save stored the three attachments once (${saved.map((a) => a.title).join(', ')})`);
    check(pdf.uri.endsWith(`/files/attachments/${pdf.id}.pdf`) && png.uri.endsWith(`/files/attachments/${png.id}.png`), '(2) the files are managed copies named by their IDs');
    check(phoneSha(pdf.uri) === sha256(pdfBytes) && phoneSha(png.uri) === sha256(pngBytes), '(2) their bytes under files/attachments/ equal the pushed files\' (SHA-256)');
    check(pdf.mimeType === 'application/pdf' && pdf.size === pdfBytes.length, `(2) the PDF's type and size are the picker's (${pdf.mimeType}, ${pdf.size})`);


    nodes = await device.reveal(names.task);
    await tapExpecting(inList(nodes, names.task), inEditor, 'the editor again');
    await revealAttachments();
    await tap(withDescription(await screen(), names.pdf) ?? fail('no PDF row title'));
    await until('a viewer for the PDF', otherAppFront, 20_000, 500);
    const viewer = front().trim();
    check(!viewer.includes(PKG), `(3) Open handed the PDF to another app (${viewer.replace(/.*u0 /, '').split(' ')[0]})`);
    await backToApp();


    await reveal((current) => withDescription(current, linkRow(names.link)), 'link row', false);
    nodes = await screen();
    const linkTitle = withDescription(nodes, linkRow(names.link)) ?? fail('no link row');
    const [, lt, , lb] = box(linkTitle);
    const remove = nodes.find((node) => node['content-desc'] === en['attachments.remove'] && box(node)[1] <= (lt + lb) / 2 && box(node)[3] >= (lt + lb) / 2);
    await tapExpecting(remove ?? fail('no Remove beside the link'), (current) => !withDescription(current, linkRow(names.link)), 'the link removed from the draft');
    await tapExpecting(button(await screen(), en['common.save']) ?? fail('no Save'), (current) => !inEditor(current), 'the editor saved again');
    await until('the removal stored', () => stored('tasks', names.task).find((a) => a.id === link.id)?.deletedAt, 15_000, 1_000);
    saved = stored('tasks', names.task);
    check(live(saved).length === 2 && saved.length === 3, '(4) Remove soft-deleted the link (deletedAt) and kept the two files');


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


    nodes = await device.projectsTab(toTabs);
    nodes = await tapExpecting(tab(nodes, en['nav.projects']), (current) => tabSelected(current, en['nav.projects']), 'Projects');
    nodes = await device.reveal(names.project);

    nodes = await tapExpecting(inList(nodes, names.project) ?? fail('no project row'), (current) => Boolean(tagged(current, 'project-details-toggle')), 'the project and its Details');
    await tapExpecting(tagged(nodes, 'project-details-toggle'), (current) => Boolean(tagged(current, 'project-attachment-add-link')), 'the project Details and its Attachments');
    await tapExpecting(tagged(await screen(), 'project-attachment-add-link'), (current) => Boolean(tagged(current, 'attachment-link-sheet')), 'the project link sheet');
    const projectLink = `${names.link}/project`;
    await typeInto(tagged(await screen(), 'attachment-link-input'), projectLink);
    await hideKeyboard();
    await tapExpecting(tagged(await screen(), 'attachment-link-save'), (current) => !tagged(current, 'attachment-link-sheet'), 'the project link saved');
    await until('the project link stored', () => live(stored('projects', names.project)).some((a) => a.uri === projectLink), 15_000, 1_000);
    check(true, '(6) the project card\'s Add link wrote the link at once');
    const [, pt, , pb] = box(await reveal((current) => withDescription(current, linkRow(projectLink)), 'the project link row', false));
    nodes = await screen();
    const projectRemove = nodes.filter((node) => node.text === en['attachments.remove'] && box(node)[1] <= (pt + pb) / 2 && box(node)[3] >= (pt + pb) / 2)[0];
    await tapExpecting(projectRemove ?? fail('no Remove beside the project link'), (current) => !withDescription(current, linkRow(projectLink)), 'the project link removed');
    await until('the project link soft-deleted', () => stored('projects', names.project).find((a) => a.uri === projectLink)?.deletedAt, 15_000, 1_000);
    check(true, '(6) Remove soft-deleted the project link (deletedAt)');


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


    const afterBoot = attachmentFiles();
    const target = afterBoot.find((name) => name.startsWith(killedId));
    const whole = Boolean(target) && phoneSha(`file:///data/user/0/${PKG}/files/attachments/${target}`) === sha256(extraBytes('install'));
    check(!afterBoot.some((name) => name.startsWith('.mindwtr-install-')) && (!target || whole),
        `(7) no installer file and no half file is left; the target is ${target ? 'the whole file (the startup sync installed it again)' : 'absent'}`);
    if (!target) await syncNow('Sync now (the install again)');


    const installedWhole = () => {
        const installed = live(stored('projects', names.project)).find((a) => a.id === killedId);
        return Boolean(installed?.uri) && phoneSha(installed.uri) === sha256(extraBytes('install'));
    };
    await until('(7) the whole file (SHA-256) in its stored record', installedWhole, 120_000, 3_000);
    check(true, '(7) the next sync installed the whole file (SHA-256)');


    const goneId = await addProjectFile('gone');
    const gone = (await second.call('menuRead', 'attachmentList', JSON.stringify({ owner: { kind: 'project', projectId } }))).rows.find((row) => row.id === goneId);
    const goneKey = [...dav.state.files.keys()].find((path) => path.includes(goneId));
    check(Boolean(gone && goneKey), '(8) the second device uploaded a second project file');
    dav.state.files.delete(goneKey);
    const pdfKey = `${FOLDER}/${stored('tasks', names.task).find((a) => a.id === pdf.id).cloudKey}`;
    dav.state.files.delete(pdfKey);
    const goneCloudKey = goneKey.slice(FOLDER.length + 1);
    await syncNow('Sync now (the 404)');
    const kept = stored('projects', names.project).find((a) => a.id === goneId);
    check(Boolean(kept) && !kept.deletedAt && kept.cloudKey === goneCloudKey && kept.localStatus !== 'available'
        && !attachmentFiles().some((name) => name.startsWith(goneId)),
        '(8) the 404 kept the attachment (live, its key, not available) and wrote no bytes');
    check(phoneSha(pdf.uri) === sha256(pdfBytes), '(8) the PDF\'s remote copy gone, the sync kept its local bytes');


    const removed = await second.call('menuCommand', 'attachmentRemove', JSON.stringify({ requestId: randomUUID(), owner: { kind: 'project', projectId }, attachmentId: goneId }));
    if (removed.kind !== 'saved') fail(`the second device did not remove the kept attachment (${JSON.stringify(removed)})`);
    await second.syncNow('webdav', { ...webdavFields, password: null });

    const remoteGone = () => webdavDocument(dav, FOLDER)?.projects?.find((p) => p.id === projectId)?.attachments?.find((a) => a.id === goneId);
    await until('the second device\'s delete in the folder', async () => {
        if (remoteGone()?.deletedAt) return true;
        await second.syncNow('webdav', { ...webdavFields, password: null });
        return Boolean(remoteGone()?.deletedAt);
    }, 120_000, 5_000);

    for (let attempt = 0; attempt < 3 && !stored('projects', names.project).find((a) => a.id === goneId)?.deletedAt; attempt += 1) {
        await syncNow(`Sync now (the second device removed the kept file, try ${attempt + 1})`);
    }
    await until('the kept attachment deleted on the phone', () => stored('projects', names.project).find((a) => a.id === goneId)?.deletedAt, 60_000, 3_000);
    check(true, '(8) the second device\'s Remove deleted the kept attachment on the phone (a real delete still wins)');


    await openSync();
    await tapTag('sync-backend-off', (current) => current.some((node) => node.text === en['settings.syncOff']), 'Sync off');
    await toTabs();
    console.log('Attachments device check passed');
} catch (error) {
    try {
        console.log(`evidence - app log (attachments):\n${logs().split('\n').filter((line) => /attachment|Attachment|install|Core action|sync state/.test(line))
            .slice(-60).map((line) => line.slice(0, 300)).join('\n')}`);
    } catch {                       }
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    try {
        const query = (sql) => sqlite(pullFile(`files/${DB}`, 'db'), sql);
        if (['tasks', 'projects'].some((table) => query(`SELECT 1 FROM ${table} o, json_each(o.attachments) j WHERE o.deletedAt IS NULL `
            + `AND j.value->>'kind' = 'file' AND j.value->>'deletedAt' IS NULL AND (j.value->>'localStatus' = 'missing' OR coalesce(j.value->>'uri', '') = '') AND o.title IN (${quote(names.task)}, ${quote(names.project)})`).length)) {
            if (!front().includes(`${PKG}/`)) device.launch(ACTIVITY);
            await removeNowhereFiles({ query, removeProjectFile });
        }
    } catch (error) {
        console.log(`warn - this run's missing files could not be removed: ${error.message}`);
        process.exitCode ||= 1;
    }
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
