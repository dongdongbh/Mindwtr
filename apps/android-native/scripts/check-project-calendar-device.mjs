import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { box, check, connect, evidenced, fail, projectTitled, Stopped, tab, tabSelected, tagged } from './device.mjs';
import { cleanupOnExit } from './check-net-device.mjs';
import { serveCalendar } from './calendar-feed-server.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-project-calendar-device.mjs <adb-serial> [apk]');
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
const STAGED = '/data/local/tmp/mindwtr-native-dev-project-calendar.db';
const DB = 'mindwtr-native-dev.db';
const work = resolve(app, 'android/build/project-calendar-check');
const shots = resolve(process.env.MINDWTR_SHOTS_DIR ?? work, 'project-calendar');
const coreSrc = resolve(app, '../../packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));

const PORT = Number(process.env.MINDWTR_CALENDAR_PORT ?? 18784);
const RUN = String(Date.now()).slice(-8);
const FEED = `pc${RUN}`;
const NAMES = { project: 'PC1550Project', feed: `Plans${RUN}`, url: `http://127.0.0.1:${PORT}/${FEED}.ics`, event: `Kickoff ${RUN}`, other: `Trip ${RUN}` };
const civil = (date) => `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
const day = (offset) => civil(new Date(Date.now() + offset * 86_400_000));
const ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mindwtr check//EN', `X-WR-CALNAME:${NAMES.feed}`,
    'BEGIN:VEVENT', `UID:kickoff-${RUN}@mindwtr`, `DTSTART:${day(1)}T100000`, `DTEND:${day(1)}T113000`, `SUMMARY:${NAMES.event}`, 'END:VEVENT',
    'BEGIN:VEVENT', `UID:trip-${RUN}@mindwtr`, `DTSTART;VALUE=DATE:${day(2)}`, `DTEND;VALUE=DATE:${day(5)}`, `SUMMARY:${NAMES.other}`, 'END:VEVENT',
    'END:VCALENDAR', ''].join('\r\n');

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { adbRaw, sh, home, front, requireAppFront, pid, screen, waitFor, tap, tapExpecting, focusAtEnd, revealNode } = device;
const runAs = (command) => sh(`run-as ${PKG} ${command}`);
const logs = () => device.logs(pid(), TAG);

const pullDatabase = (name) => {
    const dir = resolve(work, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = runAs('ls files').split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    return resolve(dir, DB);
};

const core = (mode, db = pullDatabase(mode)) => JSON.parse(execFileSync('bun', ['-e', `
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
    const kept = JSON.parse(process.env.CHECK_KEPT);
    const store = () => useTaskStore.getState();
    const project = () => store()._allProjects.find((entry) => !entry.deletedAt && entry.title === names.project);
    if (process.env.CHECK_MODE === 'inject') {
        if (!project()) await store().addProject(names.project, '#94a3b8');
        await store().updateProject(project().id, { status: 'active', calendarReference: null });
        await store().updateSettings({ externalCalendars: [{ id: 'check-${FEED}', name: names.feed, url: names.url, enabled: true }],
            appearance: { ...store().settings.appearance, mobileQuickAccessView: 'projects' } });
    }
    if (process.env.CHECK_MODE === 'cleanup') {
        if (project()) await store().deleteProject(project().id);
        await store().updateSettings({ externalCalendars: kept.externalCalendars ?? [],
            appearance: { ...store().settings.appearance, mobileQuickAccessView: kept.quickView ?? undefined } });
    }
    await flushPendingSave();
    if (store().persistenceFailure) throw new Error('save failed: ' + store().persistenceFailure.message);
    const out = { project: project() ? { id: project().id, calendarReference: project().calendarReference ?? null, rev: project().rev ?? 0 } : null,
        externalCalendars: store().settings.externalCalendars ?? null, quickView: store().settings.appearance?.mobileQuickAccessView ?? null };
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    console.log(JSON.stringify(out));
    process.exit(0);
`], { encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, CHECK_DB: db, CHECK_MODE: mode, CHECK_NAMES: JSON.stringify(NAMES), CHECK_KEPT: JSON.stringify(kept ?? {}) } })
    .trim().split('\n').pop());

const textNode = (nodes, text) => nodes.find((node) => node.text === text && node.class !== 'android.widget.EditText');
const inside = (outer, inner) => box(inner)[1] >= box(outer)[1] && box(inner)[3] <= box(outer)[3];
const card = (nodes) => tagged(nodes, 'project-calendar-reference');
const cardText = (nodes) => {
    const outer = card(nodes);
    return outer ? nodes.filter((node) => node.text && inside(outer, node)).map((node) => node.text) : [];
};
const shot = (name) => {
    mkdirSync(shots, { recursive: true });
    const file = resolve(shots, `${name}.png`);
    writeFileSync(file, adbRaw('exec-out', 'screencap', '-p'));
    console.log(`screenshot ${file}`);
};
const onTabs = (nodes) => Boolean(tab(nodes, en['tab.inbox']));
const inProject = (nodes) => projectTitled(nodes, NAMES.project);
const savedLines = (outcome) => logs().split('\n').filter((line) => line.includes('releaseCheck=v1.3.9/project-calendar-reference') && line.includes(`outcome=${outcome}`)).length;
const hideKeyboard = async () => {
    if (/mInputShown=true/.test(sh('dumpsys input_method'))) { requireAppFront(); sh('input keyevent KEYCODE_BACK'); await sleep(800); }
};

const rewrite = async (mode) => {
    await device.stopApp();
    const db = pullDatabase(mode);
    const out = core(mode, db);
    adbRaw('push', db, STAGED);
    try { runAs(`cp ${STAGED} files/${DB}`); } finally { sh(`rm -f ${STAGED}`); }
    runAs(`rm -f files/${DB}-wal files/${DB}-shm`);
    return out;
};
const start = async () => {
    await device.stopApp();
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    device.launch(ACTIVITY);
    const nodes = await waitFor('the tabs', (current) => onTabs(current) || Boolean(textNode(current, en['onboarding.skipForNow'])), 60_000);
    return textNode(nodes, en['onboarding.skipForNow'])
        ? tapExpecting(textNode(nodes, en['onboarding.skipForNow']), (current) => onTabs(current) && !textNode(current, en['onboarding.skipForNow']), 'the welcome sheet skipped')
        : nodes;
};
const openProject = async () => {
    let nodes = await screen();
    if (inProject(nodes)) return nodes;
    nodes = await tapExpecting(tab(nodes, en['projects.title']) ?? fail('no Projects tab'), (current) => tabSelected(current, en['projects.title']), 'the Projects tab');
    nodes = await device.settle(await device.reveal(NAMES.project, 60));
    return tapExpecting(textNode(nodes, NAMES.project) ?? fail(`no project row ${NAMES.project}`), inProject, `the project ${NAMES.project}`);
};
const openDetails = async () => {
    const nodes = await openProject();
    if (!card(nodes) && !tagged(nodes, 'project-details-status')) {
        await tap(await revealNode((current) => tagged(current, 'project-details-toggle'), 'the Details toggle'));
        await waitFor('the Details panel', (current) => Boolean(card(current)) || Boolean(tagged(current, 'project-details-status')), 15_000);
    }
    return showCard();
};
const showCard = async () => {
    await revealNode((current) => card(current), 'the calendar card', false);
    return screen();
};
const revealTag = (name) => revealNode((current) => tagged(current, name), name, false);

let server = null;
let kept = null;
let fixtureAdded = false;
const cleanup = cleanupOnExit([
    () => execFileSync(adbBin, ['-s', serial, 'reverse', '--remove', `tcp:${PORT}`], { stdio: 'ignore' }),
    () => { void server?.close(); },
    () => sh(`rm -f ${UI_FILE} ${STAGED}`),
]);

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}\nrun: ${RUN}`);
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    server = await serveCalendar(PORT, ICS);
    execFileSync(adbBin, ['-s', serial, 'reverse', `tcp:${PORT}`, `tcp:${PORT}`], { stdio: 'inherit' });
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    sh('cmd uimode night no');
    await start();
    const before = core('view');
    kept = { externalCalendars: before.externalCalendars, quickView: before.quickView };
    console.log(`info - kept ${JSON.stringify(kept)} to put back`);
    fixtureAdded = true;
    let seen = await rewrite('inject');
    check(seen.project?.calendarReference === null && seen.externalCalendars?.length === 1, `core stores ${NAMES.project} unlinked and one feed ${NAMES.feed} at the stub`);

    await start();
    const requests = server.state.seen.length;
    let nodes = await openDetails();
    nodes = await showCard();
    await sleep(3000);
    nodes = await showCard();
    check(server.state.seen.length === requests, `(1) an unlinked Project downloads no calendar feed (${server.state.seen.length - requests} requests while it showed)`);
    check(Boolean(tagged(nodes, 'project-calendar-link')) && cardText(nodes).includes(en['projects.calendarLink']) && !cardText(nodes).includes(en['projects.calendarTitle'])
        && !tagged(nodes, 'project-calendar-unlink'), `(1) the card shows RN's "${en['projects.calendarLink']}" and no header without a link`);
    shot('native-unlinked');

    nodes = await tapExpecting(tagged(nodes, 'project-calendar-link'), (current) => Boolean(tagged(current, 'project-calendar-search')), 'the inline picker');
    nodes = await screen();
    check(Boolean(card(nodes)) && inside(card(nodes), tagged(nodes, 'project-calendar-search')), '(2) the picker opens inside the card, as in RN');
    check(cardText(nodes).includes(en['projects.calendarHelp']) && cardText(nodes).includes(en['projects.calendarWindow']), '(2) with RN\'s help and window text');
    await focusAtEnd(await revealTag('project-calendar-search'));
    requireAppFront();
    sh(`input text '${RUN}'`);
    const row = (current, title) => current.find((node) => /(^|\/)project-calendar-event-\d+$/.test(node['resource-id'] ?? '')
        && ((node.text ?? '').includes(title) || current.some((inner) => inner.text === title && inside(node, inner))));
    await sleep(1000);
    await hideKeyboard();
    const listed = (current) => Boolean(row(current, NAMES.event)) && Boolean(row(current, NAMES.other));
    nodes = await screen();
    for (const deadline = Date.now() + 45_000; !listed(nodes) && Date.now() < deadline;) {
        nodes = tagged(nodes, 'project-calendar-cancel') ? await screen() : await device.swipe(nodes, 'down');
        if (!listed(nodes)) await sleep(1000);
    }
    check(listed(nodes), `(2) the picker lists the stub's "${NAMES.event}" and "${NAMES.other}"`);
    shot('native-picker');
    const linked = savedLines('linked');
    await tap(row(nodes, NAMES.event) ?? (await revealNode((current) => row(current, NAMES.event), NAMES.event, false)));
    await waitFor('the link stored', () => { seen = core('view'); return seen.project?.calendarReference?.title === NAMES.event; }, 30_000);
    check(seen.project.calendarReference.uid === `kickoff-${RUN}@mindwtr`, `(3) a tap links "${NAMES.event}" (stored uid ${seen.project.calendarReference.uid})`);
    check(savedLines('linked') > linked, '(3) the write logs releaseCheck=v1.3.9/project-calendar-reference outcome=linked');
    nodes = await waitFor('the linked card', (current) => cardText(current).includes(NAMES.event) && !tagged(current, 'project-calendar-search'), 30_000);
    const dateLabel = tagged(nodes, 'project-calendar-date')?.text ?? '';
    check(/ – /.test(dateLabel) && dateLabel.includes('10:00') && dateLabel.includes('11:30') && dateLabel.endsWith(` · ${NAMES.feed}`),
        `(4) the card shows "start – end" (${dateLabel})`);
    check(cardText(nodes).includes(en['projects.calendarTitle']) && cardText(nodes).includes(en['projects.calendarScheduled'])
        && cardText(nodes).includes(en['projects.calendarReplace']) && cardText(nodes).includes(en['projects.calendarUnlink']),
        '(4) with RN\'s header, "Scheduled next step", Replace and Unlink');
    nodes = await waitFor('the refreshed status', (current) => !tagged(current, 'project-calendar-status'), 30_000);
    shot('native-linked');

    server.state.mode(FEED, 'slow');
    await start();
    const requested = server.state.seen.length;
    const opened = Date.now();
    nodes = await openDetails();
    nodes = await waitFor('the stored event', (current) => cardText(current).includes(NAMES.event), 8_000);
    const shownAfter = Date.now() - opened;
    nodes = await showCard();
    check(cardText(nodes).includes(en['projects.calendarLastKnown']) && / – /.test(tagged(nodes, 'project-calendar-date')?.text ?? ''),
        `(5) after a restart the stored event shows at once (${shownAfter} ms), marked "${en['projects.calendarLastKnown']}", while the feed is still slow`);
    shot('native-linked-last-known');
    await waitFor('the linked feed request', () => server.state.seen.slice(requested).some((entry) => entry.path?.includes(FEED)), 15_000);
    check(true, '(5) a linked Project still downloads its feed to refresh the event');
    server.state.mode(FEED, 'ok');
    await hideKeyboard();
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await waitFor('the Projects list', (current) => !inProject(current), 15_000);
    nodes = await openDetails();
    nodes = await waitFor('the refreshed event', (current) => cardText(current).includes(NAMES.event) && !tagged(current, 'project-calendar-status'), 45_000);
    check(true, '(5) on the next open the refreshed event replaces the last-known line');

    const unlinked = savedLines('unlinked');
    nodes = await showCard();
    await tap(tagged(nodes, 'project-calendar-unlink') ?? fail('no Unlink'));
    await waitFor('the unlink stored', () => { seen = core('view'); return seen.project?.calendarReference === null; }, 30_000);
    check(savedLines('unlinked') > unlinked, '(6) Unlink clears the stored link and logs outcome=unlinked');
    nodes = await waitFor('the unlinked card', (current) => cardText(current).includes(en['projects.calendarLink']) && !cardText(current).includes(NAMES.event), 30_000);
    check(!cardText(nodes).includes(en['projects.calendarTitle']), '(6) the card goes back to Link only');
    console.log('Project calendar reference device check passed');
} catch (error) {
    try {
        console.log(`evidence - server saw: ${JSON.stringify(server?.state.seen.map(({ path, mode, at }) => `${at} ${path} ${mode}`))}`);
        console.log(`evidence - card: ${JSON.stringify(cardText(await screen()))}`);
        console.log(`evidence - app log:\n${logs().split('\n').filter((line) => /alendar|Core action failed|AndroidRuntime/.test(line)).slice(-30).map((line) => line.slice(0, 300)).join('\n')}`);
    } catch {}
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    try {
        if (fixtureAdded) {
            const left = await rewrite('cleanup');
            if (left.project || JSON.stringify(left.externalCalendars) !== JSON.stringify(kept.externalCalendars ?? [])) console.error(`RESTORE: the fixture is still stored: ${JSON.stringify(left)}`);
            device.launch(ACTIVITY);
        }
    } catch (error) { console.error(`RESTORE FAILED: ${error.message}`); process.exitCode = 1; }
    cleanup();
    await sleep(500);
    process.exit(process.exitCode ?? 0);
}
