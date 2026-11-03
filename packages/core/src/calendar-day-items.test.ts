import { describe, expect, it } from 'vitest';

import {
    buildCalendarDayItems,
    buildTimedCalendarLayouts,
    getCalendarTimedDeadlines,
    getCalendarDeadlineMarkerGroups,
    getTaskCompletionInstant,
    isCompletedCalendarTask,
    isSchedulableCalendarTask,
    orderCalendarDayItemsForLimitedSlots,
} from './calendar-day-items';
import type { ExternalCalendarEvent, Task } from './index';

const task = (overrides: Partial<Task>): Task => ({
    id: 'task-1',
    title: 'Task',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-05-04T00:00:00.000Z',
    updatedAt: '2026-05-04T00:00:00.000Z',
    ...overrides,
});

const event = (overrides: Partial<ExternalCalendarEvent>): ExternalCalendarEvent => ({
    id: 'event-1',
    sourceId: 'work',
    title: 'Event',
    start: '2026-05-04T09:30:00',
    end: '2026-05-04T10:00:00',
    allDay: false,
    ...overrides,
});

describe('completed look-back (#955)', () => {
    it('files a completed task under its completion instant, falling back to updatedAt', () => {
        expect(getTaskCompletionInstant({ status: 'done', completedAt: '2026-05-04T09:00:00.000Z', updatedAt: '2026-05-06T00:00:00.000Z' })?.toISOString())
            .toBe('2026-05-04T09:00:00.000Z');


        expect(getTaskCompletionInstant({ status: 'archived', updatedAt: '2026-05-06T00:00:00.000Z' })?.toISOString())
            .toBe('2026-05-06T00:00:00.000Z');
        expect(buildCalendarDayItems({
            completed: [task({ status: 'archived', updatedAt: '2026-05-06T09:00:00.000Z' })],
            deadlines: [],
            events: [],
            scheduled: [],
        })[0]?.start?.toISOString()).toBe('2026-05-06T09:00:00.000Z');
    });

    it('splits the calendar cleanly: a task is schedulable or completed, never both', () => {


        for (const status of ['inbox', 'next', 'waiting', 'someday'] as const) {
            expect(isSchedulableCalendarTask(task({ status }))).toBe(true);
            expect(isCompletedCalendarTask(task({ status }))).toBe(false);
        }
        for (const status of ['done', 'archived'] as const) {
            expect(isSchedulableCalendarTask(task({ status }))).toBe(false);
            expect(isCompletedCalendarTask(task({ status }))).toBe(true);
        }

        expect(isSchedulableCalendarTask(task({ status: 'reference' }))).toBe(false);
        expect(isCompletedCalendarTask(task({ status: 'reference' }))).toBe(false);
    });

    it('accepts done and archived tasks only, and never a deleted one', () => {
        expect(isCompletedCalendarTask(task({ status: 'done' }))).toBe(true);
        expect(isCompletedCalendarTask(task({ status: 'archived' }))).toBe(true);
        expect(isCompletedCalendarTask(task({ status: 'next' }))).toBe(false);
        expect(isCompletedCalendarTask(task({ status: 'reference' }))).toBe(false);
        expect(isCompletedCalendarTask(task({ status: 'done', deletedAt: '2026-05-05T00:00:00.000Z' }))).toBe(false);
        const cancelled = task({
            status: 'archived',
            cancelledAt: '2026-05-05T00:00:00.000Z',
            completedAt: undefined,
        });
        expect(isCompletedCalendarTask(cancelled)).toBe(false);
        expect(getTaskCompletionInstant(cancelled)).toBeNull();
        expect(buildCalendarDayItems({
            completed: [cancelled],
            deadlines: [],
            events: [],
            scheduled: [],
        })).toEqual([]);
    });

    it('orders completed items by completion time among the day\'s other items', () => {
        const items = buildCalendarDayItems({
            completed: [task({ id: 'shipped', title: 'Shipped it', status: 'done', completedAt: '2026-05-04T09:00:00' })],
            deadlines: [],
            events: [event({ id: 'standup', title: 'Standup', start: '2026-05-04T09:30:00' })],
            scheduled: [task({ id: 'timed', title: 'Timed', startTime: '2026-05-04T08:00:00' })],
        });

        expect(items.map((item) => item.id)).toEqual(['scheduled-timed', 'completed-shipped', 'event-standup']);
    });

    it('omits completed items entirely when the toggle is off', () => {
        const items = buildCalendarDayItems({
            deadlines: [],
            events: [],
            scheduled: [task({ id: 'timed', startTime: '2026-05-04T08:00:00' })],
        });

        expect(items.map((item) => item.kind)).toEqual(['scheduled']);
    });
});

