


import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, button, check, chipOn, connect, evidenced, fail, hasText, inboxCount, owedRetry, Stopped, tab, tabSelected, tagged, taskRow, taskRows, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-review-device.mjs <adb-serial> [apk]');
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
const PREFS = 'shared_prefs/mindwtr-view-state.xml';
const work = resolve(app, 'android/build/review-check');
const coreSrc = resolve(app, '../../packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));

const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const titles = { kept: `67${run}1`, restored: `67${run}2`, purged: `67${run}3`, inbox: `67${run}4` };

const CONTEXT = '@6700';
const TAG_TYPED = '6701';
const TAG_STORED = '#6701';

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting } = device;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
const commands = (operation, outcome = 'saved') => device.logs(pid(), TAG).replace(/\\/g, '').split('\n').filter((line) => line.includes('native-android-dev-task-command')
    && line.includes(`"operation":"${operation}"`) && line.includes(`"outcome":"${outcome}"`)).length;


const pullDatabase = () => {
    const dir = resolve(work, 'db');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = sh(`run-as ${PKG} ls files`).split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    return resolve(dir, DB);
};

const storedCheckpoint = (key) => {
    let xml = '';
    try { xml = sh(`run-as ${PKG} cat ${PREFS}`); } catch { return null; }
    const raw = new RegExp(`<string name="${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">([^<]*)</string>`).exec(xml)?.[1];
    return raw === undefined ? null : raw.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
};


const core = (ids = []) => JSON.parse(execFileSync('bun', ['-e', `
    import { Database } from 'bun:sqlite';
    import { SqliteAdapter, createNativeHostContract, setStorageAdapter, useTaskStore } from '${coreSrc}/index.ts';
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
    const page = { offset: 0, limit: 50 };
    const more = value(host.getMoreMenu());
    const chips = value(host.getContextsView({ searchQuery: process.env.CHECK_CONTEXT.slice(1), ...page })).chips;
    const contexts = value(host.getContextsView({ tokens: [process.env.CHECK_CONTEXT], ...page }));
    const trash = value(host.getTrashView(page));
    const weeklyAt = process.env.CHECK_WEEKLY || null;
    const weekly = value(host.getWeeklyReview({ checkpoint: weeklyAt, ...page }));
    const inboxStep = value(host.getWeeklyReview({ checkpoint: JSON.stringify({ step: 'inbox', startedAt: new Date().toISOString() }), ...page }));
    const nextStep = inboxStep.next ? value(host.getWeeklyReview({ checkpoint: inboxStep.next.checkpoint, ...page })) : null;
    const daily = value(host.getDailyReview({ checkpoint: process.env.CHECK_DAILY || null, ...page }));
    let inboxRow = null;
    for (let offset = 0; !inboxRow; offset += 50) {
        const window = value(host.getInboxWindow({ offset, limit: 50, ...(offset ? { revision: inboxRevision } : {}) }));
        var inboxRevision = window.revision;
        inboxRow = window.rows.find((row) => row.title === process.env.CHECK_INBOX) ?? null;
        if (offset + 50 >= window.total) break;
    }
    const store = useTaskStore.getState();
    const stored = Object.fromEntries(Object.values(JSON.parse(process.env.CHECK_TITLES)).map((title) => [title,
        store._allTasks.filter((task) => task.title === title).map((task) => ({ id: task.id, status: task.status, tags: task.tags ?? [],
            deletedAt: task.deletedAt ?? null, purgedAt: task.purgedAt ?? null }))]));
    // By id too: core's purge scrubs the title of its tombstone, so a purged task is found by id only.
    const byId = Object.fromEntries(JSON.parse(process.env.CHECK_IDS || '[]').map((id) => {
        const task = store._allTasks.find((item) => item.id === id);
        return [id, task ? { deletedAt: task.deletedAt ?? null, purgedAt: task.purgedAt ?? null, title: task.title } : null];
    }));
    const step = (view) => view && { title: view.step.title, indicator: view.step.indicator, id: view.step.id, next: view.labels.next, back: view.labels.back, close: view.labels.closeLabel };
    console.log(JSON.stringify({
        byId,
        quickAccess: more.quickAccessView,
        tiles: Object.fromEntries([...more.primary, ...more.utilities].map((item) => [item.id, item.label])),
        chip: chips.find((chip) => chip.id === process.env.CHECK_CONTEXT)?.accessibilityLabel ?? null,
        contexts: contexts.rows.map((row) => row.title),
        trash: { restore: trash.labels.restore, delete: trash.labels.delete, confirm: trash.confirmations.purgeItem.confirmLabel },
        weekly: step(weekly), first: { title: weekly.rail[0].title, id: weekly.rail[0].id }, inboxStep: step(inboxStep), nextStep: step(nextStep),
        daily: { title: daily.step.title, label: daily.step.label, close: daily.closeLabel },
        start: { daily: 'daily', weekly: 'weekly' },
        inboxListed: Boolean(inboxRow),
        stored,
    }));
    process.exit(0);
`], {
    encoding: 'utf8', maxBuffer: 64 << 20,
    env: { ...process.env, TZ: timeZone, CHECK_DB: pullDatabase(), CHECK_TITLES: JSON.stringify(titles), CHECK_IDS: JSON.stringify(ids), CHECK_CONTEXT: CONTEXT, CHECK_INBOX: titles.inbox,
        CHECK_WEEKLY: storedCheckpoint('mindwtr:weeklyReview:currentStep') ?? '', CHECK_DAILY: storedCheckpoint('mindwtr:dailyReview:currentStep') ?? '' },
}).trim().split('\n').pop());


