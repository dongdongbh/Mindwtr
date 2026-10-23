// Diagnostics log check for the isolated native Android development app (pass A4, L1).
//
//   ADB=/opt/android-sdk/platform-tools/adb node apps/android-native/scripts/check-log-device.mjs <adb-serial> [apk]
//
// Installs the debug APK with `install -r` (existing development data stays) and opens Settings › Data from the More sheet.
// (a) The Debug logging switch (in RN's colors for it, read from a screenshot) turned on writes RN's forced "Debug logging enabled" line and the switch's own command line to
// files/logs/mindwtr.log (pulled through run-as), each in RN's format: one JSON line per entry, keys in RN's order
// (ts, level, scope, message, stack, context), string context values, an ISO time. (b) Share log opens Android's share sheet
// (the chooser); the check presses Back and never picks a target, so nothing is sent. (c) Clear log deletes the file and shows
// core's "Log file cleared." toast. (d) The switch turned off: its command's line reaches logcat but not the file, which stays
// deleted. Forced lines while logging is off are checked by core's tests and the boot gates (the app has no forced line a
// check can cause here without changing data).
// It puts back what it changes: the switch, the log file as it was (copied off first), the language property, rotation. It
// touches only the development package (it refuses any other APK), never launches over another app, and leaves the app on its
// Inbox tab. Leave the device on its home screen.
// Exit 0 = pass, 1 = fail, 2 = refused before touching the device, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, check, connect, evidenced, fail, inboxCount, Stopped, switchOn, tab, tabSelected, tagged, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-log-device.mjs <adb-serial> [apk]');
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
const STAGED = '/data/local/tmp/mindwtr-native-dev-log.txt';
const FAULTS = ['fail_commit', 'delay_before_ms', 'delay_after_ms'];
const work = resolve(app, 'android/build/log-check');
const coreSrc = resolve(app, '../../packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));
// Core's log path (diagnostics-log.ts) under the app's files directory.
const LOG = `files/${/export const DIAGNOSTICS_LOG_RELATIVE_PATH = '([^']+)'/.exec(readFileSync(resolve(coreSrc, 'diagnostics-log.ts'), 'utf8'))[1]}`;
// Core's words for the controls (settings-menu-model.ts joins a row's title and description; data-settings-model.ts).
const words = {
    menu: en['tab.menu'], settings: en['nav.settings'], dataRow: `${en['settings.data']}. ${en['settings.menuDesc.data']}`,
    debugLogging: en['settings.debugLogging'], cleared: en['settings.logCleared'],
};

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { adbRaw, sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting } = device;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
const runAs = (command) => sh(`run-as ${PKG} ${command}`);
const logPresent = () => runAs(`sh -c 'if [ -f ${LOG} ]; then echo present; else echo absent; fi'`) === 'present';
const logText = () => (logPresent() ? adbRaw('exec-out', 'run-as', PKG, 'cat', LOG).toString('utf8') : null);
/** Logcat's count of core's task-command line for [operation] with [outcome] (its context is a JSON string, quotes escaped). */
const commands = (operation, outcome = 'saved') => device.logs(pid(), TAG).replace(/\\/g, '').split('\n').filter((line) => line.includes('native-android-dev-task-command')
    && line.includes(`"operation":"${operation}"`) && line.includes(`"outcome":"${outcome}"`)).length;

const onInbox = (nodes) => !tagged(nodes, 'menu-screen') && Number.isFinite(inboxCount(nodes));
const onData = (nodes) => Boolean(tagged(nodes, 'settings-data'));
const sheetOpen = (nodes) => Boolean(tagged(nodes, 'more-sheet'));
/** Back until the tabs show, then Menu › Settings › Data. */
const openData = async () => {
    let nodes = await screen();
    for (let step = 0; step < 8 && !(tab(nodes, words.menu) && !tagged(nodes, 'menu-screen') && !sheetOpen(nodes)); step += 1) {
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(900);
        nodes = await screen();
    }
    nodes = await tapExpecting(tab(nodes, words.menu) ?? fail('no Menu tab'), sheetOpen, 'the More sheet');
    nodes = await device.settle(nodes);
    nodes = await tapExpecting(withDescription(nodes, words.settings) ?? fail('no Settings in the More sheet'), (current) => Boolean(tagged(current, 'settings-main')), 'Settings');
    for (let step = 0; step < 6 && !withDescription(nodes, words.dataRow); step += 1) nodes = await device.swipe(nodes, 'down');
    return tapExpecting(withDescription(nodes, words.dataRow) ?? fail('no Data row in Settings'), onData, 'Settings › Data');
};
/** Taps the Debug logging switch and waits for it to read [on], with Share and Clear shown only while it is on. */
const setLogging = async (on) => {
    const nodes = await screen();
    if (switchOn(nodes, words.debugLogging) === on) return nodes;
    return tapExpecting(withDescription(nodes, words.debugLogging) ?? fail('no Debug logging switch'),
        (current) => switchOn(current, words.debugLogging) === on && Boolean(tagged(current, 'settings-share-log')) === on && Boolean(tagged(current, 'settings-clear-log')) === on,
        `Debug logging ${on ? 'on' : 'off'}`);
};
/**
 * The Debug logging switch's colors on screen, as RN draws that switch (sync-settings-sections.tsx sets only trackColor, drawn
 * solid; the thumb is AppCompat's, by the system's night mode): the track beside the thumb and the thumb's center, read from a
 * screenshot with ImageMagick.
 */
const density = Number(/(\d+)\s*$/.exec(sh('wm density'))[1]) / 160;
const systemDark = /yes/.test(sh('cmd uimode night'));
// SwitchCompat's thumb image is #FAFAFA: RN's thumb reads its color times 250/255.
const shade = (hex) => [0, 2, 4].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * 250 / 255).toString(16).padStart(2, '0')).join('').toUpperCase();
const RN_SWITCH = { on: { track: '3B82F6', thumb: shade(systemDark ? '80CBC4' : '008577') }, off: { track: '767577', thumb: shade(systemDark ? 'BDBDBD' : 'F1F1F1') } };
const switchColors = (nodes, on) => {
    const [l, t, r, b] = box(withDescription(nodes, words.debugLogging) ?? fail('no Debug logging switch'));
    const file = resolve(work, `switch-${on ? 'on' : 'off'}.png`);
    writeFileSync(file, adbRaw('exec-out', 'screencap', '-p'));
    const at = (dp) => execFileSync('magick', [file, '-format', `%[hex:p{${Math.round((l + r) / 2 + dp * density)},${Math.round((t + b) / 2)}}]`, 'info:'],
        { encoding: 'utf8' }).trim().slice(0, 6).toUpperCase();
    // RN's 24dp track and 20dp thumb 10dp off center (RnSwitchGraphic): the track shows 6dp to the thumb's other side.
    return { track: at(on ? -6 : 6), thumb: at(on ? 10 : -10) };
};
const near = (hex, want) => [0, 2, 4].every((i) => Math.abs(parseInt(hex.slice(i, i + 2), 16) - parseInt(want.slice(i, i + 2), 16)) <= 3);
const expectSwitch = (nodes, on, step) => {
    const seen = switchColors(nodes, on);
    const want = on ? RN_SWITCH.on : RN_SWITCH.off;
    check(near(seen.track, want.track) && near(seen.thumb, want.thumb),
        `(${step}) the switch ${on ? 'on' : 'off'} is RN's: track #${seen.track}, thumb #${seen.thumb} (RN #${want.track}, #${want.thumb}, system ${systemDark ? 'dark' : 'light'})`);
};

