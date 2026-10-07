// Sync encryption check for the isolated native Android development app, on this computer only.
//
//   node apps/android-native/scripts/check-encryption-device.mjs <adb-serial> [apk]
//
// Starts two WebDAV folders on 127.0.0.1 (sync-harness.mjs serveWebdav: one with strong ETags, one whose ETags are all weak),
// maps the phone's ports to them (`adb reverse`), and runs a second device on this computer: the same native bundle in a Node
// VM whose crypto is core's reference (@noble/hashes Argon2id, OpenSSL AES-GCM). Then, through Settings › Sync's encryption card:
//   (1) WebDAV saved on the phone (plaintext first);
//   (2) Enable with a typed passphrase: a tap during the Argon2id derivation is answered (a debug-only 6 s wait before each
//       derivation, `debug.mindwtr.native.crypto_delay_ms`), the card reads On, the folder holds only MWENC1 files and no title;
//   (3) the second device joins, is locked out, unlocks with the same passphrase and reads the phone's task (the phone's
//       BouncyCastle key equals core's), and its own encrypted task reaches the phone;
//   (4) the second device changes the passphrase: the phone asks for it, refuses the old one in RN's words with no change to the
//       folder or its tasks, and the new one unlocks it;
//   (5) the app restarted: it syncs encrypted by itself, with no passphrase typed;
//   (6) Disable: the folder is plaintext again;
//   (7) a weak-ETag server: Enable is refused in RN's words and nothing there is encrypted or fenced;
//   (7b) an Enable cut off by its server, then "Abandon setup": the card names the folder partly encrypted, Sync now with the
//       server back writes nothing there (core's partly-encrypted rule), "Check this location again" reads it, and sync to
//       another folder works;
//   (8) no passphrase in any app file, the journal, the log or logcat; the SecureStore entries are printed (no key after Disable).
// The Argon2id time on the phone is printed. It installs with `install -r`, touches only the development package, and on exit
// removes the port mappings and the debug property and stops both servers. Exit 0 = pass, 1 = fail, 2 = refused, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, check, connect, evidenced, fail, inboxCount, inEditor, mainList, Stopped, switchOn, tab, tabSelected, tagged, withDescription, button } from './device.mjs';
import { cleanupOnExit } from './check-net-device.mjs';
import { hostDevice, serveWebdav } from './sync-harness.mjs';
import { encryptionCard, remoteArtifacts, runEncryption } from './encryption-harness.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-encryption-device.mjs <adb-serial> [apk]');
    process.exit(2);
}
const app = resolve(import.meta.dirname, '..');
const repo = resolve(app, '../..');
const apk = apkArg ?? resolve(app, 'android/app/build/outputs/apk/play/debug/app-play-debug.apk');
const bundle = resolve(app, 'android/app/src/main/assets/core-host.js');
const adbBin = process.env.ADB ?? '/opt/android-sdk/platform-tools/adb';
const aapt2 = process.env.AAPT2 ?? '/home/dd/Android/Sdk/build-tools/36.1.0/aapt2';
const PKG = 'tech.dongdongbh.mindwtr.nativeclient.dev';
const apkPackage = execFileSync(aapt2, ['dump', 'packagename', apk], { encoding: 'utf8' }).trim();
if (apkPackage !== PKG) {
    console.error(`REFUSED: ${apk} is package "${apkPackage}", not ${PKG}`);
    process.exit(2);
}
const ACTIVITY = `${PKG}/${PKG}.MainActivity`;
const TAG = 'MindwtrNativeDev';
// The screen streams to this computer and is never written on the phone: Show passphrase puts a passphrase on it.
const UI_FILE = '/dev/tty';
const DB = 'mindwtr-native-dev.db';
const work = resolve(app, 'android/build/encryption-check');
const { en } = await import(resolve(repo, 'packages/core/src/i18n/locales/en.ts'));

