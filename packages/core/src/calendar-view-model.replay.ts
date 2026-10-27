/**
 * Test support only (imported by the calendar tests; not exported). Replays the
 * frozen React Native Calendar scenarios (calendar-views-parity.fixtures.json,
 * captured by apps/mobile/components/views/calendar-view.parity.test.tsx)
 * through the native host contract. The replay plays the native screen: it keeps
 * the screen's own state (the view state, the search text, the open composer,
 * the external calendar it fetched), reads views, sends actions, and lays the
 * view's text out in the order the React Native screen draws it.
 */
import { readFileSync } from 'node:fs';
import type { createNativeHostContract, NativeHostResult } from './native-host-contract';
import type {
    NativeCalendarComposerView,
    NativeCalendarEntry,
    NativeCalendarFeed,
    NativeCalendarItem,
    NativeCalendarState,
    NativeCalendarView,
} from './native-host-contract-calendar';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppSettings, Area, ExternalCalendarEvent, ExternalCalendarSubscription, Project, Task } from './index';

type Contract = ReturnType<typeof createNativeHostContract>;
type Observation = Record<string, unknown>;
type FeedAnswer = 'ready' | 'loading' | 'error' | 'none';

export type CalendarScenario = {
    name: string;
    settings: string;
    taskIds?: string[];
    calendar?: FeedAnswer[];
    actions: [string, ...unknown[]][];
};

export type CalendarViewsFixture = {
    provenance: Record<string, unknown>;
    timeZone: string;
    now: string;
    deviceLocale: string;
    calendarError: string;
    tasks: Task[];
    projects: Project[];
    areas: Area[];
    calendars: ExternalCalendarSubscription[];
    calendarEvents: ExternalCalendarEvent[];
    settings: Record<string, AppSettings>;
    scenarios: CalendarScenario[];
    observations: Record<string, Observation[]>;
};

export const loadCalendarViewsFixture = (): CalendarViewsFixture => JSON.parse(
    readFileSync(new URL('./calendar-views-parity.fixtures.json', import.meta.url), 'utf8'),
);

/** The store writes a scenario asks for, as the mobile harness records them. */
export function createCalendarRecorder() {
    const log: unknown[][] = [];
    const createdIds = new Map<string, string>();
    const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
        entry === undefined ? '<undefined>' : entry
    )).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (match) => createdIds.get(match) ?? match));
    return { log, createdIds, normalize };
}
export type CalendarRecorder = ReturnType<typeof createCalendarRecorder>;

const RECORDED = ['updateTask', 'deleteTask', 'addTask', 'addProject', 'updateSettings'] as const;
type Recorded = (typeof RECORDED)[number];
let realActions: Pick<ReturnType<typeof useTaskStore.getState>, Recorded> | null = null;

export const scenarioTasks = (fixture: CalendarViewsFixture, scenario: CalendarScenario): Task[] => (
    scenario.taskIds
        ? fixture.tasks.filter((task) => scenario.taskIds!.includes(task.id))
        : fixture.tasks.filter((task) => task.id !== 't-booked')
);

