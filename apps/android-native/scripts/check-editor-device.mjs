


import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { bootFailure, box, button, check, connect, described, draftText, evidenced, fail, field, inEditor, inList, isOn, Stopped, tagged, taskRows, withDescription, chipOn, inboxCount } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-editor-device.mjs <adb-serial> [apk]');
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
const work = resolve(app, 'android/build/editor-check');

const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const captured = `91${run}`;

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting, type, reveal } = device;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);


const launch = () => device.launch(ACTIVITY);
const logs = (processId) => device.logs(processId, TAG);
const count = (text, needle) => text.split('\n').filter((line) => line.includes(needle)).length;
const boots = (processId) => count(logs(processId), 'Core host boot started');
const recreations = (processId) => count(logs(processId), 'reason=activity-recreate');
const newScreens = (processId) => count(logs(processId), 'reason=new-screen');

const saves = (processId, outcome) => logs(processId).replace(/\\/g, '').split('\n').filter((line) => line.includes('native-android-dev-task-command')
    && line.includes('"operation":"saveTaskDraft"') && line.includes(`"outcome":"${outcome}"`)).length;
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


const header = inboxCount;
const inbox = () => waitFor('the Inbox', (nodes) => !inEditor(nodes) && Number.isFinite(header(nodes)), 60_000);

const editorShows = (nodes, title, values = {}) => inEditor(nodes) && field(nodes)?.text === title
    && Object.entries(values).every(([label, value]) => described(nodes, label) === value);

const hideKeyboard = async () => {
    if (!/mInputShown=true/.test(sh('dumpsys input_method'))) return;
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await sleep(600);
};


const tapDescribed = async (description, expected, what = description) => {

    const shown = (nodes) => [withDescription(nodes, description)].find((node) => node && node.bounds !== '[0,0][0,0]');
    let nodes = await screen();
    for (let step = 0; step < 4 && !shown(nodes); step += 1) nodes = await device.swipe(nodes, 'down');
    return tapExpecting(shown(nodes) ?? fail(`no control announced "${description}" on screen`), expected, what);
};

const datePicker = (nodes) => Boolean(button(nodes, 'OK')) && nodes.some((node) => node['resource-id'] === 'android:id/datePicker');

const openEditor = async (title) => {
    await inbox();


    const nodes = await reveal(title, 400);

    const row = inList(nodes, title) ?? fail(`row ${title} is not in the Inbox`);
    await tap(row);

    return waitFor(`the editor for ${title} on its Form tab`, (current) => editorShows(current, title) && isOn(withDescription(current, 'Edit')));
};

const chooseStatus = async (value) => {
    await tapDescribed(`Status: ${value}`, (nodes) => chipOn(nodes, `Status: ${value}`)

        || (value === 'Reference' && !nodes.some((node) => (node['content-desc'] ?? '').startsWith('Status: '))), `Status ${value} selected`);
};
const month = () => sh('date +%Y-%m');

const phoneMidnight = (day) => {
    const [year, mon] = month().split('-').map(Number);
    const zone = sh('getprop persist.sys.timezone') || 'UTC';

    const offsetAt = (instant) => {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
            day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(instant).map(({ type, value }) => [type, value]));
        return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - instant;
    };
    const guess = Date.UTC(year, mon - 1, day);

    const first = guess - offsetAt(guess);
    return new Date(guess - offsetAt(first)).toISOString();
};

const pickDay = async (day) => {
    const dayPattern = new RegExp(`(^|\\D)${day}(\\D|$)`);
    const cell = (nodes) => nodes.find((node) => node.clickable === 'true' && dayPattern.test(`${node.text} ${node['content-desc']}`));
    const picker = await waitFor('the date picker', (nodes) => button(nodes, 'OK') && cell(nodes));
    await tapExpecting(cell(picker), (nodes) => button(nodes, 'OK')?.enabled === 'true', 'OK enabled', 10_000);
    await tapExpecting(button(await screen(), 'OK'), (nodes) => !datePicker(nodes), 'the date picker to close', 10_000);
};


