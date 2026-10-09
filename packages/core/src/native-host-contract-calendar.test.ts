import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCalendarRecorder, loadCalendarViewsFixture, seedCalendarStore, type CalendarScenario } from './calendar-view-model.replay';
import {
    createCalendarLocaleDates,
    getCalendarDayLists,
    getCalendarMonthCell,
    getCalendarPlanningTasks,
    getCalendarRangeTasks,
    getCalendarSchedulableTasks,
    getCalendarScheduleSections,
    getCalendarDayItems,
    getCalendarVisibleRange,
    getCalendarWeekAllDayItems,
    getCalendarWeekStart,
    indexCalendarCompletedTasks,
    indexCalendarDeadlineTasks,
    indexCalendarEvents,
    indexCalendarScheduledTasks,
} from './calendar-view-model';
import { createDateFormatter } from './date';
import { createNativeHostContract, sortAreasForDisplay } from './native-host-contract';
import type { NativeCalendarEntry, NativeCalendarFeed, NativeCalendarView } from './native-host-contract-calendar';
import { isTaskVisibleInArea, resolveAreaFilterSelection } from './area-filter';
import { requestRowId, taskRevisionOf, setNativeReplayTokens } from './native-request-receipts';
import { replayAfterRestart } from './screen-parity.replay';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { noopStorage } from './storage';
import { generateUUID } from './uuid';

// Counts recurring expansions; everything else is the real module.
const expansion = vi.hoisted(() => ({ calls: 0 }));
vi.mock('./recurrence', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./recurrence')>();
    return {
        ...actual,
        expandCalendarRecurringTaskSetInRange: (...args: Parameters<typeof actual.expandCalendarRecurringTaskSetInRange>) => {
            expansion.calls += 1;
            return actual.expandCalendarRecurringTaskSetInRange(...args);
        },
    };
});

const fixture = loadCalendarViewsFixture();
const scenario = (settings = 'month', extra: Partial<CalendarScenario> = {}): CalendarScenario => ({ name: 'contract', settings, actions: [], ...extra });
const page = { offset: 0, limit: 100 };
const ready: NativeCalendarFeed = { status: 'ready', calendars: fixture.calendars, events: fixture.calendarEvents };
const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const days = (view: NativeCalendarView) => view.items.filter((entry): entry is Extract<NativeCalendarEntry, { type: 'day' }> => entry.type === 'day');
const items = (view: NativeCalendarView, lane: string) => view.items
    .filter((entry): entry is Extract<NativeCalendarEntry, { type: 'item' }> => entry.type === 'item' && entry.lane === lane)
    .map((entry) => entry.item);
const week = { viewMode: 'week' as const, selectedDate: '2026-10-28', visibleMonth: '2026-10-28' };
/** The revision a task's item sheet shows (the week of the fixture's today): what Remove from calendar, Done and Delete send back. */
const sheetRevision = (host: ReturnType<typeof createNativeHostContract>, taskId: string) => {
    const sheet = value(host.getCalendarItemSheet({ taskId, state: week, calendar: ready }));
    if (sheet.kind !== 'task') throw new Error(`${taskId} has no task sheet`);
    return sheet.taskRevision;
};
/** A task's revision in the store, for a task no sheet of the week shows. */
const storeRevision = (taskId: string) => taskRevisionOf(useTaskStore.getState()._tasksById.get(taskId)!);

