import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, check, connect, evidenced, fail, Stopped, tab, tabSelected, tagged, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-project-tagfilter-device.mjs <adb-serial> [apk]');
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
const STAGED = '/data/local/tmp/mindwtr-native-dev-project-tagfilter.db';
const DB = 'mindwtr-native-dev.db';
const NAMES = { work: 'PT32Work', home: 'PT32Home', bare: 'PT32Bare' };
const TAGS = { work: '#pt32work', home: '#pt32home' };
const work = resolve(app, 'android/build/project-tagfilter-check');
const shots = resolve(process.env.MINDWTR_HARNESS_DIR ?? work, 'project-tagfilter');
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
    const area = (name) => store()._allAreas.find((entry) => !entry.deletedAt && entry.name.toLowerCase() === name.toLowerCase());
    const project = (title) => store()._allProjects.find((entry) => !entry.deletedAt && entry.title === title);
    if (process.env.CHECK_MODE === 'inject') {
        for (const [key, tags] of [['work', [names.tags.work]], ['home', [names.tags.home]], ['bare', []]]) {
            if (!project(names[key])) await store().addProject(names[key], '#94a3b8');
            await store().updateProject(project(names[key]).id, { areaId: undefined, status: 'active', tagIds: tags });
        }
        const filtered = await host.setAreaFilter({ included: [], excluded: [] });
        if (!filtered.ok) throw new Error(filtered.error.message);
        if (store().settings.appearance?.mobileQuickAccessView !== 'projects') await store().updateSettings({ appearance: { mobileQuickAccessView: 'projects' } });
        await flushPendingSave();
        if (store().persistenceFailure) throw new Error('save failed: ' + store().persistenceFailure.message);
    }
    if (process.env.CHECK_MODE === 'cleanup') {
        for (const key of ['work', 'home', 'bare']) if (project(names[key])) await store().deleteProject(project(names[key]).id);
        const kept = JSON.parse(process.env.CHECK_KEPT);
        if ((store().settings.appearance?.mobileQuickAccessView ?? null) !== kept.quickView)
            await store().updateSettings({ appearance: { ...store().settings.appearance, mobileQuickAccessView: kept.quickView ?? undefined } });
        const live = new Set([AREA_FILTER_NONE, ...store()._allAreas.filter((entry) => !entry.deletedAt).map((entry) => entry.id)]);
        const restored = await host.setAreaFilter({ included: kept.areaFilter.included.filter((id) => live.has(id)), excluded: kept.areaFilter.excluded.filter((id) => live.has(id)) });
        if (!restored.ok) throw new Error(restored.error.message);
        await flushPendingSave();
        if (store().persistenceFailure) throw new Error('save failed: ' + store().persistenceFailure.message);
    }
    const live = store()._allProjects.filter((entry) => !entry.deletedAt);
    const out = {
        quickView: store().settings.appearance?.mobileQuickAccessView ?? null,
        areaFilter: resolveAreaFilterSelection(store().settings.filters, store()._allAreas),
        projects: live.map((entry) => ({ id: entry.id, title: entry.title, tags: entry.tagIds ?? [], status: entry.status })),
    };
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    console.log(JSON.stringify(out));
    process.exit(0);
`], { encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, CHECK_DB: db, CHECK_MODE: mode, CHECK_NAMES: JSON.stringify({ ...NAMES, tags: TAGS }), CHECK_KEPT: JSON.stringify(kept ?? { quickView: null, areaFilter: { included: [], excluded: [] } }) } })
    .trim().split('\n').pop());

const ours = (seen) => Object.fromEntries(Object.entries(NAMES).map(([key, title]) => [key, seen.projects.find((entry) => entry.title === title)]));
const canonical = (seen) => {
    const mine = ours(seen);
    return Boolean(seen.quickView === 'projects' && mine.work?.tags.join() === TAGS.work && mine.home?.tags.join() === TAGS.home && mine.bare?.tags.length === 0
        && Object.values(mine).every((entry) => entry?.status === 'active'));
};

const onInbox = (nodes) => !tagged(nodes, 'menu-screen') && tabSelected(nodes, en['tab.inbox']);
const textNode = (nodes, text) => nodes.find((node) => node.text === text && node.class !== 'android.widget.EditText');
const shot = (name) => {
    mkdirSync(shots, { recursive: true });
    const file = resolve(shots, `${name}.png`);
    writeFileSync(file, adbRaw('exec-out', 'screencap', '-p'));
    console.log(`screenshot ${file}`);
};

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
    for (const [name, value] of [['user_rotation', originalRotation], ['accelerometer_rotation', originalAccelerometer]]) {
        try { sh(value === 'null' ? `settings delete system ${name}` : `settings put system ${name} ${value}`); } catch {}
    }
    try {
        if (fixtureAdded) {
            await rewrite('cleanup');
            const left = core('view');
            if (Object.values(ours(left)).some(Boolean) || left.quickView !== kept.quickView || JSON.stringify(left.areaFilter) !== JSON.stringify(kept.areaFilter))
                console.error(`RESTORE: the fixture or the settings it changed are still stored: ${JSON.stringify({ quickView: left.quickView, areaFilter: left.areaFilter, ours: ours(left) })}`);
        }
    } catch (error) { console.error(`RESTORE FAILED: the fixture projects were not removed (${error.message})`); process.exitCode = 1; }
    try { if (front().includes(`${PKG}/`)) sh('input keyevent KEYCODE_HOME'); } catch {}
    try { sh(`rm -f ${UI_FILE} ${STAGED}`); } catch {}
};

const toggle = (nodes) => tagged(nodes, 'projects-tag-filter-toggle');
const chip = (nodes, label) => nodes.find((node) => node['resource-id']?.endsWith('projects-tag-filter-option') && node['content-desc'] === label);
const visibleProjects = (nodes, seen) => seen.projects.map((entry) => entry.title).filter((title) => Boolean(textNode(nodes, title)));
const toTop = async () => {
    for (let step = 0; step < 6; step += 1) {
        const nodes = await screen();
        if (toggle(nodes) && nodes.some((node) => node.class === 'android.widget.EditText' && box(node)[3] <= box(toggle(nodes))[1])) return nodes;
        sh('input swipe 540 700 540 1900 250');
        await sleep(600);
    }
    return fail('the Tag filter row is not on screen');
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
    }
    check(canonical(seen), `core stores ${NAMES.work} tagged ${TAGS.work}, ${NAMES.home} tagged ${TAGS.home}, and ${NAMES.bare} with no tags`);

    let nodes = await tapExpecting(tab(await screen(), en['projects.title']) ?? fail('no Projects tab'), (current) => tabSelected(current, en['projects.title']), 'the Projects tab');
    nodes = await toTop();
    const closedLabel = `${en['projects.tagFilter']}, ${en['filters.show']}`;
    check(toggle(nodes)['content-desc'] === closedLabel && toggle(nodes).checked === 'false' && Boolean(tagged(nodes, 'projects-manage-areas'))
        && box(toggle(nodes))[1] < box(tagged(nodes, 'projects-manage-areas'))[3] && box(toggle(nodes))[3] > box(tagged(nodes, 'projects-manage-areas'))[1],
        `RN's row: "${closedLabel}" on the same line as ${en['projects.manageAreas']}`);
    check(!nodes.some((node) => node['resource-id']?.endsWith('projects-tag-filter-option')), 'the chips stay hidden until Show');
    shot('closed-light');

    nodes = await tapExpecting(toggle(nodes), (current) => Boolean(chip(current, en['projects.allTags'])), 'the tag chips');
    const chips = nodes.filter((node) => node['resource-id']?.endsWith('projects-tag-filter-option')).map((node) => node['content-desc']);
    const expectedChips = [en['projects.allTags'], ...[...new Set(seen.projects.filter((entry) => entry.status !== 'deleted').flatMap((entry) => entry.tags))].sort(), en['projects.noTags']];
    check(toggle(nodes)['content-desc'] === `${en['projects.tagFilter']}, ${en['filters.hide']}` && chip(nodes, en['projects.allTags']).checked === 'true'
        && chips[0] === en['projects.allTags'] && chips.includes(TAGS.work) && chips.includes(TAGS.home) && chips.at(-1) === en['projects.noTags'],
        `Show turns into Hide and lists ${en['projects.allTags']} (chosen), the tags and ${en['projects.noTags']}: ${chips.join(', ')}`);
    console.log(`info - core tag inventory ${expectedChips.join(', ')}`);
    shot('open-light');

    nodes = await tapExpecting(chip(nodes, TAGS.work), (current) => chip(current, TAGS.work)?.checked === 'true' && !textNode(current, NAMES.home), `the ${TAGS.work} filter`);
    nodes = await device.settle(nodes);
    const workShown = visibleProjects(nodes, seen);
    const workExpected = seen.projects.filter((entry) => entry.tags.includes(TAGS.work)).map((entry) => entry.title);
    check(toggle(nodes)['content-desc'] === `${en['projects.tagFilter']}: ${TAGS.work}, ${en['filters.hide']}` && toggle(nodes).checked === 'true',
        `the heading names the chosen tag: "${en['projects.tagFilter']}: ${TAGS.work}"`);
    check(workShown.length > 0 && workShown.every((title) => workExpected.includes(title)) && workShown.includes(NAMES.work),
        `with ${TAGS.work} only matching projects show: ${workShown.join(', ')}`);
    shot('tag-light');

    nodes = await tapExpecting(chip(nodes, en['projects.noTags']), (current) => chip(current, en['projects.noTags'])?.checked === 'true' && !textNode(current, NAMES.work), `the ${en['projects.noTags']} filter`);
    nodes = await device.settle(nodes);
    const bareShown = visibleProjects(nodes, seen);
    const bareExpected = seen.projects.filter((entry) => entry.tags.length === 0).map((entry) => entry.title);
    check(bareShown.length > 0 && bareShown.every((title) => bareExpected.includes(title))
        && toggle(nodes)['content-desc'] === `${en['projects.tagFilter']}: ${en['projects.noTags']}, ${en['filters.hide']}`,
        `${en['projects.noTags']} shows only untagged projects: ${bareShown.join(', ')}`);
    nodes = await device.reveal(NAMES.bare, 60);
    check(!textNode(nodes, NAMES.work) && !textNode(nodes, NAMES.home), `${NAMES.bare} is in the ${en['projects.noTags']} list, and the tagged fixtures are not`);
    nodes = await toTop();

    nodes = await tapExpecting(chip(nodes, en['projects.allTags']), (current) => chip(current, en['projects.allTags'])?.checked === 'true', `${en['projects.allTags']}`);
    check(toggle(nodes)['content-desc'] === `${en['projects.tagFilter']}, ${en['filters.hide']}` && toggle(nodes).checked === 'false',
        `${en['projects.allTags']} clears the filter`);
    for (const title of [NAMES.work, NAMES.home, NAMES.bare]) {
        await device.reveal(title, 60);
        check(true, `${title} shows again with ${en['projects.allTags']}`);
    }
    nodes = await toTop();
    nodes = await tapExpecting(toggle(nodes), (current) => !chip(current, en['projects.allTags']), 'Hide');
    check(toggle(nodes)['content-desc'] === closedLabel, 'Hide folds the chips away');

    sh('cmd uimode night yes');
    await sleep(2500);
    nodes = await toTop();
    nodes = await tapExpecting(toggle(nodes), (current) => Boolean(chip(current, en['projects.allTags'])), 'the tag chips in dark mode');
    shot('open-dark');
    await tapExpecting(toggle(await screen()), (current) => !chip(current, en['projects.allTags']), 'Hide in dark mode');
    console.log('Projects tag filter device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
