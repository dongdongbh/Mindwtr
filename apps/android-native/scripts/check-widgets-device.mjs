


import { execFileSync } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, check, connect, evidenced, fail, Stopped, tab, tabSelected } from './device.mjs';
import { WIDGET_PREFS, WIDGET_LIST_PREFS, widgetSelections, REFRESHED, PUBLISHED, corePublication, count, firstDifference, publicationContext, widgetPrefs } from './widget-payload.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-widgets-device.mjs <adb-serial> [apk]');
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
const HOST = `${PKG}/tech.dongdongbh.mindwtr.pilot.WidgetHostActivity`;
const DIALOG = `${PKG}/${PKG}.DebugQuickCapture`;
const WIDGET = 'tech.dongdongbh.mindwtr.androidwidget';
const PROVIDERS = [`${WIDGET}.TasksWidgetProvider`, `${WIDGET}.CompactWidgetProvider`, `${WIDGET}.QuickCaptureWidgetProvider`, `${PKG}.widget.TasksWidget`];
const TILE = 'tech.dongdongbh.mindwtr.quicksettings.CaptureTileService';
const TAG = 'MindwtrNativeDev';
const PROPS = ['core_work_delay_ms', 'widget_language'];
const DB = 'mindwtr-native-dev.db';
const QUEUE = 'files/pending-captures';
const UI_FILE = '/data/local/tmp/mindwtr-native-dev-ui.xml';
const work = resolve(app, 'android/build/widgets-check');
const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const title = (digit) => `94${run}${digit}`;

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, pid, screen } = device;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
const runAs = (command) => sh(`run-as ${PKG} sh -c '${command}'`);
const originalAccelerometer = sh('settings get system accelerometer_rotation');


const pullDatabase = () => {
    const dir = resolve(work, 'db');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = runAs('ls files').split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    return resolve(dir, DB);
};
const sql = (query) => {
    const out = execFileSync('sqlite3', ['-json', pullDatabase(), query], { encoding: 'utf8' }).trim();
    return out ? JSON.parse(out) : [];
};

const stored = (text) => sql(`SELECT id, status, rev FROM tasks WHERE title = '${text}' AND deletedAt IS NULL`);
const queued = () => runAs(`ls ${QUEUE} 2>/dev/null || true`).split(/\s+/).filter((name) => name.endsWith('.json'));

const queuedFor = (text) => queued().filter((name) => runAs(`cat ${QUEUE}/${name}`).includes(text));

const enqueue = (item) => {
    const bytes = Buffer.from(JSON.stringify(item), 'utf8').toString('base64');
    runAs(`mkdir -p ${QUEUE} && echo ${bytes} | base64 -d > ${QUEUE}/${item.id}.tmp && mv ${QUEUE}/${item.id}.tmp ${QUEUE}/${item.id}.json`);
};

const storedPayload = () => widgetPrefs(runAs(`cat ${WIDGET_PREFS} 2>/dev/null || true`)).payload;


const allLogs = () => execFileSync(adbBin, ['-s', serial, 'logcat', '-d', '-s', `${TAG}:*`], { encoding: 'utf8', maxBuffer: 64 << 20 }).replace(/\\/g, '');
const INGESTED = ['Native Android core work', '"job":"ingest"', '"outcome":"success"'];

const lastInputs = () => publicationContext(allLogs()) ?? fail('no publication line');
const waitUntil = async (description, predicate, timeoutMs = 60_000, everyMs = 1000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await predicate();
        if (value) return value;
        if (Date.now() > deadline) fail(`timed out waiting for ${description}`);
        await sleep(everyMs);
    }
};

const nextRefresh = async (before, description) => {
    await waitUntil(description, () => count(allLogs(), REFRESHED) > before, 60_000);
    await sleep(2500);
};


const phoneZone = sh('getprop persist.sys.timezone');

const killApp = async () => {
    if (front().includes(`${PKG}/`)) sh('input keyevent KEYCODE_HOME');
    for (let attempt = 0; attempt < 20 && pid(); attempt += 1) {
        try { runAs(`kill -9 ${pid()}`); } catch {                      }
        await sleep(500);
    }
    if (pid()) fail('the app process did not end');
};
const start = (component) => {
    const current = front();
    if (!current.includes(`${PKG}/`) && !current.includes(`${home}/`)) throw new Stopped(`another app is in front; not starting over it: ${current.trim()}`);
    sh(`am start -W -n ${component}`);
};
const openApp = async () => {
    const before = count(allLogs(), REFRESHED);
    start(ACTIVITY);
    await nextRefresh(before, 'the boot\'s widget publication');
};
const jobIds = () => [...new Set([...sh('dumpsys jobscheduler').matchAll(new RegExp(`JOB #u\\d+a\\d+/(\\d+): \\w+ ${PKG.replace(/\./g, '\\.')}/androidx\\.work\\.impl\\.background\\.systemjob\\.SystemJobService`, 'g'))]
    .map((m) => m[1]))];


