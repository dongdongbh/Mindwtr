// Global search check for the isolated native Android development app.
//
//   node apps/android-native/scripts/check-search-device.mjs <adb-serial> [apk]
//
// Installs the debug APK with `install -r` (existing development data stays), captures one
// task with a title unique to this run, and checks RN's search screen against core's own
// searchTasks on a copy of the app's database: (a) the header's Search opens it and the
// title finds core's one result; (b) the Inbox status filter keeps it and its active chip
// clears it again; (c) the result opens the editor and Close returns to the search; (d) Mark
// Done stores `done` once and core's hidden-matches line shows; (e) Save Search stores one
// saved search for a fixed query (a second run finds it and adds none); (f) Back returns to
// the Inbox; (g) a project hit opens that project (RN's 006c4babf): a live project with a digits-only title (the capture check's
// 5600 when it is there) is searched, its Project row tapped, and its screen shows its title. It touches only the development package (it refuses any other APK), never
// launches over another app, restores rotation and clears its debug properties on exit.
// Leave the device on its home screen before running. It needs host `bun`.
// Exit 0 = pass, 1 = fail, 2 = refused before touching the device, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { box, button, chipOn, check, connect, draftText, evidenced, fail, field, inEditor, inboxCount, isOn, Stopped, tab, tagged, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-search-device.mjs <adb-serial> [apk]');
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
const PROPS = ['fail_commit', 'delay_before_ms', 'delay_after_ms', 'language'];
const DB = 'mindwtr-native-dev.db';
const work = resolve(app, 'android/build/search-check');
const coreSrc = resolve(app, '../../packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));
// Digits only: some phone keyboards hold typed letters in a composition strip.
const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const title = `51${run}`;
// Core keeps one saved search per query, so every run saves this same one.
const SAVED_QUERY = '515151';

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting, type } = device;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
const logs = () => device.logs(pid(), TAG).replace(/\\/g, '');
const commands = (operation) => logs().split('\n').filter((line) => line.includes('native-android-dev-task-command')
    && line.includes(`"operation":"${operation}"`) && line.includes('"outcome":"saved"')).length;

// ---- core on a copy of the app's database ----
const pullDatabase = () => {
    const dir = resolve(work, 'db');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = sh(`run-as ${PKG} ls files`).split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    return resolve(dir, DB);
};
/** Core's searchTasks for [query] with RN's default filters plus [filters], and the store's rows for this run. */
const core = (query, filters = {}) => JSON.parse(execFileSync('bun', ['-e', `
    import { Database } from 'bun:sqlite';
    import { DEFAULT_GLOBAL_SEARCH_FILTERS, SqliteAdapter, createNativeHostContract, setStorageAdapter, useTaskStore } from '${coreSrc}/index.ts';
    const db = new Database(process.env.CHECK_DB);
    setStorageAdapter(new SqliteAdapter({
        run: async (sql, params = []) => { db.query(sql).run(...params); },
        all: async (sql, params = []) => db.query(sql).all(...params),
        get: async (sql, params = []) => db.query(sql).get(...params) ?? undefined,
        exec: async (sql) => { db.exec(sql); },
    }));
    const host = createNativeHostContract();
    const ready = await host.activate({ writeSafetyReady: true });
    if (!ready.ok) throw new Error(ready.error.message);
    const found = await host.searchTasks({ query: process.env.CHECK_QUERY, filters: { ...DEFAULT_GLOBAL_SEARCH_FILTERS, ...JSON.parse(process.env.CHECK_FILTERS) }, limit: 50 });
    if (!found.ok) throw new Error(found.error.message);
    const store = useTaskStore.getState();
    console.log(JSON.stringify({
        titles: found.value.tasks.map((task) => task.title),
        hidden: found.value.hiddenCompletedCount,
        stored: store._allTasks.filter((task) => task.title === process.env.CHECK_TITLE && !task.deletedAt).map((task) => task.status),
        saved: (store.settings.savedSearches ?? []).filter((search) => search.query === process.env.CHECK_SAVED).length,
    }));
    process.exit(0);
`], { encoding: 'utf8', env: { ...process.env, CHECK_DB: pullDatabase(), CHECK_QUERY: query, CHECK_FILTERS: JSON.stringify(filters),
    CHECK_TITLE: title, CHECK_SAVED: SAVED_QUERY } }).trim().split('\n').pop());

