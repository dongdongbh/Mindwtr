// Settings › About, feedback, the update check and the heartbeat on the isolated native Android development app (pass O1).
//
//   ADB=/opt/android-sdk/platform-tools/adb node apps/android-native/scripts/check-about-device.mjs <adb-serial> [apk]
//
// Nothing reaches a real endpoint: a local stub on 127.0.0.1 (adb reverse) answers GitHub's latest release, the feedback endpoint
// and the heartbeat, and the debug build points all three at it (`debug.mindwtr.native.about_stub=<port>`, CoreHost's
// aboutAppInfo); `about_reset` clears the day's heartbeat and update-check keys before the boot. The check installs the debug
// APK with `install -r` (existing development data stays) and:
// (a) the boot sends one heartbeat with RN's payload (core's sendMobileDailyHeartbeat: RN's keys in RN's order, this build's
//     version, Android's major, the device's locale, the synced profile id);
// (b) Settings › About shows RN's header and rows in core's English, and its silent check asks the stub's GitHub (or Play) once;
// (c) Check for updates finds the stub's newer release: RN's alert (Update Available, the versions), then Later; the Settings
//     menu's About row then carries RN's update dot;
// (d) the feedback modal sends a bug report with a place, a reply email and diagnostics: the stub gets RN's body (the place
//     leading the message, RN's metadata, the diagnostics ending with RN's snapshot), and the modal thanks.
// It saves screenshots of About, the alert and the modal under android/build/about-check. It puts back the properties, the
// adb reverse, the rotation and the Inbox tab. Exit 0 = pass, 1 = fail, 2 = refused before touching the device, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { check, connect, evidenced, fail, inboxCount, Stopped, tab, tabSelected, tagged, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-about-device.mjs <adb-serial> [apk]');
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
const work = resolve(app, 'android/build/about-check');
const coreSrc = resolve(app, '../../packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));
const rnApp = JSON.parse(readFileSync(resolve(app, '../mobile/app.json'), 'utf8')).expo;
const VERSION = rnApp.version;
const NEWER = '9.9.9';

// ---- The stub: GitHub's latest release, the feedback endpoint and the heartbeat, each request kept ----
const requests = [];
const stub = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
        requests.push({ method: request.method, url: request.url, headers: request.headers, body });
        if (request.url === '/github/releases/latest') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ tag_name: `v${NEWER}`, html_url: `https://github.com/dongdongbh/Mindwtr/releases/tag/v${NEWER}`, body: 'Stub notes' }));
            return;
        }
        response.writeHead(request.url === '/feedback' || request.url === '/heartbeat' ? 200 : 404, { 'content-type': 'application/json' });
        response.end('{}');
    });
});
await new Promise((done) => stub.listen(0, '127.0.0.1', done));
const PORT = stub.address().port;
const seen = (path, method = 'POST') => requests.filter((entry) => entry.url === path && entry.method === method);

