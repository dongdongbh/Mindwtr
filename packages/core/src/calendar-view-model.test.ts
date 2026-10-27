import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
    createCalendarRecorder,
    loadCalendarViewsFixture,
    projectCalendarObservations,
    replayCalendarScenario,
    seedCalendarStore,
} from './calendar-view-model.replay';
import {
    compactHourLabel,
    createCalendarLocaleDates,
    createCalendarPatternDates,
    getCalendarDayTimeline,
    getCalendarDayItems,
    getCalendarDetailsTaskRow,
    getCalendarMonthItemTitle,
    getCalendarWeekTimedEntries,
    isCalendarAllDayItem,
    isCalendarTimedItem,
    isCalendarSlotFree,
    indexCalendarDeadlineTasks,
    getCalendarWallMinutes,
    getCalendarMovedStart,
    getCalendarMonthCell,
    getCalendarMonthCellAccessibilityLabel,
    CALENDAR_DAY_ALL_DAY_ITEMS,
    formatCalendarAllDayMore,
    getCalendarAllDayLane,
    getCalendarDayAllDayTones,
    getCalendarWeekAllDayTones,
    planCalendarTaskMove,
    indexCalendarScheduledTasks,
    calendarDateKey,
    isAllDayScheduledTask,
    isTimedScheduledTask,
    moveCalendarPeriod,
    getCalendarVisibleRange,
    getCalendarWeekStart,
} from './calendar-view-model';
import { configureDateFormatting, createDateFormatter } from './date';
import { getCalendarTimedDeadlines } from './calendar-day-items';
import { createNativeHostContract } from './native-host-contract';
import { resetForTests } from './store';
import type { Task } from './types';

const fixture = loadCalendarViewsFixture();

describe('calendar views parity with the frozen React Native fixture', () => {
    const originalTz = process.env.TZ;
    beforeAll(() => {
        process.env.TZ = fixture.timeZone;
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(fixture.now));
    });
    afterAll(() => {
        vi.useRealTimers();
        configureDateFormatting();
        resetForTests();
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });

    it('was captured from React Native before the screen changed', () => {
        expect(fixture.provenance.capturedAt).toMatch(/^[0-9a-f]{40}$/);
        expect(fixture.scenarios.length).toBe(Object.keys(fixture.observations).length);
    });

    for (const scenario of fixture.scenarios) {
        it(`the native host contract reproduces "${scenario.name}"`, async () => {
            const recorder = createCalendarRecorder();
            await seedCalendarStore(fixture, scenario, recorder);
            const contract = createNativeHostContract();
            expect((await contract.setLanguage({ storedLanguage: 'en', systemLocale: fixture.deviceLocale })).ok).toBe(true);
            expect((await contract.activate({ writeSafetyReady: true })).ok).toBe(true);
            recorder.log.splice(0);
            const observed = await replayCalendarScenario({ fixture, scenario, recorder, contract });
            const initial = fixture.settings[scenario.settings].calendar;
            expect(projectCalendarObservations(observed.map((entry) => ({ ...entry, styles: null })), initial))
                .toEqual(projectCalendarObservations(fixture.observations[scenario.name], initial));
        });
    }
});

const task = (overrides: Partial<Task>): Task => ({
    id: overrides.id ?? 'task-1',
    title: overrides.title ?? 'Task',
    status: overrides.status ?? 'next',
    contexts: [],
    tags: [],
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
});