describe('buildCalendarDayItems', () => {
    it('preserves an explicit timed deadline alongside the same task start when requested', () => {
        const both = task({ id: 'both', startTime: '2026-05-04T08:00:00', dueDate: '2026-05-04T17:00:00' });
        const lists = { deadlines: [both], events: [], scheduled: [both] };
        expect(buildCalendarDayItems(lists).map((item) => item.kind)).toEqual(['scheduled']);
        expect(buildCalendarDayItems({ ...lists, preserveTimedDeadlines: true }).map((item) => item.kind))
            .toEqual(['scheduled', 'deadline']);
        expect(buildCalendarDayItems({ ...lists, scheduled: [], preserveTimedDeadlines: true }).map((item) => item.kind))
            .toEqual(['deadline']);
        const dateOnly = { ...both, dueDate: '2026-05-04' };
        expect(buildCalendarDayItems({ deadlines: [dateOnly], scheduled: [dateOnly], events: [], preserveTimedDeadlines: true }))
            .toHaveLength(1);
    });

    it('orders scheduled tasks, deadlines and events by start time', () => {
        const items = buildCalendarDayItems({
            deadlines: [task({ id: 'due', title: 'Due today', dueDate: '2026-05-04' })],
            events: [event({ id: 'standup', title: 'Standup', start: '2026-05-04T09:30:00' })],
            scheduled: [task({ id: 'timed', title: 'Timed', startTime: '2026-05-04T08:00:00' })],
        });


        expect(items.map((item) => item.id)).toEqual([
            'scheduled-timed',
            'event-standup',
            'deadline-due',
        ]);
    });

    it('shows a task that is both scheduled and due only as its scheduled block', () => {
        const both = task({ id: 'both', title: 'Both', dueDate: '2026-05-04', startTime: '2026-05-04T08:00:00' });

        const items = buildCalendarDayItems({ deadlines: [both], events: [], scheduled: [both] });

        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ id: 'scheduled-both', kind: 'scheduled' });
    });

    it('sorts undated items last and breaks ties by title', () => {
        const items = buildCalendarDayItems({
            deadlines: [],
            events: [],
            scheduled: [
                task({ id: 'zulu', title: 'Zulu', startTime: '2026-05-04T08:00:00' }),
                task({ id: 'alpha', title: 'Alpha', startTime: '2026-05-04T08:00:00' }),
                task({ id: 'undated', title: 'Undated' }),
            ],
        });

        expect(items.map((item) => item.id)).toEqual(['scheduled-alpha', 'scheduled-zulu', 'scheduled-undated']);
    });
});

describe('getCalendarTimedDeadlines', () => {
    it('uses explicit due clock times including midnight, while date-only dates remain all-day', () => {
        const deadlines = [
            task({ id: 'day', dueDate: '2026-05-04' }),
            task({ id: 'midnight', dueDate: '2026-05-04T00:00:00' }),
            task({ id: 'afternoon', dueDate: '2026-05-04T17:30:00', timeEstimate: '2h' }),
            task({ id: 'invalid', dueDate: 'invalidT17:00:00' }),
            task({ id: 'undated' }),
        ];
        const before = JSON.stringify(deadlines);
        const markers = getCalendarTimedDeadlines(deadlines);
        expect(markers.map((marker) => marker.id)).toEqual(['deadline-midnight', 'deadline-afternoon']);
        expect(markers.map((marker) => [marker.start.getHours(), marker.start.getMinutes()])).toEqual([[0, 0], [17, 30]]);
        expect(markers[1]).toEqual({ id: 'deadline-afternoon', kind: 'deadline', task: deadlines[2], title: 'Task', start: new Date(2026, 4, 4, 17, 30) });
        expect(JSON.stringify(deadlines)).toBe(before);
    });

    it('excludes finished, cancelled, deleted and reference tasks but preserves projected occurrences', () => {
        const dueDate = '2026-05-04T17:00:00';
        const deadlines = [
            task({ id: 'done', status: 'done', dueDate }),
            task({ id: 'archived', status: 'archived', dueDate }),
            task({ id: 'cancelled', status: 'archived', cancelledAt: '2026-05-03T09:00:00', dueDate }),
            task({ id: 'deleted', deletedAt: '2026-05-03T09:00:00', dueDate }),
            task({ id: 'reference', status: 'reference', dueDate }),
            { ...task({ id: 'projected', dueDate }), isProjectedRecurringTask: true, sourceTaskId: 'source' } as Task,
        ];
        const markers = getCalendarTimedDeadlines(deadlines);
        expect(markers.map((marker) => marker.task.id)).toEqual(['projected']);
        expect(markers[0].task).toBe(deadlines[5]);
    });
});

