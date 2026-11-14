


import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, button, check, chipOn, connect, draftText, evidenced, fail, field, hasText, inboxCount, inEditor, inList, isOn, switchOn,
    linesAfter, logStamp, mainList, projectTitled, Stopped, tab, tabSelected, tagged, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-editor-menu-device.mjs <adb-serial> [apk]');
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
const { en } = await import(resolve(import.meta.dirname, '../../../packages/core/src/i18n/locales/en.ts'));
const ACTIVITY = `${PKG}/${PKG}.MainActivity`;
const TAG = 'MindwtrNativeDev';
const UI_FILE = '/data/local/tmp/mindwtr-native-dev-ui.xml';
const ACTION_TIMEOUT = 'accessibility_interactive_ui_timeout_ms';
const CONVERT_LINE = 'releaseCheck=v1.3.8/native-convert-to-section';
const EXPAND_LINE = 'releaseCheck=v1.3.8/native-checklist-to-project';
const work = resolve(app, 'android/build/editor-menu-check');

const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const prefix = `98${run}`;
const names = { plain: `${prefix}1`, copy: `${prefix}19`, items: [`${prefix}31`, `${prefix}32`], reference: `${prefix}2`, recurring: `${prefix}4`,
    expanded: `${prefix}5` };

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting, type, reveal } = device;


const ROW = {
    copyLink: en['task.copyTaskLink'], copyId: en['task.copyTaskId'], share: en['common.share'], duplicate: en['taskEdit.duplicateTask'],
    promote: en['task.createProjectFromTask'], toAction: en['reference.convertToAction'], toSection: en['task.convertToSection'],
    skip: en['task.skipOccurrence'], cancel: en['task.cancel'], cancelSeries: en['task.cancelRecurringSeries'], delete: en['common.delete'],
};
const head = [ROW.copyLink, ROW.copyId, ROW.share, ROW.duplicate, ROW.promote];
const menuOpen = (nodes) => Boolean(tagged(nodes, 'editor-menu'));
const editorShows = (nodes, title) => inEditor(nodes) && !menuOpen(nodes) && field(nodes)?.text === title;

const atInbox = (nodes) => tabSelected(nodes, 'Inbox') && !inEditor(nodes) && !menuOpen(nodes) && !tagged(nodes, 'global-search');
const inbox = () => waitFor('the Inbox', atInbox, 60_000);
const inSearch = (nodes) => Boolean(tagged(nodes, 'global-search')) && !inEditor(nodes) && !menuOpen(nodes);
const inProject = (title) => (nodes) => projectTitled(nodes, title) && !inEditor(nodes) && !menuOpen(nodes);

const menuRows = (nodes) => {
    const [l, t, r, b] = box(tagged(nodes, 'editor-menu') ?? fail('the editor menu is not open'));
    const labels = Object.values(ROW);
    return nodes.filter((node) => labels.includes(node['content-desc']) && box(node)[0] >= l && box(node)[1] >= t && box(node)[2] <= r && box(node)[3] <= b)
        .sort((x, y) => box(x)[1] - box(y)[1]).map((node) => node['content-desc']).filter((label, index, all) => all.indexOf(label) === index);
};
const openMenu = async () => tapExpecting(tagged(await screen(), 'editor-more') ?? fail('no More button in the editor'), menuOpen, 'the editor menu');

const choose = async (label, after, what, expected) => {
    const nodes = await openMenu();
    if (expected) {
        const rows = menuRows(nodes);
        check(JSON.stringify(rows) === JSON.stringify(expected), `${what}: the menu lists ${JSON.stringify(expected)} (shown ${JSON.stringify(rows)})`);
    }

    let seen = false;
    return tapExpecting(withDescription(nodes, label) ?? fail(`no "${label}" row in the menu`), (current) => (seen ||= after(current)), what);
};

const hideKeyboard = async () => {
    if (!/mInputShown=true/.test(sh('dumpsys input_method'))) return;
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await sleep(600);
};

const onScreen = (node, nodes) => {
    if (!node || node.bounds === '[0,0][0,0]') return false;
    const list = mainList(nodes);
    return !list || (box(node)[1] >= box(list)[1] && box(node)[3] <= box(list)[3] - 40);
};

