


import { execFileSync } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, check, connect, evidenced, fail, inboxCount, inEditor, inList, isOn, linesAfter, logStamp, Stopped, tab, tabSelected, tagged, withDescription, button } from './device.mjs';
import { projectFiles, removeNowhereFiles } from './nowhere-files.mjs';

const [serial, ...rest] = process.argv.slice(2);
const CLEAR_LEFTOVER = rest.includes('--clear-encryption-leftover');
const apkArg = rest.find((arg) => !arg.startsWith('--'));
if (!serial) {
    console.error('usage: node check-file-sync-device.mjs <adb-serial> [apk]');
    process.exit(2);
}
const app = resolve(import.meta.dirname, '..');
const repo = resolve(app, '../..');
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
const PROBE = `${PKG}/tech.dongdongbh.mindwtr.pilot.SyncLockProbe`;
const HOLDER = `${PKG}/tech.dongdongbh.mindwtr.pilot.SyncLockHolder`;
const TAG = 'MindwtrNativeDev';
const UI_FILE = '/data/local/tmp/mindwtr-native-dev-ui.xml';
const DB = 'mindwtr-native-dev.db';
const work = resolve(app, 'android/build/file-sync-check');

const FOLDER = `mts5-${String(Date.now()).slice(-4)}`;
const PHONE_DIR = `/sdcard/Download/${FOLDER}`;
const AUTHORITY = 'com.android.externalstorage.documents';

const START = `content://${AUTHORITY}/document/primary%3ADownload%2F${FOLDER}`;
const TREE = `content://${AUTHORITY}/tree/primary%3ADownload%2F${FOLDER}`;
const { en } = await import(resolve(repo, 'packages/core/src/i18n/locales/en.ts'));


const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const titles = { host: `File ✓ Grüße 😀 ${run}`, phone: `95${run}1`, attached: `96${run}1` };
const PASSPHRASE = `${run}${run}`;

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { adbRaw, sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting } = device;
const logs = () => device.logs(pid(), TAG).replace(/\\/g, '');

const allLogs = () => adbRaw('logcat', '-d', '-s', `${TAG}:*`).toString('utf8');
const stamp = () => logStamp(allLogs());
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);


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
const phoneTasks = () => Object.fromEntries(sqlite(pullFile(`files/${DB}`, 'db'), 'SELECT title, status FROM tasks WHERE deletedAt IS NULL').map((row) => [row.title, row.status]));

const storedAttachments = (title) => {
    const row = sqlite(pullFile(`files/${DB}`, 'db'), `SELECT attachments FROM tasks WHERE title = '${title}' AND deletedAt IS NULL`)[0];
    return row?.attachments ? JSON.parse(row.attachments) : [];
};

const phoneSha = (uri) => {
    const path = uri.replace(/^file:\/\/\/data\/(user\/0|data)\/[^/]+\//, '');
    return /^[0-9a-f]{64}/.exec(sh(`run-as ${PKG} sha256sum ${path} 2>/dev/null || true`))?.[0] ?? null;
};
const rkStorage = () => Object.fromEntries(sqlite(pullFile('databases/RKStorage', 'rk'), 'SELECT key, value FROM catalystLocalStorage').map((row) => [row.key, row.value]));

const folderNames = () => sh(`ls -a ${PHONE_DIR}`).split(/\s+/).filter((name) => name && name !== '.' && name !== '..').sort();
const folderBytes = (name) => adbRaw('exec-out', 'cat', `${PHONE_DIR}/${name}`);
const folderSha = (name) => createHash('sha256').update(folderBytes(name)).digest('hex');
const folderDocument = () => JSON.parse(folderBytes('data.json').toString('utf8'));
const inode = (name) => sh(`stat -c %i ${PHONE_DIR}/${name}`);
const persistedGrant = (fragment) => {
    const uid = /uid:(\d+)/.exec(sh(`pm list packages -U ${PKG}`))?.[1] ?? fail(`no UID for ${PKG}`);
    const lines = sh('dumpsys activity permissions').split('\n');
    const start = lines.findIndex((line) => new RegExp(`UID ${uid}\\b`).test(line));
    if (start < 0) return false;
    const end = lines.findIndex((line, index) => index > start && /^\s*\* UID /.test(line));

    const block = lines.slice(start, end < 0 ? undefined : end);
    const entry = block.findIndex((line) => line.includes('UriPermission{') && line.includes(`${fragment} `));
    return entry >= 0 && /\bpersisted=0x[1-9a-f]/.test(block.slice(entry + 1, entry + 4).join(' '));
};


const sheetOpen = (nodes) => Boolean(tagged(nodes, 'more-sheet'));
const onSync = (nodes) => Boolean(tagged(nodes, 'settings-sync'));
const onInbox = (nodes) => !tagged(nodes, 'quick-capture') && !tagged(nodes, 'menu-screen') && !inEditor(nodes)
    && tabSelected(nodes, en['tab.inbox']) && Number.isFinite(inboxCount(nodes));
const withPrefix = (nodes, prefix) => nodes.find((node) => (node['content-desc'] ?? '').startsWith(prefix));
const otherAppFront = () => !front().includes(`${PKG}/`);
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

        const discard = button(nodes, en['common.discard']);
        if (discard) {
            await tap(discard);
            await sleep(1000);
            continue;
        }
        await hideKeyboard();
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(1000);
    }
    return fail('the tabs did not come back');
};
const toInbox = async () => {
    let nodes = await toTabs();
    if (!tabSelected(nodes, en['tab.inbox'])) {
        nodes = await tapExpecting(tab(nodes, en['tab.inbox']), (current) => tabSelected(current, en['tab.inbox']), 'the Inbox');
    }
    if (!onInbox(nodes)) await device.toTop();
    return waitFor('the Inbox', onInbox, 30_000);
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
const tapTag = async (tag, expected, description, timeoutMs = 30_000) => {
    await hideKeyboard();
    return tapExpecting(await reveal((current) => tagged(current, tag), tag), expected, description, timeoutMs);
};
const until = async (description, holds, timeoutMs = 120_000, everyMs = 2_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try { if (await holds()) return; } catch {                     }
        if (Date.now() > deadline) fail(`timed out waiting for ${description}`);
        await sleep(everyMs);
    }
};