const inPopup = (nodes) => Boolean(tagged(nodes, 'quick-capture'));
const onInbox = (nodes) => !inPopup(nodes) && !tagged(nodes, 'menu-screen') && Number.isFinite(inboxCount(nodes));
const inScreen = (title) => (nodes) => Boolean(tagged(nodes, 'menu-screen')) && hasText(nodes, title);
const sheetOpen = (nodes) => Boolean(tagged(nodes, 'more-sheet'));

const rowLabel = (nodes, row) => row.text || row['content-desc']
    || nodes.find((node) => node !== row && node.bounds === row.bounds && (node.text || node['content-desc']))?.['content-desc'] || '';
const rowTitles = (nodes) => taskRows(nodes).sort((a, b) => box(a)[1] - box(b)[1]).map((node) => rowLabel(nodes, node));
const stepTitle = (nodes) => tagged(nodes, 'review-step-title')?.text;
const stepIndicator = (nodes) => tagged(nodes, 'review-step-indicator')?.text;

const capture = async (text, shown) => {
    let nodes = await screen();
    if (!inPopup(nodes)) nodes = await device.openCapture();
    await device.focusAtEnd(tagged(nodes, 'capture-title') ?? fail('no capture field'));
    requireAppFront();
    sh(`input text '${text}'`);
    await waitFor(`"${shown}" in the capture field`, (current) => tagged(current, 'capture-title')?.text === shown, 15_000);
    await tapExpecting(button(await screen(), en['common.save']) ?? fail('no Save'), onInbox, 'the capture to close the popup');
};

const openTile = async (label, done, description) => {
    let nodes = await screen();
    if (!sheetOpen(nodes)) nodes = await tapExpecting(tab(nodes, en['tab.menu']) ?? fail('no Menu tab'), sheetOpen, 'the More sheet');
    nodes = await device.settle(nodes);
    return tapExpecting(withDescription(nodes, label) ?? fail(`no ${label} tile`), done, description);
};

const hideKeyboard = async () => {
    if (!/mInputShown=true/.test(sh('dumpsys input_method'))) return;
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await sleep(600);
};
const back = async (done, description = 'Back') => {
    await hideKeyboard();
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    return waitFor(description, done, 15_000);
};

const rowNode = (nodes, title) => taskRow(nodes, title) ?? withDescription(nodes, title);


