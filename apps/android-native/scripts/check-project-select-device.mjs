import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, check, connect, evidenced, fail, isOn, projectTitled, Stopped, tab, tabSelected, tagged, taskRow, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-project-select-device.mjs <adb-serial> [apk]');
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
const STAGED = '/data/local/tmp/mindwtr-native-dev-project-select.db';
const DB = 'mindwtr-native-dev.db';
const NAMES = { project: 'PS1415Project', tasks: ['PS1415Alpha', 'PS1415Beta', 'PS1415Gamma'] };
const work = resolve(app, 'android/build/project-select-check');
const shots = resolve(process.env.MINDWTR_HARNESS_DIR ?? work, 'project-select');
const coreSrc = resolve(app, '../../packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { adbRaw, sh, home, front, requireAppFront, screen, waitFor, tap, tapExpecting, focusAtEnd } = device;
const runAs = (command) => sh(`run-as ${PKG} ${command}`);

const pullDatabase = (name) => {
    const dir = resolve(work, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = runAs('ls files').split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    return resolve(dir, DB);
};


const core = (mode, db = pullDatabase(mode)) => JSON.parse(execFileSync('bun', ['-e', `
    import { Database } from 'bun:sqlite';
    import { AREA_FILTER_NONE, SqliteAdapter, createNativeHostContract, flushPendingSave, resolveAreaFilterSelection, setStorageAdapter, useTaskStore } from '${coreSrc}/index.ts';
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
    const project = () => store()._allProjects.find((entry) => !entry.deletedAt && entry.title === names.project);
    const task = (title) => store()._allTasks.find((entry) => !entry.deletedAt && entry.title === title && entry.projectId === project()?.id);
    if (process.env.CHECK_MODE === 'inject') {
        if (!project()) await store().addProject(names.project, '#94a3b8');
        await store().updateProject(project().id, { status: 'active', areaId: undefined });
        for (const title of names.tasks) {
            if (!task(title)) await store().addTask(title, { projectId: project().id, status: 'next' });
            if (task(title).status !== 'next' || task(title).tags?.length) await store().updateTask(task(title).id, { status: 'next', tags: [] });
        }
        const filtered = await host.setAreaFilter({ included: [], excluded: [] });
        if (!filtered.ok) throw new Error(filtered.error.message);
        if (store().settings.appearance?.mobileQuickAccessView !== 'projects') await store().updateSettings({ appearance: { ...store().settings.appearance, mobileQuickAccessView: 'projects' } });
        await flushPendingSave();
        if (store().persistenceFailure) throw new Error('save failed: ' + store().persistenceFailure.message);
    }
    if (process.env.CHECK_MODE === 'cleanup') {
        for (const title of names.tasks) if (task(title)) await store().deleteTask(task(title).id);
        if (project()) await store().deleteProject(project().id);
        const kept = JSON.parse(process.env.CHECK_KEPT);
        if ((store().settings.appearance?.mobileQuickAccessView ?? null) !== kept.quickView)
            await store().updateSettings({ appearance: { ...store().settings.appearance, mobileQuickAccessView: kept.quickView ?? undefined } });
        const live = new Set([AREA_FILTER_NONE, ...store()._allAreas.filter((entry) => !entry.deletedAt).map((entry) => entry.id)]);
        const restored = await host.setAreaFilter({ included: kept.areaFilter.included.filter((id) => live.has(id)), excluded: kept.areaFilter.excluded.filter((id) => live.has(id)) });
        if (!restored.ok) throw new Error(restored.error.message);
        await flushPendingSave();
        if (store().persistenceFailure) throw new Error('save failed: ' + store().persistenceFailure.message);
    }
    const out = {
        quickView: store().settings.appearance?.mobileQuickAccessView ?? null,
        areaFilter: resolveAreaFilterSelection(store().settings.filters, store()._allAreas),
        project: project() ? { id: project().id, status: project().status } : null,
        tasks: names.tasks.map((title) => task(title)).filter(Boolean).map((entry) => ({ title: entry.title, id: entry.id, status: entry.status, rev: entry.rev ?? 0, tags: entry.tags ?? [] })),
    };
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    console.log(JSON.stringify(out));
    process.exit(0);
`], { encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, CHECK_DB: db, CHECK_MODE: mode, CHECK_NAMES: JSON.stringify(NAMES), CHECK_KEPT: JSON.stringify(kept ?? { quickView: null, areaFilter: { included: [], excluded: [] } }) } })
    .trim().split('\n').pop());

const [ALPHA, BETA, GAMMA] = NAMES.tasks;
const stored = (seen, title) => seen.tasks.find((entry) => entry.title === title);
const canonical = (seen) => seen.quickView === 'projects' && seen.project?.status === 'active' && seen.tasks.length === 3
    && seen.tasks.every((entry) => entry.status === 'next' && entry.tags.length === 0);

const onInbox = (nodes) => !tagged(nodes, 'menu-screen') && tabSelected(nodes, en['tab.inbox']);
const textNode = (nodes, text) => nodes.find((node) => node.text === text && node.class !== 'android.widget.EditText');
const shot = (name) => {
    mkdirSync(shots, { recursive: true });
    const file = resolve(shots, `${name}.png`);
    writeFileSync(file, adbRaw('exec-out', 'screencap', '-p'));
    console.log(`screenshot ${file}`);
};
const back = async () => { requireAppFront(); sh('input keyevent KEYCODE_BACK'); await sleep(800); };
const longPress = (node) => {
    requireAppFront();
    const [x1, y1, x2, y2] = box(node);
    const [x, y] = [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)];
    sh(`input swipe ${x} ${y} ${x} ${y} 900`);
};
const inProject = (nodes) => projectTitled(nodes, NAMES.project);
const countLabel = (count) => `${count} ${en['bulk.selected']}`;
const selectionShown = (nodes) => nodes.some((node) => new RegExp(`^\\d+ ${en['bulk.selected']}$`).test(node.text ?? ''));
const selecting = (nodes, count) => Boolean(textNode(nodes, countLabel(count))) && Boolean(withDescription(nodes, en['bulk.exitSelect']));
const moveLabel = (status) => `${en['bulk.moveTo']} ${en[`status.${status}`]}`;

