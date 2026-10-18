// AI check for the isolated native Android development app: Settings › AI and the AI actions, against a local stub only.
//
//   node apps/android-native/scripts/check-ai-device.mjs <adb-serial> [apk]
//
// Starts an OpenAI-compatible stub on this computer (127.0.0.1:<port>, MINDWTR_AI_STUB_PORT or 18781) and maps the phone's
// port to it (`adb reverse`); no real provider and no real key is ever used. Then, through the app's own screens:
//   (1) Settings › Advanced › AI opens; with the consent record removed at boot (the debug-only `ai_consent_reset`), turning
//       the assistant on asks RN's question in RN's words and writes nothing until Agree; Agree records the consent under
//       RN's key in RKStorage and turns AI on (synced settings); a provider chosen while on asks again, and Cancel keeps OpenAI;
//   (2) the base URL typed (the stub's), the model list loaded from the stub (Suggestions lists its models), a model picked;
//   (3) a key typed: sealed in RN's SecureStore format under `key_v1-mindwtr-ai-key_openai`, and in no other app file, log line
//       or journal entry; the stub sees it as the bearer of the next request;
//   (4) the editor (a capture link's Save & edit): the copilot's chips from the stub, a chip applied to the draft only; an edit
//       while Clarify waits stops its provider call and no answer shows; Clarify shows core's dialog and changes nothing until a button; Use suggestion changes the draft; Break down's Add steps adds
//       the checklist; nothing is stored until Save, and Save stores core's edits;
//   (5) a stub error that echoes the key: the alert shows the error with the key redacted;
//   (6) Process Inbox's Clarify: core's dialog, and its button edits the step's draft only;
//   (7) the Weekly Review's Run analysis on the stale step: closing the review while it waits stops the provider call and the
//       reopened review shows no old answer; then core's suggestions (or its empty line), and nothing written;
//   (8) the capture screen's copilot: its chips from the stub; Cancel writes nothing;
//   (9) a kill during a key save: the stub sees a key the field held while typing (each keystroke is one write, in order; at a
//       kill at once, also the key before), never another; a key the field showed as saved survives a kill at once
//       after; the journal holds no key and no setAIKey entry.
// It installs with `install -r` (development data stays), touches only the development package, never launches over another
// app, and on exit removes the port mapping and debug properties, stops the stub and puts the keyboard back. Leave the device on
// its home screen. Exit 0 = pass, 1 = fail, 2 = refused, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, button, check, connect, evidenced, fail, inEditor, Stopped, switchOn, tab, tagged, withDescription } from './device.mjs';
import { cleanupOnExit } from './check-net-device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-ai-device.mjs <adb-serial> [apk]');
    process.exit(2);
}
const app = resolve(import.meta.dirname, '..');
const repo = resolve(app, '../..');
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
const DB = 'mindwtr-native-dev.db';
const SCHEME = 'mindwtr-native-dev';
const work = resolve(app, 'android/build/ai-check');
const { en } = await import(resolve(repo, 'packages/core/src/i18n/locales/en.ts'));

// This run's names: letters and digits only for what the phone types.
const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const PORT = Number(process.env.MINDWTR_AI_STUB_PORT ?? 18781);
const BASE_URL = `http://127.0.0.1:${PORT}/v1`;
const KEYS = { first: `sk${run}first`, echo: `sk${run}echo` };
const MODELS = ['stub-chat-small', 'stub-chat-large'];
const titles = { editor: `Call bank ${run}`, inbox: `Gift Sam ${run}`, capture: `Pay rent ${run}`, staleSomeday: `Old errand ${run}`, staleKeep: `Old idea ${run}` };
const ANSWERS = {
    clarify: { question: `Which step for ${run}?`, options: [{ label: 'Phone the branch', action: `Phone the branch ${run}` }],
        suggestedAction: { title: `Call the bank today ${run}`, timeEstimate: '15min', context: '@phone' } },
    breakdown: { steps: [`Find the card ${run}`, `Dial the number ${run}`] },
};

/**
 * The OpenAI-compatible stub: GET /v1/models lists MODELS; POST /v1/chat/completions answers by the prompt's shape (Clarify,
 * Break down, the review analysis, the copilot). Mode "echo" answers 400 with the bearer echoed back (core shows a 400's message; a 401's it words itself). Mode "hold" never answers: it reports the request "held", then "aborted" when the app closes it. It runs on a worker
 * thread: the check's own adb calls are synchronous and would hold a request on this thread's event loop until the phone gave
 * up on it. Every request's method, path, bearer and answer kind comes back as a message into `seen`.
 */
