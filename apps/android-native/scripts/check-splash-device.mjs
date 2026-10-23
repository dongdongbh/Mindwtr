// Start screen check for the isolated native Android development app (MainActivity's installSplashScreen).
//
//   node apps/android-native/scripts/check-splash-device.mjs <adb-serial> [apk]
//
// Installs the debug APK with `install -r` (existing development data stays). Each start is cold and slowed by the debug
// property boot_delay_ms, so the screen can be sampled while core boots:
// (a) a launcher start held 6 s shows only RN's start screen (its background and the blue icon in every screenshot, no
//     ProgressBar in any UI dump) until the Inbox shows, with no cap line;
// (b) a link start to the Calendar (a list with its own read) held 6 s shows the same, then the Calendar, with no cap line;
// (c) a launcher start held 12.5 s lets the start screen go at its 10 s cap: RN's spinner shows, then the Inbox, and logcat
//     has the v1.3.5/native-splash-cap line with stage=boot.
// Screenshots go to android/build/splash-check. It touches only the development package (it refuses any other APK), never
// launches over another app, clears its debug property on exit, and leaves the app on its Inbox. Leave the phone on its home screen.
// Exit 0 = pass, 1 = fail, 2 = refused before touching the device, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { check, connect, evidenced, fail, inboxCount, Stopped, tagged } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-splash-device.mjs <adb-serial> [apk]');
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
const CAP_LINE = 'releaseCheck=v1.3.5/native-splash-cap';
const work = resolve(app, 'android/build/splash-check');
mkdirSync(work, { recursive: true });

const device = connect({ serial, pkg: PKG, uiFile: '/data/local/tmp/mindwtr-native-dev-ui.xml', adb: adbBin });
const { sh, adbRaw, front, home, pid, screen, stopApp } = device;
const setDelay = (ms) => sh(`setprop debug.mindwtr.native.boot_delay_ms '${ms}'`);

// RN's splash background (app.json's expo-splash-screen) for the phone's mode now.
const dark = /yes/.test(sh('cmd uimode night'));
const splashBg = dark ? [0x0b, 0x10, 0x20] : [0xf4, 0xf6, 0xfb];
const [width, height] = sh('wm size').match(/(\d+)x(\d+)/).slice(1).map(Number);
/**
 * A screenshot saved as [name], read as RN's start screen: the band above the icon is the splash background (within 6 a
 * channel) and the icon's middle is blue (the Mindwtr mark), which the plain loading screen and the spinner never are.
 */
const shot = (name) => {
    const file = resolve(work, `${name}.png`);
    writeFileSync(file, adbRaw('exec-out', 'screencap', '-p'));
    const [band, mean] = execFileSync('magick', [file, '-format', `%[hex:p{${width / 2},${Math.round(height * 0.2)}}]`, 'info:'], { encoding: 'utf8' }).trim()
        .split(' ').concat(execFileSync('magick', [file, '-gravity', 'center', '-crop', '240x240+0+0', '-format', '%[fx:mean.r] %[fx:mean.b]', 'info:'],
            { encoding: 'utf8' }).trim());
    const rgb = [0, 2, 4].map((i) => parseInt(band.slice(i, i + 2), 16));
    const [r, b] = mean.split(' ').map(Number);
    return { file, splash: rgb.every((v, i) => Math.abs(v - splashBg[i]) <= 6) && b - r > 0.15, band, r, b };
};
const start = (intent) => {
    const current = front();
    if (!current.includes(`${PKG}/`) && !current.includes(`${home}/`)) throw new Stopped(`another app is in front; not launching over it: ${current.trim()}`);
    // The Inbox start this check was written for, with no last-screen restore (device.mjs launch does the same; pass O2b).
    sh(`setprop debug.mindwtr.native.start_tab 'inbox'`);
    sh(`am start ${intent}`);
};
const launcher = `-a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n ${ACTIVITY}`;
const progress = (nodes) => nodes.some((node) => node.class === 'android.widget.ProgressBar');
const atInbox = (nodes) => !Number.isNaN(inboxCount(nodes));
/** One UI dump while the start screen holds the window, streamed (never written on the phone); it may not answer then. */
const heldUi = () => { try { return adbRaw('exec-out', 'uiautomator', 'dump', '/dev/tty').toString('utf8'); } catch { return ''; } };

/** Cold start [intent] held [delayMs]: every sample before [shown] is RN's start screen with no ProgressBar; then [shown] within 20 s. */
const heldStart = async (label, intent, delayMs, shown) => {
    await stopApp();
    setDelay(delayMs);
    const began = Date.now();
    start(intent);
    let samples = 0;
    await sleep(400);
    while (Date.now() - began < delayMs - 600) {
        const sample = shot(`${label}-${samples}`);
        if (!sample.splash) fail(`${label}: ${sample.file} at ${Date.now() - began} ms is not the start screen (band #${sample.band}, center r=${sample.r} b=${sample.b})`);
        if (heldUi().includes('class="android.widget.ProgressBar"')) fail(`${label}: a ProgressBar showed at ${Date.now() - began} ms`);
        samples += 1;
    }
    check(samples >= 2, `${label}: ${samples} samples during the held boot are RN's start screen, with no ProgressBar`);
    await device.waitFor(`${label}: the first screen after the boot`, shown, 20_000);
    shot(`${label}-shown`);
    const processId = pid();
    check(!device.logs(processId, TAG).includes(CAP_LINE), `${label}: no cap line (the start screen let go before its cap)`);
};

try {
    console.log(execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { encoding: 'utf8' }).trim());
    await heldStart('launcher', launcher, 6_000, atInbox);
    await heldStart('calendar-link', `-a android.intent.action.VIEW -d 'mindwtr-native-dev:///calendar'`, 6_000, (nodes) => Boolean(tagged(nodes, 'calendar')));

    // (c) Past the cap: the spinner, then the Inbox, and the cap's line.
    await stopApp();
    setDelay(12_500);
    const began = Date.now();
    start(launcher);
    await sleep(10_800);
    const spinner = await screen();
    check(progress(spinner) && !atInbox(spinner), `capped: RN's spinner shows ${Date.now() - began} ms after the start, before the Inbox`);
    shot('capped-spinner');
    await device.waitFor('the Inbox after the slow boot', atInbox, 20_000);
    await sleep(500);
    const line = device.logs(pid(), TAG).split('\n').find((text) => text.includes(CAP_LINE));
    check(Boolean(line) && /stage\W+boot/.test(line ?? ''), `capped: logcat has the cap line with stage=boot (${line?.trim()})`);
    setDelay('');
    // The app left as it normally starts: a cold start without the delay, on its Inbox.
    await stopApp();
    start(launcher);
    await device.waitFor('the Inbox', atInbox, 20_000);
    console.log(`PASS (screenshots in ${work})`);
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    try { setDelay(''); } catch { /* the phone is gone */ }
}