// Digits only for what the phone types (the keyboard guard allows only an English layout).
const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const WEBDAV_PORT = Number(process.env.MINDWTR_ENC_WEBDAV_PORT ?? 18781);
const WEAK_PORT = WEBDAV_PORT + 1;
const LOST_PORT = WEBDAV_PORT + 2;
const FOLDER = `/dav/mindwtr-enc-${run}`;
const USER = `enc${run}`;
const PASSWORD = `pw${run}secret`;
const PASSPHRASE = `71${run}3`;
const NEXT = `72${run}4`;
const DELAY_MS = 6_000;
const fields = (port) => ({ url: `http://127.0.0.1:${port}${FOLDER}`, username: USER, password: PASSWORD, allowInsecureHttp: true });
const titles = { abandoned: `94${run}5`, phone: `94${run}1`, host: `Enc ✓ 雲 😀 ${run}`, rotated: `Rotated ✓ ${run}`, restart: `Restart 😀 ${run}`, plain: `Plain ✓ ${run}` };

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting } = device;
const logs = () => device.logs(pid(), TAG);

// ---- The phone's storage (run-as copies, read on this computer) ----
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
const grepApp = (text) => sh(`run-as ${PKG} sh -c "grep -rl '${text}' files databases shared_prefs no_backup cache 2>/dev/null || true"`).split(/\s+/).filter(Boolean);

// ---- UI (core's English) ----
const sheetOpen = (nodes) => Boolean(tagged(nodes, 'more-sheet'));
const onSync = (nodes) => Boolean(tagged(nodes, 'settings-sync'));
const onInbox = (nodes) => !tagged(nodes, 'quick-capture') && !tagged(nodes, 'menu-screen') && !tagged(nodes, 'global-search') && !inEditor(nodes)
    && tabSelected(nodes, en['tab.inbox']) && Number.isFinite(inboxCount(nodes));
const withPrefix = (nodes, prefix) => nodes.find((node) => (node['content-desc'] ?? '').startsWith(prefix));
const withText = (nodes, text) => nodes.find((node) => node.text === text);
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
/** Settings' scroll moves the node [find] picks into view: from the top, then down. */
const reveal = async (find, description) => {
    let nodes = await device.toTop();
    const inView = (current) => {
        const node = find(current);
        const list = mainList(current);
        return node && (!list || (box(node)[1] >= box(list)[1] && box(node)[3] <= box(list)[3] - 40)) ? node : null;
    };
    for (let step = 0; step < 18 && !inView(nodes); step += 1) nodes = await device.swipe(nodes, 'down');
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
const fill = async (find, text, description) => {
    // The keyboard of the field before covers the lower screen: a field behind it is never "in view".
    await hideKeyboard();
    const node = await reveal(find, description);
    await tap(node);
    await sleep(300);
    requireAppFront();
    sh('input keycombination KEYCODE_CTRL_LEFT KEYCODE_A');
    sh('input keyevent KEYCODE_DEL');
    sh(`input text '${text}'`);
    await sleep(500);
};
const fillTag = (tag, text) => fill((current) => tagged(current, tag), text, tag);
const tapNode = async (find, expected, description, timeoutMs = 30_000) => {
    await hideKeyboard();
    return tapExpecting(await reveal(find, description), expected, description, timeoutMs);
};
/** Taps the node [find] picks, then waits for the node [after] picks anywhere on the screen (scrolling to it): a flow that opens
 *  below the fold is not on the screen the tap left. */
const tapThenFind = async (find, after, description, timeoutMs = 30_000) => {
    await hideKeyboard();
    await tap(await reveal(find, description));
    await until(description, async () => {
        try { await reveal(after, description); return true; } catch { return false; }
    }, timeoutMs, 1_000);
};
const until = async (description, holds, timeoutMs = 120_000, everyMs = 2_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await holds()) return;
        if (Date.now() > deadline) fail(`timed out waiting for ${description}`);
        await sleep(everyMs);
    }
};
const commands = (operation, outcome = 'saved') => logs().replace(/\\/g, '').split('\n')
    .filter((line) => line.includes(`"operation":"${operation}"`) && line.includes(`"outcome":"${outcome}"`)).length;