/** A live, unarchived project whose title is digits only (the keyboard guard types digits), the capture check's 5600 first. */
const digitProject = () => JSON.parse(execFileSync('bun', ['-e', `
    import { Database } from 'bun:sqlite';
    const db = new Database(process.env.CHECK_DB);
    const rows = db.query("SELECT title FROM projects WHERE deletedAt IS NULL AND status != 'archived'").all().map((row) => row.title)
        .filter((title) => /^[0-9]{3,12}$/.test(title));
    console.log(JSON.stringify(rows.includes('5600') ? '5600' : rows.sort()[0] ?? null));
`], { encoding: 'utf8', env: { ...process.env, CHECK_DB: pullDatabase() } }).trim().split('\n').pop());

// ---- UI (core's English) ----
const inbox = () => waitFor('the Inbox', (nodes) => !inEditor(nodes) && !tagged(nodes, 'global-search') && Number.isFinite(inboxCount(nodes)), 60_000);
const inSearch = (nodes) => Boolean(tagged(nodes, 'global-search')) && !inEditor(nodes);
/** The result rows' titles (test tag `search-result`), top to bottom. */
const results = (nodes) => nodes.filter((node) => (node['resource-id'] ?? '').endsWith('search-result')).map((node) => node['content-desc'] || node.text);
/**
 * The filter sheet's scrolling column (the one holding core's Due date chips), scrolled until [description] shows:
 * the sheet lists RN's sections in RN's order, so Status sits below the fold on a phone.
 */
