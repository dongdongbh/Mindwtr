import { act, renderHook } from '@testing-library/react';
import { type ExternalCalendarEvent, type Task } from '@mindwtr/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    useCalendarScheduleFeedback,
    useCalendarSelectedDay,
    type CalendarSelectedDayOptions,
    type CalendarScheduleFeedback,
} from './use-calendar-selected-day';

const SELECTED = new Date(2026, 3, 4);

const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: 'task-1',
    title: 'Task',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
});

const ENGLISH: Record<string, string> = {
    'calendar.noFreeTime': 'No free time on this day.',
    'calendar.overlapWarning': 'That time overlaps with an event.',
};

type Overrides = Partial<Omit<CalendarSelectedDayOptions, 'feedback'>>;

const renderSelectedDay = (overrides: Overrides = {}) => {
    const openTaskComposerAt = overrides.openTaskComposerAt ?? vi.fn();
    const updateTask = overrides.updateTask ?? vi.fn(async () => ({ success: true }));
    let feedback!: CalendarScheduleFeedback;
    const view = renderHook(() => {
        feedback = useCalendarScheduleFeedback();
        return useCalendarSelectedDay({
            feedback,
            findFreeSlotForDay: () => new Date(2026, 3, 4, 9, 0),
            getDeadlinesForDay: () => [],
            getExternalEventsForDay: () => [],
            getScheduledForDay: () => [],
            isSlotFreeForDay: () => true,
            openTaskComposerAt,
            resolveText: (_key, fallback) => fallback,
            schedulableTasks: [],
            selectedDate: SELECTED,
            t: (key) => ENGLISH[key] ?? key,
            tasks: [],
            timeEstimateToMinutes: () => 30,
            updateTask,
            ...overrides,
        });
    });
    return { ...view, getFeedback: () => feedback, openTaskComposerAt, updateTask };
};

