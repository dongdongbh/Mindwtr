import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { check, connect, fail, tab, tagged, withDescription } from './device.mjs';

const [serial, rnApk, nativeApk] = process.argv.slice(2);
if (!serial || !rnApk || !nativeApk) {
    console.error('usage: node capture-dropbox-parity.mjs <adb-serial> <RN upgradetest APK> <native Play debug APK built with a DROPBOX_APP_KEY, as the RN harness was>');
    process.exit(2);
}
const aapt2 = process.env.AAPT2 ?? '/home/dd/Android/Sdk/build-tools/36.1.0/aapt2';
const RN = 'tech.dongdongbh.mindwtr.upgradetest';
const NATIVE = 'tech.dongdongbh.mindwtr.nativeclient.dev';
for (const [apk, pkg] of [[rnApk, RN], [nativeApk, NATIVE]]) {
    const found = execFileSync(aapt2, ['dump', 'packagename', apk], { encoding: 'utf8' }).trim();
    if (found !== pkg) {
        console.error(`REFUSED: ${apk} is package "${found}", not ${pkg}`);
        process.exit(2);
    }
}
const repo = resolve(import.meta.dirname, '../../..');
const { en } = await import(resolve(repo, 'packages/core/src/i18n/locales/en.ts'));
const out = resolve(repo, 'apps/android-native/android/build/dropbox-parity');
mkdirSync(out, { recursive: true });
const panelEnd = en['settings.syncMobile.readAndMergeDropboxData'];
const disconnected = en['settings.syncMobile.statusNotConnected'];
const endsPanel = (node) => node.text === panelEnd || (node['content-desc'] ?? '').endsWith(panelEnd);
const shoot = (device, name) => {
    const file = resolve(out, `${name}.png`);
    writeFileSync(file, device.adbRaw('exec-out', 'screencap', '-p'));
    console.log(`info - ${file}`);
};
const scrollTo = async (device, found) => {
    let nodes = await device.screen();
    for (let step = 0; step < 12 && !found(nodes); step += 1) nodes = await device.swipe(nodes, 'up');
    return found(nodes) ? nodes : fail('the Dropbox panel did not scroll into view');
};

const rn = connect({ serial, pkg: RN, uiFile: '/data/local/tmp/mindwtr-dropbox-parity-rn.xml' });
if (rn.sh(`pm list packages ${RN}`).includes(`package:${RN}`)) rn.sh(`pm uninstall ${RN}`);
rn.adbRaw('install', '-g', rnApk);
rn.launch(`${RN}/${RN}.MainActivity`);
const skip = await rn.waitFor('RN onboarding', (nodes) => nodes.some((node) => node.text === 'Skip for now'), 30_000).catch(() => null);
if (skip) await rn.tap(skip.find((node) => node.text === 'Skip for now'));
await sleep(2_000);
rn.sh(`am start -W -a android.intent.action.VIEW -d 'mindwtr-upgradetest://settings?settingsScreen=sync' ${RN}`);
let nodes = await rn.waitFor('RN Settings > Sync', (current) => current.some((node) => node.text === 'Dropbox'), 60_000);
await rn.tap(nodes.find((node) => node.text === 'Dropbox'));
nodes = await scrollTo(rn, (current) => current.some(endsPanel));
check(nodes.some((node) => node.text === disconnected), 'RN shows its Dropbox panel, not connected');
shoot(rn, 'rn-dropbox-not-connected');
rn.sh(`am force-stop ${RN}`);
rn.sh(`pm uninstall ${RN}`);

const native = connect({ serial, pkg: NATIVE, uiFile: '/data/local/tmp/mindwtr-dropbox-parity-native.xml' });
native.adbRaw('install', '-r', '-g', nativeApk);
await native.stopApp();
native.launch(`${NATIVE}/${NATIVE}.MainActivity`);
nodes = await native.waitFor('the tabs', (current) => Boolean(tab(current, en['tab.menu'])), 60_000);
nodes = await native.tapExpecting(tab(nodes, en['tab.menu']), (current) => Boolean(tagged(current, 'more-sheet')), 'the More sheet');
await native.tapExpecting(withDescription(await native.settle(nodes), en['nav.settings']), (current) => Boolean(tagged(current, 'settings-main')), 'Settings');
await native.tapExpecting(await native.revealNode((current) => current.find((node) => (node['content-desc'] ?? '').startsWith(`${en['settings.sync']}. `)), 'Sync row'),
    (current) => Boolean(tagged(current, 'settings-sync')), 'Settings › Sync');
await native.tapExpecting(await native.revealNode((current) => tagged(current, 'sync-backend-dropbox'), 'Dropbox'),
    (current) => Boolean(tagged(current, 'sync-dropbox-connect')), 'the Dropbox panel');
nodes = await scrollTo(native, (current) => current.some(endsPanel));
check(nodes.some((node) => node.text === disconnected), 'native shows its Dropbox panel, not connected');
shoot(native, 'native-dropbox-not-connected');
console.log(`PASS - pair in ${out}`);
