// File Sync check for the isolated native Android development app (pass S5): a folder picked in Download/, on the phone only.
//
//   node apps/android-native/scripts/check-file-sync-device.mjs <adb-serial> [apk]
//   node apps/android-native/scripts/check-file-sync-device.mjs <adb-serial> --clear-encryption-leftover
//     (only clears what a failed run left: sync encryption on with no folder; it picks a new folder, Disables, puts Off)
//
// Makes a new test folder for this run, Download/mts5-<4 digits> (dd allowed Download/ for this check). A folder is never
// reused: the library's attachments are uploaded into it, and once it is removed core's activation (rightly) refuses to take
// that same folder again while an attachment has a copy nowhere else. Then, through the app's own Settings › Sync:
//   (1) File chosen and Select Folder tapped: the system folder picker (ACTION_OPEN_DOCUMENT_TREE, RN's expo picker) opens,
//       Use this folder and Allow; the folder is a persisted grant, RKStorage holds RN's keys (backend `file`, the folder's
//       sync file URI), and the first sync created data.json (at publication) and RN's `.mindwtr.lock`; no write probe and no
//       scratch file remain;
//   (2) both ways with this computer: a task with an emoji title written into data.json here (adb push) reaches the phone on
//       Sync now; a capture on the phone reaches data.json on the next Sync now, the emoji title intact;
//   (3) the app stopped and started again: Sync now syncs the same folder with no new pick;
//   (4) the folder lock against a second holder (debug SyncLockProbe and SyncLockHolder, another process of the app):
//       (a) the holder first: the app's Sync now is refused as busy, writes nothing, and logs `lock-busy`; released, the next
//       Sync now syncs; (b) the app's production lock code first: the holder is refused before and after each of 5
//       revalidations (a classic lock would drop when a validation handle closes); (c) the holder killed while it holds the
//       lock: the next Sync now syncs, and `.mindwtr.lock` is still the one document it was;
//   (5) encryption: Enable with a typed passphrase leaves only data.json.enc (MWENC1) and no readable title; this computer
//       decrypts it with core's code and the passphrase and finds the phone's capture; two Sync now cycles, each after a
//       capture, log `encrypted=yes` and leave one data.json.enc.bak and no scratch file; Disable makes the folder plaintext again;
//   (6) the folder's grant revoked (as in Android's settings): after a restart, Sync now shows RN's lock text, logs
//       `lock-unavailable`, and the folder is unchanged;
//   (7) Sync set Off; this run's folder removed.
// It starts only when the app's stored sync backend is Off (or never set) and sync encryption is not on: the end puts both back
// through the Sync screen, pass or fail (Disable while the folder is still there, then Off), and removes this run's folder only
// once the app no longer points at it. It refuses, with how to fix it, a
// stored File Sync folder that no longer exists, and any other stored backend (it cannot put a WebDAV or cloud one back).
// It installs with `install -r` (development data stays), touches only the development package and its own folder in Download/, never
// launches over another app. Exit 0 = pass, 1 = fail, 2 = refused, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, check, connect, evidenced, fail, inboxCount, inEditor, linesAfter, logStamp, Stopped, tab, tabSelected, tagged, withDescription, button } from './device.mjs';
import { cleanupOnExit } from './check-net-device.mjs';

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
// A short folder name: an Android property value holds at most 91 characters, and the picker's starting URI names it.
const FOLDER = `mts5-${String(Date.now()).slice(-4)}`;
const PHONE_DIR = `/sdcard/Download/${FOLDER}`;
const AUTHORITY = 'com.android.externalstorage.documents';
// The picker's starting place (EXTRA_INITIAL_URI takes a document URI) and the tree the pick grants.
const START = `content://${AUTHORITY}/document/primary%3ADownload%2F${FOLDER}`;
const TREE = `content://${AUTHORITY}/tree/primary%3ADownload%2F${FOLDER}`;
const { en } = await import(resolve(repo, 'packages/core/src/i18n/locales/en.ts'));

