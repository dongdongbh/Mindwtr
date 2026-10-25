// Intl date check for the isolated native Android development app.
//
//   node apps/android-native/scripts/check-intl-device.mjs <adb-serial> [apk]
//
// Sets the debug-only property `debug.mindwtr.native.intl_check=1` and starts the app in a fresh process. While its bundle
// loads, the app formats two fixed dates through the host's Intl (host-polyfills.js over IcuDateTimeFormat.kt, Android's
// ICU as Hermes uses it) for en-US, de-DE, zh-CN, ja-JP and the device's own locale, over core's option sets
// (host-entry.ts INTL_CHECK_OPTIONS): resolvedOptions, format, formatToParts and the three toLocale*String, one log line
// per case. This computer's Node Intl formats the same cases in the phone's time zone and the phone's locale (for the
// cases without one). The check FAILS on any difference from RN's own output, `intl-hermes-baseline.json`: every case
// through RN 0.81.5's Hermes DateTimeFormat on this S23 (the hermes-android AAR run through app_process, replayed through
// the polyfill). A phone whose locale or time zone differs from the baseline's stops the check. Node's differences are
// printed only as diagnostics (a difference only in spacing, U+202F or U+2009 for a space, is marked so). It installs
// with `install -r` (existing development data stays), touches only the development package (it refuses any other APK),
// never launches over another app, and clears its property and force-stops the app on exit. Leave the device on its home
// screen before running. Exit 0 = every case equals RN's, 1 = fail, 2 = refused before touching the device, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { connect, evidenced, fail, Stopped } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-intl-device.mjs <adb-serial> [apk]');
    process.exit(2);
}
const app = resolve(import.meta.dirname, '..');
const apk = apkArg ?? resolve(app, 'android/app/build/outputs/apk/play/debug/app-play-debug.apk');
const adbBin = process.env.ADB ?? '/home/dd/Android/Sdk/platform-tools/adb';
const aapt2 = process.env.AAPT2 ?? '/home/dd/Android/Sdk/build-tools/36.1.0/aapt2';
const PKG = 'tech.dongdongbh.mindwtr.nativeclient.dev';
// Never install anything but the development package (install -r would upgrade it).
const apkPackage = execFileSync(aapt2, ['dump', 'packagename', apk], { encoding: 'utf8' }).trim();
if (apkPackage !== PKG) {
    console.error(`REFUSED: ${apk} is package "${apkPackage}", not ${PKG}`);
    process.exit(2);
}
const ACTIVITY = `${PKG}/${PKG}.MainActivity`;
const TAG = 'MindwtrNativeDev';
const MARK = 'Native Android intl check ';
const PASSPHRASE_MARK = 'Native Android passphrase check ';
/** host-entry.ts PASSPHRASE_CHECK_CASES, in the same order. */
const PASSPHRASE_CHECK_CASES = ['cafe\u0301 \u00e9t\u00e9', '\u1112\u1161\u11ab\uae00', 'A\u030a \u212b \u00c5 \u212a', 'pass \ud83d\ude00 \u0130 \u1e9b\u0323', '\u00f1\u006e\u0303\ufb01'];
const passphraseBytes = (passphrase) => Buffer.from(passphrase.normalize('NFC'), 'utf8').toString('hex');
const baseline = JSON.parse(readFileSync(resolve(import.meta.dirname, 'intl-hermes-baseline.json'), 'utf8'));

const device = connect({ serial, pkg: PKG, uiFile: '/data/local/tmp/mindwtr-native-dev-ui.xml', adb: adbBin });
const { sh, home, front, pid } = device;
const setProp = (value) => sh(`setprop debug.mindwtr.native.intl_check '${value}'`);

/** What Node's Intl gives for one case, in the same shape as the app's line. */
const nodeResult = ({ locale, options, time }, deviceLocale) => {
    const attempt = (work) => { try { return work(); } catch (error) { return { error: error.name }; } };
    const tag = locale ?? deviceLocale;
    const date = new Date(time);
    const made = attempt(() => new Intl.DateTimeFormat(tag, options));
    const dtf = made instanceof Intl.DateTimeFormat ? made : null;
    return {
        resolved: dtf ? dtf.resolvedOptions() : made,
        format: dtf ? attempt(() => dtf.format(date)) : made,
        parts: dtf ? attempt(() => dtf.formatToParts(date)) : made,
        toLocaleString: attempt(() => date.toLocaleString(tag, options)),
        toLocaleDateString: attempt(() => date.toLocaleDateString(tag, options)),
        toLocaleTimeString: attempt(() => date.toLocaleTimeString(tag, options)),
    };
};
/** Stable text for a value: object keys sorted (Hermes's resolvedOptions order is its own). */
const text = (value) => JSON.stringify(value, (_key, inner) => (inner && typeof inner === 'object' && !Array.isArray(inner)
    ? Object.fromEntries(Object.keys(inner).sort().map((key) => [key, inner[key]])) : inner));
const spacing = (value) => value.replace(/[   ]/g, ' ');