const scanForm = async (find) => {
    let nodes = await device.toTop();
    for (let step = 0; step < 15; step += 1) {
        if (onScreen(find(nodes), nodes)) return { nodes, node: find(nodes) };
        const next = await device.swipe(nodes, 'down');
        if (device.signature(next) === device.signature(nodes)) break;
        nodes = next;
    }
    return onScreen(find(nodes), nodes) ? { nodes, node: find(nodes) } : null;
};

const formControl = async (find, what) => {
    const found = await scanForm(find);
    if (found) return found;
    for (const heading of [en['taskEdit.details'], en['taskEdit.scheduling'], en['taskEdit.organization']]) {
        const section = await scanForm((nodes) => withDescription(nodes, heading));
        if (!section) continue;
        await tap(section.node);
        await sleep(800);
        const inside = await scanForm(find);
        if (inside) return inside;
    }
    return fail(`no ${what} in the editor form`);
};
const save = async (leave, what) => {
    const nodes = await waitFor('Save enabled', (current) => button(current, en['common.save'])?.enabled === 'true', 10_000);
    return tapExpecting(button(nodes, en['common.save']), leave, what);
};
const capture = async (title) => {
    let nodes = await inbox();
    nodes = await device.toTop();
    const total = inboxCount(nodes);
    await type(title);
    const ready = await waitFor('the capture Save button', (current) => Boolean(button(current, en['common.save'])), 10_000);
    await tapExpecting(button(ready, en['common.save']), (current) => draftText(current) === '' || button(current, en['common.save'])?.enabled === 'false', 'the capture to start');
    await waitFor(`the capture of ${title}`, (current) => inboxCount(current) === total + 1 && draftText(current) === '');
    const rows = live(title);
    check(rows.length === 1 && rows[0].status === 'inbox', `captured ${title} in the Inbox`);
    return rows[0];
};

const openRow = async (title, where) => {
    const nodes = await reveal(title, 400);
    const row = inList(nodes, title) ?? fail(`row ${title} is not in ${where}`);
    return tapExpecting(row, (current) => inEditor(current) && hasText(current, title) || editorShows(current, title), `the editor for ${title}`);
};
const openFromInbox = async (title) => {
    await inbox();
    await openRow(title, 'the Inbox');

    return waitFor(`the editor for ${title} on its Form tab`, (current) => editorShows(current, title) && isOn(withDescription(current, en['markdown.edit'])));
};

const formTab = async () => {
    const nodes = await screen();
    if (isOn(withDescription(nodes, en['markdown.edit']))) return nodes;
    return tapExpecting(withDescription(nodes, en['markdown.edit']) ?? fail('no Edit tab'), (current) => isOn(withDescription(current, en['markdown.edit'])), 'the Form tab');
};

const undoToast = (message) => (nodes) => !inEditor(nodes) && !menuOpen(nodes) && hasText(nodes, message) && Boolean(button(nodes, en['common.undo']));

const tapUndo = async (message) => {
    const nodes = await screen();
    if (!hasText(nodes, message) || !button(nodes, en['common.undo'])) fail(`the "${message}" toast left before its Undo could be tapped`);
    await tap(button(nodes, en['common.undo']));
};

const deleteOpen = async (what, after = undoToast(en['list.taskDeleted'])) => choose(ROW.delete, after, `${what}: Delete`);

const toInbox = async () => {
    for (let step = 0; step < 5; step += 1) {
        const nodes = await screen();
        if (atInbox(nodes)) return nodes;
        requireAppFront();
        if (tab(nodes, 'Inbox')) await tap(tab(nodes, 'Inbox'));
        else sh('input keyevent KEYCODE_BACK');
        await sleep(1200);
    }
    return inbox();
};

const searchFor = async (title) => {
    await toInbox();
    const nodes = await tapExpecting(withDescription(await screen(), en['search.title']) ?? fail('no Search in the Inbox header'), inSearch, 'the search screen');
    await device.focusAtEnd(field(nodes) ?? fail('no search field'));
    requireAppFront();
    sh(`input text ${title}`);
};