const words = {
    menu: en['tab.menu'], settings: en['nav.settings'], about: en['settings.about'], check: en['settings.checkForUpdates'],
    later: en['settings.later'], update: en['settings.updateAvailable'], feedbackRow: en['settings.feedback'], sync: en['settings.feedbackWhereSync'],
    sent: en['settings.feedbackSent'], close: en['common.close'],
};

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { adbRaw, sh, home, front, requireAppFront, screen, waitFor, tap, tapExpecting } = device;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
const shot = (name) => writeFileSync(resolve(work, `${name}.png`), adbRaw('exec-out', 'screencap', '-p'));
const texts = (nodes) => nodes.map((node) => node.text).filter(Boolean);
const onInbox = (nodes) => !tagged(nodes, 'menu-screen') && Number.isFinite(inboxCount(nodes));
const sheetOpen = (nodes) => Boolean(tagged(nodes, 'more-sheet'));
const aboutRow = (nodes) => nodes.find((node) => node['content-desc']?.startsWith(`${words.about}.`) || node['content-desc'] === words.about);
const backToTabs = async () => {
    let nodes = await screen();
    for (let step = 0; step < 8 && !(tab(nodes, words.menu) && !tagged(nodes, 'menu-screen') && !sheetOpen(nodes)); step += 1) {
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(900);
        nodes = await screen();
    }
    return nodes;
};
const openSettings = async () => {
    let nodes = await backToTabs();
    nodes = await tapExpecting(tab(nodes, words.menu) ?? fail('no Menu tab'), sheetOpen, 'the More sheet');
    nodes = await device.settle(nodes);
    nodes = await tapExpecting(withDescription(nodes, words.settings) ?? fail('no Settings in the More sheet'), (current) => Boolean(tagged(current, 'settings-main')), 'Settings');
    for (let step = 0; step < 6 && !aboutRow(nodes); step += 1) nodes = await device.swipe(nodes, 'down');
    return nodes;
};
/** Types [text] into the field tagged [tag] (no spaces: adb's input text). */
const typeInto = async (tag, text) => {
    await tap(tagged(await screen(), tag) ?? fail(`no ${tag} field`));
    await sleep(400);
    sh(`input text '${text}'`);
    await waitFor(`${text} in ${tag}`, (nodes) => tagged(nodes, tag)?.text === text, 10_000);
};

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const originalLanguage = sh('getprop debug.mindwtr.native.language');
const restore = async () => {
    for (const name of ['about_stub', 'about_reset']) { try { setProp(name, ''); } catch { /* device gone */ } }
    try { setProp('language', originalLanguage); } catch { /* device gone */ }
    try { adbRaw('reverse', '--remove', `tcp:${PORT}`); } catch { /* already gone */ }
    try {
        if (front().includes(`${PKG}/`)) {
            const nodes = await backToTabs();
            if (tab(nodes, en['tab.inbox']) && !tabSelected(nodes, en['tab.inbox'])) await tap(tab(nodes, en['tab.inbox']));
        }
    } catch { /* the app is gone */ }
    for (const [name, value] of [['user_rotation', originalRotation], ['accelerometer_rotation', originalAccelerometer]]) {
        try { sh(value === 'null' ? `settings delete system ${name}` : `settings put system ${name} ${value}`); } catch { /* device gone */ }
    }
    try { sh(`rm -f ${UI_FILE}`); } catch { /* device gone */ }
    stub.close();
};

