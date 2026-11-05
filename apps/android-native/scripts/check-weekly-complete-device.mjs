import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, button, check, connect, evidenced, fail, inboxCount, Stopped, tab, tabSelected, tagged, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-weekly-complete-device.mjs <adb-serial> [apk]');
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
const STAGED = '/data/local/tmp/mindwtr-native-dev-weekly-complete.db';
const DB = 'mindwtr-native-dev.db';
const work = resolve(app, 'android/build/weekly-complete-check');
const coreSrc = resolve(app, '../../packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));

const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const names = { busy: `77${run}1`, idle: `77${run}2`, open: `77${run}3`, done: `77${run}4` };

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { adbRaw, sh, home, front, requireAppFront, screen, waitFor, tap, tapExpecting } = device;
const runAs = (command) => sh(`run-as ${PKG} ${command}`);
const shoot = (name) => writeFileSync(resolve(work, `${name}.png`), adbRaw('exec-out', 'screencap', '-p'));

const pullDatabase = (name) => {
    const dir = resolve(work, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = runAs('ls files').split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    return resolve(dir, DB);
};

const core = (mode, db) => JSON.parse(execFileSync('bun', ['-e', `
    import { Database } from 'bun:sqlite';
    import { SqliteAdapter, createNativeHostContract, flushPendingSave, setStorageAdapter, useTaskStore } from '${coreSrc}/index.ts';
    const db = new Database(process.env.CHECK_DB);
    setStorageAdapter(new SqliteAdapter({
        run: async (sql, params = []) => { db.query(sql).run(...params); },
        all: async (sql, params = []) => db.query(sql).all(...params),
        get: async (sql, params = []) => db.query(sql).get(...params) ?? undefined,
        exec: async (sql) => { db.exec(sql); },
    }));
    const host = createNativeHostContract();
    if (!(await host.setLanguage({ storedLanguage: 'en', systemLocale: null })).ok) throw new Error('language');
    const ready = await host.activate({ writeSafetyReady: true });
    if (!ready.ok) throw new Error(ready.error.message);
    const value = (result) => { if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message); return result.value; };
    const names = JSON.parse(process.env.CHECK_NAMES);
    const store = () => useTaskStore.getState();
    const live = (items) => items.filter((item) => !item.deletedAt);
    const saved = async () => { await flushPendingSave(); if (store().persistenceFailure) throw new Error('save failed: ' + store().persistenceFailure.message); };
    let out;
    if (process.env.CHECK_MODE === 'inject') {
        const busy = await store().addProject(names.busy, '#94a3b8');
        const idle = await store().addProject(names.idle, '#94a3b8');
        if (!busy || !idle) throw new Error('addProject failed');
        for (const [title, projectId, status] of [[names.open, busy.id, 'next'], [names.done, idle.id, 'done']]) {
            const result = await store().addTask(title, { status, projectId });
            if (!result.success) throw new Error('addTask failed: ' + result.error);
        }
        await saved();
        out = { busy: busy.id, idle: idle.id };
    } else if (process.env.CHECK_MODE === 'remove') {
        const done = (result) => { if (!result.success) throw new Error('remove failed: ' + result.error); };
        const tasks = live(store()._allTasks).filter((task) => task.title === names.open || task.title === names.done).map((task) => task.id);
        if (tasks.length > 0) { done(await store().batchDeleteTasks(tasks)); done(await store().purgeTasks(tasks)); }
        const projects = live(store()._allProjects).filter((project) => project.title === names.busy || project.title === names.idle).map((project) => project.id);
        for (const id of projects) { done(await store().deleteProject(id)); done(await store().purgeProject(id)); }
        await saved();
        out = { tasks: tasks.length, projects: projects.length };
    } else {
        const status = (title) => live(store()._allProjects).find((project) => project.title === title)?.status ?? null;
        const weekly = value(host.getWeeklyReview({ checkpoint: JSON.stringify({ step: 'projects', startedAt: new Date().toISOString() }), offset: 0, limit: 100 }));
        const more = value(host.getMoreMenu());
        out = { busy: status(names.busy), idle: status(names.idle), projectsTitle: weekly.step.title, next: weekly.labels.next,
            quickAccess: more.quickAccessView, tiles: Object.fromEntries([...more.primary, ...more.utilities].map((item) => [item.id, item.label])) };
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    console.log(JSON.stringify(out));
`], { encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, CHECK_DB: db, CHECK_MODE: mode, CHECK_NAMES: JSON.stringify(names) } }).trim().split('\n').pop());

const putDatabase = (db) => {
    adbRaw('push', db, STAGED);
    try { runAs(`cp ${STAGED} files/${DB}`); } finally { sh(`rm -f ${STAGED}`); }
    runAs(`rm -f files/${DB}-wal files/${DB}-shm`);
};

const onInbox = (nodes) => !tagged(nodes, 'menu-screen') && tabSelected(nodes, en['tab.inbox']) && Number.isFinite(inboxCount(nodes));
const onReview = (nodes) => Boolean(tagged(nodes, 'review-list'));
const onWeekly = (nodes) => Boolean(tagged(nodes, 'weekly-review')) && Boolean(tagged(nodes, 'review-step-title')?.text);
const stepTitle = (nodes) => tagged(nodes, 'review-step-title')?.text;
const prompt = (nodes) => Boolean(tagged(nodes, 'review-complete-project-prompt'));
const inPrompt = (nodes, label) => {
    const card = tagged(nodes, 'review-complete-project-prompt');
    if (!card) return undefined;
    const [left, top, right, bottom] = box(card);
    const within = (node) => {
        const [x1, y1, x2, y2] = box(node);
        const [x, y] = [(x1 + x2) / 2, (y1 + y2) / 2];
        return x >= left && x <= right && y >= top && y <= bottom;
    };
    return nodes.find((node) => node['content-desc'] === label && within(node));
};

let injected = false;
const restore = async () => {
    if (!injected) return;
    try {
        const current = front();
        if (!current.includes(`${PKG}/`) && !current.includes(`${home}/`)) throw new Error(`another app is in front: ${current.trim()}`);
        await device.stopApp();
        const db = pullDatabase('remove');
        const removed = core('remove', db);
        putDatabase(db);
        injected = false;
        device.launch(ACTIVITY);
        await waitFor('the Inbox', onInbox, 60_000);
        console.log(`note - removed this run's fixtures: ${removed.tasks} tasks and ${removed.projects} projects deleted forever`);
    } catch (error) {
        console.error(`RESTORE FAILED: this run's fixtures (77${run}…) could not be removed (${error.message}); run check-projects-device.mjs --prune-old`);
        process.exitCode = 1;
    }
};

const openCard = async (title) => {
    const card = (nodes) => withDescription(nodes, title);
    const complete = (current) => tagged(current, `review-complete-project-${seen.ids[title]}`);
    const [x1, , , y2] = box(await device.revealNode(card, `the ${title} project card`));
    requireAppFront();
    sh(`input tap ${x1 + 60} ${y2 - 40}`);
    await sleep(1500);
    await device.revealNode(complete, `${title}'s Complete`, false);
    return waitFor(`${title} expanded`, (current) => Boolean(complete(current)), 15_000);
};
let seen = null;

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    device.launch(ACTIVITY);
    requireAppFront();
    await waitFor('the Inbox', onInbox, 60_000);
    await device.stopApp();
    const db = pullDatabase('inject');
    const ids = core('inject', db);
    injected = true;
    putDatabase(db);
    device.launch(ACTIVITY);
    await waitFor('the Inbox', onInbox, 60_000);
    seen = { ...core('read', pullDatabase('read')), ids: { [names.busy]: ids.busy, [names.idle]: ids.idle } };
    check(seen.busy === 'active' && seen.idle === 'active', `two active projects ${names.busy} (an open task) and ${names.idle} (done tasks only) are stored`);

    if (seen.quickAccess === 'review') await tapExpecting(tab(await screen(), en['tab.review']) ?? fail('no Review tab'), onReview, 'the Review tab');
    else {
        let nodes = await screen();
        if (!tagged(nodes, 'more-sheet')) nodes = await tapExpecting(tab(nodes, en['tab.menu']) ?? fail('no Menu tab'), (current) => Boolean(tagged(current, 'more-sheet')), 'the More sheet');
        nodes = await device.settle(nodes);
        await tapExpecting(withDescription(nodes, seen.tiles.review) ?? fail('no Review tile'), onReview, 'Review');
    }
    const choices = await tapExpecting(button(await screen(), en['review.startReview']) ?? fail('no Start Review'),
        (current) => Boolean(button(current, en['review.openGuide'])), 'the Start Review choices');
    let nodes = await tapExpecting(button(choices, en['review.openGuide']), onWeekly, 'the Weekly Review');
    for (let steps = 0; steps < 10 && stepTitle(nodes) !== seen.projectsTitle; steps += 1) {
        const shown = stepTitle(nodes);
        nodes = await tapExpecting(withDescription(nodes, seen.next) ?? fail('no Next'), (current) => onWeekly(current) && stepTitle(current) !== shown, 'the next step');
    }
    check(stepTitle(nodes) === seen.projectsTitle, `the Weekly Review reaches its "${seen.projectsTitle}" step`);

    nodes = await openCard(names.busy);
    shoot('busy-expanded');
    nodes = await tapExpecting(tagged(nodes, `review-complete-project-${ids.busy}`), prompt, 'the completion prompt');
    shoot('prompt');
    check(nodes.some((node) => node.text === en['projects.completeConfirm']) && nodes.some((node) => node.text === names.busy),
        `(a) Complete on ${names.busy}, which has an open task, asks first with RN's "${en['projects.completeConfirm']}" (RN d32f16947, #1395)`);
    nodes = await tapExpecting(inPrompt(nodes, en['common.cancel']) ?? fail('no Cancel in the prompt'), (current) => !prompt(current), 'the prompt to close');
    check(core('read', pullDatabase('cancelled')).busy === 'active', '(a) Cancel closes the prompt and leaves the project active');
    nodes = await tapExpecting(tagged(nodes, `review-complete-project-${ids.busy}`) ?? fail('no Complete'), prompt, 'the completion prompt again');
    await tap(inPrompt(nodes, en['projects.complete']) ?? fail('no Complete in the prompt'));
    nodes = await waitFor(`${names.busy} to leave the step`, (current) => !prompt(current) && !withDescription(current, names.busy), 20_000);
    check(core('read', pullDatabase('busy-done')).busy === 'archived' && stepTitle(nodes) === seen.projectsTitle,
        `(a) the prompt's Complete stores ${names.busy} as completed, and the review stays on "${seen.projectsTitle}"`);

    nodes = await openCard(names.idle);
    await tap(tagged(nodes, `review-complete-project-${ids.idle}`));
    nodes = await waitFor(`${names.idle} to leave the step`, (current) => !withDescription(current, names.idle), 20_000);
    check(!prompt(nodes) && core('read', pullDatabase('idle-done')).idle === 'archived' && stepTitle(nodes) === seen.projectsTitle,
        `(b) Complete on ${names.idle}, which has only done tasks, completes it without asking and stays on "${seen.projectsTitle}"`);
    shoot('after');
    sh('input keyevent KEYCODE_BACK');
    await sleep(1000);
    console.log('Weekly Review Complete device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
