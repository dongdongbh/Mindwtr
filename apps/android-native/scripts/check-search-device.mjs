


import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { box, button, chipOn, check, connect, draftText, evidenced, fail, field, inEditor, inboxCount, isOn, mainList, Stopped, tab, tagged, withDescription } from './device.mjs';

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

const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const title = `51${run}`;

const SAVED_QUERY = '515151';

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting, type } = device;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
const logs = () => device.logs(pid(), TAG).replace(/\\/g, '');
const commands = (operation) => logs().split('\n').filter((line) => line.includes('native-android-dev-task-command')
    && line.includes(`"operation":"${operation}"`) && line.includes('"outcome":"saved"')).length;


const pullDatabase = () => {
    const dir = resolve(work, 'db');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = sh(`run-as ${PKG} ls files`).split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    return resolve(dir, DB);
};

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


const digitProject = () => JSON.parse(execFileSync('bun', ['-e', `
    import { Database } from 'bun:sqlite';
    const db = new Database(process.env.CHECK_DB);
    const rows = db.query("SELECT title FROM projects WHERE deletedAt IS NULL AND status != 'archived'").all().map((row) => row.title)
        .filter((title) => /^[0-9]{3,12}$/.test(title));
    console.log(JSON.stringify(rows.includes('5600') ? '5600' : rows.sort()[0] ?? null));
`], { encoding: 'utf8', env: { ...process.env, CHECK_DB: pullDatabase() } }).trim().split('\n').pop());


const busyQuery = () => JSON.parse(execFileSync('bun', ['-e', `
    import { Database } from 'bun:sqlite';
    const db = new Database(process.env.CHECK_DB);
    const projects = db.query("SELECT title FROM projects WHERE deletedAt IS NULL AND status != 'archived'").all().map((row) => row.title.toLowerCase());
    const tasks = db.query("SELECT title FROM tasks WHERE deletedAt IS NULL").all().map((row) => row.title.toLowerCase());
    const pieces = new Set(projects.flatMap((title) => Array.from({ length: Math.max(0, title.length - 5) }, (_, at) => title.slice(at, at + 6))).filter((piece) => /^[a-z0-9]{6}$/.test(piece)));
    const scored = [...pieces].map((piece) => [piece, projects.filter((title) => title.includes(piece)).length, tasks.filter((title) => title.includes(piece)).length])
        .filter(([, inProjects, inTasks]) => inProjects >= 2 && inTasks >= 15).sort((a, b) => b[2] - a[2] || a[0].localeCompare(b[0]));
    console.log(JSON.stringify(scored[0] ?? null));
`], { encoding: 'utf8', env: { ...process.env, CHECK_DB: pullDatabase() } }).trim().split('\n').pop());


const inbox = () => waitFor('the Inbox', (nodes) => !inEditor(nodes) && !tagged(nodes, 'global-search') && Number.isFinite(inboxCount(nodes)), 60_000);
const inSearch = (nodes) => Boolean(tagged(nodes, 'global-search')) && !inEditor(nodes);

const results = (nodes) => nodes.filter((node) => (node['resource-id'] ?? '').endsWith('search-result')).map((node) => node['content-desc'] || node.text);