const resourceId = (node) => (node['resource-id'] ?? '').split('/').pop();
const hostedRows = (nodes) => nodes.filter((node) => resourceId(node) === 'mindwtr_widget_item_title').map((node) => node.text);
const ringFor = (nodes, text) => {
    const titleNode = nodes.find((node) => resourceId(node) === 'mindwtr_widget_item_title' && node.text === text) ?? fail(`no widget row ${text}`);
    const [, top, , bottom] = box(titleNode);
    return nodes.find((node) => {
        if (resourceId(node) !== 'mindwtr_widget_item_ring_target') return false;
        const [, t, , b] = box(node);
        return t <= (top + bottom) / 2 && (top + bottom) / 2 <= b;
    }) ?? fail(`no check-off ring beside ${text}`);
};

const revealRow = async (text) => {
    let nodes = await screen();
    for (let step = 0; step < 15 && !hostedRows(nodes).includes(text); step += 1) {
        const list = nodes.find((node) => resourceId(node) === 'mindwtr_widget_list') ?? fail('no widget list');
        const [x1, y1, x2, y2] = box(list);
        const x = Math.round((x1 + x2) / 2);
        sh(`input swipe ${x} ${Math.round(y1 + (y2 - y1) * 0.8)} ${x} ${Math.round(y1 + (y2 - y1) * 0.3)} 400`);
        await sleep(800);
        nodes = await screen();
    }
    return hostedRows(nodes).includes(text) ? nodes : null;
};
const hostWidget = async (expected) => {
    start(HOST);
    await waitUntil('the hosted widget to draw its list', async () => (await screen()).some((node) => resourceId(node) === 'mindwtr_widget_item_title'), 30_000);
    return (await revealRow(expected)) ?? fail(`the hosted widget never showed ${expected}`);
};
const tapRing = async (nodes, text) => {
    if (!front().includes(`${PKG}/`)) throw new Stopped(`the widget host is not in front: ${front().trim()}`);
    const [x1, y1, x2, y2] = box(ringFor(nodes, text));
    sh(`input tap ${Math.round((x1 + x2) / 2)} ${Math.round((y1 + y2) / 2)}`);
};
const closeHost = async () => {
    for (let step = 0; step < 3 && front().includes('WidgetHostActivity'); step += 1) {
        sh('input keyevent KEYCODE_BACK');
        await sleep(1000);
    }
};


const parity = (step) => {
    const context = lastInputs();
    const stored = storedPayload() ?? fail(`${step} no stored payload`);
    const expected = corePublication({ listSelections: widgetSelections(runAs(`cat ${WIDGET_LIST_PREFS} 2>/dev/null || true`)), db: pullDatabase(), language: context.language, context, zone: phoneZone, out: resolve(work, 'core-publication.json') });
    const difference = firstDifference(JSON.parse(stored), JSON.parse(expected));
    check(difference === null, `${step} the payload Kotlin stored equals core's publication on a copy of the database (${context.language}, ${context.locale}, `
        + `${context.scheme}, ${stored.length} characters)${difference ? `: ${difference}` : ''}`);
    return { payload: JSON.parse(stored), expected: JSON.parse(expected), context };
};