const searchHit = (title, project = false) => (nodes) => nodes.find((node, index) => (node['resource-id'] ?? '').endsWith('search-result')
    && (node['content-desc'] || node.text) === title && (nodes[index + 1]?.text === en['search.resultProject']) === project);

const deleteProject = async (title) => {
    let nodes = await waitFor(`the project ${title}`, inProject(title), 20_000);
    nodes = await tapExpecting(tagged(nodes, 'project-actions-menu-button') ?? fail('no project actions button'), (current) => Boolean(tagged(current, 'project-delete-button')), 'the project actions');
    nodes = await tapExpecting(tagged(nodes, 'project-delete-button'), (current) => !tagged(current, 'project-actions-sheet') && Boolean(button(current, en['common.delete'])), 'the delete confirm');
    await tapExpecting(button(nodes, en['common.delete']), (current) => !projectTitled(current, title), 'the project closed');
};

const OWN_TASK = /^98[0-9]{12}(1|19|2|4|31|32)$/;
const OWN_PROJECT = /^98[0-9]{12}(1|5)$/;


const sweepEarlierRuns = async () => {
    const tasks = sqlite(`SELECT id, title FROM tasks WHERE deletedAt IS NULL AND status NOT IN ('archived', 'done') AND title LIKE '98%'`)
        .filter((item) => OWN_TASK.test(item.title));
    for (const item of tasks) {
        await searchFor(item.title);
        const nodes = await waitFor(`the search result ${item.title}`, (current) => Boolean(searchHit(item.title)(current)), 20_000);
        await hideKeyboard();
        await tapExpecting(searchHit(item.title)(await screen()) ?? searchHit(item.title)(nodes), (current) => inEditor(current) && !menuOpen(current), `the editor for ${item.title}`);
        await deleteOpen(`sweep of ${item.title}`, (current) => !inEditor(current) && !menuOpen(current));
        await until(`${item.title} in Trash`, () => taskById(item.id), (stored) => Boolean(stored.deletedAt));
    }
    const projects = sqlite(`SELECT id, title FROM projects WHERE deletedAt IS NULL AND title LIKE '98%'`).filter((item) => OWN_PROJECT.test(item.title));
    for (const item of projects) {
        await searchFor(item.title);
        await waitFor(`the project hit ${item.title}`, (current) => Boolean(searchHit(item.title, true)(current)), 20_000);
        await hideKeyboard();
        await tapExpecting(searchHit(item.title, true)(await screen()), inProject(item.title), `the project ${item.title}`);
        await deleteProject(item.title);
        await until(`project ${item.title} in Trash`, () => sqlite(`SELECT deletedAt FROM projects WHERE id = ${quote(item.id)}`)[0], (stored) => Boolean(stored?.deletedAt));
    }
    if (tasks.length + projects.length > 0) console.log(`info - deleted ${tasks.length} task(s) and ${projects.length} project(s) an earlier run left`);
    await toInbox();
};


const sqlite = (sql) => {
    const dir = resolve(work, 'db');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = sh(`run-as ${PKG} ls files`).split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) {
        const name = `mindwtr-native-dev.db${suffix}`;
        if (present.includes(name)) device.pull(`files/${name}`, resolve(dir, name));
    }
    return JSON.parse(execFileSync('sqlite3', ['-json', resolve(dir, 'mindwtr-native-dev.db'), sql], { encoding: 'utf8' }) || '[]');
};
const FIELDS = 'id, title, status, deletedAt, cancelledAt, projectId, sectionId, dueDate, recurrence, checklist, rev, createdAt';
const quote = (text) => `'${String(text).replace(/'/g, "''")}'`;
const taskById = (id) => sqlite(`SELECT ${FIELDS} FROM tasks WHERE id = ${quote(id)}`)[0];
const live = (title) => sqlite(`SELECT ${FIELDS} FROM tasks WHERE title = ${quote(title)} AND deletedAt IS NULL ORDER BY createdAt, id`);

