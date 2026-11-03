


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
const entryReads = () => device.logs(pid(), TAG).split('\n').filter((line) => line.includes('native-android-entry-point')).length;
const queued = () => { try { return runAs('cat no_backup/entries/queue'); } catch { return ''; } };
const commands = (operation) => device.logs(pid(), TAG).replace(/\\/g, '').split('\n').filter((line) => line.includes('native-android-dev-task-command')
    && line.includes(`"operation":"${operation}"`)).length;


const pullDatabase = (name = 'db') => {
    const dir = resolve(work, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = runAs('ls files').split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    return resolve(dir, DB);
};


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
        taskId: useTaskStore.getState().tasks.find((task) => !task.deletedAt && task.status !== 'done' && task.status !== 'archived')?.id ?? null,
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


const locked = (nodes) => Boolean(tagged(nodes, 'app-lock'));

const onTabs = (nodes) => !locked(nodes) && !tagged(nodes, 'menu-screen') && !inEditor(nodes) && !tagged(nodes, 'more-sheet') && Boolean(tab(nodes, en['tab.menu']));

const booted = (nodes) => locked(nodes) || Boolean(tab(nodes, en['tab.menu']) || tagged(nodes, 'menu-screen')) || inEditor(nodes);

const promptUp = (nodes) => nodes.length > 0 && !nodes.some((node) => node.package === PKG);
const closePromptAndStop = () => {
    sh('input keyevent KEYCODE_BACK');
    throw new Stopped('the device lock prompt opened: this phone has a screen lock, and this check runs only on a phone without one');
};

let changes = 0;


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
        try { sh(`rm -f ${STAGED}`); runAs(`rm -f ${next}`); } catch {                   }
    }
    device.launch(ACTIVITY);
    return result;
};

const openGeneral = async (seen) => {
    await waitFor('the app', booted, 60_000);
    await toInbox();
    let nodes = await screen();
    nodes = await tapExpecting(tab(nodes, seen.strings['tab.menu']) ?? fail('no Menu tab'), (current) => Boolean(tagged(current, 'more-sheet')), 'the More sheet');
    nodes = await device.settle(nodes);
    nodes = await tapExpecting(withDescription(nodes, seen.settingsTile) ?? fail('no Settings in the More sheet'), (current) => Boolean(tagged(current, 'settings-main')), 'Settings');
    return tapExpecting(withDescription(nodes, seen.generalRow) ?? fail('no General row'), (current) => Boolean(withDescription(current, seen.row.label)), 'Settings › General');
};

const lockScreen = (seen) => (nodes) => {
    if (promptUp(nodes)) closePromptAndStop();
    return locked(nodes) && nodes.some((node) => node.text === seen.strings['appLock.title']) && tagged(nodes, 'app-lock-message')?.text === seen.strings['appLock.unavailable']
        && !tab(nodes, seen.strings['tab.menu']);
};

let original = null;
let originalDelay = 0;
const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');

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