const pickDueDay = async (day) => {

    let shown = await screen();
    for (let step = 0; step < 6 && described(shown, 'Due Date') === undefined; step += 1) shown = await device.swipe(shown, 'down');
    const before = described(shown, 'Due Date') ?? fail('no Due Date field in the editor');
    await tapDescribed(`Due Date: ${before}`, datePicker, 'the date picker');
    await pickDay(day);
    const value = `${month()}-${String(day).padStart(2, '0')}`;
    const nodes = await waitFor(`core's new due date label for day ${day}`, (current) => ![undefined, before, 'Not set'].includes(described(current, 'Due Date')));
    return { value, label: described(nodes, 'Due Date') };
};

const typeInto = async (node, digits, expected, erase = 0) => {


    await device.focusAtEnd(node);
    requireAppFront();
    if (erase > 0) sh(`input keyevent ${Array(erase).fill('KEYCODE_DEL').join(' ')}`);
    sh(`input text ${digits}`);
    await waitFor(`the text ${expected}`, (nodes) => nodes.some((current) => current.class === 'android.widget.EditText' && current.text === expected), 10_000);
};

const appendTitle = async (digits, expected) => typeInto(field(await device.toTop()), digits, expected);

const contextsField = async () => {
    await hideKeyboard();
    let nodes = await screen();
    for (let step = 0; step < 4 && !tagged(nodes, 'editor-contexts'); step += 1) nodes = await device.swipe(nodes, 'down');
    return tagged(nodes, 'editor-contexts') ?? fail('no Contexts field on screen');
};

const saveTookEffect = (nodes) => !inEditor(nodes) || button(nodes, 'Save')?.enabled === 'false'
    || nodes.some((node) => /^[A-Z_]+: /.test(node.text ?? '') || node.text?.includes('Injected commit failure'));

