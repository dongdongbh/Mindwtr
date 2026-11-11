import { execFileSync } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, check, connect, evidenced, fail, inEditor, mainList, Stopped, tab, tagged, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-calendar-push-device.mjs <adb-serial> [apk]');
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
const TAG = 'MindwtrNativeDev';
const UI_FILE = '/data/local/tmp/mindwtr-native-dev-ui.xml';
const STAGED = '/data/local/tmp/mindwtr-native-dev-calendar-push.db';
const DB = 'mindwtr-native-dev.db';
const QUEUE = 'files/pending-captures';
const EVENTS = 'content://com.android.calendar/events';
const CALENDARS = 'content://com.android.calendar/calendars';
const ENABLED_KEY = 'mindwtr:calendar-push-sync:enabled';
const work = resolve(app, 'android/build/calendar-push-check');
const { en } = await import(resolve(repo, 'packages/core/src/i18n/locales/en.ts'));

const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const TITLES = { timed: `CP${run} timed`, allDay: `CP${run} allday`, done: `CP${run} done`, gone: `CP${run} gone`, off: `CP${run} afteroff`, mine: `CP${run} mine`,
    shade: `CP${run} shade` };
const BACKGROUND_LINE = 'Native Android calendar push after background work releaseCheck=v1.3.9/native-calendar-push-background';

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { adbRaw, sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting } = device;
const runAs = (command) => sh(`run-as ${PKG} sh -c '${command}'`);
const waitUntil = async (description, predicate, timeoutMs = 60_000, everyMs = 1000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await predicate();
        if (value) return value;
        if (Date.now() > deadline) return fail(`timed out waiting for ${description}`);
        await sleep(everyMs);
    }
};

const pullFile = (remote, name) => {
    const dir = resolve(work, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const base = remote.split('/').pop();
    const folder = remote.slice(0, remote.length - base.length - 1);
    const present = runAs(`ls ${folder}`).split(/\s+/);
    for (const suffix of ['', '-wal', '-shm', '-journal']) if (present.includes(`${base}${suffix}`)) device.pull(`${remote}${suffix}`, resolve(dir, `${base}${suffix}`));
    return resolve(dir, base);
};
const sqlite = (file, query) => {
    const out = execFileSync('sqlite3', ['-json', file, query], { encoding: 'utf8', maxBuffer: 256 << 20 }).trim();
    return out ? JSON.parse(out) : [];
};
const tasks = () => sqlite(pullFile(`files/${DB}`, 'db'), `SELECT id, title, dueDate, startTime, status, deletedAt FROM tasks WHERE title LIKE 'CP${run} %'`);
const task = (title) => tasks().find((row) => row.title === title && !row.deletedAt);
const pushEnabled = () => sqlite(pullFile('databases/RKStorage', 'rk'), `SELECT value FROM catalystLocalStorage WHERE key = '${ENABLED_KEY}'`)[0]?.value === '1';
const enqueue = (item) => {
    const bytes = Buffer.from(JSON.stringify(item), 'utf8').toString('base64');
    runAs(`mkdir -p ${QUEUE} && echo ${bytes} | base64 -d > ${QUEUE}/${item.id}.tmp && mv ${QUEUE}/${item.id}.tmp ${QUEUE}/${item.id}.json`);
};
const capture = (text) => enqueue({ id: randomUUID(), title: text, createdAt: new Date().toISOString(), source: 'android-capture-intent' });
const checkOff = (taskId) => enqueue({ kind: 'complete', id: randomUUID(), taskId, completedAt: new Date().toISOString(), source: 'android-widget' });

const rows = (uri, projection, where = '') => {
    const keys = projection.split(':');
    const split = new RegExp(`, (?=(?:${keys.join('|')})=)`);
    return sh(`content query --uri ${uri} --projection ${projection}${where ? ` --where "${where}"` : ''}`).split(/^Row: \d+ /m).slice(1)
        .map((record) => Object.fromEntries(record.replace(/\n$/, '').split(split).map((field) => {
            const at = field.indexOf('=');
            const value = field.slice(at + 1);
            return [field.slice(0, at), value === 'NULL' ? null : value];
        })));
};
const calendars = () => rows(CALENDARS, '_id:name:calendar_displayName:account_type:account_name:calendar_access_level:ownerAccount');
const mindwtrCalendar = () => calendars().find((row) => row.name === 'mindwtr' || row.name?.startsWith('mindwtr:')) ?? null;
const events = (calendarId) => rows(EVENTS, '_id:calendar_id:title:dtstart:dtend:allDay:description:deleted', `calendar_id=${calendarId} AND deleted=0`);
const eventFor = (calendarId, taskId) => events(calendarId).find((row) => (row.description ?? '').split('\n').includes(`Mindwtr-Task-ID: ${encodeURIComponent(taskId)}`)) ?? null;
const otherEvents = (calendarId) => createHash('sha256').update(JSON.stringify(rows(EVENTS, '_id:calendar_id:dtstart:dtend:deleted')
    .filter((row) => row.calendar_id !== String(calendarId)).sort((left, right) => Number(left._id) - Number(right._id)))).digest('hex');
const otherEventCount = (calendarId) => rows(EVENTS, '_id:calendar_id').filter((row) => row.calendar_id !== String(calendarId)).length;

const corePick = () => calendars().sort((left, right) => Number(left._id) - Number(right._id)).find((row) => row.calendar_access_level === '700'
    && (row.ownerAccount ?? '').trim() && (row.account_name ?? '').trim());

const localDue = (offsetDays, hour, minute) => {
    const day = new Date(Date.now() + offsetDays * 86_400_000);
    const pad = (value) => String(value).padStart(2, '0');
    return { text: `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}${hour === null ? '' : ` ${pad(hour)}:${pad(minute)}`}`,
        ms: hour === null ? Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()) : new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute).getTime() };
};

