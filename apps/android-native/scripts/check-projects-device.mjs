// Projects check for the isolated native Android development app.
//
//   node apps/android-native/scripts/check-projects-device.mjs <adb-serial> [apk] [--prune-old]
//
// Installs the debug APK with `install -r` (existing development data stays).
// The fixture needs sections and an archived project, which the app cannot make, so the script stops the app and, through
// core's own store (Bun runs core's TypeScript) on a host copy of the app's
// database, prepares ONE fixture found by its stable titles (marker 424242424242):
// a sequential project in its own area with two sections and four tasks, an
// archived project with one task, and a project with 55 tasks. The first run
// INJECTS it; every later run REUSES it and only sets the sequential project's
// tasks back to Next (the run completes two of them), so the development data
// no longer grows. --prune-old also deletes, through core (tombstones), the
// projects and areas earlier versions of this check injected per run (titles
// Area/Seq/Arch/Many plus 12 digits) and their detached tasks (61-66 plus 12 digits),
// and the tasks earlier lifecycle (81-86), focus (71-72) and editor (91, plus its
// renames' 7 and 78) runs captured, each with its 12-digit run id; nothing else is touched. It then checks the Projects tab:
// (a) each project row shows core's task count and next action, and Archived
// ("Closed") starts closed; (b) the open project shows core's section markers,
// rows, and sequence cues in core's order; (c) Done from the project stores
// `done` once; (d) a row opens the editor and Close returns to the project;
// (e) rotation and (f) process death keep the open project; (g) a failed Done
// keeps its exact retry through rotation, Back, and a new screen, then stores
// once; (h) Back returns to the list, which shows core's new count; (i) the
// archived project shows its rows without Done and opens a read-only editor;
// (j) More loads the next window of the 55-task project; (k) the project star
// stores isFocused and a second tap removes it; (l) "Add new project…" with the
// fixture's area chip stores one project (67 plus the marker) in that area (the
// next run's prepare deletes it through core first); (m) the area switcher
// narrows the list to core's projects for the fixture area, and "All areas"
// widens it again (prepare also resets the filter); (n) restored on Focus after process death (the boot reads only the tab
// on screen), with a Focus view-options read held 15 s (debug delay_action_ms), Projects chosen meanwhile fills once the
// read ends, without reopening the tab. Core's expected lists
// come from core's own contract run on a fresh host copy of the database. It
// touches only the development package (it refuses any other APK), never
// launches over another app, leaves the app on its Inbox tab, and restores
// rotation and clears its debug properties on exit. Leave the device on its
// home screen before running. It needs host `sqlite3` and `bun`.
// Exit 0 = pass, 1 = fail, 2 = refused before touching the device, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { besideRow, bootFailure, box, button, check, connect, evidenced, fail, field, hasText, inEditor, isOn, owedRetry, projectTitled, readRetry, Stopped, tab, tabSelected, taskRows, withDescription } from './device.mjs';

const cliArgs = process.argv.slice(2);
const prune = cliArgs.includes('--prune-old');
const [serial, apkArg] = cliArgs.filter((arg) => !arg.startsWith('--'));
if (!serial || cliArgs.some((arg) => arg.startsWith('--') && arg !== '--prune-old')) {
    console.error('usage: node check-projects-device.mjs <adb-serial> [apk] [--prune-old]');
    process.exit(2);
}
const app = resolve(import.meta.dirname, '..');
const apk = apkArg ?? resolve(app, 'android/app/build/outputs/apk/play/debug/app-play-debug.apk');
const adbBin = process.env.ADB ?? '/home/dd/Android/Sdk/platform-tools/adb';
const aapt2 = process.env.AAPT2 ?? '/home/dd/Android/Sdk/build-tools/36.1.0/aapt2';
const PKG = 'tech.dongdongbh.mindwtr.nativeclient.dev';
// Never install anything but the development package (install -r would upgrade it).
const apkPackage = execFileSync(aapt2, ['dump', 'packagename', apk], { encoding: 'utf8' }).trim();
if (apkPackage !== PKG) {
    console.error(`REFUSED: ${apk} is package "${apkPackage}", not ${PKG}`);
    process.exit(2);
}
const ACTIVITY = `${PKG}/${PKG}.MainActivity`;
const TAG = 'MindwtrNativeDev';
const UI_FILE = '/data/local/tmp/mindwtr-native-dev-ui.xml';
const STAGED = '/data/local/tmp/mindwtr-native-dev-projects.db';
// `language` is cleared so the app shows core's English on the (English) test phone.
const PROPS = ['fail_commit', 'delay_before_ms', 'delay_after_ms', 'language', 'delay_action_ms'];
const DB = 'mindwtr-native-dev.db';
const work = resolve(app, 'android/build/projects-check');
const coreSrc = resolve(app, '../../packages/core/src');
// The fixture's stable marker: every run finds the same projects and tasks, so it injects them only once.
// Digits only in task titles (the editor step picks a task by its digits-only title).
const run = '424242424242';
const names = { area: `Area${run}`, sequential: `Seq${run}`, archived: `Arch${run}`, many: `Many${run}`, added: `67${run}` };

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { adbRaw, sh, home, front, requireAppFront, pid, screen, waitFor, tap, reveal, toTop, completeUntil } = device;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
const runAs = (command) => sh(`run-as ${PKG} ${command}`);