const restore = async () => {
    for (const name of PROPS) { try { setProp(name, ''); } catch {                   } }
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
        try { sh(value === 'null' ? `settings delete system ${name}` : `settings put system ${name} ${value}`); } catch {                   }
    }
    try { sh(`rm -f ${UI_FILE} ${STAGED}`); } catch {                   }
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


    let nodes = await openGeneral(seen);
    check(!switchOn(nodes, seen.row.label) && nodes.some((node) => node.text === seen.row.description), `(a) General shows "${seen.row.label}" (core's words), off`);
    const saves = commands('generalSetting');
    await tap(withDescription(nodes, seen.row.label));
    nodes = await waitFor('core\'s no-screen-lock line', (current) => { if (promptUp(current)) closePromptAndStop(); return current.some((node) => node.text === seen.row.unavailable); }, 15_000);
    check(!switchOn(nodes, seen.row.label), `(a) turning it on shows "${seen.row.unavailable}" under the row, and the switch stays off`);
    await sleep(1500);
    seen = core('read');
    check(commands('generalSetting') === saves && seen.stored !== true && seen.row.value === false, '(a) nothing is stored: core still says off, and no generalSetting command ran');


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


    seen = await setLock(false);
    nodes = await openGeneral(seen);
    check(seen.stored === false && !switchOn(nodes, seen.row.label), '(d) App lock off through core opens the tabs again, and General\'s switch reads off');


    const relockLabel = en['settings.mobile.appLockRelock'];
    const relockRow = (current, choice) => current.find((node) => node['content-desc'] === `${relockLabel}: ${en[choice]}`);
    setProp('app_lock_answer', 'yes');
    await tap(withDescription(nodes, seen.row.label));
    nodes = await waitFor('the relock delay row', (current) => !locked(current) && switchOn(current, seen.row.label) && Boolean(relockRow(current, 'settings.mobile.appLockRelockImmediately')), 15_000);
    check(core('read').stored === true, `(e) the switch turns App lock on, and General shows "${relockLabel}: ${en['settings.mobile.appLockRelockImmediately']}" under it`);
    writeFileSync(resolve(work, 'relock-row.png'), adbRaw('exec-out', 'screencap', '-p'));
    setProp('app_lock_answer', '');

    const choose = async (from, choice, minutes) => {
        nodes = await tapExpecting(relockRow(await screen(), from) ?? fail('no relock row'), (current) => Boolean(tagged(current, 'settings-picker')), 'the relock picker');
        if (from === 'settings.mobile.appLockRelockImmediately') writeFileSync(resolve(work, 'relock-picker.png'), adbRaw('exec-out', 'screencap', '-p'));
        await tap(withDescription(nodes, en[choice]) ?? fail(`no "${en[choice]}" in the picker`));
        await waitFor(`"${en[choice]}" on the row`, (current) => Boolean(relockRow(current, choice)), 15_000);
        await sleep(1500);
        const stored = core('read').relockMinutes;
        if (stored !== minutes) fail(`core stored a relock delay of ${stored} minutes, not ${minutes}`);
    };

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


    setProp('app_lock_answer', 'yes');
    await tap(tagged(await screen(), 'app-lock-unlock') ?? fail('no Unlock button'));
    await waitFor('General open again', (current) => !locked(current) && Boolean(relockRow(current, 'settings.mobile.appLockRelockAfter1')), 15_000);
    await choose('settings.mobile.appLockRelockAfter1', 'settings.mobile.appLockRelockImmediately', 0);
    setProp('app_lock_answer', '');
    const taskId = core('read').taskId ?? fail('no open task in the development data');
    requireAppFront();
    sh('input keyevent KEYCODE_HOME');
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    await sleep(1000);
    const linkProcess = pid();
    const readsBefore = entryReads();
    sh(`am start -W -a android.intent.action.VIEW -d 'mindwtr-native-dev://open?task=${taskId}' ${PKG}`);
    await waitFor('the lock screen after the task link', lockScreen(seen), 30_000);
    for (let sample = 0; sample < 8; sample += 1) {
        const current = await screen();
        if (!locked(current) || inEditor(current)) fail(`sample ${sample}: the lock screen did not stay (the app or the editor showed)`);
        await sleep(500);
    }
    check(pid() === linkProcess, '(f) the task link comes back on a steady lock screen for 4 seconds, in the same process');
    writeFileSync(resolve(work, 'link-held.png'), adbRaw('exec-out', 'screencap', '-p'));
    const readUnderLock = entryReads() > readsBefore;
    const heldInQueue = queued().includes(taskId);
    console.log(`observed - under the lock: core read the entry ${readUnderLock}, the entry still queued ${heldInQueue}`);
    check(!readUnderLock && heldInQueue, '(f) the task link waits in the entry queue, unread by core, while the lock covers the app (RN b7bccbbc3)');
    setProp('app_lock_answer', 'yes');
    await tap(tagged(await screen(), 'app-lock-unlock') ?? fail('no Unlock button'));
    await waitFor('the task in the editor after the unlock', (current) => !locked(current) && inEditor(current), 30_000);
    writeFileSync(resolve(work, 'link-opened.png'), adbRaw('exec-out', 'screencap', '-p'));
    setProp('app_lock_answer', '');
    check(!queued().includes(taskId), '(f) the unlock opens the task in the editor, and the entry leaves the queue');
    console.log('App lock device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