const editDb = async (statements) => {
    await device.stopApp();
    if (pid()) fail('the app must be stopped to edit its database');
    const file = pullFile(`files/${DB}`, 'edit');
    execFileSync('bun', ['-e', `
        import { Database } from 'bun:sqlite';
        const db = new Database(process.env.CHECK_DB);
        db.exec(process.env.CHECK_SQL);
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        db.close();
    `], { env: { ...process.env, CHECK_DB: file, CHECK_SQL: statements } });
    adbRaw('push', file, STAGED);
    try {
        runAs(`cp ${STAGED} files/${DB}.calendar-new`);
        if (Number(runAs(`stat -c %s files/${DB}.calendar-new`)) !== statSync(file).size) fail('the staged database has the wrong size');
        if (pid()) fail('the app started while its database was being replaced');
        runAs(`rm -f files/${DB}-wal files/${DB}-shm && mv -f files/${DB}.calendar-new files/${DB}`);
    } finally { sh(`rm -f ${STAGED}`); }
};

const sheetOpen = (nodes) => Boolean(tagged(nodes, 'more-sheet'));
const onCalendarSettings = (nodes) => Boolean(tagged(nodes, 'settings-calendar'));
const toTabs = async () => {
    for (let step = 0; step < 10; step += 1) {
        const nodes = await screen();
        if (tab(nodes, en['tab.menu']) && !tagged(nodes, 'menu-screen') && !sheetOpen(nodes) && !inEditor(nodes)) return nodes;
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(1000);
    }
    return fail('the tabs did not come back');
};
const reveal = async (find, description) => {
    let nodes = await device.toTop();
    const inView = (current) => {
        const node = find(current);
        const list = mainList(current);
        return node && (!list || (box(node)[1] >= box(list)[1] && box(node)[3] <= box(list)[3] - 40)) ? node : null;
    };
    for (let step = 0; step < 20 && !inView(nodes); step += 1) nodes = await device.swipe(nodes, 'down');
    return inView(nodes) ?? fail(`no ${description} on screen`);
};
const openCalendarSettings = async () => {
    if (onCalendarSettings(await screen())) return screen();
    let nodes = await toTabs();
    nodes = await tapExpecting(tab(nodes, en['tab.menu']) ?? fail('no Menu tab'), sheetOpen, 'the More sheet');
    await tapExpecting(withDescription(await device.settle(nodes), en['nav.settings']) ?? fail('no Settings tile'), (next) => Boolean(tagged(next, 'settings-main')), 'Settings');
    await tapExpecting(await reveal((next) => withDescription(next, `${en['settings.advanced']}. ${en['settings.menuDesc.advanced']}`), 'Advanced row'),
        (next) => Boolean(tagged(next, 'settings-advanced')), 'Settings › Advanced');
    return tapExpecting(await reveal((next) => withDescription(next, `${en['settings.calendar']}. ${en['settings.menuDesc.calendar']}`), 'Calendar row'),
        onCalendarSettings, 'Settings › Calendar', 30_000);
};
const prompt = (current) => current.some((node) => /permission_(allow|deny)_button$/.test(node['resource-id'] ?? '')) || current.some((node) => /permission_allow_foreground_only_button$/.test(node['resource-id'] ?? ''));
const allowPrompt = async (current) => {
    const button = current.find((node) => (node['resource-id'] ?? '').endsWith('permission_allow_button')) ?? fail('no Allow on the calendar prompt');
    const [left, top, right, bottom] = box(button);
    sh(`input tap ${Math.round((left + right) / 2)} ${Math.round((top + bottom) / 2)}`);
    await sleep(1500);
};
const pushSwitch = async () => reveal((current) => tagged(current, 'calendar-push-switch'), 'the calendar push switch');
const relaunch = async () => {
    await device.stopApp();
    device.launch(ACTIVITY);
    await waitFor('the app', (nodes) => Boolean(tab(nodes, en['tab.menu'])), 60_000);
};