const STUB_SOURCE = `
    const { createServer } = require('node:http');
    const { parentPort, workerData: { port, models, answers, run } } = require('node:worker_threads');
    let mode = 'ok';
    parentPort.on('message', (message) => { mode = message.mode; });
    const server = createServer((request, response) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
            const bearer = (request.headers.authorization ?? '').replace(/^Bearer /, '');
            const seen = { method: request.method, path: request.url, bearer, at: new Date().toISOString().slice(11, 23) };
            const answer = (status, json, kind) => {
                parentPort.postMessage({ ...seen, kind });
                response.writeHead(status, { 'content-type': 'application/json' });
                response.end(JSON.stringify(json));
            };
            if (request.method === 'GET' && request.url === '/v1/models') return answer(200, { data: models.map((id) => ({ id })) });
            if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return answer(404, { error: { message: 'not found' } });
            if (mode === 'echo') return answer(400, { error: { message: 'Incorrect API key provided: ' + bearer, type: 'invalid_request_error' } }, 'echo');
            if (mode === 'hold') {
                parentPort.postMessage({ ...seen, kind: 'held' });
                response.on('close', () => { if (!response.writableEnded) parentPort.postMessage({ ...seen, kind: 'aborted' }); });
                return;
            }
            const prompt = JSON.parse(Buffer.concat(chunks).toString('utf8')).messages.at(-1).content;
            let content;
            if (prompt.includes('"question"')) content = answers.clarify;
            else if (prompt.includes('"steps"')) content = answers.breakdown;
            else if (prompt.includes('"suggestions"')) {
                // Only this run's stale tasks (never dd's fixture): the first to Someday, the other kept.
                const items = JSON.parse(prompt.slice(prompt.lastIndexOf('Items:\\n') + 7)).filter((item) => item.title.includes(run));
                content = { suggestions: items.map((item) => ({ id: item.id, action: item.title.startsWith('Old errand') ? 'someday' : 'keep', reason: 'Stale for weeks ' + run })) };
            } else {
                const task = JSON.parse(prompt.slice(prompt.lastIndexOf('Task:\\n') + 6));
                content = { context: task.contextCandidates[0] ?? null, tags: ['#finance'], timeEstimate: '15min' };
            }
            return answer(200, { choices: [{ message: { role: 'assistant', content: JSON.stringify(content) } }] }, Object.keys(content)[0]);
        });
    });
    server.listen(port, '127.0.0.1', () => parentPort.postMessage({ listening: true }));
`;
const serveStub = () => new Promise((resolveServer, rejectServer) => {
    const worker = new Worker(STUB_SOURCE, { eval: true, workerData: { port: PORT, models: MODELS, answers: ANSWERS, run } });
    const state = { seen: [], set mode(mode) { worker.postMessage({ mode }); } };
    worker.on('message', (message) => {
        if (message.listening) resolveServer({ state, close: () => worker.terminate() });
        else state.seen.push(message);
    });
    worker.on('error', rejectServer);
});

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting } = device;
const logs = () => device.logs(pid(), TAG);

