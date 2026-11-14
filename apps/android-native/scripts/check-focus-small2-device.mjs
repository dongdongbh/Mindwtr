


import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, button, check, connect, evidenced, fail, mainList, Stopped, tab, tabSelected, tagged, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-focus-small2-device.mjs <adb-serial> [apk]');
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
const work = resolve(app, 'android/build/focus-small2-check');
const { en } = await import(resolve(app, '../../packages/core/src/i18n/locales/en.ts'));

const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const titles = { later: `73${run}1`, upcoming: `73${run}2` };
const LATER_TODAY = en['agenda.laterToday'];

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting } = device;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
const logs = () => device.logs(pid(), TAG).replace(/\\/g, '');
const lines = (needle) => logs().split('\n').filter((line) => line.includes(needle));
const commands = (operation) => lines('native-android-dev-task-command').filter((line) => line.includes(`"operation":"${operation}"`)
    && line.includes('"outcome":"saved"')).length;
const shoot = (name) => {
    const png = execFileSync(adbBin, ['-s', serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 });
    writeFileSync(resolve(work, `native-${name}.png`), png);
    console.log(`screenshot - ${resolve(work, `native-${name}.png`)}`);
};


const inPopup = (nodes) => Boolean(tagged(nodes, 'quick-capture'));
const onTab = (name) => (nodes) => !inPopup(nodes) && !tagged(nodes, 'menu-screen') && tabSelected(nodes, name);
const rowNode = (nodes, title) => nodes.find((node) => node.text === title && node.class !== 'android.widget.EditText');

const laterHeading = (nodes) => nodes.find((node) => new RegExp(`^${LATER_TODAY} \\d+$`).test(node['content-desc'] ?? ''));
const capture = async (text, shown) => {
    let nodes = await screen();
    if (!inPopup(nodes)) nodes = await device.openCapture();
    await device.focusAtEnd(tagged(nodes, 'capture-title') ?? fail('no capture field'));
    requireAppFront();
    sh(`input text '${text}'`);
    await waitFor(`"${shown}" in the capture field`, (current) => tagged(current, 'capture-title')?.text === shown, 15_000);
    await tapExpecting(button(await screen(), en['common.save']) ?? fail('no Save'), (current) => !inPopup(current), 'the capture to close the popup');
};
const showFocus = async () => {
    const nodes = await waitFor('the tabs', (current) => tab(current, en['tab.next']), 60_000);
    if (!tabSelected(nodes, en['tab.next'])) await tapExpecting(tab(nodes, en['tab.next']), onTab(en['tab.next']), 'the Focus tab', 10_000);
    return waitFor('Focus', onTab(en['tab.next']), 30_000);
};

