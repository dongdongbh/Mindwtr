// Voice capture check for the isolated native Android development app (voice pass V5), against a local stub only.
//
//   node apps/android-native/scripts/check-voice-device.mjs <adb-serial> [apk]
//
// Starts an OpenAI-compatible speech stub on this computer (127.0.0.1:<port>, MINDWTR_VOICE_STUB_PORT or 18782) and maps the
// phone's port to it (`adb reverse`): no real provider and no key is used, and nothing plays on the phone (it records the room).
// Through the app's own screens:
//   (1) Settings › Advanced › AI › Speech: speech on, OpenAI, the stub's base URL (a self-hosted server needs no key, #930);
//   (2) the capture popup's mic: RN's record button (Record audio), its recording row; a stop shows the processing row, the
//       popup closes, and the task saves first as "Audio Note …" with the recording attached (audio/mp4 in managed storage);
//       the stub's transcript then becomes its title, from a multipart upload of an .m4a;
//   (3) the popup closed while recording: no task, no recording left in files/voice-captures;
//   (4) the app left while recording (Home), then back: the mic is idle and records again (review N5);
//   (5) the microphone permission refused: RN's alert, nothing records.
// Speech is turned off at the end, and the permission granted again.
import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { box, check, connect, evidenced, fail, Stopped, tab, tagged, withDescription } from './device.mjs';
import { cleanupOnExit } from './check-net-device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-voice-device.mjs <adb-serial> [apk]');
    process.exit(2);
}
const app = resolve(import.meta.dirname, '..');
const repo = resolve(app, '../..');
const apk = apkArg ?? resolve(app, 'android/app/build/outputs/apk/play/debug/app-play-debug.apk');
const adbBin = process.env.ADB ?? '/opt/android-sdk/platform-tools/adb';
const aapt2 = process.env.AAPT2 ?? '/opt/android-sdk/build-tools/36.0.0/aapt2';
const PKG = 'tech.dongdongbh.mindwtr.nativeclient.dev';
const apkPackage = execFileSync(aapt2, ['dump', 'packagename', apk], { encoding: 'utf8' }).trim();
if (apkPackage !== PKG) {
    console.error(`REFUSED: ${apk} is package "${apkPackage}", not ${PKG}`);
    process.exit(2);
}
const ACTIVITY = `${PKG}/${PKG}.MainActivity`;
const UI_FILE = '/data/local/tmp/mindwtr-native-dev-ui.xml';
const DB = 'mindwtr-native-dev.db';
const MIC = 'android.permission.RECORD_AUDIO';
const work = resolve(app, 'android/build/voice-check');
const { en } = await import(resolve(repo, 'packages/core/src/i18n/locales/en.ts'));

const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const PORT = Number(process.env.MINDWTR_VOICE_STUB_PORT ?? 18782);
const BASE_URL = `http://127.0.0.1:${PORT}/v1`;
const SPOKEN = `Voice check ${run}`;

/**
 * The OpenAI-compatible speech stub: POST /v1/audio/transcriptions answers SPOKEN and reports the upload's content type, the file
 * part's name and type and its size; POST /v1/chat/completions (core's parse of the transcript) answers it as the title. On a
 * worker thread, so the check's synchronous adb calls never hold a request.
 */
const STUB_SOURCE = `
    const { createServer } = require('node:http');
    const { parentPort, workerData: { port, spoken } } = require('node:worker_threads');
    const server = createServer((request, response) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
            const body = Buffer.concat(chunks);
            const seen = { method: request.method, path: request.url, type: request.headers['content-type'] ?? '', bytes: body.length };
            const answer = (json) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(json)); };
            if (request.method === 'POST' && request.url === '/v1/audio/transcriptions') {
                const head = body.subarray(0, 600).toString('latin1');
                seen.part = /filename="([^"]+)"\\r\\nContent-Type: ([^\\r]+)/.exec(head)?.slice(1) ?? null;
                parentPort.postMessage(seen);
                return answer({ text: spoken });
            }
            if (request.method === 'POST' && request.url === '/v1/chat/completions') {
                parentPort.postMessage(seen);
                return answer({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ transcript: spoken, title: spoken }) } }] });
            }
            parentPort.postMessage(seen);
            response.writeHead(404, { 'content-type': 'application/json' });
            response.end('{}');
        });
    });
    server.listen(port, '127.0.0.1', () => parentPort.postMessage({ listening: true }));
`;
const serveStub = () => new Promise((resolveServer, rejectServer) => {
    const worker = new Worker(STUB_SOURCE, { eval: true, workerData: { port: PORT, spoken: SPOKEN } });
    const seen = [];
    worker.on('message', (message) => { if (message.listening) resolveServer({ seen, close: () => worker.terminate() }); else seen.push(message); });
    worker.on('error', rejectServer);
});

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, requireAppFront, screen, waitFor, tap, tapExpecting } = device;

