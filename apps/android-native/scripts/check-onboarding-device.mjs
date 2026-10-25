// RN's first-run welcome sheet and startup prompts on the native app (pass O2f), on the benchmark package only (its own data,
// never the dev app's): the debuggable benchmarkSeed build is installed there and its state wiped before each empty start, as
// check-startup-device does.
//
//   node apps/android-native/scripts/check-onboarding-device.mjs <adb-serial> <benchmarkSeed.apk> [screenshot-dir]
//
// (a) An empty library with sync off opens the welcome sheet, RN's options in order (Start, Set up sync, Import tasks); Skip
// stores the dismissal, so a new start opens no sheet. (b) Set up sync closes the sheet for this run only and opens Settings ›
// Sync with RN's Getting Started card, whose Start seeds and opens Getting Started; the next start opens the sheet again. (c) Start using Mindwtr seeds Getting Started and
// opens it with RN's actions; its header "..." lists RN's project actions in order, Complete and Reactivate swap, Duplicate opens
// the copy, and the copy's Delete closes it with Undo, which puts it back; Open Inbox shows the Inbox with the two sample items. (d) The editor's Scheduling help starts
// closed and opens with core's hint. (e) A debug preview (debug.mindwtr.native.startup_prompt) opens the announcement, the
// update reminder and the donation window; the close button dismisses each. GitHub is never called: about_stub points the
// update check at a closed local port. Screenshots of each surface go to [screenshot-dir] for the side-by-side with RN.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { button, check, connect, evidenced, fail, hasText, isOn, projectTitled, Stopped, tab, tabSelected, tagged, withDescription } from './device.mjs';

const [serial, seedApk, shotsArg] = process.argv.slice(2);
if (!serial || !seedApk) {
    console.error('usage: check-onboarding-device.mjs <adb-serial> <benchmarkSeed.apk> [screenshot-dir]');
    process.exit(2);
}
const app = resolve(import.meta.dirname, '..');
const PKG = 'tech.dongdongbh.mindwtr.nativeclient.dev.benchmark';
const ACTIVITY = `${PKG}/${PKG}.MainActivity`;
const UI_FILE = '/data/local/tmp/mindwtr-onboarding-ui.xml';
const PROPS = ['startup_prompt', 'about_stub'];
const shots = shotsArg ?? resolve(process.env.HOME, '.mindwtr-harness/onboarding');
const { en } = await import(resolve(app, '../../packages/core/src/i18n/locales/en.ts'));
const { STARTER_SEED_STRINGS } = await import(resolve(app, '../../packages/core/src/i18n/starter-seed-strings.ts'));
const STARTER_TITLE = STARTER_SEED_STRINGS.en['starter.projectTitle'];

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: process.env.ADB ?? '/home/dd/Android/Sdk/platform-tools/adb' });
const { adbRaw, sh, home, front, requireAppFront, screen, waitFor, tap, tapExpecting } = device;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
const runAs = (command) => sh(`run-as ${PKG} ${command}`);
const shot = (name) => {
    mkdirSync(shots, { recursive: true });
    writeFileSync(resolve(shots, `native-${name}.png`), adbRaw('exec-out', 'screencap', '-p'));
};
const byText = (nodes, text) => nodes.find((node) => node.text === text);
const onTabs = (nodes) => Boolean(tab(nodes, en['tab.menu']));
const sheet = (nodes) => Boolean(tagged(nodes, 'welcome-sheet'));
const promptWindow = (nodes) => Boolean(tagged(nodes, 'startup-prompt'));

/** The benchmark package's whole state goes (measure-startup-device.mjs seed): an empty library, sync off, nothing dismissed. */
const wipe = async () => {
    await device.stopApp();
    runAs('rm -rf files no_backup shared_prefs cache databases');
    runAs('mkdir -p files');
};
const start = async (done, description, options) => {
    await device.stopApp();
    device.launch(ACTIVITY, options);
    requireAppFront();
    return waitFor(description, done, 60_000);
};
const centerY = (node) => { const [, top, , bottom] = node.bounds.match(/\d+/g).map(Number); return (top + bottom) / 2; };

const restore = async () => {
    for (const name of PROPS) { try { setProp(name, ''); } catch { /* device gone */ } }
    try { setProp('start_tab', 'inbox'); } catch { /* device gone */ }
    try { if (front().includes(`${PKG}/`)) await device.stopApp(); } catch { /* the app is gone */ }
    try { sh(`rm -f ${UI_FILE}`); } catch { /* device gone */ }
};

