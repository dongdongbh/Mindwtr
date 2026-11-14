import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { check, connect, evidenced, fail, Stopped, tab, tagged, withDescription } from './device.mjs';
import { cleanupOnExit } from './check-net-device.mjs';
import { serveDropbox } from './dropbox-harness.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: DROPBOX_APP_KEY=<key the APK was built with> node check-dropbox-device.mjs <adb-serial> [apk]');
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
const CLIENT = (process.env.DROPBOX_APP_KEY ?? '').trim();
if (!/^[A-Za-z0-9]+$/.test(CLIENT)) {
    console.error('REFUSED: set DROPBOX_APP_KEY to the fake key the APK was built with (DROPBOX_APP_KEY=mindwtrcheck1 ./gradlew :app:assemblePlayDebug)');
    process.exit(2);
}
const ACTIVITY = `${PKG}/${PKG}.MainActivity`;
const REDIRECT = 'mindwtr-native-dev://redirect';
const TAG = 'MindwtrNativeDev';
const UI_FILE = '/data/local/tmp/mindwtr-native-dev-ui.xml';
const PORT = Number(process.env.MINDWTR_DROPBOX_PORT ?? 18790);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const work = resolve(app, 'android/build/dropbox-check');
const { en } = await import(resolve(repo, 'packages/core/src/i18n/locales/en.ts'));

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, pid, screen, waitFor, tapExpecting } = device;
const logs = () => device.logs(pid(), TAG);
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
const onSync = (nodes) => Boolean(tagged(nodes, 'settings-sync'));
const withPrefix = (nodes, prefix) => nodes.find((node) => (node['content-desc'] ?? '').startsWith(prefix));
const statusText = (nodes) => nodes.find((node) => (node.text ?? '').startsWith('Status: '))?.text ?? null;
const rkKeys = () => {
    const dir = resolve(work, 'rk');
    mkdirSync(dir, { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) {
        try { writeFileSync(resolve(dir, `RKStorage${suffix}`), device.adbRaw('exec-out', 'run-as', PKG, 'cat', `databases/RKStorage${suffix}`)); } catch { }
    }
    const out = execFileSync('sqlite3', ['-json', resolve(dir, 'RKStorage'), 'SELECT key, value FROM catalystLocalStorage'], { encoding: 'utf8' }).trim();
    return Object.fromEntries((out ? JSON.parse(out) : []).map((row) => [row.key, row.value]));
};
const until = async (description, holds, timeoutMs = 60_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await holds())) {
        if (Date.now() > deadline) fail(`timed out waiting for ${description}`);
        await sleep(1_000);
    }
};
const shot = (name) => {
    mkdirSync(work, { recursive: true });
    const file = resolve(work, `${name}.png`);
    writeFileSync(file, device.adbRaw('exec-out', 'screencap', '-p'));
    console.log(`info - screenshot ${file}`);
};

const openSync = async () => {
    let nodes = await screen();
    if (onSync(nodes)) return nodes;
    nodes = await tapExpecting(tab(nodes, en['tab.menu']) ?? fail('no Menu tab'), (next) => Boolean(tagged(next, 'more-sheet')), 'the More sheet');
    await tapExpecting(withDescription(await device.settle(nodes), en['nav.settings']) ?? fail('no Settings tile'),
        (next) => Boolean(tagged(next, 'settings-main')), 'Settings');
    return tapExpecting(await device.revealNode((next) => withPrefix(next, `${en['settings.sync']}. `), 'Sync row'), onSync, 'Settings › Sync', 30_000);
};
const tapTag = async (tag, expected, description, timeoutMs = 30_000) =>
    tapExpecting(await device.revealNode((current) => tagged(current, tag), tag), expected, description, timeoutMs);

let dropbox = null;
const cleanup = cleanupOnExit([
    () => setProp('dropbox_origin', ''),
    () => execFileSync(adbBin, ['-s', serial, 'reverse', '--remove', `tcp:${PORT}`], { stdio: 'ignore' }),
    () => { void dropbox?.close(); },
    () => sh(`rm -f ${UI_FILE}`),
]);

