


import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, check, connect, evidenced, fail, mainList, Stopped, tagged, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-keyboard-device.mjs <adb-serial> [apk]');
    process.exit(2);
}
const app = resolve(import.meta.dirname, '..');
const apk = apkArg ?? resolve(app, 'android/app/build/outputs/apk/play/debug/app-play-debug.apk');
const adbBin = process.env.ADB ?? '/home/dd/Android/Sdk/platform-tools/adb';
const aapt2 = process.env.AAPT2 ?? '/home/dd/Android/Sdk/build-tools/36.1.0/aapt2';
const PKG = 'tech.dongdongbh.mindwtr.nativeclient.dev';
const SCHEME = 'mindwtr-native-dev';
const apkPackage = execFileSync(aapt2, ['dump', 'packagename', apk], { encoding: 'utf8' }).trim();
if (apkPackage !== PKG) {
    console.error(`REFUSED: ${apk} is package "${apkPackage}", not ${PKG}`);
    process.exit(2);
}
const ACTIVITY = `${PKG}/${PKG}.MainActivity`;
const UI_FILE = '/data/local/tmp/mindwtr-native-dev-ui.xml';
const work = resolve(app, 'android/build/keyboard-check');
const { en } = await import(resolve(app, '../../packages/core/src/i18n/locales/en.ts'));

const LINK_TITLE = `78${String(Date.now()).slice(-6)}${String(randomInt(1000)).padStart(3, '0')}`;

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, requireAppFront, screen, waitFor, tapExpecting } = device;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
const shot = (name) => writeFileSync(resolve(work, `${name}.png`), device.adbRaw('exec-out', 'screencap', '-p'));


const keyboardShown = () => /mInputShown=true/.test(sh('dumpsys input_method'));
const keyboardUp = async () => {
    for (let wait = 0; wait < 25 && !keyboardShown(); wait += 1) await sleep(200);
    if (!keyboardShown()) fail('the keyboard did not come up for the focused field');

    await sleep(600);
    return device.settle(await screen());
};