const commands = (operation, since) => linesAfter(logs(), since)
    .filter((line) => line.includes(`"operation":"${operation}"`) && line.includes('"outcome":"saved"')).length;

const toastsOf = (operation, since) => linesAfter(logs(), since).flatMap((line) => {
    const found = new RegExp(`Native Android sync screen command=${operation} toasts=(.+)$`).exec(line);
    return found ? [found[1].trim()] : [];
});

const cycles = (since) => linesAfter(logs(), since).filter((line) => line.includes('Native Android File Sync cycle'))
    .map((line) => ({ outcome: /"outcome":"([\w-]+)"/.exec(line)?.[1], provider: /"provider":"([^"]+)"/.exec(line)?.[1], line }));
const syncNow = async (description, outcome = 'synced') => {
    const since = stamp();
    await openSync();
    await tapTag('sync-now', () => commands('syncNow', since) > 0, description, 240_000);
    await until(`the File Sync cycle line of ${description}`, () => cycles(since).length > 0, 30_000, 1_000);
    const lines = cycles(since);
    check(lines.at(-1).outcome === outcome && lines.at(-1).provider === AUTHORITY,
        `${description}: the cycle logged outcome=${lines.at(-1).outcome} provider=${lines.at(-1).provider} (want ${outcome})`);
    return since;
};

const probe = async (holder, op, extra = '') => {
    const since = stamp();
    sh(`am start -W -n ${holder ? HOLDER : PROBE} --es op ${op} ${extra}`);
    const process = holder ? 'holder' : 'main';
    let answer = null;
    await until(`the lock probe's ${op} answer`, () => {
        answer = linesAfter(allLogs(), since).map((line) => new RegExp(`sync lock probe process=${process} op=${op} outcome=(\\w+) code=(\\S*)`).exec(line)).find(Boolean);
        return Boolean(answer);
    }, 20_000, 500);
    await waitFor('the app back in front', () => front().includes(`${PKG}/`), 10_000);
    return { outcome: answer[1], code: answer[2] };
};
const anyScreen = async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            const xml = adbRaw('exec-out', 'uiautomator', 'dump', '/dev/tty').toString('utf8');
            if (xml.includes('<hierarchy')) {
                return [...xml.matchAll(/<node [^>]*>/g)].map(([node]) => Object.fromEntries([...node.matchAll(/([\w-]+)="([^"]*)"/g)]
                    .map(([, name, value]) => [name, value.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/&quot;/g, '"').replace(/&amp;/g, '&')])));
            }
        } catch {                           }
        await sleep(500);
    }
    return fail('uiautomator dump failed');
};
const tapAny = async (node) => {
    const [x1, y1, x2, y2] = box(node);
    sh(`input tap ${Math.round((x1 + x2) / 2)} ${Math.round((y1 + y2) / 2)}`);
    await sleep(900);
};