const argonTimes = () => [...logs().matchAll(/Native Android sync crypto argon2id ms=(\d+) m=(\d+) t=(\d+) p=(\d+)/g)].map(([, ms, m, t, p]) => ({ ms: Number(ms), m: Number(m), t: Number(t), p: Number(p) }));
/** The encryption card's action row named [label] (its content description). */
const action = (label) => (nodes) => withDescription(nodes, label);
/** Waits for the card's state text on screen (scrolling to it). */
const cardShows = async (text, timeoutMs = 60_000) => {
    await until(`"${text.slice(0, 50)}" on the card`, async () => {
        try { await reveal((current) => withText(current, text), text.slice(0, 40)); return true; } catch { return false; }
    }, timeoutMs, 1_000);
};
/** Opens the Sync screen and saves the WebDAV form for [port] (Save proves it with a sync first). */
const saveWebdav = async (port) => {
    await openSync();
    if (!tagged(await screen(), 'sync-url')) await tapNode((current) => tagged(current, 'sync-backend-webdav'), (current) => Boolean(tagged(current, 'sync-url')), 'the WebDAV form');
    // The card shows once WebDAV is chosen: a change an earlier run left unfinished would refuse this Save.
    if (await abandonIfStranded()) console.log('info - an earlier run\'s unfinished change was abandoned first');
    await fillTag('sync-url', fields(port).url);
    const label = en['settings.allowInsecureHttp'];
    await hideKeyboard();
    const insecure = await reveal((current) => withDescription(current, label), 'Allow insecure HTTP');
    if (!switchOn(await screen(), label)) await tapExpecting(insecure, (current) => switchOn(current, label), 'insecure HTTP on');
    await fillTag('sync-username', USER);
    await fillTag('sync-password', PASSWORD);
    const before = commands('saveSyncBackend');
    await tapNode((current) => tagged(current, 'sync-save'), () => commands('saveSyncBackend') > before, 'Save', 90_000);
};
/**
 * A change an earlier run left unfinished (its server stopped for good) pauses sync everywhere: take "Abandon setup" when the
 * Sync screen offers it. True when it did.
 */
const abandonIfStranded = async () => {
    await openSync();
    // Only the first screens of Settings › Sync: the card's actions sit below the form, so scroll down without failing.
    let nodes = await device.toTop();
    for (let step = 0; step < 18 && !withDescription(nodes, en['settings.syncEncryptionAbandon']); step += 1) nodes = await device.swipe(nodes, 'down');
    const offered = withDescription(nodes, en['settings.syncEncryptionAbandon']);
    if (!offered) return false;
    const abandons = () => (logs().match(/encryption-abandon-setup/g) ?? []).length;
    const before = abandons();
    await tap(offered);
    await tap(await reveal((current) => tagged(current, 'sync-encryption-submit'), 'Abandon setup (confirm)'));
    await until('the stranded change abandoned', () => abandons() > before, 60_000, 1_000);
    return true;
};

/**
 * A failed earlier run can leave the phone asking for its folder's passphrase (a no-key discovery that run's folder made; each
 * run uses a new folder). Take RN's stale-lock exit, as a user would: Enter passphrase at this plaintext folder answers "no
 * encrypted files here" and turns encryption off. True when it did.
 */
const clearStaleLock = async () => {
    await openSync();
    try { await reveal((current) => withText(current, en['settings.syncEncryptionLockedTitle']), 'the locked card'); } catch { return false; }
    await tapThenFind((current) => tagged(current, 'sync-encryption-open'), (current) => tagged(current, 'sync-passphrase-current'), 'the unlock flow (stale)');
    await fillTag('sync-passphrase-current', PASSPHRASE);
    await tapThenFind((current) => tagged(current, 'sync-encryption-submit'), (current) => withText(current, en['settings.syncEncryptionNoEncryptedRemote']), 'the stale-lock exit', 60_000);
    return true;
};

/** How many times the Sync screen's [operation] answered, whatever its outcome. */
const answered = (operation) => logs().replace(/\\/g, '').split('\n').filter((line) => line.includes(`"operation":"${operation}"`) && line.includes('"outcome":')).length;
const syncNow = async () => {
    await openSync();
    const before = answered('syncNow');
    await tapNode((current) => tagged(current, 'sync-now'), () => answered('syncNow') > before, 'Sync now', 90_000);
};
const toInbox = async () => {
    let nodes = await toTabs();
    if (!tabSelected(nodes, en['tab.inbox'])) nodes = await tapExpecting(tab(nodes, en['tab.inbox']), (current) => tabSelected(current, en['tab.inbox']), 'the Inbox');
    if (!onInbox(nodes)) await device.toTop();
    return waitFor('the Inbox', onInbox, 30_000);
};
/** The card's flow closed: its submit button is gone. */
const flowClosed = (current) => !tagged(current, 'sync-encryption-submit');