/** Each line as RN's app-log.ts writes it: JSON.stringify of { ts, level, scope, message, stack?, context? } and a newline. */
const RN_KEYS = ['ts', 'level', 'scope', 'message', 'stack', 'context'];
const parseLines = (text) => {
    check(text.endsWith('\n'), 'the log ends with a line break');
    return text.slice(0, -1).split('\n').map((line) => {
        const entry = JSON.parse(line);
        const keys = Object.keys(entry);
        if (JSON.stringify(entry) !== line) fail(`not one compact JSON line: ${line}`);
        if (keys.join() !== RN_KEYS.filter((key) => keys.includes(key)).join() || !['ts', 'level', 'scope', 'message'].every((key) => keys.includes(key))) fail(`keys not in RN's order: ${line}`);
        if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(entry.ts) || !['info', 'warn', 'error'].includes(entry.level)) fail(`ts or level not RN's: ${line}`);
        if (entry.context && Object.values(entry.context).some((value) => typeof value !== 'string')) fail(`a context value is not text: ${line}`);
        return entry;
    });
};

const originalLanguage = sh('getprop debug.mindwtr.native.language');
const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
let originalLog;
let originalLogging = null;
const restore = async () => {
    for (const name of FAULTS) { try { setProp(name, ''); } catch { /* device gone */ } }
    try {
        if (originalLogging !== null && front().includes(`${PKG}/`)) {
            if (!onData(await screen())) await openData();
            await setLogging(originalLogging);
        }
    } catch (error) { console.error(`RESTORE FAILED: Debug logging ${originalLogging ? 'on' : 'off'}: ${error.message}; put it back by hand`); }
    // The log file as it was (turning logging back on above wrote to it first).
    try {
        if (originalLog === null) runAs(`rm -f ${LOG}`);
        else if (originalLog !== undefined) {
            writeFileSync(resolve(work, 'original.log'), originalLog);
            adbRaw('push', resolve(work, 'original.log'), STAGED);
            runAs(`sh -c 'mkdir -p files/logs && cp ${STAGED} ${LOG}'`);
        }
    } catch (error) { console.error(`RESTORE FAILED: the log file: ${error.message}; its copy is ${resolve(work, 'original.log')}`); }
    try {
        if (front().includes(`${PKG}/`)) {
            let nodes = await screen();
            for (let step = 0; step < 8 && !(tab(nodes, en['tab.inbox']) && !tagged(nodes, 'menu-screen') && !sheetOpen(nodes)); step += 1) {
                sh('input keyevent KEYCODE_BACK');
                await sleep(900);
                nodes = await screen();
            }
            if (tab(nodes, en['tab.inbox']) && !tabSelected(nodes, en['tab.inbox'])) await tap(tab(nodes, en['tab.inbox']));
        }
    } catch { /* the app is gone */ }
    try { setProp('language', originalLanguage); } catch { /* device gone */ }
    for (const [name, value] of [['user_rotation', originalRotation], ['accelerometer_rotation', originalAccelerometer]]) {
        try { sh(value === 'null' ? `settings delete system ${name}` : `settings put system ${name} ${value}`); } catch { /* device gone */ }
    }
    try { sh(`rm -f ${UI_FILE} ${STAGED}`); } catch { /* device gone */ }
};

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    for (const name of FAULTS) setProp(name, '');
    // The selectors read core's English: the app boots in English whatever language it keeps (restored on exit).
    setProp('language', 'en');
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    device.launch(ACTIVITY);
    requireAppFront();
    sh('settings put system accelerometer_rotation 0');
    sh('settings put system user_rotation 0');
    await waitFor('the Inbox', onInbox, 60_000);

    // The switch and the file as they were; then logging off and no file, so the run starts from nothing.
    let nodes = await openData();
    originalLogging = switchOn(nodes, words.debugLogging);
    originalLog = logText();
    if (originalLog !== null) writeFileSync(resolve(work, 'original.log'), originalLog);
    console.log(`info - Debug logging was ${originalLogging ? 'on' : 'off'}; the log file ${originalLog === null ? 'did not exist' : `had ${originalLog.length} characters (copied to ${resolve(work, 'original.log')})`}`);
    nodes = await setLogging(false);
    runAs(`rm -f ${LOG}`);
    check(!logPresent(), `the run starts with logging off and no ${LOG}`);

    // (a) On: RN's forced line, then the switch's own command line, in RN's format.
    let saves = commands('dataSetting');
    nodes = await setLogging(true);
    await waitFor('the switch\'s command', () => commands('dataSetting') === saves + 1, 15_000);
    expectSwitch(await screen(), true, 'a');
    let text = null;
    for (let wait = 0; wait < 20 && !(text = logText())?.includes('native-android-dev-task-command'); wait += 1) await sleep(500);
    writeFileSync(resolve(work, 'on.log'), text ?? '');
    const lines = parseLines(text ?? fail(`no ${LOG} after turning logging on`));
    const enabledAt = lines.findIndex((line) => line.message === 'Debug logging enabled');
    check(enabledAt >= 0 && JSON.stringify(lines[enabledAt]) === JSON.stringify({ ts: lines[enabledAt].ts, level: 'info', scope: 'diagnostics', message: 'Debug logging enabled' }),
        `(a) RN's forced line: ${JSON.stringify(lines[enabledAt])}`);
    const command = lines.findIndex((line) => line.context?.releaseCheck === 'v1.3.3/native-android-dev-task-command' && line.context.operation === 'dataSetting');
    check(command > enabledAt && lines[command].scope === 'native-android' && lines[command].context.outcome === 'saved' && lines[command].context.category === 'storage',
        `(a) the switch's command line follows it: ${JSON.stringify(lines[command])}`);
    check(true, `(a) all ${lines.length} lines are RN's format (compact JSON, RN's key order, ISO time, text context)`);

    // (b) Share log: Android's share sheet opens; Back closes it; no target is picked.
    await tap(tagged(await screen(), 'settings-share-log') ?? fail('no Share log row'));
    let sheet = '';
    for (let wait = 0; wait < 20; wait += 1) {
        sheet = front();
        if (!sheet.includes(`${PKG}/`)) break;
        await sleep(500);
    }
    const chooser = sh('dumpsys activity activities').split('\n').some((line) => line.includes('act=android.intent.action.CHOOSER'));
    check(!sheet.includes(`${PKG}/`) && !sheet.includes(`${home}/`) && chooser, `(b) Share log opens the share sheet: ${sheet.trim()}`);
    for (let step = 0; step < 3 && !front().includes(`${PKG}/`); step += 1) {
        // Back only, never a tap: nothing is picked, so nothing is sent.
        sh('input keyevent KEYCODE_BACK');
        await sleep(1200);
    }
    requireAppFront();
    nodes = await waitFor('Settings › Data again', onData, 10_000);
    check(true, '(b) Back returns to Settings › Data with no target picked, so nothing was sent');

    // (c) Clear log: the file is deleted; core's toast says so. The share sheet's window can still be closing after Back and take a
    // tap (run 1), so the screen settles first; the file itself proves the delete, and a tap that deleted nothing is sent once more
    // (Clear writes nothing else, so a second one changes nothing).
    await sleep(1500);
    nodes = await device.settle(await screen());
    let toastSeen = false;
    let cleared = false;
    for (let attempt = 1; attempt <= 2 && !cleared; attempt += 1) {
        await tap(tagged(nodes, 'settings-clear-log') ?? fail('no Clear log row'));
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && !(cleared && toastSeen)) {
            nodes = await screen();
            toastSeen ||= nodes.some((node) => node.text === words.cleared);
            cleared = !logPresent();
        }
        if (!cleared) console.log(`note - Clear log tap ${attempt} left ${LOG} (${toastSeen ? 'its toast showed' : 'no toast'})`);
    }
    check(cleared, `(c) Clear log deletes ${LOG}`);
    check(toastSeen, `(c) Clear log shows core's "${words.cleared}" toast`);
    nodes = await waitFor('the toast to close', (current) => !current.some((node) => node.text === words.cleared), 10_000);

    // (d) Off: the switch's command is logged to logcat, not to the file.
    saves = commands('dataSetting');
    nodes = await setLogging(false);
    await waitFor('the switch\'s command', () => commands('dataSetting') === saves + 1, 15_000);
    expectSwitch(await screen(), false, 'd');
    await sleep(1500);
    if (logPresent()) {
        // Name what wrote while logging was off: each line's level, scope, message and releaseCheck (forced lines are allowed),
        // never its other context.
        for (const line of (logText() ?? '').split('\n').filter(Boolean)) {
            let entry = {};
            try { entry = JSON.parse(line); } catch { /* an unreadable line is named as such */ }
            console.log(`note - (d) written while off: ${JSON.stringify([entry.level, entry.scope, entry.message, entry.context?.releaseCheck ?? null])}`);
        }
    }
    check(!logPresent(), '(d) with logging off the switch\'s command line reaches logcat but no file is written');
    console.log('Diagnostics log device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
