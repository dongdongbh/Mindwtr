


import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { check, connect, evidenced, fail, inEditor, Stopped, switchOn, tab, tabSelected, tagged, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-notifications-device.mjs <adb-serial> [apk]');
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
const UI_FILE = '/data/local/tmp/mindwtr-native-dev-notifications-ui.xml';
const DB = 'mindwtr-native-dev.db';
const CAPTURE_ID = 41120;
const CAPTURE_CHANNEL = 'mindwtr-persistent-capture';
const KEYS = { capture: 'mindwtr:persistentCaptureNotification' };
const POMODORO_FIRE = 'tech.dongdongbh.mindwtr.pomodoro.FIRE';
const POMODORO_BOOK = 'shared_prefs/mindwtr_pomodoro_alarms.xml';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const POMODORO_SCOPE = `${PKG}:${sha256(PKG)}`;
const pomodoroId = ({ sessionID, phase, fireAtMs }) => `mindwtr-native-pomodoro:${sha256(`${POMODORO_SCOPE}|${sessionID}|${phase}|${fireAtMs}`)}`;
const RESCHEDULE = `${PKG}/tech.dongdongbh.mindwtr.pilot.ReminderRescheduleReceiver`;
const DEBUG_RESCHEDULE = 'tech.dongdongbh.mindwtr.debug.RESCHEDULE_REMINDERS';
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
const work = resolve(app, 'android/build/notifications-check');
const { en } = await import(resolve(app, '../../packages/core/src/i18n/locales/en.ts'));

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, adbRaw, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting } = device;
const runAs = (command) => sh(`run-as ${PKG} sh -c '${command}'`);
const journal = () => runAs('ls files/journal 2>/dev/null || true').split(/\s+/).filter((name) => /^\d{16}\.json$/.test(name));
const waitUntil = async (description, predicate, timeoutMs = 60_000, everyMs = 1000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await predicate();
        if (value) return value;
        if (Date.now() > deadline) fail(`timed out waiting for ${description}`);
        await sleep(everyMs);
    }
};


const pull = (name, dir) => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const [folder, file] = [name.slice(0, name.lastIndexOf('/')), name.slice(name.lastIndexOf('/') + 1)];
    const present = runAs(`ls ${folder} 2>/dev/null || true`).split(/\s+/);
    for (const suffix of ['', '-wal', '-shm', '-journal']) if (present.includes(`${file}${suffix}`)) device.pull(`${name}${suffix}`, resolve(dir, `${file}${suffix}`));
    return resolve(dir, file);
};
const bun = (script, env) => execFileSync('bun', ['-e', `import { Database } from 'bun:sqlite';\n${script}`], { encoding: 'utf8', env: { ...process.env, ...env } }).trim();

const settings = () => JSON.parse(bun(`const db = new Database(process.env.CHECK_DB, { readonly: true });
    console.log(db.query('SELECT data FROM settings WHERE id = 1').get()?.data ?? '{}');`, { CHECK_DB: pull(`files/${DB}`, resolve(work, 'db')) }));

const kv = (keys) => JSON.parse(bun(`const db = new Database(process.env.CHECK_DB, { readonly: true });
    const keys = JSON.parse(process.env.CHECK_KEYS);
    console.log(JSON.stringify(Object.fromEntries(keys.map((key) => [key, db.query('SELECT value FROM catalystLocalStorage WHERE key = ?').get(key)?.value ?? null]))));`,
{ CHECK_DB: pull('databases/RKStorage', resolve(work, 'rkstorage')), CHECK_KEYS: JSON.stringify(keys) }));

const pomodoro = (taskId = '') => JSON.parse(bun(`const db = new Database(process.env.CHECK_DB, { readonly: true });
    const raw = db.query('SELECT state_json FROM native_pomodoro_session WHERE id = 1').get()?.state_json;
    const task = db.query('SELECT timeSpentMinutes FROM tasks WHERE id = ?').get(process.env.CHECK_TASK);
    console.log(JSON.stringify({ state: raw ? JSON.parse(raw) : null, minutes: task ? Number(task.timeSpentMinutes ?? 0) : null }));`,
{ CHECK_DB: pull(`files/${DB}`, resolve(work, 'db')), CHECK_TASK: taskId }));

const notifications = () => sh('dumpsys notification --noredact').split(/\n(?=\s*NotificationRecord\()/)
    .filter((block) => block.includes(`pkg=${PKG}`))
    .map((block) => ({
        id: Number(/\bid=(-?\d+)/.exec(block)?.[1]),
        tag: /\btag=([^\s,)]+)/.exec(block)?.[1] ?? '',
        channel: /(?:mChannelId|channelId|channel)=([\w.-]+)/.exec(block)?.[1] ?? '',
        title: /android\.title=\w+ \((.*)\)/.exec(block)?.[1] ?? '',
        text: /android\.text=\w+ \((.*)\)/.exec(block)?.[1] ?? '',
        when: Number(/\bwhen=(\d+)/.exec(block)?.[1] ?? NaN),
    }));

const pomodoroAlerts = () => notifications().filter((item) => item.tag.startsWith('mindwtr-native-pomodoro:'));

