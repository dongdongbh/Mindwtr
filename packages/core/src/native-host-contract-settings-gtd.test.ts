import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildGtdSettingsModel, type GtdSettingsEdit, type GtdSettingsOption, type GtdSettingsToggle } from './gtd-settings-model';
import { getTranslator } from './i18n';
import { loadTranslations } from './i18n/i18n-loader';
import { createNativeHostContract, type NativeHostResult } from './native-host-contract';
import { replayAfterRestart } from './screen-parity.replay';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { noopStorage } from './storage';
import { DEFAULT_TASK_EDITOR_ORDER } from './task-editor-layout';
import type { AppSettings, Area } from './types';
import { generateUUID } from './uuid';

/**
 * The frozen React Native GTD settings screens (gtd-settings-parity.fixtures.json,
 * captured by apps/mobile/components/settings/gtd-settings-screen.parity.test.tsx),
 * replayed through the native host contract. The replay plays the native screen:
 * it keeps the screen's own state (text drafts, open groups, the field sheet, the
 * area picker), reads the view, sends each control's edit, stores what the
 * contract says to store on the device, and lays the view out in the order React
 * Native draws it.
 */
type Screen = 'gtd' | 'gtd-archive' | 'gtd-capture' | 'gtd-inbox' | 'gtd-pomodoro' | 'gtd-review' | 'gtd-task-editor';
type Device = { language?: string; storage?: Record<string, string>; exactAlarm?: { relevant: boolean; allowed: boolean } };
type Scenario = { name: string; screen: Screen; settings: string; device: Device; actions: [string, ...unknown[]][] };
type Fixture = {
    now: string;
    timeZone: string;
    areas: Area[];
    settings: Record<string, AppSettings>;
    scenarios: Scenario[];
    observations: Record<string, Record<string, unknown>[]>;
};
type Host = ReturnType<typeof createNativeHostContract>;

const fixture: Fixture = JSON.parse(readFileSync(new URL('./gtd-settings-parity.fixtures.json', import.meta.url), 'utf8'));
const OPEN_MODE_KEY = 'mindwtr:view:taskOpenMode:v1';

const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const normalize = (entry: unknown): unknown => JSON.parse(JSON.stringify(entry, (_key, item) => (item === undefined ? '<undefined>' : item)));

// ---------------------------------------------------------------------------
// The store: the fixture's data, with settings writes recorded as the harness records them.

const writes: unknown[][] = [];
let realUpdateSettings: ((...args: unknown[]) => Promise<unknown>) | null = null;