describe('deadline marker label groups', () => {
    it('groups close deadlines without estimates and clamps midnight and end-of-day labels', () => {
        const markers = getCalendarTimedDeadlines([
            task({ id: 'midnight', dueDate: '2026-05-04T00:00:00' }),
            task({ id: 'close-a', dueDate: '2026-05-04T10:00:00' }),
            task({ id: 'close-b', dueDate: '2026-05-04T10:10:00' }),
            task({ id: 'close-c', dueDate: '2026-05-04T10:45:00' }),
            task({ id: 'late-a', dueDate: '2026-05-04T23:10:00' }),
            task({ id: 'late-b', dueDate: '2026-05-04T23:59:00' }),
            task({ id: 'next-day', dueDate: '2026-05-05T00:00:00' }),
        ]);
        const groups = getCalendarDeadlineMarkerGroups(markers, { dayStart: new Date(2026, 4, 4), minGapMinutes: 32, maxVisibleRows: 3 });
        expect(groups.map((group) => group.markers.map((marker) => marker.task.id)))
            .toEqual([['midnight'], ['close-a', 'close-b', 'close-c'], ['late-a', 'late-b']]);
        expect(groups.map((group) => [group.anchorMinutes, group.startMinutes])).toEqual([[0, 0], [600, 600], [1390, 1376]]);
        for (let index = 1; index < groups.length; index += 1) {
            expect(groups[index].startMinutes).toBeGreaterThanOrEqual(groups[index - 1].startMinutes + Math.min(groups[index - 1].markers.length, 3) * 32);
        }
        expect(groups[2].markers[1].start.getHours()).toBe(23);
        expect(groups[2].markers[1].start.getMinutes()).toBe(59);
        expect(groups[1].markers[0]).toBe(markers[1]);
    });

    it('caps label geometry for a dense group and keeps every exact deadline available to scroll', () => {
        const markers = getCalendarTimedDeadlines(Array.from({ length: 10 }, (_, index) => task({ id: `due-${index}`, dueDate: `2026-05-04T23:${50 + index}:00` })));
        const groups = getCalendarDeadlineMarkerGroups(markers, { dayStart: new Date(2026, 4, 4), minGapMinutes: 32, maxVisibleRows: 3 });
        expect(groups).toHaveLength(1);
        expect(groups[0].markers).toHaveLength(10);
        expect(groups[0].startMinutes).toBe(1440 - 3 * 32);
    });
});

describe('orderCalendarDayItemsForLimitedSlots', () => {
    const projectedTask = (id: string): Task => ({
        ...task({ id }),
        isProjectedRecurringTask: true,
        sourceTaskId: 'source-1',
    } as Task);

    it('moves projected recurring occurrences behind one-off items', () => {
        const items = buildCalendarDayItems({
            deadlines: [],
            events: [event({ id: 'meeting', start: '2026-05-04T15:00:00' })],
            scheduled: [
                { ...projectedTask('sleep'), startTime: '2026-05-04T08:00:00.000Z' },
                task({ id: 'dentist', startTime: '2026-05-04T10:00:00.000Z' }),
            ],
        });

        expect(items.map((item) => item.id)).toEqual(['scheduled-sleep', 'scheduled-dentist', 'event-meeting']);
        expect(orderCalendarDayItemsForLimitedSlots(items).map((item) => item.id))
            .toEqual(['scheduled-dentist', 'event-meeting', 'scheduled-sleep']);
    });

    it('keeps pure time order when nothing is projected', () => {
        const items = buildCalendarDayItems({
            deadlines: [task({ id: 'due', dueDate: '2026-05-04T12:00:00.000Z' })],
            events: [],
            scheduled: [task({ id: 'early', startTime: '2026-05-04T08:00:00.000Z' })],
        });

        expect(orderCalendarDayItemsForLimitedSlots(items).map((item) => item.id))
            .toEqual(items.map((item) => item.id));
    });
});