const keyboardTop = () => {
    const window = sh('dumpsys window windows').split(/\n  Window #/).find((part) => part.includes('InputMethod')) ?? fail('no keyboard window');
    const frameTop = Number(/ frame=\[\d+,(\d+)\]/.exec(window)?.[1] ?? /mFrame=\[\d+,(\d+)\]/.exec(window)?.[1] ?? NaN);
    const inset = Number(/mGivenContentInsets=\[\d+,(\d+)\]/.exec(window)?.[1] ?? NaN);
    if (!Number.isFinite(frameTop + inset)) fail('the keyboard window has no frame or content inset');
    return frameTop + inset;
};
const results = [];

const aboveKeyboard = (step, what, node) => {
    const [, top, , bottom] = node ? box(node) : [NaN, NaN, NaN, NaN];
    const edge = keyboardTop();
    results.push({ step, what, top, bottom, keyboardTop: edge });
    check(Boolean(node) && top >= 0 && bottom > top && bottom <= edge, `${step} ${what} [${top},${bottom}] sits above the keyboard (its top ${edge})`);
};
const focusedField = (nodes) => nodes.find((node) => node.class === 'android.widget.EditText' && node.focused === 'true');

const keyboardDown = async () => {
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    for (let wait = 0; wait < 15 && keyboardShown(); wait += 1) await sleep(200);
    if (keyboardShown()) fail('Back left the keyboard up');
    await sleep(600);
};
const back = async (done, description) => {
    requireAppFront();
    if (keyboardShown()) {
        sh('input keyevent KEYCODE_BACK');
        for (let wait = 0; wait < 15 && keyboardShown(); wait += 1) await sleep(200);
    }
    sh('input keyevent KEYCODE_BACK');
    return waitFor(description, done, 15_000);
};
const atTabs = (nodes) => Boolean(withDescription(nodes, en['nav.addTask'])) && !tagged(nodes, 'quick-capture') && !tagged(nodes, 'capture-modal');

const restore = () => {
    try { setProp('language', ''); } catch {                   }
    try { if (front().includes(`${PKG}/`)) sh('input keyevent KEYCODE_HOME'); } catch {                   }
    try { sh(`am force-stop ${PKG}`); } catch {                   }
    try { sh(`rm -f ${UI_FILE}`); } catch {                   }
};

try {
    mkdirSync(work, { recursive: true });
    const sdk = Number(sh('getprop ro.build.version.sdk'));
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sdk}); `
        + `${sdk >= 35 ? 'edge to edge (forced from API 35)' : 'adjustResize (no forced edge to edge)'}`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });

    setProp('language', 'en');
    sh(`am force-stop ${PKG}`);
    device.launch(ACTIVITY);
    requireAppFront();
    let nodes = await waitFor('the tabs', atTabs, 60_000);


    nodes = await device.openCapture();
    await device.focusAtEnd(tagged(nodes, 'capture-title') ?? fail('no capture field'));
    nodes = await keyboardUp();
    shot('a-capture-popup');
    aboveKeyboard('(a)', 'the capture popup\'s focused title', tagged(nodes, 'capture-title'));
    aboveKeyboard('(a)', 'the capture popup\'s Save', nodes.find((node) => node.text === en['common.save'] && node.class === 'android.widget.TextView'));

    const note = tagged(nodes, 'capture-note');
    const moreClosed = withDescription(nodes, en['common.more']);

    const noteLabel = withDescription(nodes, en['taskEdit.descriptionLabel']);
    const inside = (inner, outer) => { const [l, t, r, b] = box(inner); const [ol, ot, or, ob] = box(outer); return (l + r) / 2 >= ol && (l + r) / 2 <= or && (t + b) / 2 >= ot && (t + b) / 2 <= ob; };
    check(Boolean(note) && Boolean(noteLabel) && inside(noteLabel, note) && box(note)[1] >= box(tagged(nodes, 'capture-title'))[3]
        && Boolean(moreClosed) && box(note)[3] <= box(moreClosed)[1],
        `(a) the popup shows RN's Add notes field under the title with More closed (note ${note?.bounds}, More ${moreClosed?.bounds})`);
    nodes = await back(atTabs, 'the popup to close');


    requireAppFront();
    sh(`am start -a android.intent.action.VIEW -d '${SCHEME}://capture?title=${LINK_TITLE}' ${PKG}`);
    nodes = await waitFor('the capture screen', (current) => Boolean(tagged(current, 'capture-modal')), 20_000);
    nodes = await keyboardUp();
    shot('b-capture-screen');
    aboveKeyboard('(b)', 'the capture screen\'s focused title', focusedField(nodes));
    aboveKeyboard('(b)', 'the capture screen\'s Save', tagged(nodes, 'capture-modal-save'));

    let ctrlEnd = 'not checked';
    try {
        await device.focusAtEnd(focusedField(nodes) ?? fail('no focused field on the capture screen'));
        sh('input text 9');
        nodes = await waitFor('the typed digit', (current) => focusedField(current)?.text?.includes('9') ?? false, 10_000);
        ctrlEnd = focusedField(nodes).text === `${LINK_TITLE}9` ? 'end' : `not the end (${focusedField(nodes).text})`;
        check(ctrlEnd === 'end', `(b) Ctrl+End put the cursor at the title's end (${focusedField(nodes).text})`);
        aboveKeyboard('(b)', 'the capture screen\'s title after Ctrl+End and a digit', focusedField(nodes));
    } catch (error) {
        if (error instanceof Stopped || !/keycombination|English layout/.test(String(error?.message ?? error))) throw error;
        console.log(`info - (b) Ctrl+End not checked here: ${error.message}`);
    }

    nodes = await back((current) => !keyboardShown() && Boolean(tagged(current, 'capture-modal-cancel')) || atTabs(current), 'the keyboard to go');
    if (tagged(nodes, 'capture-modal-cancel')) await tapExpecting(tagged(nodes, 'capture-modal-cancel'), atTabs, 'Cancel to close the capture screen');


    nodes = await device.settle(await screen());
    const row = nodes.find((node) => / Status: /.test(node['content-desc'] ?? '')) ?? fail('no task row on the first tab');
    nodes = await tapExpecting(row, (current) => current.some((node) => node.class === 'android.widget.EditText') || Boolean(withDescription(current, en['markdown.edit'])), 'the editor');
    const editTab = nodes.find((node) => node.text === (en['markdown.edit']) || node['content-desc'] === (en['markdown.edit']));
    if (editTab && !nodes.some((node) => node.class === 'android.widget.EditText')) {
        nodes = await tapExpecting(editTab, (current) => current.some((node) => node.class === 'android.widget.EditText'), 'the editor\'s Edit tab');
    }
    const fieldsOf = (current) => current.filter((node) => node.class === 'android.widget.EditText').sort((a, b) => box(a)[1] - box(b)[1]);
    if (fieldsOf(nodes).length < 2) fail(`the editor shows ${fieldsOf(nodes).length} text field(s); the check needs two`);
    for (const [label, pick] of [['first field', (list) => list[0]], ['lowest field on screen', (list) => list.at(-1)]]) {

        nodes = await device.settle(await screen());
        await device.tap(pick(fieldsOf(nodes)) ?? fail(`no ${label} in the editor`));
        nodes = await keyboardUp();
        shot(`c-editor-${label.split(' ')[0]}`);
        aboveKeyboard('(c)', `the editor's ${label}, focused`, focusedField(nodes));


        const [, formTop, , formBottom] = box(mainList(nodes) ?? fail('no editor form'));
        const edge = keyboardTop();
        const clear = edge - 0.18 * (Math.min(formBottom, edge) - formTop);
        const bottom = box(focusedField(nodes))[3];
        results.push({ step: '(c)', what: `the editor's ${label}, RN's clearance`, bottom, clearanceEdge: Math.round(clear) });
        check(bottom <= clear + 2, `(c) the editor's ${label} ends at ${bottom}, RN's 18% clear of the keyboard (by ${Math.round(clear)})`);
        await keyboardDown();
    }

    await back((current) => !current.some((node) => node.class === 'android.widget.EditText'), 'the editor to close');
    writeFileSync(resolve(work, 'results.json'), JSON.stringify({ sdk, ctrlEnd, results }, null, 2));
    console.log(`Keyboard device check passed (Ctrl+End: ${ctrlEnd})`);
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    restore();
}
