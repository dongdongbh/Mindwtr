import { describe, expect, it } from 'vitest';

import { findFreeSlotForDay, isSlotFreeForDay, minutesToTimeEstimate, timeEstimateToMinutes } from './calendar-scheduling';
import type { ExternalCalendarEvent, Task } from './index';

const task = (overrides: Partial<Task>): Task => ({
    id: 'task-1',
    title: 'Task',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-04-26T00:00:00.000Z',
    updatedAt: '2026-04-26T00:00:00.000Z',
    ...overrides,
});

const event = (overrides: Partial<ExternalCalendarEvent>): ExternalCalendarEvent => ({
    id: 'event-1',
    sourceId: 'work',
    title: 'Event',
    start: '2026-04-26T09:00:00.000Z',
    end: '2026-04-26T10:00:00.000Z',
    allDay: false,
    ...overrides,
});

describe('calendar scheduling helpers', () => {
    it('maps Mindwtr time estimates to calendar minutes', () => {
        expect(timeEstimateToMinutes('5min')).toBe(5);
        expect(timeEstimateToMinutes('1hr')).toBe(60);
        expect(timeEstimateToMinutes('4hr+')).toBe(240);
        expect(timeEstimateToMinutes(undefined)).toBe(30);
        expect(timeEstimateToMinutes('2hr', { enabled: false })).toBe(30);
    });

    it('maps calendar minutes back to Mindwtr time estimates', () => {
        expect(minutesToTimeEstimate(15)).toBe('15min');
        expect(minutesToTimeEstimate(45)).toBe('1hr');
        expect(minutesToTimeEstimate(241)).toBe('4hr+');
    });

    it('finds the first open slot around external events and scheduled tasks', () => {
        const slot = findFreeSlotForDay({
            day: new Date(2026, 3, 26),
            durationMinutes: 30,
            events: [
                event({
                    start: '2026-04-26T08:00:00',
                    end: '2026-04-26T09:00:00',
                }),
            ],
            now: new Date(2026, 3, 25, 12, 0),
            tasks: [
                task({
                    id: 'task-2',
                    startTime: '2026-04-26T09:00:00',
                    timeEstimate: '30min',
                }),
            ],
        });

        expect(slot?.getHours()).toBe(9);
        expect(slot?.getMinutes()).toBe(30);
    });

    it('clamps timed external events that started before the selected day', () => {
        const slot = findFreeSlotForDay({
            day: new Date(2026, 3, 26),
            durationMinutes: 30,
            events: [
                event({
                    start: '2026-04-25T22:00:00',
                    end: '2026-04-26T08:45:00',
                }),
            ],
            now: new Date(2026, 3, 25, 12, 0),
            tasks: [],
        });

        expect(slot?.getHours()).toBe(8);
        expect(slot?.getMinutes()).toBe(45);
    });

    it('returns null when external events fill the available workday', () => {
        const slot = findFreeSlotForDay({
            day: new Date(2026, 3, 26),
            dayEndHour: 10,
            dayStartHour: 8,
            durationMinutes: 30,
            events: [
                event({
                    start: '2026-04-26T08:00:00',
                    end: '2026-04-26T10:00:00',
                }),
            ],
            now: new Date(2026, 3, 25, 12, 0),
            tasks: [],
        });

        expect(slot).toBeNull();
    });

    it('ignores all-day external events for free-slot detection', () => {
        const slot = findFreeSlotForDay({
            day: new Date(2026, 3, 26),
            durationMinutes: 30,
            events: [
                event({
                    allDay: true,
                    start: '2026-04-26T00:00:00',
                    end: '2026-04-27T00:00:00',
                }),
            ],
            now: new Date(2026, 3, 25, 12, 0),
            tasks: [],
        });

        expect(slot?.getHours()).toBe(8);
        expect(slot?.getMinutes()).toBe(0);
    });

    it('rounds today slots forward to the configured snap interval', () => {
        const slot = findFreeSlotForDay({
            day: new Date(2026, 3, 26),
            durationMinutes: 30,
            events: [],
            now: new Date(2026, 3, 26, 8, 7),
            tasks: [],
        });

        expect(slot?.getHours()).toBe(8);
        expect(slot?.getMinutes()).toBe(10);
    });

    it('rounds free slots after busy intervals forward to the configured snap interval', () => {
        const slot = findFreeSlotForDay({
            day: new Date(2026, 3, 26),
            durationMinutes: 30,
            events: [
                event({
                    start: '2026-04-26T08:00:00',
                    end: '2026-04-26T10:07:00',
                }),
            ],
            now: new Date(2026, 3, 25, 12, 0),
            snapMinutes: 15,
            tasks: [],
        });

        expect(slot?.getHours()).toBe(10);
        expect(slot?.getMinutes()).toBe(15);
    });

    it('checks candidate slots against blocking intervals', () => {
        const base = {
            day: new Date(2026, 3, 26),
            durationMinutes: 30,
            events: [
                event({
                    start: '2026-04-26T10:00:00',
                    end: '2026-04-26T11:00:00',
                }),
            ],
            tasks: [],
        };

        expect(isSlotFreeForDay({
            ...base,
            startTime: new Date(2026, 3, 26, 9, 30),
        })).toBe(true);
        expect(isSlotFreeForDay({
            ...base,
            startTime: new Date(2026, 3, 26, 10, 30),
        })).toBe(false);
    });

    it('allows slots outside the visible calendar window when they do not overlap', () => {
        expect(isSlotFreeForDay({
            day: new Date(2026, 3, 26),
            durationMinutes: 30,
            events: [],
            startTime: new Date(2026, 3, 26, 6, 30),
            tasks: [],
        })).toBe(true);
    });

    it('excludes the task being edited from slot collision checks', () => {
        const base = {
            day: new Date(2026, 3, 26),
            durationMinutes: 30,
            events: [],
            startTime: new Date(2026, 3, 26, 10, 0),
            tasks: [
                task({
                    id: 'task-1',
                    startTime: '2026-04-26T10:00:00',
                    timeEstimate: '30min',
                }),
            ],
        };

        expect(isSlotFreeForDay(base)).toBe(false);
        expect(isSlotFreeForDay({ ...base, excludeTaskId: 'task-1' })).toBe(true);
    });
});