// ---- The phone's storage (run-as copies, read on this computer) ----
const pullFile = (remote, name) => {
    const dir = resolve(work, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const base = remote.split('/').pop();
    const folder = remote.slice(0, remote.length - base.length - 1);
    const present = sh(`run-as ${PKG} ls ${folder}`).split(/\s+/);
    for (const suffix of ['', '-wal', '-shm', '-journal']) if (present.includes(`${base}${suffix}`)) device.pull(`${remote}${suffix}`, resolve(dir, `${base}${suffix}`));
    return resolve(dir, base);
};
const sqlite = (file, sql) => {
    const out = execFileSync('sqlite3', ['-json', file, sql], { encoding: 'utf8' }).trim();
    return out ? JSON.parse(out) : [];
};
const database = () => pullFile(`files/${DB}`, 'db');
const aiSettings = () => JSON.parse(sqlite(database(), 'SELECT data FROM settings WHERE id = 1')[0]?.data ?? '{}').ai ?? {};
/** The live tasks titled [title] (this run's titles hold only letters, digits and spaces). */
const taskByTitle = (title) => sqlite(database(), `SELECT title, status, tags, contexts, checklist, timeEstimate, rev FROM tasks WHERE deletedAt IS NULL AND title = '${title}'`);
const rkStorage = () => Object.fromEntries(sqlite(pullFile('databases/RKStorage', 'rk'), 'SELECT key, value FROM catalystLocalStorage').map((row) => [row.key, row.value]));
const grepApp = (text) => sh(`run-as ${PKG} sh -c "grep -rl '${text}' files databases shared_prefs 2>/dev/null || true"`).split(/\s+/).filter(Boolean);
const STAGED = '/data/local/tmp/mindwtr-native-dev-ai-check.db';
/**
 * Core's store on a copy of the app's database (the app stopped), as check-review-organize-device.mjs does: `inject` adds this
 * run's two stale tasks (next, untouched for 40 days: core's Weekly Review lists them), `remove` deletes them forever. The copy
 * goes back whole (its WAL checkpointed into the main file), and the app starts again.
 */
const editDatabase = async (mode) => {
    await device.stopApp();
    const db = database();
    const out = JSON.parse(execFileSync('bun', ['-e', `
        import { Database } from 'bun:sqlite';
        import { SqliteAdapter, createNativeHostContract, flushPendingSave, setStorageAdapter, useTaskStore } from ${JSON.stringify(resolve(repo, 'packages/core/src/index.ts'))};
        const db = new Database(process.env.CHECK_DB);
        setStorageAdapter(new SqliteAdapter({
            run: async (sql, params = []) => { db.query(sql).run(...params); },
            all: async (sql, params = []) => db.query(sql).all(...params),
            get: async (sql, params = []) => db.query(sql).get(...params) ?? undefined,
            exec: async (sql) => { db.exec(sql); },
        }));
        const host = createNativeHostContract();
        await host.setLanguage({ storedLanguage: 'en', systemLocale: null });
        const ready = await host.activate({ writeSafetyReady: true });
        if (!ready.ok) throw new Error(ready.error.message);
        const store = () => useTaskStore.getState();
        const titles = JSON.parse(process.env.CHECK_TITLES);
        const done = (result) => { if (!result.success) throw new Error(result.error); return result; };
        if (process.env.CHECK_MODE === 'inject') {
            for (const title of titles) done(await store().addTask(title, { status: 'next' }));
        } else {
            const ids = store()._allTasks.filter((task) => !task.deletedAt && titles.includes(task.title)).map((task) => task.id);
            if (ids.length) { done(await store().batchDeleteTasks(ids)); done(await store().purgeTasks(ids)); }
        }
        await flushPendingSave();
        if (store().persistenceFailure) throw new Error('save failed: ' + store().persistenceFailure.message);
        if (process.env.CHECK_MODE === 'inject') {
            const old = new Date(Date.now() - 40 * 86400000).toISOString();
            for (const title of titles) db.query('UPDATE tasks SET createdAt = ?, updatedAt = ? WHERE title = ?').run(old, old, title);
        }
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        db.close();
        console.log(JSON.stringify({ ok: true }));
    `], { encoding: 'utf8', cwd: repo, env: { ...process.env, CHECK_DB: db, CHECK_MODE: mode, CHECK_TITLES: JSON.stringify([titles.staleSomeday, titles.staleKeep]) } }).trim().split('\n').pop());
    if (!out.ok) fail(`the database ${mode} failed`);
    device.adbRaw('push', db, STAGED);
    try { sh(`run-as ${PKG} cp ${STAGED} files/${DB}`); } finally { sh(`rm -f ${STAGED}`); }
    sh(`run-as ${PKG} rm -f files/${DB}-wal files/${DB}-shm`);
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    device.launch(ACTIVITY);
    return waitFor('the tabs', (current) => Boolean(tab(current, en['tab.inbox'])), 60_000);
};
let staleInjected = false;
const journalEntries = () => sh(`run-as ${PKG} sh -c 'ls files/journal 2>/dev/null; cat files/journal/*.json 2>/dev/null' || true`);

// ---- UI (core's English) ----
const sheetOpen = (nodes) => Boolean(tagged(nodes, 'more-sheet'));
const onAI = (nodes) => Boolean(tagged(nodes, 'settings-ai'));
const withPrefix = (nodes, prefix) => nodes.find((node) => (node['content-desc'] ?? '').startsWith(prefix));
const keyboardShown = () => /mInputShown=true/.test(sh('dumpsys input_method'));
const hideKeyboard = async () => {
    if (!keyboardShown()) return;
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await sleep(600);
};
/** Back until the tab bar shows (nothing open over it). */
const toTabs = async () => {
    for (let step = 0; step < 10; step += 1) {
        const nodes = await screen();
        if (tab(nodes, en['tab.menu']) && !tagged(nodes, 'menu-screen') && !sheetOpen(nodes) && !inEditor(nodes) && !tagged(nodes, 'capture-modal')
            && !tagged(nodes, 'process-inbox') && !tagged(nodes, 'weekly-review') && !tagged(nodes, 'quick-capture')) return nodes;
        await hideKeyboard();
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(1000);
    }
    return fail('the tabs did not come back');
};
/** The main list scrolled until [find] picks a node fully in view: from the top, then down. */
const reveal = (find, description) => device.revealNode(find, description);
/** Settings from the More sheet. */
const openSettings = async () => {
    let nodes = await toTabs();
    nodes = await tapExpecting(tab(nodes, en['tab.menu']) ?? fail('no Menu tab'), sheetOpen, 'the More sheet');
    return tapExpecting(withDescription(await device.settle(nodes), en['nav.settings']) ?? fail('no Settings tile'),
        (next) => Boolean(tagged(next, 'settings-main')), 'Settings');
};
/** Settings › Advanced › AI (core's rows read "<title>. <description>"). */
const openAI = async () => {
    const nodes = await screen();
    if (onAI(nodes)) return nodes;
    await openSettings();
    await tapExpecting(await reveal((next) => withPrefix(next, `${en['settings.advanced']}. `), 'Advanced row'), (next) => Boolean(tagged(next, 'settings-advanced')), 'Settings › Advanced');
    return tapExpecting(await reveal((next) => withPrefix(next, `${en['settings.ai']}. `), 'AI row'), onAI, 'Settings › AI', 30_000);
};
const tapTag = async (tag, expected, description, timeoutMs = 30_000) => {
    await hideKeyboard();
    return tapExpecting(await reveal((current) => tagged(current, tag), tag), expected, description, timeoutMs);
};
/** A folded card or row ([tag]) opened. */
const unfold = async (tag, shows) => {
    const nodes = await screen();
    if (shows(nodes)) return nodes;
    return tapTag(tag, shows, `${tag} open`);
};
/** A text field (its test tag) focused and typed after what it shows; [clear] empties it first. */
const typeInto = async (tag, text, clear = true, settleMs = 700) => {
    const node = await reveal((current) => tagged(current, tag), tag);
    await device.focusAtEnd(node);
    requireAppFront();
    if (clear) {
        sh('input keycombination KEYCODE_CTRL_LEFT KEYCODE_A');
        sh('input keyevent KEYCODE_DEL');
    }
    sh(`input text '${text}'`);
    await sleep(settleMs);
};
/** How many stub requests answered (or held) as [kind]. */
const kinds = (kind) => stub.state.seen.filter((entry) => entry.kind === kind).length;
/** The consent dialog: its title and message as shown. */
const dialogTexts = (nodes) => nodes.filter((node) => node.class === 'android.widget.TextView').map((node) => node.text).filter(Boolean);
/** How many times [operation] answered (host-entry.ts taskResult's line). */
const commands = (operation, outcome = 'saved') => logs().replace(/\\/g, '').split('\n')
    .filter((line) => line.includes(`"operation":"${operation}"`) && line.includes(`"outcome":"${outcome}"`)).length;
const until = async (description, holds, timeoutMs = 60_000, everyMs = 1_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await holds()) return;
        if (Date.now() > deadline) fail(`timed out waiting for ${description}`);
        await sleep(everyMs);
    }
};
const link = async (query, expected, description) => {
    requireAppFront();
    sh(`am start -W -a android.intent.action.VIEW -d '${SCHEME}://capture?${query}' ${PKG}`);
    return waitFor(description, expected, 30_000);
};
/** The app started afresh (a new process), on the Inbox. */
const restart = async (props = {}) => {
    await device.stopApp();
    for (const [name, value] of Object.entries(props)) sh(`setprop debug.mindwtr.native.${name} ${value}`);
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    device.launch(ACTIVITY);
    const nodes = await waitFor('the tabs', (current) => Boolean(tab(current, en['tab.inbox'])), 60_000);
    for (const name of Object.keys(props)) sh(`setprop debug.mindwtr.native.${name} ''`);
    return nodes;
};
/** Core's consent question for [provider], computed by core itself (bun), in English. */
const consentPrompt = (provider) => JSON.parse(execFileSync('bun', ['-e', `
    const { getAIConsentPrompt, createAISettingsTranslator } = await import(${JSON.stringify(resolve(repo, 'packages/core/src/ai-settings-model.ts'))});
    const { getTranslator } = await import(${JSON.stringify(resolve(repo, 'packages/core/src/i18n/index.ts'))});
    const t = getTranslator('en');
    console.log(JSON.stringify(getAIConsentPrompt(${JSON.stringify(provider)}, false, { t, tr: createAISettingsTranslator(t) })));
`], { encoding: 'utf8', cwd: repo }).trim().split('\n').pop());