try {
    mkdirSync(work, { recursive: true });
    const release = sh('getprop ro.build.version.release');
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${release} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    adbRaw('reverse', `tcp:${PORT}`, `tcp:${PORT}`);
    setProp('about_stub', String(PORT));
    setProp('about_reset', '1');
    setProp('language', 'en');
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    await device.stopApp();
    device.launch(ACTIVITY);
    requireAppFront();
    sh('settings put system accelerometer_rotation 0');
    sh('settings put system user_rotation 0');
    await waitFor('the Inbox', onInbox, 60_000);
    // Later boots keep the day's keys.
    setProp('about_reset', '');

    // (a) The boot's heartbeat: one POST, RN's payload.
    const heartbeatDeadline = Date.now() + 40_000;
    while (Date.now() < heartbeatDeadline && seen('/heartbeat').length === 0) await sleep(500);
    const beats = seen('/heartbeat');
    check(beats.length === 1, `(a) the boot sent one heartbeat to the stub (${beats.length})`);
    const beat = JSON.parse(beats[0].body);
    writeFileSync(resolve(work, 'heartbeat.json'), `${JSON.stringify(beat, null, 1)}\n`);
    const keys = Object.keys(beat);
    check(keys.join() === ['distinct_id', 'profile_id', 'platform', 'channel', 'app_version', 'version', 'device_class', 'os_major', 'locale'].join(),
        `(a) RN's keys in RN's order: ${keys.join(', ')}`);
    check(/^[0-9a-f-]{36}$/.test(beat.distinct_id) && /^[0-9a-f-]{36}$/.test(beat.profile_id), `(a) a UUID distinct id and the synced profile id`);
    check(beat.platform === 'android' && beat.channel === 'play-store' && beat.app_version === VERSION && beat.version === VERSION
        && beat.device_class === 'phone' && beat.os_major === `android-${release.match(/\d+/)[0]}` && /^[a-z]{2}(-[A-Z]{2})?/.test(beat.locale),
        `(a) RN's values: ${JSON.stringify({ ...beat, distinct_id: '…', profile_id: '…' })}`);
    check(beats[0].headers['content-type'] === 'application/json', '(a) sent as JSON');

    // (b) Settings › About: RN's header and rows; the silent check asks once.
    let nodes = await openSettings();
    nodes = await tapExpecting(aboutRow(nodes) ?? fail('no About row'), (current) => Boolean(tagged(current, 'settings-about')), 'Settings › About');
    await sleep(2500);
    nodes = await screen();
    // Each link row is one button reading "label, value" (its texts merged, as RN's TouchableOpacity reads them); the license row's
    // texts are its own.
    const shown = [...texts(nodes), ...nodes.map((node) => node['content-desc']).filter(Boolean)];
    check(shown.includes(rnApp.name) && shown.includes(`v${VERSION}`), `(b) the header: ${rnApp.name}, v${VERSION}`);
    for (let step = 0; step < 3 && !shown.includes(en['settings.license']); step += 1) {
        nodes = await device.swipe(nodes, 'down');
        shown.push(...texts(nodes), ...nodes.map((node) => node['content-desc']).filter(Boolean));
    }
    const rows = [[words.check, en['settings.aboutMobile.tapToCheck']], [en['settings.aboutMobile.rateOurApp'], 'Google Play'],
        [words.feedbackRow, en['settings.feedbackSubmit']], [en['settings.officialWebsite'], 'Mindwtr'], [en['settings.videoTutorials'], 'YouTube'],
        [en['settings.privacy'], en['settings.privacy']], [en['settings.terms'], en['settings.terms']], [en['settings.sponsorProject'], en['settings.donateLinkValue']]]
        .map(([label, value]) => `${label}, ${value}`);
    const missing = [...rows, en['settings.license'], 'AGPL-3.0'].filter((text) => !shown.includes(text));
    check(missing.length === 0, `(b) RN's rows and values in core's English (missing: ${missing.join(', ') || 'none'})`);
    for (let step = 0; step < 3; step += 1) nodes = await device.swipe(nodes, 'up');
    shot('about');
    const silentGithub = seen('/github/releases/latest', 'GET').length;
    console.log(`info - the silent check asked GitHub ${silentGithub} time(s) (a sideloaded install asks GitHub; a Play install asks Play first)`);

    // (c) Check for updates: the stub's newer release, RN's alert; Later; the menu's dot.
    nodes = await screen();
    nodes = await tapExpecting(tagged(nodes, 'about-checkForUpdates') ?? fail('no Check for updates row'),
        (current) => texts(current).includes(words.update), 'the update alert', 20_000);
    const alertText = texts(nodes).join('\n');
    check(alertText.includes(`v${VERSION}`) || alertText.includes(VERSION), `(c) the alert names this version: ${alertText.replace(/\n/g, ' | ').slice(0, 300)}`);
    check(alertText.includes(NEWER), `(c) the alert names the stub's ${NEWER}`);
    check(seen('/github/releases/latest', 'GET').length > silentGithub, '(c) the check asked the stub\'s GitHub');
    const asked = seen('/github/releases/latest', 'GET').at(-1);
    check(asked.headers.accept === 'application/vnd.github.v3+json' && asked.headers['user-agent'] === 'Mindwtr-App', '(c) with RN\'s Accept and User-Agent');
    shot('about-alert');
    // The alert is its own window (Compose's AlertDialog), so its buttons are found by their text.
    const later = tagged(nodes, 'about-alert-cancel') ?? nodes.find((node) => node.text?.toLowerCase() === words.later.toLowerCase());
    nodes = await tapExpecting(later ?? fail('no Later button'), (current) => !texts(current).includes(words.update), 'the alert to close');
    nodes = await backToTabs();
    nodes = await openSettings();
    const row = aboutRow(nodes);
    check(row?.['content-desc'].includes(words.update), `(c) the Settings menu's About row has RN's update dot: ${row?.['content-desc']}`);
    shot('settings-dot');

    // (d) Feedback: a bug in Sync with a reply email and diagnostics.
    nodes = await tapExpecting(row, (current) => Boolean(tagged(current, 'settings-about')), 'Settings › About');
    nodes = await tapExpecting(tagged(nodes, 'about-feedback') ?? fail('no Send feedback row'), (current) => Boolean(tagged(current, 'feedback-modal')), 'the feedback modal');
    shot('feedback-modal');
    await tap(tagged(nodes, 'feedback-place-sync') ?? fail('no Sync place'));
    // The keyboard shrinks the card (RN's KeyboardAvoidingView 'height'): Back closes the keyboard after each field.
    const hideKeyboard = async () => {
        sh('input keyevent KEYCODE_BACK');
        await sleep(800);
        if (!tagged(await screen(), 'feedback-modal')) fail('Back closed the modal instead of the keyboard');
    };
    await typeInto('feedback-message', 'Stub-only-report');
    await hideKeyboard();
    nodes = await screen();
    for (let step = 0; step < 4 && !tagged(nodes, 'feedback-email'); step += 1) nodes = await device.swipe(nodes, 'down');
    await typeInto('feedback-email', 'tester@example.com');
    await hideKeyboard();
    nodes = await screen();
    for (let step = 0; step < 4 && !withDescription(nodes, en['settings.feedbackIncludeDiagnostics']); step += 1) nodes = await device.swipe(nodes, 'down');
    await tap(withDescription(nodes, en['settings.feedbackIncludeDiagnostics']) ?? fail('no diagnostics switch'));
    await sleep(800);
    shot('feedback-filled');
    nodes = await screen();
    await tap(tagged(nodes, 'feedback-send') ?? fail('no Send'));
    nodes = await waitFor('the thanks', (current) => texts(current).includes(words.sent), 30_000);
    shot('feedback-sent');
    const sent = seen('/feedback');
    check(sent.length === 1, `(d) one feedback request reached the stub (${sent.length})`);
    const body = JSON.parse(sent[0].body);
    writeFileSync(resolve(work, 'feedback.json'), `${JSON.stringify(body, null, 1)}\n`);
    check(Object.keys(body).join() === 'category,message,email,metadata,diagnostics,submittedAt', `(d) RN's keys in RN's order: ${Object.keys(body).join(', ')}`);
    check(body.category === 'bug' && body.message === `${en['settings.feedbackWhereMessagePrefix']}: ${words.sync}\n\nStub-only-report` && body.email === 'tester@example.com',
        `(d) the place leads the message: ${JSON.stringify(body.message)}`);
    const meta = body.metadata;
    check(Object.keys(meta).join() === 'appVersion,platform,os,installChannel,locale,build' && meta.appVersion === VERSION && meta.platform === 'android'
        && meta.os === `android ${sh('getprop ro.build.version.sdk')}` && ['play-store', 'sideload', 'unknown'].includes(meta.installChannel)
        && meta.build === String(rnApp.android.versionCode), `(d) RN's metadata: ${JSON.stringify(meta)}`);
    const logs = body.diagnostics?.logs ?? '';
    const last = JSON.parse(logs.split('\n').at(-1));
    check(last.message === 'Feedback diagnostics snapshot' && last.context.releaseCheck === 'v1.3.0/feedback-diagnostics' && logs.length <= 20_000,
        `(d) the diagnostics end with RN's snapshot (${logs.split('\n').length} lines, ${logs.length} characters)`);
    check(!logs.includes('Stub-only-report') && !logs.includes('tester@example.com'), '(d) the diagnostics hold neither the message nor the email');
    nodes = await screen();
    // The thanks' Close (a button node read as its words; the header's X reads the same).
    await tap(nodes.filter((node) => node['content-desc'] === words.close || node.text === words.close).at(-1) ?? fail('no Close'));
    await waitFor('the modal to close', (current) => !tagged(current, 'feedback-modal'), 10_000);
    check(seen('/heartbeat').length === 1, 'no second heartbeat the same day');
    console.log('About device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
    console.log(`EXIT=${process.exitCode ?? 0}`);
}
