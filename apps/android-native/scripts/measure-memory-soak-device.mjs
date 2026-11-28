import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, connect, fail, inEditor, tab, tabSelected, tagged, taskRows, withDescription } from './device.mjs';

const [serial, label, outDir, cyclesText = '200', everyText = '20', mode = 'checked'] = process.argv.slice(2);
if (!serial || !label || !outDir) {
    console.error('usage: node measure-memory-soak-device.mjs <adb-serial> <label> <out-dir> [cycles=200] [sample-every=20] [checked|replay]');
    process.exit(2);
}
const PKG = 'tech.dongdongbh.mindwtr.nativeclient.dev.benchmark';
const ACTIVITY = `${PKG}/${PKG}.MainActivity`;
const TAG = 'MindwtrNativeDev';
const cycles = Number(cyclesText);
const every = Number(everyText);
const { en } = await import(resolve(import.meta.dirname, '../../../packages/core/src/i18n/locales/en.ts'));
const device = connect({ serial, pkg: PKG, uiFile: '/dev/tty' });
const { sh, adbRaw, screen, waitFor, launch, stopApp, pid } = device;
const steps = [];
mkdirSync(outDir, { recursive: true });
const samplesFile = resolve(outDir, `${label}.jsonl`);
writeFileSync(samplesFile, '');

const onTabs = (nodes) => Boolean(tab(nodes, en['tab.inbox'])) && !inEditor(nodes) && !tagged(nodes, 'quick-capture')
    && !tagged(nodes, 'more-sheet') && !tagged(nodes, 'menu-screen') && !tagged(nodes, 'global-search');
const center = (node) => { const [x1, y1, x2, y2] = box(node); return [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)]; };
const tapThen = async (node, expected, description) => {
    const [x, y] = center(node ?? fail(`nothing on screen to tap for ${description}`));
    sh(`input tap ${x} ${y}`);
    steps.push({ tap: [x, y] });
    await sleep(300);
    return waitFor(description, expected, 15_000);
};
const backUntil = async (done, description) => {
    for (let step = 0; step < 3; step += 1) {
        sh('input keyevent KEYCODE_BACK');
        steps.push({ back: true });
        await sleep(600);
        const nodes = await screen();
        if (done(nodes)) return nodes;
    }
    return waitFor(description, done, 10_000);
};

const probe = async () => {
    const processId = pid() || fail('the app is not running');
    const since = sh('date "+%m-%d %H:%M:%S.000"');
    sh(`am broadcast -a tech.dongdongbh.mindwtr.BENCHMARK_MEMORY_PROBE -p ${PKG}`);
    let used = null;
    for (let wait = 0; wait < 40 && used === null; wait += 1) {
        await sleep(250);
        const lines = adbRaw('logcat', '-d', '-T', since, `--pid=${processId}`, '-s', `${TAG}:I`).toString('utf8');
        used = /benchmark memory probe quickjsUsedBytes=(\d+)/.exec(lines)?.[1] ?? null;
    }
    return used === null ? fail('no memory probe line after send-trim-memory') : Number(used);
};