/** Loads a scenario's data through the store and records the writes, as the harness does. */
export async function seedCalendarStore(
    fixture: CalendarViewsFixture,
    scenario: CalendarScenario,
    recorder: CalendarRecorder,
    adapter: { saveData?: (data: unknown) => Promise<void> } = {},
): Promise<void> {
    await flushPendingSave();
    resetForTests();
    const initial = useTaskStore.getState();
    realActions ??= Object.fromEntries(RECORDED.map((name) => [name, initial[name]])) as unknown as NonNullable<typeof realActions>;
    const real = realActions!;
    let data = JSON.parse(JSON.stringify({
        tasks: scenarioTasks(fixture, scenario), projects: fixture.projects, sections: [], areas: fixture.areas, people: [],
        settings: fixture.settings[scenario.settings],
    }));
    setStorageAdapter({
        getData: async () => data,
        saveData: async (next) => {
            await adapter.saveData?.(next);
            data = JSON.parse(JSON.stringify(next));
        },
    });
    useTaskStore.setState({
        ...real,
        _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
    });
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    const record = (name: string, args: unknown[]) => { recorder.log.push([name, ...(recorder.normalize(args) as unknown[])]); };
    useTaskStore.setState({
        updateTask: async (id, updates) => { record('updateTask', [id, updates]); return real.updateTask(id, updates); },
        deleteTask: async (id) => { record('deleteTask', [id]); return real.deleteTask(id); },
        addTask: async (title, props, options) => {
            record('addTask', [title, props]);
            const result = await real.addTask(title, props, options);
            if (result.id) recorder.createdIds.set(result.id, `<created:${title}>`);
            return result;
        },
        addProject: async (title, color, props) => {
            // The contract names a composer's new project from the request (an `id` prop); React Native
            // lets the store draw one, so the log leaves that id out, as the harness records the call.
            const { id: _id, ...rest } = props ?? {};
            const shown = props && 'id' in props ? (Object.keys(rest).length > 0 ? rest : undefined) : props;
            record('addProject', [title, color, shown]);
            const result = await real.addProject(title, color, props);
            if (result?.id) recorder.createdIds.set(result.id, `<created:${title}>`);
            return result;
        },
        updateSettings: async (updates) => { record('updateSettings', [updates]); return real.updateSettings(updates); },
    });
}

const ok = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};

let requestCount = 0;
const requestId = () => {
    requestCount += 1;
    return `00000000-0000-4000-8000-${requestCount.toString(16).padStart(12, '0')}`;
};

/**
 * What the comparison reads. Colors and positions are the host's to draw from
 * the view's tones and minutes, so the drawn-style hash stays out. The screen
 * saves its view mode on every switch, even to the mode it shows, while the
 * contract writes a setting only when it changes, so settings are compared as
 * the calendar settings they leave after each step.
 */
export function projectCalendarObservations(observations: Observation[], initialCalendar: unknown): Observation[] {
    let calendar = initialCalendar ?? null;
    return observations.map(({ styles: _styles, writes, ...rest }) => {
        const kept: unknown[] = [];
        for (const write of writes as unknown[][]) {
            if (write[0] === 'updateSettings') calendar = (write[1] as { calendar?: unknown }).calendar ?? calendar;
            else kept.push(write);
        }
        return { ...rest, writes: kept, calendar };
    });
}

// ---------------------------------------------------------------------------
// The native screen.

/** A pressable control: its label, the text inside it in order, and what pressing does. */
type Press = { label?: string; texts: string[]; disabled?: boolean; press: () => Promise<void> };
type Drawn = { texts: string[]; presses: Press[]; inputs: [string | null, string | null, string | null][]; blocks: { title: string; item: NativeCalendarItem }[] };

// The mobile harness's screen: 390pt wide, a 56pt week gutter, 1.4pt per minute.
const SCREEN_WIDTH = 390;
const WEEK_GUTTER = 56;
const PIXELS_PER_MINUTE = 1.4;
const weekColumnsCompact = (visibleDays: number) => Math.max(40, Math.max(1, SCREEN_WIDTH - WEEK_GUTTER) / visibleDays) < 86;