const sheetShowing = async (description) => {
    // A chip just below the fold is still listed, with empty bounds (run 22: [0,0][0,0]); only one fully inside the sheet counts.
    const shown = (nodes) => {
        const node = withDescription(nodes, description);
        const heading = nodes.find((item) => item.text === en['filters.label'] && item.class === 'android.widget.TextView');
        const sheet = heading && nodes.filter((item) => item.scrollable === 'true' && box(item)[1] >= box(heading)[3])
            .sort((a, b) => (box(a)[3] - box(a)[1]) - (box(b)[3] - box(b)[1]))[0];
        if (!node || !sheet) return false;
        const [l, t, r, b] = box(node);
        return r > l && b > t && t >= box(sheet)[1] && b <= box(sheet)[3];
    };
    let nodes = await screen();
    // The sheet lists every context and tag first, so a long-used library needs many swipes: stop once a swipe moves nothing.
    for (let step = 0, last = ''; step < 60 && !shown(nodes); step += 1) {
        const seen = nodes.map((node) => `${node.text}|${node.bounds}`).join(';');
        if (seen === last) break;
        last = seen;
        // The sheet's column starts under its "Filters" heading; the results list behind it starts higher.
        const heading = nodes.find((node) => node.text === en['filters.label'] && node.class === 'android.widget.TextView') ?? fail('no filter sheet');
        const sheet = nodes.filter((node) => node.scrollable === 'true' && box(node)[1] >= box(heading)[3])
            .sort((a, b) => (box(a)[3] - box(a)[1]) - (box(b)[3] - box(b)[1]))[0] ?? fail('no scrolling filter sheet');
        const [l, t, r, b] = box(sheet);
        requireAppFront();
        sh(`input swipe ${Math.round((l + r) / 2)} ${Math.round(b - (b - t) * 0.15)} ${Math.round((l + r) / 2)} ${Math.round(t + (b - t) * 0.15)} 500`);
        await new Promise((done) => setTimeout(done, 500));
        nodes = await screen();
    }
    return shown(nodes) ? nodes : fail(`the filter sheet shows no "${description}"`);
};
/** Types [digits] at the end of the search field (Ctrl+End: the text's true end). */
const typeQuery = async (digits) => {
    await device.focusAtEnd(field(await screen()) ?? fail('no search field'));
    requireAppFront();
    sh(`input text ${digits}`);
};

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const restore = async () => {
    for (const name of PROPS) { try { setProp(name, ''); } catch { /* device gone */ } }
    // Leave the app on its Inbox: the other checks start there.
    try { if (front().includes(`${PKG}/`) && tagged(await screen(), 'global-search')) sh('input keyevent KEYCODE_BACK'); } catch { /* the app is gone */ }
    for (const [name, value] of [['user_rotation', originalRotation], ['accelerometer_rotation', originalAccelerometer]]) {
        try { sh(value === 'null' ? `settings delete system ${name}` : `settings put system ${name} ${value}`); } catch { /* device gone */ }
    }
    try { sh(`rm -f ${UI_FILE}`); } catch { /* device gone */ }
};

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    for (const name of PROPS) setProp(name, '');
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    device.launch(ACTIVITY);
    requireAppFront();
    sh('settings put system accelerometer_rotation 0');
    sh('settings put system user_rotation 0');
    let nodes = await inbox();
    const total = inboxCount(nodes);
    await type(title);
    await tapExpecting(button(await screen(), 'Save'), (current) => draftText(current) === '' || button(current, 'Save')?.enabled === 'false', 'the capture to start');
    await waitFor('the capture', (current) => inboxCount(current) === total + 1 && draftText(current) === '');

    // (a) The header's Search opens RN's screen; the unique title finds exactly core's result.
    nodes = await tapExpecting(withDescription(await screen(), en['search.title']) ?? fail('no Search button in the header'), inSearch, 'the search screen');
    await typeQuery(title);
    nodes = await waitFor(`the result ${title}`, (current) => results(current).includes(title), 20_000);
    let expected = core(title);
    check(JSON.stringify(results(nodes)) === JSON.stringify(expected.titles), `(a) the results are core's: ${JSON.stringify(expected.titles)}`);

    // (b) The Inbox status filter: core keeps the task; its active chip clears the filter again.
    const status = `${en['taskEdit.statusLabel']}: ${en['status.inbox']}`;
    // RN's sheet opens with the keyboard gone (its openFilters blurs the field); Status is below the fold.
    await tapExpecting(withDescription(nodes, en['filters.label']) ?? fail('no Filters button'),
        (current) => Boolean(current.find((node) => node['content-desc']?.startsWith(`${en['search.due.label']}: `))), 'the filter sheet');
    check(!/mInputShown=true/.test(sh('dumpsys input_method')), '(b) the keyboard leaves when the filter sheet opens, as in RN');
    nodes = await sheetShowing(status);
    await tapExpecting(withDescription(nodes, status), (current) => chipOn(current, status), 'the Inbox status chip on');
    nodes = await tapExpecting(withDescription(await screen(), en['common.close']), (current) => !withDescription(current, status) && Boolean(withDescription(current, en['status.inbox'])), 'the active Inbox chip');
    expected = core(title, { selectedStatuses: ['inbox'] });
    nodes = await waitFor('the filtered result', (current) => JSON.stringify(results(current)) === JSON.stringify(expected.titles), 10_000);
    check(expected.titles.includes(title), '(b) the Inbox filter keeps the task, as core does');
    nodes = await tapExpecting(withDescription(nodes, en['status.inbox']), (current) => !withDescription(current, en['status.inbox']), 'the active chip cleared');
    check(results(nodes).includes(title), '(b) clearing the chip keeps the result');

    // (c) The result opens the editor on its View tab (RN's global search: defaultTab "view"); Close returns to the search with its query.
    const row = nodes.find((node) => (node['resource-id'] ?? '').endsWith('search-result') && (node['content-desc'] || node.text) === title);
    nodes = await tapExpecting(row, (current) => inEditor(current) && isOn(withDescription(current, en['markdown.preview']))
        && current.some((node) => node.text === title && node.class !== 'android.widget.EditText'), 'the editor for the result on its View tab');
    nodes = await tapExpecting(withDescription(nodes, en['common.close']) ?? fail('no Close in the editor'), (current) => inSearch(current) && field(current)?.text === title, 'the search again');
    check(results(nodes).includes(title), '(c) Close returns to the search with its query');

    // (d) Mark Done: done is stored once; the result leaves and core's hidden-matches line counts it.
    const doneBefore = commands('complete');
    await tapExpecting(withDescription(nodes, en['review.markDone']) ?? fail('no Mark Done on the result'), (current) => !results(current).includes(title), 'the done result to leave');
    expected = core(title);
    const hiddenLine = en['search.hiddenCompletedMatches'].replace('{{count}}', String(expected.hidden));
    nodes = await waitFor('core\'s hidden-matches line', (current) => current.some((node) => node.text === hiddenLine), 10_000);
    check(JSON.stringify(expected.stored) === '["done"]' && commands('complete') === doneBefore + 1, `(d) Mark Done stored done once (${JSON.stringify(expected.stored)})`);

    // (e) Save Search for the fixed query: one saved search, found again (never added) on later runs.
    nodes = await tapExpecting(withDescription(nodes, en['common.clear']) ?? fail('no Clear in the search field'), (current) => field(current)?.text === '', 'the empty query');
    await typeQuery(SAVED_QUERY);
    nodes = await waitFor('Save Search', (current) => Boolean(button(current, en['search.saveSearch'])), 10_000);
    // Android reports no label on a text field that holds text, so the dialog is the second field, below the search field.
    const edits = (current) => current.filter((node) => node.class === 'android.widget.EditText').sort((a, b) => box(a)[1] - box(b)[1]);
    nodes = await tapExpecting(button(nodes, en['search.saveSearch']), (current) => edits(current).length === 2 && edits(current)[1].text === SAVED_QUERY,
        'the save dialog with the query as its name');
    const savesBefore = commands('saveSearch');
    await tapExpecting(button(nodes, en['common.save']), (current) => edits(current).length === 1, 'the dialog to close');
    await waitFor('the saveSearch command', () => commands('saveSearch') === savesBefore + 1, 10_000);
    check(core(SAVED_QUERY).saved === 1, `(e) core stores exactly one saved search for "${SAVED_QUERY}"`);

    // (f) Back closes the search.
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await inbox();
    check(true, '(f) Back returns to the Inbox');

    // (g) A project hit opens that project: its Project row (a search-result whose subtitle is core's "Project") is tapped.
    const projectTitle = digitProject() ?? fail('no live project with a digits-only title: run check-capture-device first (it creates 5600)');
    nodes = await tapExpecting(withDescription(await screen(), en['search.title']) ?? fail('no Search button in the header'), inSearch, 'the search screen');
    await typeQuery(projectTitle);
    const projectHit = (current) => current.find((node, index) => (node['resource-id'] ?? '').endsWith('search-result')
        && (node['content-desc'] || node.text) === projectTitle && current[index + 1]?.text === en['search.resultProject']);
    nodes = await waitFor(`the project hit ${projectTitle}`, (current) => Boolean(projectHit(current)), 20_000);
    const opened = (current) => tagged(current, 'project-title-input')?.text === projectTitle && !tagged(current, 'global-search');
    nodes = await tapExpecting(projectHit(nodes), opened, `the project ${projectTitle}`);
    check(true, `(g) the project hit ${projectTitle} opened that project's screen`);
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await waitFor('the project screen to close', (current) => !tagged(current, 'project-title-input'), 15_000);
    // The Inbox tab, where the other checks start (Back past the Projects list could leave the app).
    nodes = await waitFor('the tabs', (current) => Boolean(tab(current, en['tab.inbox'])), 15_000);
    await tapExpecting(tab(nodes, en['tab.inbox']), (current) => Number.isFinite(inboxCount(current)), 'the Inbox again');
    console.log('Search device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