const restore = async () => {
    for (const name of PROPS) { try { setProp(name, ''); } catch {                   } }
    try { await closeHost(); } catch {                   }

    try { start(`${HOST} --ez release true`); } catch {                   }
    try { sh(`appwidget revokebind --package ${PKG} --user 0`); } catch {                   }
    try { if (front().includes(`${PKG}/`)) sh('input keyevent KEYCODE_HOME'); } catch {                   }
    try { sh(`settings put system accelerometer_rotation ${originalAccelerometer === 'null' ? 1 : originalAccelerometer}`); } catch {                   }
    try { sh(`rm -f ${UI_FILE}`); } catch {                   }
};

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')}), zone ${phoneZone}`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    for (const name of PROPS) setProp(name, '');
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    sh(`appwidget grantbind --package ${PKG} --user 0`);
    sh('logcat -c');


    {
        const providers = sh('dumpsys appwidget');
        for (const name of PROVIDERS) check(providers.includes(`ComponentInfo{${PKG}/${name}}`), `(1) dumpsys appwidget lists ${name}`);

        const services = sh(`dumpsys package ${PKG}`);
        const qsTile = services.slice(services.indexOf('android.service.quicksettings.action.QS_TILE:'));
        check(services.includes('android.service.quicksettings.action.QS_TILE:') && qsTile.split('\n').slice(1, 4).some((line) => line.includes(`${PKG}/${TILE}`)),
            `(1) the Quick Settings tile ${TILE} answers QS_TILE`);
    }


    const due = (days) => new Date(Date.now() + days * 86_400_000).toLocaleDateString('en-CA', { timeZone: phoneZone });
    const seeded = { [title(1)]: `${title(1)} /next /due:${due(0)}`, [title(2)]: `${title(2)} /next /due:${due(0)}`,
        [title(3)]: `${title(3)} /next /due:${due(3)}`, [title(4)]: title(4) };
    {
        await killApp();
        for (const text of Object.values(seeded)) enqueue({ id: randomUUID(), title: text, createdAt: new Date().toISOString(), source: 'android-capture-intent' });
        await openApp();
        for (const name of Object.keys(seeded)) check(stored(name).length === 1, `(2) the boot stored ${name} once`);
        const { context } = parity('(2)');
        const night = /Night mode: yes|mComputedNightMode=true/.test(sh('cmd uimode night') + sh('dumpsys uimode'));
        check(context.scheme === (night ? 'dark' : 'light'), `(2) the publication's colour scheme is the phone's (${context.scheme})`);
        const phoneLocale = sh('getprop persist.sys.locale') || sh('settings get system system_locales').split(',')[0];
        check(!phoneLocale || context.locale === phoneLocale, `(2) the publication's locale is the phone's (${context.locale}, phone ${phoneLocale || 'not set'})`);
    }


    let nodes = await hostWidget(title(1));
    {
        const payload = JSON.parse(storedPayload());
        check(hostedRows(nodes).includes(title(1)) && Boolean(await revealRow(title(2))), `(3) the widget draws RN's Focus rows ${title(1)} and ${title(2)}`);
        check(nodes.some((node) => node.text === payload.dateLabel) && nodes.some((node) => node.text === payload.subtitle),
            `(3) the widget's header shows the payload's "${payload.dateLabel}" and "${payload.subtitle}"`);
        writeFileSync(resolve(work, 'widget.png'), device.adbRaw('exec-out', 'screencap', '-p'));
        console.log(`info - the hosted widget: ${resolve(work, 'widget.png')}`);
    }


    {
        start(ACTIVITY);
        const tabs = await waitUntil('the app\'s tabs', async () => { const shown = await screen(); return tab(shown, 'Inbox') ? shown : null; }, 30_000);
        const [ix1, iy1, ix2, iy2] = box(tab(tabs, 'Inbox'));
        sh(`input tap ${Math.round((ix1 + ix2) / 2)} ${Math.round((iy1 + iy2) / 2)}`);
        await waitUntil('the Inbox tab', async () => tabSelected(await screen(), 'Inbox'), 15_000);
        nodes = await hostWidget(title(1));
        const header = nodes.find((node) => resourceId(node) === 'mindwtr_widget_title_target') ?? fail('no widget header title');
        const [x1, y1, x2, y2] = box(header);
        sh(`input tap ${Math.round((x1 + x2) / 2)} ${Math.round((y1 + y2) / 2)}`);
        const opened = await waitUntil('the app on its Focus tab', async () => {
            if (!front().includes(`${PKG}/`) || front().includes('WidgetHostActivity')) return false;
            return tabSelected(await screen(), 'Focus');
        }, 30_000).catch(() => false);
        check(opened, '(3b) the widget header\'s link opened the app on its Focus tab');
        nodes = await hostWidget(title(1));
    }


    {
        const [before] = stored(title(1));
        const jobs = count(allLogs(), ...INGESTED);
        nodes = (await revealRow(title(1))) ?? fail(`no row ${title(1)}`);
        await tapRing(nodes, title(1));
        await waitUntil('CoreWork to store the check-off', () => count(allLogs(), ...INGESTED) > jobs && stored(title(1))[0]?.status === 'done', 60_000, 2000);
        await sleep(3000);
        const [after] = stored(title(1));
        check(after.status === 'done' && after.rev === before.rev + 1 && queuedFor(before.id).length === 0, `(4) the ring tap completed ${title(1)} once (rev ${before.rev} to ${after.rev}), the queue empty`);
        await waitUntil('the payload to drop the completed task', () => !storedPayload().includes(`"id":"${before.id}"`), 30_000);
        await sleep(2000);
        nodes = await revealRow(title(1));
        check(nodes === null, '(4) CoreWork\'s refresh redrew the widget without the completed row');
    }


    {
        const [before] = stored(title(2));
        setProp('core_work_delay_ms', '3600000');
        try {
            nodes = (await revealRow(title(2))) ?? fail(`no row ${title(2)}`);
            await tapRing(nodes, title(2));
            const [file] = await waitUntil('RN\'s sweep to queue the check-off', () => queuedFor(before.id).length > 0 && queuedFor(before.id), 30_000);
            check(true, `(5) RN's CheckoffStore queued the completion (${file}) after its Undo window`);
            await killApp();
        } finally {
            setProp('core_work_delay_ms', '');
        }
        check(stored(title(2))[0].status !== 'done' && queuedFor(before.id).length === 1, '(5) killed before CoreWork ran: the task is still open, its completion queued');
        const held = jobIds();
        check(held.length >= 1, `(5) JobScheduler holds CoreWork's job (${held.join(', ')})`);
        const jobs = count(allLogs(), ...INGESTED);
        await waitUntil('the forced job', () => {
            if (count(allLogs(), ...INGESTED) > jobs) return true;
            for (const id of jobIds()) sh(`cmd jobscheduler run -f ${PKG} ${id}`);
            return false;
        }, 90_000, 15_000);
        await sleep(3000);
        const [after] = stored(title(2));
        check(after.status === 'done' && after.rev === before.rev + 1 && queuedFor(before.id).length === 0, `(5) the job completed ${title(2)} once in a new process (rev ${before.rev} to ${after.rev})`);
        await killApp();
        await openApp();
        check(stored(title(2))[0].rev === after.rev, '(5) a relaunch writes nothing more');
    }


    {
        sh('input keyevent KEYCODE_HOME');
        await sleep(1000);
        const jobs = count(allLogs(), ...INGESTED);
        start(DIALOG);
        const save = JSON.parse(storedPayload()).quickCapture.save;
        const dialog = await waitUntil('RN\'s quick capture dialog', async () => {
            const current = await screen();
            return current.some((node) => resourceId(node) === 'mindwtr_quick_capture_input') ? current : null;
        }, 15_000);
        sh(`input text ${title(5)}`);
        await waitUntil('the typed title', async () => (await screen()).some((node) => resourceId(node) === 'mindwtr_quick_capture_input' && node.text === title(5)), 10_000);
        const [x1, y1, x2, y2] = box(dialog.find((node) => resourceId(node) === 'mindwtr_quick_capture_save' && node.text === save) ?? fail('no Save'));
        sh(`input tap ${Math.round((x1 + x2) / 2)} ${Math.round((y1 + y2) / 2)}`);
        await waitUntil('CoreWork to store the dialog\'s capture', () => count(allLogs(), ...INGESTED) > jobs && stored(title(5)).length > 0, 60_000, 2000);
        await sleep(3000);
        const rows = stored(title(5));
        check(rows.length === 1 && rows[0].status === 'inbox' && queuedFor(title(5)).length === 0, '(6) the dialog\'s capture is stored once in the Inbox, the queue empty');
        check(!front().includes('QuickCaptureActivity'), '(6) the dialog closed after Save');
    }


    for (const language of ['de', 'zh']) {
        await killApp();

        setProp('widget_language', language);
        await openApp();
        const { payload, context } = parity(`(7 ${language})`);
        check(context.language === language, `(7 ${language}) the widget is in ${language}`);
        console.log(`info - (7 ${language}) header "${payload.dateLabel}", Today "${payload.sections.find((section) => section.key === 'schedule')?.detail}", `
            + `${title(3)} due "${payload.lists.next.items.find((item) => item.title === title(3))?.dueLabel}"`);
    }
    setProp('widget_language', '');
    await killApp();
    await openApp();


    const [publishedBefore, storedBefore] = (() => { const text = allLogs(); return [count(text, PUBLISHED), count(text, REFRESHED)]; })();
    sh('input keyevent KEYCODE_HOME');
    await sleep(3000);
    await waitUntil('the publication on leaving the app to be stored', () => {
        const text = allLogs();
        return count(text, REFRESHED) - storedBefore >= count(text, PUBLISHED) - publishedBefore;
    }, 30_000);
    const left = parity('(8)');
    check(left.payload.dateLabel === left.expected.dateLabel && left.payload.inboxCount === left.expected.inboxCount,
        `(8) after leaving the app the stored header is core's: "${left.payload.dateLabel}", Inbox ${left.payload.inboxCount}`);
    console.log('Widgets device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
