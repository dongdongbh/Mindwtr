import { execFileSync } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, check, connect, evidenced, fail, inEditor, isOn, Stopped, switchOn, tab, tagged, taskRows, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-sandbox-device.mjs <adb-serial> [apk]');
    process.exit(2);
}
const app = resolve(import.meta.dirname, '..');
const repo = resolve(app, '../..');
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
const DB = 'mindwtr-native-dev.db';
const QUEUE = 'files/pending-captures';
const FIRE = 'tech.dongdongbh.mindwtr.reminder.FIRE';
const work = resolve(app, 'android/build/sandbox-check');
const shots = resolve(process.env.MINDWTR_HARNESS_DIR ?? work, 'sandbox');
const { en } = await import(resolve(repo, 'packages/core/src/i18n/locales/en.ts'));
const sample = JSON.parse(execFileSync('bun', ['-e', `
    import { createSandboxData } from '${repo}/packages/core/src/sandbox-data.ts';
    const data = createSandboxData({ settings: { language: 'en' } });
    console.log(JSON.stringify(data.tasks.filter((task) => task.status === 'inbox' && !task.deletedAt).map((task) => task.title)));
`], { encoding: 'utf8' }).trim().split('\n').pop());

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { adbRaw, sh, home, front, requireAppFront, screen, waitFor, tap, tapExpecting, pid } = device;
const runAs = (command) => sh(`run-as ${PKG} sh -c '${command}'`);
const shot = (name) => {
    mkdirSync(shots, { recursive: true });
    const file = resolve(shots, `${name}.png`);
    writeFileSync(file, adbRaw('exec-out', 'screencap', '-p'));
    console.log(`screenshot ${file}`);
};