let dav = null;
let weak = null;
let lost = null;
let second = null;
const cleanup = cleanupOnExit([
    () => execFileSync(adbBin, ['-s', serial, 'reverse', '--remove', `tcp:${WEBDAV_PORT}`], { stdio: 'ignore' }),
    () => execFileSync(adbBin, ['-s', serial, 'reverse', '--remove', `tcp:${WEAK_PORT}`], { stdio: 'ignore' }),
    () => execFileSync(adbBin, ['-s', serial, 'reverse', '--remove', `tcp:${LOST_PORT}`], { stdio: 'ignore' }),
    () => { void lost?.close(); },
    () => sh("setprop debug.mindwtr.native.crypto_delay_ms ''"),
    () => { void dav?.close(); },
    () => { void weak?.close(); },
    () => second?.stop(),
]);

try {
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}\nrun: ${run}`);
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    dav = await serveWebdav({ port: WEBDAV_PORT, username: USER, password: PASSWORD });
    weak = await serveWebdav({ port: WEAK_PORT, username: USER, password: PASSWORD });
    weak.state.weakEtags = true;
    lost = await serveWebdav({ port: LOST_PORT, username: USER, password: PASSWORD });
    for (const port of [WEBDAV_PORT, WEAK_PORT, LOST_PORT]) execFileSync(adbBin, ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`], { stdio: 'inherit' });
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    sh(`setprop debug.mindwtr.native.crypto_delay_ms ${DELAY_MS}`);
    await device.stopApp();
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    device.launch(ACTIVITY);
    await waitFor('the Inbox', onInbox, 60_000);
    await until('the app to start sync', () => logs().includes('Native Android sync started'), 30_000, 1_000);
    second = await hostDevice({ bundle, name: 'second', log: (line) => { if (/error|fail/i.test(line)) console.log(`note - ${line.slice(0, 200)}`); } });
    await second.boot();

    // (1) WebDAV saved on the phone, plaintext; a capture to find later.
    await toInbox();
    const nodesInbox = await device.openCapture();
    await device.focusAtEnd(tagged(nodesInbox, 'capture-title') ?? fail('no capture field'));
    requireAppFront();
    sh(`input text '${titles.phone}'`);
    await waitFor('the capture text', (current) => tagged(current, 'capture-title')?.text === titles.phone, 15_000);
    await tapExpecting(button(await screen(), en['common.save']) ?? fail('no Save'), onInbox, 'the capture to close');
    let nodes = await openSync();
    if (!nodes.some((node) => node.text === en['settings.syncOff'])) {
        await tapNode((current) => tagged(current, 'sync-backend-off'), (current) => current.some((node) => node.text === en['settings.syncOff']), 'Sync off');
    }
    await saveWebdav(WEBDAV_PORT);
    await until('the phone\'s plaintext document in the folder', () => remoteArtifacts(dav, FOLDER).plain.some((file) => file.path.endsWith('/data.json') && file.text.includes(titles.phone)), 60_000);
    check(true, '(1) WebDAV saved; the first sync uploaded the phone\'s capture in plaintext');
    if (await clearStaleLock()) console.log('info - an earlier run\'s passphrase request was cleared through RN\'s stale-lock exit ("no encrypted files here")');

    // (2) Enable, with a tap answered during the Argon2id derivation.
    await tapThenFind(action(en['settings.syncEncryptionEnable']), (current) => tagged(current, 'sync-passphrase-next'), 'the Enable flow');
    for (const warning of ['settings.syncEncryptionWarningLost', 'settings.syncEncryptionWarningDevices']) {
        check(Boolean(await reveal((current) => withText(current, en[warning]), warning)), `(2) the enable flow shows RN's warning "${en[warning].slice(0, 60)}…"`);
    }
    // Review S4b 1: core takes at most 1,000 characters a field. 1,001 typed: the 1,001st is refused, and so is Enable (the
    // confirm field holds one character, so core's Enable is enabled and only the refusal stops it). Each typed character is a
    // core command, so this takes minutes; a pasted text is one edit.
    const transitionsStarted = () => (logs().match(/transition \{[^\n]*"phase":"start"/g) ?? []).length;
    await fillTag('sync-passphrase-confirm', '7');
    // adb's key events can outrun the field under load: type to 1,000 in chunks, reading the field back, then one more.
    await fillTag('sync-passphrase-next', '7'.repeat(100));
    // Read where it is: scrolling could move the focus the typing goes to.
    const nextLength = async () => {
        const node = tagged(await screen(), 'sync-passphrase-next') ?? await reveal((current) => tagged(current, 'sync-passphrase-next'), 'the passphrase field');
        return (node.text ?? '').length;
    };
    for (let round = 0; round < 60; round += 1) {
        const length = await nextLength();
        if (length >= 1000) break;
        requireAppFront();
        sh(`input text '${'7'.repeat(Math.min(100, 1000 - length))}'`);
        await sleep(2_000);
    }
    check(await nextLength() === 1000, '(2) the field took 1,000 characters');
    requireAppFront();
    sh("input text '7'");
    await sleep(2_000);
    await hideKeyboard();
    const shown = await nextLength();
    check(shown === 1000, `(2) a passphrase field holds at most core's 1,000 characters (${shown} after the 1,001st was typed)`);
    const startedBefore = transitionsStarted();
    // Core's Enable is enabled once its fields hold text (the typed characters drain first): only then does the tap test the refusal.
    await until('Enable enabled by core', async () => {
        try { return (await reveal((current) => tagged(current, 'sync-encryption-submit'), 'the Enable button')).enabled === 'true'; } catch { return false; }
    }, 600_000, 3_000);
    await tap(await reveal((current) => tagged(current, 'sync-encryption-submit'), 'the Enable button'));
    await sleep(3_000);
    check(transitionsStarted() === startedBefore && argonTimes().length === 0 && remoteArtifacts(dav, FOLDER).encrypted.length === 0,
        '(2) Enable after a refused 1,001st character runs nothing: no change started, nothing derived, nothing encrypted');
    await fillTag('sync-passphrase-next', PASSPHRASE);
    await fillTag('sync-passphrase-confirm', PASSPHRASE);
    await hideKeyboard();
    const submit = await reveal((current) => tagged(current, 'sync-encryption-submit'), 'the Enable button');
    const showPhrase = withDescription(await screen(), en['settings.syncEncryptionShowPassphrase']) ?? fail('no Show passphrase row beside Enable');
    check(withDescription(await screen(), en['settings.syncEncryptionShowPassphrase'])?.checked === 'false', '(2) the passphrase is hidden before Show passphrase');
    const argonBefore = argonTimes().length;
    const starts = () => (logs().match(/Native Android sync crypto argon2id start/g) ?? []).length;
    const startsBefore = starts();
    await tap(submit);
    // The derivation starts after the keystrokes sent before Enable, the server's strong-ETag proof and the fence; here it then
    // waits 6 s more (debug only). A tap made once it started must be answered before it ends.
    await until('the Argon2id derivation to start', () => starts() > startsBefore, 600_000, 250);
    const tappedAt = Date.now();
    await tap(showPhrase);
    // Its answer: the switch reads checked (RN's accessibilityState). uiautomator keeps password="true" on the field either way
    // (its keyboard type is Password), so the field's own flag proves nothing.
    await waitFor('Show passphrase answered', (current) => withDescription(current, en['settings.syncEncryptionShowPassphrase'])?.checked === 'true', DELAY_MS);
    const answeredMs = Date.now() - tappedAt;
    check(argonTimes().length === argonBefore, `(2) a tap made during the Argon2id derivation was answered in ${answeredMs} ms, before the derivation ended: the engine is never held by it`);
    await cardShows(en['settings.syncEncryptionStatusOn'], 120_000);
    const enabled = remoteArtifacts(dav, FOLDER);
    check(enabled.plain.length === 0 && enabled.encrypted.some((file) => file.path.endsWith('/data.json.enc')),
        `(2) Enable left only MWENC1 files in the folder (${enabled.all.map((file) => file.path.split('/').pop()).join(', ')})`);
    check(!enabled.all.some((file) => file.body.includes(Buffer.from(titles.phone))), '(2) the phone\'s task title is not readable on the server');
    const derivations = argonTimes();
    check(derivations.length > argonBefore, `(2) Argon2id on the phone: ${derivations.slice(argonBefore).map((d) => `${d.ms} ms (m=${d.m} KiB, t=${d.t}, p=${d.p})`).join(', ')}`);

    // (3) The second device: locked out, then unlocked with the same passphrase, reading the phone's task.
    await second.configure('webdav', fields(WEBDAV_PORT)).catch(() => null);
    check(encryptionCard(await second.view())?.rows.some((row) => row.text === en['settings.syncEncryptionLockedTitle']), '(3) the second device is locked out of the encrypted folder');
    await runEncryption(second, 'unlock', { current: PASSPHRASE });
    await second.syncNow('webdav', { ...fields(WEBDAV_PORT), password: null });
    check((await second.titles()).includes(titles.phone), '(3) with the same passphrase the second device reads the phone\'s task: the phone\'s Argon2id and AES-GCM equal core\'s');
    await second.capture(titles.host);
    await second.syncNow('webdav', { ...fields(WEBDAV_PORT), password: null });
    check(remoteArtifacts(dav, FOLDER).plain.length === 0, '(3) the second device wrote encrypted too');
    await syncNow();
    await until('the second device\'s task on the phone', () => phoneTasks()[titles.host] === 'inbox', 60_000);
    check(true, `(3) the phone decrypted the second device's "${titles.host}" exactly`);

    // (4) The second device changes the passphrase: the phone asks, refuses the old one, opens with the new one.
    await runEncryption(second, 'change', { current: PASSPHRASE, next: NEXT, confirm: NEXT });
    await second.capture(titles.rotated);
    await second.syncNow('webdav', { ...fields(WEBDAV_PORT), password: null });
    await syncNow();
    await cardShows(en['settings.syncEncryptionLockedTitle']);
    check(true, '(4) after the change on the other device the phone asks for the passphrase');
    // Leaves the phone as a run failing here does (asking for this folder's passphrase), to prove clearStaleLock on the next run.
    if (process.env.MINDWTR_ENC_STOP_LOCKED === '1') throw new Stopped('stopped while locked on purpose (MINDWTR_ENC_STOP_LOCKED=1)');
    const folderBefore = remoteArtifacts(dav, FOLDER).fingerprint;
    const tasksBefore = JSON.stringify(phoneTasks());
    await tapThenFind((current) => tagged(current, 'sync-encryption-open'), (current) => tagged(current, 'sync-passphrase-current'), 'the unlock flow');
    await fillTag('sync-passphrase-current', PASSPHRASE);
    await tapThenFind((current) => tagged(current, 'sync-encryption-submit'), (current) => withText(current, en['settings.syncEncryptionErrorWrongPassphrase']), 'the old passphrase refused', 60_000);
    check(remoteArtifacts(dav, FOLDER).fingerprint === folderBefore && JSON.stringify(phoneTasks()) === tasksBefore,
        `(4) the old passphrase is refused in RN's words ("${en['settings.syncEncryptionErrorWrongPassphrase']}") and changes no file and no task`);
    await fillTag('sync-passphrase-current', NEXT);
    await tapNode((current) => tagged(current, 'sync-encryption-submit'), flowClosed, 'the new passphrase', 120_000);
    await cardShows(en['settings.syncEncryptionStatusOn']);
    await syncNow();
    await until('the rotated task on the phone', () => phoneTasks()[titles.rotated] === 'inbox', 60_000);
    check(true, '(4) the new passphrase unlocks the phone, and it reads what was written after the change');

    // (5) A restart: the key stays sealed on the phone, so sync goes on with no passphrase.
    const argonTotal = argonTimes();
    await device.stopApp();
    await second.capture(titles.restart);
    await second.syncNow('webdav', { ...fields(WEBDAV_PORT), password: null });
    device.launch(ACTIVITY);
    await waitFor('the Inbox', onInbox, 60_000);
    await until('the task written while the app was closed', () => phoneTasks()[titles.restart] === 'inbox', 120_000);
    check(true, '(5) after a restart the phone synced the encrypted folder by itself, no passphrase typed');

    // (6) Disable: plaintext again.
    await openSync();
    await tapThenFind(action(en['settings.syncEncryptionDisable']), (current) => tagged(current, 'sync-encryption-submit'), 'the Disable flow');
    await tapNode((current) => tagged(current, 'sync-encryption-submit'), flowClosed, 'Disable', 120_000);
    await until('plaintext in the folder', () => {
        const files = remoteArtifacts(dav, FOLDER);
        return files.encrypted.length === 0 && files.plain.some((file) => file.path.endsWith('/data.json') && file.text.includes(titles.restart));
    }, 60_000);
    check(true, '(6) after Disable the folder holds plaintext again, every task in it');

    // (7) A weak-ETag server refuses enabling.
    await saveWebdav(WEAK_PORT);
    await tapThenFind(action(en['settings.syncEncryptionEnable']), (current) => tagged(current, 'sync-passphrase-next'), 'the Enable flow (weak server)');
    await fillTag('sync-passphrase-next', PASSPHRASE);
    await fillTag('sync-passphrase-confirm', PASSPHRASE);
    await tapThenFind((current) => tagged(current, 'sync-encryption-submit'), (current) => withText(current, en['settings.syncEncryptionErrorBackendIncompatible']), 'the weak server refused', 60_000);
    const weakFiles = remoteArtifacts(weak, FOLDER);
    check(weakFiles.encrypted.length === 0 && !weakFiles.all.some((file) => file.path.includes('fence')),
        `(7) a weak-ETag server refuses Enable in RN's words, nothing encrypted or fenced (${weakFiles.all.map((file) => file.path.split('/').pop()).join(', ')})`);
    await tapThenFind(action(en['common.cancel']), (current) => withDescription(current, en['settings.syncEncryptionEnable']), 'Cancel');

    // (7b) dd's "Abandon setup": an enable cut off by its server for good, abandoned, then sync elsewhere works.
    await saveWebdav(LOST_PORT);
    await tapThenFind(action(en['settings.syncEncryptionEnable']), (current) => tagged(current, 'sync-passphrase-next'), 'the Enable flow (lost server)');
    await fillTag('sync-passphrase-next', PASSPHRASE);
    await fillTag('sync-passphrase-confirm', PASSPHRASE);
    await hideKeyboard();
    lost.state.delayMs = 400;
    await tap(await reveal((current) => tagged(current, 'sync-encryption-submit'), 'the Enable button (lost server)'));
    await until('the first encrypted file on the lost server', () => remoteArtifacts(lost, FOLDER).encrypted.length > 0, 120_000, 250);
    lost.state.down = true;
    await cardShows(en['settings.syncEncryptionErrorTransitionIncomplete'], 180_000);
    check(true, '(7b) the server gone mid-enable leaves the change unfinished (RN\'s incomplete-change words)');
    await tapThenFind(action(en['settings.syncEncryptionAbandon']), (current) => withText(current, en['settings.syncEncryptionAbandonWarning']), 'the Abandon flow');
    check(true, '(7b) "Abandon setup" warns first that the location may stay partly encrypted');
    const lostRequests = lost.state.requests.length;
    // The card names the folder partly encrypted once Abandon ends (core's rule; the flow's submit is gone).
    await tapThenFind((current) => tagged(current, 'sync-encryption-submit'), (current) => withText(current, en['settings.syncEncryptionPartlyEncrypted']), 'Abandon', 90_000);
    check(lost.state.requests.length === lostRequests, '(7b) Abandon contacted no server');
    check(/"releaseCheck":"v1\.3\.4\/encryption-abandon-setup"/.test(logs().replace(/\\/g, '')) || logs().includes('v1.3.4/encryption-abandon-setup'),
        '(7b) the log shows v1.3.4/encryption-abandon-setup');
    await reveal(action(en['settings.syncEncryptionRecheck']), 'Check this location again');
    check(!withDescription(await screen(), en['settings.syncEncryptionEnable']),
        '(7b) the card names the folder partly encrypted and offers "Check this location again", not Enable');
    // The server is back: a device with encryption off never syncs plain data into the half-encrypted folder.
    lost.state.down = false;
    lost.state.delayMs = 0;
    const lostWrites = () => lost.state.requests.filter((request) => /^(PUT|DELETE|MOVE|COPY|MKCOL|LOCK) /.test(request)).length;
    const lostFiles = remoteArtifacts(lost, FOLDER).fingerprint;
    const writesBefore = lostWrites();
    await syncNow();
    check(lostWrites() === writesBefore && remoteArtifacts(lost, FOLDER).fingerprint === lostFiles, '(7b) Sync now with the server back writes nothing into the partly encrypted folder');
    check(logs().includes('blocked-partly-encrypted'), '(7b) the log shows sync paused there (decision=blocked-partly-encrypted)');
    const rechecks = () => logs().replace(/\\/g, '').split('\n').filter((line) => line.includes('"kind":"recheck"'));
    const rechecked = rechecks().length;
    await tap(await reveal(action(en['settings.syncEncryptionRecheck']), 'Check this location again'));
    await until('the recheck answered', () => rechecks().length > rechecked, 60_000, 1_000);
    const found = rechecks().at(-1).match(/"found":"(\w+)"/)?.[1];
    let stillPartly = false;
    await until('the card after the recheck', async () => {
        try {
            await reveal((current) => withDescription(current, en['settings.syncEncryptionRecheck']) ?? withDescription(current, en['settings.syncEncryptionEnable']), 'the card after the recheck');
        } catch { return false; }
        stillPartly = Boolean(withDescription(await screen(), en['settings.syncEncryptionRecheck']));
        return true;
    }, 30_000, 1_000);
    check((found === 'mixed') === stillPartly && lostWrites() === writesBefore,
        `(7b) "Check this location again" read the folder (found=${found}) and wrote nothing; the card ${stillPartly ? 'still pauses sync there' : 'cleared the mark'}`);
    await toInbox();
    const abandonCapture = await device.openCapture();
    await device.focusAtEnd(tagged(abandonCapture, 'capture-title') ?? fail('no capture field'));
    requireAppFront();
    sh(`input text '${titles.abandoned}'`);
    await waitFor('the capture text', (current) => tagged(current, 'capture-title')?.text === titles.abandoned, 15_000);
    await tapExpecting(button(await screen(), en['common.save']) ?? fail('no Save'), onInbox, 'the capture to close');
    await saveWebdav(WEBDAV_PORT);
    await until('the capture in the other folder', () => remoteArtifacts(dav, FOLDER).plain.some((file) => file.path.endsWith('/data.json') && file.text.includes(titles.abandoned)), 120_000);
    check(true, '(7b) after Abandon, sync to another location works again (Save, then the new capture is in its folder)');
    await openSync();
    await tapNode((current) => tagged(current, 'sync-backend-off'), (current) => current.some((node) => node.text === en['settings.syncOff']), 'Sync off');

    // (8) No passphrase anywhere on the phone; the key only sealed.
    for (const phrase of [PASSPHRASE, NEXT]) {
        const holders = grepApp(phrase);
        check(holders.length === 0, `(8) no app file holds a passphrase (${holders.join(', ') || 'none'}: files, journal, receipts, databases, preferences)`);
    }
    // The whole logcat buffer, searched on the phone (it outgrows a host-side read).
    const leaked = sh(`logcat -d | grep -c -F -e '${PASSPHRASE}' -e '${NEXT}' || true`).trim();
    check(leaked === '0', `(8) no logcat line holds a passphrase (${leaked} lines)`);
    const secretPrefs = sh(`run-as ${PKG} cat shared_prefs/SecureStore.xml`);
    console.log(`info - SecureStore entries: ${[...secretPrefs.matchAll(/name="([^"]+)"/g)].map(([, name]) => name).join(', ')}`);
    console.log(`info - Argon2id on the phone (ms): ${argonTotal.map((d) => `${d.ms} (m=${d.m} t=${d.t} p=${d.p})`).join(', ')}`);
    await toTabs();
    console.log('Encryption device check passed');
} catch (error) {
    try {
        console.log(`evidence - app log:\n${logs().split('\n').filter((line) => /\[sync|sync-encryption|crypto|Sync screen|Core action/.test(line))
            .slice(-60).map((line) => line.slice(0, 300)).join('\n')}`);
    } catch { /* the app is gone */ }
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    // An encryption change cut off by its server stopping leaves the app's state paused on an incomplete change, and later
    // checks' syncs blocked: let a running change end before the servers stop.
    try {
        const open = () => { const text = logs(); return (text.match(/transition \{[^\n]*"phase":"start"/g) ?? []).length - (text.match(/transition \{[^\n]*"phase":"end"/g) ?? []).length; };
        for (const deadline = Date.now() + 180_000; open() > 0 && Date.now() < deadline;) await sleep(2_000);
    } catch { /* the app is gone */ }
    // A failed run leaves its backend on a server that is about to stop: set Sync Off, as a passing run does, so the next
    // check's app does not keep failing syncs (and their toasts) against it.
    if (process.exitCode) {
        try {
            if (await abandonIfStranded()) console.log('info - the unfinished change was abandoned after the failure');
            await openSync();
            await tapNode((current) => tagged(current, 'sync-backend-off'), (current) => current.some((node) => node.text === en['settings.syncOff']), 'Sync off after a failure');
            console.log('info - Sync set Off after the failure');
        } catch (error) {
            console.log(`warn - Sync could not be set Off after the failure: ${error.message}`);
        }
    }
    cleanup();
    await sleep(500);
    process.exit(process.exitCode ?? 0);
}