const drag = async (title, dx, label, scroll = true) => {
    const nodes = scroll ? await device.reveal(title) : await waitFor(`${title} in the list`, (current) => Boolean(rowNode(current, title)), 15_000);
    const row = rowNode(nodes, title) ?? fail(`no row ${title} on screen`);
    const [x1, y1, x2, y2] = box(row);
    const y = Math.round((y1 + y2) / 2);

    const [start, end] = dx > 0 ? [x1 + 150, x1 + 150 + dx] : [Math.max(x2 - 150, x1 + 20), Math.max(x2 - 150 + dx, 10)];
    requireAppFront();
    sh(`input swipe ${start} ${y} ${end} ${y} 400`);
    const beside = (current) => current.find((node) => node['content-desc'] === label && box(node)[1] <= y && box(node)[3] >= y);
    return beside(await waitFor(`${label} beside ${title}`, (current) => Boolean(beside(current)), 8_000));
};

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const timeZone = sh('getprop persist.sys.timezone') || undefined;
const restore = async () => {
    for (const name of PROPS) { try { setProp(name, ''); } catch {                   } }

    try {
        for (let step = 0; step < 4 && front().includes(`${PKG}/`); step += 1) {
            const nodes = await screen();
            if (!tagged(nodes, 'menu-screen') && !sheetOpen(nodes)) break;
            sh('input keyevent KEYCODE_BACK');
            await sleep(800);
        }
        const nodes = await screen();
        if (front().includes(`${PKG}/`) && tab(nodes, en['tab.inbox']) && !tabSelected(nodes, en['tab.inbox'])) await tap(tab(nodes, en['tab.inbox']));
    } catch {                       }
    for (const [name, value] of [['user_rotation', originalRotation], ['accelerometer_rotation', originalAccelerometer]]) {
        try { sh(value === 'null' ? `settings delete system ${name}` : `settings put system ${name} ${value}`); } catch {                   }
    }
    try { sh(`rm -f ${UI_FILE}`); } catch {                   }
};

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')}) / ${timeZone ?? 'no time zone'}`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    for (const name of PROPS) setProp(name, '');
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    device.launch(ACTIVITY);
    requireAppFront();
    sh('settings put system accelerometer_rotation 0');
    sh('settings put system user_rotation 0');
    await waitFor('the Inbox', onInbox, 60_000);


    for (const key of ['kept', 'restored', 'purged']) await capture(`${titles[key]}%s${CONTEXT}`, `${titles[key]} ${CONTEXT}`);
    await capture(titles.inbox, titles.inbox);
    let seen = core();
    check(Object.values(titles).every((title) => seen.stored[title].length === 1), 'the four captures are stored once each');


    const onContexts = (nodes) => Boolean(tagged(nodes, 'contexts-list'));
    if (seen.quickAccess === 'contexts') await tapExpecting(tab(await screen(), en['nav.contexts']) ?? fail('no Contexts tab'), onContexts, 'the Contexts tab');
    else await openTile(seen.tiles.contexts, onContexts, 'Contexts');
    let nodes = await waitFor('the chip search', (current) => Boolean(tagged(current, 'list-search')));
    await device.focusAtEnd(tagged(nodes, 'list-search'));
    requireAppFront();
    sh(`input text '${CONTEXT.slice(1)}'`);
    nodes = await waitFor(`core's chip "${seen.chip}"`, (current) => Boolean(seen.chip && withDescription(current, seen.chip)), 15_000);
    await hideKeyboard();
    nodes = await tapExpecting(withDescription(await screen(), seen.chip), (current) => chipOn(current, seen.chip), `${CONTEXT} chosen`);
    nodes = await waitFor('core\'s rows for the chip', (current) => rowTitles(current).length > 0
        && JSON.stringify(rowTitles(current)) === JSON.stringify(seen.contexts.slice(0, rowTitles(current).length)), 15_000);
    check([titles.kept, titles.restored, titles.purged].every((title) => seen.contexts.includes(title)),
        `(a) the ${CONTEXT} chip narrows Contexts to core's ${seen.contexts.length} rows, in core's order`);


    for (const key of ['restored', 'purged']) {
        const before = commands('contextsAction');
        const del = await drag(titles[key], -450, en['task.aria.delete']);
        await tapExpecting(del, (current) => !taskRow(current, titles[key]), `${titles[key]} to leave Contexts`);
        await waitFor('the trash write', () => commands('contextsAction') === before + 1, 10_000);
    }
    seen = core();
    check(seen.stored[titles.restored][0].deletedAt && seen.stored[titles.purged][0].deletedAt, '(a) the swipe left moved two rows to Trash, one write each');


    nodes = await device.reveal(titles.kept);
    const kept = taskRow(nodes, titles.kept) ?? fail(`no row ${titles.kept}`);
    {
        const [x1, y1, x2, y2] = box(kept);
        requireAppFront();
        sh(`input swipe ${Math.round((x1 + x2) / 2)} ${Math.round((y1 + y2) / 2)} ${Math.round((x1 + x2) / 2)} ${Math.round((y1 + y2) / 2)} 900`);
    }
    nodes = await waitFor('the bulk bar', (current) => Boolean(button(current, en['bulk.addTag'])), 10_000);
    nodes = await tapExpecting(button(nodes, en['bulk.addTag']), (current) => Boolean(tagged(current, 'menu-dialog-field')), 'the Add tag picker');
    await device.focusAtEnd(tagged(nodes, 'menu-dialog-field'));
    requireAppFront();
    sh(`input text '${TAG_TYPED}'`);
    nodes = await waitFor('the tag', (current) => tagged(current, 'menu-dialog-field')?.text === TAG_TYPED, 10_000);
    setProp('fail_commit', '1');
    const failedBefore = commands('contextsAction', 'failed');
    const savedBefore = commands('contextsAction');
    nodes = await tapExpecting(button(nodes, en['common.save']) ?? fail('no Save'), (current) => Boolean(owedRetry(current)), 'the injected failure');
    check(!core().stored[titles.kept][0].tags.includes(TAG_STORED) && commands('contextsAction', 'failed') === failedBefore + 1,
        '(a) the failed commit stored nothing; its exact retry is owed');
    setProp('fail_commit', '');
    await tapExpecting(owedRetry(await screen()), (current) => !owedRetry(current), 'Try again');
    await waitFor('the retried write', () => commands('contextsAction') === savedBefore + 1, 10_000);
    seen = core();
    check(seen.stored[titles.kept][0].tags.filter((tag) => tag === TAG_STORED).length === 1, `(a) Try again stored ${TAG_STORED} once`);
    if (seen.quickAccess === 'contexts') await tapExpecting(tab(await screen(), en['tab.inbox']), onInbox, 'the Inbox');
    else await back(onInbox);


    const purgedId = seen.stored[titles.purged][0]?.id ?? fail(`no stored ${titles.purged} before the delete`);
    const onTrash = inScreen(en['trash.title']);
    await openTile(seen.tiles.trash, onTrash, 'Trash');
    {
        const before = commands('trashAction');
        const restoreButton = await drag(titles.restored, 450, seen.trash.restore, false);
        await tapExpecting(restoreButton, (current) => !rowNode(current, titles.restored), `${titles.restored} to leave Trash`);
        await waitFor('the restore write', () => commands('trashAction') === before + 1, 10_000);
        const deleteButton = await drag(titles.purged, -450, seen.trash.delete, false);
        nodes = await tapExpecting(deleteButton, (current) => Boolean(button(current, seen.trash.confirm)), 'core\'s question');
        await tapExpecting(button(nodes, seen.trash.confirm), (current) => !rowNode(current, titles.purged), `${titles.purged} to leave Trash`);
        await waitFor('the delete write', () => commands('trashAction') === before + 2, 10_000);
    }
    seen = core([purgedId]);
    const purged = seen.byId[purgedId];
    check(!seen.stored[titles.restored][0].deletedAt, '(b) Restore brought the task back in one write');
    check(Boolean(purged?.deletedAt && purged?.purgedAt), '(b) Delete permanently left core\'s tombstone (deletedAt and purgedAt), one write');
    await back(onInbox);


    const onReview = (current) => Boolean(tagged(current, 'review-list'));
    if (seen.quickAccess === 'review') await tapExpecting(tab(await screen(), en['tab.review']) ?? fail('no Review tab'), onReview, 'the Review tab');
    else await openTile(seen.tiles.review, onReview, 'Review');
    const startReview = async (label, done) => {
        const open = await tapExpecting(button(await screen(), en['review.startReview']) ?? fail('no Start Review'),
            (current) => Boolean(button(current, label)), 'the Start Review choices');
        return tapExpecting(button(open, label), done, label);
    };
    const onWeekly = (current) => Boolean(tagged(current, 'weekly-review')) && Boolean(stepTitle(current));
    nodes = await startReview(en['review.openGuide'], onWeekly);
    check(stepTitle(nodes) === seen.weekly.title && stepIndicator(nodes) === seen.weekly.indicator,
        `(c) the Weekly Review opens on core's step for the app's checkpoint ("${seen.weekly.title}", ${seen.weekly.indicator})`);
    for (let steps = 0; steps < 10; steps += 1) {
        const backButton = withDescription(nodes, seen.weekly.back);
        if (!backButton || backButton.enabled === 'false') break;
        const shown = stepTitle(nodes);
        nodes = await tapExpecting(backButton, (current) => onWeekly(current) && stepTitle(current) !== shown, 'the step before');
    }
    check(stepTitle(nodes) === seen.first.title && stepIndicator(nodes)?.startsWith('1/'), `(c) Back leads to core's first step ("${seen.first.title}")`);
    check(seen.inboxListed, `(c) core lists ${titles.inbox} in the Inbox step`);
    {
        const action = await drag(titles.inbox, 450, en['task.aria.action'].replace('{{action}}', en['common.done']));
        await tapExpecting(action, (current) => !taskRow(current, titles.inbox), `${titles.inbox} to leave the Inbox step`);
    }
    await waitFor('the done write', () => core().stored[titles.inbox][0]?.status === 'done', 15_000);
    seen = core();
    check(seen.stored[titles.inbox].length === 1 && seen.stored[titles.inbox][0].status === 'done',
        '(c) the Inbox row\'s swipe right shows RN\'s tray (review-modal.tsx renders SwipeableTaskItem; core buildTaskRowSwipeActions gives an Inbox task Done and Focus), and its Done stored the task as done once');
    const next = seen.nextStep ?? fail('core has no step after the Inbox');
    nodes = await tapExpecting(withDescription(await screen(), seen.inboxStep.next) ?? fail('no Next'), (current) => stepTitle(current) === next.title, 'core\'s next step');
    check(stepIndicator(nodes) === next.indicator, `(c) Next shows core's next step ("${next.title}", ${next.indicator})`);


    const onStep = (current) => onWeekly(current) && stepTitle(current) === next.title;
    sh('settings put system user_rotation 1');
    await waitFor('the step in landscape', onStep, 20_000);
    sh('settings put system user_rotation 0');
    await waitFor('the step in portrait', onStep, 20_000);
    const processId = pid();
    requireAppFront();
    sh('input keyevent KEYCODE_HOME');
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    await sleep(1500);
    sh(`run-as ${PKG} kill -9 ${processId}`);
    await waitFor('process death', () => pid() !== processId, 10_000);
    device.launch(ACTIVITY);
    nodes = await waitFor('the step after process death', onStep, 60_000);
    check(true, `(d) rotation and process death keep the Weekly Review on "${next.title}"`);
    await tapExpecting(withDescription(nodes, next.close) ?? fail('no Close'), onReview, 'Review again');


    seen = core();
    const onDaily = (current) => Boolean(tagged(current, 'daily-review')) && Boolean(stepTitle(current));
    nodes = await startReview(en['dailyReview.title'], onDaily);
    check(stepTitle(nodes) === seen.daily.title && stepIndicator(nodes) === seen.daily.label,
        `(e) the Daily Review opens on core's step ("${seen.daily.title}", ${seen.daily.label})`);
    await tapExpecting(withDescription(nodes, seen.daily.close) ?? fail('no Close'), onReview, 'Review again');
    console.log('Review device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