describe('native host contract: Calendar', () => {
    const originalTz = process.env.TZ;
    beforeAll(() => {
        process.env.TZ = fixture.timeZone;
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

    // Revisions read the clock.
    const freezeClock = (at = fixture.now) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(at));
    };
    const openHost = async (entry = scenario(), saveData?: (data: unknown) => Promise<void>) => {
        const recorder = createCalendarRecorder();
        await seedCalendarStore(fixture, entry, recorder, { saveData });
        const host = createNativeHostContract();
        expect(await host.setLanguage({ storedLanguage: 'en', systemLocale: fixture.deviceLocale })).toMatchObject({ ok: true });
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        recorder.log.length = 0;
        return { host, recorder };
    };

    it('emits deadline points separately from durations, including midnight', async () => {
        freezeClock();
        const { host, recorder } = await openHost(scenario());
        const store = useTaskStore.getState();
        const add = async (title: string, props: Record<string, unknown>) => {
            const result = await store.addTask(title, { status: 'next', ...props });
            if (!result.success || !result.id) throw new Error('seed failed');
            return result.id;
        };
        const same = await add('Timed same', { startTime: '2026-10-28T13:00:00Z', dueDate: '2026-10-28T19:00:00Z' });
        const midnight = await add('Midnight point', { dueDate: '2026-10-28T04:00:00Z' });
        const close = await add('Close point', { dueDate: '2026-10-28T19:05:00Z' });
        const end = await add('Last minute', { dueDate: '2026-10-29T03:59:00Z' });
        await flushPendingSave();
        const before = JSON.stringify(useTaskStore.getState().tasks);
        recorder.log.length = 0;
        for (const viewMode of ['day', 'week'] as const) {
            const view = value(host.getCalendarView({ state: { ...week, viewMode }, calendar: ready, ...page }));
            const markers = items(view, 'deadlineMarker');
            const point = markers.find((item) => item.taskId === same)!;
            expect(point).toMatchObject({ kind: 'deadline', detail: '3:00 PM · Due', timed: null, pressable: true, deadline: { startMinutes: 900 } });
            expect(items(view, 'timed').some((item) => item.taskId === same)).toBe(true);
            expect(items(view, 'allDay').some((item) => [same, midnight].includes(item.taskId!))).toBe(false);
            expect(markers.find((item) => item.taskId === midnight)?.deadline?.startMinutes).toBe(0);
            expect(markers.find((item) => item.taskId === close)?.deadline?.groupId).toBe(point.deadline?.groupId);
            expect(markers.find((item) => item.taskId === end)?.deadline?.startMinutes).toBe(1439);
        }
        expect(JSON.stringify(useTaskStore.getState().tasks)).toBe(before);
        expect(recorder.log).toEqual([]);
    });

    it('returns what core\'s calendar model returns when called directly', async () => {
        freezeClock();
        const { host } = await openHost(scenario('completed'));
        const state = useTaskStore.getState();
        const now = new Date();
        const areas = sortAreasForDisplay(state.areas);
        const areaById = new Map(areas.map((area) => [area.id, area]));
        const projectById = new Map(state.projects.map((project) => [project.id, project]));
        const resolvedAreaFilter = resolveAreaFilterSelection(state.settings.filters, areas);
        const visible = state.tasks.filter((task) => isTaskVisibleInArea(task, { areaById, projectById, resolvedAreaFilter }));
        const index = (range: { rangeStart: Date; rangeEnd: Date }) => {
            const tasks = getCalendarRangeTasks(visible, { rangeStartMs: range.rangeStart.getTime(), rangeEndMs: range.rangeEnd.getTime() }, now.toISOString());
            return {
                scheduled: indexCalendarScheduledTasks(tasks),
                deadlines: indexCalendarDeadlineTasks(tasks),
                completed: indexCalendarCompletedTasks(state._allTasks, { showCompleted: true, projectById, areaById, resolvedAreaFilter }),
                events: indexCalendarEvents(fixture.calendarEvents),
            };
        };

        // Month: every cell's counts and previews, and the selected day's lists.
        const month = value(host.getCalendarView({ state: { viewMode: 'month', selectedDate: '2026-10-28', visibleMonth: '2026-10-28' }, calendar: ready, ...page }));
        const monthIndex = index(getCalendarVisibleRange({
            calendarSystem: 'gregorian', currentMonthDate: new Date(2026, 9, 1), selectedDate: new Date(2026, 9, 28), viewMode: 'month',
            weekStartTime: getCalendarWeekStart(new Date(2026, 9, 28), 0).getTime(),
        }));
        const cells = Array.from({ length: 31 }, (_, offset) => {
            const date = new Date(2026, 9, offset + 1);
            return getCalendarMonthCell(date, getCalendarDayLists(monthIndex, date), { dates: createCalendarLocaleDates('en-US'), t: (key) => key });
        });
        expect(days(month).map((day) => [day.key.slice(-2), day.counts, day.preview.map((item) => item.id)]))
            .toEqual(cells.map((cell, offset) => [
                String(offset + 1).padStart(2, '0'),
                cell.showCounts ? { tasks: cell.taskCount, events: cell.eventCount } : null,
                cell.previewItems.map((item) => item.id),
            ]));
        const selectedLists = getCalendarDayLists(monthIndex, new Date(2026, 9, 28));
        expect(items(month, 'deadlines').map((item) => item.taskId)).toEqual(selectedLists.deadlines.filter((task) => !selectedLists.scheduled.some((scheduled) => scheduled.id === task.id)).map((task) => task.id));
        expect(items(month, 'scheduled').map((item) => item.taskId)).toEqual(selectedLists.scheduled.map((task) => task.id));
        expect(items(month, 'events').map((item) => item.eventId)).toEqual(selectedLists.events.map((event) => event.id));
        // Rows carry core meta.
        expect(items(month, 'scheduled').every((item) => item.row?.meta)).toBe(true);

        // Week: the all-day lanes.
        const week = value(host.getCalendarView({ state: { viewMode: 'week', selectedDate: '2026-10-28', visibleMonth: '2026-10-28' }, calendar: ready, ...page }));
        const weekStart = getCalendarWeekStart(new Date(2026, 9, 28), 0);
        const weekIndex = index(getCalendarVisibleRange({
            calendarSystem: 'gregorian', currentMonthDate: new Date(2026, 9, 1), selectedDate: new Date(2026, 9, 28), viewMode: 'week', weekStartTime: weekStart.getTime(),
        }));
        const weekDays = Array.from({ length: 7 }, (_, offset) => new Date(2026, 9, 25 + offset));
        expect(items(week, 'allDay').map((item) => item.id))
            .toEqual(weekDays.flatMap((date) => getCalendarWeekAllDayItems(getCalendarDayItems(getCalendarDayLists(weekIndex, date))).map((item) => item.id)));
        // As on mobile, a completed item offers no sheet: only the view's open tasks do.
        expect(items(week, 'allDay').some((item) => item.kind === 'completed' && item.taskId === 'd-done')).toBe(true);
        expect(items(week, 'allDay').find((item) => item.taskId === 'd-done')?.pressable).toBe(false);
        const completedDay = value(host.getCalendarView({ state: { viewMode: 'day', selectedDate: '2026-10-27', visibleMonth: '2026-10-27' }, calendar: ready, ...page }));
        expect(items(completedDay, 'allDay').find((item) => item.taskId === 'd-done')?.pressable).toBe(false);
        expect(host.getCalendarItemSheet({ taskId: 'd-done', state: week.state, calendar: ready })).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
        expect(value(host.getCalendarItemSheet({ taskId: 't-plan', state: week.state, calendar: ready }))).toMatchObject({
            kind: 'task', buttons: [{ id: 'edit' }, { id: 'unschedule' }, { id: 'done' }, { id: 'delete', style: 'destructive' }, { id: 'cancel', style: 'cancel' }],
        });

        // Schedule: its days and the planning list.
        const schedule = value(host.getCalendarView({ state: { viewMode: 'schedule', selectedDate: '2026-10-28', visibleMonth: '2026-10-28' }, calendar: ready, ...page }));
        const completedSchedule = value(host.getCalendarView({ state: { viewMode: 'schedule', selectedDate: '2026-10-27', visibleMonth: '2026-10-27' }, calendar: ready, ...page }));
        expect(items(completedSchedule, 'list').find((item) => item.taskId === 'd-done')?.pressable).toBe(false);
        const scheduleIndex = index(getCalendarVisibleRange({
            calendarSystem: 'gregorian', currentMonthDate: new Date(2026, 9, 1), selectedDate: new Date(2026, 9, 28), viewMode: 'schedule', weekStartTime: weekStart.getTime(),
        }));
        const sections = getCalendarScheduleSections(new Date(2026, 9, 28), (date) => getCalendarDayItems(getCalendarDayLists(scheduleIndex, date)));
        expect(days(schedule).map((day) => day.key)).toEqual(sections.map((section) => `${section.date.getFullYear()}-${String(section.date.getMonth() + 1).padStart(2, '0')}-${String(section.date.getDate()).padStart(2, '0')}`));
        const planning = getCalendarPlanningTasks(visible, { now, prioritiesEnabled: true, projects: state.projects, sections: state.sections });
        expect(schedule.items.filter((entry) => entry.type === 'task').map((entry) => entry.type === 'task' && entry.taskId)).toEqual(planning.map((task) => task.id));
        expect(getCalendarSchedulableTasks(visible).length).toBeGreaterThan(0);
    });

    it('opens in the saved mode on today and fetches the view\'s range', async () => {
        freezeClock();
        const { host } = await openHost(scenario('week'));
        const view = value(host.getCalendarView({ ...page }));
        expect(view.state).toEqual({ viewMode: 'week', selectedDate: '2026-10-28', visibleMonth: '2026-10-28' });
        expect(view.range).toEqual({ start: '2026-10-25T04:00:00.000Z', end: '2026-11-01T03:59:59.999Z' });
        // The next week leaves daylight time.
        expect(view.header.next?.state).toEqual({ viewMode: 'week', selectedDate: '2026-11-04', visibleMonth: '2026-11-04' });
        const next = value(host.getCalendarView({ state: view.header.next!.state, ...page }));
        expect([next.header.title, next.range]).toEqual(['Nov 1 - Nov 7', { start: '2026-11-01T04:00:00.000Z', end: '2026-11-08T04:59:59.999Z' }]);
        expect(next.content.mode === 'week' && next.content.visibleDays).toBe(5);
    });

    it('shows a first-load calendar error in month details', async () => {
        freezeClock();
        const { host } = await openHost();
        const view = value(host.getCalendarView({ state: { viewMode: 'month', selectedDate: '2026-10-28', visibleMonth: '2026-10-28' }, calendar: { status: 'error', message: 'Feed unavailable' }, ...page }));
        expect(view.content.mode === 'month' && view.content.details?.events?.error).toBe('Feed unavailable');
    });

    it('shows a task due and scheduled on one day only as scheduled in month details', async () => {
        freezeClock();
        const { host } = await openHost();
        const view = value(host.getCalendarView({ state: { viewMode: 'month', selectedDate: '2026-10-29', visibleMonth: '2026-10-29' }, calendar: ready, ...page }));
        expect([...items(view, 'deadlines'), ...items(view, 'scheduled')].filter((item) => item.taskId === 't-form')).toHaveLength(1);
        expect(items(view, 'scheduled').some((item) => item.taskId === 't-form')).toBe(true);
    });

    it('rejects malformed and oversized calendar Area associations at the native boundary', async () => {
        freezeClock();
        const { host } = await openHost();
        for (const areaIds of ['work', [42], ['x'.repeat(201)], Array(201).fill('a-work')]) {
            const calendar = { ...ready, calendars: ready.calendars?.map((entry) => ({ ...entry, areaIds })) };
            expect(host.getCalendarView({ state: { viewMode: 'month', selectedDate: '2026-10-28', visibleMonth: '2026-10-28' }, calendar, ...page } as never))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
    });

    it('applies the shared Area association to native event rows', async () => {
        freezeClock();
        const { host } = await openHost();
        const settings = useTaskStore.getState().settings;
        useTaskStore.setState({ settings: { ...settings, filters: { ...settings.filters, areaId: 'a-home', areaIds: ['a-home'], excludedAreaIds: [] } } });
        const calendar = { ...ready, calendars: ready.calendars?.map((entry) => entry.id === 'ics-work' ? { ...entry, areaIds: ['a-work'] } : entry) } as NativeCalendarFeed;
        const view = value(host.getCalendarView({ state: { viewMode: 'month', selectedDate: '2026-10-28', visibleMonth: '2026-10-28' }, calendar, ...page }));
        expect(items(view, 'events').some((item) => item.eventId === 'e-sync')).toBe(false);
        expect(items(view, 'events').some((item) => item.eventId === 'e-lunch')).toBe(true);
    });

    it('uses Jalali month and year in contract headings', async () => {
        freezeClock();
        const { host } = await openHost();
        useTaskStore.setState({ settings: { ...useTaskStore.getState().settings, calendarSystem: 'jalali' } });
        expect(await host.setLanguage({ storedLanguage: 'fa', systemLocale: 'fa-IR' })).toMatchObject({ ok: true });
        const month = value(host.getCalendarView({ state: { viewMode: 'month', selectedDate: '2025-03-21', visibleMonth: '2025-03-21' }, calendar: ready, ...page }));
        expect(month.header.title).toBe('فروردین 1404');
    });

    it('builds its headings in the current language without Intl, as the native host runs them', async () => {
        freezeClock();
        const { host } = await openHost(scenario('month'));
        expect(await host.setLanguage({ storedLanguage: 'de', systemLocale: null })).toMatchObject({ ok: true });
        // QuickJS has no Intl: the host's stub formats English only, and toLocale* ignore the locale.
        const realIntl = globalThis.Intl;
        const realToLocaleDateString = Date.prototype.toLocaleDateString;
        const realToLocaleString = Date.prototype.toLocaleString;
        class EnglishOnlyDateTimeFormat {
            private inner: Intl.DateTimeFormat;
            constructor(_locales?: unknown, options?: Intl.DateTimeFormatOptions) { this.inner = new realIntl.DateTimeFormat('en-US', options); }
            format(date?: Date | number) { return this.inner.format(date); }
            formatToParts(date?: Date | number) { return this.inner.formatToParts(date); }
            resolvedOptions() { return this.inner.resolvedOptions(); }
        }
        globalThis.Intl = { ...realIntl, DateTimeFormat: EnglishOnlyDateTimeFormat } as unknown as typeof Intl;
        Date.prototype.toLocaleDateString = function toLocaleDateString(_locales?: unknown, options?: Intl.DateTimeFormatOptions) {
            return realToLocaleDateString.call(this, 'en-US', options);
        };
        Date.prototype.toLocaleString = function toLocaleString(_locales?: unknown, options?: Intl.DateTimeFormatOptions) {
            return realToLocaleString.call(this, 'en-US', options);
        };
        try {
            const state = { viewMode: 'month' as const, selectedDate: '2026-10-28', visibleMonth: '2026-10-28' };
            const month = value(host.getCalendarView({ state, calendar: ready, ...page }));
            expect(month.header.title).toBe('Oktober 2026');
            expect(month.content.mode === 'month' && month.content.dayNames).toEqual(['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']);
            expect(month.content.mode === 'month' && month.content.details?.title).toBe('Mittwoch, 28 Oktober 2026');
            expect(days(month).find((day) => day.key === '2026-10-30')?.accessibilityLabel).toMatch(/^Freitag 30 Oktober\. 5 Aufgaben/);
            const week = value(host.getCalendarView({ state: { ...state, viewMode: 'week' }, calendar: ready, ...page }));
            expect(week.header.title).toBe('25 Okt. - 31 Okt.');
            const day = value(host.getCalendarView({ state: { ...state, viewMode: 'day' }, calendar: ready, ...page }));
            expect(day.header.title).toBe('Mi. 28 Oktober · Heute');
            // Clock times use the user's formatter too.
            const formatDate = createDateFormatter({ language: 'de', systemLocale: null });
            const block = items(day, 'timed').find((item) => item.taskId === 't-deep')!;
            expect(block.detail).toBe(`${formatDate(new Date(2026, 9, 28, 13), 'p')}-${formatDate(new Date(2026, 9, 28, 15), 'p')}`);
            const composer = value(host.openCalendarComposer({ day: '2026-10-31', calendar: ready })).composer!;
            expect(composer.dateLabel).toBe('Sa. 31 Okt.');
        } finally {
            globalThis.Intl = realIntl;
            Date.prototype.toLocaleDateString = realToLocaleDateString;
            Date.prototype.toLocaleString = realToLocaleString;
        }
    });

    it('keeps Chinese composer edits raw while offering localized labels', async () => {
        freezeClock();
        const { host } = await openHost();
        expect(await host.setLanguage({ storedLanguage: 'zh-Hans', systemLocale: 'zh-CN' })).toMatchObject({ ok: true });
        const at = new Date(2026, 9, 31, 8);
        const opened = value(host.openCalendarComposer({ at: at.toISOString(), calendar: ready })).composer!;
        expect(opened.composer.startTimeValue).toBe('08:00');
        expect(opened.timeLabels.start).toContain('8:00');
        const titled = value(host.editCalendarComposer({ composer: opened.composer, edit: { type: 'title', title: 'Morning call' }, calendar: ready }));
        const edited = value(host.editCalendarComposer({ composer: titled.composer, edit: { type: 'startTime', value: '09:00' }, calendar: ready }));
        expect(edited.composer.startTimeValue).toBe('09:00');
        const saved = value(await host.runCalendarAction({ requestId: generateUUID(), action: { type: 'saveComposer', composer: edited.composer }, calendar: ready }));
        expect(saved.changed).toBe(true);
        expect(new Date(useTaskStore.getState().tasks.find((task) => task.id === saved.taskId)?.startTime ?? '').getHours()).toBe(9);
    });

    it('retains supplied events during a same-view refresh and clears them when the loading feed omits them', async () => {
        freezeClock();
        const { host } = await openHost();
        const state = { viewMode: 'month' as const, selectedDate: '2026-10-31', visibleMonth: '2026-10-31' };
        const shown = value(host.getCalendarView({ state, calendar: ready, ...page }));
        const eventIds = items(shown, 'events').map((item) => item.eventId);
        expect(eventIds).toEqual(['e-retreat']);
        const loading = value(host.getCalendarView({ state, calendar: { status: 'loading', calendars: fixture.calendars, events: fixture.calendarEvents }, ...page }));
        expect(items(loading, 'events').map((item) => item.eventId)).toEqual(eventIds);
        expect(loading.content.mode === 'month' && loading.content.details?.events?.loading).toBeTruthy();
        const empty = value(host.getCalendarView({ state, calendar: { status: 'loading', calendars: fixture.calendars }, ...page }));
        expect(items(empty, 'events')).toEqual([]);
    });

    it('shows a ready feed warning while retaining its events and rejects malformed warnings', async () => {
        freezeClock();
        const { host } = await openHost();
        const state = { viewMode: 'month' as const, selectedDate: '2026-10-28', visibleMonth: '2026-10-28' };
        const shown = value(host.getCalendarView({ state, calendar: ready, ...page }));
        const warning = 'Failed to load events';
        const partial = value(host.getCalendarView({ state, calendar: { ...ready, warning }, ...page }));
        expect(items(partial, 'events')).toEqual(items(shown, 'events'));
        expect(partial.content.mode === 'month' && partial.content.details?.events?.error).toBe(warning);
        for (const malformed of [null, 42, 'x'.repeat(2001)]) {
            expect(host.getCalendarView({ state, calendar: { ...ready, warning: malformed }, ...page } as never))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
    });

    it('leaves a task at the second fall 1:30 AM when its block is dropped in place', async () => {
        freezeClock();
        const { host } = await openHost();
        const later = '2026-11-01T06:30:00.000Z';
        await useTaskStore.getState().updateTask('t-standup', { startTime: later });
        const result = value(await host.runCalendarAction({
            requestId: generateUUID(), action: { type: 'moveTask', taskId: 't-standup', day: '2026-11-01', startMinutes: 90, durationMinutes: 30, taskRevision: storeRevision('t-standup') }, calendar: ready,
        }));
        expect(result.changed).toBe(false);
        expect(useTaskStore.getState().tasks.find((task) => task.id === 't-standup')?.startTime).toBe(later);
    });

    it('expands recurring tasks once per range: a new selected day, search or item sheet reuses it', async () => {
        freezeClock();
        const bulk = Array.from({ length: 5_000 }, (_, index) => ({
            id: `bulk-${index}`, title: `Bulk ${index}`, status: 'next' as const, contexts: [], tags: [],
            dueDate: `2026-10-${String((index % 28) + 1).padStart(2, '0')}`,
            createdAt: fixture.now, updatedAt: fixture.now,
            ...(index % 50 === 0 ? { recurrence: 'weekly', showFutureRecurrence: true } : {}),
        }));
        const recorder = createCalendarRecorder();
        await seedCalendarStore({ ...fixture, tasks: [...fixture.tasks, ...bulk] }, scenario(), recorder);
        const host = createNativeHostContract();
        expect(await host.setLanguage({ storedLanguage: 'en', systemLocale: fixture.deviceLocale })).toMatchObject({ ok: true });
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        const state = { viewMode: 'month' as const, selectedDate: null, visibleMonth: '2026-10-01' };
        value(host.getCalendarView({ state, calendar: ready, ...page }));
        const calls = expansion.calls;
        expect(calls).toBeGreaterThan(0);
        value(host.getCalendarView({ state: { ...state, selectedDate: '2026-10-12' }, calendar: ready, ...page }));
        value(host.getCalendarView({ state: { ...state, selectedDate: '2026-10-19' }, scheduleQuery: 'bulk 1', calendar: ready, ...page }));
        value(host.getCalendarView({ state: { ...state, viewMode: 'day', selectedDate: '2026-10-19' }, calendar: ready, ...page }));
        value(host.getCalendarItemSheet({ taskId: 'bulk-7', state: { ...state, selectedDate: '2026-10-19' }, calendar: ready }));
        expect(expansion.calls).toBe(calls);
        // Another month is another range.
        value(host.getCalendarView({ state: { ...state, visibleMonth: '2026-11-01' }, calendar: ready, ...page }));
        expect(expansion.calls).toBe(calls + 1);
    });

    it('pages within one revision and refuses a stale page after an edit and at a day boundary', async () => {
        freezeClock('2026-10-29T03:58:00.000Z');
        const { host } = await openHost();
        const state = { viewMode: 'month' as const, selectedDate: '2026-10-28', visibleMonth: '2026-10-28' };
        const first = value(host.getCalendarView({ state, calendar: ready, offset: 0, limit: 5 }));
        expect(first.total).toBeGreaterThan(5);
        expect(value(host.getCalendarView({ state, calendar: ready, offset: 5, limit: 5, revision: first.revision })).items).toHaveLength(5);
        expect(host.getCalendarView({ state, calendar: ready, offset: 5, limit: 5 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(host.getCalendarView({ state, calendar: ready, offset: 0, limit: 101 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

        await useTaskStore.getState().updateTask('t-rent', { title: 'Pay the rent' });
        expect(host.getCalendarView({ state, calendar: ready, offset: 5, limit: 5, revision: first.revision })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        const edited = value(host.getCalendarView({ state, calendar: ready, offset: 0, limit: 5 }));
        expect(edited.revision).not.toBe(first.revision);

        // Midnight in New York: today moves, and so does the revision.
        vi.setSystemTime(new Date('2026-10-29T04:01:00.000Z'));
        const tomorrow = value(host.getCalendarView({ state, calendar: ready, offset: 0, limit: 100 }));
        expect(tomorrow.revision).not.toBe(edited.revision);
        expect(days(tomorrow).find((day) => day.isToday)?.key).toBe('2026-10-29');
        // Another calendar answer is another view.
        expect(value(host.getCalendarView({ state, offset: 0, limit: 5 })).revision).not.toBe(tomorrow.revision);
    });

    it('retries a failed composer save exactly: one task, and the retry finishes the save', async () => {
        freezeClock();
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost(scenario(), saveData);
        const opened = value(host.openCalendarComposer({ day: '2026-10-31', calendar: ready }));
        const composer = value(host.editCalendarComposer({ composer: opened.composer!.composer, edit: { type: 'title', title: 'Buy paint +Kitchen /due:2026-11-02' }, calendar: ready }));
        const input = { requestId: generateUUID(), action: { type: 'saveComposer' as const, composer: composer.composer }, calendar: ready };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        // The project and the task both land; only the save fails.
        expect(await host.runCalendarAction(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED', message: 'disk unavailable' } });
        expect(recorder.log.map(([name]) => name)).toEqual(['addProject', 'addTask']);

        saveData.mockResolvedValue(undefined);
        const retried = value(await host.runCalendarAction(input));
        expect(retried).toMatchObject({ changed: true, taskId: input.requestId.toLowerCase(), next: { viewMode: 'day', selectedDate: '2026-10-31' }, scrollToMinutes: 8 * 60 });
        expect(recorder.log.map(([name]) => name)).toEqual(['addProject', 'addTask']);
        const saved = saveData.mock.lastCall?.[0] as { tasks: { id: string; title: string; dueDate?: string; startTime?: string; projectId?: string }[]; projects: { id: string; title: string }[] };
        const kitchen = saved.projects.filter((project) => project.title === 'Kitchen');
        expect(kitchen).toHaveLength(1);
        // The due date stays date-only; the start keeps its clock time.
        expect(saved.tasks.find((task) => task.id === input.requestId.toLowerCase())).toMatchObject({
            title: 'Buy paint', dueDate: '2026-11-02', startTime: new Date(2026, 9, 31, 8).toISOString(), projectId: kitchen[0].id,
        });
        // A lost reply repeats the request: no write, no save.
        const saves = saveData.mock.calls.length;
        expect(value(await host.runCalendarAction(input))).toEqual(retried);
        expect(saveData).toHaveBeenCalledTimes(saves);
        expect(await host.runCalendarAction({ ...input, action: { type: 'completeTask', taskId: 't-rent', taskRevision: sheetRevision(host, 't-rent') } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('retries a failed move exactly: one write', async () => {
        freezeClock();
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost(scenario(), saveData);
        const input = {
            requestId: generateUUID(), action: { type: 'moveTask' as const, taskId: 't-standup', day: '2026-10-28', startMinutes: 640, durationMinutes: 30, taskRevision: sheetRevision(host, 't-standup') }, calendar: ready,
        };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.runCalendarAction(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        saveData.mockResolvedValue(undefined);
        // The retry answers from its receipt, before any revision check: the move changed the task's revision.
        expect(value(await host.runCalendarAction(input))).toMatchObject({ changed: true });
        expect(recorder.log).toEqual([['updateTask', 't-standup', { startTime: '2026-10-28T14:40:00.000Z' }]]);
    });

    it('never acknowledges a composer project without its task, and a retry adds the task to that project', async () => {
        freezeClock();
        const { host, recorder } = await openHost();
        const opened = value(host.openCalendarComposer({ day: '2026-10-31', calendar: ready })).composer!;
        const composer = value(host.editCalendarComposer({ composer: opened.composer, edit: { type: 'title', title: 'Pick paint +Kitchen' }, calendar: ready }));
        const input = { requestId: generateUUID(), action: { type: 'saveComposer' as const, composer: composer.composer }, calendar: ready };
        const addTask = useTaskStore.getState().addTask;
        useTaskStore.setState({ addTask: async () => ({ success: false, error: 'Task store refused' }) });
        expect(await host.runCalendarAction(input)).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED', message: 'Task store refused' } });
        const kitchens = () => useTaskStore.getState()._allProjects.filter((project) => project.title === 'Kitchen');
        expect(kitchens()).toHaveLength(1);
        expect(useTaskStore.getState()._allTasks.some((task) => task.id === input.requestId.toLowerCase())).toBe(false);

        useTaskStore.setState({ addTask });
        expect(value(await host.runCalendarAction(input))).toMatchObject({ changed: true, taskId: input.requestId.toLowerCase() });
        expect(kitchens()).toHaveLength(1);
        expect(useTaskStore.getState()._tasksById.get(input.requestId.toLowerCase())).toMatchObject({ title: 'Pick paint', projectId: kitchens()[0].id });
        expect(recorder.log.map(([name]) => name)).toEqual(['addProject', 'addTask']);
    });

    it('names a composer\'s new project from the request: a replay after its task failed uses it, renamed since, and refuses it deleted', async () => {
        freezeClock();
        const { host } = await openHost();
        const save = (title: string, day: string) => {
            const opened = value(host.openCalendarComposer({ day, calendar: ready })).composer!;
            const composer = value(host.editCalendarComposer({ composer: opened.composer, edit: { type: 'title', title }, calendar: ready }));
            return { requestId: generateUUID(), action: { type: 'saveComposer' as const, composer: composer.composer }, calendar: ready };
        };
        const failTask = async (input: ReturnType<typeof save>) => {
            const addTask = useTaskStore.getState().addTask;
            useTaskStore.setState({ addTask: async () => ({ success: false, error: 'Task store refused' }) });
            expect(await host.runCalendarAction(input)).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
            useTaskStore.setState({ addTask });
        };
        const projectNamed = (title: string) => useTaskStore.getState()._allProjects.find((project) => project.title === title)!;
        const made = () => useTaskStore.getState()._allProjects
            .filter((project) => !fixture.projects.some((seeded) => seeded.id === project.id))
            .map((project) => [project.id, project.title, Boolean(project.deletedAt)]);

        const input = save('Pick paint +Kitchen', '2026-10-31');
        const taskId = input.requestId.toLowerCase();
        const projectId = requestRowId(input.requestId, 'project:kitchen');
        await failTask(input);
        await useTaskStore.getState().updateProject(projectNamed('Kitchen').id, { title: 'Paint' });
        const replay = await replayAfterRestart((restarted) => restarted.runCalendarAction(input));
        expect(replay.result).toMatchObject({ ok: true, value: { changed: true, taskId } });
        expect(made()).toEqual([[projectId, 'Paint', false]]);
        expect(useTaskStore.getState()._tasksById.get(taskId)).toMatchObject({ title: 'Pick paint', projectId });
        // Landed now: a later replay answers from the task in the renamed project.
        expect(await replayAfterRestart((restarted) => restarted.runCalendarAction(input)))
            .toMatchObject({ result: { ok: true, value: { changed: false, taskId } }, wrote: false });

        // A project deleted since is not made again: refused, and nothing is written.
        const other = save('Hang shelf +Garage', '2026-10-30');
        await failTask(other);
        await useTaskStore.getState().deleteProject(projectNamed('Garage').id);
        const gone = await replayAfterRestart((restarted) => restarted.runCalendarAction(other));
        expect(gone).toMatchObject({ result: { ok: false, error: { code: 'STALE_REVISION' } }, wrote: false });
        expect(made()).toEqual([[projectId, 'Paint', false], [requestRowId(other.requestId, 'project:garage'), 'Garage', true]]);
        expect(useTaskStore.getState()._tasksById.has(other.requestId.toLowerCase())).toBe(false);
    });

    it('a replay takes the composer\'s own project, renamed since, over a project given its old name since', async () => {
        freezeClock();
        const { host } = await openHost();
        const opened = value(host.openCalendarComposer({ day: '2026-10-31', calendar: ready })).composer!;
        const composer = value(host.editCalendarComposer({ composer: opened.composer, edit: { type: 'title', title: 'Pick paint +Kitchen' }, calendar: ready }));
        const input = { requestId: generateUUID(), action: { type: 'saveComposer' as const, composer: composer.composer }, calendar: ready };
        const projectId = requestRowId(input.requestId, 'project:kitchen');
        const addTask = useTaskStore.getState().addTask;
        useTaskStore.setState({ addTask: async () => ({ success: false, error: 'Task store refused' }) });
        expect(await host.runCalendarAction(input)).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        useTaskStore.setState({ addTask });
        await useTaskStore.getState().updateProject(projectId, { title: 'Paint' });
        const newer = await useTaskStore.getState().addProject('Kitchen', '#94a3b8');
        const replay = await replayAfterRestart((restarted) => restarted.runCalendarAction(input));
        expect(replay.result).toMatchObject({ ok: true, value: { changed: true } });
        expect(useTaskStore.getState()._tasksById.get(input.requestId.toLowerCase())?.projectId).toBe(projectId);
        expect(useTaskStore.getState()._tasksById.get(input.requestId.toLowerCase())?.projectId).not.toBe(newer!.id);
    });

    it('lets a move that owes its save finish even when its slot is taken since', async () => {
        freezeClock();
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost(scenario(), saveData);
        const move = { type: 'moveTask' as const, taskId: 't-standup', day: '2026-10-28', startMinutes: 640, durationMinutes: 30, taskRevision: sheetRevision(host, 't-standup') };
        const input = { requestId: generateUUID(), action: move, calendar: ready };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.runCalendarAction(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        // Another task now sits in that slot: a new request there is a conflict.
        await useTaskStore.getState().updateTask('t-rent', { startTime: '2026-10-28T14:40:00.000Z', timeEstimate: '1hr' });
        expect(value(await host.runCalendarAction({ requestId: generateUUID(), action: { ...move, taskId: 't-plan', taskRevision: sheetRevision(host, 't-plan') }, calendar: ready })))
            .toMatchObject({ changed: false, toast: { title: 'Time conflict' } });
        saveData.mockResolvedValue(undefined);
        // The first request only saves.
        expect(value(await host.runCalendarAction(input))).toMatchObject({ changed: true });
        expect(recorder.log.filter(([name, id]) => name === 'updateTask' && id === 't-standup')).toHaveLength(1);
        const saved = saveData.mock.lastCall?.[0] as { tasks: { id: string; startTime?: string }[] };
        expect(saved.tasks.find((task) => task.id === 't-standup')?.startTime).toBe('2026-10-28T14:40:00.000Z');
    });

    it('refuses a replayed request ID whose task is not what the request writes', async () => {
        freezeClock();
        const { host, recorder } = await openHost();
        const eventRequest = generateUUID();
        value(await host.runCalendarAction({ requestId: eventRequest, action: { type: 'createTaskFromEvent', event: fixture.calendarEvents[0] }, calendar: ready }));
        const opened = value(host.openCalendarComposer({ at: new Date(2026, 9, 28, 5).toISOString(), calendar: ready })).composer!;
        const titled = value(host.editCalendarComposer({ composer: opened.composer, edit: { type: 'title', title: 'Early call' }, calendar: ready }));
        const composerRequest = generateUUID();
        value(await host.runCalendarAction({ requestId: composerRequest, action: { type: 'saveComposer', composer: titled.composer }, calendar: ready }));
        const writes = recorder.log.length;

        const restarted = createNativeHostContract();
        expect(await restarted.setLanguage({ storedLanguage: 'en', systemLocale: fixture.deviceLocale })).toMatchObject({ ok: true });
        expect(await restarted.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        // Same ID and title, another start: not the task this ID made.
        const later = { ...fixture.calendarEvents[0], start: '2026-10-29T13:15:00.000Z', end: '2026-10-29T14:00:00.000Z' };
        expect(await restarted.runCalendarAction({ requestId: eventRequest, action: { type: 'createTaskFromEvent', event: later }, calendar: ready }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const sixOClock = value(restarted.editCalendarComposer({ composer: titled.composer, edit: { type: 'startTime', value: '06:00' }, calendar: ready }));
        expect(await restarted.runCalendarAction({ requestId: composerRequest, action: { type: 'saveComposer', composer: sixOClock.composer }, calendar: ready }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        // The same requests replay as written.
        expect(value(await restarted.runCalendarAction({ requestId: eventRequest, action: { type: 'createTaskFromEvent', event: fixture.calendarEvents[0] }, calendar: ready })))
            .toMatchObject({ changed: false, taskId: eventRequest.toLowerCase() });
        expect(recorder.log).toHaveLength(writes);
    });

    it('refuses what the screen refuses without writing, and leaves the request ID free', async () => {
        freezeClock();
        const { host, recorder } = await openHost();
        // As the journaling Android host: each write must carry its replay tokens.
        setNativeReplayTokens('required');
        const requestId = generateUUID();
        // Onto Deep work: the time-conflict toast.
        const conflict = value(await host.runCalendarAction({
            requestId, action: { type: 'moveTask', taskId: 't-standup', day: '2026-10-28', startMinutes: 855, durationMinutes: 30, taskRevision: sheetRevision(host, 't-standup') }, calendar: ready,
        }));
        expect(conflict).toMatchObject({ changed: false, toast: { tone: 'warning', title: 'Time conflict' } });
        // A date command the parser cannot read: the composer shows the error.
        const composer = value(host.openCalendarComposer({ day: '2026-10-29', calendar: ready })).composer!;
        const titled = value(host.editCalendarComposer({ composer: composer.composer, edit: { type: 'title', title: 'Lunch /due:someday' }, calendar: ready }));
        const refused = value(await host.runCalendarAction({ requestId, action: { type: 'saveComposer', composer: titled.composer }, calendar: ready }));
        expect(refused.composer?.error).toBe('Invalid date command: /due:someday');
        expect(recorder.log).toEqual([]);
        expect(value(await host.runCalendarAction({ requestId, action: { type: 'completeTask', taskId: 't-rent', taskRevision: sheetRevision(host, 't-rent') }, calendar: ready }))).toMatchObject({ changed: true });
        // A projected occurrence cannot change.
        const week = value(host.getCalendarView({ state: { viewMode: 'week', selectedDate: '2026-10-28', visibleMonth: '2026-10-28' }, calendar: ready, ...page }));
        const projected = items(week, 'allDay').find((item) => item.projected)!;
        expect(projected.pressable).toBe(false);
        expect(await host.runCalendarAction({ requestId: generateUUID(), action: { type: 'completeTask', taskId: projected.taskId!, taskRevision: projected.row!.taskRevision }, calendar: ready }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        // A move, Remove from calendar, Done and Delete carry the revision the view showed.
        for (const action of [
            { type: 'moveTask', taskId: 't-standup', day: '2026-10-28', startMinutes: 640, durationMinutes: 30 },
            { type: 'unscheduleTask', taskId: 't-plan' },
            { type: 'completeTask', taskId: 't-review', taskRevision: '' },
            { type: 'deleteTask', taskId: 't-review', taskRevision: 7 },
        ]) {
            expect(await host.runCalendarAction({ requestId: generateUUID(), action: action as never, calendar: ready }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        // A composer from before this contract carried a task revision is refused.
        const { taskRevision: _dropped, ...older } = titled.composer;
        expect(await host.runCalendarAction({ requestId: generateUUID(), action: { type: 'saveComposer', composer: older as never }, calendar: ready }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(value(host.getCalendarItemSheet({ taskId: projected.taskId!, state: week.state, calendar: ready }))).toMatchObject({ kind: 'projected', buttons: [{ id: 'ok' }] });
        const schedule = value(host.openCalendarComposer({ scheduleTaskId: 'n-email', day: '2026-10-28', calendar: ready }));
        expect(schedule.composer?.composer).toMatchObject({ mode: 'existing', selectedTaskId: 'n-email', startTimeValue: '10:00', taskRevision: storeRevision('n-email') });
        expect(schedule.composer?.timeLabels.start).toBe('10:00 AM');
    });

    it('writes nothing when a request that already landed is replayed after a restart', async () => {
        freezeClock();
        const { host, recorder } = await openHost();
        const composer = value(host.openCalendarComposer({ at: new Date(2026, 9, 28, 5).toISOString(), calendar: ready })).composer!;
        const titled = value(host.editCalendarComposer({ composer: composer.composer, edit: { type: 'title', title: 'Early call' }, calendar: ready }));
        const actions: [string, unknown][] = [
            [generateUUID(), { type: 'saveComposer', composer: titled.composer }],
            [generateUUID(), { type: 'moveTask', taskId: 't-standup', day: '2026-10-28', startMinutes: 640, durationMinutes: 30, taskRevision: sheetRevision(host, 't-standup') }],
            [generateUUID(), { type: 'unscheduleTask', taskId: 't-plan', taskRevision: sheetRevision(host, 't-plan') }],
            [generateUUID(), { type: 'completeTask', taskId: 't-rent', taskRevision: sheetRevision(host, 't-rent') }],
            [generateUUID(), { type: 'deleteTask', taskId: 't-review', taskRevision: sheetRevision(host, 't-review') }],
            [generateUUID(), { type: 'createTaskFromEvent', event: fixture.calendarEvents[0] }],
            [generateUUID(), { type: 'setViewMode', viewMode: 'week' }],
            [generateUUID(), { type: 'setShowCompleted', on: true }],
            [generateUUID(), { type: 'setWeekVisibleDays', days: 7 }],
        ];
        const run = (target: typeof host, requestId: string, action: unknown) => target.runCalendarAction({ requestId, action: action as never, calendar: ready });
        for (const [requestId, action] of actions) expect(value(await run(host, requestId, action))).toMatchObject({ changed: true });
        const writes = recorder.log.length;
        expect(recorder.log.map(([name]) => name)).toEqual([
            'addTask', 'updateTask', 'updateTask', 'updateTask', 'deleteTask', 'addTask', 'updateSettings', 'updateSettings', 'updateSettings',
        ]);
        expect(recorder.log[5]).toEqual(['addTask', 'Team sync', {
            status: 'next', startTime: '2026-10-28T13:15:00.000Z', timeEstimate: 'custom:45', location: 'Room 4', description: 'Calendar: Work calendar',
        }]);
        // A new host has no receipts, as after a restart: every replay finds its target state.
        const restarted = createNativeHostContract();
        expect(await restarted.setLanguage({ storedLanguage: 'en', systemLocale: fixture.deviceLocale })).toMatchObject({ ok: true });
        expect(await restarted.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        for (const [requestId, action] of actions) expect(value(await run(restarted, requestId, action))).toMatchObject({ changed: false });
        expect(recorder.log).toHaveLength(writes);
    });

    it('refuses a move, Remove from calendar, Done, Delete or a scheduled existing task replayed after a restart once the task changed since', async () => {
        freezeClock();
        const { host } = await openHost();
        // The timeline row, the item sheet and the composer carry the revision the host sends back.
        const day = value(host.getCalendarView({ state: { ...week, viewMode: 'day' }, calendar: ready, ...page }));
        const standup = items(day, 'timed').find((item) => item.taskId === 't-standup')!.row!.taskRevision;
        expect([standup, sheetRevision(host, 't-plan')]).toEqual([storeRevision('t-standup'), storeRevision('t-plan')]);
        const scheduling = value(host.openCalendarComposer({ scheduleTaskId: 'n-email', day: '2026-10-28', calendar: ready })).composer!;
        expect(scheduling.composer.taskRevision).toBe(storeRevision('n-email'));
        // Choosing a task in the composer takes its revision; a new search drops it with the choice.
        const existing = value(host.openCalendarComposer({ at: new Date(2026, 9, 31, 8).toISOString(), mode: 'existing', calendar: ready })).composer!;
        expect(existing.composer.taskRevision).toBeNull();
        const chosen = value(host.editCalendarComposer({ composer: existing.composer, edit: { type: 'selectTask', taskId: 'n-plumber' }, calendar: ready }));
        expect(chosen.composer.taskRevision).toBe(storeRevision('n-plumber'));
        expect(value(host.editCalendarComposer({ composer: chosen.composer, edit: { type: 'query', query: 'pack' }, calendar: ready })).composer.taskRevision).toBeNull();

        const later = '2026-10-28T20:00:00.000Z';
        const requests: [Record<string, unknown>, () => Promise<unknown>, () => unknown][] = [
            [{ type: 'moveTask', taskId: 't-standup', day: '2026-10-28', startMinutes: 640, durationMinutes: 30, taskRevision: standup },
                () => useTaskStore.getState().updateTask('t-standup', { startTime: later }), () => useTaskStore.getState()._tasksById.get('t-standup')?.startTime],
            [{ type: 'unscheduleTask', taskId: 't-plan', taskRevision: sheetRevision(host, 't-plan') },
                () => useTaskStore.getState().updateTask('t-plan', { startTime: '2026-10-29' }), () => useTaskStore.getState()._tasksById.get('t-plan')?.startTime],
            [{ type: 'completeTask', taskId: 't-rent', taskRevision: sheetRevision(host, 't-rent') },
                () => useTaskStore.getState().updateTask('t-rent', { status: 'next' }), () => useTaskStore.getState()._tasksById.get('t-rent')?.status],
            [{ type: 'deleteTask', taskId: 't-review', taskRevision: sheetRevision(host, 't-review') },
                () => useTaskStore.getState().restoreTask('t-review'), () => useTaskStore.getState()._tasksById.get('t-review')?.deletedAt ?? null],
            [{ type: 'saveComposer', composer: scheduling.composer },
                () => useTaskStore.getState().updateTask('n-email', { startTime: later }), () => useTaskStore.getState()._tasksById.get('n-email')?.startTime],
        ];
        for (const [action, change, read] of requests) {
            const input = { requestId: generateUUID(), action: action as never, calendar: ready };
            expect(value(await host.runCalendarAction(input))).toMatchObject({ changed: true });
            await change();
            const kept = read();
            const { result, wrote } = await replayAfterRestart((restarted) => restarted.runCalendarAction(input));
            expect(result).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(wrote).toBe(false);
            expect(read()).toEqual(kept);
        }
    });

    it('answers a composer task, an event task and the view settings replayed after a restart, and keeps a later change', async () => {
        freezeClock();
        const { host } = await openHost();
        const opened = value(host.openCalendarComposer({ at: new Date(2026, 9, 28, 5).toISOString(), calendar: ready })).composer!;
        const titled = value(host.editCalendarComposer({ composer: opened.composer, edit: { type: 'title', title: 'Early call' }, calendar: ready }));
        // A created task edited since is not what the request writes: refused, nothing written.
        for (const action of [{ type: 'saveComposer', composer: titled.composer }, { type: 'createTaskFromEvent', event: fixture.calendarEvents[0] }]) {
            const input = { requestId: generateUUID(), action: action as never, calendar: ready };
            const taskId = input.requestId.toLowerCase();
            expect(value(await host.runCalendarAction(input))).toMatchObject({ changed: true, taskId });
            await useTaskStore.getState().updateTask(taskId, { title: 'Renamed since' });
            const { result, wrote } = await replayAfterRestart((restarted) => restarted.runCalendarAction(input));
            expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(wrote).toBe(false);
            expect(useTaskStore.getState()._tasksById.get(taskId)?.title).toBe('Renamed since');
        }
        // A setting is target-state: its replay writes nothing and keeps another calendar setting changed since.
        const settings: [Record<string, unknown>, Record<string, unknown>][] = [
            [{ type: 'setViewMode', viewMode: 'week' }, { weekVisibleDays: 3 }],
            [{ type: 'setShowCompleted', on: true }, { viewMode: 'day' }],
            [{ type: 'setWeekVisibleDays', days: 7 }, { showCompleted: false }],
        ];
        for (const [action, change] of settings) {
            const input = { requestId: generateUUID(), action: action as never, calendar: ready };
            expect(value(await host.runCalendarAction(input))).toMatchObject({ changed: true });
            await useTaskStore.getState().updateSettings({ calendar: { ...useTaskStore.getState().settings.calendar, ...change } });
            const kept = useTaskStore.getState().settings.calendar;
            const { result, wrote } = await replayAfterRestart((restarted) => restarted.runCalendarAction(input));
            expect(result).toMatchObject({ ok: true, value: { changed: false } });
            expect(wrote).toBe(false);
            expect(useTaskStore.getState().settings.calendar).toEqual(kept);
        }
    });

    it('is NOT_READY until storage is activated', async () => {
        setStorageAdapter(noopStorage);
        const host = createNativeHostContract();
        const notReady = { ok: false, error: { code: 'NOT_READY' } };
        expect(host.getCalendarView({ offset: 0, limit: 1 })).toMatchObject(notReady);
        expect(host.getCalendarItemSheet({ taskId: 't-rent' })).toMatchObject(notReady);
        expect(host.openCalendarComposer({ day: '2026-10-28' })).toMatchObject(notReady);
        expect(host.editCalendarComposer({ composer: {} as never, edit: { type: 'title', title: 'x' } })).toMatchObject(notReady);
        expect(await host.runCalendarAction({ requestId: generateUUID(), action: { type: 'completeTask', taskId: 't-rent', taskRevision: 'r' } })).toMatchObject(notReady);
    });
});