try {
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${seedApk}\napk sha256: ${createHash('sha256').update(readFileSync(seedApk)).digest('hex')}`);
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    adbRaw('install', '-r', seedApk);
    // The update reminder's GitHub read goes to a closed local port: it fails at once, and no real request leaves the phone.
    setProp('about_stub', '9');
    setProp('startup_prompt', '');

    // (a) The sheet on an empty library, RN's order; Skip is stored.
    await wipe();
    // The app's own start (no harness start tab): an empty library opens on Focus, RN's home tab, under the sheet.
    let nodes = await start(sheet, 'the welcome sheet', { startTab: '' });
    const options = [en['onboarding.startFreshTitle'], en['onboarding.syncTitle'], en['onboarding.importTitle']].map((title) => byText(nodes, title));
    check(options.every(Boolean) && centerY(options[0]) < centerY(options[1]) && centerY(options[1]) < centerY(options[2]),
        '(a) an empty library opens the welcome sheet: Start using Mindwtr, then Set up sync, then Import tasks');
    shot('welcome');
    nodes = await tapExpecting(byText(nodes, en['onboarding.skipForNow']) ?? fail('no Skip for now'), (current) => !sheet(current) && onTabs(current), 'the tabs');
    // The sheet is its own window (its dump holds no tabs): the tabs under it, read once it closes, are that same start's.
    check(tabSelected(nodes, en['tab.next']), '(a) the welcome sheet opened over Focus, RN\'s home tab');
    await start(onTabs, 'the tabs after Skip');
    await sleep(3000);
    check(!sheet(await screen()), '(a) after Skip, a new start opens no welcome sheet');

    // (b) Set up sync hands off to Settings › Sync with the Getting Started card; the sheet comes back next start.
    await wipe();
    nodes = await start(sheet, 'the welcome sheet again');
    nodes = await tapExpecting(tagged(nodes, 'welcome-sync') ?? fail('no Set up sync'), (current) => Boolean(tagged(current, 'mobile-onboarding-start-fresh-handoff')), 'the Sync handoff card');
    check(Boolean(byText(nodes, en['settings.gettingStartedContentContinueTitle'])), '(b) Set up sync opens Settings › Sync with the Getting Started card');
    shot('handoff-sync');
    nodes = await start(sheet, 'the welcome sheet after the handoff');
    check(true, '(b) the handoff closed the sheet for that run only: the next start opens it again');
    // The card's Start using Mindwtr on Sync seeds Getting Started and opens it (review O2f P1-1).
    nodes = await tapExpecting(tagged(nodes, 'welcome-sync') ?? fail('no Set up sync'), (current) => Boolean(tagged(current, 'mobile-onboarding-start-fresh-handoff')), 'the Sync handoff card again');
    nodes = await tapExpecting(tagged(nodes, 'mobile-onboarding-start-fresh-handoff'), (current) => Boolean(tagged(current, 'getting-started-actions')), 'Getting Started from the card', 60_000);
    check(true, '(b) the Sync card\'s Start using Mindwtr seeds Getting Started and opens it');

    // (c) needs an empty library again.
    await wipe();
    nodes = await start(sheet, 'the welcome sheet on a new empty library');

    // (c) Start using Mindwtr: Getting Started opens with RN's actions; Open Inbox shows the sample items.
    nodes = await tapExpecting(tagged(nodes, 'welcome-start') ?? fail('no Start using Mindwtr'), (current) => Boolean(tagged(current, 'getting-started-actions')), 'Getting Started', 60_000);
    check(Boolean(byText(nodes, en['onboarding.captureAction'])) && Boolean(byText(nodes, en['onboarding.readGuide'])),
        '(c) Start using Mindwtr opens Getting Started with Capture to Inbox and the guide link');
    nodes = await waitFor('the Getting Started title', (current) => projectTitled(current, STARTER_TITLE), 15_000);
    check(true, '(c) the project screen shows the Getting Started title');
    shot('getting-started');

    // (c) The header's "..." (RN's project actions, O2f-parity b1): Duplicate, Complete, Cancel project and Delete, in RN's order.
    const sheetOpen = (current) => Boolean(tagged(current, 'project-actions-sheet'));
    const openActions = async () => tapExpecting(tagged(await screen(), 'project-actions-menu-button') ?? fail('no project actions button'), sheetOpen, 'the project actions');
    const closeActions = async (current) => tapExpecting(button(current, en['common.close']) ?? fail('no Close on the sheet'), (next) => !sheetOpen(next), 'the sheet closed');
    // The sheet once it offers [tag]: a write's reply lands a moment after the tap.
    const actionsOffer = async (tag, description) => {
        for (let attempt = 0; attempt < 10; attempt += 1) {
            const open = await openActions();
            if (tagged(open, tag)) return open;
            await closeActions(open);
            await sleep(500);
        }
        return fail(`the project actions never offered ${description}`);
    };
    nodes = await openActions();
    // The Convert row comes with core's answer, a moment after the sheet.
    nodes = await waitFor('the Convert to section row', (current) => Boolean(tagged(current, 'project-convert-to-section-button')), 15_000);
    const actionRows = ['project-duplicate-button', 'project-archive-button', 'project-cancel-button', 'project-delete-button'].map((tag) => tagged(nodes, tag));
    check(actionRows.every(Boolean) && actionRows.every((row, index) => index === 0 || centerY(actionRows[index - 1]) < centerY(row)),
        '(c) the project\'s "..." lists Duplicate, Complete, Cancel project and Delete in RN\'s order');
    shot('project-actions');
    // Convert to section… is listed after Duplicate, offered or off with core's reason; when offered it opens RN's two-step sheet.
    const convertRow = tagged(nodes, 'project-convert-to-section-button');
    check(Boolean(convertRow) && centerY(actionRows[0]) < centerY(convertRow) && centerY(convertRow) < centerY(actionRows[1]),
        '(c) Convert to section… follows Duplicate');
    if (convertRow?.enabled === 'true') {
        nodes = await tapExpecting(convertRow, (current) => Boolean(tagged(current, 'project-convert-sheet')), 'the convert sheet');
        shot('project-convert');
        nodes = await tapExpecting(button(nodes, en['common.cancel']) ?? fail('no Cancel on the convert sheet'), (current) => !tagged(current, 'project-convert-sheet'), 'the convert sheet closed');
        nodes = await openActions();
    }
    // Complete files it (Reactivate offered, no Cancel project); Reactivate makes it active again.
    await tapExpecting(tagged(nodes, 'project-archive-button'), (current) => !sheetOpen(current), 'the sheet closed');
    nodes = await actionsOffer('project-reactivate-button', 'Reactivate after Complete');
    check(!tagged(nodes, 'project-cancel-button'), '(c) Complete files the project: its actions offer Reactivate and no Cancel project');
    await tapExpecting(tagged(nodes, 'project-reactivate-button'), (current) => !sheetOpen(current), 'the sheet closed');
    nodes = await actionsOffer('project-archive-button', 'Complete after Reactivate');
    check(Boolean(tagged(nodes, 'project-cancel-button')), '(c) Reactivate makes the project active again');
    // Duplicate opens the copy; its Delete asks first, closes it, and core's toast offers Undo, which puts it back in Projects.
    const COPY = `${STARTER_TITLE} (Copy)`;
    nodes = await tapExpecting(tagged(nodes, 'project-duplicate-button'), (current) => projectTitled(current, COPY), 'the copy', 30_000);
    check(true, '(c) Duplicate opens the copy');
    nodes = await openActions();
    nodes = await tapExpecting(tagged(nodes, 'project-delete-button'), (current) => !sheetOpen(current) && Boolean(button(current, en['common.delete'])), 'the delete confirm');
    nodes = await tapExpecting(button(nodes, en['common.delete']), (current) => hasText(current, en['projects.deleted']), 'the deleted toast', 30_000);
    check(!projectTitled(nodes, COPY) && Boolean(button(nodes, en['common.undo'])), '(c) Delete closes the copy and core\'s toast offers Undo');
    // RN's toast stays 5.2 s and one UI dump here takes 1-2 s: Undo is tapped from the very dump that found the toast (a fresh
    // dump first, as tapExpecting takes, let it expire in phone runs 4 and 5).
    await tap(button(nodes, en['common.undo']) ?? fail('no Undo on the toast'));
    nodes = await waitFor('the copy back in Projects', (current) => hasText(current, COPY), 30_000);
    check(true, '(c) Undo puts the copy back');
    nodes = await tapExpecting(byText(nodes, STARTER_TITLE) ?? fail('no Getting Started row'),
        (current) => projectTitled(current, STARTER_TITLE) && Boolean(tagged(current, 'getting-started-actions')), 'Getting Started again');
    // The pinned row's view options "..." (RN's More options, b4a): Sort with its current choice, then Show completed. A sort
    // other than Default washes the "..."; Default again clears it.
    const viewOpen = (current) => Boolean(tagged(current, 'project-view-options-sheet'));
    const openView = async () => {
        await tapExpecting(tagged(await screen(), 'project-task-view-options-button') ?? fail('no view options "..."'), viewOpen, 'the view options');
        return waitFor('the Sort row', (current) => Boolean(tagged(current, 'project-view-sort-option')), 15_000);
    };
    nodes = await openView();
    const viewRows = ['project-view-sort-option', 'project-view-completed-option'].map((tag) => tagged(nodes, tag));
    check(viewRows.every(Boolean) && centerY(viewRows[0]) < centerY(viewRows[1]) && hasText(nodes, en['sort.default']),
        '(c) the view options list Sort (Default) then Show completed, as RN');
    shot('project-view-options');
    const pickSort = async (label) => {
        nodes = await openView();
        await tapExpecting(tagged(nodes, 'project-view-sort-option'), (current) => !viewOpen(current) && hasText(current, label), 'the sort choices');
        return tapExpecting(byText(await screen(), label) ?? fail(`no ${label} choice`), (current) => !hasText(current, en['sort.label']), 'the sort chosen');
    };
    await pickSort(en['sort.title']);
    // Compose reports a non-tab node's selected state as checked (isOn reads either), which TalkBack announces.
    nodes = await waitFor('the "..." washed', (current) => isOn(tagged(current, 'project-task-view-options-button')), 15_000);
    check(true, '(c) a Title sort washes the view options "..."');
    await pickSort(en['sort.default']);
    nodes = await waitFor('the "..." plain again', (current) => { const options = tagged(current, 'project-task-view-options-button'); return Boolean(options) && !isOn(options); }, 15_000);
    check(true, '(c) Default again clears it');
    // b4b: Filters is the view options' first row. Its sheet narrows the project to core's @computer tasks, the pinned row then shows
    // core's "Filters · 1" chip, and the sheet's Clear removes it.
    nodes = await openView();
    const filterRow = tagged(nodes, 'project-view-filter-option');
    check(Boolean(filterRow) && centerY(filterRow) < centerY(tagged(nodes, 'project-view-sort-option')), '(c) Filters comes first in the view options');
    // The shared FilterSheet's rows merge into one description each (as check-toolbars-device reads the Inbox's).
    const sheetUp = (current) => Boolean(withDescription(current, en['filters.label'])) && hasText(current, en['filters.label']);
    nodes = await tapExpecting(filterRow, sheetUp, 'the filter sheet');
    shot('project-filters');
    const pickerSearch = `${en['common.search']} ${en['filters.contexts']}`;
    nodes = await tapExpecting(withDescription(nodes, `${en['filters.contexts']}: ${en['common.all']}`) ?? fail('no Contexts & tags row'),
        (current) => Boolean(withDescription(current, pickerSearch)) && Boolean(withDescription(current, '@computer')), 'the contexts page');
    await tapExpecting(withDescription(nodes, '@computer'), (current) => isOn(withDescription(current, '@computer'))
        || current.some((node) => node.text === en['bulk.selected']), '@computer chosen');
    nodes = await tapExpecting(button(await screen(), en['common.back']) ?? fail('no Back on the contexts page'),
        (current) => Boolean(withDescription(current, `${en['filters.contexts']}: @computer`)), 'the sheet overview');
    nodes = await tapExpecting(button(nodes, en['common.done']) ?? fail('no Done'), (current) => Boolean(tagged(current, 'project-task-filter-button')), 'the filter chip');
    check(tagged(nodes, 'project-task-filter-button')?.['content-desc'] === `${en['filters.label']} · 1`, '(c) the pinned row shows core\'s "Filters · 1"');
    nodes = await tapExpecting(tagged(nodes, 'project-task-filter-button'), sheetUp, 'the filter sheet again');
    nodes = await tapExpecting(button(nodes, en['filters.clear']) ?? fail('no Clear'), (current) => !button(current, en['filters.clear']), 'the filters cleared');
    nodes = await tapExpecting(button(nodes, en['common.done']) ?? fail('no Done'), (current) => !sheetUp(current) && !tagged(current, 'project-task-filter-button'), 'the chip gone');
    check(true, '(c) Clear removes the filter and its chip');
    // The pinned "+" (RN's openProjectQuickAdd): the popup opens with Getting Started chosen, and the task saves as Next in it.
    nodes = await tapExpecting(tagged(nodes, 'project-add-task-button') ?? fail('no project "+"'),
        (current) => Boolean(tagged(current, 'quick-capture')) && hasText(current, STARTER_TITLE), 'the capture popup with Getting Started chosen', 15_000);
    check(true, '(c) the project\'s "+" opens the capture popup with the project chosen');
    shot('project-add');
    const ADDED = 'Paint the fence';
    const input = nodes.find((node) => node.class === 'android.widget.EditText' && (node['resource-id'] ?? '').endsWith('capture-title'))
        ?? nodes.filter((node) => node.class === 'android.widget.EditText').pop() ?? fail('no capture field');
    await tap(input);
    requireAppFront();
    sh(`input text '${ADDED.replaceAll(' ', '%s')}'`);
    nodes = await waitFor('the typed capture', (current) => current.some((node) => node.class === 'android.widget.EditText' && node.text === ADDED), 10_000);
    nodes = await tapExpecting(button(nodes, en['common.save']) ?? fail('no Save'), (current) => !tagged(current, 'quick-capture') && hasText(current, ADDED), 'the task in the project', 30_000);
    check(projectTitled(nodes, STARTER_TITLE) && nodes.some((node) => node['content-desc'] === `${ADDED}. Status: Next`),
        '(c) the captured task shows in Getting Started, as Next');
    // The list scrolled to the new task (RN's highlight, #916): back to the top for Getting Started's actions.
    nodes = await device.toTop();
    nodes = await tapExpecting(byText(nodes, en['starter.processInbox.check1']) ?? fail('no Open Inbox'), (current) => tabSelected(current, en['tab.inbox']), 'the Inbox');
    check(tabSelected(nodes, en['tab.inbox']), '(c) Open Inbox closes the project and shows the Inbox');

    // (d) The editor's Scheduling help: closed, then open with core's hint.
    const row = nodes.find((node) => node.text === en['starter.sampleBuyMilk']) ?? nodes.find((node) => (node['resource-id'] ?? '').endsWith('task-row'));
    nodes = await tapExpecting(row ?? fail('no sample Inbox item'), (current) => current.some((node) => /(^|\/)task-editor$/.test(node['resource-id'] ?? '')), 'the editor');
    // RN's Focus star sits in the Title row (15c42df63), not in the top bar.
    check(Boolean(tagged(nodes, 'task-edit-focus-star')), '(d) the editor shows the Focus star in the Title row');
    shot('editor');
    const helpLabel = `${en['onboarding.help']}: ${en['taskEdit.scheduling']}`;
    // Scroll until the Scheduling heading sits clear of the bottom edge (the gesture bar takes taps there).
    const clear = (current) => { const heading = withDescription(current, en['taskEdit.scheduling']); return heading && centerY(heading) < 1700; };
    for (let step = 0; step < 8 && !clear(nodes); step += 1) {
        sh('input swipe 540 1700 540 1100 400');
        await sleep(700);
        nodes = await screen();
    }
    const scheduling = withDescription(nodes, en['taskEdit.scheduling']) ?? fail('no Scheduling section');
    if (!withDescription(nodes, helpLabel)) nodes = await tapExpecting(scheduling, (current) => Boolean(withDescription(current, helpLabel)), 'Scheduling open');
    const help = withDescription(nodes, helpLabel) ?? fail('no Scheduling help');
    check(!byText(nodes, en['onboarding.schedulingHint']), '(d) the Scheduling help starts closed');
    nodes = await tapExpecting(help, (current) => Boolean(byText(current, en['onboarding.schedulingHint'])), 'the help open');
    check(Boolean(byText(nodes, en['onboarding.readGuide'])), '(d) the open help shows core\'s hint and Read the guide');
    shot('editor-help');

    // (e) The debug preview of each window; its close dismisses it.
    for (const id of ['announcement', 'update-reminder', 'donation']) {
        setProp('startup_prompt', id);
        nodes = await start(promptWindow, `the ${id} window`);
        shot(`prompt-${id}`);
        nodes = await tapExpecting(withDescription(nodes, en['announcement.dismiss']) ?? fail(`no close on the ${id} window`), (current) => !promptWindow(current), `the ${id} window closed`);
        check(!promptWindow(nodes), `(e) the ${id} window opens in a preview and its close dismisses it`);
    }
    setProp('startup_prompt', '');
    console.log(`screenshots: ${shots}`);
    console.log('Onboarding device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