const pullDatabase = () => {
    const dir = resolve(work, 'db');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = sh(`run-as ${PKG} ls files`).split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    return resolve(dir, DB);
};
const sqlite = (sql) => {
    const out = execFileSync('sqlite3', ['-json', pullDatabase(), sql], { encoding: 'utf8' }).trim();
    return out ? JSON.parse(out) : [];
};
/** This run's live tasks: their titles and attachments. */
const runTasks = () => sqlite(`SELECT id, title, attachments FROM tasks WHERE deletedAt IS NULL AND (title = '${SPOKEN}' OR title LIKE '${en['quickAdd.audioNoteTitle']} %') AND createdAt >= '${started}'`);
const recordings = () => sh(`run-as ${PKG} sh -c 'ls files/voice-captures 2>/dev/null; ls files/voice-captures/quick-capture-audio 2>/dev/null' || true`)
    .split(/\s+/).filter((name) => /\.(m4a|wav|tmp)$/.test(name));

const popup = (nodes) => Boolean(tagged(nodes, 'quick-capture'));
const mic = (nodes) => tagged(nodes, 'capture-mic');
const recording = (nodes) => Boolean(tagged(nodes, 'capture-recording'));
const micLabel = (nodes) => mic(nodes)?.['content-desc'] ?? '';
const keyboardShown = () => /mInputShown=true/.test(sh('dumpsys input_method'));
const hideKeyboard = async () => { if (keyboardShown()) { requireAppFront(); sh('input keyevent KEYCODE_BACK'); await sleep(600); } };
const toTabs = async () => {
    for (let step = 0; step < 10; step += 1) {
        const nodes = await screen();
        if (tab(nodes, en['tab.menu']) && !tagged(nodes, 'menu-screen') && !tagged(nodes, 'more-sheet') && !popup(nodes)) return nodes;
        await hideKeyboard();
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(900);
    }
    return fail('the tabs did not come back');
};
const restart = async () => {
    await device.stopApp();
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    device.launch(ACTIVITY);
    return waitFor('the tabs', (nodes) => Boolean(tab(nodes, en['tab.inbox'])), 60_000);
};
const withPrefix = (nodes, prefix) => nodes.find((node) => (node['content-desc'] ?? '').startsWith(prefix));
const openSpeech = async () => {
    let nodes = await toTabs();
    nodes = await tapExpecting(tab(nodes, en['tab.menu']) ?? fail('no Menu tab'), (next) => Boolean(tagged(next, 'more-sheet')), 'the More sheet');
    await tapExpecting(withDescription(await device.settle(nodes), en['nav.settings']) ?? fail('no Settings tile'), (next) => Boolean(tagged(next, 'settings-main')), 'Settings');
    await tapExpecting(await device.revealNode((next) => withPrefix(next, `${en['settings.advanced']}. `), 'Advanced row'), (next) => Boolean(tagged(next, 'settings-advanced')), 'Advanced');
    await tapExpecting(await device.revealNode((next) => withPrefix(next, `${en['settings.ai']}. `), 'AI row'), (next) => Boolean(tagged(next, 'settings-ai')), 'Settings › AI', 30_000);
    nodes = await screen();
    if (!tagged(nodes, 'ai-speech-enabled')) nodes = await tapExpecting(await device.revealNode((next) => tagged(next, 'ai-speech-card'), 'Speech card'), (next) => Boolean(tagged(next, 'ai-speech-enabled')), 'the Speech card open');
    return nodes;
};
const agreeIfAsked = async () => {
    const nodes = await screen();
    const agree = tagged(nodes, 'ai-consent-agree');
    if (agree) await tapExpecting(agree, (next) => !tagged(next, 'ai-consent-agree'), 'consent agreed');
};
const speechSettings = () => JSON.parse(sqlite('SELECT data FROM settings WHERE id = 1')[0]?.data ?? '{}').ai?.speechToText ?? {};
const openPopup = async () => {
    const nodes = await toTabs();
    const capture = withDescription(nodes, en['nav.addTask']) ?? withDescription(nodes, en['quickAdd.audioCaptureLabel']) ?? fail('no capture button');
    return tapExpecting(capture, popup, 'the capture popup');
};
const startRecording = async () => {
    const nodes = await screen();
    return tapExpecting(mic(nodes) ?? fail('no mic'), recording, 'the recording row', 30_000);
};