let stub = null;
const cleanup = cleanupOnExit([
    () => execFileSync(adbBin, ['-s', serial, 'reverse', '--remove', `tcp:${PORT}`], { stdio: 'ignore' }),
    () => sh("setprop debug.mindwtr.native.ai_consent_reset ''"),
    () => { void stub?.close(); },
    () => sh(`rm -f ${UI_FILE}`),
]);

try {
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')}) / locale ${sh('getprop persist.sys.locale')}`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}\nrun: ${run}`);
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    stub = await serveStub();
    execFileSync(adbBin, ['-s', serial, 'reverse', `tcp:${PORT}`, `tcp:${PORT}`], { stdio: 'inherit' });
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    await restart({ ai_consent_reset: 1 });
    check(!rkStorage()['mindwtr-ai-provider-consent-v1'], '(0) the app booted with no AI consent recorded (debug reset)');

    // (1) Settings › AI; AI off first when an earlier run left it on.
    let nodes = await openAI();
    check(onAI(nodes), '(1) Settings › AI opens from Settings › Advanced');
    nodes = await unfold('ai-assistant-card', (current) => Boolean(tagged(current, 'ai-enabled')));
    const enableLabel = en['settings.aiEnable'];
    if (switchOn(nodes, enableLabel)) {
        await tapTag('ai-enabled', (current) => !switchOn(current, enableLabel), 'AI off');
        await until('AI off stored', () => aiSettings().enabled === false, 20_000);
    }
    const expected = consentPrompt('openai');
    const settingsBefore = aiSettings();
    // The question is RN's Alert (a dialog window of its own): its buttons are found by their words.
    const asked = (prompt) => (current) => dialogTexts(current).includes(prompt.title) && Boolean(button(current, prompt.agree));
    nodes = await tapTag('ai-enabled', asked(expected), 'the consent question');
    const shown = dialogTexts(nodes);
    check(shown.includes(expected.title) && shown.includes(expected.message), `(1) turning AI on asks RN's question in RN's words ("${expected.title}")`);
    check(button(nodes, expected.agree) && button(nodes, expected.cancel), `(1) the question offers RN's "${expected.cancel}" and "${expected.agree}"`);
    check(JSON.stringify(aiSettings()) === JSON.stringify(settingsBefore) && !rkStorage()['mindwtr-ai-provider-consent-v1'], '(1) nothing is written while the question is open');
    nodes = await tapExpecting(button(nodes, expected.agree), (current) => !asked(expected)(current) && switchOn(current, enableLabel), 'AI on after Agree');
    await until('AI on stored', () => aiSettings().enabled === true, 20_000);
    check(JSON.parse(rkStorage()['mindwtr-ai-provider-consent-v1'] ?? '{}').openai === true, '(1) Agree recorded the consent under RN\'s key in RKStorage, then turned AI on');
    // A provider chosen while on asks for that provider; Cancel keeps OpenAI.
    const gemini = consentPrompt('gemini');
    const geminiConsented = JSON.parse(rkStorage()['mindwtr-ai-provider-consent-v1']).gemini === true;
    if (!geminiConsented) {
        nodes = await tapTag('ai-provider-gemini', asked(gemini), 'the Gemini consent question');
        check(dialogTexts(nodes).includes(gemini.message), '(1) choosing Gemini while AI is on asks its own question');
        await tapExpecting(button(nodes, gemini.cancel), (current) => !asked(gemini)(current), 'the question closed');
        await sleep(1000);
        check((aiSettings().provider ?? 'openai') === 'openai' && !JSON.parse(rkStorage()['mindwtr-ai-provider-consent-v1']).gemini, '(1) Cancel keeps OpenAI and records nothing');
    }

    // (2) The stub as the OpenAI-compatible endpoint; its model list; a model picked.
    await typeInto('ai-base-url', BASE_URL);
    await hideKeyboard();
    await until('the base URL stored', () => aiSettings().baseUrl === BASE_URL, 20_000);
    check(!logs().includes(BASE_URL), '(2) the base URL is stored and never logged');
    await until('the model list asked from the stub', () => stub.state.seen.some((entry) => entry.path === '/v1/models'), 30_000);
    // The list shows once the stub's answer is back (the picker follows core's view as it changes).
    nodes = await tapTag('ai-model-suggestions', (current) => Boolean(tagged(current, 'ai-picker')) && MODELS.every((model) => current.some((node) => node['content-desc'] === model)), 'the model picker');
    check(MODELS.every((model) => nodes.some((node) => node['content-desc'] === model)), `(2) Suggestions lists the stub's models (${MODELS.join(', ')})`);
    await tapExpecting(withDescription(nodes, MODELS[1]), (current) => !tagged(current, 'ai-picker'), 'the model picked');
    await until('the model stored', () => aiSettings().model === MODELS[1], 20_000);
    check(true, `(2) picking ${MODELS[1]} stored it`);

    // (3) A key: RN's SecureStore format, nowhere else.
    await typeInto('ai-assistant-key', KEYS.first);
    await hideKeyboard();
    await tapTag('ai-model', (current) => Boolean(current), 'the key field left');
    await until('the key stored', () => /name="key_v1-mindwtr-ai-key_openai"/.test(sh(`run-as ${PKG} cat shared_prefs/SecureStore.xml`)), 20_000);
    const secretPrefs = sh(`run-as ${PKG} cat shared_prefs/SecureStore.xml`);
    const item = JSON.parse(/name="key_v1-mindwtr-ai-key_openai">([^<]*)</.exec(secretPrefs)[1].replace(/&quot;/g, '"'));
    check(item.scheme === 'aes' && item.usesKeystoreSuffix === true && item.keystoreAlias === 'key_v1' && item.requireAuthentication === false
        && item.tlen >= 96 && item.ct && item.iv, '(3) the key is sealed in RN\'s SecureStore item (AES-GCM, key_v1, unauthenticated)');
    check(!secretPrefs.includes(KEYS.first), '(3) SecureStore holds no plain key');
    const holders = grepApp(KEYS.first);
    check(holders.length === 0, `(3) no app file holds the key in plain text (${holders.join(', ') || 'none'}; journal, logs, databases, preferences)`);
    check(!journalEntries().includes(KEYS.first) && !/"setAIKey"/.test(journalEntries()), '(3) the journal holds no key and no setAIKey entry');
    check(!Object.values(rkStorage()).some((value) => value.includes(KEYS.first)), '(3) RKStorage holds no key');

    // (4) The editor: a capture link's Save & edit opens the task.
    nodes = await link(`title=${encodeURIComponent(titles.editor)}`, (current) => tagged(current, 'capture-modal-title')?.text === titles.editor, 'the capture screen');
    nodes = await tapExpecting(tagged(nodes, 'capture-modal-save-edit') ?? fail('no Save & edit'), (current) => inEditor(current) && !tagged(current, 'capture-modal'), 'the editor');
    const saved = taskByTitle(titles.editor)[0] ?? fail('the capture was not stored');
    nodes = await waitFor('the copilot\'s chips', (current) => current.some((node) => node['content-desc'] === '#finance'), 30_000);
    const copilotAsk = stub.state.seen.filter((entry) => entry.kind === 'context').at(-1);
    check(copilotAsk?.bearer === KEYS.first, '(4) the copilot asked the stub with the stored key as its bearer');
    nodes = await tapExpecting(withDescription(nodes, '#finance'), (current) => Boolean(tagged(current, 'ai-applied')), 'the chip applied');
    check(tagged(nodes, 'ai-applied').text.includes('#finance'), `(4) the chip is applied to the draft ("${tagged(nodes, 'ai-applied').text}")`);
    // An edit while Clarify waits stops its provider call, and its answer never shows (review C1 verification 5).
    {
        const [held, aborted] = [kinds('held'), kinds('aborted')];
        stub.state.mode = 'hold';
        await tap(tagged(nodes, 'ai-clarify'));
        await until('Clarify held by the stub', () => kinds('held') > held, 30_000);
        const titleField = (await screen()).find((node) => node.class === 'android.widget.EditText' && node.text === titles.editor) ?? fail('no title field');
        await device.focusAtEnd(titleField);
        requireAppFront();
        sh('input text 9');
        await until('the held Clarify stopped', () => kinds('aborted') > aborted, 20_000);
        stub.state.mode = 'ok';
        sh('input keyevent KEYCODE_DEL');
        await hideKeyboard();
        nodes = await waitFor('the title as before', (current) => current.some((node) => node.text === titles.editor), 10_000);
        await sleep(1_500);
        nodes = await screen();
        check(!tagged(nodes, 'ai-answer'), '(4) an edit while Clarify waited stopped its provider call, and no answer shows');
    }
    nodes = await tapExpecting(tagged(nodes, 'ai-clarify'), (current) => Boolean(tagged(current, 'ai-answer')), 'the Clarify dialog', 60_000);
    check(dialogTexts(nodes).includes(ANSWERS.clarify.question) && Boolean(withDescription(nodes, 'Phone the branch')) && Boolean(withDescription(nodes, en['ai.applySuggestion'])),
        '(4) Clarify shows core\'s dialog: the question, the stub\'s option and Use suggestion');
    check(JSON.stringify(taskByTitle(titles.editor)[0]) === JSON.stringify(saved), '(4) the answer wrote nothing');
    nodes = await tapExpecting(withDescription(nodes, en['common.cancel']), (current) => !tagged(current, 'ai-answer'), 'Cancel');
    check(nodes.some((node) => node.text === titles.editor), '(4) Cancel changed nothing on the draft');
    nodes = await tapExpecting(tagged(nodes, 'ai-clarify'), (current) => Boolean(tagged(current, 'ai-answer')), 'the Clarify dialog again', 60_000);
    nodes = await tapExpecting(withDescription(nodes, en['ai.applySuggestion']), (current) => current.some((node) => node.text === ANSWERS.clarify.suggestedAction.title), 'the suggestion applied');
    check(JSON.stringify(taskByTitle(titles.editor)[0]) === JSON.stringify(saved), '(4) Use suggestion changed the draft only; the stored task is unchanged');
    nodes = await tapExpecting(tagged(nodes, 'ai-breakdown'), (current) => Boolean(tagged(current, 'ai-answer')), 'the Break down dialog', 60_000);
    check(ANSWERS.breakdown.steps.every((step, index) => dialogTexts(nodes).some((text) => text.includes(`${index + 1}. ${step}`))), '(4) Break down shows core\'s numbered steps');
    await tapExpecting(withDescription(nodes, en['ai.addSteps']), (current) => !tagged(current, 'ai-answer'), 'Add steps');
    await tapExpecting(button(await screen(), en['common.save']) ?? fail('no Save'), (current) => !inEditor(current), 'the editor saved');
    await until('the edits stored', () => taskByTitle(ANSWERS.clarify.suggestedAction.title).length === 1, 20_000);
    const stored = taskByTitle(ANSWERS.clarify.suggestedAction.title)[0];
    const checklist = JSON.parse(stored.checklist ?? '[]').map((entry) => entry.title);
    check(JSON.parse(stored.tags ?? '[]').includes('#finance') && JSON.parse(stored.contexts ?? '[]').includes('@phone')
        && ANSWERS.breakdown.steps.every((step) => checklist.includes(step)), '(4) Save stored the suggestion\'s title and context, the chip\'s tag and the steps, in one write');

    // (5) A provider error that echoes the key: redacted.
    stub.state.mode = 'echo';
    nodes = await link(`title=${encodeURIComponent(`Echo ${run}`)}`, (current) => Boolean(tagged(current, 'capture-modal-title')), 'the capture screen for the echo');
    // Samsung's keyboard can open on its Clipboard panel, which took both taps on Save & edit (d1 full4, 10-12): the keyboard
    // goes first (a Back can only close the panel, so up to three).
    for (let tries = 0; tries < 3 && keyboardShown(); tries += 1) await hideKeyboard();
    nodes = await screen();
    nodes = await tapExpecting(tagged(nodes, 'capture-modal-save-edit') ?? fail('no Save & edit'), (current) => inEditor(current), 'the echo task\'s editor');
    nodes = await tapExpecting(tagged(nodes, 'ai-clarify'), (current) => dialogTexts(current).includes(en['ai.errorTitle']) && Boolean(button(current, en['common.ok'])), 'the error alert', 60_000);
    const alertText = dialogTexts(nodes).join(' | ');
    check(alertText.includes('Incorrect API key provided') && !alertText.includes(KEYS.first), `(5) the error shows, with the key redacted: ${alertText.slice(0, 200)}`);
    check(!logs().includes(KEYS.first), '(5) no log line holds the key');
    await tapExpecting(button(nodes, en['common.ok']), (current) => !dialogTexts(current).includes(en['ai.errorTitle']), 'the alert closed');
    stub.state.mode = 'ok';
    await toTabs();

    // (6) Process Inbox's Clarify: core's dialog; its button edits the step's draft only.
    await link(`title=${encodeURIComponent(titles.inbox)}`, (current) => tagged(current, 'capture-modal-title')?.text === titles.inbox, 'the capture screen for the Inbox');
    await tapExpecting(tagged(await screen(), 'capture-modal-save') ?? fail('no Save'), (current) => !tagged(current, 'capture-modal'), 'the capture saved');
    nodes = await toTabs();
    if (!(tab(nodes, en['tab.inbox'])?.selected === 'true')) nodes = await tapExpecting(tab(nodes, en['tab.inbox']), (current) => tab(current, en['tab.inbox'])?.selected === 'true', 'the Inbox');
    nodes = await device.toTop();
    const processButton = nodes.find((node) => new RegExp(`^${en['inbox.processButton']} \\(\\d+\\)$`).test(node['content-desc'] ?? '')) ?? fail('no Process Inbox button');
    nodes = await tapExpecting(processButton, (current) => Boolean(tagged(current, 'process-ai-clarify')), 'Process Inbox with AI Clarify');
    const stepTitle = tagged(nodes, 'process-title').text;
    const before = taskByTitle(stepTitle);
    nodes = await tapExpecting(tagged(nodes, 'process-ai-clarify'), (current) => Boolean(tagged(current, 'ai-answer')), 'the Process Inbox Clarify dialog', 60_000);
    check(dialogTexts(nodes).includes(ANSWERS.clarify.question), `(6) Process Inbox's Clarify shows core's dialog for "${stepTitle}"`);
    check(JSON.stringify(taskByTitle(stepTitle)) === JSON.stringify(before), '(6) the answer wrote nothing');
    nodes = await tapExpecting(withDescription(nodes, en['ai.applySuggestion']), (current) => tagged(current, 'process-title')?.text === ANSWERS.clarify.suggestedAction.title, 'the step\'s title from the suggestion');
    check(JSON.stringify(taskByTitle(stepTitle)) === JSON.stringify(before), '(6) Use suggestion edited the step\'s draft only (its title shows it); the task is unchanged');
    await tapExpecting(withDescription(nodes, en['common.close']) ?? fail('no Close'), (current) => !tagged(current, 'process-inbox'), 'Process Inbox closed');
    check(JSON.stringify(taskByTitle(stepTitle)) === JSON.stringify(before), '(6) closing Process Inbox wrote nothing');

    // (7) The Weekly Review's analysis on the stale step: this run's two stale tasks (injected through core's store), core's
    // suggestions from the stub, nothing written by the answer, and Apply selected moving only the chosen one to Someday.
    staleInjected = true;
    await editDatabase('inject');
    check(taskByTitle(titles.staleSomeday)[0]?.status === 'next' && taskByTitle(titles.staleKeep)[0]?.status === 'next', '(7) this run\'s two stale tasks are in the app\'s database');
    nodes = await toTabs();
    const reviewTab = tab(nodes, en['nav.review']);
    if (reviewTab) nodes = await tapExpecting(reviewTab, (current) => Boolean(button(current, en['review.startReview'])), 'Review');
    else {
        nodes = await tapExpecting(tab(nodes, en['tab.menu']), sheetOpen, 'the More sheet');
        nodes = await tapExpecting(withDescription(await device.settle(nodes), en['nav.review']) ?? fail('no Review tile'), (current) => Boolean(button(current, en['review.startReview'])), 'Review');
    }
    const weekly = (current) => Boolean(tagged(current, 'weekly-review')) && Boolean(tagged(current, 'review-step-title'));
    const startWeekly = async (current) => {
        const choices = await tapExpecting(button(current, en['review.startReview']), (next) => Boolean(button(next, en['review.openGuide'])), 'the Start Review choices');
        return tapExpecting(button(choices, en['review.openGuide']), weekly, 'the Weekly Review');
    };
    nodes = await startWeekly(nodes);
    console.log(`info - the Weekly Review opened on "${tagged(nodes, 'review-step-title').text}" (${tagged(nodes, 'review-step-indicator')?.text})`);
    // A checkpoint on the last step has no Back: Finish (core's lastReviewAt, as a user finishing it), then the guide starts over.
    if (!withDescription(nodes, en['review.back']) && withDescription(nodes, en['review.finish'])) {
        nodes = await tapExpecting(withDescription(nodes, en['review.finish']), (current) => Boolean(button(current, en['review.startReview'])), 'the review finished');
        nodes = await startWeekly(nodes);
        console.log(`info - after Finish it opened on "${tagged(nodes, 'review-step-title').text}" (${tagged(nodes, 'review-step-indicator')?.text})`);
    }
    const stale = en['review.staleStep'];
    const toStale = async (current) => {
        nodes = current;
        for (let steps = 0; steps < 10 && tagged(nodes, 'review-step-title').text !== stale; steps += 1) {
            const back = withDescription(nodes, en['review.back']);
            if (!back || back.enabled === 'false') break;
            const shownStep = tagged(nodes, 'review-step-title').text;
            nodes = await tapExpecting(back, (current) => weekly(current) && tagged(current, 'review-step-title').text !== shownStep, 'the step before');
        }
        for (let steps = 0; steps < 10 && tagged(nodes, 'review-step-title').text !== stale; steps += 1) {
            const shownStep = tagged(nodes, 'review-step-title').text;
            nodes = await waitFor('Next', (current) => Boolean(withDescription(current, en['review.next'])), 15_000);
            console.log(`info - on "${tagged(nodes, 'review-step-title').text}", Next`);
            nodes = await tapExpecting(withDescription(nodes, en['review.next']), (current) => weekly(current) && tagged(current, 'review-step-title').text !== shownStep, 'the next step');
        }
        return nodes;
    };
    nodes = await toStale(nodes);
    check(tagged(nodes, 'review-step-title').text === stale, `(7) the Weekly Review reached "${stale}"`);
    // Closing the review while its analysis waits stops the provider call; the review opened again shows no old answer
    // (review C1 verification 5 and A).
    {
        const [held, aborted] = [kinds('held'), kinds('aborted')];
        stub.state.mode = 'hold';
        await tap(await reveal((current) => tagged(current, 'review-ai-run'), 'Run analysis'));
        await until('the analysis held by the stub', () => kinds('held') > held, 30_000);
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        nodes = await waitFor('the review closed', (current) => !tagged(current, 'weekly-review') && Boolean(button(current, en['review.startReview'])), 15_000);
        await until('the held analysis stopped', () => kinds('aborted') > aborted, 20_000);
        stub.state.mode = 'ok';
        nodes = await toStale(await startWeekly(nodes));
        await sleep(1_500);
        nodes = await screen();
        check(!tagged(nodes, 'review-ai-suggestion') && !tagged(nodes, 'review-ai-error'), '(7) closing the review stopped its analysis, and the review opened again shows no old answer');
    }
    const tasksBefore = sqlite(database(), 'SELECT id, rev FROM tasks ORDER BY id');
    const asksBefore = stub.state.seen.filter((entry) => entry.kind === 'suggestions').length;
    const runButton = await reveal((current) => tagged(current, 'review-ai-run'), 'Run analysis');
    nodes = await tapExpecting(runButton, (current) => Boolean(tagged(current, 'review-ai-suggestion')) || current.some((node) => node.text === en['review.aiEmpty'])
        || Boolean(tagged(current, 'review-ai-error')), 'the analysis', 60_000);
    check(stub.state.seen.filter((entry) => entry.kind === 'suggestions').length > asksBefore, '(7) Run analysis asked the stub');
    nodes = await device.settle();
    if (tagged(nodes, 'review-ai-error')) fail(`the analysis failed: ${tagged(nodes, 'review-ai-error').text}`);
    // A suggestion's row (its test tag) holds its title: its checkbox state is the row's `checked`.
    const suggestionOf = (title, current = nodes) => {
        const label = current.find((node) => node.text === title && !(node['content-desc'] ?? '').includes('Status'));
        if (!label) return undefined;
        const [x1, y1, x2, y2] = box(label);
        return current.filter((node) => (node['resource-id'] ?? '').endsWith('review-ai-suggestion')).find((row) => {
            const [l, t, r, b] = box(row);
            return l <= x1 && t <= y1 && r >= x2 && b >= y2;
        });
    };
    // The suggestions sit under Run analysis, below the step's stale list (the phone's other stale tasks make it long): each
    // is scrolled into view on its own.
    const revealed = async (find, description) => reveal(find, description).catch(() => undefined);
    const somedaySuggestion = await revealed((current) => suggestionOf(titles.staleSomeday, current), 'the Someday suggestion');
    const keptSuggestion = await revealed((current) => suggestionOf(titles.staleKeep, current), 'the kept suggestion');
    const reason = await revealed((current) => current.find((node) => node.text === `${en['review.aiAction.someday']} · Stale for weeks ${run}`), 'the action label and reason');
    check(Boolean(somedaySuggestion) && Boolean(keptSuggestion) && Boolean(reason), '(7) the stub\'s suggestions show with core\'s action label and reason');
    check(somedaySuggestion.checked === 'true' && keptSuggestion.checked !== 'true' && keptSuggestion.enabled === 'false',
        '(7) the actionable suggestion is chosen; the kept one is not, and cannot be');
    check(JSON.stringify(sqlite(database(), 'SELECT id, rev FROM tasks ORDER BY id')) === JSON.stringify(tasksBefore), '(7) the analysis wrote nothing');
    const applyLabel = `${en['review.aiApply']} (1)`;
    const applyButton = await reveal((current) => tagged(current, 'review-ai-apply'), applyLabel);
    check((await screen()).some((node) => node.text === applyLabel), `(7) RN's "${applyLabel}"`);
    nodes = await tapExpecting(applyButton, () => taskByTitle(titles.staleSomeday)[0]?.status === 'someday', 'Apply selected', 30_000);
    check(taskByTitle(titles.staleKeep)[0]?.status === 'next', '(7) Apply selected moved only the chosen task to Someday (runReviewAction applySuggestions)');
    await toTabs();
    await editDatabase('remove');
    staleInjected = false;
    check(taskByTitle(titles.staleSomeday).length === 0 && taskByTitle(titles.staleKeep).length === 0, '(7) this run\'s stale tasks are removed again');

    // (8) The capture screen's copilot: its chips from the stub; Cancel writes nothing.
    nodes = await link(`title=${encodeURIComponent(titles.capture)}`, (current) => tagged(current, 'capture-modal-title')?.text === titles.capture, 'the capture screen for the copilot');
    await hideKeyboard();
    nodes = await waitFor('the capture screen\'s chips', (current) => current.some((node) => node['content-desc'] === '#finance'), 30_000);
    nodes = await tapExpecting(withDescription(nodes, '#finance'), (current) => current.some((node) => (node.text ?? '').startsWith(en['copilot.applied']) && node.text.includes('#finance')), 'the capture chip applied');
    check(true, '(8) the capture screen shows the stub\'s chips, and a chip shows as applied');
    await tapExpecting(tagged(nodes, 'capture-modal-cancel'), (current) => !tagged(current, 'capture-modal'), 'the capture cancelled');
    check(taskByTitle(titles.capture).length === 0, '(8) Cancel wrote nothing');

    // (9) Kills during a key save: the key is the one before or one the field held while typing, never another; no journal entry holds it.
    let storedKey = KEYS.first;
    // Each keystroke is one setAIKey, in order (AISettings.kt, review C1 4): the kills fall while the writes run and after.
    const modelsAsked = async (seenBefore, description) => {
        await until(description, () => stub.state.seen.slice(seenBefore).some((entry) => entry.path === '/v1/models'), 30_000);
        return stub.state.seen.slice(seenBefore).find((entry) => entry.path === '/v1/models').bearer;
    };
    const journalClean = (key) => {
        const journal = journalEntries();
        check(!journal.includes(key) && !/"setAIKey"/.test(journal), '(9) the journal holds neither the key nor a setAIKey entry');
    };
    for (const [index, waitMs] of [0, 300, 600].entries()) {
        const next = `sk${run}kill${index}`;
        await openAI();
        await unfold('ai-assistant-card', (current) => Boolean(tagged(current, 'ai-enabled')));
        // Typed after the dots (no clear): the field's first edit starts the key over, so each write is a prefix of the new key.
        await typeInto('ai-assistant-key', next, false, 0);
        await sleep(waitMs);
        const seenBefore = stub.state.seen.length;
        await restart();
        await openAI();
        const bearer = await modelsAsked(seenBefore, 'the model list asked with the stored key');
        const typedPart = bearer.length > 0 && next.startsWith(bearer);
        // At once after typing a write may not have landed yet (the key before); from 300 ms on, the field's text is stored.
        const allowed = typedPart || (waitMs === 0 && bearer === storedKey);
        check(allowed, `(9) killed ${waitMs} ms after typing: the stored key is ${typedPart ? `${bearer.length} of the ${next.length} typed characters` : bearer === storedKey ? 'the one before' : `another (${bearer.length} characters, ${[...bearer].filter((c) => c === '•').length} dots; a stub key)`}`);
        storedKey = bearer;
        journalClean(next);
    }
    // A key the field showed as saved (its writes stored, the model list asked with it) survives a kill at once after.
    {
        const saved = `sk${run}saved`;
        await openAI();
        await unfold('ai-assistant-card', (current) => Boolean(tagged(current, 'ai-enabled')));
        const seenTyping = stub.state.seen.length;
        await typeInto('ai-assistant-key', saved, false, 0);
        await hideKeyboard();
        await tapTag('ai-model', (current) => Boolean(current), 'the key field left');
        await until('the model list asked with the whole key', () => stub.state.seen.slice(seenTyping).some((entry) => entry.path === '/v1/models' && entry.bearer === saved), 30_000);
        const seenBefore = stub.state.seen.length;
        await restart();
        await openAI();
        const bearer = await modelsAsked(seenBefore, 'the model list asked after the kill');
        check(bearer === saved, '(9) a key the field showed as saved is the stored key after a kill at once after');
        journalClean(saved);
    }

    // AI off again, so the other device checks see the editor and Process Inbox without it.
    nodes = await openAI();
    nodes = await unfold('ai-assistant-card', (current) => Boolean(tagged(current, 'ai-enabled')));
    if (switchOn(nodes, enableLabel)) await tapTag('ai-enabled', (current) => !switchOn(current, enableLabel), 'AI off');
    await until('AI off stored', () => aiSettings().enabled === false, 20_000);
    await toTabs();
    console.log('AI device check passed');
} catch (error) {
    try {
        console.log(`evidence - stub saw: ${JSON.stringify(stub?.state.seen.map(({ method, path, kind, at }) => `${at} ${method} ${path} ${kind ?? ''}`))}`);
        console.log(`evidence - app log (ai):\n${logs().split('\n').filter((line) => /AI|ai|Core action|DEBUGAI/.test(line) && !/task command/.test(line)).slice(-40).map((line) => line.slice(0, 300)).join('\n')}`);
    } catch { /* the app is gone */ }
    evidenced(error);
    if (staleInjected) {
        try { await editDatabase('remove'); console.log('note - removed this run\'s stale tasks'); } catch (cleanupError) { console.error(`RESTORE FAILED: this run's stale tasks (${run}) stay: ${cleanupError.message}`); }
    }
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    cleanup();
    await sleep(500);
    process.exit(process.exitCode ?? 0);
}
