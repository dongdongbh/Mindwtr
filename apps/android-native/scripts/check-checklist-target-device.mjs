import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, button, check, connect, evidenced, fail, inboxCount, Stopped, tab, tabSelected, tagged, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-checklist-target-device.mjs <adb-serial> [apk]');
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
const STAGED = '/data/local/tmp/mindwtr-native-dev-checklist-target.db';
const DB = 'mindwtr-native-dev.db';
const work = resolve(app, 'android/build/checklist-target-check');
const shots = process.env.MINDWTR_SHOTS ?? work;
const coreSrc = resolve(app, '../../packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));

const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const names = { area: `75${run}0`, source: `75${run}1`, noted: `75${run}2`, target: `75${run}3`, editing: `75${run}4`, first: `75${run}5`, second: `75${run}6`, later: `75${run}7` };

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { adbRaw, sh, home, front, requireAppFront, screen, waitFor, tap, tapExpecting } = device;
const runAs = (command) => sh(`run-as ${PKG} ${command}`);
const shoot = (name) => { writeFileSync(resolve(shots, `${name}.png`), adbRaw('exec-out', 'screencap', '-p')); console.log(`shot - ${name}.png`); };

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
    import { SqliteAdapter, createNativeHostContract, flushPendingSave, setStorageAdapter, sortProjectsForPicker, useTaskStore } from '${coreSrc}/index.ts';
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
    const names = JSON.parse(process.env.CHECK_NAMES);
    const store = () => useTaskStore.getState();
    const live = (items) => items.filter((item) => !item.deletedAt);
    const mine = (title) => Object.values(names).includes(title);
    const saved = async () => { await flushPendingSave(); if (store().persistenceFailure) throw new Error('save failed: ' + store().persistenceFailure.message); };
    let out;
    if (process.env.CHECK_MODE === 'inject') {
        const area = await store().addArea(names.area, { color: '#94a3b8' });
        if (!area) throw new Error('addArea failed');
        const first = await store().addProject(names.first, '#94a3b8', { areaId: area.id, order: 5 });
        const second = await store().addProject(names.second, '#94a3b8', { areaId: area.id, order: 1 });
        const later = await store().addProject(names.later, '#94a3b8', { areaId: area.id, order: 0, status: 'someday' });
        if (!first || !second || !later) throw new Error('addProject failed');
        for (const [title, fields] of [
            [names.source, { status: 'inbox' }],
            [names.noted, { status: 'inbox', description: 'a note' }],
            [names.target, { status: 'next', checklist: [{ id: 'milk' + names.target, title: 'Milk', isCompleted: false }] }],
            [names.editing, { status: 'inbox', areaId: area.id }],
        ]) {
            const result = await store().addTask(title, fields);
            if (!result.success) throw new Error('addTask failed: ' + result.error);
        }
        await saved();
        out = { area: area.id };
    } else if (process.env.CHECK_MODE === 'remove') {
        const done = (result) => { if (!result.success) throw new Error('remove failed: ' + result.error); };
        const tasks = store()._allTasks.filter((task) => mine(task.title) && !task.purgedAt).map((task) => task.id);
        if (tasks.length > 0) { done(await store().batchDeleteTasks(tasks.filter((id) => !store()._tasksById.get(id)?.deletedAt))); done(await store().purgeTasks(tasks)); }
        const projects = live(store()._allProjects).filter((project) => mine(project.title)).map((project) => project.id);
        for (const id of projects) { done(await store().deleteProject(id)); done(await store().purgeProject(id)); }
        const areas = live(store()._allAreas).filter((area) => mine(area.name)).map((area) => area.id);
        for (const id of areas) done(await store().deleteArea(id));
        await saved();
        out = { tasks: tasks.length, projects: projects.length, areas: areas.length };
    } else {
        const row = (title) => {
            const task = store()._allTasks.find((entry) => entry.title === title);
            return task ? { status: task.status, rev: task.rev ?? 0, deleted: Boolean(task.deletedAt), checklist: (task.checklist ?? []).map((entry) => entry.title) } : null;
        };
        const ours = live(store()._allProjects).filter((project) => mine(project.title));
        out = { source: row(names.source), noted: row(names.noted), target: row(names.target),
            pickerOrder: sortProjectsForPicker(ours, store().areas).map((project) => project.title) };
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
const read = (name) => core('read', pullDatabase(name));
const readUntil = async (name, done, ms = 20_000) => {
    let seen = read(name);
    for (const deadline = Date.now() + ms; !done(seen) && Date.now() < deadline; await sleep(800)) seen = read(name);
    return seen;
};

const onInbox = (nodes) => !tagged(nodes, 'menu-screen') && tabSelected(nodes, en['tab.inbox']) && Number.isFinite(inboxCount(nodes));
const titleNode = (nodes, title) => nodes.find((node) => node.text === title && (node['resource-id'] ?? '').endsWith('task-row'));
const originalNight = /Night mode: (\w+)/.exec(sh('cmd uimode night'))?.[1] ?? 'auto';

let injected = false;
const restore = async () => {
    try { sh(`cmd uimode night ${['yes', 'no', 'auto'].includes(originalNight) ? originalNight : 'auto'}`); } catch (error) { console.error(`restore night mode: ${error.message}`); }
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
        console.log(`note - removed this run's fixtures: ${removed.tasks} tasks, ${removed.projects} projects and ${removed.areas} areas deleted`);
    } catch (error) {
        console.error(`RESTORE FAILED: this run's fixtures (75${run}…) could not be removed (${error.message}); run check-projects-device.mjs --prune-old`);
        process.exitCode = 1;
    }
};

const toTabs = async () => {
    for (let step = 0; step < 6; step += 1) {
        const nodes = await screen();
        if (!tagged(nodes, 'menu-screen') && !tagged(nodes, 'more-sheet') && tab(nodes, en['tab.inbox']) && !tagged(nodes, 'project-title-input')) return nodes;
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(800);
    }
    return screen();
};

const statusLabel = en['task.aria.changeStatus'].replace('{{status}}', en['status.inbox']);
const statusControl = (nodes, title) => {
    const row = titleNode(nodes, title) ?? fail(`no row ${title}`);
    const [, top, , bottom] = box(row);
    return nodes.find((node) => node['content-desc'] === statusLabel && box(node)[1] < bottom && box(node)[3] > top);
};
const openStatusMenu = async (title) => {
    await toTabs();
    let nodes = await screen();
    if (!tabSelected(nodes, en['tab.inbox'])) nodes = await tapExpecting(tab(nodes, en['tab.inbox']) ?? fail('no Inbox tab'), onInbox, 'the Inbox');
    await device.revealNode((current) => titleNode(current, title), `the row ${title}`);
    return tapExpecting(statusControl(await screen(), title) ?? fail(`no status control on ${title}`), (current) => Boolean(withDescription(current, en['task.copyTaskId'])), `${title}'s status menu`);
};
const closeMenu = async () => {
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await waitFor('the menu to close', (current) => !withDescription(current, en['task.copyTaskId']), 10_000);
};

try {
    mkdirSync(work, { recursive: true });
    mkdirSync(shots, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    sh('cmd uimode night no');
    device.launch(ACTIVITY);
    requireAppFront();
    await waitFor('the Inbox', onInbox, 60_000);
    await device.stopApp();
    core('inject', pullDatabase('inject'));
    injected = true;
    putDatabase(resolve(work, 'inject', DB));
    device.launch(ACTIVITY);
    await waitFor('the Inbox', onInbox, 60_000);
    let seen = read('seeded');
    check(seen.source?.status === 'inbox' && seen.target?.checklist.join() === 'Milk', `a title-only Inbox item ${names.source} and a Next target ${names.target} with one item are stored`);

    let nodes = await openStatusMenu(names.noted);
    check(!withDescription(nodes, en['task.addToChecklist']), `(a) ${names.noted}, which has a note, offers no Add to checklist…, as RN's canMoveTaskToChecklist says`);
    await closeMenu();
    nodes = await openStatusMenu(names.source);
    nodes = await waitFor('Add to checklist…', (current) => Boolean(withDescription(current, en['task.addToChecklist'])), 10_000);
    check(true, `(a) the title-only ${names.source} offers RN's "${en['task.addToChecklist']}" under Destination`);
    shoot('status-menu-add-to-checklist');
    nodes = await tapExpecting(withDescription(nodes, en['task.addToChecklist']), (current) => Boolean(tagged(current, 'checklist-target-search')), 'the checklist target picker');
    await tap(tagged(nodes, 'checklist-target-search'));
    requireAppFront();
    sh(`input text '${names.target}'`);
    const targetRow = (current) => current.some((node) => (node['resource-id'] ?? '').endsWith('checklist-target'))
        ? current.find((node) => node['content-desc'] === names.target) : undefined;
    nodes = await waitFor('the target in the picker', (current) => Boolean(targetRow(current)), 15_000);
    check(nodes.some((node) => node.text === '0/1'), `(b) the picker shows ${names.target} with its 0/1 progress, as RN's picker does`);
    shoot('checklist-target-picker');
    const before = seen;
    await tap(targetRow(nodes));
    nodes = await waitFor('RN\'s Added to checklist toast', (current) => current.some((node) => node.text === en['task.addedToChecklist']), 15_000);
    seen = await readUntil('moved', (current) => current.target?.checklist.length === 2 && current.source?.deleted);
    check(JSON.stringify(seen.target.checklist) === JSON.stringify(['Milk', names.source]) && seen.source.deleted
        && seen.target.rev === before.target.rev + 1 && seen.source.rev === before.source.rev + 1,
        `(b) the title went into ${names.target}'s checklist and ${names.source} moved to Trash, each once (stored ${JSON.stringify({ source: seen.source, target: seen.target })})`);
    shoot('added-to-checklist-toast');
    await tap(nodes.find((node) => node.text === en['common.undo']) ?? fail('no Undo'));
    seen = await readUntil('undone', (current) => current.target?.checklist.length === 1 && current.source && !current.source.deleted);
    check(JSON.stringify(seen.target.checklist) === JSON.stringify(['Milk']) && !seen.source.deleted && seen.source.status === 'inbox',
        `(c) Undo put ${names.source} back in the Inbox and took only its item out of ${names.target}`);

    await toTabs();
    nodes = await screen();
    if (!tabSelected(nodes, en['tab.inbox'])) nodes = await tapExpecting(tab(nodes, en['tab.inbox']), onInbox, 'the Inbox');
    await device.revealNode((current) => titleNode(current, names.editing), `the row ${names.editing}`);
    const editorOpen = (current) => current.some((node) => (node['content-desc'] ?? '').startsWith(`${en['task.destination']}: `));
    nodes = await tapExpecting(titleNode(await screen(), names.editing), editorOpen, `${names.editing}'s editor`);
    const destination = nodes.find((node) => (node['content-desc'] ?? '').startsWith(`${en['task.destination']}: `));
    nodes = await tapExpecting(destination, (current) => seen.pickerOrder.every((title) => current.some((node) => node.text === title)), 'the Destination picker with this run\'s projects');
    const listed = nodes.filter((node) => node.text && ([names.first, names.second, names.later].includes(node.text) || node.text === en['projects.deferredSection']))
        .sort((a, z) => box(a)[1] - box(z)[1]).map((node) => node.text);
    shoot('editor-destination-order');
    check(JSON.stringify(listed) === JSON.stringify([seen.pickerOrder[0], seen.pickerOrder[1], en['projects.deferredSection'], seen.pickerOrder[2]]),
        `(d) the editor's Destination lists ${names.area}'s projects in the Projects view order, with Someday / Waiting after them (${JSON.stringify(listed)}; core's order ${JSON.stringify(seen.pickerOrder)})`);
    await tapExpecting(button(await screen(), en['common.cancel']) ?? fail('no Cancel'), (current) => !current.some((node) => node.text === seen.pickerOrder[0]), 'the picker to close');
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await sleep(800);
    console.log('Checklist target device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