// This run's names: digits only for what the phone types (the keyboard guard allows only an English layout).
const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const titles = { host: `File ✓ Grüße 😀 ${run}`, phone: `95${run}1` };
const PASSPHRASE = `${run}${run}`;

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { adbRaw, sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting } = device;
const logs = () => device.logs(pid(), TAG).replace(/\\/g, '');
/** Every process's lines of the app's tag (the lock holder runs in its own process). */
const allLogs = () => adbRaw('logcat', '-d', '-s', `${TAG}:*`).toString('utf8');
const stamp = () => logStamp(allLogs());
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);

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
const phoneTasks = () => Object.fromEntries(sqlite(pullFile(`files/${DB}`, 'db'), 'SELECT title, status FROM tasks WHERE deletedAt IS NULL').map((row) => [row.title, row.status]));
const rkStorage = () => Object.fromEntries(sqlite(pullFile('databases/RKStorage', 'rk'), 'SELECT key, value FROM catalystLocalStorage').map((row) => [row.key, row.value]));
/** The test folder's file names (hidden ones too). */
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
    return lines.slice(start, end < 0 ? undefined : end).some((line) => line.includes(fragment));
};

// ---- UI (core's English) ----
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
        try { if (await holds()) return; } catch { /* not ready yet */ }
        if (Date.now() > deadline) fail(`timed out waiting for ${description}`);
        await sleep(everyMs);
    }
};
/** The Sync screen's [operation] answers after [since] (host-entry.ts taskResult's line). */
const commands = (operation, since) => linesAfter(logs(), since)
    .filter((line) => line.includes(`"operation":"${operation}"`) && line.includes('"outcome":"saved"')).length;
/** The toasts (tone:title) the Sync screen showed for [operation], oldest first (SyncSettings.kt logs them). */
const toastsOf = (operation, since) => linesAfter(logs(), since).flatMap((line) => {
    const found = new RegExp(`Native Android sync screen command=${operation} toasts=(.+)$`).exec(line);
    return found ? [found[1].trim()] : [];
});
/** The File Sync cycle lines (host-sync.ts performSync, v1.3.7/native-file-sync) after [since]: each line's outcome. */
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
/** The debug lock probe in the app's process ([holder]: false) or in the `:lockholder` process; its answer's outcome and code. */
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
        } catch { /* briefly unavailable */ }
        await sleep(500);
    }
    return fail('uiautomator dump failed');
};
const tapAny = async (node) => {
    const [x1, y1, x2, y2] = box(node);
    sh(`input tap ${Math.round((x1 + x2) / 2)} ${Math.round((y1 + y2) / 2)}`);
    await sleep(900);
};
/** RN's folder picker (opened in this run's folder through the debug start place): Use this folder, then Allow when it asks. */
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
/** Taps the node [find] picks, then waits for the node [after] picks anywhere on the screen (scrolling to it). */
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
/** data.json.enc decrypted on this computer by core's own code (Bun runs core's TypeScript): its task titles. */
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
        const plain = await crypto.decryptSyncArtifact(bytes, material.key, prims);
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