export async function replayCalendarScenario(options: {
    fixture: CalendarViewsFixture;
    scenario: CalendarScenario;
    recorder: CalendarRecorder;
    contract: Contract;
}): Promise<Observation[]> {
    const { fixture, scenario, recorder, contract } = options;
    const plan = [...(scenario.calendar ?? ['ready'])];
    let state: NativeCalendarState | undefined;
    let query = '';
    let composer: NativeCalendarComposerView | null = null;
    let editor: string | null = null;
    let allDayExpanded = false;
    let feed: NativeCalendarFeed | undefined;
    let fetchedRange = '';
    let calendars: ExternalCalendarSubscription[] = [];
    let events: ExternalCalendarEvent[] = [];
    const alerts: { title: string; message: string | null; buttons: { label: string; style: string | null; press?: () => Promise<void> }[] }[] = [];
    const toasts: unknown[][] = [];
    const fetches: [string, string][] = [];
    const opened: string[] = [];
    const seen = { writes: 0, toasts: 0, alerts: 0, fetches: 0, opened: 0 };

    const readAll = (): { view: NativeCalendarView; entries: NativeCalendarEntry[] } => {
        const first = ok(contract.getCalendarView({ state, scheduleQuery: query, calendar: feed, offset: 0, limit: 7 }));
        const entries = [...first.items];
        while (entries.length < first.total) {
            entries.push(...ok(contract.getCalendarView({ state, scheduleQuery: query, calendar: feed, offset: entries.length, limit: 7, revision: first.revision })).items);
        }
        return { view: first, entries };
    };
    /** The view, after fetching its range when it moved, as the screen's effect does. */
    const read = () => {
        let current = readAll();
        state = current.view.state;
        const range = `${current.view.range.start}|${current.view.range.end}`;
        if (range !== fetchedRange) {
            fetchedRange = range;
            fetches.push([current.view.range.start, current.view.range.end]);
            const answer = plan.length > 1 ? plan.shift()! : plan[0];
            if (answer === 'ready') {
                calendars = fixture.calendars;
                events = fixture.calendarEvents;
                feed = { status: 'ready', calendars, events };
            } else if (answer === 'none') {
                calendars = [];
                events = [];
                feed = { status: 'ready', calendars, events };
            } else if (answer === 'loading') {
                events = [];
                feed = { status: 'loading', calendars, events };
            } else {
                events = [];
                feed = { status: 'error', message: fixture.calendarError, calendars };
            }
            current = readAll();
        }
        return current;
    };
    const run = async (action: unknown) => ok(await contract.runCalendarAction({ requestId: requestId(), action: action as never, state, calendar: feed }));
    const setViewMode = async (viewMode: string) => { await run({ type: 'setViewMode', viewMode }); };
    const edit = (change: unknown) => { composer = ok(contract.editCalendarComposer({ composer: composer!.composer, edit: change as never, calendar: feed })); };
    const openComposer = (input: Record<string, unknown>) => {
        const opened = ok(contract.openCalendarComposer({ ...input, calendar: feed }));
        if (opened.toast) toasts.push([opened.toast.tone, opened.toast.title, opened.toast.message, opened.toast.durationMs]);
        composer = opened.composer;
    };
    const sheetButtons = <Id extends string>(buttons: { id: Id; label: string; style: string }[], press: Partial<Record<Id, () => Promise<void>>>) => (
        buttons.map((button) => ({ label: button.label, style: button.style === 'default' ? null : button.style, press: press[button.id] }))
    );
    const openTask = (item: NativeCalendarItem) => {
        const answer = contract.getCalendarItemSheet({ taskId: item.taskId!, state, calendar: feed });
        // Mobile's press on a completed item finds no open task and does nothing.
        if (!answer.ok && answer.error.code === 'TASK_NOT_FOUND') return;
        const sheet = ok(answer);
        if (sheet.kind === 'projected') {
            alerts.push({ title: sheet.title, message: sheet.message, buttons: sheetButtons(sheet.buttons, {}) });
            return;
        }
        if (sheet.kind !== 'task') return;
        const { taskId, taskRevision } = sheet;
        alerts.push({
            title: sheet.title,
            message: null,
            buttons: sheetButtons(sheet.buttons, {
                edit: async () => { editor = taskId; },
                unschedule: async () => { await run({ type: 'unscheduleTask', taskId, taskRevision }); },
                done: async () => { await run({ type: 'completeTask', taskId, taskRevision }); },
                delete: async () => { await run({ type: 'deleteTask', taskId, taskRevision }); },
            }),
        });
    };
    const openEvent = (eventId: string, view: NativeCalendarView) => {
        const event = events.find((entry) => entry.id === eventId)!;
        const sheet = ok(contract.getCalendarItemSheet({ event, canOpen: Boolean(event.nativeEventId) }));
        if (sheet.kind !== 'event') return;
        alerts.push({
            title: sheet.title,
            message: null,
            buttons: sheetButtons(sheet.buttons, {
                createTask: async () => {
                    const result = await run({ type: 'createTaskFromEvent', event });
                    if (result.next) state = result.next;
                    if (result.toast) toasts.push([result.toast.tone, result.toast.title, result.toast.message, result.toast.durationMs]);
                },
                // The harness's calendar app cannot open events.
                openInCalendar: async () => {
                    opened.push(event.id);
                    const toast = view.text.toasts.cannotOpenEvent;
                    toasts.push([toast.tone, toast.title, toast.message, toast.durationMs]);
                },
            }),
        });
    };
    const scheduleTask = (taskId: string) => openComposer({ scheduleTaskId: taskId, day: state!.selectedDate });
    const saveComposer = async () => {
        const result = await run({ type: 'saveComposer', composer: composer!.composer });
        if (result.composer) {
            composer = result.composer;
            return;
        }
        composer = null;
        query = '';
        state = result.next!;
        await setViewMode('day');
    };

    const draw = (view: NativeCalendarView, entries: NativeCalendarEntry[]): Drawn => {
        const drawn: Drawn = { texts: [], presses: [], inputs: [], blocks: [] };
        const text = (value: string) => drawn.texts.push(value);
        const press = (entry: Omit<Press, 'texts'>, texts: string[]) => {
            drawn.presses.push({ ...entry, texts });
            texts.forEach(text);
        };
        const header = () => {
            if (view.content.mode === 'schedule') {
                text(view.header.title);
                press({ label: view.header.today.label, press: async () => { state = view.header.today.state; } }, [view.header.today.label]);
            } else {
                const { previous, next, today } = view.header;
                press({ label: previous!.label, press: async () => { state = previous!.state; } }, ['‹']);
                text(view.header.title);
                press({ label: today.label, press: async () => { state = today.state; } }, [today.label]);
                press({ label: next!.label, press: async () => { state = next!.state; } }, ['›']);
            }
            for (const mode of view.modes) {
                press({ label: mode.label, press: async () => { state = mode.state; await setViewMode(mode.mode); } }, [mode.label]);
            }
            press({
                label: view.showCompleted.hint,
                press: async () => { await run({ type: 'setShowCompleted', on: !view.showCompleted.on }); },
            }, [view.showCompleted.label]);
        };
        const itemPress = (item: NativeCalendarItem) => async () => {
            if (item.eventId) openEvent(item.eventId, view);
            else openTask(item);
        };
        const searchInput = () => drawn.inputs.push([view.text.schedulePlaceholder, view.text.schedulePlaceholder, query]);
        const taskRows = (list: 'search' | 'planning') => {
            for (const entry of entries) {
                if (entry.type === 'task' && entry.list === list) {
                    press({ press: async () => { scheduleTask(entry.taskId); } }, [entry.title, entry.detail]);
                }
            }
        };
        const byDay = (key: string, lane: string) => entries.filter((entry): entry is Extract<NativeCalendarEntry, { type: 'item' }> => (
            entry.type === 'item' && entry.dayKey === key && entry.lane === lane
        )).map((entry) => entry.item);
        const days = entries.filter((entry): entry is Extract<NativeCalendarEntry, { type: 'day' }> => entry.type === 'day');

        header();
        const content = view.content;
        if (content.mode === 'month') {
            content.dayNames.forEach(text);
            for (const day of days) {
                const counts = day.counts ? [day.counts.tasks > 0 ? String(day.counts.tasks) : null, day.counts.events > 0 ? String(day.counts.events) : null]
                    .filter((entry): entry is string => entry !== null) : [];
                press({
                    label: day.accessibilityLabel ?? undefined,
                    press: async () => { state = { ...state!, selectedDate: day.key }; },
                }, [day.dayNumber, ...day.preview.map((item) => item.title), ...counts]);
            }
            const details = content.details;
            if (details) {
                const day = state!.selectedDate!;
                text(details.title);
                press({ label: view.text.addTask, press: async () => { openComposer({ day, mode: 'new' }); } }, [view.text.addTask]);
                searchInput();
                if (details.searchTitle) {
                    text(details.searchTitle);
                    taskRows('search');
                }
                if (details.events) {
                    text(details.events.title);
                    if (details.events.loading) text(details.events.loading);
                    if (details.events.error) text(details.events.error);
                    for (const item of byDay(day, 'events')) press({ press: itemPress(item) }, [item.title, item.detail ?? '']);
                }
                for (const item of byDay(day, 'deadlines')) {
                    press({ disabled: !item.pressable, press: itemPress(item) }, [item.title, item.detail ?? '']);
                    if (item.showDone) press({ press: async () => { await run({ type: 'completeTask', taskId: item.taskId, taskRevision: item.row!.taskRevision }); } }, [view.text.done]);
                }
                for (const item of byDay(day, 'scheduled')) {
                    const done = { press: async () => { await run({ type: 'completeTask', taskId: item.taskId, taskRevision: item.row!.taskRevision }); } };
                    drawn.presses.push({ disabled: !item.pressable, press: itemPress(item), texts: [item.title, item.detail ?? '', ...(item.showDone ? [view.text.done] : [])] });
                    text(item.title);
                    text(item.detail ?? '');
                    if (item.showDone) press(done, [view.text.done]);
                }
                if (details.empty) text(details.empty);
            }
        } else if (content.mode === 'week') {
            // Deadline weeks use scrollable, readable columns (at least 260pt).
            const hasDeadlineMarkers = entries.some((entry) => entry.type === 'item' && entry.lane === 'deadlineMarker');
            const compact = !hasDeadlineMarkers && weekColumnsCompact(content.visibleDays);
            for (const day of days) {
                press({ press: async () => { state = day.opens!; await setViewMode('day'); } }, [day.weekday, day.dayNumber]);
            }
            text(view.text.allDay);
            for (const day of days) {
                for (const item of byDay(day.key, 'allDay')) press({ disabled: !item.pressable, press: itemPress(item) }, [item.title]);
                if (day.allDayMore) press({ press: async () => { state = day.opens!; await setViewMode('day'); } }, [day.allDayMore]);
            }
            content.hourLabels.forEach(text);
            for (const day of days) {
                const timed = byDay(day.key, 'timed');
                const texts = timed.flatMap((item) => (compact ? [item.title] : [item.title, item.detail ?? '']));
                drawn.presses.push({ press: async () => { openComposer({ day: day.key, mode: 'new' }); }, texts });
                for (const item of timed) press({ disabled: !item.pressable, press: itemPress(item) }, compact ? [item.title] : [item.title, item.detail ?? '']);
                for (const item of byDay(day.key, 'deadlineMarker')) press({ disabled: !item.pressable, press: itemPress(item) }, ['◆', item.title, item.detail ?? '']);
            }
            for (const choice of content.density.choices) {
                press({ label: choice.label, press: async () => { await run({ type: 'setWeekVisibleDays', days: choice.days }); } }, [String(choice.days)]);
            }
        } else if (content.mode === 'day') {
            const allDay = byDay(content.dayKey, 'allDay');
            if (allDay.length > 0) {
                text(view.text.allDay);
                for (const item of allDayExpanded || !content.allDayMore ? allDay : allDay.slice(0, content.allDayLimit)) press({ press: itemPress(item) }, [item.title]);
                if (content.allDayMore) {
                    press({ press: async () => { allDayExpanded = !allDayExpanded; } }, [allDayExpanded ? view.text.allDayLess : content.allDayMore]);
                }
            }
            drawn.presses.push({ press: async () => undefined, texts: [] });
            content.hourLabels.forEach(text);
            for (const item of byDay(content.dayKey, 'timed')) {
                if (item.eventId) {
                    press({ press: itemPress(item) }, [item.title, item.detail ?? '']);
                    continue;
                }
                const timed = item.timed!;
                const height = Math.max(24, (timed.endMinutes - timed.startMinutes) * PIXELS_PER_MINUTE);
                drawn.blocks.push({ title: item.title, item });
                text(item.title);
                if (height >= 44) text(item.detail ?? '');
            }
            for (const item of byDay(content.dayKey, 'deadlineMarker')) press({ disabled: !item.pressable, press: itemPress(item) }, ['◆', item.title, item.detail ?? '']);
            searchInput();
            if (content.searchTitle) {
                text(content.searchTitle);
                taskRows('search');
            }
        } else {
            for (const day of days) {
                text(day.title);
                for (const item of byDay(day.key, 'list')) {
                    press({ label: item.accessibilityLabel ?? undefined, disabled: !item.pressable, press: itemPress(item) }, [item.title, item.detail ?? '']);
                }
            }
            if (content.empty) text(content.empty);
            if (content.planning) {
                text(content.planning.title);
                text(content.planning.subtitle);
                taskRows('planning');
            }
        }

        if (composer) {
            const current = composer;
            const modalStart = drawn.texts.length;
            const backdrop: Press = { press: async () => { composer = null; }, texts: [] };
            drawn.presses.push(backdrop);
            text(current.text.title);
            text(current.dateLabel);
            press({ label: current.text.close, press: async () => { composer = null; } }, ['×']);
            for (const [mode, label] of [['new', current.text.newTask], ['existing', current.text.existingTask]] as const) {
                press({ label, press: async () => { edit({ type: 'mode', mode }); } }, [label]);
            }
            if (current.composer.mode === 'new') {
                drawn.inputs.push([current.text.titlePlaceholder, current.text.titlePlaceholder, current.composer.title]);
                text(current.text.help);
            } else {
                drawn.inputs.push([current.text.queryPlaceholder, current.text.queryPlaceholder, current.composer.query]);
                for (const candidate of current.candidates ?? []) {
                    press({ label: candidate.title, press: async () => { edit({ type: 'selectTask', taskId: candidate.id }); } }, [candidate.title]);
                }
                if ((current.candidates ?? []).length === 0) text(current.text.noMatchingTasks);
                if (current.selectedTaskTitle) text(current.selectedTaskTitle);
            }
            text(current.text.start);
            drawn.inputs.push([current.text.start, current.placeholders.start, current.timeLabels.start]);
            text(current.text.end);
            drawn.inputs.push([current.text.end, current.placeholders.end, current.timeLabels.end]);
            for (const duration of current.durations) {
                press({ label: duration.label, press: async () => { edit({ type: 'duration', minutes: duration.minutes }); } }, [duration.label]);
            }
            if (current.error) text(current.error);
            press({ label: current.text.cancel, press: async () => { composer = null; } }, [current.text.cancel]);
            press({ label: current.text.save, disabled: current.saveDisabled, press: saveComposer }, [current.text.save]);
            backdrop.texts = drawn.texts.slice(modalStart);
        }
        return drawn;
    };

    const observe = (): Observation => {
        const { view, entries } = read();
        const drawn = draw(view, entries);
        const observation = {
            texts: drawn.texts,
            inputs: drawn.inputs,
            editor: editor ? [editor, 'view'] : null,
            writes: recorder.log.slice(seen.writes),
            toasts: toasts.slice(seen.toasts),
            alerts: alerts.slice(seen.alerts).map((alert) => [alert.title, alert.message, alert.buttons.map((button) => [button.label, button.style])]),
            fetches: fetches.slice(seen.fetches),
            opened: opened.slice(seen.opened),
        };
        Object.assign(seen, { writes: recorder.log.length, toasts: toasts.length, alerts: alerts.length, fetches: fetches.length, opened: opened.length });
        return recorder.normalize(observation) as Observation;
    };

    const findPress = (presses: Press[], label: string) => (
        presses.find((entry) => entry.label === label)
        ?? presses.find((entry) => entry.texts.join('') === label)
        ?? presses.find((entry) => entry.texts[0] === label)
    );
    const dayLabel = (key: string) => {
        const [year, month, day] = key.split('-').map(Number);
        return new Date(year, month - 1, day).toLocaleDateString(fixture.deviceLocale, { weekday: 'long', month: 'long', day: 'numeric' });
    };

    const perform = async ([kind, target, ...rest]: [string, ...unknown[]]) => {
        const { view, entries } = read();
        const drawn = draw(view, entries);
        const need = <T,>(value: T | undefined | null, what: string): T => {
            if (value === undefined || value === null) throw new Error(`Nothing to do for ${what} in ${JSON.stringify(drawn.texts)}`);
            return value;
        };
        switch (kind) {
            case 'press':
            case 'mode':
            case 'toggleCompleted': {
                const label = kind === 'toggleCompleted' ? view.showCompleted.hint : String(target);
                const control = need(findPress(drawn.presses, label), `press ${label}`);
                if (!control.disabled) await control.press();
                return;
            }
            case 'day': {
                const label = dayLabel(String(target));
                const cell = need(drawn.presses.find((entry) => entry.label === label || entry.label?.startsWith(`${label}.`)), `day ${String(target)}`);
                await cell.press();
                return;
            }
            case 'untitledEvent':
                await need(drawn.presses.find((entry) => entry.texts[0] === '' && entry.texts.length > 1), 'untitled event').press();
                return;
            case 'doneButton': {
                // The first row with that title, and the Done button that follows it.
                const index = drawn.presses.findIndex((entry) => entry.texts[0] === target);
                need(drawn.presses[index], `done ${String(target)}`);
                const button = drawn.presses.slice(index + 1).find((entry) => entry.texts.join('') === view.text.done);
                await need(button, `done button of ${String(target)}`).press();
                return;
            }
            case 'swipe': {
                const dx = Number(rest[0]);
                if (Math.abs(dx) < 28) return;
                const target = dx < 0 ? view.header.next : view.header.previous;
                state = need(target, 'swipe').state;
                return;
            }
            case 'closeDetails':
                if (view.content.mode === 'month' && view.content.details) state = view.content.details.close;
                return;
            case 'alert': {
                const button = need(alerts[alerts.length - 1]?.buttons.find((entry) => entry.label === target), `alert ${String(target)}`);
                await button.press?.();
                return;
            }
            case 'type': {
                const value = String(rest[0]);
                if (composer) {
                    const field = target === composer.text.titlePlaceholder ? { type: 'title', title: value }
                        : target === composer.text.queryPlaceholder ? { type: 'query', query: value }
                            : target === composer.text.start ? { type: 'startTime', value }
                                : target === composer.text.end ? { type: 'endTime', value } : null;
                    if (field) {
                        edit(field);
                        return;
                    }
                }
                need(target === view.text.schedulePlaceholder ? true : null, `type ${String(target)}`);
                query = value;
                return;
            }
            case 'timeline': {
                const content = view.content;
                if (content.mode !== 'day') throw new Error('The timeline is on the day view');
                const rawMinutes = Number(target) / PIXELS_PER_MINUTE;
                const snapped = Math.round(rawMinutes / 5) * 5;
                const minutes = Math.max(0, Math.min(24 * 60 - 30, snapped));
                const [year, month, day] = content.dayKey.split('-').map(Number);
                openComposer({ at: new Date(new Date(year, month - 1, day).getTime() + minutes * 60_000).toISOString(), mode: 'new' });
                return;
            }
            case 'weekColumn':
            case 'weekHeader': {
                const days = entries.filter((entry): entry is Extract<NativeCalendarEntry, { type: 'day' }> => entry.type === 'day');
                const day = need(days[Number(target)], kind);
                if (kind === 'weekColumn') openComposer({ day: day.key, mode: 'new' });
                else {
                    state = day.opens!;
                    await setViewMode('day');
                }
                return;
            }
            case 'drag': {
                const block = need(drawn.blocks.find((entry) => entry.title === target && !entry.item.projected), `drag ${String(target)}`);
                const timed = block.item.timed!;
                const top = Math.max(0, timed.startMinutes) * PIXELS_PER_MINUTE;
                const startMinutes = Math.round((top + Number(rest[0])) / PIXELS_PER_MINUTE / 5) * 5;
                const clamped = Math.max(0, Math.min(24 * 60 - timed.durationMinutes, startMinutes));
                const content = view.content as Extract<NativeCalendarView['content'], { mode: 'day' }>;
                const result = await run({
                    type: 'moveTask', taskId: block.item.taskId, day: content.dayKey, startMinutes: clamped, durationMinutes: timed.durationMinutes,
                    taskRevision: block.item.row!.taskRevision,
                });
                if (result.toast) toasts.push([result.toast.tone, result.toast.title, result.toast.message, result.toast.durationMs]);
                return;
            }
            case 'tapBlock': {
                const block = need(drawn.blocks.find((entry) => entry.title === target), `tap ${String(target)}`);
                openTask(block.item);
                return;
            }
            case 'closeEditor':
                editor = null;
                return;
            default:
                throw new Error(`Unknown action ${kind}`);
        }
    };

    const observations = [observe()];
    for (const action of scenario.actions) {
        await perform(action);
        await flushPendingSave();
        observations.push(observe());
    }
    return observations;
}