const sheetShowing = async (description) => {

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

    for (let step = 0, last = ''; step < 60 && !shown(nodes); step += 1) {
        const seen = nodes.map((node) => `${node.text}|${node.bounds}`).join(';');
        if (seen === last) break;
        last = seen;

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

const typeQuery = async (digits) => {
    await device.focusAtEnd(field(await screen()) ?? fail('no search field'));
    requireAppFront();
    sh(`input text ${digits}`);
};

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const restore = async () => {
    for (const name of PROPS) { try { setProp(name, ''); } catch {                   } }

    try { if (front().includes(`${PKG}/`) && tagged(await screen(), 'global-search')) sh('input keyevent KEYCODE_BACK'); } catch {                       }
    for (const [name, value] of [['user_rotation', originalRotation], ['accelerometer_rotation', originalAccelerometer]]) {
        try { sh(value === 'null' ? `settings delete system ${name}` : `settings put system ${name} ${value}`); } catch {                   }
    }
    try { sh(`rm -f ${UI_FILE}`); } catch {                   }
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
    if (!digitProject()) {
        console.log('note - the library has no digits-only project; capturing a task into a new project 5600');
        await device.capture(`56${run} +5600`);
    }
    if (!busyQuery()) {
        const token = `sq${run.slice(-4)}`;
        console.log(`note - no 6-character piece matches 2 projects and 15 tasks; capturing 15 tasks with "${token}" into 2 new projects`);
        for (let index = 0; index < 15; index += 1) await device.capture(`${token} ${index} +Sx${token}${index % 2 ? 'b' : 'a'}`);
    }
    nodes = await inbox();
    const total = inboxCount(nodes);
    await type(title);
    await tapExpecting(button(await screen(), 'Save'), (current) => draftText(current) === '' || button(current, 'Save')?.enabled === 'false', 'the capture to start');
    await waitFor('the capture', (current) => inboxCount(current) === total + 1 && draftText(current) === '');


    nodes = await tapExpecting(withDescription(await screen(), en['search.title']) ?? fail('no Search button in the header'), inSearch, 'the search screen');
    await typeQuery(title);
    nodes = await waitFor(`the result ${title}`, (current) => results(current).includes(title), 20_000);
    let expected = core(title);
    check(JSON.stringify(results(nodes)) === JSON.stringify(expected.titles), `(a) the results are core's: ${JSON.stringify(expected.titles)}`);


    const status = `${en['taskEdit.statusLabel']}: ${en['status.inbox']}`;

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


    const row = nodes.find((node) => (node['resource-id'] ?? '').endsWith('search-result') && (node['content-desc'] || node.text) === title);
    nodes = await tapExpecting(row, (current) => inEditor(current) && isOn(withDescription(current, en['markdown.preview']))
        && current.some((node) => node.text === title && node.class !== 'android.widget.EditText'), 'the editor for the result on its View tab');
    nodes = await tapExpecting(withDescription(nodes, en['common.close']) ?? fail('no Close in the editor'), (current) => inSearch(current) && field(current)?.text === title, 'the search again');
    check(results(nodes).includes(title), '(c) Close returns to the search with its query');


    const doneBefore = commands('complete');
    await tapExpecting(withDescription(nodes, en['review.markDone']) ?? fail('no Mark Done on the result'), (current) => !results(current).includes(title), 'the done result to leave');
    expected = core(title);
    const hiddenLine = en['search.hiddenCompletedMatches'].replace('{{count}}', String(expected.hidden));
    nodes = await waitFor('core\'s hidden-matches line', (current) => current.some((node) => node.text === hiddenLine), 10_000);
    check(JSON.stringify(expected.stored) === '["done"]' && commands('complete') === doneBefore + 1, `(d) Mark Done stored done once (${JSON.stringify(expected.stored)})`);


    nodes = await tapExpecting(withDescription(nodes, en['common.clear']) ?? fail('no Clear in the search field'), (current) => field(current)?.text === '', 'the empty query');
    await typeQuery(SAVED_QUERY);
    nodes = await waitFor('Save Search', (current) => Boolean(button(current, en['search.saveSearch'])), 10_000);

    const edits = (current) => current.filter((node) => node.class === 'android.widget.EditText').sort((a, b) => box(a)[1] - box(b)[1]);
    nodes = await tapExpecting(button(nodes, en['search.saveSearch']), (current) => edits(current).length === 2 && edits(current)[1].text === SAVED_QUERY,
        'the save dialog with the query as its name');
    const savesBefore = commands('saveSearch');
    await tapExpecting(button(nodes, en['common.save']), (current) => edits(current).length === 1, 'the dialog to close');
    await waitFor('the saveSearch command', () => commands('saveSearch') === savesBefore + 1, 10_000);
    check(core(SAVED_QUERY).saved === 1, `(e) core stores exactly one saved search for "${SAVED_QUERY}"`);


    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await inbox();
    check(true, '(f) Back returns to the Inbox');


    const projectTitle = digitProject() ?? fail('no live project with a digits-only title');
    nodes = await tapExpecting(withDescription(await screen(), en['search.title']) ?? fail('no Search button in the header'), inSearch, 'the search screen');
    await typeQuery(projectTitle);
    const projectHit = (current) => current.find((node, index) => (node['resource-id'] ?? '').endsWith('search-result')
        && (node['content-desc'] || node.text) === projectTitle && current[index + 1]?.text === en['search.resultProject']);
    nodes = await waitFor(`the project hit ${projectTitle}`, (current) => Boolean(projectHit(current)), 20_000);
    const opened = (current) => tagged(current, 'project-title-input')?.text === projectTitle && !tagged(current, 'global-search');
    nodes = await tapExpecting(projectHit(nodes), opened, `the project ${projectTitle}`);
    check(true, `(g) the project hit ${projectTitle} opened that project's screen`);
    sh('settings put system user_rotation 1');
    const wide = (current) => { const [l, t, r, b] = box(current[0]); return r - l > b - t; };
    await waitFor('the project after rotating', (current) => opened(current) && wide(current), 15_000);
    sh('settings put system user_rotation 0');
    await waitFor('the project after rotating back', (current) => opened(current) && !wide(current), 15_000);
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    nodes = await waitFor('the search results again', (current) => inSearch(current) && field(current)?.text === projectTitle && Boolean(projectHit(current)), 15_000);
    check(!tagged(nodes, 'project-title-input'), `(h) Back from the project returns to the search with "${projectTitle}" and its results, as RN pops back to it`);
    writeFileSync(resolve(work, 'search-after-project-back.png'), execFileSync(adbBin, ['-s', serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 }));
    const [busyToken, projectCount] = busyQuery() ?? fail('no 6-character piece of a project title matches 2 projects and 15 tasks');
    await tapExpecting(withDescription(nodes, en['common.clear']) ?? fail('no Clear in the search field'), (current) => field(current)?.text === '', 'the empty query');
    await typeQuery(busyToken);
    const projectHits = (current) => current.filter((node, index) => (node['resource-id'] ?? '').endsWith('search-result') && current[index + 1]?.text === en['search.resultProject']);
    nodes = await waitFor(`the ${projectCount} project hits for ${busyToken}`, (current) => field(current)?.text === busyToken && projectHits(current).length >= 2, 20_000);
    const resultList = mainList(nodes) ?? fail('no search result list');
    const [rl, rt, rr, rb] = box(resultList);
    const shown = (current) => current.filter((node) => (node['resource-id'] ?? '').endsWith('search-result') && box(node)[1] >= rt && box(node)[3] <= rb)
        .map((node) => `${node['content-desc'] || node.text}@${box(node)[1]}`).join(',');
    const atTop = shown(nodes);
    sh(`input swipe ${Math.round((rl + rr) / 2)} ${rb - 200} ${Math.round((rl + rr) / 2)} ${rb - 420} 900`);
    nodes = await device.settle(await screen());
    const scrolledTo = shown(nodes);
    check(scrolledTo !== atTop && projectHits(nodes).some((node) => box(node)[1] >= rt), `the ${busyToken} results scroll and still show a project hit (${scrolledTo})`);
    const target = projectHits(nodes).find((node) => box(node)[1] >= rt);
    const targetTitle = target['content-desc'] || target.text;
    await tapExpecting(target, (current) => tagged(current, 'project-title-input')?.text === targetTitle && !tagged(current, 'global-search'), `the project ${targetTitle}`);
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    nodes = await waitFor('the search at its scroll position', (current) => inSearch(current) && shown(current) === scrolledTo, 15_000);
    check(field(nodes)?.text === busyToken, `(i) Back from ${targetTitle} returns to the ${busyToken} results at the same scroll position, as in RN`);
    writeFileSync(resolve(work, 'search-scroll-after-project-back.png'), execFileSync(adbBin, ['-s', serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 }));

    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await waitFor('the search to close', (current) => !tagged(current, 'global-search'), 15_000);

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