const meminfo = async (cycle) => {
    const quickjsUsed = await probe();
    await sleep(1500);
    const text = sh(`dumpsys meminfo ${PKG}`);
    const row = (name) => Number(new RegExp(`^\\s*${name}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? NaN);
    const count = (name) => Number(new RegExp(`\\b${name}:\\s+(\\d+)`).exec(text)?.[1] ?? NaN);
    const sample = {
        label, cycle, at: new Date().toISOString(), pid: pid(), quickjsUsedKb: Math.round(quickjsUsed / 1024),
        javaHeapKb: row('Java Heap'), nativeHeapKb: row('Native Heap'), codeKb: row('Code'), graphicsKb: row('Graphics'),
        privateOtherKb: row('Private Other'), systemKb: row('System'), totalPssKb: Number(/TOTAL PSS:\s+(\d+)/.exec(text)?.[1] ?? NaN),
        views: count('Views'), viewRoots: count('ViewRootImpl'), activities: count('Activities'), appContexts: count('AppContexts'),
        binders: count('Local Binders'), proxyBinders: count('Proxy Binders'), deathRecipients: count('Death Recipients'),
    };
    appendFileSync(samplesFile, `${JSON.stringify(sample)}\n`);
    console.log(`sample ${label} cycle=${cycle} pss=${sample.totalPssKb} java=${sample.javaHeapKb} native=${sample.nativeHeapKb} quickjs=${sample.quickjsUsedKb} `
        + `graphics=${sample.graphicsKb} views=${sample.views} activities=${sample.activities}`);
    return sample;
};

const toTab = (nodes, name) => tapThen(tab(nodes, name) ?? fail(`no ${name} tab`), (current) => tabSelected(current, name) && onTabs(current), `the ${name} tab`);

const scrollInbox = async () => {
    const [x, from, to] = [540, 1650, 750];
    for (let step = 0; step < 5; step += 1) { sh(`input swipe ${x} ${from} ${x} ${to} 120`); await sleep(350); }
    await sleep(600);
    for (let step = 0; step < 5; step += 1) { sh(`input swipe ${x} ${to} ${x} ${from} 120`); await sleep(350); }
    await sleep(800);
};

const cycleOnce = async (nodes, cycle) => {
    nodes = await toTab(nodes, en['tab.next']);
    nodes = await toTab(nodes, quickTab);
    nodes = await toTab(nodes, en['tab.inbox']);
    await scrollInbox();
    steps.push({ scroll: true });
    nodes = await screen();
    await tapThen(taskRows(nodes)[0], inEditor, 'the task editor');
    nodes = await backUntil(onTabs, 'the editor to close');
    nodes = await tapThen(withDescription(nodes, en['nav.addTask']), (current) => Boolean(tagged(current, 'quick-capture')), 'quick capture');
    nodes = await tapThen(withDescription(nodes, en['common.close']), (current) => onTabs(current), 'quick capture to close');
    nodes = await tapThen(tab(nodes, en['tab.menu']), (current) => Boolean(tagged(current, 'more-sheet')), 'the More sheet');
    nodes = await tapThen(withDescription(nodes, en['nav.waiting']), (current) => Boolean(tagged(current, 'menu-screen')), 'Waiting For');
    nodes = await backUntil(onTabs, 'Waiting For to close');
    if (!tabSelected(nodes, en['tab.inbox'])) nodes = await toTab(nodes, en['tab.inbox']);
    nodes = await tapThen(withDescription(nodes, en['search.title']), (current) => Boolean(tagged(current, 'global-search')), 'the search screen');
    sh(`input text 'Synthetic%stask%s${(cycle % 90) + 10}'`);
    steps.push({ text: true });
    await sleep(1500);
    return backUntil(onTabs, 'the search to close');
};

const recoveries = [];
const recover = async (cycle, index) => {
    recoveries.push({ cycle, step: index });
    console.log(`recovery ${recoveries.length}: the app left the front before replayed step ${index} of cycle ${cycle}; relaunching the same process`);
    if (recoveries.length > 10) fail('more than 10 replay recoveries');
    launch(ACTIVITY);
    const nodes = await waitFor('the tab bar after a recovery', onTabs, 30_000);
    if (!tabSelected(nodes, en['tab.inbox'])) await toTab(nodes, en['tab.inbox']);
};
const replayOnce = async (cycle) => {
    for (const [index, step] of steps.entries()) {
        if (!device.front().includes(`${PKG}/`)) return recover(cycle, index);
        if (step.tap) { sh(`input tap ${step.tap[0]} ${step.tap[1]}`); await sleep(1500); }
        if (step.back) { sh('input keyevent KEYCODE_BACK'); await sleep(900); }
        if (step.scroll) { await scrollInbox(); await sleep(1500); }
        if (step.text) { sh(`input text 'Synthetic%stask%s${(cycle % 90) + 10}'`); await sleep(1500); }
        if (cycle === 2) writeFileSync(resolve(outDir, `${label}-replay-step${index}.png`), adbRaw('exec-out', 'screencap', '-p'));
    }
    if (!device.front().includes(`${PKG}/`)) await recover(cycle, steps.length);
};

const conditions = () => ({
    load: sh('cat /proc/loadavg'),
    battery: sh('dumpsys battery').split('\n').filter((line) => /^\s*(level|temperature):/.test(line)).map((line) => line.trim()),
    thermal: sh('dumpsys thermalservice').split('\n').find((line) => /Thermal Status/.test(line))?.trim(),
});

const started = Date.now();
console.log(`start ${label} ${JSON.stringify(conditions())}`);
await stopApp();
launch(ACTIVITY);
const shown = await waitFor('the tab bar', onTabs, 60_000);
const quickTab = [en['nav.projects'], en['tab.review'], en['nav.contexts'], en['tab.calendar']].find((name) => tab(shown, name)) ?? fail('no quick access tab');
await sleep(10_000);
const first = await meminfo(0);
let nodes = await screen();
for (let cycle = 1; cycle <= cycles; cycle += 1) {
    const cycleStart = Date.now();
    if (mode === 'replay' && cycle > 1) await replayOnce(cycle);
    else nodes = await cycleOnce(nodes, cycle);
    console.log(`cycle ${cycle} ${((Date.now() - cycleStart) / 1000).toFixed(1)} s`);
    if (cycle % every === 0) {
        if (mode === 'replay') await waitFor('the Inbox after the replayed cycles', (current) => onTabs(current) && tabSelected(current, en['tab.inbox']), 15_000);
        await meminfo(cycle);
        nodes = await screen();
    }
    if (pid() !== first.pid) fail(`the app process changed from ${first.pid} to ${pid()} at cycle ${cycle}`);
}
await sleep(60_000);
await meminfo(`${cycles}+60s`);
console.log(`replay recoveries ${JSON.stringify(recoveries)}`);
console.log(`end ${label} ${JSON.stringify(conditions())} minutes=${((Date.now() - started) / 60_000).toFixed(1)}`);
sh('input keyevent KEYCODE_HOME');
console.log(`SOAK DONE ${samplesFile}`);