const rewrite = async (mode) => {
    await device.stopApp();
    const db = pullDatabase(mode);
    core(mode, db);
    adbRaw('push', db, STAGED);
    try { runAs(`cp ${STAGED} files/${DB}`); } finally { sh(`rm -f ${STAGED}`); }
    runAs(`rm -f files/${DB}-wal files/${DB}-shm`);
    device.launch(ACTIVITY);
    await waitFor('the Inbox', onInbox, 60_000);
};
let fixtureAdded = false;
let kept = null;

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const originalNight = sh('cmd uimode night').replace(/^Night mode: /, '').trim();
const restore = async () => {
    try { if (originalNight && originalNight !== 'unknown') sh(`cmd uimode night ${originalNight}`); } catch {}
    try {
        for (let step = 0; step < 5 && front().includes(`${PKG}/`); step += 1) {
            const nodes = await screen();
            if (onInbox(nodes)) break;
            sh('input keyevent KEYCODE_BACK');
            await sleep(800);
        }
        const nodes = await screen();
        if (front().includes(`${PKG}/`) && tab(nodes, en['tab.inbox']) && !tabSelected(nodes, en['tab.inbox'])) await tap(tab(nodes, en['tab.inbox']));
    } catch {}
    for (const [name, value] of [['user_rotation', originalRotation], ['accelerometer_rotation', originalAccelerometer]]) {
        try { sh(value === 'null' ? `settings delete system ${name}` : `settings put system ${name} ${value}`); } catch {}
    }
    try {
        if (fixtureAdded) {
            await rewrite('cleanup');
            const left = core('view');
            if (left.project || left.tasks.length || left.quickView !== kept.quickView || JSON.stringify(left.areaFilter) !== JSON.stringify(kept.areaFilter))
                console.error(`RESTORE: the fixture or the settings it changed are still stored: ${JSON.stringify(left)}`);
        }
    } catch (error) { console.error(`RESTORE FAILED: the fixture project and tasks were not removed (${error.message})`); process.exitCode = 1; }
    try { sh(`rm -f ${UI_FILE} ${STAGED}`); } catch {}
};

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    sh('cmd uimode night no');
    device.launch(ACTIVITY);
    requireAppFront();
    sh('settings put system accelerometer_rotation 0');
    sh('settings put system user_rotation 0');
    await waitFor('the Inbox', onInbox, 60_000);
    let seen = core('view');
    kept = { quickView: seen.quickView, areaFilter: seen.areaFilter };
    console.log(`info - kept the quick-access view ${kept.quickView} and the area filter ${JSON.stringify(kept.areaFilter)} to put back`);
    fixtureAdded = true;
    if (!canonical(seen)) {
        await rewrite('inject');
        seen = core('view');
        console.log(`info - injected ${NAMES.project} with ${NAMES.tasks.join(', ')} in Next`);
    }
    check(canonical(seen), `core stores ${NAMES.project} with ${NAMES.tasks.join(', ')} in Next, untagged`);

    const openProject = async () => {
        let nodes = await tapExpecting(tab(await screen(), en['projects.title']) ?? fail('no Projects tab'), (current) => tabSelected(current, en['projects.title']), 'the Projects tab');
        nodes = await device.reveal(NAMES.project, 60);
        nodes = await device.settle(nodes);
        return tapExpecting(textNode(nodes, NAMES.project) ?? fail(`no project row ${NAMES.project}`), inProject, `the project ${NAMES.project}`);
    };
    const rowOf = async (title) => {
        const nodes = await device.reveal(title, 30);
        return taskRow(nodes, title) ?? textNode(nodes, title) ?? fail(`no task row ${title}`);
    };

    let nodes = await openProject();
    check(!selectionShown(nodes), 'the project opens without a selection bar');
    longPress(await rowOf(ALPHA));
    nodes = await waitFor('the selection bar for one task', (current) => selecting(current, 1), 15_000);
    check(isOn(taskRow(nodes, ALPHA)), `a long press on ${ALPHA} enters selection with it picked ("${countLabel(1)}")`);
    check(Boolean(withDescription(nodes, moveLabel('waiting'))) && Boolean(withDescription(nodes, en['bulk.organize']))
        && Boolean(withDescription(nodes, en['projects.reorderTasks'])) && !withDescription(nodes, `${en['bulk.select']} ${en['common.all']}`),
        `the bar offers ${moveLabel('waiting')}, ${en['bulk.organize']} and ${en['projects.reorderTasks']}, as RN's project bar does, and no Select all`);
    await tap(await rowOf(BETA));
    nodes = await waitFor('two tasks selected', (current) => selecting(current, 2), 15_000);
    check(isOn(taskRow(nodes, BETA)) && !isOn(taskRow(nodes, GAMMA)), `a tap adds ${BETA}; ${GAMMA} stays unpicked`);
    shot('project-selection-light');

    const before = Object.fromEntries(seen.tasks.map((entry) => [entry.title, entry.rev]));
    nodes = await tapExpecting(withDescription(nodes, moveLabel('waiting')), (current) => !selectionShown(current), 'the move landed and selection ended');
    await waitFor(`${ALPHA} and ${BETA} stored in Waiting`, () => {
        seen = core('view');
        return stored(seen, ALPHA).status === 'waiting' && stored(seen, BETA).status === 'waiting';
    }, 20_000);
    check(stored(seen, ALPHA).rev === before[ALPHA] + 1 && stored(seen, BETA).rev === before[BETA] + 1 && stored(seen, GAMMA).status === 'next' && stored(seen, GAMMA).rev === before[GAMMA],
        `${moveLabel('waiting')} writes ${ALPHA} and ${BETA} once each (rev +1) and leaves ${GAMMA}; selection ends`);
    check(inProject(await screen()), 'the project stays open after the move');

    longPress(await rowOf(GAMMA));
    nodes = await waitFor('the selection bar again', (current) => selecting(current, 1), 15_000);
    await back();
    nodes = await waitFor('selection left', (current) => !selectionShown(current), 10_000);
    check(inProject(nodes), 'Back leaves selection first and keeps the project open (#1415)');

    longPress(await rowOf(GAMMA));
    nodes = await waitFor('the selection bar for Reorder', (current) => selecting(current, 1), 15_000);
    nodes = await tapExpecting(withDescription(nodes, en['projects.reorderTasks']) ?? fail(`no ${en['projects.reorderTasks']} in the selection bar`),
        (current) => Boolean(tagged(current, 'project-reorder-list')) && Boolean(tagged(current, 'project-task-reorder-row')) && !selectionShown(current), 'project task Reorder');
    check(true, `${en['projects.reorderTasks']} in the selection bar opens project task Reorder and ends selection (#1477)`);
    shot('project-reorder-from-selection-light');
    nodes = await tapExpecting(tagged(nodes, 'project-task-reorder-toggle'), (current) => !tagged(current, 'project-reorder-list') && inProject(current), 'Reorder left with Done');
    check(true, 'Done leaves Reorder and keeps the project open');
    await back();
    nodes = await waitFor('the Projects list', (current) => !inProject(current) && Boolean(tagged(current, 'projects-manage-areas')), 10_000);
    check(true, 'a further Back leaves the project');

    sh('cmd uimode night yes');
    await sleep(2500);
    nodes = await device.settle(await device.reveal(NAMES.project, 60));
    nodes = await tapExpecting(textNode(nodes, NAMES.project) ?? fail(`no project row ${NAMES.project} in dark mode`), inProject, 'the project in dark mode');
    longPress(await rowOf(GAMMA));
    await waitFor('the selection bar in dark mode', (current) => selecting(current, 1), 15_000);
    shot('project-selection-dark');
    await back();
    console.log('Project selection device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