const save = async () => {
    const nodes = await waitFor('Save enabled', (current) => button(current, 'Save')?.enabled === 'true', 10_000);
    await tapExpecting(button(nodes, 'Save'), saveTookEffect, 'the save to start');
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
const FIELDS = 'title, status, dueDate, startTime, description, projectId, contexts, rev';
let taskId = '';

const stored = () => {
    const found = sqlite(`SELECT ${FIELDS} FROM tasks WHERE id = '${taskId}' AND deletedAt IS NULL`)[0];
    return found && { ...found, contexts: JSON.parse(found.contexts ?? '[]') };
};
const expectStored = (expected, message) => {
    const row = stored();
    const wrong = Object.entries(expected).filter(([name, value]) => JSON.stringify(row?.[name]) !== JSON.stringify(value));
    check(wrong.length === 0, `${message}${wrong.length ? ` (stored ${JSON.stringify(row)})` : ''}`);
    return row;
};

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const restore = () => {
    for (const name of PROPS) { try { setProp(name, ''); } catch {                   } }
    for (const [name, value] of [['user_rotation', originalRotation], ['accelerometer_rotation', originalAccelerometer]]) {
        try { sh(value === 'null' ? `settings delete system ${name}` : `settings put system ${name} ${value}`); } catch {                   }
    }
    try { sh(`rm -f ${UI_FILE}`); } catch {                   }
};

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})${sh('getprop ro.boot.qemu.avd_name') ? ` / AVD ${sh('getprop ro.boot.qemu.avd_name')}` : ''}`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    for (const name of PROPS) setProp(name, '');


    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) {
        throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    }
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    launch();
    await inbox();
    setRotation(0);
    await sleep(1500);
    let nodes = await inbox();
    let processId = pid();
    check(sqlite(`SELECT id FROM tasks WHERE title LIKE '${captured}%'`).length === 0, 'this run\'s titles are not in the database yet');
    const total = header(nodes);
    await type(captured);
    await tapExpecting(button(await screen(), 'Save'), (current) => draftText(current) === '' || button(current, 'Save')?.enabled === 'false', 'the capture to start');
    await waitFor('the capture', (current) => header(current) === total + 1 && draftText(current) === '');
    const ids = sqlite(`SELECT id FROM tasks WHERE title = '${captured}' AND deletedAt IS NULL`);
    check(ids.length === 1, 'captured one task to edit');
    taskId = ids[0].id;
    let row = expectStored({ title: captured, status: 'inbox', dueDate: null, contexts: [] }, 'captured task starts plain');


    const context = `78${run}`;
    await openEditor(captured);
    const { value: due } = await pickDueDay(15);
    const titleA = `${captured}7`;
    await appendTitle('7', titleA);
    await typeInto(await contextsField(), context, context);
    await save();
    await inbox();
    row = expectStored({
        title: titleA, status: 'inbox', dueDate: due, contexts: [`@${context}`],
        startTime: null, description: null, projectId: null, rev: row.rev + 1,
    }, '(a) stored exactly the edited title, due date, and @context in one write');


    await openEditor(titleA);
    await tapDescribed('Clear Due Date', (current) => described(current, 'Due Date') === 'Not set', 'Due Date: Not set');
    await save();
    await inbox();
    row = expectStored({ title: titleA, dueDate: null, contexts: [`@${context}`], rev: row.rev + 1 }, '(e) cleared due date stored as null');


    await openEditor(titleA);
    const { value: dueB, label: dueBLabel } = await pickDueDay(16);
    const titleB = `${titleA}8`;
    await appendTitle('8', titleB);
    await rotate(1);
    nodes = await waitFor('the draft after rotation', (current) => editorShows(current, titleB));
    check(pid() === processId, '(b) landscape: same process, draft title kept');
    await rotate(0);
    nodes = await waitFor('the draft after rotating back', (current) => editorShows(current, titleB, { 'Due Date': dueBLabel }));
    check(boots(processId) === 1, '(b) portrait: draft title and due date kept, one host boot');
    expectStored({ title: titleA, dueDate: null, rev: row.rev }, '(b) an unsaved draft wrote nothing');


    await goHome();
    await sleep(1500);
    sh(`run-as ${PKG} kill -9 ${processId}`);
    await waitFor('process death', () => pid() !== processId, 10_000);
    launch();
    nodes = await waitFor('the restored editor', (current) => editorShows(current, titleB, { 'Due Date': dueBLabel }), 60_000);
    processId = pid();
    check(boots(processId) === 1, '(c) editor draft restored after process death, one host boot');
    const booted = stored();
    if (booted.rev !== row.rev) console.log(`note - (c) core wrote the task at startup: status ${row.status} -> ${booted.status}, rev ${row.rev} -> ${booted.rev}`);
    await save();
    await inbox();
    row = expectStored({ title: titleB, status: booted.status, dueDate: dueB, rev: booted.rev + 1 }, '(c) restored draft saved once');


    await openEditor(titleB);
    const titleD = `${titleB}9`;
    await appendTitle('9', titleD);
    setProp('fail_commit', '1');
    await save();
    const hasError = (current) => current.some((node) => node.text?.includes('Injected commit failure'));
    const failedEditor = (current, label) => {
        check(field(current)?.text === titleD && field(current)?.enabled === 'false', `(d${label}) draft kept and locked`);
        check(button(current, 'Save')?.enabled === 'true', `(d${label}) exact retry allowed`);
        check(button(current, 'Close')?.enabled === 'false', `(d${label}) leaving the editor blocked`);
    };
    nodes = await waitFor('save failure', (current) => inEditor(current) && hasError(current));
    failedEditor(nodes, '');
    expectStored({ title: titleB, rev: row.rev }, '(d) failed commit stored nothing');
    await rotate(1);
    failedEditor(await waitFor('failed state after rotation', (current) => inEditor(current) && hasError(current)), ' landscape');
    await rotate(0);
    failedEditor(await waitFor('failed state after rotating back', (current) => inEditor(current) && hasError(current)), ' portrait');

    for (let attempt = 0; attempt < 2 && front().includes(`${PKG}/`); attempt += 1) {
        sh('input keyevent KEYCODE_BACK');
        await sleep(1500);
    }
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    launch();
    failedEditor(await waitFor('failed state after Back and reopen', (current) => inEditor(current) && hasError(current)), ' after Back and reopen');


    const newScreensBefore = newScreens(processId);
    requireAppFront();
    sh(`am start -W -f 0x10008000 -n ${ACTIVITY}`);
    await waitFor('a new screen on the running host', () => newScreens(processId) > newScreensBefore, 15_000);
    failedEditor(await waitFor('failed state on the new screen', (current) => inEditor(current) && hasError(current)), ' on a new screen');
    check(pid() === processId && boots(processId) === 1, '(d) same process and host');
    expectStored({ title: titleB, rev: row.rev }, '(d) still nothing stored before the retry');
    setProp('fail_commit', '');
    await save();
    nodes = await inbox();
    check(!hasError(nodes) && taskRows(nodes).some((node) => node.enabled === 'true'),
        '(d) retry cleared the failure: rows work again');
    row = expectStored({ title: titleD, dueDate: dueB, rev: row.rev + 1 }, '(d) retry stored the edit once');


    await openEditor(titleD);
    const titleI = `${titleD}6`;
    await appendTitle('6', titleI);

    await hideKeyboard();
    await tapDescribed('Clear Due Date', (current) => described(current, 'Due Date') === 'Not set', 'Due Date: Not set');
    setProp('delay_after_ms', '20000');
    await save();
    await waitFor('the commit while its reply is held back', () => stored()?.title === titleI && stored()?.dueDate === null, 15_000);
    await goHome();
    sh(`run-as ${PKG} kill -9 ${processId}`);
    setProp('delay_after_ms', '');
    await waitFor('process death', () => pid() !== processId, 10_000);
    launch();
    nodes = await inbox();
    processId = pid();
    check(boots(processId) === 1 && !inEditor(nodes), '(i) the relaunch sent the saved request again and closed the editor');


    check(logs(processId).includes('Native Android journal replay sent=1 dropped=1 left=0 owed=none') && saves(processId, 'saved') === 2,
        '(i) the boot replayed the journaled save, and the editor\'s re-send answered saved too, in the new process');
    row = expectStored({ title: titleI, status: 'inbox', dueDate: null, rev: row.rev + 1 }, '(i) the edit is stored from one write');


    await openEditor(titleI);
    const stored0 = `@${context}`;
    const prefix = `78${run.slice(0, 6)}`;

    await typeInto(await contextsField(), prefix, prefix, stored0.length + 2);
    nodes = await waitFor(`core's suggestion ${stored0}`, (current) => current.some((node) => node.text === stored0 && node.class !== 'android.widget.EditText'));
    await tapExpecting(nodes.find((node) => node.text === stored0 && node.class !== 'android.widget.EditText'),
        (current) => tagged(current, 'editor-contexts')?.text === `${stored0}, `, 'the suggestion in the field');
    const second = `79${run.slice(0, 6)}`;
    await typeInto(await contextsField(), second, `${stored0}, ${second}`);
    await hideKeyboard();
    const { label: dateOnlyLabel } = await pickDueDay(16);

    await tapDescribed(`Change time Due Date`, (current) => button(current, 'OK') && !datePicker(current), 'the time picker');
    await tapExpecting(button(await screen(), 'OK'), (current) => ![undefined, dateOnlyLabel].includes(described(current, 'Due Date')), 'core\'s label with the time');
    const dueH = phoneMidnight(16);
    await save();
    await inbox();
    row = expectStored({ title: titleI, contexts: [stored0, `@${second}`], dueDate: dueH, rev: row.rev + 1 },
        '(g) the suggestion replaced the typed digits and (h) the due date got its time (core\'s instant for 00:00), in one write');


    await openEditor(titleI);
    await pickDueDay(17);
    await save();
    await inbox();
    row = expectStored({ title: titleI, dueDate: phoneMidnight(17), rev: row.rev + 1 }, '(j) a day pick kept the due date\'s time');


    await openEditor(titleI);
    nodes = await screen();
    for (let step = 0; step < 4 && !tagged(nodes, 'contextual-help-scheduling')?.bounds?.match(/[1-9]/); step += 1) nodes = await device.swipe(nodes, 'down');
    const helpButton = tagged(nodes, 'contextual-help-scheduling') ?? fail('no (?) on the Scheduling header');
    const schedulingHeader = withDescription(nodes, 'Scheduling') ?? fail('no Scheduling header');
    const [hl, ht, hr, hb] = box(helpButton);
    const [sl, st, sr, sb] = box(schedulingHeader);
    check((ht + hb) / 2 > st && (ht + hb) / 2 < sb && hl < (sl + sr) / 2,
        `(l) the (?) sits in the Scheduling header after its title (help ${helpButton.bounds}, header ${schedulingHeader.bounds})`);
    nodes = await tapExpecting(helpButton, (current) => Boolean(tagged(current, 'contextual-help-body-scheduling')), 'the Scheduling help text');
    const helpBody = tagged(nodes, 'contextual-help-body-scheduling');
    const headerNow = withDescription(nodes, 'Scheduling');
    check(helpButton['content-desc']?.startsWith('Help: ') && box(helpBody)[1] >= box(headerNow)[3] - 4 && box(helpBody)[1] <= box(headerNow)[3] + 40,
        `(l) "${helpButton['content-desc']}" opened the help text right under the header (body ${helpBody.bounds}, header ${headerNow.bounds})`);
    await tapExpecting(tagged(nodes, 'contextual-help-scheduling'), (current) => !tagged(current, 'contextual-help-body-scheduling'), 'the help text closed');
    check(true, '(l) a second tap closed the help text');


    const onScreen = (current, label) => [withDescription(current, label)].find((node) => node && node.bounds !== '[0,0][0,0]'
        && (([, t, , b]) => b - t >= 80 && b <= 2150)(box(node)));
    nodes = await screen();
    for (let step = 0; step < 6 && !onScreen(nodes, 'Expand') && !onScreen(nodes, 'Details'); step += 1) nodes = await device.swipe(nodes, 'down');
    if (!onScreen(nodes, 'Expand')) nodes = await tapExpecting(onScreen(nodes, 'Details') ?? fail('no Details section'), (current) => Boolean(withDescription(current, 'Expand')), 'the Details section open');
    for (let step = 0; step < 4 && !onScreen(nodes, 'Expand'); step += 1) nodes = await device.swipe(nodes, 'down');
    nodes = await tapExpecting(onScreen(nodes, 'Expand') ?? fail('no Expand on the Description field'),
        (current) => Boolean(tagged(current, 'task-description-fullscreen')) && Boolean(tagged(current, 'markdown-toolbar')), 'the expanded editor with its toolbar');
    check(/mInputShown=true/.test(sh('dumpsys input_method')), '(k) the expanded editor opened with the keyboard up');

    const ACTIONS = ['Insert heading', 'Bold', 'Italic', 'Strikethrough', 'Insert link', 'Inline code', 'Code block', 'Quote', 'Horizontal rule', 'Bullet list', 'Numbered list', 'Task list'];
    const [tl, tt, tr, tb] = box(tagged(nodes, 'markdown-toolbar'));

    const inBar = [...new Set(nodes.filter((node) => node['content-desc'] && node.bounds !== '[0,0][0,0]' && (() => {
        const [l, t, r, b] = box(node);
        return (l + r) / 2 >= tl && (l + r) / 2 <= tr && (t + b) / 2 >= tt && (t + b) / 2 <= tb;
    })()).sort((a, b) => box(a)[0] - box(b)[0]).map((node) => node['content-desc']))];
    check(inBar.length >= 6 && inBar.at(-1) === 'Undo' && JSON.stringify(inBar.slice(0, -1)) === JSON.stringify(ACTIONS.slice(0, inBar.length - 1)),
        `(k) the toolbar shows RN's actions in order, then Undo: ${JSON.stringify(inBar)}`);
    check(withDescription(nodes, 'Undo')?.enabled === 'false', '(k) Undo is off before any change');
    const typed = run.slice(0, 3);
    requireAppFront();
    sh(`input text ${typed}`);
    const fullText = (want) => (current) => field(current)?.text === want;
    nodes = await waitFor(`the typed ${typed}`, fullText(typed), 15_000);
    nodes = await tapExpecting(withDescription(nodes, 'Bold'), fullText(`${typed}****`), 'Bold at the cursor');
    check(true, `(k) Bold put core's ** pair at the cursor: "${typed}****"`);
    nodes = await tapExpecting(withDescription(nodes, 'Undo'), fullText(typed), 'Undo of Bold');
    nodes = await tapExpecting(withDescription(nodes, 'Insert heading'), fullText(`# ${typed}`), 'H1 on the line');
    check(true, `(k) Undo took Bold back, and H1 made the line a heading: "# ${typed}"`);
    for (let step = 0; step < 8 && field(nodes)?.text !== ''; step += 1) nodes = await tapExpecting(withDescription(nodes, 'Undo'), (current) => field(current)?.text !== field(nodes)?.text, 'one Undo');
    check(field(nodes)?.text === '' && withDescription(nodes, 'Undo')?.enabled === 'false', '(k) Undo stepped back through every change to the empty description');
    await hideKeyboard();
    await tapExpecting(withDescription(await screen(), 'Collapse') ?? fail('no Collapse'), (current) => inEditor(current) && !tagged(current, 'task-description-fullscreen'), 'the editor form');
    await tapExpecting(button(await screen(), 'Close') ?? fail('no Close'), (current) => !inEditor(current), 'the editor closed with nothing to save');
    await inbox();
    row = expectStored({ title: titleI, rev: row.rev }, '(k) (l) nothing was stored: the help and the toolbar only changed the draft, and Undo took it back');


    await openEditor(titleI);
    await chooseStatus('Reference');
    nodes = await tapDescribed(`Destination: ${described(await screen(), 'Destination')}`, (current) => Boolean(button(current, 'Cancel')), 'the Destination picker');
    const choice = nodes.find((node) => (node['resource-id'] ?? '').endsWith('destination-project'));
    const projectTitle = choice ? nodes.find((node) => node.text && (() => { const [l, t, r, b] = node.bounds.match(/\d+/g).map(Number); const [cl, ct, cr, cb] = choice.bounds.match(/\d+/g).map(Number); return l >= cl && t >= ct && r <= cr && b <= cb; })())?.text : undefined;
    if (choice) {
        await tapExpecting(choice, (current) => described(current, 'Destination') === projectTitle, `Destination: ${projectTitle}`);
    } else {
        console.log('note - (f) the development data has no project to choose; the picker closes with Cancel');
        await tapExpecting(button(nodes, 'Cancel'), (current) => !button(current, 'Cancel'), 'the picker to close');
    }
    await save();
    await inbox();
    row = expectStored({ title: titleI, status: 'reference', dueDate: null, rev: row.rev + 1 }, '(f) core stored Reference and cleared the due date');
    if (choice) {
        const chosen = sqlite(`SELECT title FROM projects WHERE id = (SELECT projectId FROM tasks WHERE id = '${taskId}')`)[0];
        check(chosen?.title === projectTitle, `(f) the Destination picker stored the project "${projectTitle}"`);
    }
    check(saves(processId, 'saved') >= 3,
        'task-command log shows operation=saveTaskDraft saves');


    requireAppFront();
    sh(`am force-stop ${PKG}`);
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    launch();
    nodes = await inbox();
    processId = pid();
    check(boots(processId) === 1 && !bootFailure(nodes), 'relaunch: boot validation passed');
    expectStored({ title: titleI, status: 'reference', dueDate: null, contexts: [stored0, `@${second}`], rev: row.rev },
        'relaunch: final values stored');
    console.log('Editor device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    restore();
}