try {
    const zone = sh('getprop persist.sys.timezone');
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')}) / locale ${sh('getprop persist.sys.locale')} / zone ${zone}`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    console.log(`node ${process.version} / ICU ${process.versions.icu} (CLDR ${process.versions.cldr})`);
    if (!zone) throw new Stopped('the phone reports no time zone');
    if (zone !== baseline.device.zone) throw new Stopped(`the baseline is for ${baseline.device.zone}; the phone is in ${zone}`);
    setProp('');
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });

    // The cases run once, while the bundle loads: a fresh process.
    setProp('1');
    sh(`am force-stop ${PKG}`);
    for (let i = 0; i < 20 && pid(); i += 1) await sleep(500);
    for (let i = 0; i < 20 && !front().includes(`${home}/`); i += 1) await sleep(500);
    device.launch(ACTIVITY);
    let appPid = '';
    for (let i = 0; i < 20 && !appPid; i += 1, await sleep(500)) appPid = pid();
    if (!appPid) fail('the app did not start');
    // Collect by case number: logcat is read again until every case is in.
    const lines = new Map();
    const passphrases = new Map();
    let total = 0;
    for (const deadline = Date.now() + 60_000; Date.now() < deadline
        && (!total || lines.size < total || passphrases.size < PASSPHRASE_CHECK_CASES.length); await sleep(1000)) {
        for (const entry of device.logs(appPid, TAG).split('\n')) {
            if (entry.includes(`${MARK}failed`)) fail(`the app's intl check failed: ${entry}`);
            const passphraseAt = entry.indexOf(PASSPHRASE_MARK);
            if (passphraseAt >= 0) {
                const { index, bytes } = JSON.parse(entry.slice(passphraseAt + PASSPHRASE_MARK.length).split(' ').slice(1).join(' '));
                passphrases.set(index, bytes);
                continue;
            }
            const at = entry.indexOf(MARK);
            if (at < 0) continue;
            const [count, ...json] = entry.slice(at + MARK.length).split(' ');
            const [index, of] = count.split('/').map(Number);
            total = of;
            lines.set(index, JSON.parse(json.join(' ')));
        }
    }
    setProp('');
    if (!total || lines.size < total) fail(`only ${lines.size} of ${total || '?'} intl check lines arrived`);
    PASSPHRASE_CHECK_CASES.forEach((passphrase, index) => {
        const phone = passphrases.get(index);
        if (phone !== passphraseBytes(passphrase)) fail(`passphrase case ${index + 1}: the phone's NFC bytes ${JSON.stringify(phone)}, Node's ${passphraseBytes(passphrase)}`);
    });
    console.log(`ok - ${PASSPHRASE_CHECK_CASES.length} sync passphrases normalize to Node's NFC bytes in the phone's engine`);

    process.env.TZ = zone;
    const cases = [...lines.keys()].sort((a, b) => a - b).map((index) => lines.get(index));
    const deviceLocale = cases.find((entry) => !entry.locale && !entry.options)?.resolved?.locale;
    if (!deviceLocale) fail('no case gave the device locale');
    console.log(`device locale (resolvedOptions): ${deviceLocale}`);
    if (deviceLocale !== baseline.device.locale) throw new Stopped(`the baseline is for ${baseline.device.locale}; the phone's locale is ${deviceLocale}`);
    if (cases.length !== baseline.cases.length) fail(`${cases.length} cases on the phone, ${baseline.cases.length} in the baseline`);
    // RN's text: any difference fails.
    let wrong = 0;
    cases.forEach((entry, index) => {
        const rn = baseline.cases[index];
        for (const field of ['locale', 'options', 'time', 'resolved', 'format', 'parts', 'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
            const [phone, hermes] = [text(entry[field]), text(rn[field])];
            if (phone === hermes) continue;
            wrong += 1;
            console.log(`NOT RN ${entry.locale ?? `(device ${deviceLocale})`} ${JSON.stringify(entry.options)} ${new Date(entry.time).toISOString()} ${field}\n  phone ${phone}\n  RN    ${hermes}`);
        }
    });
    console.log(`${cases.length} cases against RN's Hermes baseline: ${wrong} differences`);
    if (wrong > 0) fail(`${wrong} fields differ from RN's Hermes output`);
    // Diagnostics only: this computer's Node Intl.
    const differences = { spacing: 0, other: 0 };
    for (const entry of cases) {
        const expected = nodeResult(entry, deviceLocale);
        for (const field of Object.keys(expected)) {
            const [phone, node] = [text(entry[field]), text(expected[field])];
            if (phone === node) continue;
            const kind = spacing(phone) === spacing(node) ? 'spacing' : 'other';
            differences[kind] += 1;
            console.log(`node ${kind === 'spacing' ? 'spacing' : 'diff'} ${entry.locale ?? `(device ${deviceLocale})`} ${JSON.stringify(entry.options)} ${new Date(entry.time).toISOString()} ${field}\n  phone ${phone}\n  node  ${node}`);
        }
    }
    console.log(`Node diagnostics: ${differences.other} differences, ${differences.spacing} in spacing only`);
    console.log('Intl device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    try { setProp(''); } catch { /* device gone */ }
    try { sh(`am force-stop ${PKG}`); } catch { /* device gone */ }
}