const deleteThroughApp = async () => {
    await openCalendarSettings();
    const deleteRow = (current) => withDescription(current, en['settings.calendarMobile.deleteMindwtrCalendar']);
    const remove = await reveal(deleteRow, 'Delete Mindwtr calendar').catch(async () => {
        await tap(await reveal((current) => tagged(current, 'calendar-push'), 'the calendar push card'));
        await sleep(1500);
        return reveal(deleteRow, 'Delete Mindwtr calendar');
    });
    const nodes = await tapExpecting(remove, (current) => Boolean(tagged(current, 'calendar-delete-confirm')), 'the delete question');
    await tap(tagged(nodes, 'calendar-delete-confirm'));
    await waitUntil('Mindwtr\'s calendar gone', () => !mindwtrCalendar(), 30_000);
};

const notificationsSetting = () => sqlite(pullFile(`files/${DB}`, 'db'), "SELECT json_extract(data, '$.notificationsEnabled') AS value FROM settings WHERE id = 1")[0]?.value ?? null;
const shown = (title) => sh('dumpsys notification --noredact').split(/\n(?=\s*NotificationRecord\()/)
    .some((block) => block.includes(`pkg=${PKG}`) && new RegExp(`android\\.title=\\w+ \\(${title}\\)`).test(block));
const tapComplete = async (title) => {
    sh('cmd statusbar expand-notifications');
    await sleep(1500);
    const center = (node) => { const [l, t, r, b] = box(node); return [Math.round((l + r) / 2), Math.round((t + b) / 2)]; };
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const nodes = await screen();
        const titleNode = nodes.find((node) => node.text === title) ?? fail(`the reminder "${title}" is not in the shade`);
        const [, y] = center(titleNode);
        const button = nodes.find((node) => (node.text ?? '').toUpperCase() === 'COMPLETE' && center(node)[1] > y && center(node)[1] < y + 500);
        if (button) { const [x, by] = center(button); sh(`input tap ${x} ${by}`); return; }
        const expand = nodes.filter((node) => /\/expand_button$/.test(node['resource-id'] ?? '') && Math.abs(center(node)[1] - y) < 140)[0];
        if (expand) { const [x, ey] = center(expand); sh(`input tap ${x} ${ey}`); } else sh(`input swipe ${center(titleNode)[0]} ${y} ${center(titleNode)[0]} ${y + 400} 300`);
        await sleep(1200);
    }
    fail(`no COMPLETE on "${title}" in the shade`);
};
const exactMode = /SCHEDULE_EXACT_ALARM: (\w+)/.exec(sh(`appops get ${PKG} SCHEDULE_EXACT_ALARM`))?.[1] ?? 'default';
let keptNotifications;

