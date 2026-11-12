import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, check, connect, evidenced, fail, inboxCount, inEditor, isOn, mainList, Stopped, tagged, taskRow, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-checklist-drag-device.mjs <adb-serial> [apk]');
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
const UI_FILE = '/data/local/tmp/mindwtr-native-dev-ui.xml';
const STAGED = '/data/local/tmp/mindwtr-native-dev-checklist-drag.db';
const DB = 'mindwtr-native-dev.db';
const work = resolve(app, 'android/build/checklist-drag-check');
const shots = process.env.MINDWTR_SHOTS ?? work;
const coreSrc = resolve(app, '../../packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));

const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const names = { task: `78${run}1`, items: ['Alpha', 'Bravo', 'Charlie', 'Delta'], long: `78${run}2`,
    longItems: Array.from({ length: 15 }, (_, index) => `Row${String(index + 1).padStart(2, '0')}`) };

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { adbRaw, sh, home, front, requireAppFront, screen, waitFor, tapExpecting } = device;
const runAs = (command) => sh(`run-as ${PKG} ${command}`);
const shoot = (name) => { writeFileSync(resolve(shots, `${name}.png`), adbRaw('exec-out', 'screencap', '-p')); console.log(`shot - ${name}.png`); };

const pullDatabase = (name) => {
    const dir = resolve(work, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = runAs('ls files').split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    return resolve(dir, DB);
};

const core = (mode, db) => JSON.parse(execFileSync('bun', ['-e', `
    import { Database } from 'bun:sqlite';
    import { SqliteAdapter, createNativeHostContract, flushPendingSave, setStorageAdapter, useTaskStore } from '${coreSrc}/index.ts';
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
    const names = JSON.parse(process.env.CHECK_NAMES);
    const store = () => useTaskStore.getState();
    const live = (items) => items.filter((item) => !item.deletedAt);
    const saved = async () => { await flushPendingSave(); if (store().persistenceFailure) throw new Error('save failed: ' + store().persistenceFailure.message); };
    let out;
    if (process.env.CHECK_MODE === 'inject') {
        for (const [title, items] of [[names.long, names.longItems], [names.task, names.items]]) {
            const result = await store().addTask(title, { status: 'inbox',
                checklist: items.map((item) => ({ id: crypto.randomUUID(), title: item, isCompleted: false })) });
            if (!result.success) throw new Error('addTask failed: ' + result.error);
        }
        await saved();
        out = {};
    } else if (process.env.CHECK_MODE === 'remove') {
        const done = (result) => { if (!result.success) throw new Error('remove failed: ' + result.error); };
        const tasks = live(store()._allTasks).filter((task) => task.title === names.task || task.title === names.long).map((task) => task.id);
        if (tasks.length > 0) { done(await store().batchDeleteTasks(tasks)); done(await store().purgeTasks(tasks)); }
        await saved();
        out = { tasks: tasks.length };
    } else {
        const titles = (title) => live(store()._allTasks).find((entry) => entry.title === title)?.checklist?.map((entry) => entry.title) ?? null;
        const task = live(store()._allTasks).find((entry) => entry.title === names.task);
        const model = task && host.getTaskEditorModel({ id: task.id });
        const section = model?.ok ? model.value.layout.sections.find((entry) => entry.fields.includes('checklist')) ?? null : null;
        out = { task: task ? { checklist: titles(names.task) } : null, long: titles(names.long),
            section: section && { titleKey: section.titleKey ?? null, open: section.open !== false } };
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    console.log(JSON.stringify(out));
    process.exit(0);
`], { encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, CHECK_DB: db, CHECK_MODE: mode, CHECK_NAMES: JSON.stringify(names) } }).trim().split('\n').pop());

const putDatabase = (db) => {
    adbRaw('push', db, STAGED);
    try { runAs(`cp ${STAGED} files/${DB}`); } finally { sh(`rm -f ${STAGED}`); }
    runAs(`rm -f files/${DB}-wal files/${DB}-shm`);
};
const read = (name) => core('read', pullDatabase(name));
const readUntil = async (name, done, ms = 20_000) => {
    let seen = read(name);
    for (const deadline = Date.now() + ms; !done(seen) && Date.now() < deadline; await sleep(800)) seen = read(name);
    return seen;
};

const onInbox = (nodes) => !tagged(nodes, 'menu-screen') && !inEditor(nodes) && Number.isFinite(inboxCount(nodes));
const handles = (nodes, count = names.items.length) => Array.from({ length: count }, (_, index) => tagged(nodes, `checklist-drag-${index}`));
const top = (node) => box(node)[1];
const inputs = (nodes) => nodes.filter((node) => (node['resource-id'] ?? '').endsWith('checklist-item-input'))
    .sort((a, z) => top(a) - top(z)).map((node) => node.text);
const allShown = (nodes) => {
    const list = mainList(nodes);
    const found = handles(nodes);
    return list && found.every(Boolean) && top(found[0]) >= box(list)[1] && box(found.at(-1))[3] <= box(list)[3] ? found : null;
};
const centre = (node) => (box(node)[1] + box(node)[3]) / 2;
const moveTo = (x, from, to, steps) => Array.from({ length: steps }, (_, index) => `input motionevent MOVE ${x} ${Math.round(from + ((to - from) * (index + 1)) / steps)}`).join('; ');
const bandDifference = (frames, idlePng, droppedPng, band) => JSON.parse(execFileSync('python3', ['-I', '-c', `
import json, os, sys
from PIL import Image, ImageChops, ImageStat
folder, idle, dropped, band = sys.argv[1], sys.argv[2], sys.argv[3], json.loads(sys.argv[4])
def crop(path):
    image = Image.open(path).convert('L')
    if image.size != (1080, 2340): image = image.resize((1080, 2340))
    return image.crop(tuple(band))
def distance(a, b): return ImageStat.Stat(ImageChops.difference(a, b)).mean[0]
old, new = crop(idle), crop(dropped)
print(json.dumps([[distance(crop(os.path.join(folder, name)), old), distance(crop(os.path.join(folder, name)), new)] for name in sorted(os.listdir(folder))]))
`, frames, idlePng, droppedPng, JSON.stringify(band)], { encoding: 'utf8', maxBuffer: 64 << 20 }).trim());
const originalNight = /Night mode: (\w+)/.exec(sh('cmd uimode night'))?.[1] ?? 'auto';

let injected = false;
let held = null;
const restore = async () => {
    if (held) { try { sh(`input motionevent UP ${held.x} ${held.y}`); } catch (error) { console.error(`release the held drag: ${error.message}`); } }
    try { sh(`cmd uimode night ${['yes', 'no', 'auto'].includes(originalNight) ? originalNight : 'auto'}`); } catch (error) { console.error(`restore night mode: ${error.message}`); }
    if (!injected) return;
    try {
        const current = front();
        if (!current.includes(`${PKG}/`) && !current.includes(`${home}/`)) throw new Error(`another app is in front: ${current.trim()}`);
        await device.stopApp();
        const db = pullDatabase('remove');
        const removed = core('remove', db);
        putDatabase(db);
        injected = false;
        device.launch(ACTIVITY);
        await waitFor('the Inbox', onInbox, 60_000);
        console.log(`note - removed this run's fixture: ${removed.tasks} task deleted forever`);
    } catch (error) {
        console.error(`RESTORE FAILED: this run's fixture (78${run}…) could not be removed (${error.message}); run check-projects-device.mjs --prune-old`);
        process.exitCode = 1;
    }
};

try {
    mkdirSync(work, { recursive: true });
    mkdirSync(shots, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    if (Number(sh('getprop ro.build.version.sdk')) < 30) throw new Stopped('the held drag needs `input motionevent` (Android 11 or later)');
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    sh('cmd uimode night no');
    device.launch(ACTIVITY);
    requireAppFront();
    await waitFor('the Inbox', onInbox, 60_000);
    await device.stopApp();
    core('inject', pullDatabase('inject'));
    injected = true;
    putDatabase(resolve(work, 'inject', DB));
    device.launch(ACTIVITY);
    await waitFor('the Inbox', onInbox, 60_000);
    let seen = read('seeded');
    check(JSON.stringify(seen.task?.checklist) === JSON.stringify(names.items), `an Inbox task ${names.task} with the checklist ${names.items.join(', ')} is stored`);
    check(JSON.stringify(seen.long) === JSON.stringify(names.longItems), `an Inbox task ${names.long} with ${names.longItems.length} checklist rows is stored`);

    const editTab = (current) => withDescription(current, en['markdown.edit']);
    const openChecklist = async (title) => {
        const row = await device.revealNode((current) => taskRow(current, title), `the row ${title}`);
        let found = await tapExpecting(row, inEditor, `${title}'s editor`);
        if (editTab(found) && !isOn(editTab(found))) found = await tapExpecting(editTab(found), (current) => isOn(editTab(current)), 'the Edit tab');
        if (seen.section?.titleKey && !seen.section.open) {
            for (let step = 0; step < 10 && !withDescription(found, en[seen.section.titleKey]); step += 1) found = await device.swipe(found, 'down');
            found = await tapExpecting(withDescription(found, en[seen.section.titleKey]) ?? fail(`no ${en[seen.section.titleKey]} section`),
                (current) => Boolean(tagged(current, 'checklist-drag-0')), 'the checklist field');
        }
        return found;
    };
    const save = (current) => withDescription(current, en['common.save']) ?? current.find((node) => node.text === en['common.save']);
    let nodes = await openChecklist(names.task);
    for (let step = 0; step < 10 && !allShown(nodes); step += 1) {
        const next = await device.swipe(nodes, top(handles(nodes)[0] ?? { bounds: '[0,99999][0,99999]' }) > box(mainList(nodes))[1] ? 'down' : 'up');
        if (device.signature(next) === device.signature(nodes)) break;
        nodes = next;
    }
    let idle = allShown(nodes) ?? fail('the four checklist drag handles are not all on screen');
    const [, listTop, , listBottom] = box(mainList(nodes));
    const middle = (top(idle[0]) + box(idle[3])[3]) / 2;
    const offset = Math.round(middle - (listTop + listBottom) / 2);
    if (Math.abs(offset) > 150) {
        requireAppFront();
        sh(`input swipe 700 ${Math.round((listTop + listBottom) / 2)} 700 ${Math.round((listTop + listBottom) / 2) - offset} 1500`);
        await sleep(1200);
        nodes = await device.settle();
        idle = allShown(nodes) ?? fail('the checklist moved off screen while centring it');
    }
    check(JSON.stringify(inputs(nodes)) === JSON.stringify(names.items), `the editor lists ${names.items.join(', ')} in order`);
    shoot('checklist-idle');

    const pitch = top(idle[1]) - top(idle[0]);
    check(pitch > 60, `the checklist rows are ${pitch}px apart`);
    const [x1, y1, x2, y2] = box(idle[0]);
    const x = Math.round((x1 + x2) / 2);
    const y = Math.round((y1 + y2) / 2);
    const finger = Math.round(pitch * 1.6);
    requireAppFront();
    held = { x, y: y + finger };
    sh(`input motionevent DOWN ${x} ${y}; sleep 0.4; ${moveTo(x, y, y + finger, 30)}`);
    await sleep(900);
    shoot('checklist-mid-drag');
    const mid = await screen();
    const moved = handles(mid).map((node, index) => node ? top(node) - top(idle[index]) : null);
    console.log(`info - finger moved ${finger}px; handle tops moved ${JSON.stringify(moved)} (row pitch ${pitch}px)`);
    const near = (value, expected) => value !== null && Math.abs(value - expected) <= pitch * 0.3;
    check(moved[0] !== null && Math.abs(moved[0] - finger) <= 16, `(a) mid-drag, the dragged row stays under the finger: it moved ${moved[0]}px for a ${finger}px drag`);
    check(near(moved[1], -pitch) && near(moved[2], -pitch), `(b) mid-drag, Bravo and Charlie shift up one row (${moved[1]}px, ${moved[2]}px) to show the drop slot under Charlie`);
    check(near(moved[3], 0), `(c) mid-drag, Delta below the slot stays put (${moved[3]}px)`);
    const recording = '/data/local/tmp/mindwtr-checklist-drop.mp4';
    sh(`rm -f ${recording}`);
    const recorder = spawn(adbBin, ['-s', serial, 'shell', `screenrecord --time-limit 4 ${recording}`], { stdio: 'ignore' });
    const recorded = new Promise((done) => recorder.on('exit', done));
    await sleep(1500);
    sh(`input motionevent UP ${held.x} ${held.y}`);
    held = null;
    await recorded;
    await sleep(500);

    const expected = ['Bravo', 'Charlie', 'Alpha', 'Delta'];
    nodes = await waitFor('the dropped order', (current) => JSON.stringify(inputs(current)) === JSON.stringify(expected), 15_000);
    const settled = handles(nodes);
    check(settled.every((node, index) => node && Math.abs(top(node) - top(idle[index])) <= 4),
        '(d) after the drop every row sits in its own slot again, with no leftover offset');
    shoot('checklist-dropped');
    const frames = resolve(work, 'drop-frames');
    rmSync(frames, { recursive: true, force: true });
    mkdirSync(frames, { recursive: true });
    adbRaw('pull', recording, resolve(work, 'drop.mp4'));
    sh(`rm -f ${recording}`);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-i', resolve(work, 'drop.mp4'), '-fps_mode', 'passthrough', resolve(frames, '%04d.png')]);
    const bandLeft = box(idle[0])[2] + 120;
    const band = [bandLeft, box(idle[0])[1], Math.min(bandLeft + 400, 1000), box(idle[0])[3]];
    const distances = bandDifference(frames, resolve(shots, 'checklist-idle.png'), resolve(shots, 'checklist-dropped.png'), band);
    const flashed = distances.filter(([old, dropped]) => old < dropped).length;
    console.log(`info - ${distances.length} recorded frames around the drop; ${flashed} show Alpha back in the first slot`);
    check(distances.length >= 2 && distances.at(-1)[1] < distances.at(-1)[0],
        `(e) the screen recording around the drop has ${distances.length} frames and ends with Bravo in the first slot`);
    await tapExpecting(save(nodes) ?? fail('no Save'), (current) => !inEditor(current), 'the editor to save and close');
    seen = await readUntil('saved', (current) => JSON.stringify(current.task?.checklist) === JSON.stringify(expected));
    check(JSON.stringify(seen.task?.checklist) === JSON.stringify(expected), `(f) Save stores the moved order ${expected.join(', ')} (stored ${JSON.stringify(seen.task?.checklist)})`);

    nodes = await openChecklist(names.long);
    const longHandles = (current) => handles(current, names.longItems.length);
    for (let step = 0; step < 10 && !longHandles(nodes)[0]; step += 1) nodes = await device.swipe(nodes, 'down');
    const [, viewTop, , viewBottom] = box(mainList(nodes));
    let first = longHandles(nodes)[0] ?? fail('no drag handle for Row01');
    const lift = Math.round(centre(first) - (viewTop + 420));
    if (Math.abs(lift) > 80) {
        requireAppFront();
        sh(`input swipe 700 ${Math.round((viewTop + viewBottom) / 2)} 700 ${Math.round((viewTop + viewBottom) / 2) - lift} 1500`);
        await sleep(1200);
        nodes = await device.settle();
        first = longHandles(nodes)[0] ?? fail('Row01 moved off screen while placing it');
    }
    const longPitch = top(longHandles(nodes)[1] ?? fail('no drag handle for Row02')) - top(first);
    const longX = Math.round((box(first)[0] + box(first)[2]) / 2);
    const longY = Math.round(centre(first));
    const edgeY = viewBottom - 100;
    requireAppFront();
    held = { x: longX, y: edgeY };
    sh(`input motionevent DOWN ${longX} ${longY}; sleep 0.4; ${moveTo(longX, longY, edgeY, 40)}`);
    await sleep(6000);
    shoot('checklist-long-auto-scrolled');
    const scrolled = await screen();
    const visible = longHandles(scrolled).map((node) => (node && box(node)[1] >= viewTop && box(node)[3] <= viewBottom ? node : undefined));
    const dragged = visible[0];
    console.log(`info - long list: finger held at ${edgeY}px; Row01's handle centre ${dragged ? centre(dragged) : 'off screen'}; visible handles ${visible.map((node, index) => node ? index : null).filter((index) => index !== null).join(',')}`);
    check(!visible[1] && visible.some((node, index) => node && index > 1), '(g) auto-scroll carried Row01\'s own slot out of view');
    check(dragged && Math.abs(centre(dragged) - edgeY) <= 24, `(h) after auto-scroll, Row01 still sits under the finger (${dragged ? Math.round(centre(dragged) - edgeY) : 'off screen'}px away)`);
    sh(`input motionevent UP ${held.x} ${held.y}`);
    held = null;
    await sleep(1500);
    nodes = await device.settle();
    await tapExpecting(save(nodes) ?? fail('no Save'), (current) => !inEditor(current), 'the long list to save and close');
    seen = await readUntil('long saved', (current) => current.long?.[0] !== 'Row01');
    const landed = seen.long?.indexOf('Row01') ?? -1;
    const reordered = names.longItems.filter((item) => item !== 'Row01');
    reordered.splice(landed, 0, 'Row01');
    check(landed >= 10 && JSON.stringify(seen.long) === JSON.stringify(reordered), `(i) the drop stores Row01 at slot ${landed + 1}, under the finger near the list end (stored ${JSON.stringify(seen.long)})`);
    const slot = (index) => (index <= landed ? index - 1 : index);
    const anchors = visible.map((node, index) => (node && index > 0 ? top(node) - slot(index) * longPitch : null)).filter((value) => value !== null);
    check(anchors.length >= 3 && Math.max(...anchors) - Math.min(...anchors) <= 6,
        `(j) mid-drag, the visible rows sat in the slots of the stored order, with the gap where Row01 landed (spread ${anchors.length ? Math.max(...anchors) - Math.min(...anchors) : 'none'}px)`);
    check(flashed === 0, `(k) no frame after the short-list drop showed Alpha snapping back to its old slot (${flashed} frames did)`);
    console.log('Checklist drag device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