/** The phone folder a stored externalstorage File Sync path names (`primary%3A<path>`), or null for another provider. */
const storedFolder = (path) => {
    const id = /\/tree\/primary%3A([^/]+)/.exec(path ?? '')?.[1];
    return id ? `/sdcard/${decodeURIComponent(id)}` : null;
};
class Refused extends Error {}
class LeftoverCleared extends Error {}
/** Before the run: the stored backend must be one the end can put back (Off). */
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
/** This run turned sync encryption on at its folder (Enable, or the leftover mode's pick) and has not turned it off yet. */
let encrypted = false;
/** Disable at this run's folder (the key is on the phone, so no passphrase): the folder is plaintext again. */
const disableHere = async (description) => {
    await openSync();
    await tapThenFind(action(en['settings.syncEncryptionDisable']), (current) => tagged(current, 'sync-encryption-submit'), description);
    await hideKeyboard();
    await tap(await reveal((current) => tagged(current, 'sync-encryption-submit'), 'the Disable button'));
    // Done only when the whole transition is: data.json back, every encrypted file and scratch gone, and the card offering
    // Enable again (core's state off, no unfinished transition). A step that restarts the app or revokes the grant before
    // that leaves the Disable unfinished, and core then refuses Sync Off until Retry or Abandon (run 6, 10-19).
    await until('the folder plaintext again', () => {
        const names = folderNames();
        return names.includes('data.json') && !names.some((name) => name.endsWith('.enc') || name.endsWith('.enc.bak') || name.includes('.mindwtr-et-'));
    }, 300_000, 2_000);
    await until('the card offering Enable again', async () => {
        try { await reveal(action(en['settings.syncEncryptionEnable']), 'Enable encryption'); return true; } catch { return false; }
    }, 120_000, 2_000);
    encrypted = false;
};
/** After the run, pass or fail: encryption off and sync Off again through the Sync screen, then (only then) this run's folder removed. */
const restoreBackend = async () => {
    if (!touched) return;
    try {
        // A run that failed inside the system folder picker leaves it in front: back out of it first.
        for (let step = 0; step < 4 && front().includes('documentsui'); step += 1) {
            sh('input keyevent KEYCODE_BACK');
            await sleep(1000);
        }
        if (!front().includes(`${PKG}/`)) device.launch(ACTIVITY);
        await waitFor('the app', (nodes) => nodes.length > 0 && front().includes(`${PKG}/`), 30_000);
        if (encrypted) await disableHere('Disable (the end puts encryption back off)');
        if (rkStorage()['@mindwtr_sync_backend'] !== 'off') {
            await openSync();
            await tapTag('sync-backend-off', (current) => current.some((node) => node.text === en['settings.syncOff']), 'Sync off');
            await until('Off stored', () => rkStorage()['@mindwtr_sync_backend'] === 'off', 30_000, 1_000);
        }
        sh(`rm -rf ${PHONE_DIR}`);
        console.log(`info - sync encryption is off, the stored sync backend is Off again and ${PHONE_DIR} is removed`);
        await toTabs().catch(() => undefined);
    } catch (error) {
        console.error(`LEFT: the dev app may still point at ${PHONE_DIR}${encrypted ? ' with sync encryption on' : ''}; the folder is kept. `
            + `Disable encryption and choose Off in Settings › Sync (${error.message})`);
        process.exitCode = 1;
    }
};
// A signal ends the run without the Sync screen: the folder stays, so the app never points at a removed one.
const cleanup = cleanupOnExit([
    () => setProp('sync_tree', ''),
    () => sh(`rm -f ${UI_FILE}`),
]);