try {
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    const before = front();
    if (!before.includes(`${PKG}/`) && !before.includes(`${home}/`)) throw new Stopped(`another app is in front: ${before.trim()}`);
    dropbox = await serveDropbox({ port: PORT, clientId: CLIENT });
    execFileSync(adbBin, ['-s', serial, 'reverse', `tcp:${PORT}`, `tcp:${PORT}`], { stdio: 'inherit' });
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    setProp('dropbox_origin', ORIGIN);
    await device.stopApp();
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    device.launch(ACTIVITY);
    await waitFor('the tabs', (nodes) => Boolean(tab(nodes, en['tab.menu'])), 60_000);

    await openSync();
    let nodes = await tapTag('sync-backend-dropbox', (current) => Boolean(tagged(current, 'sync-dropbox-connect')), 'the Dropbox panel');
    check(nodes.some((node) => node.text === `${en['settings.dropboxRedirectUri']}: ${REDIRECT}`), `(1) the Dropbox panel shows RN's redirect line for this build (${REDIRECT})`);
    check(statusText(nodes) === en['settings.syncMobile.statusNotConnected'], `(1) the panel starts "${en['settings.syncMobile.statusNotConnected']}"`);
    shot('dropbox-panel-disconnected');

    await device.tap(await device.revealNode((current) => tagged(current, 'sync-dropbox-connect'), 'Connect Dropbox'));
    await until('the browser to open the Dropbox authorize URL', () => dropbox.state.authorizes.length > 0, 45_000);
    const asked = dropbox.state.authorizes[0];
    check(asked.client_id === CLIENT && asked.redirect_uri === REDIRECT && asked.response_type === 'code',
        `(2) the browser opened /oauth2/authorize with the build's app key and redirect (${asked.client_id}, ${asked.redirect_uri})`);
    check(asked.code_challenge_method === 'S256' && /^[A-Za-z0-9_-]{43}$/.test(asked.code_challenge ?? '') && asked.state?.length >= 16,
        '(2) the request carries a PKCE S256 challenge and a state');
    check(asked.token_access_type === 'offline' && asked.scope === 'files.content.read files.content.write files.metadata.read',
        '(2) it asks for RN\'s scopes and offline access');
    console.log(`info - the browser in front: ${front().trim()}`);

    sh(`am start -W -a android.intent.action.VIEW -d '${dropbox.redirectFor(asked)}' -n ${ACTIVITY}`);
    await until('the connected panel', async () => statusText(await screen()) === en['settings.syncMobile.statusConnected'], 60_000);
    check(dropbox.state.tokens.includes('authorization_code'), '(3) the app exchanged the code (the fake checked the verifier against the challenge)');
    await until('the first Dropbox sync', () => dropbox.state.files.has('/data.json'), 60_000);
    const keys = rkKeys();
    check(keys['@mindwtr_sync_backend'] === 'cloud' && keys['@mindwtr_cloud_provider'] === 'dropbox',
        '(3) Connect activated Dropbox in RN\'s RKStorage keys and synced at once');
    check(keys['@mindwtr_dropbox_last_rev'] === dropbox.state.files.get('/data.json').rev, '(3) the Dropbox cursor is stored under RN\'s key');
    const prefs = sh(`run-as ${PKG} cat shared_prefs/SecureStore.xml`);
    const access = [...dropbox.state.access.keys()].at(-1);
    const refresh = [...dropbox.state.refresh].at(-1);
    check(/name="key_v1-mindwtr_dropbox_tokens"/.test(prefs) && !prefs.includes(access) && !prefs.includes(refresh),
        '(3) the tokens are sealed in RN\'s SecureStore entry, never plain');
    check(!logs().includes(access) && !logs().includes(refresh) && !logs().includes(asked.state), '(3) no log line holds a token or the state');
    check(/releaseCheck[^\n]*v1\.3\.9\/native-dropbox[^\n]*connected/.test(logs().replace(/\\/g, '')), '(3) the diagnostics log shows native-dropbox outcome=connected');
    shot('dropbox-panel-connected');

    const uploads = dropbox.state.requests.length;
    await tapTag('sync-now', () => dropbox.state.requests.length > uploads, 'Sync now', 60_000);
    check(dropbox.state.requests.slice(uploads).some((line) => line.endsWith('/2/files/download') || line.endsWith('/2/files/get_metadata')),
        '(4) Sync now read Dropbox again with the stored token');
    console.log('PASS - native Dropbox sign-in and sync against the local fake');
} catch (error) {
    evidenced(error);
    console.log(`info - fake Dropbox requests: ${dropbox?.state.requests.join(', ') || 'none'}`);
    try {
        console.log(logs().split('\n').filter((line) => /sync|Dropbox|dropbox/.test(line)).slice(-80).join('\n'));
    } catch { }
    throw error;
} finally {
    cleanup();
}