async function seed(settings: string | AppSettings, saveData?: (data: unknown) => Promise<void>) {
    await flushPendingSave();
    resetForTests();
    realUpdateSettings ??= useTaskStore.getState().updateSettings as never;
    const real = realUpdateSettings!;
    const stored = typeof settings === 'string' ? fixture.settings[settings] : settings;
    let data = JSON.parse(JSON.stringify({ tasks: [], projects: [], sections: [], areas: fixture.areas, people: [], settings: stored }));
    setStorageAdapter({
        getData: async () => data,
        saveData: async (next) => {
            await saveData?.(next);
            data = JSON.parse(JSON.stringify(next));
        },
    });
    useTaskStore.setState({
        updateSettings: real,
        _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
    } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    useTaskStore.setState({
        updateSettings: async (...args: unknown[]) => {
            writes.push(['updateSettings', ...(normalize(args) as unknown[])]);
            return real(...args);
        },
    } as never);
    writes.length = 0;
}

async function openHost(language = 'en'): Promise<Host> {
    const host = createNativeHostContract();
    value(await host.setLanguage({ storedLanguage: language, systemLocale: 'en-US' }));
    expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
    return host;
}

// ---------------------------------------------------------------------------
// The native screen.

type Control = { label: string; selected: boolean; disabled: boolean; press: () => Promise<void> };
type Switch = { label: string; value: boolean; flip: () => Promise<void> };
type Input = { label: string | null; placeholder: string | null; value: string; type: (text: string) => void; blur: () => Promise<void> };
type Drawn = { texts: string[]; controls: Control[]; switches: Switch[]; inputs: Input[]; automationCapture: boolean };

const described = (link: { title: string; description: string | null }) => [link.title, ...(link.description ? [link.description] : [])];

function gtdDriver(host: Host, scenario: Scenario) {
    const device = scenario.device;
    const storage = new Map(Object.entries(device.storage ?? {}));
    const alarmDenied = device.exactAlarm?.relevant === true && device.exactAlarm.allowed === false;
    const log = { device: [] as unknown[][], toasts: [] as unknown[][], navigations: [] as unknown[], writes: 0 };
    const read = () => value(host.getGtdSettings({ taskOpenMode: storage.get(OPEN_MODE_KEY) ?? null }));

    let view = read();
    // Screen state.
    let scheduleDraft = view.hub.defaultScheduleTime.value;
    let minutes = { ...view.pomodoro.minutes };
    let noticeShown = false;
    let areaPicker = false;
    let selectedField: string | null = null;
    let expandedKey = view.taskEditor.expandedResetKey;
    let expanded: Record<string, boolean> = { ...view.taskEditor.initiallyExpanded };

    /** Sends an edit and stores what the contract says to store on the device. */
    const send = async (edit: GtdSettingsEdit) => {
        const result = await host.setGtdSetting({ requestId: generateUUID(), edit });
        if (!result.ok) return result;
        for (const write of result.value.deviceWrites) {
            expect(write.key).toBe(OPEN_MODE_KEY);
            log.device.push(['setItem', write.key, write.value]);
            storage.set(write.key, write.value!);
        }
        return result;
    };
    /** Re-reads the view and applies React Native's effects on the screen state. */
    const refresh = () => {
        const before = view;
        view = read();
        if (view.hub.defaultScheduleTime.value !== before.hub.defaultScheduleTime.value) scheduleDraft = view.hub.defaultScheduleTime.value;
        if (view.pomodoro.minutes.focus !== before.pomodoro.minutes.focus || view.pomodoro.minutes.break !== before.pomodoro.minutes.break) {
            minutes = { ...view.pomodoro.minutes };
        }
        if (view.taskEditor.expandedResetKey !== expandedKey) {
            expandedKey = view.taskEditor.expandedResetKey;
            expanded = { ...view.taskEditor.initiallyExpanded };
            selectedField = null;
        }
    };
    const control = (label: string, press: () => Promise<void> | void, selected = false, disabled = false): Control => ({
        label, selected, disabled, press: async () => { await press(); },
    });
    const toggleSwitch = (toggle: GtdSettingsToggle, after?: (changed: boolean) => void): Switch => ({
        label: toggle.label,
        value: toggle.value,
        flip: async () => {
            const result = value(await send(toggle.edit));
            after?.(result.changed);
        },
    });
    const optionControls = <T,>(options: GtdSettingsOption<T>[], after?: () => void) => options.map((option) => control(option.label, async () => {
        value(await send(option.edit));
        after?.();
    }, option.selected));
    const link = (entry: { title: string; description: string | null; screen: string }) => control(described(entry).join('|'), () => {
        log.navigations.push(entry.screen);
    });
    const toggleTexts = (toggle: GtdSettingsToggle) => [toggle.label, ...(toggle.description !== null ? [toggle.description] : [])];

    const drawScreen = (): Drawn => {
        const drawn: Drawn = { texts: [], controls: [], switches: [], inputs: [], automationCapture: false };
        const { hub, pomodoro, capture, review, inbox, archive, taskEditor } = view;
        switch (scenario.screen) {
            case 'gtd': {
                drawn.texts.push(hub.title, hub.description, hub.features.label, hub.features.description, ...toggleTexts(hub.pomodoro));
                if (hub.pomodoroSettings) drawn.texts.push(...described(hub.pomodoroSettings));
                drawn.texts.push(
                    hub.defaultScheduleTime.label, hub.defaultScheduleTime.description,
                    hub.focusTaskLimit.label, hub.focusTaskLimit.description, ...hub.focusTaskLimit.options.map((option) => option.label),
                    ...toggleTexts(hub.focusIncludeStartDates),
                    hub.defaultProjectFlowMode.label, hub.defaultProjectFlowMode.description, ...hub.defaultProjectFlowMode.options.map((option) => option.label),
                    ...[hub.autoArchive, hub.taskEditor, hub.capture, hub.review, hub.inbox].flatMap(described),
                );
                if (hub.pomodoroSettings) drawn.controls.push(link(hub.pomodoroSettings));
                drawn.controls.push(
                    ...optionControls(hub.focusTaskLimit.options),
                    ...optionControls(hub.defaultProjectFlowMode.options),
                    ...[hub.autoArchive, hub.taskEditor, hub.capture, hub.review, hub.inbox].map(link),
                );
                drawn.switches.push(toggleSwitch(hub.pomodoro), toggleSwitch(hub.focusIncludeStartDates));
                drawn.inputs.push({
                    label: null,
                    placeholder: hub.defaultScheduleTime.placeholder,
                    value: scheduleDraft,
                    type: (text) => { scheduleDraft = text; },
                    blur: async () => {
                        const result = await send({ type: 'defaultScheduleTime', value: scheduleDraft });
                        if (!result.ok) {
                            expect(result.error.code).toBe('INVALID_INPUT');
                            log.toasts.push([hub.defaultScheduleTime.invalidMessage, 'warning', null]);
                        }
                        refresh();
                        scheduleDraft = view.hub.defaultScheduleTime.value;
                    },
                });
                return drawn;
            }
            case 'gtd-pomodoro': {
                drawn.texts.push(pomodoro.title, pomodoro.description);
                const controls = pomodoro.controls;
                if (pomodoro.enable || !controls) {
                    const enable = pomodoro.enable!;
                    drawn.texts.push(enable.label);
                    // The button's text is tinted.
                    drawn.controls.push(control(enable.label, async () => { value(await send(enable.edit)); }, true));
                    return drawn;
                }
                const notice = alarmDenied ? controls.alarmNotice : null;
                drawn.texts.push(
                    controls.customPreset.label, controls.customPreset.description, controls.customPreset.focusLabel, controls.customPreset.breakLabel,
                    ...[controls.linkTask, controls.autoStartBreaks, controls.autoStartFocus, controls.completionAlert].flatMap(toggleTexts),
                    ...(notice ? [notice.label, notice.description, notice.actionLabel] : []),
                );
                if (notice) drawn.controls.push(control(notice.actionLabel, () => undefined, true));
                // Turning an auto-start on shows the notice once per visit, after the write.
                const autoStart = (toggle: GtdSettingsToggle) => toggleSwitch(toggle, (changed) => {
                    if (changed && !toggle.value && !noticeShown) {
                        noticeShown = true;
                        log.toasts.push([pomodoro.autoStartNotice, 'info', 5000]);
                    }
                });
                drawn.switches.push(toggleSwitch(controls.linkTask), autoStart(controls.autoStartBreaks), autoStart(controls.autoStartFocus), toggleSwitch(controls.completionAlert));
                const commit = async () => {
                    value(await send({ type: 'pomodoroDurations', focusMinutes: minutes.focus, breakMinutes: minutes.break }));
                    refresh();
                    minutes = { ...view.pomodoro.minutes };
                };
                drawn.inputs.push(
                    { label: controls.customPreset.focusLabel, placeholder: null, value: minutes.focus, type: (text) => { minutes.focus = text; }, blur: commit },
                    { label: controls.customPreset.breakLabel, placeholder: null, value: minutes.break, type: (text) => { minutes.break = text; }, blur: commit },
                );
                return drawn;
            }
            case 'gtd-capture': {
                drawn.texts.push(
                    capture.title, capture.description, capture.method.label, capture.method.description, ...capture.method.options.map((option) => option.label),
                    capture.defaultArea.label, capture.defaultArea.description, capture.defaultArea.value,
                );
                const toggles = [capture.saveAudio, capture.quickAddAutoClean, capture.naturalLanguageDates, capture.markdownEditorAssist]
                    .filter((toggle): toggle is GtdSettingsToggle => toggle !== null);
                drawn.texts.push(...toggles.flatMap(toggleTexts));
                drawn.controls.push(
                    ...optionControls(capture.method.options),
                    control(capture.defaultArea.accessibilityLabel, () => { areaPicker = true; }),
                );
                drawn.switches.push(...toggles.map((toggle) => toggleSwitch(toggle)));
                drawn.automationCapture = true;
                return drawn;
            }
            case 'gtd-review':
                drawn.texts.push(review.title, review.description, review.daily.label, review.daily.description, ...toggleTexts(review.dailyFocusStep),
                    review.weekly.label, review.weekly.description, ...toggleTexts(review.weeklyContextStep));
                drawn.switches.push(toggleSwitch(review.dailyFocusStep), toggleSwitch(review.weeklyContextStep));
                return drawn;
            case 'gtd-inbox': {
                const toggles = [inbox.twoMinute, inbox.projectFirst, inbox.contextStep, inbox.schedule];
                drawn.texts.push(inbox.title, inbox.description, ...toggles.flatMap(toggleTexts));
                drawn.switches.push(...toggles.map((toggle) => toggleSwitch(toggle)));
                return drawn;
            }
            case 'gtd-archive':
                drawn.texts.push(archive.title, archive.description, ...archive.options.map((option) => option.label));
                drawn.controls.push(...optionControls(archive.options));
                return drawn;
            case 'gtd-task-editor': {
                drawn.texts.push(
                    taskEditor.title, taskEditor.description, taskEditor.helper,
                    taskEditor.openMode.label, taskEditor.openMode.description, ...taskEditor.openMode.options.map((option) => option.label),
                    taskEditor.presets.label, ...taskEditor.presets.options.map((option) => option.label),
                    ...(taskEditor.presets.custom !== null ? [taskEditor.presets.custom] : []),
                );
                drawn.controls.push(...optionControls(taskEditor.openMode.options), ...optionControls(taskEditor.presets.options));
                for (const group of taskEditor.groups) {
                    drawn.texts.push(group.title, String(group.count));
                    drawn.controls.push(control(`${group.title}|${group.count}`, () => { expanded[group.id] = !expanded[group.id]; }));
                    if (!expanded[group.id]) continue;
                    if (group.defaultOpen) {
                        drawn.texts.push(...toggleTexts(group.defaultOpen));
                        drawn.switches.push(toggleSwitch(group.defaultOpen));
                    }
                    for (const field of group.fields) {
                        drawn.texts.push(field.label, field.status);
                        drawn.controls.push(
                            control(field.visibility.accessibilityLabel, async () => { value(await send(field.visibility.edit)); }, field.visible),
                            control(`${field.label}|${field.status}`, () => { selectedField = field.id; }),
                        );
                    }
                }
                drawn.texts.push(taskEditor.reset.label);
                drawn.controls.push(control(taskEditor.reset.label, async () => { value(await send(taskEditor.reset.edit)); }));
                return drawn;
            }
        }
    };

    const drawModal = (): Omit<Drawn, 'inputs' | 'automationCapture'> | null => {
        if (scenario.screen === 'gtd-capture' && areaPicker) {
            const picker = view.capture.defaultArea;
            return {
                texts: [picker.pickerTitle, ...picker.options.map((option) => option.label)],
                controls: optionControls(picker.options, () => { areaPicker = false; }),
                switches: [],
            };
        }
        if (scenario.screen !== 'gtd-task-editor' || selectedField === null) return null;
        const field = view.taskEditor.groups.flatMap((group) => group.fields).find((entry) => entry.id === selectedField)!;
        const { sheet } = field;
        const move = (entry: typeof sheet.order.moveUp) => control(entry.label, async () => { if (entry.edit) value(await send(entry.edit)); }, false, entry.disabled);
        return {
            texts: [
                sheet.title, ...(sheet.section !== null ? [sheet.section] : []), sheet.visible.label,
                ...(sheet.sections ? [sheet.sections.label, ...sheet.sections.options.map((option) => option.label)] : []),
                sheet.order.label, sheet.order.moveUp.label, sheet.order.moveDown.label, sheet.doneLabel,
            ],
            controls: [
                // A chip's text is tinted while it is the field's section.
                ...(sheet.sections ? optionControls(sheet.sections.options) : []),
                move(sheet.order.moveUp),
                move(sheet.order.moveDown),
                control(sheet.doneLabel, () => { selectedField = null; }),
            ],
            switches: [toggleSwitch(sheet.visible)],
        };
    };

    const drain = () => {
        const out = { writes: writes.slice(log.writes), device: log.device, toasts: log.toasts, navigations: log.navigations };
        log.writes = writes.length;
        log.device = [];
        log.toasts = [];
        log.navigations = [];
        return out;
    };

    const strings = (keys: string[]) => value(host.getStrings({ keys })).strings;
    const labelText = (label: string) => (label.startsWith('k:') ? strings([label.slice(2)])[label.slice(2)] : label);
    const matches = (entry: Control, label: string) => entry.label === label || entry.label.split('|')[0] === label || entry.label.startsWith(`${label}: `);

    return {
        observe() {
            const screen = drawScreen();
            const modal = drawModal();
            return normalize({
                texts: screen.texts,
                controls: screen.controls.map((entry) => [entry.label, entry.selected, entry.disabled]),
                switches: screen.switches.map((entry) => [entry.label, entry.value, false]),
                inputs: screen.inputs.map((entry) => [entry.label, entry.placeholder, entry.value]),
                automationCapture: screen.automationCapture,
                modal: modal ? {
                    texts: modal.texts,
                    controls: modal.controls.map((entry) => [entry.label, entry.selected, entry.disabled]),
                    switches: modal.switches.map((entry) => [entry.label, entry.value, false]),
                } : null,
                ...drain(),
            });
        },
        async perform([kind, target, extra]: [string, ...unknown[]]) {
            const screen = drawScreen();
            const modal = drawModal();
            const fieldControl = (prefix: 'eye' | 'row') => {
                const field = view.taskEditor.groups.flatMap((group) => group.fields).find((entry) => entry.id === target)!;
                const label = prefix === 'eye' ? field.visibility.accessibilityLabel : `${field.label}|${field.status}`;
                return screen.controls.find((entry) => entry.label === label)!;
            };
            switch (kind) {
                case 'press':
                case 'modalPress': {
                    const label = labelText(target as string);
                    const entry = (kind === 'press' ? screen.controls : modal!.controls).find((candidate) => matches(candidate, label));
                    if (!entry) throw new Error(`No control ${label}`);
                    if (!entry.disabled) await entry.press();
                    break;
                }
                case 'switch':
                    await screen.switches[target as number].flip();
                    break;
                case 'modalSwitch':
                    await modal!.switches[target as number].flip();
                    break;
                case 'type':
                    screen.inputs[target as number].type(extra as string);
                    break;
                case 'blur':
                    await screen.inputs[target as number].blur();
                    break;
                case 'dismiss':
                    areaPicker = false;
                    selectedField = null;
                    break;
                case 'eye':
                    await fieldControl('eye').press();
                    break;
                case 'field':
                    await fieldControl('row').press();
                    break;
                default:
                    throw new Error(`Unknown action ${kind}`);
            }
            await flushPendingSave();
            refresh();
        },
    };
}

describe('native host contract: Settings › GTD', () => {
    const originalTz = process.env.TZ;
    beforeAll(async () => {
        process.env.TZ = fixture.timeZone;
        await loadTranslations('en');
        await loadTranslations('de');
    });
    afterAll(() => {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });
    afterEach(async () => {
        vi.useRealTimers();
        await flushPendingSave();
        resetForTests();
        vi.restoreAllMocks();
    });
    const freezeClock = () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(fixture.now));
    };

    it.each(fixture.scenarios.map((scenario) => [scenario.name, scenario] as const))(
        'replays the frozen React Native scenario through the contract: %s',
        async (name, scenario) => {
            freezeClock();
            await seed(scenario.settings);
            const host = await openHost(scenario.device.language);
            const driver = gtdDriver(host, scenario);
            const observed = [driver.observe()];
            for (const action of scenario.actions) {
                await driver.perform(action);
                observed.push(driver.observe());
            }
            expect(observed).toEqual(fixture.observations[name]);
        },
    );

    it('names one day in the singular in Auto-archive', () => {
        const labels = (language: string) => buildGtdSettingsModel({ settings: {} as AppSettings, areas: [], taskOpenMode: 'automatic', t: getTranslator(language) })
            .archive.options.slice(1, 3).map((option) => option.label);
        expect(labels('en')).toEqual(['1 day', '3 days']);
        expect(labels('de')).toEqual(['1 Tag', '3 Tage']);
    });

    it('returns what core\'s GTD model returns when called directly, and opens GTD from the menu', async () => {
        freezeClock();
        await seed('stored');
        const host = await openHost('de');
        const view = value(host.getGtdSettings({ taskOpenMode: 'preview' }));
        const { version: _version, revision: _revision, ...model } = view;
        const state = useTaskStore.getState();
        expect(model).toEqual(buildGtdSettingsModel({ settings: state.settings, areas: state.areas, taskOpenMode: 'preview', t: getTranslator('de') }));
        expect(value(host.getGtdSettings({ taskOpenMode: 'sideways' })).taskEditor.openMode.options.find((option) => option.selected)?.value).toBe('automatic');
        const menu = value(host.getSettingsMenu());
        expect(menu.groups.flat().filter((row) => row.enabled).map((row) => row.id)).toEqual(['general', 'gtd', 'manage', 'sync', 'data', 'advanced', 'about']);
        // Settings › Advanced opens for its AI screen (pass C1); Calendar comes with its own pass.
        expect(menu.advanced.rows.filter((row) => row.enabled).map((row) => row.id)).toEqual(['ai']);
    });

    it('changes the revision with the settings and the language', async () => {
        freezeClock();
        await seed('base');
        const host = await openHost();
        const first = value(host.getGtdSettings()).revision;
        expect(value(host.getGtdSettings()).revision).toBe(first);
        value(await host.setGtdSetting({ requestId: generateUUID(), edit: { type: 'focusTaskLimit', value: 5 } }));
        const second = value(host.getGtdSettings()).revision;
        expect(second).not.toBe(first);
        value(await host.setLanguage({ storedLanguage: 'de', systemLocale: 'de-DE' }));
        expect(value(host.getGtdSettings()).revision).not.toBe(second);
    });

    it('writes only the keys a control changes and keeps every other stored key', async () => {
        freezeClock();
        const stored = {
            ...fixture.settings.stored,
            gtd: { ...fixture.settings.stored.gtd, futureOption: 'kept', inboxProcessing: { ...fixture.settings.stored.gtd!.inboxProcessing, futureStep: 1 } },
        } as AppSettings;
        await seed(stored);
        const host = await openHost();
        const before = useTaskStore.getState().settings;
        value(await host.setGtdSetting({ requestId: generateUUID(), edit: { type: 'inboxSchedule', value: false } }));
        const after = useTaskStore.getState().settings;
        expect(after.gtd).toEqual({ ...before.gtd, inboxProcessing: { ...before.gtd!.inboxProcessing, scheduleEnabled: false } });
        expect({ ...after, gtd: before.gtd, syncPreferencesUpdatedAt: before.syncPreferencesUpdatedAt }).toEqual(before);
        expect(writes).toHaveLength(1);
    });

    it('writes nothing again for a value already stored, even after a restart', async () => {
        freezeClock();
        await seed('customEditor');
        const edits: GtdSettingsEdit[] = [
            { type: 'pomodoro', value: true },
            { type: 'defaultScheduleTime', value: ' 7:05 ' },
            { type: 'focusTaskLimit', value: 10 },
            { type: 'defaultProjectFlowMode', value: 'sequential' },
            { type: 'autoArchiveDays', value: 30 },
            { type: 'pomodoroDurations', focusMinutes: '45', breakMinutes: 'x' },
            { type: 'pomodoroAutoStartFocus', value: true },
            { type: 'captureMethod', value: 'audio' },
            { type: 'defaultArea', value: 'a-home' },
            { type: 'quickAddAutoClean', value: true },
            { type: 'inboxProjectFirst', value: true },
            { type: 'weeklyReviewContextStep', value: false },
            { type: 'taskEditorFieldVisible', field: 'priority', value: true },
            { type: 'taskEditorFieldSection', field: 'tags', value: 'organization' },
            { type: 'taskEditorSectionOpen', section: 'details', value: false },
            { type: 'taskEditorOrder', value: ['project', ...DEFAULT_TASK_EDITOR_ORDER.filter((id) => id !== 'project')] },
        ];
        const run = async (host: Host) => {
            for (const edit of edits) value(await host.setGtdSetting({ requestId: generateUUID(), edit }));
        };
        await run(await openHost());
        await flushPendingSave();
        const written = writes.length;
        expect(written).toBe(edits.length);
        const settings = useTaskStore.getState().settings;
        // New request IDs on a new host: every write finds its value already stored.
        await run(await openHost());
        expect(writes).toHaveLength(written);
        expect(useTaskStore.getState().settings).toBe(settings);
        // A preset or a reset twice: the second writes nothing.
        const host = await openHost();
        for (const edit of [{ type: 'taskEditorPreset', value: 'full' }, { type: 'taskEditorReset' }] as GtdSettingsEdit[]) {
            expect(value(await host.setGtdSetting({ requestId: generateUUID(), edit })).changed).toBe(true);
            expect(value(await host.setGtdSetting({ requestId: generateUUID(), edit })).changed).toBe(false);
        }
    });

    it('a replay after a restart answers changed: false and keeps a later change to another GTD setting', async () => {
        freezeClock();
        await seed('base');
        const host = await openHost();
        const input = { requestId: generateUUID(), edit: { type: 'dailyReviewFocusStep' as const, value: false } };
        expect(value(await host.setGtdSetting(input)).changed).toBe(true);
        await useTaskStore.getState().updateSettings({ gtd: { ...useTaskStore.getState().settings.gtd, weeklyReview: { includeContextStep: false } } });
        const { result, wrote } = await replayAfterRestart((restarted) => restarted.setGtdSetting(input));
        expect(result).toEqual({ ok: true, value: { changed: false, deviceWrites: [] } });
        expect(wrote).toBe(false);
        expect(useTaskStore.getState().settings.gtd).toMatchObject({ dailyReview: { includeFocusStep: false }, weeklyReview: { includeContextStep: false } });
    });

    describe('exact retry after a failed save: one write, and the retry finishes the save', () => {
        it.each([
            ['feature switch', { type: 'pomodoro', value: true }, (saved: AppSettings) => expect(saved.features?.pomodoro).toBe(true)],
            ['top-level switch', { type: 'markdownEditorAssist', value: false }, (saved: AppSettings) => expect(saved.markdownEditorAssist).toBe(false)],
            ['gtd choice', { type: 'autoArchiveDays', value: 60 }, (saved: AppSettings) => expect(saved.gtd?.autoArchiveDays).toBe(60)],
            ['gtd group switch', { type: 'dailyReviewFocusStep', value: false }, (saved: AppSettings) => expect(saved.gtd?.dailyReview).toEqual({ includeFocusStep: false })],
            ['schedule time', { type: 'defaultScheduleTime', value: '1745' }, (saved: AppSettings) => expect(saved.gtd?.defaultScheduleTime).toBe('17:45')],
            ['pomodoro minutes', { type: 'pomodoroDurations', focusMinutes: '40', breakMinutes: '8' },
                (saved: AppSettings) => expect(saved.gtd?.pomodoro?.customDurations).toEqual({ focusMinutes: 40, breakMinutes: 8 })],
            ['default area', { type: 'defaultArea', value: 'a-errands' },
                (saved: AppSettings) => expect(saved.gtd).toMatchObject({ defaultAreaMode: 'fixed', defaultAreaId: 'a-errands' })],
            ['task editor preset', { type: 'taskEditorPreset', value: 'simple' },
                (saved: AppSettings) => expect(saved.gtd?.taskEditor?.order?.slice(0, 5)).toEqual(['status', 'project', 'area', 'contexts', 'dueDate'])],
            ['field visibility', { type: 'taskEditorFieldVisible', field: 'timeEstimate', value: true }, (saved: AppSettings) => {
                expect(saved.features?.timeEstimates).toBe(true);
                expect(saved.gtd?.taskEditor?.hidden).not.toContain('timeEstimate');
            }],
            ['field section', { type: 'taskEditorFieldSection', field: 'location', value: 'basic' },
                (saved: AppSettings) => expect(saved.gtd?.taskEditor?.sections).toEqual({ location: 'basic' })],
            ['section open', { type: 'taskEditorSectionOpen', section: 'organization', value: true },
                (saved: AppSettings) => expect(saved.gtd?.taskEditor?.sectionOpen).toEqual({ organization: true })],
            ['reset', { type: 'taskEditorReset' }, (saved: AppSettings) => expect(saved.gtd?.taskEditor).toMatchObject({ sections: {}, sectionOpen: {} })],
        ] as const)('setGtdSetting: %s', async (_name, edit, check) => {
            freezeClock();
            const saveData = vi.fn().mockResolvedValue(undefined);
            await seed('base', saveData);
            const host = await openHost();
            const requestId = generateUUID();
            const run = () => host.setGtdSetting({ requestId, edit: edit as GtdSettingsEdit });
            saveData.mockRejectedValue(new Error('disk unavailable'));
            expect(await run()).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED', message: 'disk unavailable' } });
            expect(writes).toHaveLength(1);
            saveData.mockResolvedValue(undefined);
            const retried = await run();
            expect(retried).toMatchObject({ ok: true, value: { changed: true, deviceWrites: [] } });
            expect(writes).toHaveLength(1);
            check((saveData.mock.lastCall?.[0] as { settings: AppSettings }).settings);
            // A lost reply repeats the request: no write, no save.
            const saves = saveData.mock.calls.length;
            expect(await run()).toEqual(retried);
            expect(saveData).toHaveBeenCalledTimes(saves);
        });

        // A device-only edit writes nothing to the store, so a failing disk cannot fail it.
        it('setGtdSetting: task open mode (device only)', async () => {
            freezeClock();
            const saveData = vi.fn().mockResolvedValue(undefined);
            await seed('base', saveData);
            const host = await openHost();
            saveData.mockClear();
            saveData.mockRejectedValue(new Error('disk unavailable'));
            const requestId = generateUUID();
            const answer = { ok: true, value: { changed: false, deviceWrites: [{ key: OPEN_MODE_KEY, value: 'edit' }] } };
            expect(await host.setGtdSetting({ requestId, edit: { type: 'taskOpenMode', value: 'edit' } })).toEqual(answer);
            expect(await host.setGtdSetting({ requestId, edit: { type: 'taskOpenMode', value: 'edit' } })).toEqual(answer);
            expect(writes).toEqual([]);
            expect(saveData).not.toHaveBeenCalled();
        });
    });

    it('refuses input the screens do not offer', async () => {
        freezeClock();
        await seed('base');
        const host = await openHost();
        const invalid = { ok: false, error: { code: 'INVALID_INPUT' } };
        const send = (edit: unknown) => host.setGtdSetting({ requestId: generateUUID(), edit: edit as GtdSettingsEdit });
        expect(host.getGtdSettings({ taskOpenMode: 3 as never })).toMatchObject(invalid);
        for (const edit of [
            { type: 'defaultScheduleTime', value: '25:00' },
            { type: 'defaultScheduleTime', value: 'noon' },
            { type: 'focusTaskLimit', value: 4 },
            { type: 'defaultProjectFlowMode', value: 'serial' },
            { type: 'autoArchiveDays', value: 10 },
            { type: 'captureMethod', value: 'video' },
            { type: 'defaultArea', value: 'a-gone' },
            { type: 'defaultArea', value: 'a-missing' },
            { type: 'taskOpenMode', value: 'sideways' },
            { type: 'taskEditorPreset', value: 'custom' },
            { type: 'taskEditorFieldVisible', field: 'textDirection', value: true },
            { type: 'taskEditorFieldSection', field: 'status', value: 'details' },
            { type: 'taskEditorFieldSection', field: 'tags', value: 'misc' },
            { type: 'taskEditorSectionOpen', section: 'basic', value: false },
            { type: 'taskEditorOrder', value: ['status', 'project'] },
            { type: 'taskEditorOrder', value: [...Array(18).fill('status')] },
            { type: 'pomodoroDurations', focusMinutes: 25, breakMinutes: '5' },
            { type: 'inboxSchedule', value: 'yes' },
            { type: 'inboxSchedule', value: true, extra: 1 },
            { type: 'taskEditorReset', value: true },
            { type: 'theme', value: 'dark' },
        ]) {
            expect(await send(edit)).toMatchObject(invalid);
        }
        expect(await host.setGtdSetting({ requestId: 'not-a-uuid', edit: { type: 'inboxSchedule', value: true } })).toMatchObject(invalid);
        expect(writes).toEqual([]);
    });

    it('is NOT_READY until storage is activated', async () => {
        setStorageAdapter(noopStorage);
        const host = createNativeHostContract();
        const notReady = { ok: false, error: { code: 'NOT_READY' } };
        expect(host.getGtdSettings()).toMatchObject(notReady);
        expect(await host.setGtdSetting({ requestId: generateUUID(), edit: { type: 'inboxSchedule', value: true } })).toMatchObject(notReady);
    });
});