let stub = null;
const started = new Date(Date.now() - 60_000).toISOString();
const cleanup = cleanupOnExit([
    () => execFileSync(adbBin, ['-s', serial, 'reverse', '--remove', `tcp:${PORT}`], { stdio: 'ignore' }),
    () => sh(`pm grant ${PKG} ${MIC}`),
    () => { void stub?.close(); },
    () => sh(`rm -f ${UI_FILE}`),
]);

try {
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} / run ${run}`);
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    stub = await serveStub();
    execFileSync(adbBin, ['-s', serial, 'reverse', `tcp:${PORT}`, `tcp:${PORT}`], { stdio: 'inherit' });
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    sh(`pm grant ${PKG} ${MIC}`);
    await restart();

    // (1) Speech on, OpenAI, the stub's base URL.
    let nodes = await openSpeech();
    if (!speechSettings().enabled) {
        await tap(tagged(nodes, 'ai-speech-enabled') ?? fail('no speech switch'));
        await sleep(800);
        await agreeIfAsked();
    }
    nodes = await screen();
    const openai = await device.revealNode((next) => tagged(next, 'ai-speech-provider-openai'), 'OpenAI speech chip');
    await tap(openai);
    await sleep(800);
    await agreeIfAsked();
    // The field emptied and the stub's URL typed, as check-ai-device.mjs types its base URL.
    await device.focusAtEnd(await device.revealNode((next) => tagged(next, 'ai-speech-base-url'), 'speech base URL'));
    requireAppFront();
    sh('input keycombination KEYCODE_CTRL_LEFT KEYCODE_A');
    sh('input keyevent KEYCODE_DEL');
    sh(`input text '${BASE_URL}'`);
    await sleep(700);
    await hideKeyboard();
    await waitFor('the speech settings stored', () => {
        const speech = speechSettings();
        return speech.enabled === true && speech.provider === 'openai' && speech.baseUrl === BASE_URL;
    }, 30_000);
    check(true, `(1) speech on with OpenAI at ${BASE_URL}`);

    // (2) Record, stop, save first, then the transcript.
    nodes = await openPopup();
    check(micLabel(nodes) === en['quickAdd.audioRecord'], `(2) RN's record button beside the title: "${micLabel(nodes)}"`);
    nodes = await startRecording();
    check(micLabel(nodes) === en['quickAdd.audioStop'] && recording(nodes), '(2) recording: Stop recording and RN\'s recording row');
    await sleep(3000);
    await tap(mic(await screen()));
    await waitFor('the popup closed after the save', (current) => !popup(current), 30_000);
    // waitFor answers the screen's nodes, so the task is kept here. The first title is quickAdd.audioNoteTitle ("Audio Note").
    let saved = null;
    await waitFor('the voice task', () => (saved = runTasks().find((task) => task.title === SPOKEN
        || task.title.startsWith(`${en['quickAdd.audioNoteTitle']} `))), 30_000);
    const attachments = JSON.parse(saved.attachments ?? '[]');
    check(attachments.length === 1 && attachments[0].mimeType === 'audio/mp4' && attachments[0].uri.includes('/files/attachments/')
        && attachments[0].title.startsWith(`${en['quickAdd.audioNoteTitle']} `), `(2) saved with the recording in managed storage: ${attachments[0]?.title} ${attachments[0]?.mimeType}`);
    const transcribed = await waitFor('the transcript as the title', () => runTasks().find((task) => task.title === SPOKEN), 60_000);
    check(Boolean(transcribed), `(2) the stub's transcript became the title: ${SPOKEN}`);
    const upload = stub.seen.find((entry) => entry.path === '/v1/audio/transcriptions');
    check(Boolean(upload && /^multipart\/form-data; boundary=/.test(upload.type) && upload.part?.[0]?.endsWith('.m4a') && upload.part?.[1] === 'audio/mp4' && upload.bytes > 1000),
        `(2) an m4a multipart upload: ${upload?.part?.join(' ')} ${upload?.bytes} bytes`);
    check(recordings().length === 0, `(2) no recording left in files/voice-captures (${recordings().join(' ')})`);

    // (3) Closed while recording: nothing saved, nothing left.
    const before = runTasks().length;
    await openPopup();
    await startRecording();
    await sleep(1500);
    nodes = await screen();
    await tapExpecting(withDescription(nodes, en['common.close']) ?? fail('no Close'), (current) => !popup(current), 'the popup closed');
    await sleep(2000);
    check(runTasks().length === before && recordings().length === 0, '(3) closing the popup while recording saves nothing and leaves no file');

    // (4) Leaving the app while recording, then back: idle, and it records again (review N5).
    await openPopup();
    await startRecording();
    requireAppFront();
    sh('input keyevent KEYCODE_HOME');
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    await sleep(1500);
    device.launch(ACTIVITY);
    nodes = await waitFor('the popup back', popup, 30_000);
    check(!recording(nodes) && micLabel(nodes) === en['quickAdd.audioRecord'] && recordings().length === 0,
        '(4) back from Home: the mic is idle, no recording row, no recording left');
    nodes = await startRecording();
    check(recording(nodes), '(4) the next tap records again');
    await tapExpecting(withDescription(nodes, en['common.close']) ?? fail('no Close'), (current) => !popup(current), 'the popup closed');

    // (5) The permission refused: RN's alert, nothing records.
    sh(`pm revoke ${PKG} ${MIC}`);
    await restart();
    nodes = await openPopup();
    await tap(mic(nodes) ?? fail('no mic'));
    const deny = await waitFor('the system permission prompt', (current) => current.find((node) => /permission_deny(_and_dont_ask_again)?_button$/.test(node['resource-id'] ?? '')), 20_000);
    // The system's own dialog is in front, so the app-front guard of tap() does not apply: tap it only while it is the one in front.
    if (!front().includes('permissioncontroller')) throw new Stopped(`the permission prompt is not in front: ${front().trim()}`);
    const [dx1, dy1, dx2, dy2] = box(deny.find((node) => /permission_deny(_and_dont_ask_again)?_button$/.test(node['resource-id'] ?? '')));
    sh(`input tap ${Math.round((dx1 + dx2) / 2)} ${Math.round((dy1 + dy2) / 2)}`);
    // The alert is a dialog window, which carries no test tags: it is found by RN's title and its OK button by text.
    const alertShown = (current) => current.some((node) => node.text === en['quickAdd.audioPermissionTitle']);
    const alertOk = (current) => current.find((node) => node.text === en['common.ok']);
    nodes = await waitFor('RN\'s permission alert', (current) => alertShown(current) && Boolean(alertOk(current)), 20_000);
    check(nodes.some((node) => node.text === en['quickAdd.audioPermissionTitle']), `(5) a refused permission shows RN's alert: ${en['quickAdd.audioPermissionTitle']}`);
    await tapExpecting(alertOk(nodes), (current) => !alertShown(current), 'the alert closed');
    check(!recording(await screen()) && recordings().length === 0, '(5) nothing records');
    sh(`pm grant ${PKG} ${MIC}`);

    // Speech off again, for the checks after this one.
    nodes = await openSpeech();
    if (speechSettings().enabled) await tap(tagged(nodes, 'ai-speech-enabled'));
    await waitFor('speech off', () => speechSettings().enabled !== true, 20_000);
    await toTabs();
    console.log('PASS: voice capture');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    cleanup();
}
