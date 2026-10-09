// Project details check for the isolated native Android development app.
//
//   node apps/android-native/scripts/check-project-details-device.mjs <adb-serial> [apk]
//
// Installs the debug APK with `install -r` (existing development data stays). It stops the app and, through core's own store
// (Bun runs core's TypeScript) on a host copy of the app's database, prepares ONE fixture found by its stable marker
// (535353535353): an area PDArea<marker> and a project PD<marker> with one task. The first run injects it; every later run puts
// it back to RN's defaults (its title, Active, Parallel, no area, no tags, no notes, no dates, no attachments, no sections),
// so the development data does not grow. Then, on the open project's Details panel (RN's ProjectDetailModal):
//   (a) the folded Details shows core's summary; a tap unfolds the panel;
//   (b) Status → Waiting, (c) Type → Sequential, (d) Sequential Scope → Within sections, (e) Sections: Add Section twice,
//       Move down, Edit, Delete, (f) Area, (g) Tags (+ adds; Done and + on a held tag store nothing), (h) Notes (Preview shows the
//       typed notes and stores nothing; Back stores them),
//       (i) Attachments' Add link and Remove, (j) Start, Due and Review dates (the picker's day), and a Clear, (k) the title:
//       each write is stored once (the pulled database: the value, and the project's rev one higher);
//   (l) a restart replays a journaled edit: one stopped before the engine saw it (Status → Someday) is stored by the boot's
//       replay, one stopped after core's reply (a tag) is replayed and stores nothing more; typed notes Back journaled, killed
//       before the engine sees them, are stored by the replay;
//   (m) a restart keeps every value: the reopened Details shows core's labels for the stored values.
// It touches only the development package (it refuses any other APK), never launches over another app, leaves the app on its
// Inbox tab, and restores rotation and clears its debug properties on exit. Leave the device on its home screen. It needs host
// `sqlite3` and `bun`. Exit 0 = pass, 1 = fail, 2 = refused before touching the device, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { bootFailure, box, button, check, connect, evidenced, fail, hasText, inEditor, mainList, Stopped, tab, tabSelected, tagged, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-project-details-device.mjs <adb-serial> [apk]');
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
const TAG = 'MindwtrNativeDev';
const UI_FILE = '/data/local/tmp/mindwtr-native-dev-ui.xml';
const STAGED = '/data/local/tmp/mindwtr-native-dev-details.db';
const PROPS = ['fail_commit', 'delay_before_ms', 'delay_after_ms', 'language', 'journal_stop'];
const DB = 'mindwtr-native-dev.db';
const work = resolve(app, 'android/build/project-details-check');
const coreSrc = resolve(app, '../../packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));
const run = '535353535353';
const names = { area: `PDArea${run}`, project: `PD${run}`, renamed: `PDR${run}`, backTitle: `PDB${run}`, killTitle: `PDK${run}`, killNotes: `Kill notes ${run}`, task: `55${run}`, first: `S1${run}`, second: `S2${run}`,
    edited: `S3${run}`, tag: `pd${run}`, replayTag: `pdr${run}`, notes: `Notes ${run}`, link: `https://example.com/pd/${run}` };

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { adbRaw, sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting } = device;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
const runAs = (command) => sh(`run-as ${PKG} ${command}`);
const launch = () => device.launch(ACTIVITY);
const logs = (processId) => device.logs(processId, TAG);
const stopApp = async () => {
    await device.stopApp();
};

// ---- database: a host copy of .db, -wal and -shm; core runs on it in Bun ----
const pullDatabase = (name) => {
    const dir = resolve(work, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = runAs('ls files').split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) {
        if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    }
    return resolve(dir, DB);
};
const sqlite = (db, sql) => JSON.parse(execFileSync('sqlite3', ['-json', db, sql], { encoding: 'utf8' }) || '[]');
let ids = {};
/** The fixture project as stored, and its live sections in order. */
const stored = (label = 'stored') => {
    const db = pullDatabase(label);
    const [project] = sqlite(db, `SELECT title, status, isSequential, sequentialScope, areaId, tagIds, supportNotes, attachments, startDate, dueDate,
        reviewAt, rev FROM projects WHERE id = '${ids.project}'`);
    const sections = sqlite(db, `SELECT id, title FROM sections WHERE projectId = '${ids.project}' AND deletedAt IS NULL ORDER BY orderNum`);
    return { ...project, tags: JSON.parse(project.tagIds || '[]'), attachmentList: JSON.parse(project.attachments || '[]'), sections };
};
/**
 * Runs core's contract on a database copy: `prepare` finds the fixture by its marker (or injects it once), puts it back to RN's
 * defaults through core's store, and prints the ids; `metadata` prints core's Details metadata for the project.
 */
const core = (db, mode) => JSON.parse(execFileSync('bun', ['-e', `
    import { Database } from 'bun:sqlite';
    import { SqliteAdapter, createNativeHostContract, flushPendingSave, setStorageAdapter, useTaskStore } from '${coreSrc}/index.ts';
    const db = new Database(process.env.CHECK_DB);
    const client = {
        run: async (sql, params = []) => { db.query(sql).run(...params); },
        all: async (sql, params = []) => db.query(sql).all(...params),
        get: async (sql, params = []) => db.query(sql).get(...params) ?? undefined,
        exec: async (sql) => { db.exec(sql); },
    };
    setStorageAdapter(new SqliteAdapter(client));
    const host = createNativeHostContract();
    const ready = await host.activate({ writeSafetyReady: true });
    if (!ready.ok) throw new Error(ready.error.message);
    const names = JSON.parse(process.env.CHECK_NAMES);
    const store = () => useTaskStore.getState();
    const live = (items) => items.filter((item) => !item.deletedAt);
    const must = (result, what) => { if (result && result.success === false) throw new Error(what + ' failed: ' + result.error); };
    let out;
    if (process.env.CHECK_MODE === 'prepare') {
        // This check reads the Projects tab: RN's quick-access view set to Projects.
        if (store().settings.appearance?.mobileQuickAccessView !== 'projects') {
            await store().updateSettings({ appearance: { mobileQuickAccessView: 'projects' } });
            await flushPendingSave();
        }
        const found = live(store()._allProjects).filter((project) => [names.project, names.renamed, names.backTitle, names.killTitle].includes(project.title));
        if (found.length > 1) throw new Error('the fixture project title is not unique');
        let area = live(store()._allAreas).find((item) => item.name === names.area);
        if (!area) area = await store().addArea(names.area);
        let project = found[0];
        if (!project) {
            project = await store().addProject(names.project, '#3b82f6');
            must(await store().addTask(names.task, { status: 'next', projectId: project.id }), 'addTask');
        }
        for (const section of live(store()._allSections).filter((item) => item.projectId === project.id)) {
            must(await store().deleteSection(section.id), 'deleteSection');
            await flushPendingSave();
        }
        must(await store().updateProject(project.id, { title: names.project, status: 'active', isSequential: false, sequentialScope: undefined,
            areaId: undefined, tagIds: [], supportNotes: undefined, attachments: [], startDate: undefined, dueDate: undefined, reviewAt: undefined,
            isFocused: false }), 'reset');
        await flushPendingSave();
        if (store().persistenceFailure) throw new Error('save failed: ' + store().persistenceFailure.message);
        out = { project: project.id, area: area.id, reused: found.length === 1 };
    } else {
        const detail = host.getProjectDetail({ projectId: process.env.CHECK_PROJECT, offset: 0, limit: 10 });
        if (!detail.ok) throw new Error(detail.error.message);
        out = detail.value.metadata;
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    console.log(JSON.stringify(out));
    process.exit(0);
`], { encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, CHECK_DB: db, CHECK_MODE: mode, CHECK_NAMES: JSON.stringify(names), CHECK_PROJECT: ids.project ?? '' } })
    .trim().split('\n').pop());