const until = async (description, read, predicate, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    let value;
    while (Date.now() < deadline) {
        value = read();
        if (predicate(value)) return value;
        await sleep(500);
    }
    return fail(`timed out waiting for ${description} (stored ${JSON.stringify(value)})`);
};
const logs = () => device.logs(pid(), TAG);
const commands = (stamp) => linesAfter(logs().replace(/\\/g, ''), stamp).filter((line) => line.includes('native-android-dev-task-command')
    && line.includes('"operation":"taskEditorAction"') && line.includes('"outcome":"saved"')).length;

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const originalActionTimeout = sh(`settings get secure ${ACTION_TIMEOUT}`);
const restore = async () => {
    for (const [space, name, value] of [['system', 'user_rotation', originalRotation], ['system', 'accelerometer_rotation', originalAccelerometer],
        ['secure', ACTION_TIMEOUT, originalActionTimeout]]) {
        try { sh(value === 'null' ? `settings delete ${space} ${name}` : `settings put ${space} ${name} ${value}`); } catch {                   }
    }

    try { if (front().includes(`${PKG}/`)) sh('input keyevent KEYCODE_HOME'); } catch {                   }
    try { await device.stopApp(); } catch {                   }
    try { sh(`rm -f ${UI_FILE}`); } catch {                   }
};


process.on('SIGTERM', () => { restore().finally(() => process.exit(143)); });

