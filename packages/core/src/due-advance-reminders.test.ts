import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReminderSchedule, getReminderNotificationTag, getTaskReminderPlan, normalizeDueReminderLeadMinutes, resolveDueReminders } from './schedule-utils';
import { buildReminderAlarmDetails, buildReminderSnooze, isReminderOwnerGone, planReminderAlarms, scheduleReminderAlarms, type ReminderAlarmEntry, type ReminderAlarmPlanInput, type ReminderAlarmPort } from './mobile-reminder-alarms';
import { resolveNotificationOpenRoute } from './mobile-notification-open';
import type { Task } from './types';

const now = new Date('2026-06-17T08:00:00Z');
const task = (patch: Partial<Task> = {}): Task => ({
    id: 'advance', title: 'Prepare', status: 'next', contexts: [], tags: [],
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
    dueDate: '2026-06-17T10:00:00Z', dueReminderLeadMinutes: 60, ...patch,
});
const input = (tasks: Task[], alarms: Map<string, ReminderAlarmEntry> = new Map()): ReminderAlarmPlanInput => ({
    tasks, projects: [], settings: { notificationsEnabled: true }, now, translations: {}, maxOneShotReminders: 200, alarms,
});

describe('advance due reminders', () => {
    it('validates a bounded integer lead and retains explicit Off', () => {
        for (const value of [0, 1, 5, 1440, 10_080]) expect(normalizeDueReminderLeadMinutes(value)).toBe(value);
        for (const value of [undefined, null, '60', -1, 0.5, NaN, Infinity, 10_081]) expect(normalizeDueReminderLeadMinutes(value)).toBeUndefined();
    });

    it('adds a separate preparation alert before a future start without replacing due or repeats', () => {
        const value = task({ startTime: '2026-06-17T09:30:00Z', repeatReminderMinutes: 30 });
        const plan = getTaskReminderPlan(value, now);
        expect(plan.advance).toMatchObject({ kind: 'due-advance', scheduledAt: new Date('2026-06-17T09:00:00Z') });
        expect(plan.next?.kind).toBe('start');
        const scheduled = buildReminderSchedule({ ...input([value]), now }).requests;
        expect(scheduled.filter((request) => request.data.kind === 'task-due-advance')).toHaveLength(1);
        const duePlan = getTaskReminderPlan({ ...value, startTime: undefined }, now);
        expect(duePlan.next).toMatchObject({ kind: 'due', scheduledAt: new Date(value.dueDate!) });
        expect(duePlan.repeats.map((entry) => entry.scheduledAt.toISOString())).toEqual([
            '2026-06-17T10:30:00.000Z', '2026-06-17T11:00:00.000Z', '2026-06-17T11:30:00.000Z', '2026-06-17T12:00:00.000Z',
        ]);
    });

    it('keeps the new request in desktop delivery while excluding due repeats', () => {
        const requests = resolveDueReminders({ ...input([task({ repeatReminderMinutes: 30 })]) }, {
            from: new Date('2026-06-17T08:59:59Z'), to: new Date('2026-06-17T09:00:00Z'),
        });
        expect(requests.map((request) => request.data.kind)).toEqual(['task-due-advance']);
    });

    it.each([
        { dueDate: '2026-06-17' }, { dueDate: 'broken' }, { dueReminderLeadMinutes: 0 }, { dueReminderLeadMinutes: -1 },
        { dueReminderLeadMinutes: 1.5 }, { dueReminderLeadMinutes: 10_081 }, { dueDate: '2026-06-17T08:30:00Z' },
        { dueDate: '2026-06-17T09:00:00Z' }, { dueDate: '2026-06-16T10:00:00Z' }, { status: 'done' },
        { status: 'archived' }, { deletedAt: now.toISOString() }, { reminderPolicy: 'skip' },
    ] satisfies Partial<Task>[])('does not arm a past, inactive, date-only or invalid advance: %j', (patch) => {
        expect(getTaskReminderPlan(task(patch), now).advance).toBeNull();
    });

    it('uses due settings, inherited policy and notification permission gates', () => {
        expect(getTaskReminderPlan(task(), now, { includeDueDate: false }).advance).toBeNull();
        expect(getTaskReminderPlan(task({ reminderPolicy: 'inherit' }), now, { taskReminderDefault: 'skip' }).advance).toBeNull();
        expect(planReminderAlarms({ ...input([task()]), permissionGranted: false }).oneShot).toEqual([]);
        expect(planReminderAlarms({ ...input([task()]), settings: { notificationsEnabled: false } }).oneShot).toEqual([]);
    });

    it('withdraws old identities on deadline/offset, done, deletion, Skip and permission changes', () => {
        const first = planReminderAlarms(input([task()]));
        const request = first.oneShot.find((entry) => entry.config.data?.kind === 'task-due-advance')!;
        const alarms = new Map([[request.key, { id: 99, signature: request.signature }]]);
        for (const patch of [
            { dueDate: '2026-06-17T11:00:00Z' }, { dueReminderLeadMinutes: 30 }, { dueReminderLeadMinutes: 0 },
            { dueDate: '2026-06-17' }, { status: 'done' }, { deletedAt: now.toISOString() }, { reminderPolicy: 'skip' },
        ] satisfies Partial<Task>[]) {
            const next = planReminderAlarms(input([task(patch)], alarms));
            expect(next.cancel).toContain(request.key);
            expect(next.reasons[request.key]).toBe('withdrawn');
            expect(next.schedule).not.toContain(request.key);
        }
        const revoked = planReminderAlarms({ ...input([task()], alarms), permissionGranted: false });
        expect(revoked.cancel).toContain(request.key);
        expect(isReminderOwnerGone(request.key, new Map(), new Map())).toBe(true);
        expect(isReminderOwnerGone(request.key, new Map([[task().id, task()]]), new Map())).toBe(false);
    });

    it('logs scheduling only after acceptance and retains task grouping, Done, Snooze and opening', async () => {
        const plan = planReminderAlarms(input([task()]));
        const request = plan.oneShot.find((entry) => entry.config.data?.kind === 'task-due-advance')!;
        const details = buildReminderAlarmDetails(request.key, request.config);
        expect(details).toMatchObject({ has_complete_action: true, snooze_interval: 10, tag: getReminderNotificationTag('task:advance') });
        expect(buildReminderSnooze(details, now.getTime(), 'snooze:test')?.details.data).toEqual(details.data);
        expect(resolveNotificationOpenRoute({ kind: 'task-due-advance', taskId: 'advance', notificationId: request.key }, { now: () => now.getTime(), nextTaskOpenSequence: () => 1 })).toMatchObject({ type: 'task', taskId: 'advance' });
        const logs: unknown[] = [];
        let accept = false;
        const port: ReminderAlarmPort = {
            parseDate: (date) => date.toISOString(), scheduleAlarm: async () => {
                if (!accept) throw new Error('refused');
                return { id: 42 };
            }, deleteAlarm: () => {}, deleteRepeatingAlarm: () => {}, removeFiredNotification: () => {},
            logInfo: (_message, extra) => { if (extra?.releaseCheck) logs.push(extra); }, logError: () => {},
        };
        await scheduleReminderAlarms(plan, new Map(), port);
        expect(logs).toEqual([]);
        accept = true;
        await scheduleReminderAlarms(plan, new Map(), port);
        expect(logs).toEqual([{ releaseCheck: 'v1.3.8/due-advance-reminder', outcome: 'scheduled' }]);
    });

    it('does not shift a refused advance alarm and still schedules the original due alarm', async () => {
        const plan = planReminderAlarms(input([task({ dueReminderLeadMinutes: 5 })]));
        const advance = plan.oneShot.find((request) => request.config.data?.kind === 'task-due-advance')!;
        const due = plan.oneShot.find((request) => request.key === 'task:advance')!;
        const attempts: unknown[] = [];
        const alarms = new Map<string, ReminderAlarmEntry>();
        let advanceAttempts = 0;
        const port: ReminderAlarmPort = {
            parseDate: (date) => date.toISOString(),
            scheduleAlarm: async (details) => {
                attempts.push(details);
                if (details.fire_date === advance.config.fireAt.toISOString() && ++advanceAttempts === 1) {
                    throw new Error('Duplicate alarm set at date');
                }
                return { id: 42 };
            },
            deleteAlarm: () => {}, deleteRepeatingAlarm: () => {}, removeFiredNotification: () => {},
            logInfo: () => {}, logError: () => {},
        };
        expect(await scheduleReminderAlarms(plan, alarms, port)).toBe(1);
        expect(attempts).toEqual([
            expect.objectContaining({ fire_date: '2026-06-17T09:55:00.000Z', data: expect.objectContaining({ kind: 'task-due-advance' }) }),
            expect.objectContaining({ fire_date: '2026-06-17T10:00:00.000Z', data: expect.objectContaining({ kind: 'task-reminder' }) }),
        ]);
        expect(alarms.has(advance.key)).toBe(false);
        expect(alarms.get(due.key)).toEqual({ id: 42, signature: due.signature });
    });
});

describe('advance reminders across daylight saving transitions', () => {
    const previousZone = process.env.TZ;
    beforeAll(() => { process.env.TZ = 'America/New_York'; });
    afterAll(() => { if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone; });
    it.each([
        ['2026-03-08T09:30:00-04:00', 1440, '2026-03-07T09:30:00-05:00'],
        ['2026-03-09T09:30:00-04:00', 2880, '2026-03-07T09:30:00-05:00'],
        ['2026-03-10T09:30:00-04:00', 10080, '2026-03-03T09:30:00-05:00'],
        ['2026-11-01T09:30:00-05:00', 1440, '2026-10-31T09:30:00-04:00'],
        ['2026-11-03T09:30:00-05:00', 10080, '2026-10-27T09:30:00-04:00'],
        ['2026-03-08T03:30:00-04:00', 60, '2026-03-08T01:30:00-05:00'],
    ])('subtracts %s by %i minutes using calendar days only for whole days', (dueDate, lead, expected) => {
        const plan = getTaskReminderPlan(task({ dueDate, dueReminderLeadMinutes: Number(lead) }), new Date('2026-01-01T00:00:00Z'));
        expect(plan.advance?.scheduledAt.getTime()).toBe(new Date(expected).getTime());
    });
});