const coreMetadata = (label) => core(pullDatabase(label), 'metadata');

// ---- UI ----
const textNode = (nodes, text) => nodes.find((node) => node.text === text && node.class !== 'android.widget.EditText');
const inProject = (nodes) => Boolean(tagged(nodes, 'project-title-input')) && Boolean(button(nodes, 'Back'));
const showTab = async (name) => {
    const nodes = await waitFor('the tabs', (current) => tab(current, name), 60_000);
    if (!tabSelected(nodes, name)) await tap(tab(nodes, name));
    await waitFor(`the ${name} tab`, (current) => tabSelected(current, name), 10_000);
};
/** Scrolls the open project until [found] holds (the panel's lower blocks sit below the fold). */
const revealIn = async (found, description) => {
    let nodes = await screen();
    for (const direction of ['down', 'up']) {
        for (let step = 0; step < 12 && !found(nodes); step += 1) {
            const next = await device.swipe(nodes, direction);
            if (device.signature(next) === device.signature(nodes)) break;
            nodes = next;
        }
        if (found(nodes)) return nodes;
    }
    return fail(`${description} is not on the project screen`);
};
const revealTag = (tag) => revealIn((nodes) => {
    const node = tagged(nodes, tag);
    if (!node) return false;
    // Fully inside the list, not under the header or the tab bar.
    const list = mainList(nodes);
    const [, top, , bottom] = box(node);
    return !list || (top >= box(list)[1] && bottom <= box(list)[3]);
}, tag);
const hideKeyboard = async () => {
    // Back while the keyboard shows only hides it.
    if (/mInputShown=true/.test(sh('dumpsys input_method'))) { requireAppFront(); sh('input keyevent KEYCODE_BACK'); await sleep(800); }
};
const typeText = async (node, text) => {
    await device.focusAtEnd(node);
    requireAppFront();
    sh('input keycombination KEYCODE_CTRL_LEFT KEYCODE_A');
    sh('input keyevent KEYCODE_DEL');
    sh(`input text '${text.replace(/ /g, '%s')}'`);
    await sleep(500);
};
/** Waits until the stored project satisfies [holds]; checks it took exactly one write (its rev one higher). */
const expectWrite = async (label, before, holds) => {
    let after;
    await waitFor(`${label} stored`, () => { after = stored(); return holds(after); }, 30_000);
    check(after.rev === before.rev + 1, `${label}: stored once (rev ${before.rev} → ${after.rev})`);
    return after;
};
/** One write from the panel: [act] taps it, [holds] reads the stored value. */
const write = async (label, act, holds) => {
    const before = stored('before');
    await act();
    return expectWrite(label, before, holds);
};
const pickToday = async () => {
    const nodes = await waitFor('the date picker', (current) => Boolean(button(current, en['common.ok'])), 15_000);
    await tap(button(nodes, en['common.ok']));
};
const localDay = () => sh('date +%Y-%m-%d');

