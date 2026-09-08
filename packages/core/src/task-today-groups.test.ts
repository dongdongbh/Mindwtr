import { describe, expect, it } from 'vitest';
import { splitTodayTasksByStartTime } from './task-utils';

describe('splitTodayTasksByStartTime (#995)', () => {
    const now = new Date(2026, 8, 8, 21, 47);
    const at = (hour: number, minute = 0) => new Date(2026, 8, 8, hour, minute).toISOString();

    it('puts available rows before later-today rows while preserving each group order and task identity', () => {
        const later = Object.freeze({ id: 'later', startTime: at(22) });
        const ready = Object.freeze({ id: 'ready', startTime: at(18) });
        const laterAgain = Object.freeze({ id: 'later-again', startTime: at(23) });
        const dateOnly = Object.freeze({ id: 'date-only', startTime: '2026-09-08' });
        const tasks = Object.freeze([later, ready, laterAgain, dateOnly]);
        const groups = splitTodayTasksByStartTime(tasks, now);
        expect(groups.ready).toEqual([ready, dateOnly]);
        expect(groups.laterToday).toEqual([later, laterAgain]);
        expect(groups.laterToday[0]).toBe(later);
        expect(tasks[0]).toBe(later);
    });

    it('moves a task at its exact start time and leaves no later group', () => {
        const task = { startTime: at(22) };
        expect(splitTodayTasksByStartTime([task], new Date(2026, 8, 8, 21, 59, 59, 999)).laterToday).toEqual([task]);
        expect(splitTodayTasksByStartTime([task], new Date(2026, 8, 8, 22))).toEqual({ ready: [task], laterToday: [] });
    });

    it.each([
        undefined, '', 'not-a-date', '2026-09-08', at(18), at(21, 47),
        new Date(2026, 8, 7, 22).toISOString(), new Date(2026, 8, 9, 1).toISOString(),
    ])('does not classify %s as later today or alter upstream membership', (startTime) => {
        const task = { startTime };
        expect(splitTodayTasksByStartTime([task], now)).toEqual({ ready: [task], laterToday: [] });
    });

    it('uses local calendar boundaries even when serialized ISO dates cross midnight', () => {
        const late = { startTime: new Date(2026, 8, 8, 23, 59, 59, 999).toISOString() };
        const tomorrow = { startTime: new Date(2026, 8, 9, 0).toISOString() };
        expect(splitTodayTasksByStartTime([late, tomorrow], now)).toEqual({ ready: [tomorrow], laterToday: [late] });
    });

    it('does not use due or recurrence times to defer a task with no explicit timed start', () => {
        const task = { startTime: undefined, dueDate: at(22), recurrence: 'daily' };
        expect(splitTodayTasksByStartTime([task], now)).toEqual({ ready: [task], laterToday: [] });
    });

    it('returns empty groups for an empty Today list', () => {
        expect(splitTodayTasksByStartTime([], now)).toEqual({ ready: [], laterToday: [] });
    });
});