const openSections = async () => {
    let nodes = await screen();
    const only = en['agenda.collapseOtherSections'];
    const expand = en['agenda.expandOtherSections'];
    if (withDescription(nodes, only)) nodes = await tapExpecting(withDescription(nodes, only), (current) => Boolean(withDescription(current, expand)), 'Focus only');
    if (withDescription(nodes, expand)) await tapExpecting(withDescription(nodes, expand), (current) => Boolean(withDescription(current, only)), 'every section open');
};

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
let folded = false;
const restore = async () => {
    for (const name of PROPS) { try { setProp(name, ''); } catch {                   } }
    try {
        if (folded && front().includes(`${PKG}/`)) {
            const heading = await device.revealNode(laterHeading, 'the Later today heading');
            await tap(heading);
            await sleep(1500);
        }
        const nodes = await screen();
        if (front().includes(`${PKG}/`) && tab(nodes, en['tab.inbox']) && !tabSelected(nodes, en['tab.inbox'])) await tap(tab(nodes, en['tab.inbox']));
    } catch {                       }
    for (const [name, value] of [['user_rotation', originalRotation], ['accelerometer_rotation', originalAccelerometer]]) {
        try { sh(value === 'null' ? `settings delete system ${name}` : `settings put system ${name} ${value}`); } catch {                   }
    }
    try { sh(`rm -f ${UI_FILE}`); } catch {                   }
};

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    const [hour, minute] = sh('date +%H:%M').split(':').map(Number);
    if (hour * 60 + minute > 22 * 60 + 30) throw new Stopped('Later today needs a start still to come today: run before 10:30 pm phone time');
    for (const name of PROPS) setProp(name, '');
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    device.launch(ACTIVITY);
    requireAppFront();
    sh('settings put system accelerometer_rotation 0');
    sh('settings put system user_rotation 0');
    await waitFor('the Inbox', onTab(en['tab.inbox']), 60_000);


    await capture(`${titles.later}%s/next%s/start:today%s11pm`, `${titles.later} /next /start:today 11pm`);
    await capture(`${titles.upcoming}%s/next%s/start:tomorrow`, `${titles.upcoming} /next /start:tomorrow`);
    await showFocus();
    await openSections();


    const pulls = () => lines('Native Android pull to sync');
    let nodes = await device.toTop();
    if (!mainList(nodes)) {
        console.log('note - the Focus list is too short to scroll; capturing 10 Upcoming Next actions to fill it');
        await tapExpecting(tab(nodes, en['tab.inbox']), onTab(en['tab.inbox']), 'the Inbox', 10_000);
        for (let index = 0; index < 10; index += 1) await device.capture(`73${run}f${index} /next /start:tomorrow`);
        await showFocus();
        await openSections();
        nodes = await device.toTop();
    }

    const before = pulls().length;
    const list = mainList(nodes) ?? fail('no Focus list');
    const [x1, y1, x2, y2] = box(list);
    const x = Math.round((x1 + x2) / 2);
    requireAppFront();
    sh(`input swipe ${x} ${y1 + 60} ${x} ${Math.min(y2 - 40, y1 + 900)} 700`);
    await sleep(300);
    shoot('pull-bar');
    await waitFor('the pull to sync run', () => pulls().length > before, 120_000);
    await sleep(3_000);
    const ran = pulls().slice(before);
    check(ran.length === 1, `(a) one pull down runs one pull down to sync: ${ran.map((line) => line.slice(line.indexOf('{'))).join(' ')}`);


    const later = await device.revealNode((current) => rowNode(current, titles.later), 'the run\'s Later today row');
    nodes = await screen();
    const heading = laterHeading(nodes);
    check(Boolean(heading) && box(heading)[1] < box(later)[1], '(b) the run\'s row is listed under core\'s Later today heading');
    nodes = await tapExpecting(heading, (current) => !rowNode(current, titles.later) && Boolean(laterHeading(current)), 'the fold');
    folded = true;
    shoot('later-today-folded');
    check(!rowNode(nodes, titles.later) && Boolean(laterHeading(nodes)), '(b) a tap on Later today folds it: the heading stays, its row goes');
    await device.stopApp();
    device.launch(ACTIVITY, { startTab: 'focus' });
    requireAppFront();
    await showFocus();
    nodes = await device.revealNode(laterHeading, 'the Later today heading after the new launch').then(() => screen());
    check(!rowNode(nodes, titles.later), '(b) after a force-stop and a new launch Later today is still folded');
    nodes = await tapExpecting(laterHeading(nodes), (current) => Boolean(rowNode(current, titles.later)), 'the unfold');
    folded = false;
    check(Boolean(rowNode(nodes, titles.later)), '(b) a second tap unfolds it');


    const star = (current) => {
        const row = rowNode(current, titles.upcoming);
        if (!row) return undefined;
        const [, top, , bottom] = box(row);
        return current.find((node) => [en['agenda.addToFocus'], en['agenda.removeFromFocus']].some((label) => (node['content-desc'] ?? '').startsWith(label))
            && box(node)[1] <= (top + bottom) / 2 && box(node)[3] >= (top + bottom) / 2);
    };
    const starNode = await device.revealNode(star, 'the Upcoming row\'s star');
    check(starNode.enabled !== 'false' && starNode['content-desc'].startsWith(en['agenda.addToFocus']),
        `(c) the Upcoming row's star is enabled: "${starNode['content-desc']}"`);
    const writes = commands('taskFocus');
    nodes = await tapExpecting(starNode, (current) => star(current)?.['content-desc']?.startsWith(en['agenda.removeFromFocus']), 'the star');
    await waitFor('the star write', () => commands('taskFocus') === writes + 1, 10_000);
    check(commands('taskFocus') === writes + 1, '(c) the star on a future-start Next action in Upcoming is one setTaskFocus write');
    await tapExpecting(star(nodes) ?? fail('no star after the write'), (current) => star(current)?.['content-desc']?.startsWith(en['agenda.addToFocus']), 'the star back');
    await waitFor('the unstar write', () => commands('taskFocus') === writes + 2, 10_000);
    console.log('Focus small-2 device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