// ---- device state ----
const launch = () => device.launch(ACTIVITY);
const logs = (processId) => device.logs(processId, TAG);
const count = (text, needle) => text.split('\n').filter((line) => line.includes(needle)).length;
const boots = (processId) => count(logs(processId), 'Core host boot started');
const recreations = (processId) => count(logs(processId), 'reason=activity-recreate');
const newScreens = (processId) => count(logs(processId), 'reason=new-screen');
// The log's `context` is itself a JSON string, so its quotes arrive escaped.
const completes = (processId, outcome) => logs(processId).replace(/\\/g, '').split('\n').filter((line) => line.includes('native-android-dev-task-command')
    && line.includes('"operation":"complete"') && line.includes(`"outcome":"${outcome}"`)).length;
const setRotation = (rotation) => {
    requireAppFront();
    sh('settings put system accelerometer_rotation 0');
    sh(`settings put system user_rotation ${rotation}`);
};
const rotate = async (rotation) => {
    const processId = pid();
    const before = recreations(processId);
    setRotation(rotation);
    await waitFor(`rotation ${rotation} recreation`, () => recreations(processId) > before, 15_000);
};
const goHome = async () => {
    requireAppFront();
    sh('input keyevent KEYCODE_HOME');
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
};
const stopApp = async () => {
    await device.stopApp();
};

// ---- UI (core's English labels: nav.projects, projects.closed, common.back, common.done, common.more, common.close) ----
const inbox = () => waitFor('the Inbox', (nodes) => tabSelected(nodes, 'Inbox') && !inEditor(nodes) && hasText(nodes, 'Inbox'), 60_000);
const textNode = (nodes, text) => nodes.find((node) => node.text === text && node.class !== 'android.widget.EditText');
/** The open project: the Projects tab, core's project title as the heading, and Back. */
// The header's title is RN's editable title field (ProjectDetails.kt's ProjectTitleField).
const inProject = (nodes, title) => tabSelected(nodes, 'Projects') && !inEditor(nodes) && projectTitled(nodes, title) && Boolean(button(nodes, 'Back'));
const openProject = (title, description = `the project ${title}`) => waitFor(description, (nodes) => inProject(nodes, title), 60_000);
const showTab = async (name) => {
    const nodes = await waitFor('the tabs', (current) => tab(current, name), 60_000);
    if (!tabSelected(nodes, name)) await tap(tab(nodes, name));
    await waitFor(`the ${name} tab`, (current) => tabSelected(current, name), 10_000);
};
const hasError = (nodes) => nodes.some((node) => node.text?.includes('Injected commit failure'));
/** Taps the control labelled [label] until [done] holds; a tap can land while the list still moves, so tap again. */
const tapUntil = async (label, description, done) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const nodes = await screen();
        // The last tap took effect after the wait ran out: tapping again would be a second command
        // (after a failure, its exact retry), so stop here.
        if (attempt > 0 && done(nodes)) return nodes;
        const control = button(nodes, label);
        if (!control && attempt > 0) break; // the first tap took effect; only the wait is left
        await tap(control ?? fail(`no control labelled ${label}`));
        try { return await waitFor(description, done, 8_000); } catch { /* tap again */ }
    }
    return waitFor(description, done, 20_000);
};
/** Scrolls the Projects list to [title] and opens it; a tap can land while the list still moves, so tap again. */
const openRow = async (title) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        // The last tap opened it after the wait ran out: do not tap the detail screen.
        if (attempt > 0 && inProject(await screen(), title)) return screen();
        const nodes = await reveal(title, 80);
        await tap(textNode(nodes, title) ?? fail(`${title} is not on the Projects list`));
        try { return await waitFor(`the project ${title}`, (current) => inProject(current, title), 8_000); } catch { /* tap again */ }
    }
    return openProject(title);
};
/** The content description of the task count on the Projects row titled [title] ("<n> tasks"). */
const rowCount = (nodes, title) => {
    const [, top, , bottom] = box(textNode(nodes, title) ?? fail(`${title} is not on screen`));
    return nodes.find((node) => /^\d+ tasks$/.test(node['content-desc'] ?? '') && box(node)[1] < bottom + 60 && box(node)[3] > top - 20)?.['content-desc'];
};
/** The texts of [expected] as the screen shows them, top to bottom. */
const shownOrder = (nodes, expected) => nodes.filter((node) => expected.includes(node.text) && node.class !== 'android.widget.EditText')
    .sort((a, b) => box(a)[1] - box(b)[1]).map((node) => node.text);

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
/**
 * Runs core's contract on a database copy: `prepare` finds the fixture by its titles (or injects it once) through
 * core's store, resets it, and prints the ids; `projects` and `detail` print core's getProjects row and
 * getProjectDetail items as the app shows them.
 */