const zone = sh('getprop persist.sys.timezone') || 'UTC';
const phoneNow = () => Number(sh('date +%s')) * 1000;
const local = (ms) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
};
const pullDb = () => {
    const dir = resolve(work, 'db');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = runAs('ls files').split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    return resolve(dir, DB);
};
const sql = (file, query) => {
    const out = execFileSync('sqlite3', ['-json', file, query], { encoding: 'utf8', maxBuffer: 256 << 20 }).trim();
    return out ? JSON.parse(out) : [];
};
const realRows = () => {
    const db = pullDb();
    return { tasks: sql(db, 'SELECT * FROM tasks ORDER BY id'), settings: sql(db, 'SELECT * FROM settings ORDER BY rowid') };
};
const digest = (rows) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const changes = (before, after) => {
    const byId = (rows) => new Map(rows.map((row) => [row.id ?? row.rowid ?? JSON.stringify(row).slice(0, 40), row]));
    const out = [];
    for (const table of ['tasks', 'settings']) {
        const was = byId(before[table]);
        for (const [id, row] of byId(after[table])) {
            const old = was.get(id);
            if (!old) { out.push(`${table} ${id} added`); continue; }
            const fields = Object.keys(row).filter((key) => JSON.stringify(row[key]) !== JSON.stringify(old[key]));
            if (fields.length) out.push(`${table} ${id}: ${fields.map((key) => key === 'data' ? `data(${Object.keys(JSON.parse(row.data ?? '{}')).filter((name) => JSON.stringify(JSON.parse(row.data ?? '{}')[name]) !== JSON.stringify(JSON.parse(old.data ?? '{}')[name])).join('+')})` : key).join(', ')}`);
        }
        for (const id of was.keys()) if (!byId(after[table]).has(id)) out.push(`${table} ${id} removed`);
    }
    return out;
};
const same = (before, after, message) => {
    const diff = changes(before, after);
    if (diff.length) console.log(`info - changed rows: ${diff.join('; ')}`);
    check(diff.length === 0, message);
};
const enqueue = (item) => {
    const bytes = Buffer.from(JSON.stringify(item), 'utf8').toString('base64');
    runAs(`mkdir -p ${QUEUE} && echo ${bytes} | base64 -d > ${QUEUE}/${item.id}.tmp && mv ${QUEUE}/${item.id}.tmp ${QUEUE}/${item.id}.json`);
};
const alarms = () => sh('dumpsys alarm').split(/\n(?=\s*(?:RTC_WAKEUP|RTC|ELAPSED_WAKEUP|ELAPSED) #\d+: Alarm\{)/)
    .filter((block) => block.includes(`*walarm*:${FIRE}`) && block.includes(PKG))
    .map((block) => Number(/origWhen[= ](\d+)/.exec(block)?.[1] ?? NaN)).sort();
const notifications = () => sh('dumpsys notification --noredact').split(/\n(?=\s*NotificationRecord\()/)
    .filter((block) => block.includes(`pkg=${PKG}`))
    .map((block) => /android\.title=\w+ \((.*)\)/.exec(block)?.[1] ?? '');

const banner = (nodes) => Boolean(tagged(nodes, 'sandbox-workspace-banner'));
const sheetOpen = (nodes) => Boolean(tagged(nodes, 'more-sheet'));
const launch = () => device.launch(ACTIVITY);
const settled = (nodes) => Boolean(tab(nodes, en['tab.menu']));
const appUp = (description) => waitFor(description, (nodes) => settled(nodes) && !tagged(nodes, 'sandbox-switching'), 90_000);
const toTabs = async () => {
    for (let step = 0; step < 8; step += 1) {
        const nodes = await screen();
        if (settled(nodes) && !tagged(nodes, 'menu-screen') && !sheetOpen(nodes) && !inEditor(nodes)) return nodes;
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(900);
    }
    return fail('the tabs did not come back');
};
const openSettings = async () => {
    let nodes = await toTabs();
    nodes = await tapExpecting(tab(nodes, en['tab.menu']) ?? fail('no Menu tab'), sheetOpen, 'the More sheet');
    return tapExpecting(withDescription(await device.settle(nodes), en['nav.settings']) ?? fail('no Settings tile'),
        (next) => Boolean(tagged(next, 'settings-main')) || Boolean(tagged(next, 'sandbox-settings')), 'Settings');
};
const enterSandbox = async () => {
    await openSettings();
    let nodes = await device.revealNode((current) => current.find((node) => (node['content-desc'] ?? '').startsWith(`${en['settings.sync']}. `)), 'the Sync row');
    nodes = await tapExpecting(nodes, (next) => Boolean(tagged(next, 'settings-sync')), 'Settings › Sync', 30_000);
    nodes = await device.revealNode((current) => tagged(current, 'sandbox-open'), 'Open sandbox');
    nodes = await tapExpecting(nodes, (next) => next.some((node) => node.text === en['sandbox.confirmTitle']), 'the Enter sandbox question');
    shot('enter-confirmation');
    const before = pid();
    await tap(withDescription(nodes, en['sandbox.enter']) ?? nodes.find((node) => node.text === en['sandbox.enter']) ?? fail('no Enter sandbox button'));
    await waitFor('a new process', () => { const now = pid(); return now && now !== before; }, 60_000, 500);
    return waitFor('the sandbox banner', (next) => banner(next) && settled(next), 90_000);
};

const LOG = 'files/logs/mindwtr.log';
const logText = () => { try { return runAs(`cat ${LOG}`); } catch { return ''; } };
const completeReal = (title) => enqueue({ kind: 'complete', id: randomUUID(), taskId: realRows().tasks.find((task) => task.title === title)?.id ?? '', completedAt: new Date().toISOString(), source: 'android-widget' });

let originalExact = null;
let remindersWere = null;
const setTaskReminders = async (on) => {
    await openSettings();
    const row = `${en['settings.notifications']}. ${en['settings.menuDesc.notifications']}`;
    await tapExpecting(await device.revealNode((current) => withDescription(current, row), 'the Notifications row'), (current) => Boolean(tagged(current, 'settings-notifications')), 'Settings › Notifications');
    const label = en['settings.notificationsEnable'];
    const toggle = await device.revealNode((current) => withDescription(current, label), 'the task reminders switch', false);
    const was = switchOn(await screen(), label);
    if (was !== on) await tapExpecting(toggle, (current) => switchOn(current, label) === on, `task reminders ${on ? 'on' : 'off'}`);
    await toTabs();
    return was;
};
let realTitle = null;
let heldTitle = null;
const restore = async () => {
    try {
        if (front().includes(`${PKG}/`) && banner(await screen())) {
            await tap(tagged(await screen(), 'sandbox-exit-button'));
            await sleep(6000);
        }
    } catch {}
    try {
        if (realTitle) {
            await device.stopApp();
            for (const title of [realTitle, heldTitle].filter(Boolean)) completeReal(title);
            launch();
            await sleep(8000);
        }
    } catch (error) { console.error(`RESTORE: the real reminder task was not completed (${error.message})`); }
    try {
        if (remindersWere === false) {
            if (!front().includes(`${PKG}/`)) launch();
            await appUp('the real workspace for the reminders restore');
            await setTaskReminders(false);
            console.log('restored - task reminders are off again, as the fresh library had them');
        }
    } catch (error) { console.error(`RESTORE FAILED: task reminders are still on (${error.message})`); process.exitCode ||= 1; }
    try { if (originalExact) sh(`appops set ${PKG} SCHEDULE_EXACT_ALARM ${originalExact}`); } catch {}
    try { sh('cmd statusbar collapse'); } catch {}
    try { if (front().includes(`${PKG}/`)) sh('input keyevent KEYCODE_HOME'); } catch {}
    try { sh(`rm -f ${UI_FILE}`); } catch {}
};

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')}), zone ${zone}`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`);
    originalExact = /SCHEDULE_EXACT_ALARM: (\w+)/.exec(sh(`appops get ${PKG} SCHEDULE_EXACT_ALARM`))?.[1] ?? 'default';
    sh(`appops set ${PKG} SCHEDULE_EXACT_ALARM allow`);

    launch();
    await appUp('the real workspace');
    remindersWere = await setTaskReminders(true);
    if (!remindersWere) console.log('note - task reminders were off (core turns them off on a fresh install); turned on for this check, off again at the end');
    await device.stopApp();
    const due = Math.ceil((phoneNow() + 4 * 60_000) / 60_000) * 60_000;
    realTitle = `SB1196Real${randomInt(100000, 999999)}`;
    enqueue({ id: randomUUID(), title: `${realTitle} /due:${local(due)}`, createdAt: new Date().toISOString(), source: 'android-capture-intent' });
    launch();
    await appUp('the real workspace');
    try {
        await waitFor('the real reminder alarm', () => alarms().includes(due), 60_000, 2000);
    } catch (error) {
        const blocks = sh('dumpsys alarm').split(/\n(?=\s*(?:RTC_WAKEUP|RTC|ELAPSED_WAKEUP|ELAPSED) #\d+: Alarm\{)/).filter((block) => block.includes(PKG));
        console.log(`evidence - due ${due} (${local(due)}); ${blocks.length} ${PKG} alarms in dumpsys alarm:\n${blocks.map((block) => block.trim().slice(0, 600)).join('\n')}`);
        const row = realRows().tasks.find((task) => String(task.title).startsWith(realTitle));
        console.log(`evidence - the stored task: ${JSON.stringify(row ?? null)}`);
        console.log(`evidence - reminder log:\n${logText().split('\n').filter((line) => /remind|alarm|notif/i.test(line)).slice(-30).join('\n')}`);
        throw error;
    }
    const alarmsBefore = alarms();
    const before = realRows();
    const logStart = logText().length;
    check(before.tasks.some((task) => task.title === realTitle) && !banner(await screen()),
        `the real workspace holds ${realTitle}, due ${local(due)}, with its alarm armed; no sandbox banner`);

    let nodes = await enterSandbox();
    shot('sandbox-inbox');
    nodes = await toTabs();
    const shownSample = taskRows(nodes).filter((row) => sample.includes(row.text));
    check(shownSample.length > 0 && !nodes.some((node) => node.text === realTitle), `Enter sandbox restarts on sample data (${shownSample.map((row) => row.text).join(', ')}) and shows no real task`);
    check(Boolean(tagged(nodes, 'sandbox-reset-button')) && Boolean(tagged(nodes, 'sandbox-exit-button')), 'the banner offers Reset and Exit');

    await device.swipeDone(nodes, shownSample[0].text);
    await waitFor(`the sample task ${shownSample[0].text} done`, (current) => !taskRows(current).some((row) => row.text === shownSample[0].text), 15_000);
    await toTabs();
    nodes = await openSettings();
    check(Boolean(tagged(nodes, 'sandbox-settings')), 'Settings shows the Sandbox page');
    shot('sandbox-settings');
    const ageNode = (current) => {
        const label = current.find((node) => /task age/i.test(node['content-desc'] ?? ''));
        if (!label) return null;
        const [x1, y1, x2, y2] = box(label);
        return current.find((node) => node.checkable === 'true' && (([a, b, c, d]) => a <= x1 && b <= y1 && c >= x2 && d >= y2)(box(node))) ?? null;
    };
    const toggle = ageNode(nodes) ?? await device.revealNode(ageNode, 'Show task age');
    const wasOn = isOn(toggle);
    await tap(toggle);
    await sleep(1500);
    const toggled = ageNode(await screen()) ?? await device.revealNode(ageNode, 'Show task age');
    check(isOn(toggled) !== wasOn, `Show task age in the sandbox reads back ${wasOn ? 'off' : 'on'} after the tap`);
    check(alarms().join(',') === alarmsBefore.join(','), 'inside the sandbox the real alarm list is unchanged');
    const inside = realRows();
    same(before, inside, 'a sample task and a setting changed in the sandbox leave the real tasks and settings rows byte-identical');

    nodes = await toTabs();
    const resetPid = pid();
    await tap(tagged(nodes, 'sandbox-reset-button') ?? fail('no Reset in the banner'));
    await waitFor('a new process after Reset', () => { const now = pid(); return now && now !== resetPid; }, 60_000, 500);
    nodes = await waitFor('the sandbox after Reset', (next) => banner(next) && settled(next) && taskRows(next).some((row) => row.text === shownSample[0].text), 90_000);
    check(true, `Reset restarts the sandbox on fresh sample data: ${shownSample[0].text} is back in the Inbox`);
    nodes = await openSettings();
    const resetAge = ageNode(nodes) ?? await device.revealNode(ageNode, 'Show task age');
    check(isOn(resetAge) !== wasOn, 'Reset keeps Show task age as set, like RN: the boot request carries the display settings (core pickSandboxDisplaySettings)');
    same(before, realRows(), 'after Reset the real rows are still byte-identical');

    await device.stopApp();
    launch();
    nodes = await appUp('the app after a kill inside the sandbox');
    check(!banner(nodes), 'a kill inside the sandbox comes back to the real workspace');
    same(before, realRows(), 'after the kill the real rows are still byte-identical');
    await waitFor('the real alarm re-armed', () => alarms().includes(due), 60_000, 2000);
    check(true, 'the real reminder alarm is armed again in the real workspace');

    nodes = await enterSandbox();
    heldTitle = `SB1196Held${randomInt(100000, 999999)}`;
    const heldId = randomUUID();
    enqueue({ id: heldId, title: heldTitle, createdAt: new Date().toISOString(), source: 'android-capture-intent' });
    sh('input keyevent KEYCODE_HOME');
    await sleep(1500);
    launch();
    nodes = await waitFor('the sandbox back in front', (next) => banner(next) && settled(next), 30_000);
    await sleep(3000);
    nodes = await toTabs();
    check(!nodes.some((node) => node.text === heldTitle) && runAs(`ls ${QUEUE}`).split(/\s+/).includes(`${heldId}.json`),
        'a real capture made while the sandbox is open stays in the real queue and never shows in the sandbox');
    const firedBy = due + 120_000;
    await waitFor(`the real reminder "${realTitle}" posted`, () => notifications().includes(realTitle), Math.max(0, firedBy - phoneNow()) + 30_000, 3000);
    check(true, `a real reminder firing inside the sandbox still posts its real text "${realTitle}"`);
    sh('cmd statusbar expand-notifications');
    await sleep(1500);
    nodes = await screen();
    await tap(nodes.find((node) => node.text === realTitle) ?? fail('the real reminder is not in the shade'));
    await sleep(3000);
    nodes = await screen();
    check(banner(nodes) && !nodes.some((node) => node.text === realTitle), 'its tap opens no task in the sandbox; the sandbox stays');
    shot('sandbox-after-reminder-tap');

    same(before, realRows(), 'with the sandbox still open after the real reminder fired, the real tasks and settings rows are byte-identical');
    const exitedAt = phoneNow();
    const exitPid = pid();
    await tap(tagged(nodes, 'sandbox-exit-button') ?? fail('no Exit in the banner'));
    await waitFor('a new process after Exit', () => { const now = pid(); return now && now !== exitPid; }, 60_000, 500);
    nodes = await waitFor('the real workspace after Exit', (next) => !banner(next) && (settled(next) || inEditor(next)), 90_000);
    nodes = await waitFor('the held reminder tap', (next) => inEditor(next) && next.some((node) => node.text === realTitle), 30_000);
    check(true, `after Exit the held reminder tap opens the real task ${realTitle}`);
    const realId = before.tasks.find((task) => task.title === realTitle).id;
    const promoted = (id) => {
        const was = before.tasks.find((task) => task.id === id);
        const now = after.tasks.find((task) => task.id === id);
        return id === realId && was?.status === 'inbox' && now?.status === 'next' && Date.parse(now.updatedAt) >= exitedAt - 1000;
    };
    const heldRows = () => realRows().tasks.filter((task) => task.title === heldTitle && !task.deletedAt);
    await waitFor(`the held capture ${heldTitle} in the real database`, () => heldRows().length > 0, 60_000);
    await sleep(3000);
    const held = heldRows();
    check(held.length === 1, `after Exit the real capture made during the sandbox lands in the real database exactly once (${held.length})`);
    const after = realRows();
    const diff = changes(before, after).filter((line) => !(line.startsWith(`tasks ${realId}: `) && promoted(realId) && /^tasks [^:]+: (status|rev|updatedAt)(, (status|rev|updatedAt))*$/.test(line))
        && line !== `tasks ${held[0].id} added`);
    if (diff.length) console.log(`info - changed rows: ${diff.join('; ')}`);
    check(diff.length === 0, `after Exit nothing in the real rows changed except the held capture and the real workspace itself promoting ${realTitle} from Inbox to Next once its due time passed`);
    const lines = logText().slice(logStart);
    const count = (message) => lines.split(message).length - 1;
    check(count('Native Android sandbox switch requested') === 3 && count('Native Android sandbox opened') === 3 && count('Native Android sandbox closed') === 1,
        `the Diagnostics log shows requested 3, opened 3, closed 1 (Enter, Reset, Enter, Exit): ${count('Native Android sandbox switch requested')}, ${count('Native Android sandbox opened')}, ${count('Native Android sandbox closed')}`);
    console.log(`info - Show task age was ${wasOn ? 'on' : 'off'} in the sandbox before the tap`);
    console.log('Sandbox device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
