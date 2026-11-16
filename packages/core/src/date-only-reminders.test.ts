import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    buildReminderSchedule,
    getDueReminderRepeatTimes,
    getProjectReviewReminderIntent,
    getTaskReminderPlan,
    resolveDueReminders,
    resolveTaskReminderDate,
} from './schedule-utils';
import { getCalendarTimedDeadlines } from './calendar-day-items';
import { createNextRecurringTask } from './recurrence';
import type { NotificationSettings, Task } from './types';

const task = (patch: Partial<Task> = {}): Task => ({
    id: 'date-only', title: 'Synthetic reminder', status: 'next', tags: [], contexts: [],
    createdAt: '2026-06-16T12:00:00Z', updatedAt: '2026-06-16T12:00:00Z',
    startTime: '2026-06-17', dueDate: '2026-06-18', ...patch,
});
const preferences = { dateOnlyStartReminderTime: '09:00', dateOnlyDueReminderTime: '17:00' };
const now = new Date('2026-06-16T12:00:00Z');
const schedule = (value: Task, settings: NotificationSettings = preferences, at = now) =>
    buildReminderSchedule({ tasks: [value], projects: [], settings, translations: {}, now: at });

describe('date-only reminders', () => {
    const previousZone = process.env.TZ;
    beforeAll(() => { process.env.TZ = 'America/New_York'; });
    afterAll(() => { if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone; });

    it('requires an explicit strict default clock for a date-only value', () => {
        for (const clock of [undefined, '', '9:00', '09:0', '24:00', '12:60', '09:00:00', ' 09:00', 'invalid']) {
            expect(resolveTaskReminderDate('2026-06-17', clock)).toBeNull();
        }
        expect(resolveTaskReminderDate('2026-06-17', '00:00')?.toISOString()).toBe('2026-06-17T04:00:00.000Z');
        expect(resolveTaskReminderDate('2026-06-17', '23:59')?.toISOString()).toBe('2026-06-18T03:59:00.000Z');
    });

    it('rejects invalid calendars and clocks without repairing task values', () => {
        for (const value of [undefined, null, '', 'broken', '2026-02-29', '2026-04-31', '2026-13-01', '2026-06-00',
            '2026-6-17']) {
            expect(resolveTaskReminderDate(value, '09:00')).toBeNull();
        }
        expect(resolveTaskReminderDate('2028-02-29', '09:00')?.getDate()).toBe(29);
    });

    it('preserves explicit local and offset datetimes regardless of defaults', () => {
        expect(resolveTaskReminderDate('2026-06-17T14:30:12.123Z', '09:00')?.toISOString()).toBe('2026-06-17T14:30:12.123Z');
        expect(resolveTaskReminderDate('2026-06-17T14:30+02:00', 'invalid')?.toISOString()).toBe('2026-06-17T12:30:00.000Z');
        expect(resolveTaskReminderDate('2026-06-17T14:30', '')?.toISOString()).toBe('2026-06-17T18:30:00.000Z');
        expect(resolveTaskReminderDate('2026-06-17T14:30:12.123456Z', '09:00')?.toISOString()).toBe('2026-06-17T14:30:12.123Z');
    });

    it('uses the local date through DST gaps and the first overlap occurrence', () => {
        expect(resolveTaskReminderDate('2026-03-08', '02:30')?.toISOString()).toBe('2026-03-08T07:30:00.000Z');
        expect(resolveTaskReminderDate('2026-11-01', '01:30')?.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    });

    it('leaves both defaults off for upgraded settings and enables each independently', () => {
        const value = task();
        expect(schedule(value, {}).requests).toEqual([]);
        expect(schedule(value, { dateOnlyStartReminderTime: '', dateOnlyDueReminderTime: '' }).requests).toEqual([]);
        expect(schedule(value, { dateOnlyStartReminderTime: '09:00' }).requests).toMatchObject([
            { fireAt: new Date('2026-06-17T13:00:00Z'), data: { dateOnly: 'true', dateOnlyKind: 'start' } },
        ]);
        expect(schedule(value, { dateOnlyDueReminderTime: '17:00' }).requests).toMatchObject([
            { fireAt: new Date('2026-06-18T21:00:00Z'), data: { dateOnly: 'true', dateOnlyKind: 'due' } },
        ]);
        expect(schedule(value, preferences, new Date('2026-06-17T14:00:00Z')).requests).toMatchObject([
            { fireAt: new Date('2026-06-18T21:00:00Z') },
        ]);
    });

    it('uses effective time for advances and repeats without changing task data', () => {
        const value = task({ dueReminderLeadMinutes: 1440, startReminderLeadMinutes: 30, repeatReminderMinutes: 30 });
        const before = structuredClone(value);
        const plan = getTaskReminderPlan(value, now, preferences);
        expect(plan.startAdvance).toMatchObject({ scheduledAt: new Date('2026-06-17T12:30:00Z'), dateOnly: true });
        expect(plan.advance).toMatchObject({ scheduledAt: new Date('2026-06-17T21:00:00Z'), dateOnly: true });
        expect(plan.repeats.map(entry => entry.scheduledAt.toISOString())).toEqual([
            '2026-06-18T21:30:00.000Z', '2026-06-18T22:00:00.000Z', '2026-06-18T22:30:00.000Z', '2026-06-18T23:00:00.000Z',
        ]);
        expect(plan.repeats.every(entry => entry.dateOnly)).toBe(true);
        const requests = schedule(value).requests;
        expect(requests.find(entry => entry.data.kind === 'task-start-advance')?.data.dateOnlyKind).toBe('start');
        expect(requests.find(entry => entry.data.kind === 'task-due-advance')?.data.dateOnlyKind).toBe('due');
        expect(requests.filter(entry => entry.key.includes(':r')).every(entry => entry.data.dateOnlyKind === 'due')).toBe(true);
        expect(getDueReminderRepeatTimes(value, preferences)).toEqual(plan.repeats.map(entry => entry.scheduledAt));
        expect(value).toEqual(before);
        const shifted = getTaskReminderPlan(value, now, { ...preferences, dateOnlyDueReminderTime: '18:00' });
        expect(shifted.repeats[0].dedupeKey).not.toBe(plan.repeats[0].dedupeKey);
    });

    it.each(['done', 'archived', 'reference'] as const)('never schedules an inactive %s task', (status) => {
        expect(schedule(task({ status, repeatReminderMinutes: 30, dueReminderLeadMinutes: 60, startReminderLeadMinutes: 30 })).requests).toEqual([]);
    });

    it('keeps task policies, deletion, global and per-date toggles authoritative', () => {
        for (const patch of [{ reminderPolicy: 'skip' }, { suppressMindwtrReminders: true }, { deletedAt: now.toISOString() }] satisfies Partial<Task>[]) {
            expect(schedule(task(patch)).requests).toEqual([]);
        }
        expect(schedule(task({ reminderPolicy: 'inherit' }), { ...preferences, taskReminderDefault: 'skip' }).requests).toEqual([]);
        expect(schedule(task({ reminderPolicy: 'send' }), { ...preferences, taskReminderDefault: 'skip' }).requests).toHaveLength(1);
        expect(schedule(task(), { ...preferences, notificationsEnabled: false }).requests).toEqual([]);
        expect(schedule(task(), { ...preferences, startDateNotificationsEnabled: false }).requests[0].fireAt)
            .toEqual(new Date('2026-06-18T21:00:00Z'));
        expect(schedule(task({ startTime: undefined }), { ...preferences, dueDateNotificationsEnabled: false }).requests).toEqual([]);
        for (const reminderPolicy of ['start', 'due'] as const) {
            const value = task({ reminderPolicy, repeatReminderMinutes: 30 });
            expect(schedule(value).requests).toHaveLength(1);
            expect(schedule(value).requests[0].fireAt).toEqual(new Date(reminderPolicy === 'start' ? '2026-06-17T13:00:00Z' : '2026-06-18T21:00:00Z'));
        }
    });

    it('does not schedule missed base reminders or change review reminder behavior', () => {
        expect(schedule(task(), preferences, new Date('2026-06-19T12:00:00Z')).requests).toEqual([]);
        expect(schedule(task({ startTime: undefined, dueDate: undefined, reviewAt: '2026-06-18' })).requests).toEqual([]);
        const review = schedule(task({ startTime: undefined, dueDate: undefined, reviewAt: '2026-06-18T10:00:00Z' })).requests[0];
        expect(review.data).toEqual({ kind: 'task-review', taskId: 'date-only' });
        expect(getProjectReviewReminderIntent({ id: 'project', title: 'Project', status: 'active', color: '', order: 0,
            tagIds: [], createdAt: '', updatedAt: '', reviewAt: '2026-06-18' }, now)).toBeNull();
    });

    it('keeps recurring successors and calendar deadlines date-only', () => {
        const value = task({ startTime: undefined, recurrence: 'daily' });
        schedule(value);
        const next = createNextRecurringTask(value, '2026-06-18T22:00:00Z', 'next', { createId: () => 'successor' });
        expect(next?.dueDate).toBe('2026-06-19');
        expect(getCalendarTimedDeadlines([value, next!])).toEqual([]);
        expect(schedule(next!, preferences).requests[0].fireAt).toEqual(new Date('2026-06-19T21:00:00Z'));
        expect(value.dueDate).toBe('2026-06-18');
        expect(next?.dueDate).toBe('2026-06-19');
    });

    it('retains delivery-window catch-up for a reminder already scheduled before sleep', () => {
        const value = task({ dueDate: undefined });
        expect(resolveDueReminders({ tasks: [value], projects: [], settings: preferences, translations: {} }, {
            from: new Date('2026-06-17T12:59:00Z'), to: new Date('2026-06-17T13:01:00Z'),
        })).toMatchObject([{ fireAt: new Date('2026-06-17T13:00:00Z'), data: { dateOnly: 'true' } }]);
    });
});