describe('useCalendarSelectedDay', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 3, 3, 14, 48));
        return () => vi.useRealTimers();
    });

    it('offers no schedule candidates until the user types', () => {
        const tasks = [makeTask({ id: 'a', title: 'Write proposal' }), makeTask({ id: 'b', title: 'Book flights' })];
        const { result } = renderSelectedDay({ schedulableTasks: tasks });

        expect(result.current.scheduleCandidates).toHaveLength(0);

        act(() => result.current.updateScheduleQuery('write'));
        expect(result.current.scheduleCandidates.map((task) => task.id)).toEqual(['a']);
    });

    it('offers no candidates at all while no day is selected', () => {
        const tasks = [makeTask({ id: 'a', title: 'Write proposal' })];
        const { result } = renderSelectedDay({ schedulableTasks: tasks, selectedDate: null });

        act(() => result.current.updateScheduleQuery('write'));
        expect(result.current.scheduleCandidates).toHaveLength(0);
    });

    it('caps the candidate list at twelve', () => {
        const tasks = Array.from({ length: 20 }, (_, index) => makeTask({ id: `t-${index}`, title: `Task ${index}` }));
        const { result } = renderSelectedDay({ schedulableTasks: tasks });

        act(() => result.current.updateScheduleQuery('task'));
        expect(result.current.scheduleCandidates).toHaveLength(12);
    });

    it('sorts the day rows by start time, with a date-only due date at the end of its day', () => {
        const scheduled = [
            makeTask({ id: 'later', title: 'Later', startTime: '2026-04-04T15:00:00' }),
            makeTask({ id: 'earlier', title: 'Earlier', startTime: '2026-04-04T09:00:00' }),

            makeTask({ id: 'untimed', title: 'Zulu untimed', startTime: '2026-04-04' }),
        ];
        const deadlines = [
            makeTask({ id: 'later', title: 'Later', dueDate: '2026-04-04' }),

            makeTask({ id: 'due', title: 'Alpha due', dueDate: '2026-04-04' }),
        ];
        const { result } = renderSelectedDay({
            getScheduledForDay: () => scheduled,
            getDeadlinesForDay: () => deadlines,
        });

        expect(result.current.selectedTaskRows.map((row) => row.id)).toEqual([
            'scheduled-untimed',
            'scheduled-earlier',
            'scheduled-later',
            'deadline-due',
        ]);


        expect(result.current.selectedTaskRows.filter((row) => row.task.id === 'later')).toHaveLength(1);
    });

    it('breaks a same-time tie by title', () => {
        const scheduled = [
            makeTask({ id: 'zulu', title: 'Zulu', startTime: '2026-04-04T09:00:00' }),
            makeTask({ id: 'alpha', title: 'Alpha', startTime: '2026-04-04T09:00:00' }),
        ];
        const { result } = renderSelectedDay({ getScheduledForDay: () => scheduled });

        expect(result.current.selectedTaskRows.map((row) => row.task.id)).toEqual(['alpha', 'zulu']);
    });

    it('splits the day events into all-day and timed', () => {
        const events: ExternalCalendarEvent[] = [
            { id: 'e1', sourceId: 'work', title: 'Standup', start: '2026-04-04T09:00:00', end: '2026-04-04T09:15:00', allDay: false },
            { id: 'e2', sourceId: 'work', title: 'Holiday', start: '2026-04-04T00:00:00', end: '2026-04-05T00:00:00', allDay: true },
        ];
        const { result } = renderSelectedDay({ getExternalEventsForDay: () => events });

        expect(result.current.selectedExternalEvents).toHaveLength(2);
        expect(result.current.selectedAllDayEvents.map((event) => event.id)).toEqual(['e2']);
        expect(result.current.selectedTimedEvents.map((event) => event.id)).toEqual(['e1']);
    });

    it('opens the composer at the free slot it found for the task', () => {
        const task = makeTask({ id: 'task-plan', title: 'Draft planning memo' });
        const { result, openTaskComposerAt } = renderSelectedDay({ tasks: [task] });

        act(() => result.current.scheduleTaskOnSelectedDate('task-plan'));

        expect(openTaskComposerAt).toHaveBeenCalledWith(
            new Date(2026, 3, 4, 9, 0),
            { mode: 'existing', taskId: 'task-plan' },
        );
        expect(result.current.scheduleError).toBeNull();
    });

    it('reports a full day instead of opening the composer', () => {
        const task = makeTask({ id: 'task-plan' });
        const { result, openTaskComposerAt } = renderSelectedDay({
            tasks: [task],
            findFreeSlotForDay: () => null,
        });

        act(() => result.current.scheduleTaskOnSelectedDate('task-plan'));

        expect(openTaskComposerAt).not.toHaveBeenCalled();
        expect(result.current.scheduleError).toBe('No free time on this day.');
    });

    it('asks for a day before planning, and schedules once one is selected', () => {
        const task = makeTask({ id: 'task-plan' });
        const withoutDay = renderSelectedDay({ tasks: [task], selectedDate: null });

        act(() => withoutDay.result.current.schedulePlanningTask('task-plan'));
        expect(withoutDay.openTaskComposerAt).not.toHaveBeenCalled();
        expect(withoutDay.result.current.scheduleError).toBe('Select a day to plan first.');

        const withDay = renderSelectedDay({ tasks: [task] });
        act(() => withDay.result.current.schedulePlanningTask('task-plan'));
        expect(withDay.openTaskComposerAt).toHaveBeenCalled();
    });

    it('edits a scheduled time, keeping the selected day and clearing the editor', async () => {
        const task = makeTask({ id: 'task-timed', startTime: '2026-04-04T09:00:00' });
        const { result, updateTask } = renderSelectedDay({ tasks: [task] });

        act(() => result.current.beginEditScheduledTime('task-timed'));
        expect(result.current.editingTimeTaskId).toBe('task-timed');
        expect(result.current.editingTimeValue).toBe('09:00');

        act(() => result.current.updateEditingTimeValue('11:30'));
        await act(async () => { await result.current.commitEditScheduledTime(); });

        expect(updateTask).toHaveBeenCalledWith('task-timed', {
            startTime: new Date(2026, 3, 4, 11, 30).toISOString(),
        });
        expect(result.current.editingTimeTaskId).toBeNull();
        expect(result.current.editingTimeValue).toBe('');
    });

    it('refuses an overlapping time and keeps the editor open on the old value', async () => {
        const task = makeTask({ id: 'task-timed', startTime: '2026-04-04T09:00:00' });
        const { result, updateTask } = renderSelectedDay({ tasks: [task], isSlotFreeForDay: () => false });

        act(() => result.current.beginEditScheduledTime('task-timed'));
        act(() => result.current.updateEditingTimeValue('11:30'));
        await act(async () => { await result.current.commitEditScheduledTime(); });

        expect(updateTask).not.toHaveBeenCalled();
        expect(result.current.scheduleError).toBe('That time overlaps with an event.');
        expect(result.current.editingTimeTaskId).toBe('task-timed');
    });

    it('ignores an unparseable time instead of writing NaN', async () => {
        const task = makeTask({ id: 'task-timed', startTime: '2026-04-04T09:00:00' });
        const { result, updateTask } = renderSelectedDay({ tasks: [task] });

        act(() => result.current.beginEditScheduledTime('task-timed'));
        act(() => result.current.updateEditingTimeValue('not-a-time'));
        await act(async () => { await result.current.commitEditScheduledTime(); });

        expect(updateTask).not.toHaveBeenCalled();
    });

    it('never opens the time editor for a task with no start time', () => {
        const { result } = renderSelectedDay({ tasks: [makeTask({ id: 'task-undated' })] });

        act(() => result.current.beginEditScheduledTime('task-undated'));

        expect(result.current.editingTimeTaskId).toBeNull();
    });

    it('cancels an edit without writing', () => {
        const task = makeTask({ id: 'task-timed', startTime: '2026-04-04T09:00:00' });
        const { result, updateTask } = renderSelectedDay({ tasks: [task] });

        act(() => result.current.beginEditScheduledTime('task-timed'));
        act(() => result.current.cancelEditScheduledTime());

        expect(result.current.editingTimeTaskId).toBeNull();
        expect(updateTask).not.toHaveBeenCalled();
    });

    it('clears the stale error as soon as the search changes', () => {
        const { result, getFeedback } = renderSelectedDay({ tasks: [makeTask({ id: 'task-plan' })], findFreeSlotForDay: () => null });

        act(() => result.current.scheduleTaskOnSelectedDate('task-plan'));
        expect(result.current.scheduleError).toBe('No free time on this day.');

        act(() => result.current.updateScheduleQuery('draft'));
        expect(result.current.scheduleError).toBeNull();
        expect(result.current.scheduleQuery).toBe('draft');


        act(() => getFeedback().resetSelectedDayState());
        expect(result.current.scheduleQuery).toBe('');
        expect(result.current.editingTimeTaskId).toBeNull();
    });

    it('drops an in-progress time edit when the selected day changes', () => {
        const task = makeTask({ id: 'task-timed', startTime: '2026-04-04T09:00:00' });
        const { result, rerender } = renderHook(
            ({ selectedDate }: { selectedDate: Date }) => {
                const feedback = useCalendarScheduleFeedback();
                return useCalendarSelectedDay({
                    feedback,
                    findFreeSlotForDay: () => null,
                    getDeadlinesForDay: () => [],
                    getExternalEventsForDay: () => [],
                    getScheduledForDay: () => [],
                    isSlotFreeForDay: () => true,
                    openTaskComposerAt: vi.fn(),
                    resolveText: (_key, fallback) => fallback,
                    schedulableTasks: [],
                    selectedDate,
                    t: (key) => ENGLISH[key] ?? key,
                    tasks: [task],
                    timeEstimateToMinutes: () => 30,
                    updateTask: vi.fn(async () => ({ success: true })),
                });
            },
            { initialProps: { selectedDate: SELECTED } }
        );

        act(() => result.current.beginEditScheduledTime('task-timed'));
        expect(result.current.editingTimeTaskId).toBe('task-timed');

        rerender({ selectedDate: new Date(2026, 3, 5) });
        expect(result.current.editingTimeTaskId).toBeNull();
    });
});
