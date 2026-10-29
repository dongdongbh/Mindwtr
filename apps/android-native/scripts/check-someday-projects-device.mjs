// Someday projects in their section (pass P3, #1319) for the isolated native Android development app.
//
//   node apps/android-native/scripts/check-someday-projects-device.mjs <adb-serial> [apk]
//
// RN draws a parked (Someday) project inside its Someday section group, before the group's tasks, and no Projects block above the
// list. The first run INJECTS, through
// core's own store on a host copy of the database, one fixed Someday section ("P3 1319") and one fixed Someday project in it
// ("P3 1319 project"); every later run REUSES them, so the development data does not grow. Installs the debug APK with
// `install -r`, then checks against core's own Someday view (projectsInSections, grouped by section) on a copy: the project row
// sits under its section's heading, before that group's first task, and no Projects block shows; its tap opens the project, and
// Back returns. Then RN's long press on the row (8fd2cab96) opens core's Move to section… for the project: No section moves it
// under "No section" (core stores no section), and a second long press puts it back in "P3 1319" (the fixture as it was). Screenshots
// go to the harness folder (MINDWTR_HARNESS_DIR) for the side-by-side with RN. Its only UI writes are those two moves; it touches
// only the development package (it refuses any other APK), never launches over another app, leaves the
// app on its Inbox tab and restores rotation on exit. Exit 0 = pass, 1 = fail, 2 = refused, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, check, connect, evidenced, fail, Stopped, tab, tabSelected, tagged, taskRows, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-someday-projects-device.mjs <adb-serial> [apk]');
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
const STAGED = '/data/local/tmp/mindwtr-native-dev-someday.db';
const DB = 'mindwtr-native-dev.db';
const SECTION = 'P3 1319';
const PROJECT = 'P3 1319 project';
const work = resolve(app, 'android/build/someday-projects-check');
const shots = resolve(process.env.MINDWTR_HARNESS_DIR ?? work, 'someday-projects');
const coreSrc = resolve(app, '../../packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { adbRaw, sh, home, front, requireAppFront, screen, waitFor, tap, tapExpecting } = device;
const runAs = (command) => sh(`run-as ${PKG} ${command}`);

const pullDatabase = (name) => {
    const dir = resolve(work, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = runAs('ls files').split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    return resolve(dir, DB);
};
/**
 * Core on a copy: `inject` makes the fixed section and project when either is missing (and checkpoints the WAL); `view` prints the
 * fixed project and section ids and core's Someday items (projectsInSections, by section) as the screen reads them.
 */
const core = (mode, db = pullDatabase(mode)) => JSON.parse(execFileSync('bun', ['-e', `
    import { Database } from 'bun:sqlite';
    import { SqliteAdapter, buildSomedaySectionsSettingsUpdate, createNativeHostContract, flushPendingSave, planSomedaySectionCreate, setStorageAdapter, useTaskStore } from '${coreSrc}/index.ts';
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
    const store = () => useTaskStore.getState();
    const section = () => (store().settings.gtd?.viewSections?.someday ?? []).find((entry) => entry.title === process.env.CHECK_SECTION);
    const project = () => store()._allProjects.find((entry) => entry.title === process.env.CHECK_PROJECT && !entry.deletedAt);
    let out;
    if (process.env.CHECK_MODE === 'inject') {
        if (!section()) {
            const plan = planSomedaySectionCreate(store().settings.gtd?.viewSections?.someday, process.env.CHECK_SECTION);
            if (plan.kind !== 'create') throw new Error('section plan ' + plan.kind);
            await store().updateSettings(buildSomedaySectionsSettingsUpdate(store().settings, plan.sections));
        }
        if (!project()) await store().addProject(process.env.CHECK_PROJECT, '#94a3b8');
        const placed = project();
        if (placed.status !== 'someday' || placed.viewSectionIds?.someday !== section().id) {
            await store().updateProject(placed.id, { status: 'someday', viewSectionIds: { ...(placed.viewSectionIds ?? {}), someday: section().id } });
        }
        await flushPendingSave();
        if (store().persistenceFailure) throw new Error('save failed: ' + store().persistenceFailure.message);
        out = { injected: true };
    } else {
        const view = value(host.getSomedayView({ groupBy: 'viewSection', projectsInSections: true, offset: 0, limit: 100 }));
        out = {
            section: section()?.id ?? null,
            project: project() ? { id: project().id, status: project().status, section: project().viewSectionIds?.someday ?? null } : null,
            deferred: view.deferred !== null,
            items: view.items.map((item) => item.type === 'heading' ? ['heading', item.id, item.title] : item.type === 'project' ? ['project', item.id, item.project.title] : ['task', item.groupId, item.row.title]),
        };
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    console.log(JSON.stringify(out));
    process.exit(0);
`], { encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, CHECK_DB: db, CHECK_MODE: mode, CHECK_SECTION: SECTION, CHECK_PROJECT: PROJECT } })
    .trim().split('\n').pop());

// ---- UI (core's English) ----
const onInbox = (nodes) => !tagged(nodes, 'menu-screen') && tabSelected(nodes, en['tab.inbox']);
const sheetOpen = (nodes) => Boolean(tagged(nodes, 'more-sheet'));
const top = (node) => box(node)[1];
const textNode = (nodes, text) => nodes.find((node) => node.text === text && node.class !== 'android.widget.EditText');

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const restore = async () => {
    try {
        for (let step = 0; step < 4 && front().includes(`${PKG}/`); step += 1) {
            const nodes = await screen();
            if (onInbox(nodes)) break;
            sh('input keyevent KEYCODE_BACK');
            await sleep(800);
        }
        const nodes = await screen();
        if (front().includes(`${PKG}/`) && tab(nodes, en['tab.inbox']) && !tabSelected(nodes, en['tab.inbox'])) await tap(tab(nodes, en['tab.inbox']));
    } catch { /* the app is gone */ }
    for (const [name, value] of [['user_rotation', originalRotation], ['accelerometer_rotation', originalAccelerometer]]) {
        try { sh(value === 'null' ? `settings delete system ${name}` : `settings put system ${name} ${value}`); } catch { /* device gone */ }
    }
    try { sh(`rm -f ${UI_FILE} ${STAGED}`); } catch { /* device gone */ }
};

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    device.launch(ACTIVITY);
    requireAppFront();
    sh('settings put system accelerometer_rotation 0');
    sh('settings put system user_rotation 0');
    await waitFor('the Inbox', onInbox, 60_000);
    let seen = core('view');
    if (!seen.section || seen.project?.status !== 'someday' || seen.project.section !== seen.section) {
        // First run (or the fixture changed): stop, add the fixed section and project through core, put the database back.
        await device.stopApp();
        const db = pullDatabase('inject');
        core('inject', db);
        adbRaw('push', db, STAGED);
        try { runAs(`cp ${STAGED} files/${DB}`); } finally { sh(`rm -f ${STAGED}`); }
        runAs(`rm -f files/${DB}-wal files/${DB}-shm`);
        device.launch(ACTIVITY);
        await waitFor('the Inbox', onInbox, 60_000);
        seen = core('view');
        console.log(`info - injected the fixed section "${SECTION}" and Someday project "${PROJECT}"`);
    }
    check(seen.project?.status === 'someday' && seen.project.section === seen.section, `core stores "${PROJECT}" in Someday, in the section "${SECTION}"`);
    const heading = seen.items.findIndex((item) => item[0] === 'heading' && item[2] === SECTION);
    check(heading >= 0 && seen.items[heading + 1]?.[0] === 'project' && seen.items[heading + 1][1] === seen.project.id && !seen.deferred,
        `core's Someday puts "${PROJECT}" first under "${SECTION}", with no Projects block`);
    const nextTask = seen.items.slice(heading + 1).find((item) => item[0] !== 'project');

    // Someday from the More sheet, scrolled to the section.
    let nodes = await tapExpecting(tab(await screen(), en['tab.menu']) ?? fail('no Menu tab'), sheetOpen, 'the More sheet');
    nodes = await device.settle(nodes);
    nodes = await tapExpecting(withDescription(nodes, en['nav.someday']) ?? fail('no Someday tile'),
        (current) => Boolean(tagged(current, 'menu-screen')) && Boolean(textNode(current, en['someday.title'])), 'Someday');
    nodes = await device.reveal(PROJECT, 60);
    nodes = await device.settle(nodes);
    const sectionNode = textNode(nodes, SECTION) ?? fail(`no heading "${SECTION}" beside the project`);
    const projectNode = withDescription(nodes, PROJECT) ?? textNode(nodes, PROJECT) ?? fail(`no project row "${PROJECT}"`);
    const below = nextTask?.[0] === 'task' && nextTask[1] === seen.items[heading][1]
        ? taskRows(nodes).find((node) => node.text === nextTask[2]) : null;
    check(top(sectionNode) < top(projectNode) && (!below || top(projectNode) < top(below)),
        `the project row sits under "${SECTION}"${below ? `, before its first task "${nextTask[2]}"` : ''}`);
    const block = `${en['projects.title']} (`.toUpperCase();
    check(!nodes.some((node) => (node.text ?? '').startsWith(block)), 'no Projects block above the list');
    mkdirSync(shots, { recursive: true });
    const file = resolve(shots, 'someday-section-native.png');
    writeFileSync(file, adbRaw('exec-out', 'screencap', '-p'));
    console.log(`screenshot ${file}`);
    // Its tap opens the project (RN's onOpenProject; its title is the header's text field).
    nodes = await tapExpecting(projectNode, (current) => !textNode(current, SECTION) && current.some((node) => node.text === PROJECT), `the project "${PROJECT}"`);
    check(true, `the project row's tap opens "${PROJECT}"`);
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');

    // RN's long press (8fd2cab96): Move to section… for the project, out to No section and back into its section.
    const noSection = en['viewSections.noSection'];
    const moveTitle = en['viewSections.moveToSection'];
    const longPress = (node) => {
        requireAppFront();
        const [x1, y1, x2, y2] = box(node);
        sh(`input swipe ${Math.round((x1 + x2) / 2)} ${Math.round((y1 + y2) / 2)} ${Math.round((x1 + x2) / 2)} ${Math.round((y1 + y2) / 2)} 900`);
    };
    const moveTo = async (choice, shot) => {
        nodes = await device.reveal(PROJECT, 60);
        nodes = await device.settle(nodes);
        longPress(withDescription(nodes, PROJECT) ?? textNode(nodes, PROJECT) ?? fail(`no project row "${PROJECT}"`));
        nodes = await waitFor('the Move to section dialog', (current) => Boolean(textNode(current, moveTitle)) && Boolean(withDescription(current, choice)), 15_000);
        if (shot) writeFileSync(resolve(shots, 'someday-project-move-native.png'), adbRaw('exec-out', 'screencap', '-p'));
        await tap(withDescription(nodes, choice));
        await waitFor('the dialog closed', (current) => !textNode(current, moveTitle), 15_000);
        await sleep(1500);
        return core('view');
    };
    await waitFor('Someday again', (current) => Boolean(textNode(current, en['someday.title'])), 15_000);
    seen = await moveTo(noSection, true);
    const noSectionHeading = seen.items.findIndex((item) => item[0] === 'heading' && item[2] === noSection);
    check(seen.project?.section === null && noSectionHeading >= 0 && seen.items.slice(noSectionHeading + 1).some((item) => item[0] === 'project' && item[1] === seen.project.id),
        `a long press on "${PROJECT}" and "${noSection}" moves it under "${noSection}" (core stores no section)`);
    seen = await moveTo(SECTION, false);
    check(seen.project?.section === seen.section, `a second long press puts "${PROJECT}" back in "${SECTION}"`);
    console.log('Someday projects in sections device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
