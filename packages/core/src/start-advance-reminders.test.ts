import { describe, expect, it } from 'vitest';
import { buildReminderSchedule, getTaskReminderPlan, normalizeStartReminderLeadMinutes, resolveDueReminders, getReminderNotificationTag } from './schedule-utils';
import { planReminderAlarms, scheduleReminderAlarms, isReminderOwnerGone, findStaleNativeReminderAlarms, buildReminderAlarmDetails, type ReminderAlarmEntry, type ReminderAlarmPort } from './mobile-reminder-alarms';
import { createTaskDraft } from './task-draft';
import { getTaskEditorReminders } from './task-editor-schedule';
import type { Task } from './types';

const now = new Date('2026-06-17T08:00:00Z');
const task = (patch: Partial<Task> = {}): Task => ({
    id: 'start-advance', title: 'Prepare', status: 'next', contexts: [], tags: [],
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
    startTime: '2026-06-17T10:00:00Z', startReminderLeadMinutes: 15, ...patch,
});
const input = (value = task(), alarms = new Map<string, ReminderAlarmEntry>()) => ({
    tasks: [value], projects: [], settings: { notificationsEnabled: true }, now, translations: {}, maxOneShotReminders: 200, alarms,
});

describe('start advance reminders', () => {
    it('adds an exact earlier alert while retaining the real start time and its alert', () => {
        const value = task();
        const before = structuredClone(value);
        const plan = getTaskReminderPlan(value, now);
        expect(plan.startAdvance).toMatchObject({ kind: 'start-advance', scheduledAt: new Date('2026-06-17T09:45:00Z') });
        expect(plan.next).toMatchObject({ kind: 'start', scheduledAt: new Date(value.startTime!) });
        expect(plan.advance).toBeNull();
        expect(value).toEqual(before);
        expect(buildReminderSchedule(input()).requests.map((entry) => [entry.fireAt.toISOString(), entry.data.kind])).toEqual([
            ['2026-06-17T09:45:00.000Z', 'task-start-advance'], ['2026-06-17T10:00:00.000Z', 'task-reminder'],
        ]);
        expect(resolveDueReminders(input(), { from: new Date('2026-06-17T09:44:59Z'), to: new Date('2026-06-17T09:45:00Z') })[0].data.kind).toBe('task-start-advance');
    });

    it.each([
        { startTime: undefined }, { startTime: '2026-06-17' }, { startTime: 'broken' }, { startReminderLeadMinutes: undefined },
        { startReminderLeadMinutes: 0 }, { startReminderLeadMinutes: -1 }, { startReminderLeadMinutes: 1 },
        { startReminderLeadMinutes: 1.5 }, { startReminderLeadMinutes: 61 }, { startTime: '2026-06-17T08:15:00Z' },
        { startTime: '2026-06-17T08:10:00Z' }, { status: 'done' }, { status: 'archived' }, { status: 'archived', cancelledAt: now.toISOString() },
        { status: 'reference' }, { deletedAt: now.toISOString() }, { reminderPolicy: 'skip' }, { suppressMindwtrReminders: true },
    ] satisfies Partial<Task>[])('never arms an invalid, inactive, date-only or missed prealert: %j', (patch) => {
        expect(getTaskReminderPlan(task(patch), now).startAdvance).toBeNull();
    });

    it('uses the start toggle and Send/Skip policy independently from due settings', () => {
        expect(getTaskReminderPlan(task(), now, { includeDueDate: false }).startAdvance).not.toBeNull();
        expect(getTaskReminderPlan(task(), now, { includeStartTime: false }).startAdvance).toBeNull();
        expect(getTaskReminderPlan(task({ reminderPolicy: 'inherit' }), now, { taskReminderDefault: 'skip' }).startAdvance).toBeNull();
        expect(getTaskReminderPlan(task({ reminderPolicy: 'send' }), now, { taskReminderDefault: 'skip' }).startAdvance).not.toBeNull();
        expect(buildReminderSchedule({ ...input(), settings: { startDateNotificationsEnabled: false } }).requests).toEqual([]);
    });

    it('withdraws old identities on edits, Off, date removal, Skip, completion and permission changes', () => {
        const first = planReminderAlarms(input());
        const advance = first.oneShot.find((entry) => entry.config.data?.kind === 'task-start-advance')!;
        const alarms = new Map([[advance.key, { id: 99, signature: advance.signature }]]);
        for (const patch of [
            { startTime: '2026-06-17T11:00:00Z' }, { startReminderLeadMinutes: 30 }, { startReminderLeadMinutes: 0 },
            { startTime: undefined }, { startTime: '2026-06-17' }, { status: 'done' }, { deletedAt: now.toISOString() }, { reminderPolicy: 'skip' },
        ] satisfies Partial<Task>[]) {
            const plan = planReminderAlarms(input(task(patch), alarms));
            expect(plan.cancel).toContain(advance.key);
            expect(plan.schedule).not.toContain(advance.key);
        }
        expect(planReminderAlarms({ ...input(task(), alarms), settings: { startDateNotificationsEnabled: false } }).cancel).toContain(advance.key);
        expect(planReminderAlarms({ ...input(task(), alarms), permissionGranted: false }).cancel).toContain(advance.key);
        expect(planReminderAlarms(input(task(), alarms)).schedule).not.toContain(advance.key);
    });

    it.each([
        { dueDate: '2026-06-17T09:45:00Z' },
        { dueDate: '2026-06-17T10:45:00Z', dueReminderLeadMinutes: 60 },
        { dueDate: '2026-06-17T09:30:00Z', repeatReminderMinutes: 15 },
    ] satisfies Partial<Task>[])('deduplicates a start prealert matching another task alert: %j', (patch) => {
        const at = buildReminderSchedule(input(task(patch))).requests.filter((entry) => entry.fireAt.toISOString() === '2026-06-17T09:45:00.000Z');
        expect(at).toHaveLength(1);
    });

    it('retains live native owners and task tray grouping, and cleans up skipped or finished owners', () => {
        const value = task();
        const advance = planReminderAlarms(input(value)).oneShot.find((entry) => entry.config.data?.kind === 'task-start-advance')!;
        const details = buildReminderAlarmDetails(advance.key, advance.config);
        expect(details).toMatchObject({ tag: getReminderNotificationTag('task:start-advance'), has_complete_action: true, snooze_interval: 10 });
        expect(isReminderOwnerGone(advance.key, new Map([[value.id, value]]), new Map())).toBe(false);
        const at = advance.config.fireAt;
        const rows = [{ id: 99, scheduleType: 'once', year: at.getFullYear(), month: at.getMonth() + 1,
            day: at.getDate(), hour: at.getHours(), minute: at.getMinutes(), second: at.getSeconds(), data: details.data }];
        const cleanup = (owner: Task) => findStaleNativeReminderAlarms({ rows, trackedIds: new Set(), tasks: [owner], projects: [], now });
        expect(cleanup(value)).toEqual([]);
        expect(cleanup({ ...value, reminderPolicy: 'skip' })).toEqual([{ id: 99, reason: 'withdrawn' }]);
        expect(cleanup({ ...value, status: 'done' })).toEqual([{ id: 99, reason: 'withdrawn' }]);
    });

    it('records a content-free scheduling receipt only after acceptance and never shifts a refused prealert', async () => {
        const plan = planReminderAlarms(input());
        const logs: unknown[] = [];
        const calls: string[] = [];
        let accept = false;
        const port: ReminderAlarmPort = {
            parseDate: (date) => date.toISOString(), scheduleAlarm: async (details) => {
                if (details.data?.kind === 'task-start-advance') {
                    calls.push(details.fire_date);
                    if (!accept) throw new Error('Duplicate alarm set at date');
                }
                return { id: 42 };
            }, deleteAlarm: () => {}, deleteRepeatingAlarm: () => {}, removeFiredNotification: () => {},
            logInfo: (_message, extra) => { if (extra?.releaseCheck) logs.push(extra); }, logError: () => {},
        };
        await scheduleReminderAlarms(plan, new Map(), port);
        expect(logs).toEqual([]);
        expect(calls).toEqual(['2026-06-17T09:45:00.000Z']);
        accept = true;
        await scheduleReminderAlarms(plan, new Map(), port);
        expect(logs).toEqual([{ releaseCheck: 'v1.3.8/start-advance-reminder', outcome: 'scheduled' }]);
    });

    it('offers only the start presets beside a timed start, preserving hidden preferences', () => {
        for (const lead of [0, 5, 15, 30, 60]) expect(normalizeStartReminderLeadMinutes(lead)).toBe(lead);
        for (const lead of [undefined, null, '15', 1, 61, Infinity, NaN]) expect(normalizeStartReminderLeadMinutes(lead)).toBeUndefined();
        const timed = createTaskDraft(task());
        const model = getTaskEditorReminders(timed, (key) => key);
        expect(model.startAdvance?.options.map((entry) => entry.value)).toEqual([0, 5, 15, 30, 60]);
        expect(getTaskEditorReminders({ ...timed, startTime: '2026-06-17' }, (key) => key).startAdvance).toBeNull();
        expect(getTaskEditorReminders({ ...timed, reminderPolicy: 'skip' }, (key) => key).startAdvance?.enabled).toBe(false);
        expect(timed.startReminderLeadMinutes).toBe(15);
    });
});
