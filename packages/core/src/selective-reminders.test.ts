import { describe, expect, it } from 'vitest';
import { buildReminderSchedule, getTaskReminderPlan, resolveDueReminders } from './schedule-utils';
import { findStaleNativeReminderAlarms, planReminderAlarms, type ReminderAlarmEntry } from './mobile-reminder-alarms';
import { isTaskReminderSelectionCurrent, shouldSendTaskReminderKind, suppressLegacyTaskReminders } from './task-reminder-policy';
import type { Task } from './types';

const now = new Date('2026-06-15T12:00:00Z');
const task = (patch: Partial<Task> = {}): Task => ({
    id: 'selective', title: 'Synthetic reminder', status: 'next', tags: [], contexts: [],
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
    startTime: '2026-06-15T16:00:00Z', dueDate: '2026-06-16T08:00:00Z', ...patch,
});
const input = (value: Task, alarms = new Map<string, ReminderAlarmEntry>()) => ({
    tasks: [value], projects: [], settings: {}, translations: {}, now, maxOneShotReminders: 200, alarms,
});

describe('selective task reminders', () => {
    it.each(['start', 'due'] as const)('sends only %s, overriding a skipped default without changing dates', (reminderPolicy) => {
        const value = task({ reminderPolicy, suppressMindwtrReminders: true, repeatReminderMinutes: 5 });
        const before = structuredClone(value);
        const requests = buildReminderSchedule({ ...input(value), settings: { taskReminderDefault: 'skip' } }).requests;
        expect(requests).toHaveLength(1);
        expect(requests[0].fireAt.toISOString()).toBe(new Date(reminderPolicy === 'start' ? value.startTime! : value.dueDate!).toISOString());
        expect(value).toEqual(before);
        expect(suppressLegacyTaskReminders(value)).toBe(true);
        expect(shouldSendTaskReminderKind(value, reminderPolicy)).toBe(true);
        expect(shouldSendTaskReminderKind(value, reminderPolicy === 'start' ? 'due' : 'start')).toBe(false);
    });

    it.each([
        ['start', '2026-06-15T15:30:00.000Z'],
        ['due', '2026-06-16T06:00:00.000Z'],
    ] as const)('replaces %s time with one advance reminder and never falls back after it passes', (reminderPolicy, expected) => {
        const value = task({ reminderPolicy, startReminderLeadMinutes: 30, dueReminderLeadMinutes: 120, repeatReminderMinutes: 5 });
        const requests = buildReminderSchedule(input(value)).requests;
        expect(requests).toHaveLength(1);
        expect(requests[0].fireAt.toISOString()).toBe(expected);
        expect(buildReminderSchedule({ ...input(value), now: new Date(expected) }).requests).toEqual([]);
        expect(resolveDueReminders(input(value), { from: new Date(Date.parse(expected) - 1), to: new Date(expected) })).toHaveLength(1);
    });

    it.each(['start', 'due'] as const)('does not fall back to the other date for %s', (reminderPolicy) => {
        for (const date of [undefined, '2026-06-16', 'bad']) {
            const value = task({ reminderPolicy, [reminderPolicy === 'start' ? 'startTime' : 'dueDate']: date });
            expect(buildReminderSchedule(input(value)).requests).toEqual([]);
        }
        for (const patch of [{ status: 'done' }, { status: 'reference' }, { deletedAt: now.toISOString() }] satisfies Partial<Task>[]) {
            expect(buildReminderSchedule(input(task({ reminderPolicy, ...patch }))).requests).toEqual([]);
        }
        expect(buildReminderSchedule({ ...input(task({ reminderPolicy })), settings: { notificationsEnabled: false } }).requests).toEqual([]);
        expect(buildReminderSchedule({ ...input(task({ reminderPolicy })), settings: { [reminderPolicy === 'start' ? 'startDateNotificationsEnabled' : 'dueDateNotificationsEnabled']: false } }).requests).toEqual([]);
    });

    it('withdraws recovered alarms from the previous selection, including tracked IDs', () => {
        const rows = [1, 2].map(id => ({ id, scheduleType: 'once', year: 2026, month: 6, day: 16, hour: 8, minute: 0, second: 0,
            data: { alarmKey: 'task:selective', kind: 'task-reminder', ...(id === 2 ? { reminderSelection: 'due' } : {}) } }));
        expect(findStaleNativeReminderAlarms({ rows, trackedIds: new Set([1, 2]), tasks: [task({ reminderPolicy: 'due' })], projects: [], now }))
            .toEqual([{ id: 1, reason: 'withdrawn' }]);
        expect(isTaskReminderSelectionCurrent(task({ reminderPolicy: 'due' }), { kind: 'task-reminder', reminderSelection: 'start' })).toBe(false);
        expect(isTaskReminderSelectionCurrent(task({ reminderPolicy: 'due' }), { kind: 'task-review' })).toBe(true);
    });

    it('keeps review reminders separate from selective date reminders', () => {
        const plan = getTaskReminderPlan(task({ reminderPolicy: 'due', dueReminderLeadMinutes: 120, reviewAt: '2026-06-15T14:00:00Z' }), now, { includeReviewAt: true });
        expect(plan.next?.kind).toBe('review');
        expect(plan.advance?.kind).toBe('due-advance');
        expect(plan.startAdvance).toBeNull();
    });

    it('withdraws old alarms when selecting a different date or advance time', () => {
        const original = task({ reminderPolicy: 'send', startReminderLeadMinutes: 30, dueReminderLeadMinutes: 120, repeatReminderMinutes: 5 });
        const first = planReminderAlarms(input(original));
        const alarms = new Map(first.oneShot.map((entry, index) => [entry.key, { id: index + 1, signature: entry.signature }]));
        const next = planReminderAlarms(input({ ...original, reminderPolicy: 'due' }, alarms));
        expect(next.oneShot).toHaveLength(1);
        expect(next.oneShot[0].config.fireAt.toISOString()).toBe('2026-06-16T06:00:00.000Z');
        for (const entry of first.oneShot.filter(entry => entry.key !== next.oneShot[0].key)) expect(next.cancel).toContain(entry.key);
        const retained = new Map([[next.oneShot[0].key, { id: 99, signature: next.oneShot[0].signature }]]);
        const moved = planReminderAlarms(input({ ...original, reminderPolicy: 'due', dueReminderLeadMinutes: 60 }, retained));
        expect(moved.cancel).toContain(next.oneShot[0].key);
    });
});