describe('buildTimedCalendarLayouts', () => {
    it('gives each overlap cluster its own column count', () => {
        const layouts = buildTimedCalendarLayouts([
            { id: 'morning', startMinutes: 9 * 60, endMinutes: 10 * 60 },
            { id: 'afternoon', startMinutes: 14 * 60, endMinutes: 15 * 60 },
        ]);


        expect(layouts.get('morning')).toMatchObject({ columnCount: 1, leftPercent: 0, widthPercent: 100 });
        expect(layouts.get('afternoon')).toMatchObject({ columnCount: 1, leftPercent: 0, widthPercent: 100 });
    });

    it('splits only the cluster that actually overlaps', () => {
        const layouts = buildTimedCalendarLayouts([
            { id: 'solo', startMinutes: 8 * 60, endMinutes: 9 * 60 },
            { id: 'pair-a', startMinutes: 13 * 60, endMinutes: 14 * 60 },
            { id: 'pair-b', startMinutes: 13 * 60 + 30, endMinutes: 14 * 60 + 30 },
        ]);

        expect(layouts.get('solo')).toMatchObject({ columnCount: 1, widthPercent: 100 });
        expect(layouts.get('pair-a')).toMatchObject({ columnCount: 2, columnIndex: 0, leftPercent: 0 });
        expect(layouts.get('pair-b')).toMatchObject({ columnCount: 2, columnIndex: 1, leftPercent: 50 });
    });

    it('places same-slot timed items in separate columns', () => {
        const layouts = buildTimedCalendarLayouts([
            { id: 'long-event', startMinutes: 9 * 60, endMinutes: 10 * 60 },
            { id: 'short-event', startMinutes: 9 * 60, endMinutes: 9 * 60 + 15 },
        ]);

        const longEvent = layouts.get('long-event');
        const shortEvent = layouts.get('short-event');

        expect(longEvent?.columnCount).toBe(2);
        expect(shortEvent?.columnCount).toBe(2);
        expect(longEvent?.widthPercent).toBeCloseTo(50);
        expect(longEvent?.columnIndex).not.toBe(shortEvent?.columnIndex);
        expect(new Set([longEvent?.leftPercent, shortEvent?.leftPercent])).toEqual(new Set([0, 50]));
    });

    it('keeps back-to-back timed items full width', () => {
        const layouts = buildTimedCalendarLayouts([
            { id: 'morning', startMinutes: 9 * 60, endMinutes: 10 * 60 },
            { id: 'next', startMinutes: 10 * 60, endMinutes: 11 * 60 },
        ]);

        expect(layouts.get('morning')).toMatchObject({ columnCount: 1, columnIndex: 0, leftPercent: 0, widthPercent: 100 });
        expect(layouts.get('next')).toMatchObject({ columnCount: 1, columnIndex: 0, leftPercent: 0, widthPercent: 100 });
    });

    it('reuses a column inside a chained overlap group', () => {
        const layouts = buildTimedCalendarLayouts([
            { id: 'a', startMinutes: 9 * 60, endMinutes: 10 * 60 },
            { id: 'b', startMinutes: 9 * 60 + 30, endMinutes: 10 * 60 + 30 },
            { id: 'c', startMinutes: 10 * 60, endMinutes: 11 * 60 },
        ]);

        expect(layouts.get('a')).toMatchObject({ columnCount: 2, columnIndex: 0 });
        expect(layouts.get('b')).toMatchObject({ columnCount: 2, columnIndex: 1 });
        expect(layouts.get('c')).toMatchObject({ columnCount: 2, columnIndex: 0 });
    });

    it('drops items without a usable range', () => {
        const layouts = buildTimedCalendarLayouts([
            { id: 'empty', startMinutes: 60, endMinutes: 60 },
            { id: 'nan', startMinutes: Number.NaN, endMinutes: 120 },
        ]);

        expect(layouts.size).toBe(0);
    });
});