const core = (db, mode, extra = {}) => JSON.parse(execFileSync('bun', ['-e', `
    import { Database } from 'bun:sqlite';
    import { SqliteAdapter, createNativeHostContract, flushPendingSave, setStorageAdapter, useTaskStore } from '${coreSrc}/index.ts';
    import { revisionOf } from '${coreSrc}/native-request-receipts.ts';
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
    const value = (result) => { if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message); return result.value; };
    let out;
    if (process.env.CHECK_MODE === 'prepare') {
        const live = (items) => items.filter((item) => !item.deletedAt);
        let pruned = 0;
        const prunedChecks = {};
        if (process.env.CHECK_PRUNE === '1') {
            // The Review organize check's runs it could not clean up (76, a 12-digit run id): its six tasks (1-6) first, then its
            // project (9), then its two areas (0 and 7).
            {
                const ids = live(store()._allTasks).filter((item) => /^76[0-9]{12}[1-6]$/.test(item.title)).map((item) => item.id);
                if (ids.length > 0) {
                    const result = await store().batchDeleteTasks(ids);
                    if (!result.success) throw new Error('prune failed: ' + result.error);
                    await flushPendingSave();
                }
                prunedChecks.reviewOrganize = ids.length;
                for (const project of live(store()._allProjects).filter((item) => /^76[0-9]{12}9$/.test(item.title))) {
                    const result = await store().deleteProject(project.id);
                    if (!result.success) throw new Error('prune failed: ' + result.error);
                    await flushPendingSave();
                    pruned += 1;
                }
                for (const area of live(store()._allAreas).filter((item) => /^76[0-9]{12}[07]$/.test(item.name))) {
                    const result = await store().deleteArea(area.id);
                    if (!result.success) throw new Error('prune failed: ' + result.error);
                    await flushPendingSave();
                    pruned += 1;
                }
            }
            // The capture screen check's project (79, a 12-digit run id, 9), created from each run's capture link.
            for (const project of live(store()._allProjects).filter((item) => /^79[0-9]{12}9$/.test(item.title))) {
                const result = await store().deleteProject(project.id);
                if (!result.success) throw new Error('prune failed: ' + result.error);
                await flushPendingSave();
                pruned += 1;
            }
            // The attachments check's projects (A2 project, a 12-digit run id): their synced files point at a WebDAV folder that
            // ended with its run, so a live one would refuse the next run's new folder (core's activation proof).
            for (const project of live(store()._allProjects).filter((item) => /^A2 project [0-9]{12}$/.test(item.title))) {
                const result = await store().deleteProject(project.id);
                if (!result.success) throw new Error('prune failed: ' + result.error);
                await flushPendingSave();
                pruned += 1;
            }
            // Only what earlier versions of this check injected per run: its four title shapes with a 12-digit run id.
            // [0-9], not \\d: this code sits in a template literal, which drops the backslash.
            for (const project of live(store()._allProjects).filter((item) => /^(Seq|Arch|Many)[0-9]{12}$/.test(item.title) && !item.title.endsWith(names.run))) {
                const result = await store().deleteProject(project.id);
                if (!result.success) throw new Error('prune failed: ' + result.error);
                await flushPendingSave();
                pruned += 1;
            }
            // The settings and editor check's per-run area (70, a 12-digit run id, 2) goes too, and the Mind Sweep and saved search
            // check's (75, a 12-digit run id, 4).
            for (const area of live(store()._allAreas).filter((item) => (/^Area[0-9]{12}$/.test(item.name) && !item.name.endsWith(names.run)) || /^70[0-9]{12}2$/.test(item.name)
                || /^75[0-9]{12}4$/.test(item.name))) {
                const result = await store().deleteArea(area.id);
                if (!result.success) throw new Error('prune failed: ' + result.error);
                await flushPendingSave();
                pruned += 1;
            }
            // Deleting a project detaches its tasks, so the old runs' tasks stay as loose next actions:
            // tombstone them by their title shape (61-66, a 12-digit run id, an optional index).
            const oldTasks = live(store()._allTasks).filter((item) => {
                const match = /^6[1-6]([0-9]{12})([0-9]{2})?$/.exec(item.title);
                return match !== null && match[1] !== names.run;
            }).map((item) => item.id);
            if (oldTasks.length > 0) {
                const result = await store().batchDeleteTasks(oldTasks);
                if (!result.success) throw new Error('prune failed: ' + result.error);
                await flushPendingSave();
                pruned += oldTasks.length;
            }
            // The other checks' captures from earlier runs, by each script's exact title shape (a 12-digit run id):
            // lifecycle 81-86, focus 71-72, editor 91 (plus the 7 and 78 its renames append), search 51, Process Inbox 52, capture 53-59 (57 appends a line number),
            // menu 60 (plus the 1-6 of its five captures and its Someday task), review 67 (plus the 1-4 of its four captures),
            // calendar and board 68 (plus the 1-2 of its two captures; the Board's Duplicate keeps the title), toolbars 69 (plus the 1-6 of its six captures),
            // settings and editor 70 (plus the 1 of its injected Done list task), Mind Sweep and saved search 75 (plus the 1 of its
            // injected task and the 2-3 of its two captures), entry points 77 (plus the 1 of its shared text; 2 to 8 are never saved),
            // the capture screen 79 (plus the 0-8 of its captures; 3 and 4 are never saved),
            // the runner 80 (plus the 1-9 of its captures), the widgets 94 (plus the 1-6 of its captures),
            // sync 93 (plus the 1-4 of its four captures) and its two emoji titles (a 12-digit run id after them), attachments 94,
            // reminders 87 (plus one digit; its recurring task's next instance stays due, under Focus's Today, after every run).
            // No other title matches. [0-9], not \\d: this code sits in a template literal, which drops the backslash.
            const shapes = {
                lifecycle: /^8[1-6][0-9]{12}$/,
                focus: /^7[12][0-9]{12}$/,
                editor: /^91[0-9]{12}(7(8)?)?$/,
                search: /^51[0-9]{12}$/,
                processInbox: /^52[0-9]{12}$/,
                capture: /^5[3-9][0-9]{12}[12]?$/,
                menu: /^60[0-9]{12}[1-6]$/,
                review: /^67[0-9]{12}[1-4]$/,
                calendarBoard: /^68[0-9]{12}[12]$/,
                toolbars: /^69[0-9]{12}[1-6]$/,
                settingsEditor: /^70[0-9]{12}1$/,
                sweepSaved: /^75[0-9]{12}[1-3]$/,
                entryPoints: /^77[0-9]{12}[1-8]$/,
                captureModal: /^79[0-9]{12}[0-8]$/,
                sync: /^(93[0-9]{12}[1-4]|(Sync ✓ Grüße|Cloud ✓ 雲) 😀 [0-9]{12})$/,
                runner: /^80[0-9]{12}[1-9]$/,
                attachments: /^94[0-9]{12}$/,
                widgets: /^94[0-9]{12}[1-6]$/,
                reminders: /^87[0-9]{12}[0-9]$/,
            };
            for (const [check, shape] of Object.entries(shapes)) {
                const ids = live(store()._allTasks).filter((item) => shape.test(item.title)).map((item) => item.id);
                if (ids.length > 0) {
                    const result = await store().batchDeleteTasks(ids);
                    if (!result.success) throw new Error('prune failed: ' + result.error);
                    await flushPendingSave();
                }
                prunedChecks[check] = ids.length;
            }
            // The Mind Sweep and saved search check's saved search (75, a 12-digit run id, 0), left by a run that stopped before its Delete.
            const searches = store().settings.savedSearches ?? [];
            const keptSearches = searches.filter((search) => !/^75[0-9]{12}0$/.test(search.name));
            if (keptSearches.length !== searches.length) {
                await store().updateSettings({ savedSearches: keptSearches });
                await flushPendingSave();
            }
            prunedChecks.savedSearches = searches.length - keptSearches.length;
        }
        // Every run starts from RN's defaults for what it changes: all areas, the fixture unstarred, no project it added.
        value(await host.setAreaFilter({ included: [], excluded: [] }));
        // This check reads the Projects tab: RN's quick-access view set to Projects (RN's default is Review, which takes the slot).
        if (store().settings.appearance?.mobileQuickAccessView !== 'projects') {
            await store().updateSettings({ appearance: { mobileQuickAccessView: 'projects' } });
            await flushPendingSave();
        }
        for (const project of live(store()._allProjects).filter((item) => item.title === names.added)) {
            const result = await store().deleteProject(project.id);
            if (!result.success) throw new Error('removing the added project failed: ' + result.error);
            await flushPendingSave();
        }
        for (const project of live(store()._allProjects).filter((item) => [names.sequential, names.many].includes(item.title) && item.isFocused)) {
            value(await host.setProjectFocus({ id: project.id, focused: false, projectRevision: revisionOf(project) }));
        }
        const areaId = () => live(store()._allAreas).find((area) => area.name === names.area)?.id;
        const find = (title) => live(store()._allProjects).filter((project) => project.title === title);
        const found = [names.sequential, names.archived, names.many].map(find);
        if (found.some((list) => list.length > 1)) throw new Error('the fixture project titles are not unique');
        if (found.every((list) => list.length === 1)) {
            const [sequential, archived, many] = found.map(([project]) => project);
            // Reset: the run completes two of the sequential project's tasks; put all four back to Next.
            let reset = 0;
            for (const task of live(store()._allTasks).filter((item) => item.projectId === sequential.id && item.status !== 'next')) {
                const result = await store().updateTask(task.id, { status: 'next' });
                if (!result.success) throw new Error('reset failed: ' + result.error);
                await flushPendingSave(); // one save at a time: core's incremental saves share one SQLite connection
                reset += 1;
            }
            await flushPendingSave();
            if (store().persistenceFailure) throw new Error('save failed: ' + store().persistenceFailure.message);
            out = { reused: true, reset, pruned, prunedChecks, sequential: sequential.id, archived: archived.id, many: many.id, area: areaId() };
        } else if (found.some((list) => list.length === 1)) {
            throw new Error('only part of the fixture is in the database; restore or remove it by hand');
        } else {
            const add = async (title, props) => {
                const result = await store().addTask(title, { status: 'next', ...props });
                if (!result.success || !result.id) throw new Error('addTask failed: ' + result.error);
                return result.id;
            };
            const area = await store().addArea(names.area);
            const sequential = await store().addProject(names.sequential, '#3b82f6', { areaId: area.id, isSequential: true });
            const first = await store().addSection(sequential.id, 'S1' + names.run);
            const second = await store().addSection(sequential.id, 'S2' + names.run);
            await add('61' + names.run, { projectId: sequential.id, sectionId: first.id });
            await add('62' + names.run, { projectId: sequential.id, sectionId: first.id });
            await add('63' + names.run, { projectId: sequential.id, sectionId: second.id });
            await add('64' + names.run, { projectId: sequential.id });
            const archived = await store().addProject(names.archived, '#64748b');
            await add('65' + names.run, { projectId: archived.id });
            const archivedResult = await store().updateProject(archived.id, { status: 'archived' });
            if (!archivedResult.success) throw new Error('archive failed: ' + archivedResult.error);
            const many = await store().addProject(names.many, '#10b981');
            for (let index = 0; index < 55; index += 1) await add('66' + names.run + String(index).padStart(2, '0'), { projectId: many.id });
            await flushPendingSave();
            if (store().persistenceFailure) throw new Error('save failed: ' + store().persistenceFailure.message);
            out = { reused: false, reset: 0, pruned, prunedChecks, sequential: sequential.id, archived: archived.id, many: many.id, area: area.id };
        }
    } else if (process.env.CHECK_MODE === 'groups') {
        const view = value(host.getProjects());
        out = { areas: view.active.map((group) => group.areaId), titles: view.active.flatMap((group) => group.projects.map((row) => row.title)) };
    } else if (process.env.CHECK_MODE === 'projects') {
        const view = value(host.getProjects());
        out = [...view.active, ...view.deferred, ...view.archived].flatMap((group) => group.projects).find((row) => row.id === process.env.CHECK_PROJECT);
    } else {
        const detail = value(host.getProjectDetail({ projectId: process.env.CHECK_PROJECT, offset: 0, limit: 100 }));
        out = {
            readOnly: detail.readOnly,
            total: detail.total,
            items: detail.items.map((item) => (item.type === 'section'
                ? { text: item.title + ' · ' + item.count }
                : { text: item.row.title, cue: item.sequenceCue })),
        };
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    console.log(JSON.stringify(out));
    process.exit(0);
`], {
    encoding: 'utf8', maxBuffer: 64 << 20,
    env: { ...process.env, CHECK_DB: db, CHECK_MODE: mode, CHECK_NAMES: JSON.stringify({ ...names, run }), CHECK_PRUNE: prune ? '1' : '', ...extra },
}).trim().split('\n').pop());
const CUES = { available: 'Available next action', later: 'Later in sequence' }; // core's en projects.availableNextAction / laterInSequence
let ids = {};
const coreDetail = (label, project) => core(pullDatabase(label), 'detail', { CHECK_PROJECT: project });
const coreRow = (label, project) => core(pullDatabase(label), 'projects', { CHECK_PROJECT: project });
const storedProjects = (title) => sqlite(pullDatabase('project'), `SELECT id, areaId, isFocused FROM projects WHERE title = '${title}' AND deletedAt IS NULL`);
const storedTask = (title) => sqlite(pullDatabase('task'), `SELECT status, rev FROM tasks WHERE title = '${title}' AND deletedAt IS NULL`);
/** The open project shows core's items in core's order, and each cue under its row. */
const expectCoreOrder = (nodes, detail, label) => {
    const expected = detail.items.map((item) => item.text);
    const shown = shownOrder(nodes, expected);
    check(isDeepStrictEqual(shown, expected), `${label} shows core's ${expected.length} items in core's order${isDeepStrictEqual(shown, expected) ? '' : `: ${JSON.stringify(shown)} vs core ${JSON.stringify(expected)}`}`);
    for (const [cue, text] of Object.entries(CUES)) {
        const want = detail.items.filter((item) => item.cue === cue).length;
        const got = nodes.filter((node) => node.text === text).length;
        check(got === want, `${label} shows core's "${cue}" cue ${want} time(s) (screen ${got})`);
    }
};

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const restore = async () => {
    for (const name of PROPS) { try { setProp(name, ''); } catch { /* device gone */ } }
    // Leave the app on its Inbox tab with no project open: the other checks start there.
    try {
        if (front().includes(`${PKG}/`)) {
            let nodes = await screen();
            if (button(nodes, 'Back') && tabSelected(nodes, 'Projects')) { sh('input keyevent KEYCODE_BACK'); await sleep(1000); nodes = await screen(); }
            if (tab(nodes, 'Inbox') && !tabSelected(nodes, 'Inbox')) await tap(tab(nodes, 'Inbox'));
        }
    } catch { /* the app is gone */ }
    for (const [name, value] of [['user_rotation', originalRotation], ['accelerometer_rotation', originalAccelerometer]]) {
        try { sh(value === 'null' ? `settings delete system ${name}` : `settings put system ${name} ${value}`); } catch { /* device gone */ }
    }
    try { sh(`rm -f ${UI_FILE} ${STAGED}`); } catch { /* device gone */ }
};

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})${sh('getprop ro.boot.qemu.avd_name') ? ` / AVD ${sh('getprop ro.boot.qemu.avd_name')}` : ''}`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    for (const name of PROPS) setProp(name, '');

    // Setup: upgrade-install, boot once (so the database has this build's schema), stop, prepare the fixture.
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) {
        throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    }
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    launch();
    await showTab('Inbox');
    setRotation(0);
    await inbox();
    await stopApp();
    const db = pullDatabase('inject');
    ids = core(db, 'prepare');
    // Only the main file goes back, so core's checkpoint must have moved every frame into it.
    check(!existsSync(`${db}-wal`) || statSync(`${db}-wal`).size === 0, 'the injected rows are all in the main database file');
    adbRaw('push', db, STAGED);
    try { runAs(`cp ${STAGED} files/${DB}`); } finally { sh(`rm -f ${STAGED}`); }
    runAs(`rm -f files/${DB}-wal files/${DB}-shm`);
    console.log(ids.reused
        ? `REUSED: the fixture ${names.sequential}, ${names.archived}, ${names.many}; ${ids.reset} task(s) set back to Next through core's store`
        : `INJECTED (once): through core's store, area ${names.area}; sequential project ${names.sequential} (sections S1${run}, S2${run}; tasks 61-64${run}); archived project ${names.archived} (task 65${run}); project ${names.many} (55 tasks 66${run}00-54)`);
    if (prune) {
        console.log(`PRUNED: ${ids.pruned} project(s), area(s) and task(s) earlier runs injected, deleted through core's store`);
        console.log(`PRUNED: earlier runs' captures, tombstoned through core's store: ${Object.entries(ids.prunedChecks).map(([name, n]) => `${name} ${n}`).join(', ')}`);
    }

    launch();
    let nodes = await inbox();
    let processId = pid();
    check(boots(processId) === 1 && !bootFailure(nodes), 'boot validation passed on the injected database');

    // (a) The list: core's count and next action on the row; the area header above it; Archived starts closed.
    await showTab('Projects');
    let row = coreRow('a', ids.sequential);
    nodes = await reveal(names.sequential, 80);
    // Found at the top edge, the row's area header can sit just above the screen: one drag toward the top shows both.
    if (!textNode(nodes, names.area)) await device.swipe(nodes, 'up');
    nodes = await waitFor(`${names.sequential} with its area`, (current) => textNode(current, names.sequential) && textNode(current, names.area));
    check(box(textNode(nodes, names.area))[1] < box(textNode(nodes, names.sequential))[1], `(a) ${names.sequential} is under core's area ${names.area}`);
    check(rowCount(nodes, names.sequential) === `${row.activeTaskCount} tasks`, `(a) the row shows core's count: ${row.activeTaskCount} tasks`);
    const startCount = row.activeTaskCount;
    check(Boolean(row.nextActionTitle) && hasText(nodes, `↳ ${row.nextActionTitle}`), `(a) the row shows core's next action ${row.nextActionTitle}`);
    // Archived is core's last group, so a closed "Closed" is the list's last row: nothing is listed below it.
    nodes = await reveal('Closed', 80);
    const closedBottom = box(textNode(nodes, 'Closed') ?? fail('no "Closed" group on the list'))[3];
    // Only the list's own rows count: the tab bar below the list has labels too (a list that fits is not scrollable).
    const listBottom = box(tab(nodes, 'Inbox') ?? fail('no tab bar on the Projects tab'))[1];
    const below = nodes.filter((node) => node.package === PKG && node.text && box(node)[1] >= closedBottom && box(node)[3] <= listBottom);
    check(below.length === 0, `(a) Archived ("Closed") is closed (RN's default; every run closes it again): nothing is listed below it${below.length ? ` (${below.map((node) => node.text).join(', ')})` : ''}`);

    // (b) The open project: core's section markers, rows, and cues, in core's order.
    nodes = await openRow(names.sequential);
    let detail = coreDetail('b', ids.sequential);
    check(!detail.readOnly && detail.total === detail.items.length && detail.items.length <= 10, `(b) core lists ${detail.items.length} items`);
    expectCoreOrder(nodes, detail, '(b)');
    const firstTask = detail.items.find((item) => item.cue === 'available')?.text ?? fail('core marks no available task');

    // (c) Done from the project: the row leaves, done is stored once, and the project matches core again.
    const beforeDone = storedTask(firstTask)[0];
    const savedBefore = completes(processId, 'saved');
    nodes = await completeUntil(firstTask, `${firstTask} to leave the project`, (current) => inProject(current, names.sequential) && !textNode(current, firstTask));
    const afterDone = storedTask(firstTask);
    check(afterDone.length === 1 && afterDone[0].status === 'done' && afterDone[0].rev === beforeDone.rev + 1, `(c) ${firstTask} stored done in one write`);
    check(completes(processId, 'saved') === savedBefore + 1, '(c) task-command log shows one operation=complete saved');
    detail = coreDetail('c', ids.sequential);
    expectCoreOrder(await screen(), detail, '(c) after Done,');

    // (d) A row opens the editor on its View tab (RN's resolveTaskOpenTab); Close returns to the open project.
    const editTask = detail.items.find((item) => item.cue !== undefined && item.text !== firstTask && /^\d+$/.test(item.text))?.text
        ?? fail('core lists no task to edit');
    nodes = await tapUntil(editTask, `the editor for ${editTask} on its View tab`, (current) => inEditor(current) && isOn(withDescription(current, 'Preview')) && hasText(current, editTask));
    await tap(button(nodes, 'Close'));
    await openProject(names.sequential, 'the project after Close');
    check(true, '(d) the editor opened from the project on its View tab, and Close returned to it');

    // (e) Rotation keeps the open project, on the same process and host.
    await rotate(1);
    nodes = await openProject(names.sequential, 'the project in landscape');
    check(hasText(nodes, editTask) || hasText(await toTop(), editTask), '(e) landscape: the project is still open with its rows');
    await rotate(0);
    nodes = await openProject(names.sequential, 'the project in portrait');
    check(pid() === processId && boots(processId) === 1, '(e) portrait: same process, one host boot');

    // (f) Home, process death, relaunch: the open project comes back with core's rows.
    await goHome();
    await sleep(1500);
    sh(`run-as ${PKG} kill -9 ${processId}`);
    await waitFor('process death', () => pid() !== processId, 10_000);
    launch();
    nodes = await waitFor('the restored project', (current) => inProject(current, names.sequential) && textNode(current, editTask), 60_000);
    processId = pid();
    check(boots(processId) === 1, '(f) the open project restored after process death, one host boot');
    expectCoreOrder(nodes, detail, '(f)');

    // (g) A failed Done keeps only its exact retry across rotation, Back, and a new screen.
    const beforeFailure = storedTask(editTask)[0];
    setProp('fail_commit', '1');
    await completeUntil(editTask, 'the failed Done', hasError);
    const failedProject = async (description, label) => {
        const current = await waitFor(description, (screenNodes) => inProject(screenNodes, names.sequential) && hasError(screenNodes));
        check(Boolean(textNode(current, editTask)), `(g${label}) the row with the owed retry is still shown`);
        // Every row locks with the owed retry; only the failed row's swipe stays on (the same rule, check-boot-gates.mjs).
        const rows = taskRows(current);
        check(rows.length > 0 && rows.every((node) => node.enabled === 'false'), `(g${label}) ${rows.length} rows locked`);
        // The project's Back stays blocked; the failure offers only the owed Done's exact retry, never a plain read refresh.
        check(button(current, 'Back')?.enabled === 'false' && owedRetry(current)?.enabled === 'true' && !readRetry(current),
            `(g${label}) Back blocked; Try again is the owed Done's retry, and no read refresh is offered`);
        check(tab(current, 'Inbox')?.enabled === 'true', `(g${label}) tabs still work`);
    };
    await failedProject('the failure', '');
    check(storedTask(editTask)[0].rev === beforeFailure.rev, '(g) failed commit stored nothing');
    await rotate(1);
    await failedProject('the failure after rotation', ' landscape');
    await rotate(0);
    await failedProject('the failure after rotating back', ' portrait');
    // Back is left to the system while the retry is owed, so it leaves the app.
    for (let attempt = 0; attempt < 2 && front().includes(`${PKG}/`); attempt += 1) {
        sh('input keyevent KEYCODE_BACK');
        await sleep(1500);
    }
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    launch();
    await failedProject('the failure after Back and reopen', ' after Back and reopen');
    // Android 12+ keeps a root Activity on Back, so also finish it: the new screen gets a new
    // ViewModel and must restore the Projects tab, the open project, and the retry from the process.
    const newScreensBefore = newScreens(processId);
    requireAppFront();
    sh(`am start -W -f 0x10008000 -n ${ACTIVITY}`); // NEW_TASK | CLEAR_TASK
    await waitFor('a new screen on the running host', () => newScreens(processId) > newScreensBefore, 15_000);
    await failedProject('the failure on a new screen', ' on a new screen');
    check(pid() === processId && boots(processId) === 1 && storedTask(editTask)[0].rev === beforeFailure.rev,
        '(g) same process and host, still nothing stored before the retry');
    // Reads wait while the retry is owed, so no read failure can have replaced the Done retry.
    check(!logs(processId).includes('lock=storage'), '(g) no read failed while the retry was owed (log has no lock=storage)');
    setProp('fail_commit', '');
    // The failure's Try again re-sends the exact owed Done: one write.
    await device.tapExpecting(owedRetry(await screen()) ?? fail('no Try again for the owed Done'),
        (current) => !hasError(current) && !textNode(current, editTask), 'the retry from Try again');
    const retried = storedTask(editTask)[0];
    check(retried.status === 'done' && retried.rev === beforeFailure.rev + 1 && storedTask(editTask).length === 1, '(g) Try again stored done once');
    check(completes(processId, 'failed') >= 1 && completes(processId, 'saved') >= 1, '(g) task-command log shows the failed and the saved complete');

    // (h) Back returns to the list, which shows core's new count.
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await waitFor('the Projects list', (current) => tabSelected(current, 'Projects') && !button(current, 'Back'));
    row = coreRow('h', ids.sequential);
    nodes = await reveal(names.sequential, 80);
    check(rowCount(nodes, names.sequential) === `${row.activeTaskCount} tasks` && row.activeTaskCount === startCount - 2,
        `(h) Back showed the list; ${names.sequential} shows core's count ${startCount} - 2 = ${row.activeTaskCount}`);

    // (i) The archived project: Closed opens on a tap; rows show without Done; the editor is read-only.
    nodes = await reveal('Closed', 80);
    await tap(button(nodes, 'Closed') ?? textNode(nodes, 'Closed'));
    nodes = await openRow(names.archived);
    detail = coreDetail('i', ids.archived);
    check(detail.readOnly, '(i) core marks the archived project read-only');
    expectCoreOrder(nodes, detail, '(i)');
    // Read-only: RN's status badges show disabled (and the rows have no swipe; check-boot-gates.mjs).
    const badges = nodes.filter((node) => node['content-desc']?.startsWith('Change status.')).map((node) => button(nodes, node['content-desc']) ?? node);
    check(badges.length > 0 && badges.every((node) => node.enabled === 'false'), `(i) ${badges.length} status badges are read-only`);
    nodes = await tapUntil(`65${run}`, 'the read-only editor', (current) => inEditor(current) && button(current, 'Close'));
    check(hasText(nodes, 'Archived project. Reactivate it to edit this task.') && !button(nodes, 'Save'), '(i) the editor is read-only');
    await tap(button(nodes, 'Close'));
    await openProject(names.archived, 'the archived project after Close');
    sh('input keyevent KEYCODE_BACK');
    nodes = await waitFor('the Projects list', (current) => tabSelected(current, 'Projects') && !button(current, 'Back'));
    // Closed stays open on this device (RN keeps it); close it again so the next run starts from RN's default.
    nodes = await reveal('Closed', 80);
    await tap(button(nodes, 'Closed') ?? textNode(nodes, 'Closed'));

    // (j) More: the 55-task project opens at core's first window, and More loads the rest.
    nodes = await openRow(names.many);
    detail = coreDetail('j', ids.many);
    const last = detail.items.at(-1).text;
    check(detail.total > 50 && !hasText(nodes, last), `(j) core lists ${detail.total} items; the last is not loaded yet`);
    nodes = await reveal(last, 80);
    check(hasText(nodes, last) && !button(nodes, 'More'), `(j) More loaded the rest: ${last} shows and More is gone`);
    sh('input keyevent KEYCODE_BACK');
    await waitFor('the Projects list', (current) => tabSelected(current, 'Projects') && !button(current, 'Back'));

    // (k) The project star: core stores isFocused, and a second tap removes it (the fixture stays unstarred).
    nodes = await reveal(names.sequential, 80);
    const star = besideRow(nodes, names.sequential, 'Add to focus') ?? fail(`no "Add to focus" star beside ${names.sequential}`);
    if (star.enabled !== 'true') {
        console.log('skip - (k) core disables the star: the development data already has five starred projects');
    } else {
        await tap(star);
        await waitFor(`${names.sequential} starred`, () => storedProjects(names.sequential)[0]?.isFocused === 1, 15_000);
        check(coreRow('k', ids.sequential).isFocused, `(k) core lists ${names.sequential} as starred`);
        nodes = await reveal(names.sequential, 80);
        await tap(besideRow(nodes, names.sequential, 'Remove from focus') ?? fail(`no "Remove from focus" star beside ${names.sequential}`));
        await waitFor(`${names.sequential} unstarred`, () => storedProjects(names.sequential)[0]?.isFocused === 0, 15_000);
        check(true, '(k) the second tap stored the removal');
    }

    // (l) Add new project…: type a title, pick the fixture's area chip, tap +; core stores one project in that area.
    check(storedProjects(names.added).length === 0, `(l) no ${names.added} project before the add`);
    nodes = await toTop();
    await tap(field(nodes) ?? fail('no "Add new project…" field'));
    requireAppFront();
    sh(`input text ${names.added}`);
    nodes = await waitFor('the typed project title and the area chips', (current) => field(current)?.text === names.added
        && current.some((node) => node.text === names.area && node.clickable === 'true'), 10_000);
    // The chip is the first "Area…" on screen: the area header sits lower in the list.
    const chip = nodes.filter((node) => node.text === names.area && node.clickable === 'true').sort((a, b) => box(a)[1] - box(b)[1])[0];
    await tap(chip);
    await tap(button(await screen(), 'Add') ?? fail('no Add button'));
    await waitFor('the field to clear', (current) => field(current)?.text === '' || field(current)?.text === 'Add new project...', 15_000);
    const added = storedProjects(names.added);
    check(added.length === 1 && added[0].areaId === ids.area, `(l) core stored ${names.added} once, in ${names.area}`);

    // (m) The area switcher: the fixture's area alone narrows the list to core's projects for it; "All areas" widens it again.
    const openSheet = async () => {
        const current = await waitFor('the area switcher', (screenNodes) => screenNodes.some((node) => node['content-desc']?.startsWith('Area filter: ')), 10_000);
        await tap(current.find((node) => node['content-desc']?.startsWith('Area filter: ')));
        return waitFor('the area sheet', (screenNodes) => hasText(screenNodes, 'All areas'), 10_000);
    };
    nodes = await openSheet();
    // The sheet is drawn last, so its option is the last node with the area's name.
    await tap(nodes.filter((node) => node.text === names.area).at(-1));
    // Core's summary for one included area is its name; the trigger speaks it.
    await waitFor('the trigger to name the area', (current) => current.some((node) => node['content-desc'] === `Area filter: ${names.area}`), 15_000);
    sh('input keyevent KEYCODE_BACK');
    const narrowed = core(pullDatabase('m'), 'groups');
    check(narrowed.areas.length === 1 && narrowed.areas[0] === ids.area, `(m) core narrows Projects to ${names.area}`);
    nodes = await toTop();
    check(hasText(nodes, names.sequential) && !hasText(nodes, names.many), `(m) the list shows ${names.sequential} and not ${names.many}, as core does`);
    nodes = await openSheet();
    await tap(textNode(nodes, 'All areas'));
    await waitFor('the trigger to say All', (current) => current.some((node) => node['content-desc']?.startsWith('Area filter: All areas')), 15_000);
    sh('input keyevent KEYCODE_BACK');
    check(core(pullDatabase('m2'), 'groups').titles.includes(names.many), '(m) "All areas" widens core\'s list again');

    // (n) Startup review 1: the boot leaves Projects for later when Focus shows. Chosen while a user action runs, Projects must
    // still fill when that action ends (its read waits for idle; it is never dropped).
    await showTab('Focus');
    processId = pid();
    await goHome();
    await sleep(1500);
    sh(`run-as ${PKG} kill -9 ${processId}`);
    await waitFor('process death', () => pid() !== processId, 10_000);
    // Long enough for the Done tap and the tab switch, each through a UI dump of a few seconds.
    const HOLD_MS = 15_000;
    setProp('delay_action_ms', String(HOLD_MS));
    launch();
    nodes = await waitFor('Focus restored with its View options', (current) => tabSelected(current, 'Focus') && button(current, 'View options'), 60_000);
    processId = pid();
    await tap(button(nodes, 'View options'));
    // The chosen sort chip: a selectable chip is a checked node (its label is a child), between "SORT" and the group heading.
    const chosenSort = (current) => {
        const top = current.find((node) => node.text === 'SORT');
        const end = current.find((node) => /^GROUP /.test(node.text ?? ''));
        return top && end && current.find((node) => node.checkable === 'true' && node.checked === 'true'
            && box(node)[1] > box(top)[1] && box(node)[3] < box(end)[1]);
    };
    nodes = await waitFor('the view options sheet', (current) => button(current, 'Done') && chosenSort(current), 10_000);
    // The current sort again: a read-only Focus controls request (no command, so no full refresh follows it).
    await tap(chosenSort(nodes));
    const heldAt = Date.now();
    await tap(button(await screen(), 'Done'));
    await showTab('Projects');
    check(Date.now() - heldAt < HOLD_MS, `(n) Projects chosen while the Focus read was held (${Date.now() - heldAt} ms after it started)`);
    const listed = (current) => tabSelected(current, 'Projects') && current.some((node) => /^active projects$/i.test(node.text ?? ''));
    nodes = await waitFor('core\'s projects once the held read ends', listed, HOLD_MS + 20_000);
    check(listed(nodes) && pid() === processId, '(n) Projects filled after the held action, without reopening the tab, on the same process');
    setProp('delay_action_ms', '');

    // Relaunch: boot validation passes on the final data.
    requireAppFront();
    await stopApp();
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    launch();
    await showTab('Inbox');
    nodes = await inbox();
    processId = pid();
    check(boots(processId) === 1 && !bootFailure(nodes), 'relaunch: boot validation passed');
    console.log('Projects device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