let calendarId = null;
let unmarkedId = null;
let created = false;
const restore = async () => {
    try { if (calendarId && unmarkedId) sh(`content delete --uri ${EVENTS} --where "_id=${unmarkedId} AND calendar_id=${calendarId}"`); } catch {}
    try {
        if (created && mindwtrCalendar()) {
            if (!front().includes(`${PKG}/`)) device.launch(ACTIVITY);
            if (!pushEnabled()) { await openCalendarSettings(); await tap(await pushSwitch()); await sleep(3000); }
            await deleteThroughApp();
            console.log('note - the check deleted Mindwtr\'s calendar and its events with the app\'s own Delete Mindwtr calendar');
        }
    } catch (error) {
        const own = mindwtrCalendar();
        if (own?.account_type === 'LOCAL') {
            sh(`content delete --uri '${CALENDARS}?caller_is_syncadapter=true&account_name=${own.account_name}&account_type=LOCAL' --where "_id=${own._id}"`);
            console.log(`note - the app's delete failed (${error.message}); removed Mindwtr's LOCAL calendar ${own._id} directly`);
        } else if (own) console.error(`RESTORE: Mindwtr's calendar ${own._id} (${own.account_type}) is left on the phone: ${error.message}`);
    }
    try {
        const left = tasks().filter((row) => !row.deletedAt && row.status !== 'done');
        if (left.length) {
            await device.stopApp();
            for (const row of left) checkOff(row.id);
            device.launch(ACTIVITY);
            await sleep(8000);
        }
    } catch (error) { console.error(`RESTORE: this run's tasks were not checked off (${error.message})`); }
    try {
        if (keptNotifications !== undefined && keptNotifications !== 1 && keptNotifications !== true) {
            await editDb(keptNotifications === null ? "UPDATE settings SET data = json_remove(data, '$.notificationsEnabled') WHERE id = 1"
                : `UPDATE settings SET data = json_set(data, '$.notificationsEnabled', json('${keptNotifications ? 'true' : 'false'}')) WHERE id = 1`);
            device.launch(ACTIVITY);
            await sleep(6000);
        }
    } catch (error) { console.error(`RESTORE: the reminder setting was not put back (${error.message})`); }
    try { sh(`appops set ${PKG} SCHEDULE_EXACT_ALARM ${exactMode}`); } catch {}
    try { sh('cmd statusbar collapse'); } catch {}
    try { if (front().includes(`${PKG}/`)) sh('input keyevent KEYCODE_HOME'); } catch {}
    try { sh(`rm -f ${UI_FILE} ${STAGED}`); } catch {}
};

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    console.log('info - dd allowed this check to create Mindwtr\'s own calendar on the test phone; it touches no other calendar or event');
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    if (mindwtrCalendar()) throw new Stopped(`a Mindwtr calendar (${mindwtrCalendar()._id}) is already on the phone; this check starts from none`);
    const pick = corePick();
    if (pick?.account_type !== 'LOCAL') throw new Stopped(`core would create Mindwtr's calendar under a ${pick?.account_type ?? 'missing'} account, not a LOCAL one; that needs dd`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    for (const permission of ['READ_CALENDAR', 'WRITE_CALENDAR']) {
        sh(`pm revoke ${PKG} android.permission.${permission} || true`);
        sh(`pm clear-permission-flags ${PKG} android.permission.${permission} user-set user-fixed || true`);
    }

    const due = { timed: localDue(2, 15, 30), allDay: localDue(3, null), done: localDue(2, 11, 0), gone: localDue(2, 12, 0), moved: localDue(4, 9, 15), off: localDue(2, 16, 0) };
    await device.stopApp();
    for (const key of ['timed', 'allDay', 'done', 'gone']) capture(`${TITLES[key]} /due:${due[key].text}`);
    device.launch(ACTIVITY);
    await waitUntil('the four dated tasks', () => ['timed', 'allDay', 'done', 'gone'].every((key) => task(TITLES[key])), 60_000);
    check(task(TITLES.allDay).dueDate === due.allDay.text && Date.parse(task(TITLES.timed).dueDate ?? '') === due.timed.ms,
        `(1) four dated tasks, one all-day on ${due.allDay.text} and one at ${due.timed.text}`);

    let nodes = await openCalendarSettings();
    check(!pushEnabled(), '(2) calendar push starts off');
    nodes = await tapExpecting(await pushSwitch(), prompt, 'the system calendar prompt');
    created = true;
    await allowPrompt(nodes);
    const own = await waitUntil('Mindwtr\'s calendar', () => mindwtrCalendar(), 60_000);
    calendarId = own._id;
    check(own.account_type === 'LOCAL' && own.calendar_displayName === 'Mindwtr' && own.name.startsWith('mindwtr:') && own.calendar_access_level === '700',
        `(2) on, after the system prompt: Mindwtr's own calendar ${calendarId} is made on the phone's LOCAL account, as RN makes it`);
    check(pushEnabled(), '(2) the push setting is stored on');
    const otherBefore = otherEvents(calendarId);
    console.log(`info - ${otherEventCount(calendarId)} events in other calendars are fingerprinted (ids and times only) and must not change`);

    const ids = Object.fromEntries(['timed', 'allDay', 'done', 'gone'].map((key) => [key, task(TITLES[key]).id]));
    await waitUntil('an event for each dated task', () => ['timed', 'allDay', 'done', 'gone'].every((key) => eventFor(calendarId, ids[key])), 60_000);
    const timed = eventFor(calendarId, ids.timed);
    const allDay = eventFor(calendarId, ids.allDay);
    check(timed.title === TITLES.timed && Number(timed.dtstart) === due.timed.ms && Number(timed.dtend) > Number(timed.dtstart) && timed.allDay === '0',
        `(3) the timed task's event has RN's title, starts at ${due.timed.text} and carries the task's Mindwtr line`);
    check(allDay.title === TITLES.allDay && allDay.allDay === '1' && Number(allDay.dtstart) === due.allDay.ms && Number(allDay.dtend) === due.allDay.ms + 86_400_000,
        `(3) the all-day task's event is all day on ${due.allDay.text} (UTC midnight to midnight, as RN writes it on Android)`);

    const start = due.timed.ms + 86_400_000;
    sh(`content insert --uri ${EVENTS} --bind calendar_id:i:${calendarId} --bind title:s:'${TITLES.mine}' --bind dtstart:l:${start} --bind dtend:l:${start + 3_600_000} --bind eventTimezone:s:UTC --bind description:s:'made by hand'`);
    const mine = events(calendarId).find((row) => row.title === TITLES.mine) ?? fail('the hand-made event was not stored');
    unmarkedId = mine._id;

    nodes = await toTabs();
    nodes = await tapExpecting(tab(nodes, en['tab.inbox']) ?? fail('no Inbox tab'), (current) => current.some((node) => node.text === TITLES.done), 'the Inbox with the tasks');
    await device.completeUntil(TITLES.done, `${TITLES.done} done`, (current) => !current.some((node) => node.text === TITLES.done));
    await waitUntil('the done task\'s event removed', () => !eventFor(calendarId, ids.done), 60_000);
    check(true, '(4) completing a task in the app removes its event right away (push follows the store, as RN)');

    await editDb(`UPDATE tasks SET dueDate = '${new Date(due.moved.ms).toISOString()}', updatedAt = '${new Date().toISOString()}', rev = rev + 1 WHERE id = '${ids.timed}';
        UPDATE tasks SET deletedAt = '${new Date().toISOString()}', updatedAt = '${new Date().toISOString()}', rev = rev + 1 WHERE id = '${ids.gone}'`);
    device.launch(ACTIVITY);
    await waitUntil('the moved event and the deleted task\'s event gone', () => {
        const moved = eventFor(calendarId, ids.timed);
        return moved && Number(moved.dtstart) === due.moved.ms && !eventFor(calendarId, ids.gone) ? moved : null;
    }, 90_000);
    check(eventFor(calendarId, ids.timed)._id === timed._id, `(5) a new date moves the same event to ${due.moved.text}, and a deleted task's event is removed (the start's full push)`);
    const kept = events(calendarId).find((row) => row._id === unmarkedId);
    check(kept && kept.title === TITLES.mine && Number(kept.dtstart) === start && kept.description === 'made by hand',
        '(6) an event in Mindwtr\'s calendar without a Mindwtr line is never changed or removed');
    check(otherEvents(calendarId) === otherBefore, '(6) no event in any other calendar changed');

    sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`);
    sh(`appops set ${PKG} SCHEDULE_EXACT_ALARM allow`);
    keptNotifications = notificationsSetting();
    const fireAt = Math.ceil((Date.now() + 150_000) / 60_000) * 60_000;
    const pad = (value) => String(value).padStart(2, '0');
    const at = new Date(fireAt);
    await editDb("UPDATE settings SET data = json_set(data, '$.notificationsEnabled', json('true')) WHERE id = 1");
    capture(`${TITLES.shade} /due:${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`);
    device.launch(ACTIVITY);
    const shadeId = (await waitUntil('the reminder task', () => task(TITLES.shade), 60_000)).id;
    await waitUntil('the reminder task\'s event', () => eventFor(calendarId, shadeId), 60_000);
    sh('input keyevent KEYCODE_HOME');
    await sleep(1500);
    for (let attempt = 0; attempt < 10 && pid(); attempt += 1) { try { runAs(`kill -9 ${pid()}`); } catch {} await sleep(500); }
    if (pid()) fail('the app did not close');
    sh('logcat -c');
    await waitUntil(`the reminder for ${TITLES.shade}`, () => shown(TITLES.shade), fireAt - Date.now() + 90_000, 3000);
    await tapComplete(TITLES.shade);
    sh('cmd statusbar collapse');
    await waitUntil('the event removed by the background Done', () => !eventFor(calendarId, shadeId), 150_000, 2000);
    const line = adbRaw('logcat', '-d', '-s', `${TAG}:*`).toString('utf8').split('\n').find((entry) => entry.includes(BACKGROUND_LINE)) ?? '';
    check(!front().includes(`${PKG}/`) && /"job":"reminderDone"/.test(line.replace(/\\/g, '')) && /"outcome":"pushed"/.test(line.replace(/\\/g, '')),
        '(6b) with the app closed, Done on the reminder pushes the calendar in the background: the event is gone and the log shows the push (C4d)');
    check(otherEvents(calendarId) === otherBefore, '(6b) no event in any other calendar changed');
    device.launch(ACTIVITY);
    await waitFor('the app', (current) => Boolean(tab(current, en['tab.menu'])), 60_000);

    nodes = await openCalendarSettings();
    await tap(await pushSwitch());
    await waitUntil('push stored off', () => !pushEnabled(), 20_000);
    check(eventFor(calendarId, ids.timed) && eventFor(calendarId, ids.allDay) && mindwtrCalendar(), '(7) off, as RN: push stops and Mindwtr\'s calendar and its events stay');
    await device.stopApp();
    capture(`${TITLES.off} /due:${due.off.text}`);
    device.launch(ACTIVITY);
    await waitUntil('the task made after off', () => task(TITLES.off), 60_000);
    await sleep(10_000);
    check(!eventFor(calendarId, task(TITLES.off).id), '(7) a dated task made while push is off gets no event');
    check(otherEvents(calendarId) === otherBefore, '(7) still no event in any other calendar changed');

    sh(`content delete --uri ${EVENTS} --where "_id=${unmarkedId} AND calendar_id=${calendarId}"`);
    unmarkedId = null;
    nodes = await openCalendarSettings();
    await tap(await pushSwitch());
    await waitUntil('push stored on again', () => pushEnabled(), 20_000);
    await waitUntil('the task made while off pushed now', () => eventFor(calendarId, task(TITLES.off).id), 60_000);
    check(mindwtrCalendar()?._id === calendarId, '(8) on again: the same Mindwtr calendar is used, and the full push adds the task made while off');
    await deleteThroughApp();
    check(!mindwtrCalendar() && !pushEnabled() && rows(EVENTS, '_id', `calendar_id=${calendarId}`).length === 0,
        '(8) Delete Mindwtr calendar removes the calendar and its events and turns push off, as RN');
    check(otherEvents(calendarId) === otherBefore, '(8) no event in any other calendar changed');
    calendarId = null;
    console.log('Calendar push device check passed');
} catch (error) {
    try { console.log(`evidence - app log (calendar):\n${device.logs(pid(), TAG).split('\n').filter((line) => /alendar/.test(line)).slice(-30).map((line) => line.slice(0, 300)).join('\n')}`); } catch {}
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
