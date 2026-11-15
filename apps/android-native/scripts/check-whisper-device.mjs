import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { check, connect, evidenced, fail, Stopped, tab, tagged, withDescription } from './device.mjs';
import { cleanupOnExit } from './check-net-device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-whisper-device.mjs <adb-serial> [apk]   (MINDWTR_WHISPER_WAV=<16 kHz mono PCM16 jfk.wav>)');
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
const fixture = process.env.MINDWTR_WHISPER_WAV ?? '/home/dd/tmp/mindwtr-whisper-fixtures-20261031/jfk.wav';
if (!existsSync(fixture)) {
    console.error(`REFUSED: no speech fixture at ${fixture}; set MINDWTR_WHISPER_WAV to whisper.cpp's samples/jfk.wav`);
    process.exit(2);
}
const ACTIVITY = `${PKG}/${PKG}.MainActivity`;
const UI_FILE = '/data/local/tmp/mindwtr-native-dev-ui.xml';
const DB = 'mindwtr-native-dev.db';
const MIC = 'android.permission.RECORD_AUDIO';
const work = resolve(app, 'android/build/whisper-check');
const coreSrc = resolve(repo, 'packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));
const { WHISPER_MODELS } = await import(resolve(coreSrc, 'whisper-models.ts'));
const tiny = WHISPER_MODELS.find((model) => model.id === 'whisper-tiny');
const LOG = `files/${/export const DIAGNOSTICS_LOG_RELATIVE_PATH = '([^']+)'/.exec(readFileSync(resolve(coreSrc, 'diagnostics-log.ts'), 'utf8'))[1]}`;
const SLUG = 'v1.3.9/native-whisper-local';
const SPOKEN = /ask not what your country can do for you/i;


const canonicalWave = () => {
    const bytes = readFileSync(fixture);
    if (bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE') fail(`${fixture} is not a WAV`);
    let format = null;
    let data = null;
    for (let at = 12; at + 8 <= bytes.length;) {
        const id = bytes.toString('latin1', at, at + 4);
        const size = bytes.readUInt32LE(at + 4);
        if (id === 'fmt ') format = { pcm: bytes.readUInt16LE(at + 8), channels: bytes.readUInt16LE(at + 10), rate: bytes.readUInt32LE(at + 12), bits: bytes.readUInt16LE(at + 22) };
        if (id === 'data') data = bytes.subarray(at + 8, at + 8 + size);
        at += 8 + size + (size % 2);
    }
    if (!format || !data || format.pcm !== 1 || format.channels !== 1 || format.rate !== 16_000 || format.bits !== 16) fail(`${fixture} is not 16 kHz mono PCM16`);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8, 'latin1');
    header.write('fmt ', 12, 'latin1'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16_000, 24); header.writeUInt32LE(32_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write('data', 36, 'latin1'); header.writeUInt32LE(data.length, 40);
    const file = resolve(work, 'speech.wav');
    writeFileSync(file, Buffer.concat([header, data]));
    return file;
};

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { adbRaw, sh, home, front, requireAppFront, screen, waitFor, tap, tapExpecting } = device;
const runAs = (command) => sh(`run-as ${PKG} ${command}`);

const pullDatabase = () => {
    const dir = resolve(work, 'db');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = runAs('ls files').split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    return resolve(dir, DB);
};
const sqlite = (sql) => {
    const out = execFileSync('sqlite3', ['-json', pullDatabase(), sql], { encoding: 'utf8' }).trim();
    return out ? JSON.parse(out) : [];
};
const speechSettings = () => JSON.parse(sqlite('SELECT data FROM settings WHERE id = 1')[0]?.data ?? '{}').ai?.speechToText ?? {};
const logLines = () => {
    const present = runAs(`sh -c 'if [ -f ${LOG} ]; then echo present; fi'`) === 'present';
    return present ? adbRaw('exec-out', 'run-as', PKG, 'cat', LOG).toString('utf8').split('\n').filter((line) => line.includes(SLUG)) : [];
};
const modelSize = () => Number(runAs(`sh -c 'stat -c %s files/whisper-models/${tiny.fileName} 2>/dev/null || echo 0'`));

const keyboardShown = () => /mInputShown=true/.test(sh('dumpsys input_method'));
const toTabs = async () => {
    for (let step = 0; step < 10; step += 1) {
        const nodes = await screen();
        if (tab(nodes, en['tab.menu']) && !tagged(nodes, 'menu-screen') && !tagged(nodes, 'more-sheet') && !tagged(nodes, 'quick-capture')) return nodes;
        if (keyboardShown()) { requireAppFront(); sh('input keyevent KEYCODE_BACK'); await sleep(600); }
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
    const agree = tagged(await screen(), 'ai-consent-agree');
    if (agree) await tapExpecting(agree, (next) => !tagged(next, 'ai-consent-agree'), 'consent agreed');
};
const action = () => device.revealNode((next) => tagged(next, 'ai-whisper-action'), 'the offline model button', false);
const status = (nodes) => tagged(nodes, 'ai-whisper-status')?.text ?? '';
const until = async (description, read, timeoutMs, everyMs = 3_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = read();
        if (value) return value;
        await sleep(everyMs);
    }
    return fail(`timed out waiting for ${description}`);
};
const shot = (name) => writeFileSync(resolve(work, `${name}.png`), adbRaw('exec-out', 'screencap', '-p'));

const cleanup = cleanupOnExit([
    () => { sh(`pm clear-permission-flags ${PKG} ${MIC} user-set user-fixed`); sh(`pm grant ${PKG} ${MIC}`); },
    () => sh(`rm -f ${UI_FILE} /data/local/tmp/mindwtr-whisper-speech.wav`),
]);

try {
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    const wave = canonicalWave();
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} / ${sh('getprop ro.product.cpu.abi')}`);
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    sh(`pm grant ${PKG} ${MIC}`);
    await restart();


    let nodes = await openSpeech();
    if (!speechSettings().enabled) {
        await tap(tagged(nodes, 'ai-speech-enabled') ?? fail('no speech switch'));
        await sleep(800);
        await agreeIfAsked();
    }
    await tap(await device.revealNode((next) => tagged(next, 'ai-speech-provider-whisper'), 'Whisper chip'));
    await waitFor('Whisper stored', () => speechSettings().provider === 'whisper' && speechSettings().enabled === true, 30_000);
    const leftover = await action();
    if (leftover['content-desc'] === en['settings.speechOfflineDelete']) {
        await tap(leftover);
        await waitFor('the leftover model deleted', (current) => status(current).startsWith(en['settings.speechOfflineNotDownloaded']), 60_000);
    }
    nodes = await waitFor('the Download button', (current) => tagged(current, 'ai-whisper-action')?.['content-desc'] === en['settings.speechOfflineDownload'], 30_000);
    shot('native-whisper-not-downloaded');
    check(status(nodes) === en['settings.speechOfflineNotDownloaded'] && modelSize() === 0, `(1) Whisper picked; the row reads "${status(nodes)}" with RN's Download button`);


    const downloadStarted = Date.now();
    await tap(await action());
    await waitFor('the download spinner', (current) => Boolean(tagged(current, 'ai-whisper-busy')), 20_000);
    nodes = await waitFor('the model ready', (current) => status(current).startsWith(en['settings.speechOfflineReady']), 20 * 60_000);
    shot('native-whisper-ready');
    const folder = runAs(`ls -a files/whisper-models`).split(/\s+/).filter((name) => name && name !== '.' && name !== '..');
    check(modelSize() === tiny.sizeBytes && folder.length === 1, `(2) downloaded in ${Math.round((Date.now() - downloadStarted) / 1000)} s: files/whisper-models holds only ${tiny.fileName} at ${tiny.sizeBytes} bytes; the row reads "${status(nodes)}"`);
    check(tagged(nodes, 'ai-whisper-action')?.['content-desc'] === en['settings.speechOfflineDelete'], '(2) the button turned into Delete');
    check(runAs(`sh -c 'ls files/whisper-models/*.part cache/whisper-downloads 2>/dev/null || true'`) === '', '(2) no partial download is left');
    check(logLines().some((line) => line.includes('model-ready')), `(2) the Diagnostics log shows ${SLUG} stage=download outcome=model-ready`);


    const id = randomUUID();
    const filesDir = runAs(`sh -c 'cd files && pwd'`);
    adbRaw('push', wave, '/data/local/tmp/mindwtr-whisper-speech.wav');
    sh('chmod 644 /data/local/tmp/mindwtr-whisper-speech.wav');
    runAs(`sh -c 'mkdir -p files/quick-capture-audio files/pending-captures && cp /data/local/tmp/mindwtr-whisper-speech.wav files/quick-capture-audio/${id}.wav'`);
    const queued = JSON.stringify({ kind: 'audio', id, audioPath: `file://${filesDir}/quick-capture-audio/${id}.wav`, source: 'android-quick-capture', createdAt: new Date().toISOString() });
    runAs(`sh -c 'echo ${Buffer.from(queued).toString('base64')} | base64 -d > files/pending-captures/${id}.tmp && mv files/pending-captures/${id}.tmp files/pending-captures/${id}.json'`);
    const transcribeStarted = Date.now();
    await restart();
    const made = await until('the widget recording transcribed into a task', () => sqlite(`SELECT id, title FROM tasks WHERE deletedAt IS NULL AND id = '${id}'`)[0], 5 * 60_000);
    check(SPOKEN.test(made.title), `(3) the widget recording became a task titled by the on-device transcript in ${Math.round((Date.now() - transcribeStarted) / 1000)} s: "${made.title}"`);
    check(runAs(`sh -c 'ls files/quick-capture-audio/${id}.wav files/pending-captures/${id}.json 2>/dev/null || true'`) === '', '(3) its recording and queue file are gone');
    const transcribed = logLines().find((line) => line.includes('transcribed'));
    check(Boolean(transcribed) && !SPOKEN.test(transcribed), `(3) the log shows stage=transcribe outcome=transcribed with no transcript text: ${transcribed?.slice(0, 240)}`);


    nodes = await toTabs();
    const transcribeLines = () => logLines().filter((line) => line.includes('transcribe'));
    const before = transcribeLines().length;
    const capture = withDescription(nodes, en['nav.addTask']) ?? withDescription(nodes, en['quickAdd.audioCaptureLabel']) ?? fail('no capture button');
    nodes = await tapExpecting(capture, (current) => Boolean(tagged(current, 'quick-capture')), 'the capture popup');
    await tapExpecting(tagged(nodes, 'capture-mic') ?? fail('no mic'), (current) => Boolean(tagged(current, 'capture-recording')), 'the recording row', 30_000);
    await sleep(2500);
    await tap(tagged(await screen(), 'capture-mic'));
    await waitFor('the popup closed after the save', (current) => !tagged(current, 'quick-capture'), 30_000);
    await until('the popup recording ran through local Whisper', () => transcribeLines().length > before, 3 * 60_000);
    const popupLine = transcribeLines().at(-1);
    check(/transcribed|empty/.test(popupLine) && !/failed/.test(popupLine), `(4) a popup recording is a WAV that local Whisper transcribed on the device: ${popupLine.slice(0, 240)}`);


    nodes = await openSpeech();
    await tap(await action());
    nodes = await waitFor('the model deleted', (current) => status(current).startsWith(en['settings.speechOfflineNotDownloaded']), 60_000);
    check(modelSize() === 0 && tagged(nodes, 'ai-whisper-action')?.['content-desc'] === en['settings.speechOfflineDownload'],
        '(5) Delete removed the model file and the row offers Download again');
    check(logLines().some((line) => line.includes('deleted')), `(5) the log shows ${SLUG} stage=delete outcome=deleted`);
    if (speechSettings().enabled) await tap(tagged(await screen(), 'ai-speech-enabled') ?? await device.revealNode((next) => tagged(next, 'ai-speech-enabled'), 'speech switch'));
    await waitFor('speech off', () => speechSettings().enabled !== true, 20_000);
    await toTabs();
    console.log(`evidence: ${work}`);
    console.log('PASS: local Whisper');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    cleanup();
}
