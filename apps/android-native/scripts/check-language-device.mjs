


import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { button, check, connect, evidenced, Stopped, tab } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-language-device.mjs <adb-serial> [apk]');
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
const PROPS = ['fail_commit', 'delay_before_ms', 'delay_after_ms', 'language'];


const locales = resolve(app, '../../packages/core/src/i18n/locales');
const { en } = await import(resolve(locales, 'en.ts'));
const { zhHans } = await import(resolve(locales, 'zh-Hans.ts'));
const label = (language, key) => (language === 'zh' ? zhHans[key] : undefined) ?? en[key];

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, pid, waitFor, logs } = device;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);


const expectLanguage = async (language, step) => {
    await device.stopApp();
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    device.launch(ACTIVITY);
    const [inbox, focus, capture, scope] = ['tab.inbox', 'tab.next', 'nav.addTask', 'projects.allAreas'].map((key) => label(language, key));
    const nodes = await waitFor(`the ${language} Inbox`, (current) => tab(current, inbox)
        && current.some((node) => node.text === scope), 60_000);

    const quick = ['nav.projects', 'tab.review', 'nav.contexts'].map((key) => [key, label(language, key)]).find(([, text]) => tab(nodes, text))
        ?? ['nav.projects', label(language, 'nav.projects')];
    for (const [name, text] of [['tab.inbox', inbox], ['tab.next', focus], quick]) {
        check(Boolean(tab(nodes, text)), `(${step}) the ${name} tab reads core's ${language} "${text}"`);
    }

    check(Boolean(button(nodes, capture)), `(${step}) the capture button reads core's ${language} "${capture}"`);
    check(nodes.some((node) => node.text === scope), `(${step}) the Inbox scope line reads core's ${language} "${scope}"`);
    const line = logs(pid(), TAG).split('\n').find((entry) => entry.includes('Native Android labels')) ?? '';
    check(line.includes(`language=${language} missing=0`), `(${step}) the app logged ${line.slice(line.indexOf('Native Android labels')) || 'no labels line'}`);
};

try {
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')}) / locale ${sh('getprop persist.sys.locale')}`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    for (const name of PROPS) setProp(name, '');
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) {
        throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    }
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });

    await expectLanguage('en', 'a');
    setProp('language', 'zh');
    await expectLanguage('zh', 'b');
    setProp('language', '');
    await expectLanguage('en', 'c');
    console.log('Language device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    for (const name of PROPS) { try { setProp(name, ''); } catch {                   } }
    try { sh(`rm -f ${UI_FILE}`); } catch {                   }
}