try {
    mkdirSync(work, { recursive: true });
    console.log(`settings before: rotation ${originalAccelerometer}/${originalRotation}, ${ACTION_TIMEOUT} ${originalActionTimeout}`);
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}\nrun: ${run}`);
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    sh(`settings put secure ${ACTION_TIMEOUT} 30000`);
    device.launch(ACTIVITY);
    await inbox();
    requireAppFront();
    sh('settings put system accelerometer_rotation 0');
    sh('settings put system user_rotation 0');
    await sleep(1500);
    check(sqlite(`SELECT id FROM tasks WHERE title LIKE '${prefix}%'`).length === 0, 'this run\'s titles are not in the database yet');
    await sweepEarlierRuns();


    const plain = await capture(names.plain);
    const plainRows = [...head, ROW.cancel, ROW.delete];
    await openFromInbox(names.plain);
    const copied = (nodes) => editorShows(nodes, names.plain) && hasText(nodes, en['list.taskCopied']);
    await choose(ROW.copyLink, copied, '(1) Copy Mindwtr link shows "Task copied to clipboard"', plainRows);
    await waitFor('the copy toast to go', (nodes) => !hasText(nodes, en['list.taskCopied']), 20_000);
    await choose(ROW.copyId, copied, '(1) Copy task ID shows "Task copied to clipboard"');
    check(true, '(1) Copy Mindwtr link and Copy task ID each showed RN\'s toast');
    await waitFor('the copy toast to go', (nodes) => !hasText(nodes, en['list.taskCopied']), 20_000);


    await openMenu();
    await tap(withDescription(await screen(), ROW.share) ?? fail('no Share row'));
    let sheet = '';
    for (let wait = 0; wait < 40 && !sheet; wait += 1) {
        const now = front();
        if (now && !now.includes(`${PKG}/`) && !now.includes(`${home}/`)) sheet = now.trim();
        else await sleep(250);
    }
    check(Boolean(sheet), `(1) Share opened the system share sheet (${sheet || 'nothing over the app'})`);
    for (let attempt = 0; attempt < 3 && !front().includes(`${PKG}/`); attempt += 1) {
        sh('input keyevent KEYCODE_BACK');
        await sleep(1500);
    }
    await waitFor('the editor after the share sheet', (nodes) => editorShows(nodes, names.plain), 15_000);
    let row = taskById(plain.id);
    check(row.rev === plain.rev && live(names.plain).length === 1, '(1) the copy rows and Share stored nothing');


    await choose(ROW.duplicate, (nodes) => !menuOpen(nodes), '(1) Duplicate');
    const pair = await until('the duplicate', () => live(names.plain), (rows) => rows.length === 2);
    const copy = pair.find((item) => item.id !== plain.id);
    check(Boolean(copy) && copy.status === plain.status && copy.projectId === null, `(1) Duplicate stored one copy titled ${names.plain}, status ${copy?.status}`);
    await waitFor('the copy in the editor', (nodes) => editorShows(nodes, names.plain) && isOn(withDescription(nodes, en['markdown.edit'])));

    await device.focusAtEnd(field(await device.toTop()));
    requireAppFront();
    sh('input text 9');
    await waitFor(`the title ${names.copy}`, (nodes) => field(nodes)?.text === names.copy, 10_000);
    await save(atInbox, 'the copy saved');
    check(taskById(copy.id).title === names.copy && taskById(plain.id).title === names.plain, '(1) Duplicate opened the copy, not the original, in the editor');


    await openFromInbox(names.copy);
    let stamp = logStamp(logs());
    const copyBefore = taskById(copy.id);
    await choose(ROW.delete, undoToast(en['list.taskDeleted']), '(1) Delete shows "Task deleted" with Undo', [...head, ROW.cancel, ROW.delete]);
    row = await until('the copy in Trash', () => taskById(copy.id), (item) => Boolean(item.deletedAt));
    check(row.status === copyBefore.status, `(1) Delete put the copy in Trash (deletedAt ${row.deletedAt})`);
    await tapUndo(en['list.taskDeleted']);
    row = await until('the copy restored', () => taskById(copy.id), (item) => !item.deletedAt);
    check(row.status === copyBefore.status && row.title === names.copy && commands(stamp) === 2, '(1) Undo restored the copy (Delete and its Undo: two saved menu commands)');
    await openFromInbox(names.copy);
    await deleteOpen('(1) cleanup');
    row = await until('the copy back in Trash', () => taskById(copy.id), (item) => Boolean(item.deletedAt));
    check(true, '(1) the copy is in Trash again (cleanup)');


    await openFromInbox(names.plain);
    stamp = logStamp(logs());
    await choose(ROW.cancel, undoToast(en['task.cancelledWithRestore']), '(1) Cancel task shows core\'s cancelled toast with Undo', plainRows);
    row = await until('the cancelled task', () => taskById(plain.id), (item) => item.status === 'archived');
    check(Boolean(row.cancelledAt) && !row.deletedAt, `(1) Cancel task archived the task (cancelledAt ${row.cancelledAt})`);
    await tapUndo(en['task.cancelledWithRestore']);
    row = await until('the task restored', () => taskById(plain.id), (item) => item.status === 'inbox');
    check(!row.cancelledAt && commands(stamp) === 2, '(1) Undo restored the task to the Inbox with no cancelledAt');


    await openFromInbox(names.plain);
    await choose(ROW.promote, inProject(names.plain), '(1) Create project from task opens the new project', plainRows);
    const projects = await until('the new project', () => sqlite(`SELECT id, title FROM projects WHERE title = ${quote(names.plain)} AND deletedAt IS NULL`),
        (rows) => rows.length === 1);
    const project = projects[0];
    row = await until('the task in the project', () => taskById(plain.id), (item) => item.projectId === project.id);
    check(!row.deletedAt && row.title === names.plain, `(1) Create project made project "${names.plain}" and moved the task into it`);


    await openRow(names.plain, 'the project');
    await formTab();
    for (const item of names.items) {
        await hideKeyboard();
        const { node: add } = await formControl((nodes) => tagged(nodes, 'checklist-add-item'), 'checklist Add item');
        const empty = (nodes) => nodes.find((node) => (node['resource-id'] ?? '').endsWith('checklist-item-input') && node.text === '');
        const nodes = await tapExpecting(add, (current) => Boolean(empty(current)), 'a new empty checklist item');
        await device.focusAtEnd(empty(nodes));
        requireAppFront();
        sh(`input text ${item}`);
        await waitFor(`the item ${item}`, (current) => current.some((node) => (node['resource-id'] ?? '').endsWith('checklist-item-input') && node.text === item), 15_000);
    }
    await hideKeyboard();
    await save(inProject(names.plain), 'the checklist saved');
    row = await until('the checklist', () => taskById(plain.id), (item) => JSON.stringify(JSON.parse(item.checklist ?? '[]').map((entry) => entry.title)) === JSON.stringify(names.items));
    const projectRows = [...head, ROW.toSection, ROW.cancel, ROW.delete];


    await openRow(names.plain, 'the project');
    let nodes = await choose(ROW.promote, (current) => Boolean(tagged(current, 'promote-dialog')), '(3) Create project shows its dialog', projectRows);
    check(tagged(nodes, 'promote-title')?.text === names.plain && Boolean(tagged(nodes, 'promote-confirm')), '(3) the dialog offers the task\'s title as the project name');
    await tapExpecting(button(nodes, en['common.cancel']) ?? fail('no Cancel in the dialog'), (current) => !tagged(current, 'promote-dialog') && editorShows(current, names.plain)
        || (!tagged(current, 'promote-dialog') && inEditor(current)), 'the dialog closed');
    await sleep(1000);
    const afterCancel = taskById(plain.id);
    check(afterCancel.rev === row.rev && afterCancel.projectId === project.id
        && sqlite(`SELECT id FROM projects WHERE title = ${quote(names.plain)} AND deletedAt IS NULL`).length === 1, '(3) the cancelled dialog stored nothing');


    stamp = logStamp(logs());
    nodes = await choose(ROW.promote, (current) => Boolean(tagged(current, 'promote-dialog')), '(3) Create project shows its dialog again');
    const expandSwitch = (current) => withDescription(current, en['task.expandChecklist']);
    nodes = await waitFor('the Expand checklist switch on core\'s answer', (current) => expandSwitch(current)?.enabled === 'true', 15_000);

    check(!switchOn(nodes, en['task.expandChecklist']) && hasText(nodes, en['task.keepChecklistDescription']), '(3) Expand checklist starts off, with the keep-checklist note');
    await device.focusAtEnd(tagged(nodes, 'promote-title') ?? fail('no project name field'));
    requireAppFront();
    sh(`input keyevent ${Array(names.plain.length + 2).fill('KEYCODE_DEL').join(' ')}`);
    sh(`input text ${names.expanded}`);
    nodes = await waitFor(`the project name ${names.expanded}`, (current) => tagged(current, 'promote-title')?.text === names.expanded, 15_000);
    await hideKeyboard();
    nodes = await tapExpecting(expandSwitch(await screen()), (current) => switchOn(current, en['task.expandChecklist']) && hasText(current, en['task.expandChecklistDescription']), 'Expand checklist on');
    let seenExpand = false;
    await tapExpecting(tagged(nodes, 'promote-confirm'), (current) => (seenExpand ||= inProject(names.expanded)(current) || undoToast(en['task.promoteToProjectCreated'])(current)),
        '(3) Create project with Expand checklist');
    const expandedProject = await until('the expanded project', () => sqlite(`SELECT id, title, deletedAt FROM projects WHERE title = ${quote(names.expanded)}`), (rows) => rows.length === 1);
    const expandedTasks = sqlite(`SELECT ${FIELDS} FROM tasks WHERE projectId = ${quote(expandedProject[0].id)} AND deletedAt IS NULL ORDER BY title`);
    check(JSON.stringify(expandedTasks.map((item) => [item.title, item.status])) === JSON.stringify(names.items.map((title) => [title, 'next'])),
        `(3) Expand checklist made project "${names.expanded}" with one Next task per checklist item: ${JSON.stringify(expandedTasks.map((item) => item.title))}`);
    row = await until('the source task in Trash', () => taskById(plain.id), (item) => Boolean(item.deletedAt));
    check(true, '(3) the source task went to Trash');
    await tapUndo(en['task.promoteToProjectCreated']);
    row = await until('the source task back', () => taskById(plain.id), (item) => !item.deletedAt);
    check(row.projectId === project.id && sqlite(`SELECT deletedAt FROM projects WHERE id = ${quote(expandedProject[0].id)}`)[0]?.deletedAt
        && sqlite(`SELECT id FROM tasks WHERE projectId = ${quote(expandedProject[0].id)} AND deletedAt IS NULL`).length === 0,
        '(3) Undo brought the task back to its project, and the expanded project and its tasks went to Trash');
    await waitFor(`the editor for ${names.plain}`, (current) => inEditor(current) && hasText(current, names.plain) || editorShows(current, names.plain), 20_000);
    check(true, '(3) Undo opened the task, as RN\'s undo() does');
    await sleep(2000);
    const expanded = linesAfter(logs(), stamp).filter((line) => line.includes('Native checklist expanded into a project') && line.includes(EXPAND_LINE)).length;
    check(expanded === 1, `(3) logcat shows "Native checklist expanded into a project ${EXPAND_LINE}" once (${expanded})`);
    await formTab();


    stamp = logStamp(logs());
    await choose(ROW.toSection, inProject(names.plain), '(3) Convert to Section closes the editor on the project');
    const sections = await until('the new section', () => sqlite(`SELECT id, title, projectId FROM sections WHERE projectId = ${quote(project.id)} AND deletedAt IS NULL`),
        (rows) => rows.length === 1);
    check(sections[0].title === names.plain, `(3) Convert to Section made section "${names.plain}" in the project`);
    const made = sqlite(`SELECT ${FIELDS} FROM tasks WHERE sectionId = ${quote(sections[0].id)} AND deletedAt IS NULL ORDER BY title`);
    check(JSON.stringify(made.map((item) => item.title)) === JSON.stringify(names.items) && made.every((item) => item.projectId === project.id),
        `(3) one task per checklist item in the section: ${JSON.stringify(made.map((item) => item.title))}`);
    row = await until('the source task deleted', () => taskById(plain.id), (item) => Boolean(item.deletedAt));
    check(true, '(3) the source task is deleted');
    await sleep(3000);
    const converted = linesAfter(logs(), stamp).filter((line) => line.includes('Native task converted to a section') && line.includes(CONVERT_LINE)).length;
    check(converted === 1, `(3) logcat shows "Native task converted to a section ${CONVERT_LINE}" once (${converted})`);


    for (const item of made) {
        await openRow(item.title, 'the project');
        await deleteOpen(`(3) cleanup of ${item.title}`, (current) => !inEditor(current) && !menuOpen(current));
        await until(`${item.title} in Trash`, () => taskById(item.id), (stored) => Boolean(stored.deletedAt));
    }
    await deleteProject(names.plain);
    await until('the project in Trash', () => sqlite(`SELECT deletedAt FROM projects WHERE id = ${quote(project.id)}`)[0], (stored) => Boolean(stored?.deletedAt));
    check(true, '(3) cleanup: the section tasks and the project are in Trash');
    await toInbox();


    const reference = await capture(names.reference);
    await openFromInbox(names.reference);

    const shownChip = (await scanForm((current) => withDescription(current, `${en['taskEdit.statusLabel']}: ${en['status.reference']}`)))?.node
        ?? fail('no Reference status chip');
    await tapExpecting(shownChip, (current) => chipOn(current, `${en['taskEdit.statusLabel']}: ${en['status.reference']}`)
        || !current.some((node) => (node['content-desc'] ?? '').startsWith(`${en['taskEdit.statusLabel']}: `)), 'Status Reference');
    await save(atInbox, 'the Reference save');
    check(taskById(reference.id).status === 'reference', '(2) the task is stored as Reference');
    nodes = await tapExpecting(withDescription(await screen(), en['search.title']) ?? fail('no Search in the Inbox header'), inSearch, 'the search screen');
    await device.focusAtEnd(field(nodes) ?? fail('no search field'));
    requireAppFront();
    sh(`input text ${names.reference}`);
    const result = (current) => current.find((node) => (node['resource-id'] ?? '').endsWith('search-result') && (node['content-desc'] || node.text) === names.reference);
    await waitFor(`the search result ${names.reference}`, (current) => Boolean(result(current)), 20_000);
    await hideKeyboard();
    const openResult = async () => {
        const current = await waitFor(`the search result ${names.reference}`, (shown) => Boolean(result(shown)) && inSearch(shown), 20_000);
        return tapExpecting(result(current), (shown) => inEditor(shown) && !menuOpen(shown) && hasText(shown, names.reference) || editorShows(shown, names.reference), 'the editor from search');
    };
    await openResult();
    const referenceRows = [...head, ROW.toAction, ROW.delete];
    await choose(ROW.toAction, (current) => inEditor(current) && !menuOpen(current), '(2) Convert to action', referenceRows);
    check(taskById(reference.id).status === 'reference', '(2) Convert to action changes only the draft until Save');
    await save(inSearch, 'the Convert to action save');
    row = await until('status next', () => taskById(reference.id), (item) => item.status === 'next');
    check(true, '(2) Convert to action then Save stored status next');
    await openResult();
    await deleteOpen('(2) cleanup', (current) => !inEditor(current) && !menuOpen(current));
    await until('the Reference task in Trash', () => taskById(reference.id), (item) => Boolean(item.deletedAt));
    check(true, '(2) cleanup: the task is in Trash');
    await waitFor('the search', inSearch, 15_000);
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await inbox();


    const recurring = await capture(names.recurring);
    await openFromInbox(names.recurring);

    const today = Number(sh('date +%d'));
    const dueDay = today >= 28 ? 20 : today + 1;
    let found = await scanForm((current) => current.find((node) => node['content-desc']?.startsWith(`${en['taskEdit.dueDateLabel']}: `)));
    const dueLabel = found?.node['content-desc'] ?? fail('no Due Date field');
    await tapExpecting(found.node, (current) => Boolean(button(current, 'OK')) && current.some((node) => node['resource-id'] === 'android:id/datePicker'), 'the date picker');
    const dayPattern = new RegExp(`(^|\\D)${dueDay}(\\D|$)`);
    const cell = (current) => current.find((node) => node.clickable === 'true' && dayPattern.test(`${node.text} ${node['content-desc']}`));
    nodes = await waitFor('the day cell', (current) => Boolean(cell(current)));
    await tapExpecting(cell(nodes), (current) => button(current, 'OK')?.enabled === 'true', 'OK enabled', 10_000);
    await tapExpecting(button(await screen(), 'OK'), (current) => !current.some((node) => node['resource-id'] === 'android:id/datePicker')
        && current.some((node) => node['content-desc']?.startsWith(`${en['taskEdit.dueDateLabel']}: `) && node['content-desc'] !== dueLabel), 'core\'s new due date label', 15_000);
    const due = `${sh('date +%Y-%m')}-${String(dueDay).padStart(2, '0')}`;
    const daily = `${en['taskEdit.recurrenceLabel']}: ${en['recurrence.daily']}`;
    found = await formControl((current) => withDescription(current, daily), 'Recurrence Daily chip');
    await tapExpecting(found.node, (current) => chipOn(current, daily), 'Recurrence Daily');
    await save(atInbox, 'the recurring save');
    row = taskById(recurring.id);
    const recurrence = JSON.parse(row.recurrence ?? 'null');
    check(row.dueDate === due && recurrence?.rule === 'daily' && (recurrence.strategy ?? 'strict') === 'strict',
        `(4) the task is stored due ${due}, repeating daily (${row.recurrence})`);
    await openFromInbox(names.recurring);
    const recurringRows = [...head, ROW.skip, ROW.cancelSeries, ROW.delete];
    await choose(ROW.skip, (current) => !inEditor(current) && !menuOpen(current), '(4) Skip this occurrence', recurringRows);
    check(true, '(4) the menu shows Skip this occurrence and Cancel recurring series');
    row = await until('the skipped occurrence', () => taskById(recurring.id), (item) => item.status === 'archived');
    check(Boolean(row.cancelledAt) && !row.deletedAt, `(4) Skip archived the occurrence (cancelledAt ${row.cancelledAt})`);
    const next = await until('the next occurrence', () => live(names.recurring).filter((item) => item.id !== recurring.id), (rows) => rows.length === 1);
    const nextDue = new Date(Date.parse(`${due}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    check(next[0].status === 'inbox' && next[0].dueDate === nextDue && JSON.parse(next[0].recurrence ?? 'null')?.rule === 'daily',
        `(4) Skip stored the next occurrence due ${nextDue}, still daily (stored ${next[0].dueDate}, ${next[0].status})`);
    await openFromInbox(names.recurring);
    await deleteOpen('(4) cleanup');
    await until('the next occurrence in Trash', () => taskById(next[0].id), (item) => Boolean(item.deletedAt));
    check(true, '(4) cleanup: the next occurrence is in Trash; the skipped one stays archived');

    nodes = await inbox();
    check(live(names.plain).length + live(names.copy).length + live(names.reference).length + names.items.reduce((sum, item) => sum + live(item).length, 0) === 0
        && live(names.recurring).every((item) => item.status === 'archived'), 'cleanup: only the archived skipped occurrence of this run is left live');
    console.log('Editor menu device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
