// App lock check for the isolated native Android development app.
//
//   node apps/android-native/scripts/check-app-lock-device.mjs <adb-serial> [apk]
//
// The phone must have no screen lock (no PIN, pattern, password or biometrics). The check never sets or changes the phone's
// lock; if the device lock prompt opens, the phone has one, and the check closes the prompt and stops (exit 3). Installs the
// debug APK with `install -r` (existing development data stays) and checks against core's own views on database copies:
// (a) Settings › General's App lock row shows core's words, off; turning it on shows RN's no-screen-lock line (core's
// `errors.unavailable`) under the row and stores nothing (core still says off, no generalSetting command ran); (b) with App lock
// turned on through core's own setGeneralSetting on a host copy (what RN's switch stores after a yes: the per-device
// `settings.security.mobileAppLockEnabled`), the app opens on RN's lock screen in core's words instead of its tabs, its own
// prompt answers with the no-screen-lock line, and Unlock keeps it locked; (c) rotation, leaving for the home screen and
// coming back, and process death keep it locked (the setting survives a restart); (d) App lock turned off through core opens
// the tabs again, and General's switch reads off. Turning it off from the switch needs an unlocked app with App lock on, which
// needs a screen lock, so this check cannot reach it; (e) the relock delay (#1423), with the debug build's device lock saying yes
// (debug.mindwtr.native.app_lock_answer): the switch turns App lock on and General draws core's relock row (shot as
// relock-row.png); with "After 5 minutes", leaving for the home screen for 65 seconds and coming back opens the app without asking;
// with "After 1 minute", the same leave comes back on the lock screen. Each database change happens while the app is stopped: core writes a
// copy, the copy is staged beside the database and size-checked, the old WAL and SHM go, and a rename puts it in place; the
// untouched pull stays in android/build/app-lock-check/original-<n> for a manual recovery. It puts the setting back as it
// found it, on failure too, reads core to prove it, goes back to the Inbox tab, and restores rotation; a restore that fails
// exits 1. It needs host `bun`.
// Exit 0 = pass, 1 = fail, 2 = refused before touching the device, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { check, connect, evidenced, fail, inboxCount, inEditor, Stopped, switchOn, tab, tabSelected, tagged, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-app-lock-device.mjs <adb-serial> [apk]');
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
const TAG = 'MindwtrNativeDev';
const UI_FILE = '/data/local/tmp/mindwtr-native-dev-ui.xml';
const STAGED = '/data/local/tmp/mindwtr-native-dev-app-lock.db';
const PROPS = ['fail_commit', 'delay_before_ms', 'delay_after_ms', 'language', 'app_lock_answer'];
const DB = 'mindwtr-native-dev.db';
const work = resolve(app, 'android/build/app-lock-check');
const coreSrc = resolve(app, '../../packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { adbRaw, sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting } = device;
const phoneLocale = (sh('getprop persist.sys.locale') || sh('getprop ro.product.locale')).trim();
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
const runAs = (command) => sh(`run-as ${PKG} ${command}`);
const commands = (operation) => device.logs(pid(), TAG).replace(/\\/g, '').split('\n').filter((line) => line.includes('native-android-dev-task-command')
    && line.includes(`"operation":"${operation}"`)).length;

// ---- core on a copy of the app's database ----
const pullDatabase = (name = 'db') => {
    const dir = resolve(work, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = runAs('ls files').split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    return resolve(dir, DB);
};
/**
 * Core on a copy: `set` turns App lock on or off (CHECK_VALUE) through core's setGeneralSetting, as the app's switch sends it, and
 * checkpoints the WAL; every mode prints the stored value, General's App lock row, the More sheet's and Settings' labels the
 * check taps, and the lock screen's words.
 */
const core = (mode, db = pullDatabase(), on = false, delay = null) => JSON.parse(execFileSync('bun', ['-e', `
    import { Database } from 'bun:sqlite';
    import { SqliteAdapter, createNativeHostContract, flushPendingSave, setStorageAdapter, useTaskStore } from '${coreSrc}/index.ts';
    const db = new Database(process.env.CHECK_DB);
    setStorageAdapter(new SqliteAdapter({
        run: async (sql, params = []) => { db.query(sql).run(...params); },
        all: async (sql, params = []) => db.query(sql).all(...params),
        get: async (sql, params = []) => db.query(sql).get(...params) ?? undefined,
        exec: async (sql) => { db.exec(sql); },
    }));
    const host = createNativeHostContract();
    if (!(await host.setLanguage({ storedLanguage: 'en', systemLocale: process.env.CHECK_LOCALE || null })).ok) throw new Error('language');
    const ready = await host.activate({ writeSafetyReady: true });
    if (!ready.ok) throw new Error(ready.error.message);
    const value = (result) => { if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message); return result.value; };
    if (process.env.CHECK_MODE === 'set') {
        value(await host.setGeneralSetting({ requestId: crypto.randomUUID(), edit: { type: 'appLock', value: process.env.CHECK_VALUE === 'true' } }));
        if (process.env.CHECK_DELAY) value(await host.setGeneralSetting({ requestId: crypto.randomUUID(), edit: { type: 'appLockRelockDelay', value: Number(process.env.CHECK_DELAY) } }));
        await flushPendingSave();
        if (useTaskStore.getState().persistenceFailure) throw new Error('save failed: ' + useTaskStore.getState().persistenceFailure.message);
    }
    const more = value(host.getMoreMenu());
    const menu = value(host.getSettingsMenu({}));
    const row = value(host.getGeneralSettings({})).privacy.appLock;
    const out = {
        stored: useTaskStore.getState().settings.security?.mobileAppLockEnabled ?? null,
        relockMinutes: useTaskStore.getState().settings.security?.mobileAppLockRelockDelayMinutes ?? 0,
        row: { label: row.label, description: row.description, value: row.value, unavailable: row.errors.unavailable },
        settingsTile: [...more.primary, ...more.utilities].find((item) => item.id === 'settings').label,
        generalRow: menu.groups.flat().find((item) => item.id === 'general').accessibilityLabel,
        strings: value(host.getStrings({ keys: ['tab.menu', 'appLock.title', 'appLock.unavailable', 'appLock.unlock'] })).strings,
    };
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    console.log(JSON.stringify(out));
    process.exit(0);
`], { encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, CHECK_DB: db, CHECK_MODE: mode, CHECK_VALUE: String(on), CHECK_DELAY: delay === null ? '' : String(delay), CHECK_LOCALE: phoneLocale } }).trim().split('\n').pop());

// ---- UI ----
const locked = (nodes) => Boolean(tagged(nodes, 'app-lock'));
/** The tabs show: no lock screen, Menu screen (Settings is one), editor or More sheet over them. */
const onTabs = (nodes) => !locked(nodes) && !tagged(nodes, 'menu-screen') && !inEditor(nodes) && !tagged(nodes, 'more-sheet') && Boolean(tab(nodes, en['tab.menu']));
/** The boot is over: the lock screen, or a screen of the app (the tabs, a Menu screen, the editor). */
const booted = (nodes) => locked(nodes) || Boolean(tab(nodes, en['tab.menu']) || tagged(nodes, 'menu-screen')) || inEditor(nodes);
/** The device lock prompt is up: the screen shows none of this app's nodes. */
const promptUp = (nodes) => nodes.length > 0 && !nodes.some((node) => node.package === PKG);
const closePromptAndStop = () => {
    sh('input keyevent KEYCODE_BACK');
    throw new Stopped('the device lock prompt opened: this phone has a screen lock, and this check runs only on a phone without one');
};

let changes = 0;
/**
 * Stops the app and waits for its process to end; pulls its database untouched (original-<n>, the recovery copy); lets core set
 * App lock on a second copy and checkpoint it into one file; stages that file beside the database, checks its size, removes the
 * old WAL and SHM (the copy holds their content), and renames it over the database, all while the app is stopped; then launches.
 */
const setLock = async (on, delay = null) => {
    await device.stopApp();
    changes += 1;
    const original = pullDatabase(`original-${changes}`);
    const db = resolve(work, `set-${changes}`, DB);
    rmSync(dirname(db), { recursive: true, force: true });
    mkdirSync(dirname(db), { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${original}${suffix}`)) copyFileSync(`${original}${suffix}`, `${db}${suffix}`);
    const result = core('set', db, on, delay);
    check(!existsSync(`${db}-wal`) || statSync(`${db}-wal`).size === 0, `App lock ${on ? 'on' : 'off'} through core's setGeneralSetting is in one database file`);
    const next = `files/${DB}.app-lock-new`;
    try {
        adbRaw('push', db, STAGED);
        runAs(`cp ${STAGED} ${next}`);
        const staged = Number(runAs(`stat -c %s ${next}`));
        if (staged !== statSync(db).size) fail(`the staged database is ${staged} bytes, not ${statSync(db).size}`);
        if (pid() !== '') fail('the app started while its database was being replaced');
        runAs(`rm -f files/${DB}-wal files/${DB}-shm`);
        runAs(`mv -f ${next} files/${DB}`);
    } catch (error) {
        console.error(`the app's database before this change is in ${dirname(original)}: with the app stopped, push it and move it over files/${DB} (and its -wal and -shm) with run-as`);
        throw error;
    } finally {
        try { sh(`rm -f ${STAGED}`); runAs(`rm -f ${next}`); } catch { /* device gone */ }
    }
    device.launch(ACTIVITY);
    return result;
};
/** Settings › General from the tabs: the Menu tab's More sheet, Settings, then General. */
const openGeneral = async (seen) => {
    await waitFor('the app', booted, 60_000);
    await toInbox();
    let nodes = await screen();
    nodes = await tapExpecting(tab(nodes, seen.strings['tab.menu']) ?? fail('no Menu tab'), (current) => Boolean(tagged(current, 'more-sheet')), 'the More sheet');
    nodes = await device.settle(nodes);
    nodes = await tapExpecting(withDescription(nodes, seen.settingsTile) ?? fail('no Settings in the More sheet'), (current) => Boolean(tagged(current, 'settings-main')), 'Settings');
    return tapExpecting(withDescription(nodes, seen.generalRow) ?? fail('no General row'), (current) => Boolean(withDescription(current, seen.row.label)), 'Settings › General');
};
/** The lock screen showing core's title and its no-screen-lock line, and none of the app's tabs. */
const lockScreen = (seen) => (nodes) => {
    if (promptUp(nodes)) closePromptAndStop();
    return locked(nodes) && nodes.some((node) => node.text === seen.strings['appLock.title']) && tagged(nodes, 'app-lock-message')?.text === seen.strings['appLock.unavailable']
        && !tab(nodes, seen.strings['tab.menu']);
};

let original = null;
let originalDelay = 0;
const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
/** Back until the tabs show (General, Settings and the More sheet close), then the Inbox tab. */
const toInbox = async () => {
    for (let step = 0; step < 8; step += 1) {
        const nodes = await screen();
        if (onTabs(nodes)) {
            if (!tabSelected(nodes, en['tab.inbox'])) await tap(tab(nodes, en['tab.inbox']) ?? fail('no Inbox tab'));
            return;
        }
        if (locked(nodes)) fail('the app is locked');
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(900);
    }
    fail('the tabs did not come back');
};
/** Puts App lock back as the check found it and proves it from core; with it off, back to the Inbox tab. A failure exits 1. */
const restore = async () => {
    for (const name of PROPS) { try { setProp(name, ''); } catch { /* device gone */ } }
    if (original !== null) {
        try {
            const before = core('read');
            if ((before.stored === true) !== original || before.relockMinutes !== originalDelay) await setLock(original, originalDelay);
            const after = core('read');
            const now = after.stored === true;
            if (now !== original) fail(`core says App lock is ${now ? 'on' : 'off'}`);
            if (after.relockMinutes !== originalDelay) fail(`core says the relock delay is ${after.relockMinutes} minutes, not ${originalDelay}`);
            console.log(`restored - core says App lock is ${original ? 'on' : 'off'}, as the check found it`);
            if (!original) {
                await waitFor('the app unlocked', (current) => booted(current) && !locked(current), 60_000);
                await toInbox();
            }
        } catch (error) {
            console.error(`RESTORE FAILED: App lock ${original ? 'on' : 'off'}: ${error.message}; put it back by hand`);
            process.exitCode = 1;
        }
    }
    for (const [name, value] of [['user_rotation', originalRotation], ['accelerometer_rotation', originalAccelerometer]]) {
        try { sh(value === 'null' ? `settings delete system ${name}` : `settings put system ${name} ${value}`); } catch { /* device gone */ }
    }
    try { sh(`rm -f ${UI_FILE} ${STAGED}`); } catch { /* device gone */ }
};

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    for (const name of PROPS) setProp(name, '');
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    device.launch(ACTIVITY);
    requireAppFront();
    sh('settings put system accelerometer_rotation 0');
    sh('settings put system user_rotation 0');
    await waitFor('the app or the lock screen', (nodes) => booted(nodes) || promptUp(nodes), 60_000);
    let seen = core('read');
    original = seen.stored === true;
    originalDelay = seen.relockMinutes;
    if (original) {
        seen = await setLock(false);
        console.log('note - App lock was on; turned off through core for the check, and turned on again at the end');
    }

    // (a) General's App lock row in core's words, off; turning it on without a screen lock shows core's line and stores nothing.
    let nodes = await openGeneral(seen);
    check(!switchOn(nodes, seen.row.label) && nodes.some((node) => node.text === seen.row.description), `(a) General shows "${seen.row.label}" (core's words), off`);
    const saves = commands('generalSetting');
    await tap(withDescription(nodes, seen.row.label));
    nodes = await waitFor('core\'s no-screen-lock line', (current) => { if (promptUp(current)) closePromptAndStop(); return current.some((node) => node.text === seen.row.unavailable); }, 15_000);
    check(!switchOn(nodes, seen.row.label), `(a) turning it on shows "${seen.row.unavailable}" under the row, and the switch stays off`);
    await sleep(1500);
    seen = core('read');
    check(commands('generalSetting') === saves && seen.stored !== true && seen.row.value === false, '(a) nothing is stored: core still says off, and no generalSetting command ran');

    // (b) App lock on through core (RN's stored value): the app opens on the lock screen; its own prompt answers; Unlock keeps it locked.
    seen = await setLock(true);
    check(seen.stored === true && seen.row.value === true, '(b) core\'s setGeneralSetting stores settings.security.mobileAppLockEnabled = true, as RN\'s switch does after a yes');
    nodes = await waitFor('the lock screen with its no-screen-lock line', lockScreen(seen), 60_000);
    check(!Number.isFinite(inboxCount(nodes)), `(b) the app opens on "${seen.strings['appLock.title']}" instead of its tabs, and its own prompt answers "${seen.strings['appLock.unavailable']}"`);
    const unlock = tagged(nodes, 'app-lock-unlock') ?? fail('no Unlock button');
    check(unlock['content-desc'] === seen.strings['appLock.unlock'], `(b) the lock screen offers core's "${seen.strings['appLock.unlock']}"`);
    await tap(unlock);
    await sleep(1500);
    await waitFor('the app still locked after Unlock', lockScreen(seen), 15_000);
    check(true, '(b) Unlock without a screen lock keeps the app locked');

    // (c) Rotation, the home screen and back, and process death keep it locked.
    sh('settings put system user_rotation 1');
    await waitFor('the lock screen in landscape', lockScreen(seen), 20_000);
    sh('settings put system user_rotation 0');
    await waitFor('the lock screen in portrait', lockScreen(seen), 20_000);
    requireAppFront();
    sh('input keyevent KEYCODE_HOME');
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    await sleep(1000);
    device.launch(ACTIVITY);
    await waitFor('the lock screen after the home screen', lockScreen(seen), 30_000);
    const processId = pid();
    requireAppFront();
    sh('input keyevent KEYCODE_HOME');
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    await sleep(1500);
    sh(`run-as ${PKG} kill -9 ${processId}`);
    await waitFor('process death', () => pid() !== processId, 10_000);
    device.launch(ACTIVITY);
    await waitFor('the lock screen after process death', lockScreen(seen), 60_000);
    check(true, '(c) rotation, the home screen and back, and process death keep the app locked (the setting survives a restart)');

    // (d) App lock off through core: the tabs come back, and General's switch reads off.
    seen = await setLock(false);
    nodes = await openGeneral(seen);
    check(seen.stored === false && !switchOn(nodes, seen.row.label), '(d) App lock off through core opens the tabs again, and General\'s switch reads off');

    // (e) The relock delay (#1423): the debug build's device lock says yes, so the switch turns App lock on with the app open.
    const relockLabel = en['settings.mobile.appLockRelock'];
    const relockRow = (current, choice) => current.find((node) => node['content-desc'] === `${relockLabel}: ${en[choice]}`);
    setProp('app_lock_answer', 'yes');
    await tap(withDescription(nodes, seen.row.label));
    nodes = await waitFor('the relock delay row', (current) => !locked(current) && switchOn(current, seen.row.label) && Boolean(relockRow(current, 'settings.mobile.appLockRelockImmediately')), 15_000);
    check(core('read').stored === true, `(e) the switch turns App lock on, and General shows "${relockLabel}: ${en['settings.mobile.appLockRelockImmediately']}" under it`);
    writeFileSync(resolve(work, 'relock-row.png'), adbRaw('exec-out', 'screencap', '-p'));
    setProp('app_lock_answer', '');
    /** Chooses [choice] in the relock picker, and proves core stored [minutes]. */
    const choose = async (from, choice, minutes) => {
        nodes = await tapExpecting(relockRow(await screen(), from) ?? fail('no relock row'), (current) => Boolean(tagged(current, 'settings-picker')), 'the relock picker');
        if (from === 'settings.mobile.appLockRelockImmediately') writeFileSync(resolve(work, 'relock-picker.png'), adbRaw('exec-out', 'screencap', '-p'));
        await tap(withDescription(nodes, en[choice]) ?? fail(`no "${en[choice]}" in the picker`));
        await waitFor(`"${en[choice]}" on the row`, (current) => Boolean(relockRow(current, choice)), 15_000);
        await sleep(1500);
        const stored = core('read').relockMinutes;
        if (stored !== minutes) fail(`core stored a relock delay of ${stored} minutes, not ${minutes}`);
    };
    /** Home screen for 65 seconds, then back. */
    const away = async () => {
        requireAppFront();
        sh('input keyevent KEYCODE_HOME');
        await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
        await sleep(65_000);
        device.launch(ACTIVITY);
    };
    await choose('settings.mobile.appLockRelockImmediately', 'settings.mobile.appLockRelockAfter5', 5);
    await away();
    await waitFor('General open again', (current) => Boolean(relockRow(current, 'settings.mobile.appLockRelockAfter5')), 30_000);
    await sleep(3000);
    nodes = await screen();
    check(!locked(nodes) && Boolean(relockRow(nodes, 'settings.mobile.appLockRelockAfter5')),
        '(e) with "After 5 minutes", 65 seconds away comes back on General, open, without asking');
    await choose('settings.mobile.appLockRelockAfter5', 'settings.mobile.appLockRelockAfter1', 1);
    await away();
    await waitFor('the lock screen after 65 seconds away', lockScreen(seen), 30_000);
    check(true, '(e) with "After 1 minute", 65 seconds away comes back on the lock screen');
    console.log('App lock device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