// ---- stop and relaunch (check-journal-device.mjs's) ----
const stopAt = async (at, op, trigger) => {
    const before = pid();
    setProp('journal_stop', `${at}:${op}`);
    try {
        await trigger();
        const deadline = Date.now() + 30_000;
        while (pid() === before) {
            if (Date.now() > deadline) fail(`the process did not stop ${at} ${op}`);
            await sleep(100);
        }
    } finally {
        setProp('journal_stop', '');
    }
    check(logs(before).includes(`Native Android journal stop at=${at} op=${op}`), `the process stopped ${at} ${op}`);
    return before;
};
const relaunch = async (stopped) => {
    await sleep(1500);
    if (!pid() || pid() === stopped) {
        await waitFor('the home screen or the app', () => front().includes(`${home}/`) || front().includes(`${PKG}/`), 15_000);
        launch();
    }
    let processId = '';
    const replay = await waitFor('the boot\'s journal replay', () => {
        processId = pid();
        return Boolean(processId) && logs(processId).includes('Native Android journal replay');
    }, 60_000).then(() => logs(processId).split('\n').find((line) => line.includes('Native Android journal replay')));
    return { processId, replay };
};
const replayed = (replay) => replay.includes('sent=1 dropped=1 left=0 owed=none');

/** The fixture project open (after a restart the app may come back on its Inbox), titled [title]. */
const openFixture = async (title) => {
    let nodes = await waitFor('the app', (current) => Boolean(tab(current, 'Inbox')) || inProject(current), 60_000);
    if (inProject(nodes)) return nodes;
    await showTab('Projects');
    nodes = await device.reveal(title, 80);
    if (!textNode(nodes, title)) {
        // A Waiting or Someday project is listed under RN's Someday / Waiting group, which starts closed.
        const heading = en['projects.deferredSection'];
        nodes = await device.reveal(heading, 80);
        await tap(textNode(nodes, heading) ?? textNode(nodes, heading.toUpperCase()) ?? fail('no Someday / Waiting group'));
        nodes = await device.reveal(title, 80);
    }
    await tap(textNode(nodes, title) ?? fail(`${title} is not on the Projects list`));
    return waitFor('the open project', inProject, 30_000);
};
const openDetails = async (title = names.renamed) => {
    let nodes = await openFixture(title);
    if (!tagged(nodes, 'project-details-status')) {
        await tap(await revealTag('project-details-toggle').then((current) => tagged(current, 'project-details-toggle')));
        nodes = await waitFor('the Details panel', (current) => Boolean(tagged(current, 'project-details-status')), 10_000);
    }
    return nodes;
};

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const restore = async () => {
    for (const name of PROPS) { try { setProp(name, ''); } catch { /* device gone */ } }
    try {
        await hideKeyboard();
        if (front().includes(`${PKG}/`)) {
            let nodes = await screen();
            for (let step = 0; step < 3 && !tab(nodes, 'Inbox'); step += 1) { sh('input keyevent KEYCODE_BACK'); await sleep(800); nodes = await screen(); }
            if (button(nodes, 'Back') && tabSelected(nodes, 'Projects')) { sh('input keyevent KEYCODE_BACK'); await sleep(1000); nodes = await screen(); }
            if (tab(nodes, 'Inbox') && !tabSelected(nodes, 'Inbox')) await tap(tab(nodes, 'Inbox'));
        }
    } catch { /* the app is gone */ }
    try { sh(`settings put system accelerometer_rotation ${originalAccelerometer === 'null' ? 1 : originalAccelerometer}`); } catch { /* device gone */ }
    try { sh(`rm -f ${UI_FILE} ${STAGED}`); } catch { /* device gone */ }
};

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    for (const name of PROPS) setProp(name, '');
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    device.requireEnglishKeyboard?.();
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    launch();
    await showTab('Inbox');
    sh('settings put system accelerometer_rotation 0');
    sh('settings put system user_rotation 0');
    await stopApp();
    const db = pullDatabase('inject');
    ids = core(db, 'prepare');
    check(!existsSync(`${db}-wal`) || statSync(`${db}-wal`).size === 0, 'the fixture rows are all in the main database file');
    adbRaw('push', db, STAGED);
    try { runAs(`cp ${STAGED} files/${DB}`); } finally { sh(`rm -f ${STAGED}`); }
    runAs(`rm -f files/${DB}-wal files/${DB}-shm`);
    console.log(`${ids.reused ? 'REUSED' : 'INJECTED (once)'}: project ${names.project} and area ${names.area}, put back to RN's defaults through core's store`);

    launch();
    let nodes = await waitFor('the Inbox', (current) => tabSelected(current, 'Inbox') && !inEditor(current), 60_000);
    let processId = pid();
    check(!bootFailure(nodes), 'boot validation passed on the prepared database');
    nodes = await openFixture(names.project);

    // (a) Folded: core's summary; a tap unfolds the panel.
    let metadata = coreMetadata('a');
    check(textNode(nodes, metadata.summary) !== undefined, `(a) the folded Details shows core's summary "${metadata.summary}"`);
    check(!tagged(nodes, 'project-details-attachments'), '(a) the Attachments block is inside the folded Details, not above the tasks');
    nodes = await openDetails(names.project);
    check(true, '(a) a tap unfolds the Details panel');

    // (b) Status.
    let row = await write('(b) Status → Waiting', async () => {
        await tap(tagged(await revealTag('project-status-picker'), 'project-status-picker'));
        await tap(tagged(await waitFor('the status menu', (current) => Boolean(tagged(current, 'project-status-menu-item-waiting'))), 'project-status-menu-item-waiting'));
    }, (current) => current.status === 'waiting');
    nodes = await waitFor('the Waiting status', (current) => withDescription(current, `${en['projects.statusLabel']}: ${en['status.waiting']}`), 15_000);

    // (c) Type, (d) Sequential Scope.
    row = await write('(c) Type → Sequential', async () => tap(tagged(await revealTag('project-type-toggle'), 'project-type-toggle')),
        (current) => current.isSequential === 1);
    nodes = await waitFor('the Sequential Scope block', (current) => textNode(current, en['projects.sequentialWithinSections']), 15_000);
    row = await write('(d) Sequential Scope → Within sections', async () => tap(textNode(await screen(), en['projects.sequentialWithinSections'])),
        (current) => current.sequentialScope === 'section');

    // (e) Sections: Add Section (twice), Move down, Edit, Delete.
    const manager = async () => {
        const current = await screen();
        if (tagged(current, 'project-section-manager')) return current;
        await tap(tagged(await revealTag('project-sections-button'), 'project-sections-button'));
        return waitFor('the section manager', (next) => Boolean(tagged(next, 'project-section-manager')), 15_000);
    };
    const sectionWrite = async (label, act, holds) => {
        const before = stored('before');
        await act();
        let after;
        await waitFor(`${label} stored`, () => { after = stored(); return holds(after); }, 30_000);
        check(true, `${label}: stored (${JSON.stringify(after.sections.map((section) => section.title))})`);
        return { before, after };
    };
    for (const title of [names.first, names.second]) {
        await sectionWrite(`(e) Add Section ${title}`, async () => {
            nodes = await manager();
            await tap(tagged(nodes, 'project-section-add-button'));
            nodes = await waitFor('the section editor', (current) => Boolean(tagged(current, 'project-section-title-input')));
            await typeText(tagged(nodes, 'project-section-title-input'), title);
            await tap(tagged(await screen(), 'project-section-save-button'));
        }, (current) => current.sections.some((section) => section.title === title));
    }
    let sections = stored().sections;
    check(sections.length === 2 && sections[0].title === names.first, '(e) two sections stored, the first added first');
    await sectionWrite('(e) Move down', async () => tap(tagged(await manager(), `project-section-move-down-${sections[0].id}`)),
        (current) => current.sections.map((section) => section.title).join() === [names.second, names.first].join());
    await sectionWrite('(e) Edit', async () => {
        await tap(tagged(await manager(), `project-section-edit-${sections[1].id}`));
        nodes = await waitFor('the section editor', (current) => Boolean(tagged(current, 'project-section-title-input')));
        await typeText(tagged(nodes, 'project-section-title-input'), names.edited);
        await tap(tagged(await screen(), 'project-section-save-button'));
    }, (current) => current.sections.some((section) => section.title === names.edited));
    await sectionWrite('(e) Delete', async () => {
        await tap(tagged(await manager(), `project-section-delete-${sections[0].id}`));
        await tap(button(await waitFor('the delete confirm', (current) => textNode(current, en['projects.deleteSectionConfirm'])), en['common.delete']));
    }, (current) => current.sections.length === 1 && current.sections[0].title === names.edited);
    await hideKeyboard();
    await tap(withDescription(await screen(), en['common.cancel']) ?? fail('no Close on the section manager'));
    await waitFor('the section manager to close', (current) => !tagged(current, 'project-section-manager'), 10_000);

    // (f) Area.
    row = await write('(f) Area', async () => {
        await tap(tagged(await revealTag('project-area-picker'), 'project-area-picker'));
        nodes = await waitFor('the area picker', (current) => Boolean(tagged(current, 'project-area-sheet')), 15_000);
        // The development data has many areas: scroll the picker's list until the fixture's shows. Each drag covers half
        // the list, slowly: the full-height 500 ms drag flung past the fixture's row to the end of 47 areas (10-09).
        for (let step = 0; step < 30 && !textNode(nodes, names.area); step += 1) {
            const list = nodes.find((node) => node.scrollable === 'true' && box(node)[1] >= box(tagged(nodes, 'project-area-sheet'))[1]);
            const [x1, y1, x2, y2] = box(list ?? fail('the area picker has no list'));
            requireAppFront();
            sh(`input swipe ${Math.round((x1 + x2) / 2)} ${Math.round(y1 + (y2 - y1) * 0.75)} ${Math.round((x1 + x2) / 2)} ${Math.round(y1 + (y2 - y1) * 0.25)} 800`);
            await sleep(500);
            const next = await screen();
            const shown = (current) => current.map((node) => node.text).join('|');
            if (shown(next) === shown(nodes)) break;
            nodes = next;
        }
        await tap(textNode(nodes, names.area) ?? fail(`${names.area} is not in the area picker`));
    }, (current) => current.areaId === ids.area);

    // (g) Tags: typed, then + adds it. The keyboard's Done changes nothing, and + on a tag the project has keeps it (RN: Done ends
    // editing; dd 2026-10-04: + only adds).
    row = await write('(g) Tags', async () => {
        await tap(tagged(await revealTag('project-tag-picker'), 'project-tag-picker'));
        nodes = await waitFor('the tag picker', (current) => Boolean(tagged(current, 'project-tag-input')), 15_000);
        await typeText(tagged(nodes, 'project-tag-input'), names.tag);
        await tap(tagged(await screen(), 'project-tag-add'));
    }, (current) => current.tags.join() === `#${names.tag}`);
    for (const [label, send] of [['the keyboard\'s Done', () => sh('input keyevent KEYCODE_ENTER')],
        ['+ on a tag the project has', async () => tap(tagged(await screen(), 'project-tag-add'))]]) {
        const tagsBefore = stored('before');
        await typeText(tagged(await screen(), 'project-tag-input'), names.tag);
        await send();
        await sleep(2500);
        const after = stored();
        check(after.rev === tagsBefore.rev && after.tags.join() === `#${names.tag}`, `(g) ${label} stores nothing and keeps the tag`);
    }
    await hideKeyboard();
    // Back only while the picker is still up (else Back would close the project).
    if (tagged(await screen(), 'project-tag-input')) sh('input keyevent KEYCODE_BACK');
    await waitFor('the tag picker to close', (current) => !tagged(current, 'project-tag-input'), 10_000);

    // (h) Notes: typed; Preview shows the typed draft and stores nothing (RN previews the unsaved notes); Back stores them, as
    // RN's blur on close does.
    const notesBefore = stored('before');
    {
        await tap(tagged(await revealTag('project-notes-toggle'), 'project-notes-toggle'));
        nodes = await revealTag('project-notes-input');
        await typeText(tagged(nodes, 'project-notes-input'), names.notes);
        // RN's KeyboardAvoidingView: with the keyboard up the list is shorter and the field stays in it.
        const typed = await waitFor('the notes field above the keyboard', (current) => {
            const input = tagged(current, 'project-notes-input');
            const list = mainList(current);
            return Boolean(input && list) && box(input)[1] < box(list)[3] && box(input)[1] >= box(list)[1];
        }, 10_000).catch(() => null);
        check(Boolean(typed) && /mInputShown=true/.test(sh('dumpsys input_method')), '(h) the notes field stays in view above the open keyboard');
        await hideKeyboard();
        await tap(tagged(await revealTag('project-notes-mode'), 'project-notes-mode'));
    }
    nodes = await waitFor('core\'s preview of the typed notes', (current) => Boolean(tagged(current, 'project-notes-preview')) && hasText(current, names.notes), 15_000);
    await sleep(1500);
    check(stored().rev === notesBefore.rev && stored().supportNotes !== names.notes, '(h) Preview shows the typed notes and stores nothing');
    await tap(tagged(await revealTag('project-notes-mode'), 'project-notes-mode'));
    await waitFor('the notes field again', (current) => tagged(current, 'project-notes-input')?.text === names.notes, 10_000);
    await tap(button(await screen(), 'Back') ?? fail('no Back in the project header'));
    row = await expectWrite('(h) Back stores the typed notes', notesBefore, (current) => current.supportNotes === names.notes);
    nodes = await openDetails(names.project);

    // (i) Attachments inside Details: Add link, then Remove.
    row = await write('(i) Add link', async () => {
        await tap(tagged(await revealTag('project-attachment-add-link'), 'project-attachment-add-link'));
        nodes = await waitFor('the link sheet', (current) => Boolean(tagged(current, 'attachment-link-input')), 15_000);
        await typeText(tagged(nodes, 'attachment-link-input'), names.link);
        await waitFor('the link typed', (current) => tagged(current, 'attachment-link-input')?.text === names.link, 10_000);
        await tap(tagged(await screen(), 'attachment-link-save') ?? fail('no Save on the link sheet'));
    }, (current) => current.attachmentList.some((item) => item.uri === names.link && !item.deletedAt));
    row = await write('(i) Remove', async () => {
        // The block's rows are read after the write: wait for the link's row and its Remove.
        nodes = await revealIn((current) => Boolean(textNode(current, en['attachments.remove'])), 'the link row\'s Remove');
        await tap(textNode(nodes, en['attachments.remove']));
    }, (current) => current.attachmentList.some((item) => item.uri === names.link && item.deletedAt));

    // (j) Dates: the picker's OK takes the day it opens on (today for an empty date); then Clear.
    const today = localDay();
    row = await write('(j) Start date', async () => { await tap(tagged(await revealTag('project-start-date-picker'), 'project-start-date-picker')); await pickToday(); },
        (current) => current.startDate === today);
    row = await write('(j) Due date', async () => { await tap(tagged(await revealTag('project-due-date-picker'), 'project-due-date-picker')); await pickToday(); },
        (current) => current.dueDate === today);
    const reviewStart = Date.now();
    row = await write('(j) Review date', async () => { await tap(tagged(await revealTag('project-review-date-picker'), 'project-review-date-picker')); await pickToday(); },
        (current) => Boolean(current.reviewAt));
    // RN's picker keeps the time of day it opened on (now): an instant within a minute of the tap, on today's date.
    // RN's Android picker answers the hour and minute it opened on, seconds and milliseconds 0.
    check(Math.abs(Date.parse(row.reviewAt) - reviewStart) < 120_000 && /:00\.000Z$/.test(row.reviewAt), `(j) Review date stored at the opened hour and minute, seconds 0: ${row.reviewAt}`);
    row = await write('(j) Clear Start date', async () => {
        nodes = await revealTag('project-start-date-picker');
        await tap(withDescription(nodes, `${en['common.clear']} ${en['taskEdit.startDateLabel']}`) ?? fail('no Clear beside Start Date'));
    }, (current) => current.startDate === null);

    // (k) The title: edited in the header, stored on Done.
    row = await write('(k) Title', async () => {
        nodes = await revealIn((current) => Boolean(tagged(current, 'project-title-input')), 'the title');
        await typeText(tagged(nodes, 'project-title-input'), names.renamed);
        sh('input keyevent KEYCODE_ENTER');
    }, (current) => current.title === names.renamed);
    await hideKeyboard();
    // A typed title Back leaves with is stored too (RN's end of editing on close); then Done names it back.
    const titleBefore = stored('before');
    nodes = await revealIn((current) => Boolean(tagged(current, 'project-title-input')), 'the title');
    await typeText(tagged(nodes, 'project-title-input'), names.backTitle);
    await tap(button(await screen(), 'Back') ?? fail('no Back in the project header'));
    row = await expectWrite('(k) Back stores the typed title', titleBefore, (current) => current.title === names.backTitle);
    await hideKeyboard();
    nodes = await openFixture(names.backTitle);
    row = await write('(k) Title again', async () => {
        await typeText(tagged(await screen(), 'project-title-input'), names.renamed);
        sh('input keyevent KEYCODE_ENTER');
    }, (current) => current.title === names.renamed);
    await hideKeyboard();
    await openDetails();

    // (l) Restart replay: stopped before the engine saw it, the boot's replay stores it; stopped after core's reply, the replay
    // stores nothing more.
    let before = stored('before');
    let stopped = await stopAt('before', 'projectEdit', async () => {
        await tap(tagged(await revealTag('project-status-picker'), 'project-status-picker'));
        await tap(tagged(await waitFor('the status menu', (current) => Boolean(tagged(current, 'project-status-menu-item-someday'))), 'project-status-menu-item-someday'));
    });
    check(stored().status === 'waiting', '(l) nothing stored before the engine saw the write');
    let relaunched = await relaunch(stopped);
    check(replayed(relaunched.replay), `(l) the boot replayed the Status commit: ${relaunched.replay.split('journal replay ')[1]}`);
    row = stored();
    check(row.status === 'someday' && row.rev === before.rev + 1, `(l) the replay stored Someday once (rev ${before.rev} → ${row.rev})`);
    processId = relaunched.processId;
    await openDetails();
    before = stored('before');
    stopped = await stopAt('after', 'projectEdit', async () => {
        await tap(tagged(await revealTag('project-tag-picker'), 'project-tag-picker'));
        nodes = await waitFor('the tag picker', (current) => Boolean(tagged(current, 'project-tag-input')), 15_000);
        await typeText(tagged(nodes, 'project-tag-input'), names.replayTag);
        await tap(tagged(await screen(), 'project-tag-add'));
    });
    relaunched = await relaunch(stopped);
    check(replayed(relaunched.replay), `(l) the boot replayed the Tags commit core had answered: ${relaunched.replay.split('journal replay ')[1]}`);
    row = stored();
    check(row.tags.includes(`#${names.replayTag}`) && row.rev === before.rev + 1, `(l) the tag stored once through the replay (rev ${before.rev} → ${row.rev})`);
    processId = relaunched.processId;

    // (l) A typed title (stored when the notes field takes the focus), then typed notes and Back, killed before the engine
    // sees the notes: Back journaled them at once, so the boot's replay stores them; the title and the notes are stored once each.
    nodes = await openDetails();
    before = stored('before');
    nodes = await revealIn((current) => Boolean(tagged(current, 'project-title-input')), 'the title');
    await typeText(tagged(nodes, 'project-title-input'), names.killTitle);
    await tap(tagged(await revealTag('project-notes-toggle'), 'project-notes-toggle'));
    // The notes field takes the focus: the title lets go and is stored (the fields lock while it saves).
    await tap(tagged(await revealTag('project-notes-input'), 'project-notes-input'));
    await waitFor('the title stored', () => stored().title === names.killTitle, 30_000);
    await waitFor('the notes field free again', (current) => tagged(current, 'project-notes-input')?.enabled === 'true', 15_000);
    await typeText(tagged(await revealTag('project-notes-input'), 'project-notes-input'), names.killNotes);
    await waitFor('the notes typed', (current) => tagged(current, 'project-notes-input')?.text === names.killNotes, 10_000);
    stopped = await stopAt('before', 'projectEdit', async () => tap(button(await screen(), 'Back') ?? fail('no Back in the project header')));
    check(stored().supportNotes !== names.killNotes, '(l) the notes were not stored before the process died');
    relaunched = await relaunch(stopped);
    check(replayed(relaunched.replay), `(l) the boot replayed the notes Back journaled: ${relaunched.replay.split('journal replay ')[1]}`);
    row = stored();
    check(row.title === names.killTitle && row.supportNotes === names.killNotes && row.rev === before.rev + 2,
        `(l) the typed title and notes were stored once each (rev ${before.rev} → ${row.rev})`);
    processId = relaunched.processId;
    nodes = await openFixture(names.killTitle);
    row = await write('(l) Title named back', async () => {
        await typeText(tagged(await screen(), 'project-title-input'), names.renamed);
        sh('input keyevent KEYCODE_ENTER');
    }, (current) => current.title === names.renamed);
    await hideKeyboard();

    // (m) After the restarts: the reopened Details shows core's labels for every stored value.
    nodes = await openDetails();
    metadata = coreMetadata('m');
    for (const label of [metadata.statusLabel, metadata.typeLabel, metadata.sequentialScopeLabel ?? '', metadata.areaLabel, metadata.tagsLabel,
        metadata.dueDateLabel, metadata.reviewDateLabel]) {
        const found = await revealIn((current) => current.some((node) => node.text === label || (node['content-desc'] ?? '').endsWith(`: ${label}`)), label);
        check(Boolean(found), `(m) Details shows core's "${label}"`);
    }
    check(metadata.sections.length === 1 && metadata.sections[0].title === names.edited, '(m) core lists the one stored section');
    check(pid() === processId && !bootFailure(await screen()), '(m) one process since the last replay, no boot failure');
    // (n) Clear Due and Review: each stored once, and the fixture leaves no project due for review or due today in the shared
    // development data (Focus's "Projects to review" and the other checks' lists stay as they were).
    for (const [field, label] of [['dueDate', en['taskEdit.dueDateLabel']], ['reviewAt', en['projects.reviewAt']]]) {
        row = await write(`(n) Clear ${label}`, async () => {
            nodes = await revealIn((current) => Boolean(withDescription(current, `${en['common.clear']} ${label}`)), `Clear ${label}`);
            await tap(withDescription(nodes, `${en['common.clear']} ${label}`));
        }, (current) => current[field] === null);
    }
    console.log('Project details device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