try {
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}\nrun: ${run}`);
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    await restart();
    requireRestorableBackend(rkStorage());
    touched = true;
    sh(`mkdir -p ${PHONE_DIR}`);

    // (1) File, and Select Folder through the system picker. A folder an earlier run stored activates when File is chosen (it
    // is gone, so that activation fails with a toast); the pick below replaces it.
    let nodes = await openSync();
    if (!nodes.some((node) => node.text === en['settings.syncOff'])) {
        await tapTag('sync-backend-off', (current) => current.some((node) => node.text === en['settings.syncOff']), 'Sync off');
    }
    await tapTag('sync-backend-file', (current) => Boolean(tagged(current, 'sync-select-folder')), 'the File panel');
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
        // The leftover key sealed this new folder on its first sync; the end Disables it, puts Off and removes the folder.
        encrypted = true;
        check(folderNames().includes('data.json.enc'), '(leftover) the leftover key encrypted the new folder; the end now Disables it');
        throw new LeftoverCleared();
    }
    const names = folderNames();
    check(names.includes('data.json') && names.includes('.mindwtr.lock'), `(1) the first sync wrote data.json and RN's .mindwtr.lock (${names.join(', ')})`);
    check(!names.some((name) => /mindwtr-write-test|\.mindwtr-et-|\.tmp$/.test(name)), '(1) no write probe and no scratch file remain');
    const phoneCount = Object.keys(phoneTasks()).length;
    check(folderDocument().tasks.filter((task) => !task.deletedAt).length >= phoneCount, `(1) data.json holds the phone's ${phoneCount} tasks`);

    // (2) Both ways with this computer.
    const document = folderDocument();
    const at = new Date().toISOString();
    document.tasks.push({ id: randomUUID(), title: titles.host, status: 'inbox', tags: [], contexts: [], createdAt: at, updatedAt: at, rev: 1, revBy: 'file-sync-check' });
    mkdirSync(work, { recursive: true });
    writeFileSync(resolve(work, 'data.json'), JSON.stringify(document, null, 2));
    execFileSync(adbBin, ['-s', serial, 'push', resolve(work, 'data.json'), `${PHONE_DIR}/data.json`], { stdio: 'ignore' });
    await syncNow('(2) Sync now after this computer wrote the folder');
    await until('this computer\'s task on the phone', () => phoneTasks()[titles.host] === 'inbox', 30_000);
    check(true, `(2) Sync now brought "${titles.host}" from the folder exactly`);
    await capture(titles.phone);
    await syncNow('(2) Sync now after a capture');
    const back = folderDocument();
    check(back.tasks.some((task) => task.title === titles.phone && !task.deletedAt), '(2) the phone\'s capture reached data.json');
    check(back.tasks.some((task) => task.title === titles.host), '(2) the emoji title round-tripped byte for byte');

    // (3) A restart keeps the folder.
    await restart();
    since = stamp();
    await syncNow('(3) Sync now after a restart');
    check(!front().includes('documentsui') && rkStorage()['@mindwtr_sync_path'] === syncPath, '(3) the same folder synced with no new pick');

    // (4) The folder lock against a second holder.
    const lockInode = inode('.mindwtr.lock');
    // The app's own cycles (a follow-up after Sync now, an automatic one) hold the lock while they run: wait them out.
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

    // (5) Encryption on the picked folder, and off again.
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
        // A cycle writes only what changed: a capture makes each one replace data.json.enc, rotating the one before it.
        await capture(`95${run}${round + 1}`);
        const at = await syncNow(`(5) encrypted Sync now ${round}`);
        check(cycles(at).at(-1).line.includes('"encrypted":"yes"'), `(5) encrypted Sync now ${round} logged encrypted=yes`);
    }
    encryptedNames = folderNames();
    check(encryptedNames.filter((name) => name === 'data.json.enc.bak').length === 1 && !encryptedNames.some((name) => /\.mindwtr-et-|mindwtr-write-test/.test(name)),
        `(5) two encrypted cycles left one data.json.enc.bak and no scratch (${encryptedNames.join(', ')})`);
    await disableHere('(5) the Disable flow');
    check(folderDocument().tasks.some((task) => task.title === titles.phone), '(5) Disable made the folder plaintext again, with the phone\'s capture');

    // (6) The grant revoked.
    answer = await probe(false, 'revoke', `--es uri '${TREE}'`);
    check(answer.outcome === 'revoked', `(6) the app released the folder's persisted grant (${answer.outcome} ${answer.code})`);
    // The activity manager still lists the grant while the process that held it lives: read it after the restart.
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
    check(logs().includes(lockText) || shown.some((toast) => toast.includes('error')), `(6) the app answered with RN's lock refusal ("${lockText}")`);

    // (7) Off.
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
    } catch { /* the app is gone */ }
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
    await restoreBackend();
    cleanup();
    await sleep(500);
    process.exit(process.exitCode ?? 0);
}