describe('calendar view model', () => {
    const deadlineTextOptions = {
        t: (key: string) => ({ 'calendar.due': 'Due', 'calendar.deadline': 'Deadline', 'calendar.allDay': 'All day' }[key] ?? key),
        formatDate: createDateFormatter({ language: 'en', dateFormat: 'mdy', systemLocale: 'en-US' }),
        projectedLabel: 'Projected',
        timeEstimateToMinutes: () => 30,
    };

    it('keeps timed deadlines out of all-day and duration layouts, even with Starts off', () => {
        const both = task({ startTime: '2026-05-04T08:00:00', dueDate: '2026-05-04T17:00:00' });
        const lists = { scheduled: [both], deadlines: [both], events: [], completed: [] };
        const items = getCalendarDayItems(lists, { preserveTimedDeadlines: true });
        expect(items).toHaveLength(2);
        expect(items.filter(isCalendarAllDayItem)).toEqual([]);
        expect(items.filter(isCalendarTimedItem).map((item) => item.kind)).toEqual(['scheduled']);
        const startsOffItems = getCalendarDayItems({ ...lists, scheduled: [] }, { preserveTimedDeadlines: true });
        const bounds = { dayStart: new Date(2026, 4, 4), dayEnd: new Date(2026, 4, 5) };
        expect(getCalendarWeekTimedEntries({ items: startsOffItems, ...bounds, ...deadlineTextOptions })).toEqual([]);
        expect(getCalendarTimedDeadlines(lists.deadlines).map((marker) => marker.task.id)).toEqual([both.id]);
        const dateOnly = getCalendarDayItems({ ...lists, scheduled: [], deadlines: [{ ...both, dueDate: '2026-05-04' }] });
        expect(dateOnly.filter(isCalendarAllDayItem)).toHaveLength(1);
    });

    it('does not reserve free time or mutate a due-only task with an estimate', () => {
        const due = task({ dueDate: '2026-05-04T17:00:00', timeEstimate: '2h' });
        const before = JSON.stringify(due);
        getCalendarTimedDeadlines([due]);
        expect(isCalendarSlotFree(new Date(2026, 4, 4), new Date(2026, 4, 4, 17), 60, { tasks: [due], events: [], timeEstimatesEnabled: true })).toBe(true);
        expect(JSON.stringify(due)).toBe(before);
    });

    it('adds exact due time to one compact month row and its same-day scheduled details', () => {
        const both = task({ title: 'Finish report', startTime: '2026-05-04T08:00:00', dueDate: '2026-05-04T17:00:00' });
        const [item] = getCalendarDayItems({ scheduled: [both], deadlines: [both], events: [], completed: [] });
        expect(getCalendarMonthItemTitle(item, new Date(2026, 4, 4), deadlineTextOptions)).toBe('5:00 PM · Due · Finish report');
        const longTitle = { ...item, title: 'A long task title that a compact month cell will truncate' };
        expect(getCalendarMonthItemTitle(longTitle, new Date(2026, 4, 4), deadlineTextOptions).startsWith('5:00 PM · Due · ')).toBe(true);
        expect(getCalendarMonthItemTitle(item, new Date(2026, 4, 3), deadlineTextOptions)).toBe('Finish report');
        expect(getCalendarMonthItemTitle({ ...item, task: { ...both, dueDate: '2026-05-04' } }, new Date(2026, 4, 4), deadlineTextOptions)).toBe('Finish report');
        expect(getCalendarDetailsTaskRow(both, 'scheduled', deadlineTextOptions).detail).toBe('8:00 AM-8:30 AM · Due 5:00 PM');
        expect(getCalendarDetailsTaskRow(both, 'deadline', deadlineTextOptions).detail).toBe('Due 5:00 PM');
        expect(getCalendarDetailsTaskRow({ ...both, dueDate: '2026-05-05T17:00:00' }, 'scheduled', deadlineTextOptions).detail).toBe('8:00 AM-8:30 AM');
        expect(getCalendarDetailsTaskRow({ ...both, dueDate: '2026-05-04' }, 'deadline', deadlineTextOptions).detail).toBe('Deadline');
    });

    it.each(['2026-03-08T07:30:00.000Z', '2026-11-01T06:30:00.000Z'])('uses due local clock and day on DST instant %s', (dueDate) => {
        const previous = process.env.TZ;
        process.env.TZ = 'America/New_York';
        try {
            const due = task({ dueDate });
            const [marker] = getCalendarTimedDeadlines([due]);
            expect(marker.start.getTime()).toBe(new Date(dueDate).getTime());
            expect(getCalendarWallMinutes(new Date(marker.start.getFullYear(), marker.start.getMonth(), marker.start.getDate()), marker.start))
                .toBe(dueDate.includes('03-08') ? 210 : 90);
            expect(indexCalendarDeadlineTasks([due]).get(calendarDateKey(marker.start))).toEqual([due]);
        } finally {
            if (previous === undefined) delete process.env.TZ;
            else process.env.TZ = previous;
        }
    });

    it.each([[2026, 2, 8], [2026, 10, 1]])('keeps a drawn block at 10:00 when dropped in place on %i-%i-%i', (year, month, day) => {
        const start = new Date(year, month, day, 10);
        const dayStart = new Date(year, month, day);
        const timeline = getCalendarDayTimeline({ events: [], tasks: [task({ startTime: start.toISOString() })], dayStart, dayEnd: new Date(year, month, day + 1), timeEstimateToMinutes: () => 30, formatDate: createDateFormatter({}), projectedLabel: 'Projected' });
        expect(getCalendarWallMinutes(dayStart, timeline.tasks[0].displayStart)).toBe(600);
        expect(getCalendarMovedStart(dayStart.getTime(), getCalendarWallMinutes(dayStart, timeline.tasks[0].displayStart)).getTime()).toBe(start.getTime());
        expect(getCalendarMovedStart(dayStart.getTime(), 8 * 60).getHours()).toBe(8);
    });
    it('keeps the second 1:30 AM instant when dropped in place on the fall DST day', () => {
        // Pinned: CI runs in UTC, which has no DST day.
        const previous = process.env.TZ;
        process.env.TZ = 'America/New_York';
        try {
            const dayStart = new Date(2026, 10, 1);
            const later = new Date('2026-11-01T06:30:00.000Z');
            const minute = getCalendarWallMinutes(dayStart, later);
            expect(minute).toBe(90);
            expect(getCalendarMovedStart(dayStart.getTime(), minute, later).getTime()).toBe(later.getTime());
            expect(planCalendarTaskMove({ taskId: 'task-1', dayStartMs: dayStart.getTime(), startMinutes: minute, durationMinutes: 30, currentStart: later, isSlotFree: () => false })).toEqual({ kind: 'move', updates: { startTime: later.toISOString() } });
        } finally {
            if (previous === undefined) delete process.env.TZ;
            else process.env.TZ = previous;
        }
    });
    it('indexes date-only start dates on their local calendar day', () => {
        const dateOnly = task({ id: 'date-only', startTime: '2026-04-20' });
        const timed = task({ id: 'timed', startTime: '2026-04-20T09:00:00' });
        const grouped = indexCalendarScheduledTasks([dateOnly, timed]);
        expect(grouped.get(calendarDateKey(new Date(2026, 3, 20)))?.map((item) => item.id)).toEqual(['date-only', 'timed']);
        expect(isAllDayScheduledTask(dateOnly)).toBe(true);
        expect(isTimedScheduledTask(dateOnly)).toBe(false);
        expect(isTimedScheduledTask(timed)).toBe(true);
    });

    it('drops the empty minutes of an hour label only when a meridiem keeps it long', () => {
        expect(compactHourLabel('10:00 AM')).toBe('10 AM');
        expect(compactHourLabel('12:00 PM')).toBe('12 PM');
        expect(compactHourLabel('10.00 a.m.')).toBe('10 a.m.');
        expect(compactHourLabel('午前10:00')).toBe('午前10');
        expect(compactHourLabel('13:00')).toBe('13:00');
    });

    it('moves a week across the daylight-saving change and the year by calendar days', () => {
        const originalTz = process.env.TZ;
        process.env.TZ = 'America/New_York';
        try {
            const week = { viewMode: 'week' as const, selectedDate: new Date(2026, 9, 28), visibleMonthDate: new Date(2026, 9, 28) };
            const next = moveCalendarPeriod(week, 'next', { calendarSystem: 'gregorian' });
            expect(next.selectedDate?.getDate()).toBe(4);
            expect(next.selectedDate?.getHours()).toBe(0);
            const start = getCalendarWeekStart(next.selectedDate!, 0);
            const range = getCalendarVisibleRange({ calendarSystem: 'gregorian', currentMonthDate: new Date(2026, 10, 1), selectedDate: next.selectedDate, viewMode: 'week', weekStartTime: start.getTime() });
            // Nov 1 starts in daylight time (UTC-4) and the week ends in standard time (UTC-5).
            expect([range.rangeStart.toISOString(), range.rangeEnd.toISOString()]).toEqual(['2026-11-01T04:00:00.000Z', '2026-11-08T04:59:59.999Z']);
            const day = moveCalendarPeriod({ viewMode: 'day', selectedDate: new Date(2026, 11, 31), visibleMonthDate: new Date(2026, 11, 31) }, 'next', { calendarSystem: 'gregorian' });
            expect([day.selectedDate?.getFullYear(), day.visibleMonthDate.getMonth()]).toEqual([2027, 0]);
            const month = moveCalendarPeriod({ viewMode: 'month', selectedDate: null, visibleMonthDate: new Date(2026, 11, 15) }, 'next', { calendarSystem: 'gregorian' });
            expect([month.visibleMonthDate.getFullYear(), month.visibleMonthDate.getMonth(), month.visibleMonthDate.getDate(), month.selectedDate]).toEqual([2027, 0, 1, null]);
        } finally {
            if (originalTz === undefined) delete process.env.TZ;
            else process.env.TZ = originalTz;
        }
    });

    it('hides a month cell\'s previews from six items on and shows its counts', () => {
        const tasks = Array.from({ length: 6 }, (_, index) => task({ id: `t${index}`, title: `T${index}`, dueDate: '2026-10-30' }));
        const lists = { scheduled: [], deadlines: tasks, completed: [], events: [] };
        const cell = getCalendarMonthCell(new Date(2026, 9, 30), lists, { dates: createCalendarLocaleDates('en-US'), t: (key) => (key === 'common.tasks' ? 'tasks' : key) });
        expect(cell.previewItems).toEqual([]);
        expect(cell).toMatchObject({ showCounts: true, taskCount: 6, eventCount: 0, accessibilityLabel: 'Friday, October 30. 6 tasks' });
        const two = getCalendarMonthCell(new Date(2026, 9, 30), { ...lists, deadlines: tasks.slice(0, 2) }, { dates: createCalendarLocaleDates('en-US'), t: (key) => key });
        expect([two.previewItems.length, two.showCounts]).toEqual([2, false]);
    });

    it('draws a completed all-day item crossed out and muted in the day and week lanes (#1462)', () => {
        const open = task({ id: 'open', title: 'Open', dueDate: '2026-10-30' });
        const done = task({ id: 'done', title: 'Done', status: 'done', completedAt: '2026-10-30T15:00:00.000Z' });
        const items = getCalendarDayItems({ scheduled: [], deadlines: [open], completed: [done], events: [] });
        const completed = items.find((item) => item.kind === 'completed')!;
        const deadline = items.find((item) => item.kind === 'deadline')!;
        for (const tones of [getCalendarWeekAllDayTones(completed), getCalendarDayAllDayTones(completed)]) {
            expect(tones).toMatchObject({ struck: true, text: 'secondary', fill: 'secondary', accent: 'secondary', disabled: true });
        }
        for (const tones of [getCalendarWeekAllDayTones(deadline), getCalendarDayAllDayTones(deadline)]) {
            expect(tones).toMatchObject({ struck: false, text: 'text', fill: 'input', accent: 'danger', disabled: false });
        }
    });

    it('caps an all-day lane and counts the rest for "+N more" (#1462)', () => {
        const deadlines = Array.from({ length: 6 }, (_, index) => task({ id: `t${index}`, title: `T${index}`, dueDate: '2026-10-30' }));
        const items = getCalendarDayItems({ scheduled: [], deadlines, completed: [], events: [] });
        const lane = getCalendarAllDayLane(items, CALENDAR_DAY_ALL_DAY_ITEMS);
        expect(lane.items.map((item) => item.title)).toEqual(['T0', 'T1', 'T2', 'T3']);
        expect(lane.hiddenCount).toBe(2);
        expect(formatCalendarAllDayMore(lane.hiddenCount, (key) => (key === 'calendar.more' ? 'more' : key))).toBe('+2 more');
        const expanded = getCalendarAllDayLane(items, CALENDAR_DAY_ALL_DAY_ITEMS, true);
        expect([expanded.items.length, expanded.hiddenCount]).toEqual([6, 2]);
        expect(getCalendarAllDayLane(items.slice(0, 4), CALENDAR_DAY_ALL_DAY_ITEMS).hiddenCount).toBe(0);
    });

    it('starts the weekday labels on Sunday after the time zone changes', () => {
        const originalTz = process.env.TZ;
        try {
            for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
                process.env.TZ = zone;
                expect(createCalendarPatternDates(createDateFormatter({ language: 'en', dateFormat: 'mdy', systemLocale: 'en-US' })).weekdays[0]).toBe('Sun');
            }
        } finally {
            if (originalTz === undefined) delete process.env.TZ;
            else process.env.TZ = originalTz;
        }
    });

    it('speaks singular and plural task and event counts', () => {
        const t = (key: string) => ({ 'list.countTaskSingular': 'task', 'common.tasks': 'tasks', 'calendar.eventSingular': 'event', 'calendar.eventPlural': 'events' }[key] ?? key);
        const options = { dates: createCalendarLocaleDates('en-US'), t };
        const date = new Date(2026, 9, 28);
        expect(getCalendarMonthCellAccessibilityLabel(date, { taskCount: 1, eventCount: 1 }, options)).toBe('Wednesday, October 28. 1 task. 1 event');
        expect(getCalendarMonthCellAccessibilityLabel(date, { taskCount: 2, eventCount: 2 }, options)).toBe('Wednesday, October 28. 2 tasks. 2 events');
    });

    it.each(['2026-03-08', '2026-11-01'])('moves to 08:00 wall-clock time on %s', (dayKey) => {
        const previous = process.env.TZ;
        process.env.TZ = 'America/New_York';
        try {
            const [year, month, day] = dayKey.split('-').map(Number);
            const midnight = new Date(year, month - 1, day);
            const plan = planCalendarTaskMove({ taskId: 'task-1', dayStartMs: midnight.getTime(), startMinutes: 480, durationMinutes: 30, isSlotFree: () => true });
            expect(plan.kind).toBe('move');
            if (plan.kind === 'move') expect(new Date(plan.updates.startTime!).getHours()).toBe(8);
        } finally {
            if (previous === undefined) delete process.env.TZ;
            else process.env.TZ = previous;
        }
    });

    it('builds the English headings from date-fns patterns as the React Native screen draws them', () => {
        const date = new Date(2026, 9, 28);
        const english = (dateFormat: string) => createCalendarPatternDates(createDateFormatter({ language: 'en', dateFormat, systemLocale: 'en-US' }));
        const styles = ['monthYear', 'monthDay', 'dayTitle', 'longDate', 'shortDate', 'cellDate'] as const;
        // What toLocaleDateString gives for en-US and en-GB (the fixture's ICU).
        expect(styles.map((style) => english('mdy')[style](date))).toEqual([
            'October 2026', 'Oct 28', 'Wed, October 28', 'Wednesday, October 28, 2026', 'Wed, Oct 28', 'Wednesday, October 28',
        ]);
        expect(styles.map((style) => english('dmy')[style](date))).toEqual([
            'October 2026', '28 Oct', 'Wed 28 October', 'Wednesday, 28 October 2026', 'Wed 28 Oct', 'Wednesday 28 October',
        ]);
        expect(english('mdy').weekdays).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
        expect(english('mdy').weekdays).toEqual(createCalendarLocaleDates('en-US').weekdays);
    });
});
