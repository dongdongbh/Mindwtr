// Last-screen restore check for the isolated native Android development app (pass O2b; RN's #842, core's session-restore.ts).
//
//   node apps/android-native/scripts/check-session-restore-device.mjs <adb-serial> [apk]
//
// Installs the debug APK with `install -r` (existing development data stays) and launches it as the launcher does, with the
// app's own start (device.mjs launch startTab ''): (a) a start with no recent last screen opens Focus, as RN does; (b) Someday,
// left with Home and then force-stopped (no saved state survives), comes back on the next start, and Back from it returns to
// the tabs instead of leaving the app; (c) History comes back on its Archived tab; (d) a project opened from a link comes back
// open; (e) Settings (a screen RN never records) leaves the tab under it to come back; (f) a process death with saved state
// keeps the open search (no restore); (g) a cold start by a link opens the link, not the recent last screen. (a) dates the stored screens 26 minutes
// back with debug.mindwtr.native.session_age_ms, so the phone's clock is never changed. The last
// screen lives in RN's RKStorage key `mindwtr:session:lastRoute`, as RN keeps it. It touches only the development package,
// never launches over another app, restores rotation and its debug properties on exit, and leaves the app on its Inbox tab.
// Leave the device on its home screen before running. Exit 0 = pass, 1 = fail, 2 = refused before touching the device, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { check, connect, evidenced, fail, Stopped, tab, tabSelected, tagged, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: check-session-restore-device.mjs <adb-serial> [apk]');
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
const UI_FILE = '/data/local/tmp/mindwtr-native-dev-ui.xml';
const DB = 'mindwtr-native-dev.db';
const PROPS = ['session_age_ms'];
const work = resolve(app, 'android/build/session-restore-check');
const coreSrc = resolve(app, '../../packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, requireAppFront, screen, waitFor, tap, tapExpecting } = device;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
const sheetOpen = (nodes) => Boolean(tagged(nodes, 'more-sheet'));
const onTabs = (nodes) => Boolean(tab(nodes, en['tab.menu'])) && !tagged(nodes, 'menu-screen') && !sheetOpen(nodes);
const inScreen = (title) => (nodes) => Boolean(tagged(nodes, 'menu-screen')) && nodes.some((node) => node.text === title);
/** The app's own start, as the launcher starts it: the restore runs (device.mjs launch startTab ''). */
const start = async (done, description) => {
    await device.stopApp();
    device.launch(ACTIVITY, { startTab: '' });
    requireAppFront();
    return waitFor(description, done, 60_000);
};
/** Home, as a user leaves (RN stores the last screen again on leaving), then a force-stop: no saved state survives. */
const leaveAndKill = async () => {
    requireAppFront();
    sh('input keyevent KEYCODE_HOME');
    await sleep(1500);
    await device.stopApp();
};
const openTile = async (label, title) => {
    let nodes = await screen();
    if (!sheetOpen(nodes)) nodes = await tapExpecting(tab(nodes, en['tab.menu']) ?? fail('no Menu tab'), sheetOpen, 'the More sheet');
    nodes = await device.settle(nodes);
    return tapExpecting(withDescription(nodes, label) ?? fail(`no ${label} tile`), inScreen(title), `the ${title} screen`);
};
const toTabs = async () => {
    for (let step = 0; step < 4; step += 1) {
        const nodes = await screen();
        if (onTabs(nodes)) return nodes;
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(900);
    }
    return fail('the tabs did not come back');
};
const liveProject = () => {
    const dir = resolve(work, 'db');
    mkdirSync(dir, { recursive: true });
    const present = sh(`run-as ${PKG} ls files`).split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    const row = execFileSync('sqlite3', [resolve(dir, DB), "SELECT id, title FROM projects WHERE deletedAt IS NULL AND status = 'active' ORDER BY title LIMIT 1"], { encoding: 'utf8' }).trim();
    if (!row) return fail('the development library has no active project to open');
    const [id, ...title] = row.split('|');
    return { id, title: title.join('|') };
};

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const restore = async () => {
    for (const name of PROPS) { try { setProp(name, ''); } catch { /* device gone */ } }
    // The other checks' start (device.mjs launch sets it again on each launch; a check that launches its own way finds it too).
    try { setProp('start_tab', 'inbox'); } catch { /* device gone */ }
    // Leave the app on its Inbox tab (the start the other checks expect), started as they start it.
    try {
        if (front().includes(`${PKG}/`)) {
            await device.stopApp();
            device.launch(ACTIVITY);
            const nodes = await waitFor('the Inbox tab', (current) => Boolean(tab(current, en['tab.inbox'])), 60_000);
            if (!tabSelected(nodes, en['tab.inbox'])) await tap(tab(nodes, en['tab.inbox']));
        }
    } catch { /* the app is gone */ }
    for (const [name, value] of [['user_rotation', originalRotation], ['accelerometer_rotation', originalAccelerometer]]) {
        try { sh(value === 'null' ? `settings delete system ${name}` : `settings put system ${name} ${value}`); } catch { /* device gone */ }
    }
    try { sh(`rm -f ${UI_FILE}`); } catch { /* device gone */ }
};

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    sh('settings put system accelerometer_rotation 0');
    sh('settings put system user_rotation 0');

    // (a) No recent last screen: every screen stored in this run is dated 26 minutes back, so the next start opens Focus.
    setProp('session_age_ms', String(26 * 60 * 1000));
    let nodes = await start((current) => Boolean(tab(current, en['tab.menu'])), 'the app');
    await toTabs();
    nodes = await screen();
    await tap(tab(nodes, en['tab.inbox']));
    await waitFor('the Inbox tab', (current) => tabSelected(current, en['tab.inbox']), 15_000);
    await leaveAndKill();
    nodes = await start((current) => onTabs(current) && tabSelected(current, en['tab.next']), 'Focus');
    check(tabSelected(nodes, en['tab.next']), '(a) a start whose last screen is older than 25 minutes opens Focus, as RN does');
    setProp('session_age_ms', '');

    // (b) Someday comes back after a force-stop; Back from it returns to the tabs.
    await openTile(en['someday.title'], en['someday.title']);
    await leaveAndKill();
    nodes = await start(inScreen(en['someday.title']), 'Someday again');
    check(true, '(b) Someday, left with Home and force-stopped, comes back on the next start');
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    nodes = await waitFor('the tabs after Back', onTabs, 15_000);
    check(front().includes(`${PKG}/`), '(b) Back from the restored Someday returns to the tabs; the app stays open');

    // (c) History comes back on its Archived tab.
    await openTile(en['nav.history'], en['nav.history']);
    nodes = await screen();
    await tapExpecting(tab(nodes, en['nav.archived']) ?? fail('no Archived tab'), (current) => tabSelected(current, en['nav.archived']), 'the Archived tab');
    await leaveAndKill();
    nodes = await start((current) => inScreen(en['nav.history'])(current) && tabSelected(current, en['nav.archived']), 'History on Archived');
    check(true, '(c) History comes back on its Archived tab');
    await toTabs();

    // (d) A project opened from a link comes back open.
    const project = liveProject();
    requireAppFront();
    sh(`am start -W -a android.intent.action.VIEW -d 'mindwtr-native-dev://open?project=${encodeURIComponent(project.id)}' ${PKG}`);
    await waitFor(`the project ${project.title}`, (current) => tagged(current, 'project-title-input')?.text === project.title, 30_000);
    await leaveAndKill();
    await start((current) => tagged(current, 'project-title-input')?.text === project.title, 'the project again');
    check(true, `(d) the open project comes back open (${project.title})`);
    await toTabs();

    // (e) Settings is never recorded: the tab under it (the Inbox, not the Focus start) comes back.
    nodes = await screen();
    await tap(tab(nodes, en['tab.inbox']));
    await waitFor('the Inbox tab', (current) => tabSelected(current, en['tab.inbox']), 15_000);
    await openTile(en['settings.title'], en['settings.title']);
    await leaveAndKill();
    nodes = await start((current) => onTabs(current) && tabSelected(current, en['tab.inbox']), 'the Inbox under Settings');
    check(true, '(e) a death in Settings brings back the tab under it (the Inbox), as RN keeps the previous snapshot');
    // (f) A process the system killed (its task still in recents, saved state kept) comes back from its own saved state, never
    // a restore: the open search is still open (review O2b P2-1).
    await toTabs();
    nodes = await screen();
    nodes = await tapExpecting(withDescription(nodes, en['search.title']) ?? fail('no Search button in the header'),
        (current) => Boolean(tagged(current, 'global-search')), 'the search screen');
    requireAppFront();
    sh('input keyevent KEYCODE_HOME');
    await sleep(1500);
    sh(`am kill ${PKG}`);
    await sleep(1500);
    device.launch(ACTIVITY, { startTab: '' });
    await waitFor('the search again', (current) => Boolean(tagged(current, 'global-search')), 60_000);
    check(true, '(f) after a process death with saved state, the open search is still open (no restore over it)');
    await toTabs();

    // (g) A link wins over a recent last screen: Someday is stored, then a cold start by a link opens the link's screen.
    await openTile(en['someday.title'], en['someday.title']);
    await leaveAndKill();
    sh(`am start -W -a android.intent.action.VIEW -d 'mindwtr-native-dev:///waiting' ${PKG}`);
    await waitFor('Waiting from the link', inScreen(en['waiting.title']), 60_000);
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    nodes = await waitFor('the tabs after Back', onTabs, 15_000);
    check(tabSelected(nodes, en['tab.next']), '(g) a cold start by a link opens the link\'s screen over a recent Someday, and Back returns to Focus');
    console.log('Session restore device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
