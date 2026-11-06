import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, check, connect, evidenced, fail, inboxCount, Stopped, tab, tabSelected, tagged, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-row-checklist-device.mjs <adb-serial> [apk]');
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
const STAGED = '/data/local/tmp/mindwtr-native-dev-row-checklist.db';
const DB = 'mindwtr-native-dev.db';
const work = resolve(app, 'android/build/row-checklist-check');
const shots = process.env.MINDWTR_SHOTS ?? work;
const coreSrc = resolve(app, '../../packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));

const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const names = { project: `76${run}1`, next: `76${run}2`, reference: `76${run}3`, added: `76${run}4` };

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
    const names = JSON.parse(process.env.CHECK_NAMES);
    const store = () => useTaskStore.getState();
    const live = (items) => items.filter((item) => !item.deletedAt);
    const saved = async () => { await flushPendingSave(); if (store().persistenceFailure) throw new Error('save failed: ' + store().persistenceFailure.message); };
    const item = (id, title) => ({ id, title, isCompleted: false });
    let out;
    if (process.env.CHECK_MODE === 'inject') {
        const project = await store().addProject(names.project, '#94a3b8');
        if (!project) throw new Error('addProject failed');
        for (const [title, fields] of [
            [names.next, { status: 'next', projectId: project.id, checklist: [item('a' + names.next, 'Bread'), item('b' + names.next, 'Milk')] }],
            [names.reference, { status: 'reference', taskMode: 'list', checklist: [item('a' + names.reference, 'Passport'), item('b' + names.reference, 'Tickets')] }],
        ]) {
            const result = await store().addTask(title, fields);
            if (!result.success) throw new Error('addTask failed: ' + result.error);
        }
        await saved();
        out = { project: project.id };
    } else if (process.env.CHECK_MODE === 'remove') {
        const done = (result) => { if (!result.success) throw new Error('remove failed: ' + result.error); };
        const tasks = live(store()._allTasks).filter((task) => task.title === names.next || task.title === names.reference).map((task) => task.id);
        if (tasks.length > 0) { done(await store().batchDeleteTasks(tasks)); done(await store().purgeTasks(tasks)); }
        const projects = live(store()._allProjects).filter((project) => project.title === names.project).map((project) => project.id);
        for (const id of projects) { done(await store().deleteProject(id)); done(await store().purgeProject(id)); }
        await saved();
        out = { tasks: tasks.length, projects: projects.length };
    } else {
        const row = (title) => {
            const task = live(store()._allTasks).find((entry) => entry.title === title);
            return task ? { status: task.status, rev: task.rev ?? 0, focused: task.isFocusedToday === true, completedAt: task.completedAt ?? null,
                checklist: (task.checklist ?? []).map((entry) => [entry.title, entry.isCompleted === true]) } : null;
        };
        const more = (await host.getMoreMenu()).value;
        out = { next: row(names.next), reference: row(names.reference), quickAccess: more.quickAccessView,
            tiles: Object.fromEntries([...more.primary, ...more.utilities].map((entry) => [entry.id, entry.label])) };
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
const below = (nodes, title, tag) => {
    const top = box(titleNode(nodes, title) ?? fail(`no row ${title}`))[1];
    return nodes.filter((node) => (node['resource-id'] ?? '').endsWith(tag) && box(node)[1] > top).sort((a, z) => box(a)[1] - box(z)[1])[0];
};
const items = (nodes) => nodes.filter((node) => (node['resource-id'] ?? '').endsWith('row-checklist-item'));
const itemNode = (nodes, title) => items(nodes).find((node) => node['content-desc'] === title);
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
        console.log(`note - removed this run's fixtures: ${removed.tasks} tasks and ${removed.projects} projects deleted forever`);
    } catch (error) {
        console.error(`RESTORE FAILED: this run's fixtures (76${run}…) could not be removed (${error.message}); run check-projects-device.mjs --prune-old`);
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
const openMenuList = async (tile) => {
    let nodes = await toTabs();
    nodes = await tapExpecting(tab(nodes, en['tab.menu']) ?? fail('no Menu tab'), (current) => Boolean(tagged(current, 'more-sheet')), 'the More sheet');
    nodes = await device.settle(nodes);
    return tapExpecting(withDescription(nodes, tile) ?? fail(`no ${tile} tile`), (current) => Boolean(tagged(current, 'menu-screen')), tile);
};
const expand = async (title) => {
    await device.revealNode((current) => titleNode(current, title), `the row ${title}`);
    const nodes = await screen();
    return tapExpecting(below(nodes, title, 'row-checklist-toggle') ?? fail(`no checklist badge under ${title}`), (current) => items(current).length > 0, `${title}'s checklist`);
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
    const ids = core('inject', pullDatabase('inject'));
    injected = true;
    putDatabase(resolve(work, 'inject', DB));
    device.launch(ACTIVITY);
    await waitFor('the Inbox', onInbox, 60_000);
    let seen = read('seeded');
    check(seen.next?.checklist.length === 2 && seen.reference?.status === 'reference', `a Next task ${names.next} and a Reference list ${names.reference} with two items each are stored`);

    let nodes = await toTabs();
    if (seen.quickAccess === 'projects') nodes = await tapExpecting(tab(nodes, en['nav.projects']) ?? fail('no Projects tab'), (current) => tabSelected(current, en['nav.projects']), 'the Projects tab');
    else nodes = await openMenuList(seen.tiles.projects);
    const projectRow = (current) => current.find((node) => (node['resource-id'] ?? '').endsWith(`project-row-open-${ids.project}`));
    nodes = await tapExpecting(await device.revealNode(projectRow, `the project ${names.project}`), (current) => Boolean(titleNode(current, names.next)), `the project ${names.project}`);
    check(items(nodes).length === 0, `(a) ${names.next}'s checklist starts folded, with only RN's progress badge`);
    nodes = await expand(names.next);
    check(Boolean(itemNode(nodes, 'Bread')) && Boolean(itemNode(nodes, 'Milk')) && itemNode(nodes, 'Bread').checked === 'false',
        '(a) the badge opens the row\'s list: Bread and Milk, unticked, with RN\'s + Add Item');
    shoot('row-checklist-light');

    const before = seen.next.rev;
    await tap(itemNode(nodes, 'Bread'));
    seen = await readUntil('ticked', (current) => current.next?.checklist[0]?.[1] === true);
    check(JSON.stringify(seen.next.checklist) === JSON.stringify([['Bread', true], ['Milk', false]]) && seen.next.rev === before + 1 && seen.next.status === 'next',
        `(b) a tick stores Bread done by its id in one write, and the task stays Next (stored ${JSON.stringify(seen.next)})`);
    nodes = await waitFor('Bread shown ticked', (current) => itemNode(current, 'Bread')?.checked === 'true', 10_000);
    check(true, '(b) the row shows Bread ticked');

    const add = below(nodes, names.next, 'row-checklist-add') ?? fail('no Add Item field');
    await tap(add);
    requireAppFront();
    sh(`input text '${names.added}'`);
    await waitFor('the typed item', (current) => below(current, names.next, 'row-checklist-add')?.text === names.added, 10_000);
    sh('input keyevent KEYCODE_ENTER');
    seen = await readUntil('added', (current) => current.next?.checklist.length === 3);
    check(JSON.stringify(seen.next.checklist[2]) === JSON.stringify([names.added, false]) && seen.next.rev === before + 2,
        `(c) + Add Item appends ${names.added} to the stored checklist in one write`);
    sh('input keyevent KEYCODE_BACK');
    await sleep(600);

    sh('cmd uimode night yes');
    await sleep(3000);
    nodes = await waitFor('the project in dark mode', (current) => items(current).length > 0, 20_000);
    shoot('row-checklist-dark');
    sh('cmd uimode night no');
    await sleep(3000);

    nodes = await openMenuList(seen.tiles.reference);
    await device.revealNode((current) => titleNode(current, names.reference), `the row ${names.reference}`);
    nodes = await screen();
    const nextRow = nodes.filter((node) => (node['resource-id'] ?? '').endsWith('task-row') && box(node)[1] > box(titleNode(nodes, names.reference))[1])
        .sort((a, z) => box(a)[1] - box(z)[1])[0];
    const badge = below(nodes, names.reference, 'row-checklist-toggle');
    check(!badge || (nextRow && box(badge)[1] > box(nextRow)[1]), `(d) the Reference row ${names.reference} shows no inline checklist, as RN's row hides it (swipeable-task-item.tsx showChecklist={!isReference && …})`);
    const refBefore = seen.reference.rev;
    const viewItem = (current, title) => current.find((node) => node['content-desc'] === title && node.checkable === 'true');
    nodes = await tapExpecting(titleNode(nodes, names.reference), (current) => Boolean(viewItem(current, 'Passport')), `${names.reference}'s view`);
    await tap(viewItem(nodes, 'Passport'));
    nodes = await waitFor('Passport ticked in the view', (current) => viewItem(current, 'Passport')?.checked === 'true', 10_000);
    await tap(viewItem(nodes, 'Tickets'));
    await waitFor('Tickets ticked in the view', (current) => viewItem(current, 'Tickets')?.checked === 'true', 10_000);
    shoot('reference-view-ticked');
    const save = (current) => current.find((node) => node.text === en['common.save'] && node.clickable !== 'false') ?? current.find((node) => node.text === en['common.save']);
    await tapExpecting(save(await screen()) ?? fail('no Save'), (current) => !viewItem(current, 'Passport'), 'the editor to save and close');
    seen = await readUntil('reference ticked', (current) => current.reference?.checklist.every(([, done]) => done));
    check(seen.reference.status === 'reference' && seen.reference.completedAt === null && !seen.reference.focused
        && seen.reference.checklist.every(([, done]) => done) && seen.reference.rev > refBefore,
        `(d) both Reference items tick in its view, while the reference never completes or enters Focus (bc518c30e) (stored ${JSON.stringify(seen.reference)})`);
    nodes = await waitFor('the Reference list again', (current) => Boolean(titleNode(current, names.reference)), 15_000);
    check(true, `(d) ${names.reference} stays in the Reference list`);
    console.log('Row checklist device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
