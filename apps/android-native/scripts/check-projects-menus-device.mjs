import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, check, connect, evidenced, fail, Stopped, tab, tabSelected, tagged, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-projects-menus-device.mjs <adb-serial> [apk]');
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
const STAGED = '/data/local/tmp/mindwtr-native-dev-projects-menus.db';
const DB = 'mindwtr-native-dev.db';
const NAMES = { work: 'PM1489Work', home: 'PM1489Home', office: 'PM1489Office', one: 'PM1489One', two: 'PM1489Two' };
const work = resolve(app, 'android/build/projects-menus-check');
const shots = resolve(process.env.MINDWTR_HARNESS_DIR ?? work, 'projects-menus');
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
    const area = (name) => store()._allAreas.find((entry) => !entry.deletedAt && entry.name.toLowerCase() === name.toLowerCase());
    const project = (title) => store()._allProjects.find((entry) => !entry.deletedAt && entry.title === title);
    if (process.env.CHECK_MODE === 'inject') {
        const renamed = area(names.office);
        if (renamed && !area(names.work)) await store().updateArea(renamed.id, { name: names.work });
        if (!area(names.work)) await store().addArea(names.work, { color: '#3b82f6' });
        if (!area(names.home)) await store().addArea(names.home, { color: '#10b981' });
        for (const [index, title] of [names.one, names.two].entries()) {
            if (!project(title)) await store().addProject(title, '#94a3b8');
            await store().updateProject(project(title).id, { areaId: area(names.work).id, status: 'active', order: index });
        }
        const filtered = await host.setAreaFilter({ included: [], excluded: [] });
        if (!filtered.ok) throw new Error(filtered.error.message);
        if (store().settings.appearance?.mobileQuickAccessView !== 'projects') await store().updateSettings({ appearance: { mobileQuickAccessView: 'projects' } });
        await flushPendingSave();
        if (store().persistenceFailure) throw new Error('save failed: ' + store().persistenceFailure.message);
    }
    if (process.env.CHECK_MODE === 'cleanup') {
        for (const title of [names.one, names.two]) if (project(title)) await store().deleteProject(project(title).id);
        for (const name of [names.work, names.office, names.home]) if (area(name)) await store().deleteArea(area(name).id);
        await flushPendingSave();
        if (store().persistenceFailure) throw new Error('save failed: ' + store().persistenceFailure.message);
    }
    const out = {
        quickView: store().settings.appearance?.mobileQuickAccessView ?? null,
        areas: store()._allAreas.filter((entry) => !entry.deletedAt && entry.name.startsWith('PM1489')).map((entry) => ({ id: entry.id, name: entry.name })),
        projects: [names.one, names.two].map((title) => project(title)).filter(Boolean)
            .map((entry) => ({ id: entry.id, title: entry.title, areaId: entry.areaId ?? null, order: entry.order, status: entry.status })),
    };
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    console.log(JSON.stringify(out));
    process.exit(0);
`], { encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, CHECK_DB: db, CHECK_MODE: mode, CHECK_NAMES: JSON.stringify(NAMES) } })
    .trim().split('\n').pop());

const areaNamed = (seen, name) => seen.areas.find((entry) => entry.name === name);
const projectTitled = (seen, title) => seen.projects.find((entry) => entry.title === title);
const canonical = (seen) => {
    const workArea = areaNamed(seen, NAMES.work);
    const [one, two] = [projectTitled(seen, NAMES.one), projectTitled(seen, NAMES.two)];
    return Boolean(seen.quickView === 'projects' && workArea && areaNamed(seen, NAMES.home) && !areaNamed(seen, NAMES.office) && one && two
        && one.areaId === workArea.id && two.areaId === workArea.id && one.order < two.order && one.status === 'active' && two.status === 'active');
};

const onInbox = (nodes) => !tagged(nodes, 'menu-screen') && tabSelected(nodes, en['tab.inbox']);
const textNode = (nodes, text) => nodes.find((node) => node.text === text && node.class !== 'android.widget.EditText');
const shot = (name) => {
    mkdirSync(shots, { recursive: true });
    const file = resolve(shots, `${name}.png`);
    writeFileSync(file, adbRaw('exec-out', 'screencap', '-p'));
    console.log(`screenshot ${file}`);
};
const replaceText = async (node, text) => {
    await focusAtEnd(node);
    requireAppFront();
    sh('input keycombination KEYCODE_CTRL_LEFT KEYCODE_A');
    await sleep(200);
    sh(`input text ${text}`);
};
const back = async () => { requireAppFront(); sh('input keyevent KEYCODE_BACK'); await sleep(800); };

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

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const originalNight = sh('cmd uimode night').replace(/^Night mode: /, '').trim();
const restore = async () => {
    try { if (originalNight && originalNight !== 'unknown') sh(`cmd uimode night ${originalNight}`); } catch {                   }
    try {
        for (let step = 0; step < 4 && front().includes(`${PKG}/`); step += 1) {
            const nodes = await screen();
            if (onInbox(nodes)) break;
            sh('input keyevent KEYCODE_BACK');
            await sleep(800);
        }
        const nodes = await screen();
        if (front().includes(`${PKG}/`) && tab(nodes, en['tab.inbox']) && !tabSelected(nodes, en['tab.inbox'])) await tap(tab(nodes, en['tab.inbox']));
    } catch {                       }
    for (const [name, value] of [['user_rotation', originalRotation], ['accelerometer_rotation', originalAccelerometer]]) {
        try { sh(value === 'null' ? `settings delete system ${name}` : `settings put system ${name} ${value}`); } catch {                   }
    }
    try {
        if (fixtureAdded) {
            await rewrite('cleanup');
            const left = core('view');
            if (left.areas.length || left.projects.length) console.error(`RESTORE: the fixture areas or projects are still stored: ${JSON.stringify(left)}`);
        }
    } catch (error) { console.error(`RESTORE FAILED: the fixture areas and projects were not removed (${error.message})`); process.exitCode = 1; }
    try { sh(`rm -f ${UI_FILE} ${STAGED}`); } catch {                   }
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
    if (!canonical(seen)) {
        await rewrite('inject');
        seen = core('view');
        console.log(`info - injected the areas ${NAMES.work} and ${NAMES.home} with ${NAMES.one} above ${NAMES.two} in ${NAMES.work}`);
    }
    fixtureAdded = true;
    check(canonical(seen), `core stores ${NAMES.one} above ${NAMES.two}, both in ${NAMES.work}, beside ${NAMES.home}`);
    const workId = areaNamed(seen, NAMES.work).id;
    const homeId = areaNamed(seen, NAMES.home).id;

    let nodes = await tapExpecting(tab(await screen(), en['projects.title']) ?? fail('no Projects tab'), (current) => tabSelected(current, en['projects.title']), 'the Projects tab');
    const openRowMenu = async (title) => {
        nodes = await device.reveal(title, 60);
        nodes = await device.settle(nodes);
        const more = withDescription(nodes, `${en['common.more']}: ${title}`) ?? fail(`no "${en['common.more']}" button on the row ${title}`);
        return tapExpecting(more, (current) => Boolean(tagged(current, 'project-row-menu-sheet')), `the menu of ${title}`);
    };

    nodes = await openRowMenu(NAMES.one);
    check(Boolean(textNode(nodes, NAMES.one)) && !withDescription(nodes, en['projects.moveUp']) && Boolean(withDescription(nodes, en['projects.moveDown']))
        && Boolean(withDescription(nodes, en['projects.areaLabel'])),
        `the "…" menu of the first project ${NAMES.one} is titled with it and offers ${en['projects.moveDown']} and ${en['projects.areaLabel']}, not ${en['projects.moveUp']}`);
    shot('row-menu-light');
    nodes = await tapExpecting(withDescription(nodes, en['projects.moveDown']), (current) => !tagged(current, 'project-row-menu-sheet'), 'the menu closed');
    await waitFor(`${NAMES.one} stored below ${NAMES.two}`, () => {
        seen = core('view');
        return projectTitled(seen, NAMES.one).order > projectTitled(seen, NAMES.two).order;
    }, 20_000);
    check(true, `${en['projects.moveDown']} from the menu stores ${NAMES.one} below ${NAMES.two}`);

    nodes = await openRowMenu(NAMES.one);
    check(Boolean(withDescription(nodes, en['projects.moveUp'])) && !withDescription(nodes, en['projects.moveDown']),
        `now last, ${NAMES.one}'s menu offers ${en['projects.moveUp']} and no ${en['projects.moveDown']}`);
    nodes = await tapExpecting(withDescription(nodes, en['projects.areaLabel']), (current) => Boolean(tagged(current, 'project-area-move-sheet')), 'the Area picker');
    check(Boolean(withDescription(nodes, en['projects.manageAreas'])) && Boolean(withDescription(nodes, en['projects.noArea']))
        && Boolean(tagged(nodes, `project-area-picker-${workId}`)) && Boolean(tagged(nodes, `project-area-picker-${homeId}`)),
        `${en['projects.areaLabel']} opens the picker with ${en['projects.manageAreas']}, ${en['projects.noArea']} and both areas`);
    shot('area-picker-light');
    nodes = await tapExpecting(tagged(nodes, `project-area-picker-${homeId}`), (current) => !tagged(current, 'project-area-move-sheet'), 'the picker closed');
    await waitFor(`${NAMES.one} stored in ${NAMES.home}`, () => {
        seen = core('view');
        return projectTitled(seen, NAMES.one).areaId === homeId;
    }, 20_000);
    check(projectTitled(seen, NAMES.two).areaId === workId, `the picker moves ${NAMES.one} to ${NAMES.home} without opening it, and ${NAMES.two} stays in ${NAMES.work}`);
    nodes = await device.settle(await screen());
    check(!tagged(nodes, 'project-title-input'), 'the Projects list stays open after the move');

    const manageLabel = `${en['projects.manageAreas']}: ${NAMES.work}`;
    nodes = await device.reveal(NAMES.two, 60);
    nodes = await device.settle(nodes);
    check(!withDescription(nodes, `${en['projects.manageAreas']}: ${en['projects.noArea']}`), `the ${en['projects.noArea']} heading has no "…" menu`);
    nodes = await tapExpecting(withDescription(nodes, manageLabel) ?? fail(`no "${manageLabel}" button on the area heading`),
        (current) => Boolean(tagged(current, 'project-area-manager')) && Boolean(tagged(current, 'project-area-rename-input')), `the ${en['projects.manageAreas']} sheet for ${NAMES.work}`);
    const input = tagged(nodes, 'project-area-rename-input');
    check(input.text === NAMES.work && Boolean(textNode(nodes, en['projects.manageAreas'])) && !tagged(nodes, `project-area-row-${homeId}`) && !tagged(nodes, 'project-area-new-name'),
        `the heading's "…" opens ${en['projects.manageAreas']} on ${NAMES.work} alone, its name ready to rename, without the new-area form`);
    shot('area-rename-light');

    await replaceText(input, NAMES.home.toLowerCase());
    nodes = await waitFor('the name-taken line', (current) => tagged(current, 'project-area-rename-input')?.text === NAMES.home.toLowerCase()
        && Boolean(tagged(current, 'project-area-rename-taken')), 15_000);
    check(textNode(nodes, en['areas.nameExists']) && tagged(nodes, 'area-rename-save')?.enabled === 'false',
        `typing another area's name in another case shows "${en['areas.nameExists']}" and turns Save off`);
    shot('area-rename-taken-light');
    seen = core('view');
    check(areaNamed(seen, NAMES.work)?.id === workId && areaNamed(seen, NAMES.home)?.id === homeId, 'core keeps both areas as they were');

    await replaceText(tagged(nodes, 'project-area-rename-input'), NAMES.office);
    nodes = await waitFor('Save on for a free name', (current) => tagged(current, 'project-area-rename-input')?.text === NAMES.office
        && !tagged(current, 'project-area-rename-taken') && tagged(current, 'area-rename-save')?.enabled === 'true', 15_000);
    const save = tagged(nodes, 'area-rename-save');
    const keyboard = sh('dumpsys window windows').split(/\n  Window #/).find((block) => / InputMethod\}:/.test(block) && /mHasSurface=true/.test(block));
    const keyboardTop = Number(keyboard?.match(/touchable region=SkRegion\(\((\d+),(\d+),/)?.[2] ?? NaN);
    check(Number.isFinite(keyboardTop) && box(save)[3] <= keyboardTop, `with the keyboard up, Save sits above it (Save bottom ${box(save)[3]}, keyboard top ${keyboardTop})`);
    nodes = await tapExpecting(save, (current) => Boolean(tagged(current, 'project-area-manager')) && !tagged(current, 'project-area-rename-input'), 'the rename saved');
    await waitFor(`${NAMES.office} stored`, () => {
        seen = core('view');
        return areaNamed(seen, NAMES.office)?.id === workId;
    }, 20_000);
    check(!areaNamed(seen, NAMES.work) && seen.areas.filter((entry) => entry.name === NAMES.office).length === 1 && areaNamed(seen, NAMES.home)?.id === homeId,
        `Save stores ${NAMES.office} once, on the same area, and ${NAMES.home} is untouched`);
    nodes = await waitFor(`the sheet row named ${NAMES.office}`, (current) => Boolean(textNode(current, NAMES.office)), 15_000);
    check(true, `the sheet shows the new name ${NAMES.office}`);
    await back();
    nodes = await waitFor('the sheet closed', (current) => !tagged(current, 'project-area-manager'), 10_000);
    nodes = await device.reveal(NAMES.two, 60);
    check(Boolean(withDescription(await screen(), `${en['projects.manageAreas']}: ${NAMES.office}`)), `the Projects list heading now reads ${NAMES.office}`);

    sh('cmd uimode night yes');
    await sleep(2500);
    nodes = await openRowMenu(NAMES.two);
    shot('row-menu-dark');
    await back();
    nodes = await device.reveal(NAMES.two, 60);
    nodes = await tapExpecting(withDescription(nodes, `${en['projects.manageAreas']}: ${NAMES.office}`) ?? fail('no area heading menu in dark mode'),
        (current) => Boolean(tagged(current, 'project-area-rename-input')), 'the rename sheet in dark mode');
    shot('area-rename-dark');
    await back();
    console.log('Projects list menus device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