const useTestFolder = async () => {
    await until('the folder picker', otherAppFront, 15_000, 500);
    await sleep(1500);
    let nodes = await anyScreen();
    for (const folder of ['Download', FOLDER]) {
        if (nodes.some((node) => node['resource-id']?.endsWith('breadcrumb_text') && node.text === folder)) continue;
        if (folder === 'Download' && nodes.some((node) => node.text === FOLDER && node['resource-id']?.endsWith('breadcrumb_text'))) continue;
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
const capture = async (text) => {
    await toInbox();
    const nodes = await device.openCapture();
    await device.focusAtEnd(tagged(nodes, 'capture-title') ?? fail('no capture field'));
    requireAppFront();
    sh(`input text '${text}'`);
    await waitFor(`"${text}" in the capture field`, (current) => tagged(current, 'capture-title')?.text === text, 15_000);
    await tapExpecting(button(await screen(), en['common.save']) ?? fail('no Save'), onInbox, 'the capture to close the popup');
};
const withText = (nodes, text) => nodes.find((node) => node.text === text);
const action = (label) => (nodes) => withDescription(nodes, label);
const fillTag = async (tag, text) => {
    await hideKeyboard();
    await tap(await reveal((current) => tagged(current, tag), tag));
    await sleep(300);
    requireAppFront();
    sh('input keycombination KEYCODE_CTRL_LEFT KEYCODE_A');
    sh('input keyevent KEYCODE_DEL');
    sh(`input text '${text}'`);
    await sleep(500);
};

const tapThenFind = async (find, after, description, timeoutMs = 30_000) => {
    await hideKeyboard();
    await tap(await reveal(find, description));
    await until(description, async () => {
        try { await reveal(after, description); return true; } catch { return false; }
    }, timeoutMs, 1_000);
};
const cardShows = (text, timeoutMs) => until(`"${text.slice(0, 50)}" on the card`, async () => {
    try { await reveal((current) => withText(current, text), text.slice(0, 40)); return true; } catch { return false; }
}, timeoutMs, 1_000);

const openAttachmentsOf = async (title) => {
    await toInbox();
    let nodes = await device.reveal(title);
    nodes = await tapExpecting(inList(nodes, title) ?? fail(`no task row ${title}`), inEditor, 'the editor');
    for (let step = 0; step < 14 && !tagged(nodes, 'attachment-add-file'); step += 1) {
        const next = await device.swipe(nodes, 'down');
        if (device.signature(next) === device.signature(nodes)) break;
        nodes = next;
    }
    if (!tagged(nodes, 'attachment-add-file')) {
        await tap(withDescription(nodes, en['taskEdit.details']) ?? fail('no Details section'));
        await sleep(800);
    }
};

const remoteOnlyAttachments = () => ['tasks', 'projects'].flatMap((table) => sqlite(pullFile(`files/${DB}`, 'db'),
    `SELECT id, attachments FROM ${table} WHERE deletedAt IS NULL AND attachments IS NOT NULL`)
    .flatMap((row) => JSON.parse(row.attachments).filter((a) => a.kind === 'file' && !a.deletedAt && a.cloudKey && (!a.uri || a.localStatus === 'missing'))
        .map((a) => `${a.id} on ${table.slice(0, -1)} ${row.id}`)));

const { removeProjectFile } = projectFiles({ device, en, toTabs, hideKeyboard });

const sharePhoneFile = async () => {
    const name = `97${run}1.pdf`;
    writeFileSync(resolve(work, name), `File Sync phone file ${run}\n`);
    execFileSync(adbBin, ['-s', serial, 'push', resolve(work, name), `/data/local/tmp/${name}`], { stdio: 'ignore' });
    sh(`run-as ${PKG} sh -c 'mkdir -p files/share-test && cp /data/local/tmp/${name} files/share-test/'`);
    sh(`rm -f /data/local/tmp/${name}`);
    requireAppFront();
    sh(`am start -W --activity-multiple-task -n ${PKG}/tech.dongdongbh.mindwtr.pilot.ShareTestSender --es action android.intent.action.SEND --es type 'application/pdf' --esal uris content://${PKG}.sharetest/file/${name}`);
    const nodes = await waitFor('the capture screen with the shared phone file', (current) => Boolean(tagged(current, 'capture-modal-save')), 30_000);
    await tapExpecting(tagged(nodes, 'capture-modal-save'), (current) => !tagged(current, 'capture-modal'), 'the shared phone file to save');
    await until('the shared phone file stored with its bytes on the phone', () => sqlite(pullFile(`files/${DB}`, 'db'),
        `SELECT 1 FROM tasks t, json_each(t.attachments) j WHERE t.deletedAt IS NULL AND (j.value->>'title' = '${name}' OR t.title = '97${run}1') AND j.value->>'kind' = 'file' AND coalesce(j.value->>'uri', '') <> ''`).length > 0, 30_000, 1_000);
    sh(`run-as ${PKG} rm -rf files/share-test`);
    console.log(`note - shared ${name} into a new task, so the library holds a phone file for (2b) to publish`);
};

const removeHostFile = async () => {

    if (!storedAttachments(titles.attached).some((a) => a.id === hostFile.id && !a.deletedAt)) { hostFilePending = false; return; }
    await openAttachmentsOf(titles.attached);
    const title = await reveal((current) => withDescription(current, hostFile.title), hostFile.title);
    const [, top, , bottom] = box(title);
    const remove = (await screen()).find((node) => node['content-desc'] === en['attachments.remove'] && box(node)[1] <= (top + bottom) / 2 && box(node)[3] >= (top + bottom) / 2);
    await tapExpecting(remove ?? fail('no Remove beside the file'), (current) => !withDescription(current, hostFile.title), 'the file removed from the draft');
    await tapExpecting(button(await screen(), en['common.save']) ?? fail('no Save'), (current) => !inEditor(current), 'the editor saved');
    await until('the removal stored', () => storedAttachments(titles.attached).find((a) => a.id === hostFile.id)?.deletedAt, 15_000, 1_000);
    hostFilePending = false;
};

const decryptedTitles = () => {
    const file = resolve(work, 'data.json.enc');
    writeFileSync(file, folderBytes('data.json.enc'));
    const out = execFileSync('bun', ['-e', `
        const crypto = await import(${JSON.stringify(resolve(repo, 'packages/core/src/sync-crypto.ts'))});
        const bytes = new Uint8Array(await Bun.file(${JSON.stringify(file)}).arrayBuffer());
        const header = crypto.inspectSyncArtifact(bytes);
        if (header.kind !== 'encrypted') throw new Error('not MWENC1: ' + header.kind);
        const prims = crypto.defaultSyncCryptoPrimitives;
        const material = await crypto.deriveSyncKeyMaterial(process.env.PASS, header.salt, header.params, prims);
        const plain = await crypto.decryptSyncArtifact(bytes, material.key, prims, { kind: 'document' });
        console.log(JSON.stringify(JSON.parse(new TextDecoder().decode(plain)).tasks.map((task) => task.title)));
    `], { cwd: repo, encoding: 'utf8', env: { ...process.env, PASS: PASSPHRASE }, maxBuffer: 1 << 28 }).trim().split('\n').pop();
    return JSON.parse(out);
};
const restart = async () => {
    await device.stopApp();
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    device.launch(ACTIVITY);
    await waitFor('the Inbox', onInbox, 60_000);
};


const storedFolder = (path) => {
    const id = /\/tree\/primary%3A([^/]+)/.exec(path ?? '')?.[1];
    return id ? `/sdcard/${decodeURIComponent(id)}` : null;
};
class Refused extends Error {}
class LeftoverCleared extends Error {}


const storedEncryptionOn = (keys) => {
    const state = (() => { try { return JSON.parse(keys['@mindwtr_sync_encryption_state_v1'] ?? 'null'); } catch { return null; } })();
    return Boolean(state) && (state.state !== 'off' || Boolean(state.incompleteTransition));
};
const requireRestorableBackend = (keys) => {
    const backend = keys['@mindwtr_sync_backend'] ?? 'off';
    const encryption = (() => { try { return JSON.parse(keys['@mindwtr_sync_encryption_state_v1'] ?? 'null'); } catch { return null; } })();
    const encryptionOn = Boolean(encryption) && (encryption.state !== 'off' || Boolean(encryption.incompleteTransition));
    if (CLEAR_LEFTOVER) {
        if (backend !== 'off' || encryption?.state !== 'enabled' || encryption.incompleteTransition) {
            throw new Refused(`--clear-encryption-leftover clears only encryption left on with sync Off (backend ${backend}, encryption ${encryption?.state ?? 'off'})`);
        }
        return;
    }
    if (encryptionOn) {
        throw new Refused(`the app's sync encryption is "${encryption.state}"${encryption.incompleteTransition ? ` (an unfinished ${encryption.incompleteTransition})` : ''}; `
            + 'an earlier run may have left it. Run this check with --clear-encryption-leftover, or turn it off in the dev app, then run again');
    }
    if (backend === 'off') return;
    if (backend === 'file') {
        const folder = storedFolder(keys['@mindwtr_sync_path']);
        if (folder && !sh(`[ -d '${folder}' ] && echo yes || echo no`).includes('yes')) {
            throw new Refused(`the app's stored File Sync folder ${folder} no longer exists (an earlier run removed it?); `
                + 'open the dev app\'s Settings › Sync, choose Off, then run again');
        }
    }
    throw new Refused(`the app's stored sync backend is "${backend}"; this check can put back only Off. `
        + 'Choose Off in the dev app\'s Settings › Sync, then run again');
};
let touched = false;


let hostFile = null;
let hostFilePending = false;

let encrypted = false;

const disableHere = async (description) => {
    await openSync();
    await tapThenFind(action(en['settings.syncEncryptionDisable']), (current) => tagged(current, 'sync-encryption-submit'), description);
    await hideKeyboard();
    await tap(await reveal((current) => tagged(current, 'sync-encryption-submit'), 'the Disable button'));


    await until('the folder plaintext again', () => {
        const names = folderNames();
        return names.includes('data.json') && !names.some((name) => name.endsWith('.enc') || name.endsWith('.enc.bak') || name.includes('.mindwtr-et-'));
    }, 300_000, 2_000);
    await until('the card offering Enable again', async () => {
        try { await reveal(action(en['settings.syncEncryptionEnable']), 'Enable encryption'); return true; } catch { return false; }
    }, 120_000, 2_000);
    encrypted = false;
};

const restoreBackend = async () => {
    if (!touched) return;
    try {

        for (let step = 0; step < 4 && front().includes('documentsui'); step += 1) {
            sh('input keyevent KEYCODE_BACK');
            await sleep(1000);
        }
        if (!front().includes(`${PKG}/`)) device.launch(ACTIVITY);
        await waitFor('the app', (nodes) => nodes.length > 0 && front().includes(`${PKG}/`), 30_000);
        if (hostFilePending) await removeHostFile();

        if (storedEncryptionOn(rkStorage())) {
            try {
                await disableHere('Disable (the end puts encryption back off)');
            } catch (error) {
                console.error(`info - the end's Disable failed (${error.message}); trying Off anyway`);
            }
        }
        encrypted = storedEncryptionOn(rkStorage());
        if (rkStorage()['@mindwtr_sync_backend'] !== 'off') {
            await openSync();
            await tapTag('sync-backend-off', (current) => current.some((node) => node.text === en['settings.syncOff']), 'Sync off');
            await until('Off stored', () => rkStorage()['@mindwtr_sync_backend'] === 'off', 30_000, 1_000);
        }


        if (persistedGrant(`Download%2F${FOLDER}`)) await probe(false, 'revoke', `--es uri '${TREE}'`);
        sh(`rm -rf ${PHONE_DIR}`);
        if (encrypted) {
            console.error(`LEFT: the stored sync encryption is still on; ${PHONE_DIR} is removed and the stored backend is Off. Turn encryption off in the dev app`);
            process.exitCode = 1;
        } else {
            console.log(`info - sync encryption is off, the stored sync backend is Off again, its grant released and ${PHONE_DIR} removed`);
        }
        await toTabs().catch(() => undefined);
    } catch (error) {
        console.error(`LEFT: the dev app may still point at ${PHONE_DIR}${encrypted ? ' with sync encryption on' : ''}`
            + `${hostFilePending ? `, and task ${titles.attached} still holds the check's file ${hostFile.title}` : ''}; the folder is kept. `
            + `Disable encryption and choose Off in Settings › Sync (${error.message})`);
        process.exitCode = 1;
    }
};
const cleanup = () => {
    for (const step of [() => setProp('sync_tree', ''), () => sh(`rm -f ${UI_FILE}`)]) {
        try { step(); } catch {                         }
    }
};

let ending = null;
const end = () => (ending ??= restoreBackend().finally(cleanup));

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.once(signal, () => { void end().finally(() => process.exit(code)); });
}

try {
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}\nrun: ${run}`);
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    await restart();
    requireRestorableBackend(rkStorage());
    if (remoteOnlyAttachments().length) {
        await removeNowhereFiles({ query: (sql) => sqlite(pullFile(`files/${DB}`, 'db'), sql), removeProjectFile });
    }
    const remoteOnly = remoteOnlyAttachments();
    if (remoteOnly.length) {
        throw new Refused(`the library holds ${remoteOnly.length} live file attachments with a cloud key and no local copy (${remoteOnly.slice(0, 5).join('; ')}); `
            + 'core\'s activation (as RN\'s) refuses every new folder while one exists. Download or remove them in the dev app, then run again');
    }
    touched = true;
    sh(`mkdir -p ${PHONE_DIR}`);


    let nodes = await openSync();
    if (!nodes.some((node) => node.text === en['settings.syncOff'])) {
        await tapTag('sync-backend-off', (current) => current.some((node) => node.text === en['settings.syncOff']), 'Sync off');
    }
    await tapTag('sync-backend-file', (current) => isOn(tagged(current, 'sync-backend-file')), 'the File panel');
    setProp('sync_tree', START);
    let since = stamp();
    await tapTag('sync-select-folder', otherAppFront, 'the folder picker', 15_000);
    await useTestFolder();
    await until('Select Folder\'s answer', () => commands('pickSyncFolder', since) > 0, 240_000, 1_000);
    setProp('sync_tree', '');
    const pickToasts = toastsOf('pickSyncFolder', since);
    check(!pickToasts.some((toast) => toast.startsWith('error')), `(1) Select Folder answered with no error toast (${pickToasts.join(' / ') || 'none'})`);
    check(persistedGrant(`Download%2F${FOLDER}`), '(1) the picked folder is a persisted grant of the app, as RN\'s expo keeps it');
    let stored = rkStorage();
    const syncPath = stored['@mindwtr_sync_path'] ?? '';
    check(stored['@mindwtr_sync_backend'] === 'file' && syncPath.startsWith(`${TREE}/document/`),
        `(1) RKStorage holds RN's File Sync keys: backend ${stored['@mindwtr_sync_backend']}, path ${syncPath}`);
    check(cycles(since).some((line) => line.outcome === 'synced' && line.provider === AUTHORITY), '(1) the pick activated through a File Sync cycle that synced');
    if (CLEAR_LEFTOVER) {

        encrypted = true;
        check(folderNames().includes('data.json.enc'), '(leftover) the leftover key encrypted the new folder; the end now Disables it');
        throw new LeftoverCleared();
    }
    const names = folderNames();
    check(names.includes('data.json') && names.includes('.mindwtr.lock'), `(1) the first sync wrote data.json and RN's .mindwtr.lock (${names.join(', ')})`);
    check(!names.some((name) => /mindwtr-write-test|\.mindwtr-et-|\.tmp$/.test(name)), '(1) no write probe and no scratch file remain');
    const phoneCount = Object.keys(phoneTasks()).length;
    check(folderDocument().tasks.filter((task) => !task.deletedAt).length >= phoneCount, `(1) data.json holds the phone's ${phoneCount} tasks`);


    const document = folderDocument();
    const at = new Date().toISOString();
    document.tasks.push({ id: randomUUID(), title: titles.host, status: 'inbox', tags: [], contexts: [], createdAt: at, updatedAt: at, rev: 1, revBy: 'file-sync-check' });

    const fileBytes = Buffer.from(`File Sync attachment ${run} ✓\n`);
    const fileSha = createHash('sha256').update(fileBytes).digest('hex');
    const fileId = randomUUID();
    hostFile = { id: fileId, kind: 'file', title: `s5-${run}.txt`, uri: '', mimeType: 'text/plain', size: fileBytes.length,
        createdAt: at, updatedAt: at, cloudKey: `attachments/${fileId}.${fileSha}.txt`, fileHash: fileSha };
    document.tasks.push({ id: randomUUID(), title: titles.attached, status: 'inbox', tags: [], contexts: [], attachments: [hostFile],
        createdAt: at, updatedAt: at, rev: 1, revBy: 'file-sync-check' });
    mkdirSync(work, { recursive: true });
    writeFileSync(resolve(work, 'attachment.txt'), fileBytes);
    sh(`mkdir -p ${PHONE_DIR}/attachments`);
    execFileSync(adbBin, ['-s', serial, 'push', resolve(work, 'attachment.txt'), `${PHONE_DIR}/${hostFile.cloudKey}`], { stdio: 'ignore' });
    hostFilePending = true;
    writeFileSync(resolve(work, 'data.json'), JSON.stringify(document, null, 2));
    execFileSync(adbBin, ['-s', serial, 'push', resolve(work, 'data.json'), `${PHONE_DIR}/data.json`], { stdio: 'ignore' });
    await syncNow('(2) Sync now after this computer wrote the folder');
    await until('this computer\'s task on the phone', () => phoneTasks()[titles.host] === 'inbox', 30_000);
    check(true, `(2) Sync now brought "${titles.host}" from the folder exactly`);
    await sharePhoneFile();
    await capture(titles.phone);
    await syncNow('(2) Sync now after a capture');
    const back = folderDocument();
    check(back.tasks.some((task) => task.title === titles.phone && !task.deletedAt), '(2) the phone\'s capture reached data.json');
    check(back.tasks.some((task) => task.title === titles.host), '(2) the emoji title round-tripped byte for byte');


    const fileKeys = [...back.tasks, ...(back.projects ?? [])].filter((owner) => !owner.deletedAt).flatMap((owner) => owner.attachments ?? [])
        .filter((attachment) => attachment.kind === 'file' && !attachment.deletedAt && attachment.cloudKey && attachment.id !== fileId);
    const published = fileKeys.filter((attachment) => /^attachments\/[^/]+\.[a-f0-9]{64}(\.[a-z0-9]{1,8})?$/.test(attachment.cloudKey));
    console.log(`info - (2b) ${fileKeys.length - published.length} file attachments keep another backend's key`);
    check(published.length > 0, `(2b) the phone published ${published.length} file attachments under File Sync keys (the dev library needs at least one)`);
    const bad = published.filter((attachment) => !folderNames().includes('attachments')
        || createHash('sha256').update(folderBytes(attachment.cloudKey)).digest('hex') !== attachment.fileHash);
    check(bad.length === 0, `(2b) each one's bytes are in the folder at its key, their SHA-256 its fileHash (${bad.map((a) => a.cloudKey).join(', ') || 'all'})`);

    check(storedAttachments(titles.attached).some((attachment) => attachment.id === fileId && !attachment.uri), '(2b) this computer\'s file reached the phone as a remote copy');
    await openAttachmentsOf(titles.attached);
    await tap(await reveal((current) => withText(current, en['attachments.download']), 'Download', false));

    await waitFor('the row downloaded', (current) => !withText(current, en['attachments.download']) && !withText(current, en['common.loading'])
        && !withText(current, en['attachments.missing']), 120_000);
    await hideKeyboard();
    await tapExpecting(button(await screen(), en['common.save']) ?? fail('no Save'), (current) => !inEditor(current), 'the editor saved');
    await until('the download stored', () => {
        const file = storedAttachments(titles.attached).find((attachment) => attachment.id === hostFile.id);
        return Boolean(file?.uri) && phoneSha(file.uri) === fileSha;
    }, 60_000, 2_000);
    check(true, '(2b) Download fetched this computer\'s file from the folder; Save stored it, the phone\'s copy with its SHA-256');
    await toTabs();


    await restart();
    since = stamp();
    await syncNow('(3) Sync now after a restart');
    check(!front().includes('documentsui') && rkStorage()['@mindwtr_sync_path'] === syncPath, '(3) the same folder synced with no new pick');


    await openSync();
    setProp('sync_tree', START);
    since = stamp();
    await tapTag('sync-select-folder', otherAppFront, '(3b) the folder picker', 15_000);
    const pickerPid = pid() || fail('no app process behind the picker');
    sh(`run-as ${PKG} kill -9 ${pickerPid}`);
    await until('the app process to end', () => pid() !== pickerPid, 10_000, 500);
    check(otherAppFront(), '(3b) the app\'s process died while the folder picker was in front');
    await useTestFolder();
    await until('the recreated screen\'s Select Folder answer', () => commands('pickSyncFolder', since) > 0, 240_000, 1_000);
    setProp('sync_tree', '');
    await sleep(5_000);
    check(commands('pickSyncFolder', since) === 1, `(3b) the recreated Sync screen answered Select Folder once (${commands('pickSyncFolder', since)})`);
    check(rkStorage()['@mindwtr_sync_path'] === syncPath && persistedGrant(`Download%2F${FOLDER}`), '(3b) it stored the same folder, its grant kept');


    await until('a synced cycle of the picked folder', () => cycles(since).some((line) => line.outcome === 'synced'), 60_000, 1_000);
    check(true, `(3b) the folder synced after the pick (the pick's toasts: ${toastsOf('pickSyncFolder', since).join(' / ') || 'none'})`);


    const lockInode = inode('.mindwtr.lock');

    const holdWhenFree = async (holder) => {
        let taken = await probe(holder, 'hold', `--es uri '${syncPath}'`);
        for (let attempt = 0; attempt < 20 && taken.code === 'SYNC_FILE_LOCK_BUSY'; attempt += 1) {
            console.log('info - (4) the app holds the lock for a cycle of its own; trying again');
            await sleep(3_000);
            taken = await probe(holder, 'hold', `--es uri '${syncPath}'`);
        }
        return taken;
    };
    let answer = await holdWhenFree(true);
    check(answer.outcome === 'held', `(4a) the second holder took the folder lock (${answer.outcome} ${answer.code})`);
    const before = folderSha('data.json');
    since = stamp();
    await openSync();
    await tapTag('sync-now', () => commands('syncNow', since) > 0, '(4a) Sync now while another process holds the lock', 120_000);
    await until('the busy cycle line', () => cycles(since).length > 0, 30_000, 1_000);
    check(cycles(since).at(-1).outcome === 'lock-busy', `(4a) the app's cycle was refused as busy (${cycles(since).at(-1).outcome})`);
    check(folderSha('data.json') === before, '(4a) data.json is unchanged');
    answer = await probe(true, 'release');
    check(answer.outcome === 'released', '(4a) the second holder released the lock');
    await syncNow('(4a) Sync now once the holder released');
    answer = await holdWhenFree(false);
    check(answer.outcome === 'held', `(4b) the app's process took the lock with the production lock code (${answer.outcome} ${answer.code})`);
    for (let round = 0; round <= 5; round += 1) {
        if (round > 0) {
            answer = await probe(false, 'revalidate');
            check(answer.outcome === 'revalidated', `(4b) revalidation ${round} kept the lease`);
        }
        answer = await probe(true, 'hold', `--es uri '${syncPath}'`);
        check(answer.outcome === 'refused' && answer.code === 'SYNC_FILE_LOCK_BUSY', `(4b) the second holder is refused after ${round} revalidations (${answer.outcome} ${answer.code})`);
    }
    answer = await probe(false, 'release');
    check(answer.outcome === 'released', '(4b) the app\'s process released the lock');
    answer = await holdWhenFree(true);
    check(answer.outcome === 'held', '(4c) the second holder took the lock again');
    const holderPid = sh(`pidof ${PKG}:lockholder`).trim() || fail('no lock holder process');
    sh(`run-as ${PKG} kill -9 ${holderPid}`);
    await until('the lock holder process to end', () => !sh(`pidof ${PKG}:lockholder || true`).trim(), 10_000, 500);
    await syncNow('(4c) Sync now after the holder died holding the lock');
    check(inode('.mindwtr.lock') === lockInode && folderNames().filter((name) => name.includes('mindwtr.lock')).length === 1,
        '(4c) .mindwtr.lock is still the one document it was (no create, no delete)');


    await openSync();
    await tapThenFind(action(en['settings.syncEncryptionEnable']), (current) => tagged(current, 'sync-passphrase-next'), '(5) the Enable flow');
    await fillTag('sync-passphrase-next', PASSPHRASE);
    await fillTag('sync-passphrase-confirm', PASSPHRASE);
    await hideKeyboard();
    since = stamp();
    encrypted = true;
    await tap(await reveal((current) => tagged(current, 'sync-encryption-submit'), 'the Enable button'));
    await cardShows(en['settings.syncEncryptionStatusOn'], 300_000);
    let encryptedNames = folderNames();
    check(encryptedNames.includes('data.json.enc') && !encryptedNames.includes('data.json') && folderBytes('data.json.enc').subarray(0, 6).toString() === 'MWENC1',
        `(5) Enable left data.json.enc (MWENC1) and no data.json (${encryptedNames.join(', ')})`);
    check(!encryptedNames.filter((name) => !name.startsWith('.') && name !== 'attachments').some((name) => folderBytes(name).includes(Buffer.from(titles.phone))),
        '(5) no file in the folder holds the phone\'s task title readably');
    check(decryptedTitles().includes(titles.phone), '(5) this computer decrypts data.json.enc with core\'s code and the passphrase and finds the phone\'s capture');
    for (const round of [1, 2]) {

        await capture(`95${run}${round + 1}`);
        const at = await syncNow(`(5) encrypted Sync now ${round}`);
        check(cycles(at).at(-1).line.includes('"encrypted":"yes"'), `(5) encrypted Sync now ${round} logged encrypted=yes`);
    }
    encryptedNames = folderNames();
    check(encryptedNames.filter((name) => name === 'data.json.enc.bak').length === 1 && !encryptedNames.some((name) => /\.mindwtr-et-|mindwtr-write-test/.test(name)),
        `(5) two encrypted cycles left one data.json.enc.bak and no scratch (${encryptedNames.join(', ')})`);
    await disableHere('(5) the Disable flow');
    check(folderDocument().tasks.some((task) => task.title === titles.phone), '(5) Disable made the folder plaintext again, with the phone\'s capture');


    answer = await probe(false, 'revoke', `--es uri '${TREE}'`);
    check(answer.outcome === 'revoked', `(6) the app released the folder's persisted grant (${answer.outcome} ${answer.code})`);

    await restart();
    await until('the grant gone from the activity manager', () => !persistedGrant(`Download%2F${FOLDER}`), 20_000, 1_000);
    check(true, '(6) the folder\'s grant is gone after a restart');
    const untouched = folderSha('data.json');
    since = stamp();
    await openSync();
    await tapTag('sync-now', () => commands('syncNow', since) > 0, '(6) Sync now with the grant revoked', 120_000);
    await until('the refused cycle line', () => cycles(since).length > 0, 30_000, 1_000);
    check(cycles(since).at(-1).outcome === 'lock-unavailable', `(6) the cycle was refused as lock-unavailable (${cycles(since).at(-1).outcome})`);
    const lockText = en['settings.syncFileLockUnavailable'];
    const shown = toastsOf('syncNow', since);
    console.log(`info - (6) toasts: ${shown.join(' / ') || 'none'}`);
    check(folderSha('data.json') === untouched && !folderNames().some((name) => /\.mindwtr-et-/.test(name)), '(6) the folder is unchanged');
    const errorLine = await reveal((current) => tagged(current, 'sync-error'), 'the last sync error');
    check(errorLine.text === lockText, `(6) Settings › Sync shows RN's lock refusal as the last sync error ("${errorLine.text}")`);


    await openSync();
    await tapTag('sync-backend-off', (current) => current.some((node) => node.text === en['settings.syncOff']), 'Sync off');
    await until('Off stored', () => rkStorage()['@mindwtr_sync_backend'] === 'off', 15_000, 1_000);
    check(true, '(7) Sync is Off again');
    await toTabs();
    console.log('File Sync device check passed');
} catch (error) {
    try {
        console.log(`evidence - app log (sync):\n${logs().split('\n').filter((line) => /File Sync|sync screen|sync lock probe|\[sync\]|Core action/.test(line))
            .slice(-60).map((line) => line.slice(0, 300)).join('\n')}`);
    } catch {                       }
    if (error instanceof LeftoverCleared) {
        console.log('info - leftover mode: the end clears the encryption left on');
    } else if (error instanceof Refused) {
        console.error(`REFUSED: ${error.message}`);
        process.exitCode = 2;
    } else {
        evidenced(error);
        console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
        process.exitCode = error instanceof Stopped ? 3 : 1;
    }
} finally {
    await end();
    await sleep(500);
    process.exit(process.exitCode ?? 0);
}