const pomodoroAlarms = () => sh('dumpsys alarm').split(/\n(?=\s*(?:RTC_WAKEUP|RTC|ELAPSED_WAKEUP|ELAPSED) #\d+: Alarm\{)/)
    .filter((block) => block.includes(`*walarm*:${POMODORO_FIRE}`) && block.includes(PKG))
    .map((block) => Number(/origWhen[= ](\d+)/.exec(block)?.[1] ?? NaN)).filter((at) => at > 1e12);
const unxml = (value) => value.replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/&amp;/g, '&');

const book = () => {
    const entries = new Map([...runAs(`cat ${POMODORO_BOOK} 2>/dev/null || true`).matchAll(/<string name="([^"]*)">([^<]*)<\/string>/g)]
        .map(([, name, value]) => [unxml(name), unxml(value)]));
    const listed = (prefix) => [...entries].filter(([name]) => name.startsWith(prefix)).map(([name, value]) => ({ id: name.slice(prefix.length), ...JSON.parse(value) }));
    const record = entries.has('record') ? JSON.parse(entries.get('record')) : null;
    return { record, alarm: record?.libraries?.find((library) => library.scope === POMODORO_SCOPE)?.alarm ?? null, armed: listed('armed:'), fired: listed('fired:') };
};
const closeShade = () => sh('cmd statusbar collapse');
const tapInShade = async (text) => {
    sh('cmd statusbar expand-notifications');
    await sleep(1500);
    const node = (await screen()).find((item) => item.text === text) ?? fail(`"${text}" is not in the shade`);
    const [x1, y1, x2, y2] = node.bounds.match(/\d+/g).map(Number);
    sh(`input tap ${Math.round((x1 + x2) / 2)} ${Math.round((y1 + y2) / 2)}`);
};


const killApp = async () => {
    if (front().includes(`${PKG}/`)) sh('input keyevent KEYCODE_HOME');
    for (let attempt = 0; attempt < 20 && pid(); attempt += 1) {
        try { runAs(`kill -9 ${pid()}`); } catch {                      }
        await sleep(500);
    }
    if (pid()) fail('the app process did not end');
};
const onTabs = (nodes) => Boolean(tab(nodes, en['tab.menu'])) && !tagged(nodes, 'menu-screen') && !tagged(nodes, 'more-sheet') && !inEditor(nodes);
const toTabs = async () => {
    for (let step = 0; step < 8; step += 1) {
        const nodes = await screen();
        if (onTabs(nodes)) return nodes;
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(900);
    }
    return fail('the tabs did not come back');
};
const launch = async () => {
    device.launch(ACTIVITY);
    return waitFor('the tabs', onTabs, 60_000);
};
const row = (nodes, label) => nodes.find((node) => (node['content-desc'] ?? '').startsWith(`${label}: `));
const value = (nodes, label) => row(nodes, label)?.['content-desc'].slice(label.length + 2);
const openNotifications = async () => {
    let nodes = await toTabs();
    nodes = await tapExpecting(tab(nodes, en['tab.menu']), (current) => Boolean(tagged(current, 'more-sheet')), 'the More sheet');
    nodes = await device.settle(nodes);
    nodes = await tapExpecting(withDescription(nodes, en['nav.settings']) ?? fail('no Settings tile'), (current) => Boolean(tagged(current, 'settings-main')), 'Settings');
    const label = `${en['settings.notifications']}. ${en['settings.menuDesc.notifications']}`;
    return tapExpecting(withDescription(nodes, label) ?? fail('no Notifications row'), (current) => Boolean(tagged(current, 'settings-notifications')), 'Settings › Notifications');
};

const visible = (node) => { if (!node) return false; const [x1, y1, x2, y2] = node.bounds.match(/\d+/g).map(Number); return x2 > x1 && y2 > y1 && y2 < 2150; };

const reveal = async (found) => {
    let nodes = await screen();

    for (let step = 0; step < 6 && !found(nodes); step += 1) nodes = await device.swipe(nodes, 'up');
    for (let step = 0; step < 6 && !found(nodes); step += 1) nodes = await device.swipe(nodes, 'down');
    return found(nodes) ? nodes : fail('not on the Notifications screen');
};

const flip = async (label, stored, description) => {
    const nodes = await reveal((current) => visible(withDescription(current, label)));
    const was = switchOn(nodes, label);


    const shown = (current) => visible(withDescription(current, label));
    const after = await tapExpecting(withDescription(nodes, label), (current) => !shown(current) || switchOn(current, label) !== was, `${label} to switch`);
    if (!shown(after)) await reveal(shown);
    await waitFor(`${label} to switch`, (current) => shown(current) && switchOn(current, label) !== was, 10_000);
    await waitUntil(description, async () => stored(settings()), 20_000);
    await waitUntil('the journal to empty', async () => journal().length === 0, 20_000);
    check(true, description);
};


const setSwitch = async (label, on, stored) => {
    const nodes = await reveal((current) => visible(withDescription(current, label)));
    if (switchOn(nodes, label) === on) return;
    await flip(label, stored, `${label} ${on ? 'on' : 'off'} is stored`);
};
const byId = (current, id) => current.find((node) => (node['resource-id'] ?? '').endsWith(`:id/${id}`));

const setTime = async (label, time) => {
    const nodes = await reveal((current) => visible(row(current, label)));
    if (value(nodes, label) === time) return;
    await tap(row(nodes, label));
    let dialog = await waitFor('the time dialog', (current) => current.some((node) => /toggle_mode|button1/.test(node['resource-id'] ?? '')), 15_000);
    if (byId(dialog, 'toggle_mode') && !byId(dialog, 'input_hour')) {
        await tap(byId(dialog, 'toggle_mode'));
        dialog = await waitFor('the time dialog\'s fields', (current) => Boolean(byId(current, 'input_hour')), 10_000);
    }
    const [hour, minute] = time.split(':').map(Number);
    const twelve = dialog.some((node) => node.text === 'AM' || node.text === 'PM');
    const shownHour = twelve ? String(hour % 12 === 0 ? 12 : hour % 12).padStart(2, '0') : String(hour).padStart(2, '0');
    for (const [id, text] of [['input_hour', shownHour], ['input_minute', String(minute).padStart(2, '0')]]) {
        await tap(byId(dialog, id) ?? fail(`no ${id} in the time dialog`));
        sh('input keyevent KEYCODE_MOVE_END');
        for (let i = 0; i < 3; i += 1) sh('input keyevent KEYCODE_DEL');
        sh(`input text ${text}`);
        dialog = await screen();
    }
    const half = dialog.find((node) => node.text === (hour < 12 ? 'AM' : 'PM') && node.class?.includes('RadioButton'));
    if (half && half.checked !== 'true') await tap(half);
    await tap(byId(await screen(), 'button1') ?? fail('no OK in the time dialog'));
};

const setDay = async (day) => {
    let nodes = await reveal((current) => visible(row(current, en['settings.weeklyReviewDay'])));
    if (value(nodes, en['settings.weeklyReviewDay']) === day) return;
    nodes = await tapExpecting(row(nodes, en['settings.weeklyReviewDay']), (current) => Boolean(tagged(current, 'settings-picker')), 'the day picker');
    await tapExpecting(withDescription(nodes, day) ?? fail(`no ${day}`), (current) => !tagged(current, 'settings-picker'), 'the picker to close');
};


const GTD_ROW = `${en['settings.gtd']}. ${en['settings.menuDesc.gtd']}`;
const POMODORO = { feature: en['settings.featurePomodoro'], link: en['settings.pomodoroSettings'], focus: en['settings.pomodoroFocusMinutes'],
    break: en['settings.pomodoroBreakMinutes'], linkTask: en['settings.pomodoroLinkTask'], autoBreaks: en['settings.pomodoroAutoStartBreaks'],
    autoFocus: en['settings.pomodoroAutoStartFocus'], alert: en['settings.pomodoroCompletionAlert'] };
const POMODORO_SWITCHES = [POMODORO.linkTask, POMODORO.autoBreaks, POMODORO.autoFocus, POMODORO.alert];

const minuteField = (nodes, label) => {
    const named = nodes.find((node) => node.class === 'android.widget.EditText' && (node['content-desc'] === label || node.hint === label));
    if (named) return named;
    const labelled = withDescription(nodes, label);
    if (!labelled) return undefined;
    const [x1, y1, x2, y2] = labelled.bounds.match(/\d+/g).map(Number);
    const [cx, cy] = [(x1 + x2) / 2, (y1 + y2) / 2];
    return nodes.find((node) => {
        if (node.class !== 'android.widget.EditText') return false;
        const [l, t, r, b] = node.bounds.match(/\d+/g).map(Number);
        return l <= cx && cx <= r && t <= cy && cy <= b;
    });
};
const startsWith = (nodes, label) => nodes.find((node) => (node['content-desc'] ?? '').startsWith(label));

const openGtd = async (feature) => {
    let nodes = await toTabs();
    nodes = await tapExpecting(tab(nodes, en['tab.menu']), (current) => Boolean(tagged(current, 'more-sheet')), 'the More sheet');
    nodes = await device.settle(nodes);
    nodes = await tapExpecting(withDescription(nodes, en['nav.settings']) ?? fail('no Settings tile'), (current) => Boolean(tagged(current, 'settings-main')), 'Settings');
    nodes = await tapExpecting(withDescription(nodes, GTD_ROW) ?? fail('no GTD row'), (current) => Boolean(withDescription(current, POMODORO.feature)), 'Settings › GTD');
    if (switchOn(nodes, POMODORO.feature) !== feature) {
        nodes = await tapExpecting(withDescription(nodes, POMODORO.feature), (current) => switchOn(current, POMODORO.feature) === feature, 'the Pomodoro feature');
        await waitUntil('the Pomodoro feature stored', async () => (settings().features?.pomodoro === true) === feature, 20_000);
    }
    if (!feature) return nodes;
    nodes = await waitFor('the Pomodoro settings row', (current) => Boolean(startsWith(current, POMODORO.link)), 15_000);
    return tapExpecting(startsWith(nodes, POMODORO.link), (current) => Boolean(minuteField(current, POMODORO.focus)), 'Settings › GTD › Pomodoro');
};

const setMinutes = async (focus, brk) => {
    let nodes = await screen();
    if (minuteField(nodes, POMODORO.focus)?.text === focus && minuteField(nodes, POMODORO.break)?.text === brk) return;
    for (const [label, text] of [[POMODORO.focus, focus], [POMODORO.break, brk]]) {
        await tap(minuteField(nodes, label) ?? fail(`no ${label} field`));
        sh('input keyevent KEYCODE_MOVE_END');
        for (let i = 0; i < 4; i += 1) sh('input keyevent KEYCODE_DEL');
        sh(`input text ${text}`);
        nodes = await screen();
    }
    sh('input keyevent KEYCODE_ENTER');
    await waitUntil(`the minutes ${focus}/${brk} stored`, async () => {
        const durations = settings().gtd?.pomodoro?.customDurations;
        return String(durations?.focusMinutes) === focus && String(durations?.breakMinutes) === brk;
    }, 20_000);

    if (sh('dumpsys input_method').includes('mInputShown=true')) sh('input keyevent KEYCODE_BACK');
    await sleep(800);
};

const POMODORO_FIELDS = { [POMODORO.linkTask]: 'linkTask', [POMODORO.autoBreaks]: 'autoStartBreaks', [POMODORO.autoFocus]: 'autoStartFocus', [POMODORO.alert]: 'completionAlert' };
const storedSwitch = (label) => {
    const value = settings().gtd?.pomodoro?.[POMODORO_FIELDS[label]];

    return label === POMODORO.alert ? value !== false : value === true;
};
const pomodoroSwitch = async (label) => reveal((current) => visible(withDescription(current, label)));
const setPomodoroSwitch = async (label, on) => {
    const nodes = await pomodoroSwitch(label);
    if (switchOn(nodes, label) === on) return;
    await tapExpecting(withDescription(nodes, label), (current) => switchOn(current, label) === on, label);
    await waitUntil(`${label} ${on ? 'on' : 'off'} stored`, async () => storedSwitch(label) === on, 20_000);
    await waitUntil('the journal to empty', async () => journal().length === 0, 20_000);
};


const card = (nodes) => Boolean(tagged(nodes, 'pomodoro-card')) && !nodes.some((node) => node.text === en['common.loading']);
const toCard = async () => {
    const nodes = await toTabs();
    if (!tabSelected(nodes, en['tab.next'])) await tap(tab(nodes, en['tab.next']));
    return waitFor('the Pomodoro card', card, 30_000);
};
const clock = (nodes) => tagged(nodes, 'pomodoro-clock')?.text;

const control = async (tag) => tagged(await waitFor(`${tag} enabled`, (current) => tagged(current, tag)?.enabled === 'true', 30_000), tag);
const primary = (nodes) => tagged(nodes, 'pomodoro-primary')?.['content-desc'];

const idleCard = async () => {
    let nodes = await toCard();
    if (primary(nodes) === en['common.pause']) nodes = await tapExpecting(await control('pomodoro-primary'), (current) => primary(current) === en['common.start'], 'Pause');
    if (withDescription(nodes, en['pomodoro.switchToFocus'])) {
        nodes = await tapExpecting(await control('pomodoro-switch'), (current) => Boolean(withDescription(current, en['pomodoro.switchToBreak'])), 'Switch to Focus');
    }

    const oneOne = () => { const durations = pomodoro().state?.session?.durations; return durations?.focusMinutes === 1 && durations?.breakMinutes === 1; };
    if (!oneOne()) {
        await tap(await control('pomodoro-preset-custom'));
        await waitUntil('the 1/1 minutes stored', oneOne, 20_000);
    }
    nodes = await waitFor('the card idle at 1/1', (current) => tagged(current, 'pomodoro-primary')?.enabled === 'true' && Boolean(clock(current)), 30_000);
    if (clock(nodes) !== '01:00') nodes = await tapExpecting(await control('pomodoro-reset'), (current) => clock(current) === '01:00', 'Reset');
    return waitFor('the card idle', (current) => tagged(current, 'pomodoro-primary')?.enabled === 'true', 30_000);
};

const startFocus = async (nodes) => {
    await tapExpecting(await control('pomodoro-primary'), (current) => primary(current) === en['common.pause'], 'Start');
    const state = await waitUntil('the running session stored', () => { const { state: s } = pomodoro(); return s?.session?.timerState?.isRunning && s; }, 15_000);
    const alert = { sessionID: state.sessionID, phase: 'focus', fireAtMs: Date.parse(state.session.phaseEndsAt) };
    await waitUntil('core\'s record of the focus alert', () => { const { alarm } = book(); return alarm?.fireAtMs === alert.fireAtMs && alarm.phase === 'focus'; }, 15_000);
    return { ...alert, id: pomodoroId(alert) };
};


const LATE_MS = 120_000;
const armedAt = (alert) => pomodoroAlarms().filter((at) => at === alert.fireAtMs).length;


let found = null;

let stayOn = null;
const restore = async () => {
    try { sh('input keyevent KEYCODE_WAKEUP'); sh('wm dismiss-keyguard'); } catch {                   }
    try { closeShade(); } catch {                   }
    try { setProp('journal_stop', ''); } catch {                   }
    try {
        if (found) {
            if (!pid() || !front().includes(`${PKG}/`)) await launch();

            if (tagged(await screen(), 'pomodoro-picker')) { sh('input keyevent KEYCODE_BACK'); await sleep(1000); }
            if (found.pomodoro && settings().features?.pomodoro === true) {

                const nodes = await toCard();
                if (primary(nodes) === en['common.pause']) await tapExpecting(await control('pomodoro-primary'), (current) => primary(current) === en['common.start'], 'Pause');

                await waitUntil('no Pomodoro alarm left', () => pomodoroAlarms().length === 0, LATE_MS);
            }
            await openNotifications();
            await setSwitch(en['settings.notificationsEnable'], found.reminders, () => true);
            await setSwitch(en['settings.weeklyReview'], true, () => true);
            await setDay(found.day);
            await setTime(en['settings.weeklyReviewTime'], found.weeklyTime);
            await setSwitch(en['settings.weeklyReview'], found.weekly, () => true);
            await setSwitch(en['settings.dailyDigestMorning'], true, () => true);
            await setTime(en['settings.dailyDigestMorningTime'], found.morningTime);
            await setSwitch(en['settings.dailyDigestMorning'], found.morning, () => true);
            await setSwitch(en['settings.persistentCaptureLabel'], found.capture, () => true);
            if (found.pomodoro) {
                await openGtd(true);
                if (found.pomodoro.focus !== null) await setMinutes(found.pomodoro.focus, found.pomodoro.brk);
                for (const [label, on] of found.pomodoro.switches) await setPomodoroSwitch(label, on);
                if (!found.pomodoro.feature) await openGtd(false);
            }
            await toTabs();
        }
    } catch (error) { console.error(`RESTORE FAILED: the development settings are not as they were (${error.message}); put them back by hand`); process.exitCode = 1; }
    try { if (front().includes(`${PKG}/`)) sh('input keyevent KEYCODE_HOME'); } catch {                   }
    try { sh('settings put system accelerometer_rotation 1'); } catch {                   }
    try { if (stayOn !== null) sh(`settings put global stay_on_while_plugged_in ${stayOn}`); } catch {                   }
    try { sh(`rm -f ${UI_FILE}`); } catch {                   }
};

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`);
    sh('settings put system accelerometer_rotation 0');

    stayOn = /^\d+$/.test(sh('settings get global stay_on_while_plugged_in')) ? sh('settings get global stay_on_while_plugged_in') : '0';
    sh('settings put global stay_on_while_plugged_in 7');
    await launch();

    let nodes = await openNotifications();
    const shown = async (label) => switchOn(await reveal((current) => visible(withDescription(current, label))), label);
    const at = async (label) => value(await reveal((current) => visible(row(current, label))), label);
    const start = { reminders: await shown(en['settings.notificationsEnable']), weekly: await shown(en['settings.weeklyReview']),
        day: await at(en['settings.weeklyReviewDay']), weeklyTime: await at(en['settings.weeklyReviewTime']), morning: await shown(en['settings.dailyDigestMorning']),
        morningTime: await at(en['settings.dailyDigestMorningTime']), capture: await shown(en['settings.persistentCaptureLabel']) };

    found = start;
    nodes = await openNotifications();
    await setSwitch(en['settings.notificationsEnable'], false, (stored) => stored.notificationsEnabled === false);
    await setSwitch(en['settings.weeklyReview'], true, (stored) => stored.weeklyReviewEnabled === true);
    await setDay('Sunday');
    await setSwitch(en['settings.weeklyReview'], false, (stored) => stored.weeklyReviewEnabled === false);
    await setSwitch(en['settings.dailyDigestMorning'], true, (stored) => stored.dailyDigestMorningEnabled === true);
    await setTime(en['settings.dailyDigestMorningTime'], '09:00');
    await setSwitch(en['settings.dailyDigestMorning'], false, (stored) => stored.dailyDigestMorningEnabled === false);
    await setSwitch(en['settings.persistentCaptureLabel'], false, () => kv([KEYS.capture])[KEYS.capture] === null);

    found.pomodoro = { feature: settings().features?.pomodoro === true, focus: null, brk: null, switches: [] };
    nodes = await openGtd(true);
    const minutesShown = { focus: minuteField(nodes, POMODORO.focus)?.text ?? '25', brk: minuteField(nodes, POMODORO.break)?.text ?? '5' };
    const switchesShown = [];
    for (const label of POMODORO_SWITCHES) switchesShown.push([label, switchOn(await pomodoroSwitch(label), label)]);
    Object.assign(found.pomodoro, minutesShown, { switches: switchesShown });
    await reveal((current) => Boolean(minuteField(current, POMODORO.focus)));
    await setMinutes('1', '1');
    for (const label of POMODORO_SWITCHES) await setPomodoroSwitch(label, label === POMODORO.alert);


    if (process.env.NOTIFICATIONS_ONLY !== 'pomodoro') {

        nodes = await openNotifications();
        check(Boolean(withDescription(nodes, en['settings.notificationsEnable'])) && !switchOn(nodes, en['settings.notificationsEnable']),
            '(1) Settings › Notifications shows core\'s Task reminders switch, off');
        await flip(en['settings.notificationsEnable'], (stored) => stored.notificationsEnabled === true, '(1) Task reminders on is stored');
        await flip(en['settings.weeklyReview'], (stored) => stored.weeklyReviewEnabled === true, '(1) Weekly review on is stored');
        nodes = await reveal((current) => visible(row(current, en['settings.weeklyReviewDay'])));
        check(value(nodes, en['settings.weeklyReviewDay']) === 'Sunday', '(1) the review day row shows Sunday (set at the start)');
        nodes = await tapExpecting(row(nodes, en['settings.weeklyReviewDay']), (current) => Boolean(tagged(current, 'settings-picker')), 'the day picker');
        await tapExpecting(withDescription(nodes, 'Wednesday') ?? fail('no Wednesday'), (current) => !tagged(current, 'settings-picker'), 'the picker to close');
        await waitUntil('the review day stored', async () => settings().weeklyReviewDay === 3, 20_000);
        check(true, '(1) the review day Wednesday is stored (3)');
        await flip(en['settings.dailyDigestMorning'], (stored) => stored.dailyDigestMorningEnabled === true, '(1) the morning digest on is stored');
        await setTime(en['settings.dailyDigestMorningTime'], '07:45');
        await waitUntil('the morning time stored', async () => settings().dailyDigestMorningTime === '07:45', 20_000);
        check(journal().length === 0, '(1) the morning time 07:45 from Android\'s time picker is stored, and no journal entry is left');
        await killApp();
        await launch();
        nodes = await openNotifications();
        check(switchOn(nodes, en['settings.notificationsEnable']), '(1) after a restart Task reminders shows on');
        nodes = await reveal((current) => visible(row(current, en['settings.dailyDigestMorningTime'])));
        check(value(nodes, en['settings.dailyDigestMorningTime']) === '07:45' && switchOn(nodes, en['settings.dailyDigestMorning']),
            '(1) after a restart the morning digest shows on, at 07:45');
        nodes = await reveal((current) => visible(row(current, en['settings.weeklyReviewDay'])));
        check(value(nodes, en['settings.weeklyReviewDay']) === 'Wednesday' && switchOn(nodes, en['settings.weeklyReview']),
            '(1) after a restart the weekly review shows on, on Wednesday');

        await flip(en['settings.notificationsEnable'], (stored) => stored.notificationsEnabled === false, '(1) Task reminders off is stored');
        await flip(en['settings.dailyDigestMorning'], (stored) => stored.dailyDigestMorningEnabled === false, '(1) the morning digest off is stored');
        await flip(en['settings.weeklyReview'], (stored) => stored.weeklyReviewEnabled === false, '(1) Weekly review off is stored');


        const capture = () => notifications().filter((item) => item.id === CAPTURE_ID && item.channel === CAPTURE_CHANNEL);
        await flip(en['settings.persistentCaptureLabel'], () => kv([KEYS.capture])[KEYS.capture] === 'true', '(2) the switch stores RN\'s key');
        await waitUntil('the capture notification', () => capture().length === 1, 15_000);
        check(capture()[0].title === en['captureNotification.title'] && capture()[0].text === en['captureNotification.text'],
            `(2) RN's notification is posted (id ${CAPTURE_ID}, channel ${CAPTURE_CHANNEL}) with core's words`);

        const removeCapture = async () => {
            sh(`am broadcast -f 0x20 -n ${RESCHEDULE} -a ${DEBUG_RESCHEDULE} --ez cancelCaptureNotification true`);
            await waitUntil('the capture notification removed', () => capture().length === 0, 10_000);
        };
        await removeCapture();
        await killApp();
        await launch();
        await waitUntil('the capture notification after a restart', () => capture().length === 1, 20_000);
        check(true, '(2) removed, then a process death: the next start shows it again');
        sh('input keyevent KEYCODE_HOME');
        await sleep(1500);
        check(Boolean(pid()), '(2) the app is in the background, its process alive');
        await removeCapture();
        await launch();
        await waitUntil('the capture notification after a resume', () => capture().length === 1, 20_000);
        check(true, '(2) removed while in the background: the resume shows it again');
        await toTabs();
        sh('input keyevent KEYCODE_HOME');
        await sleep(1000);
        await tapInShade(en['captureNotification.title']);
        await waitUntil('the quick capture dialog', () => front().includes('QuickCaptureActivity'), 20_000);
        check(true, '(2) a tap on it opens RN\'s quick capture dialog');
        sh('input keyevent KEYCODE_BACK');
        await sleep(1500);
        if (!front().includes(`${PKG}/`)) await launch();
        await openNotifications();


        setProp('journal_stop', 'after:notificationsSetting');
        let current = await reveal((shown) => visible(withDescription(shown, en['settings.persistentCaptureLabel'])));
        await tap(withDescription(current, en['settings.persistentCaptureLabel']));
        await waitUntil('the process to stop after the off was stored', () => !pid(), 20_000);
        setProp('journal_stop', '');
        check(kv([KEYS.capture])[KEYS.capture] === null && capture().length === 1, '(2) the off is stored and the notification is still pinned');
        await launch();
        await waitUntil('the capture notification to go after the restart', () => capture().length === 0, 30_000);
        await sleep(3000);
        check(capture().length === 0 && kv([KEYS.capture])[KEYS.capture] === null, '(2) the next start removes it, and it stays off');
        await openNotifications();
        current = await reveal((shown) => visible(withDescription(shown, en['settings.persistentCaptureLabel'])));
        check(!switchOn(current, en['settings.persistentCaptureLabel']), '(2) Settings › Notifications shows the switch off');
        await killApp();
        await launch();
        await sleep(3000);
        check(capture().length === 0, '(2) a later start pins nothing');
    }


    const shownOnce = (alert) => pomodoroAlerts().filter((item) => item.tag === alert.id);
    nodes = await idleCard();
    check(true, '(3) the 1/1 preset sets the clock to 01:00');
    const first = await startFocus(nodes);
    await waitUntil('one Pomodoro alarm at the phase end', () => armedAt(first) === 1, 15_000);
    check(book().armed.some((entry) => entry.id === first.id) && pomodoroAlarms().length === 1,
        `(3) Start arms one alarm at the phase end (${new Date(first.fireAtMs).toISOString()}) under core's id`);
    await killApp();
    await waitUntil('the focus alert', () => shownOnce(first).length === 1, Math.max(0, first.fireAtMs - Date.now()) + LATE_MS);
    const late = Date.now() - first.fireAtMs;
    const [focusAlert] = shownOnce(first);
    check(focusAlert.title === en['pomodoro.mobileTitle'] && focusAlert.text === en['pomodoro.focusComplete'] && focusAlert.when === first.fireAtMs && late > -2000,
        `(3) with the process gone the alert fires at the phase end (${late} ms after it), stamped with it, with core's words`);
    await sleep(15_000);
    let alarms = book();
    check(shownOnce(first).length === 1 && pomodoroAlarms().length === 0 && alarms.fired.some((entry) => entry.id === first.id)
        && !alarms.armed.some((entry) => entry.id === first.id), '(3) no second alert, no alarm left, and the ledger holds the alert');
    nodes = await launch();
    nodes = await toCard();
    await waitFor('the finished-phase line', (current) => tagged(current, 'pomodoro-event')?.text === en['pomodoro.focusComplete'], 30_000);
    await sleep(3000);
    check(pomodoroAlarms().length === 0 && shownOnce(first).length === 1, '(3) the next start shows RN\'s finished-phase line, arms nothing, and keeps the alert');
    sh('input keyevent KEYCODE_HOME');
    await sleep(1000);
    await tapInShade(en['pomodoro.focusComplete']);
    await waitUntil('the app in front', () => front().includes(`${PKG}/`), 20_000);
    await waitUntil('the alert to go', () => shownOnce(first).length === 0, 10_000);
    check(true, '(3) a tap on the alert opens the app, and the alert goes');


    nodes = await idleCard();
    await waitUntil('the journal to empty', () => journal().length === 0, 20_000);
    setProp('journal_stop', 'before:pomodoroTransitionCommit');
    await tap(await control('pomodoro-primary'));
    await waitUntil('the process to stop at the journaled Start', () => !pid(), 20_000);
    setProp('journal_stop', '');
    check(journal().length === 1 && pomodoro().state?.session?.timerState?.isRunning !== true, '(4) the Start is in the journal and core never committed it');
    await launch();
    nodes = await toCard();
    await waitFor('the replayed Start', (current) => primary(current) === en['common.pause'], 30_000);
    await waitUntil('the journal to empty', () => journal().length === 0, 20_000);
    const replayed = pomodoro().state;
    check(replayed?.session?.timerState?.isRunning === true && replayed.session.durations?.focusMinutes === 1 && replayed.session.durations?.breakMinutes === 1,
        '(4) the replay ran on the stored session: running, its 1/1 minutes kept');
    const replayAlert = { sessionID: replayed.sessionID, phase: 'focus', fireAtMs: Date.parse(replayed.session.phaseEndsAt) };
    await waitUntil('the replayed Start\'s alarm', () => armedAt(replayAlert) === 1, 15_000);
    check(pomodoroAlarms().length === 1 && book().armed.some((entry) => entry.id === pomodoroId(replayAlert)), '(4) one alarm is armed, and the journal is empty');
    nodes = await screen();
    await tapExpecting(await control('pomodoro-primary'), (current) => primary(current) === en['common.start'], 'Pause');
    await waitUntil('the alarm to go', () => pomodoroAlarms().length === 0, 15_000);
    check(true, '(4) Pause cancels it');


    nodes = await idleCard();
    const silenced = await startFocus(nodes);
    await waitUntil('the alarm', () => armedAt(silenced) === 1, 15_000);
    await openGtd(true);
    await setPomodoroSwitch(POMODORO.alert, false);
    await waitUntil('the alarm to go', () => pomodoroAlarms().length === 0, 15_000);
    check(!book().armed.some((entry) => entry.id === silenced.id), '(8) the alert turned off in Settings cancels the armed alarm');
    await sleep(Math.max(0, silenced.fireAtMs - Date.now()) + LATE_MS);
    check(shownOnce(silenced).length === 0 && pomodoroAlarms().length === 0, '(8) nothing shows after the phase end');
    await setPomodoroSwitch(POMODORO.alert, true);
    nodes = await toCard();
    await sleep(3000);
    check(shownOnce(silenced).length === 0 && pomodoroAlarms().length === 0, '(8) the alert on again on an ended phase: still nothing shows, nothing is armed');


    nodes = await idleCard();
    const stopped = await startFocus(nodes);
    await waitUntil('the alarm', () => armedAt(stopped) === 1, 15_000);
    await device.stopApp();
    check(pomodoroAlarms().length === 0 && book().armed.some((entry) => entry.id === stopped.id), '(7) a force-stop drops the alarm (the book still lists it)');
    await launch();
    await waitUntil('the alarm armed again', () => armedAt(stopped) === 1, 20_000);
    check(pomodoroAlarms().length === 1 && book().alarm?.fireAtMs === stopped.fireAtMs, '(7) the next start arms the same alert again, at the same time');
    nodes = await toCard();
    await tapExpecting(await control('pomodoro-primary'), (current) => primary(current) === en['common.start'], 'Pause');
    await waitUntil('the alarm to go', () => pomodoroAlarms().length === 0, 15_000);


    await openGtd(true);
    await setPomodoroSwitch(POMODORO.autoBreaks, true);
    nodes = await idleCard();
    const open = await startFocus(nodes);

    const breakOf = async (focus, timeoutMs) => {
        const state = await waitUntil('the auto-started break stored', () => {
            const { state: s } = pomodoro();
            return s?.sessionID === focus.sessionID && s.session?.timerState?.phase === 'break' && s.session.timerState.isRunning && s;
        }, timeoutMs, 2000);
        const alert = { sessionID: state.sessionID, phase: 'break', fireAtMs: Date.parse(state.session.phaseEndsAt) };
        return { ...alert, id: pomodoroId(alert) };
    };

    const openBreak = await breakOf(open, Math.max(0, open.fireAtMs - Date.now()) + 30_000);
    await waitUntil('the break\'s alarm', () => armedAt(openBreak) === 1, 30_000, 2000);
    await waitUntil('the focus alert', () => shownOnce(open).length === 1, Math.max(0, open.fireAtMs - Date.now()) + LATE_MS);
    await sleep(3000);
    check(shownOnce(open).length === 1 && shownOnce(open)[0].text === en['pomodoro.focusComplete'], '(5) the break starts and the focus alert shows, once');
    check(openBreak.id !== open.id && book().armed.some((entry) => entry.id === openBreak.id) && pomodoroAlarms().length === 1,
        '(5) the break\'s alarm is armed at its end under another id');
    nodes = await toCard();
    await tapExpecting(await control('pomodoro-primary'), (current) => primary(current) === en['common.start'], 'Pause');
    await waitUntil('the break\'s alarm to go', () => pomodoroAlarms().length === 0, 15_000);
    check(true, '(5) Pause cancels the break\'s alarm');


    nodes = await idleCard();
    const dark = await startFocus(nodes);
    await waitUntil('the alarm', () => armedAt(dark) === 1, 15_000);
    sh('input keyevent KEYCODE_SLEEP');
    await waitUntil('the screen off', () => /mWakefulness=Asleep|mWakefulness=Dozing/.test(sh('dumpsys power')), 15_000);
    await waitUntil('the focus alert', () => shownOnce(dark).length === 1, Math.max(0, dark.fireAtMs - Date.now()) + LATE_MS);
    const darkLate = Date.now() - dark.fireAtMs;
    check(shownOnce(dark)[0].when === dark.fireAtMs && darkLate > -2000 && darkLate < LATE_MS,
        `(6) with the screen off the focus alert arrives at the phase end (${darkLate} ms after it), stamped with it`);
    await sleep(15_000);
    check(pomodoroAlarms().length === 0 && !book().armed.some((entry) => entry.sessionID === dark.sessionID && entry.phase === 'break'),
        '(6) the auto-started break gets no alarm while the screen is off and the app does not run (RN\'s background rule)');
    sh('input keyevent KEYCODE_WAKEUP');
    sh('wm dismiss-keyguard');
    const darkBreak = await breakOf(dark, 30_000);
    await waitUntil('the break\'s alarm once the app runs', () => armedAt(darkBreak) === 1, 30_000);
    check(Date.now() < darkBreak.fireAtMs, '(6) the screen on again resumes the app, which arms the break\'s alert at its end');
    await waitUntil('the break\'s alert', () => shownOnce(darkBreak).length === 1, Math.max(0, darkBreak.fireAtMs - Date.now()) + LATE_MS);
    check(shownOnce(darkBreak)[0].text === en['pomodoro.breakComplete'] && shownOnce(darkBreak)[0].when === darkBreak.fireAtMs,
        '(6) the break\'s alert arrives at its end, stamped with it');
    await waitFor('the break settled', (current) => primary(current) === en['common.start'], 30_000);


    await openGtd(true);
    await setPomodoroSwitch(POMODORO.linkTask, true);
    nodes = await idleCard();
    nodes = await tapExpecting(await control('pomodoro-link'), (current) => Boolean(tagged(current, 'pomodoro-picker')), 'the task picker');
    nodes = await waitFor('a Focus task in the picker', (current) => Boolean(tagged(current, 'pomodoro-task')), 20_000);
    await tapExpecting(await control('pomodoro-task'), (current) => !tagged(current, 'pomodoro-picker') && Boolean(tagged(current, 'pomodoro-done')), 'the first Focus task');
    const linked = await waitUntil('the linked task stored', () => pomodoro().state?.session?.selectedTaskId, 15_000);
    const before = pomodoro(linked).minutes ?? fail('the linked task is not in the database');
    nodes = await waitFor('the card', card, 15_000);
    const credited = await startFocus(nodes);
    await waitUntil('the journal to empty', () => journal().length === 0, 20_000);

    setProp('journal_stop', 'after:pomodoroTransitionCommit');
    await waitUntil('the process to stop after the phase end committed', () => !pid(), Math.max(0, credited.fireAtMs - Date.now()) + 30_000, 500);
    setProp('journal_stop', '');
    check(journal().length === 1, '(9) the focus phase\'s end is committed and its journal entry left, as a process death right after it leaves it');
    await launch();
    await toCard();
    await waitUntil('the journal to empty', () => journal().length === 0, 20_000);
    const once = pomodoro(linked);
    check(once.minutes === before + 1 && once.state.session.sessionHistory?.totalCompletedFocusSessions >= 1,
        `(9) the replay gives the task its 1 focus minute once (${before} -> ${once.minutes})`);
    await killApp();
    await launch();
    await toCard();
    await sleep(3000);
    check(pomodoro(linked).minutes === before + 1, '(9) a further restart gives nothing more');
    nodes = await idleCard();
    nodes = await tapExpecting(await control('pomodoro-link'), (current) => Boolean(tagged(current, 'pomodoro-picker')), 'the task picker');
    await tapExpecting(await control('pomodoro-timer-only'), (current) => !tagged(current, 'pomodoro-picker') && !tagged(current, 'pomodoro-done'), 'Timer only');
    closeShade();

    console.log('Notifications device check passed');
} catch (error) {
    evidenced(error);
    try {
        console.log(`evidence - the app's Pomodoro log lines:\n${sh('logcat -d -v time -s MindwtrNativeDev:* AndroidRuntime:E').split('\n').filter((line) => /omodoro|journal|Exception|FATAL/i.test(line)).slice(-40).join('\n')}`);
    } catch {                   }
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
