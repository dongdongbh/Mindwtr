import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadTranslations } from './i18n/i18n-loader';
import {
    buildReminderAlarmDetails,
    buildReminderAlarmSignature,
    buildReminderSnooze,
    cancelReminderAlarm,
    cancelUnrequestedReminderAlarms,
    countReminderAlarmCancelReasons,
    findStaleNativeReminderAlarms,
    getDuplicateAlarmRetryFireAt,
    getMaxPendingOneShotReminderAlarms,
    isPomodoroAlarmScheduleSuperseded,
    isPomodoroAlarmUnchanged,
    isPomodoroNativeAlarm,
    planReminderAlarms,
    readPomodoroAlarmEntry,
    readReminderAlarmMap,
    scheduleReminderAlarms,
    shouldRemoveFiredPomodoroAlarm,
    shouldRescheduleReminderAlarms,
    writeReminderAlarmMap,
    type ReminderAlarmEntry,
    type ReminderAlarmPlanInput,
    type ReminderAlarmPort,
} from './mobile-reminder-alarms';
import type { NotificationSettings, Project, Task } from './types';

type Answer = { id: number | string } | { reject: string };
type Cycle = {
    now: string;
    platform?: string;
    trigger?: 'start' | 'exact';
    settings: NotificationSettings;
    tasks: Task[];
    projects?: Project[];
    answers?: Answer[];
};
type Fixture = {
    scenarios: { name: string; storedAlarms?: string; cycles: Cycle[] }[];
    observations: Record<string, { calls: unknown[][]; alarms: Record<string, ReminderAlarmEntry>; error: string | null }[]>;
};

const fixture = JSON.parse(readFileSync(new URL('./reminder-alarms-parity.fixtures.json', import.meta.url), 'utf8')) as Fixture;
const ALARM_MAP_KEY = 'mindwtr:local:alarms:v1';
const LIBRARY_CALLS = new Set(['scheduleAlarm', 'deleteAlarm', 'deleteRepeatingAlarm', 'removeFiredNotification']);
// The log lines the applier writes; the rest of a cycle's log stays React Native's.
const APPLIER_LOG = /^\[Local Notifications\] (Alarm scheduled|Alarm canceled|Failed to delete alarm|Scheduled alarm returned invalid id|Failed to schedule alarm)/;

/** React Native's alarm library as the fixture scripted it, recording calls the way the harness did. */
function recordingPort(answers: Answer[], ids: { next: number }) {
    const calls: unknown[][] = [];
    const port: ReminderAlarmPort = {
        parseDate: (date) => date.toISOString(),
        scheduleAlarm: async (details) => {
            calls.push(['scheduleAlarm', JSON.parse(JSON.stringify(details))]);
            const answer = answers.shift() ?? { id: ids.next++ };
            if ('reject' in answer) throw new Error(answer.reject);
            return { id: answer.id };
        },
        deleteAlarm: (id) => { calls.push(['deleteAlarm', id]); },
        deleteRepeatingAlarm: (id) => { calls.push(['deleteRepeatingAlarm', id]); },
        removeFiredNotification: (id) => { calls.push(['removeFiredNotification', id]); },
        logInfo: (message, extra) => { calls.push(['logInfo', `[Local Notifications] ${message}`, extra ?? null]); },
        logError: (message, error) => {
            calls.push(['logWarn', `[Local Notifications] ${message}`, error ? { error: error instanceof Error ? error.message : String(error) } : null]);
        },
    };
    return { port, calls };
}

describe('mobile reminder alarms', () => {
    const originalTz = process.env.TZ;
    let english: Record<string, string> = {};
    beforeAll(async () => {
        process.env.TZ = 'UTC';
        english = await loadTranslations('en');
    });
    afterAll(() => {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });

    it('replays React Native\'s frozen reconciliation cycles: the same library calls, alarm map, saves and top-up', async () => {
        for (const scenario of fixture.scenarios) {
            const alarms = (() => {
                try {
                    return readReminderAlarmMap(scenario.storedAlarms ?? null);
                } catch {
                    return new Map<string, ReminderAlarmEntry>();
                }
            })();
            const ids = { next: 100 };
            let lastSaved: string | null = null;
            for (const [index, cycle] of scenario.cycles.entries()) {
                const observed = fixture.observations[scenario.name][index];
                const { port, calls } = recordingPort([...(cycle.answers ?? [])], ids);
                const timers: number[] = [];
                let error: string | null = null;
                if (cycle.trigger === 'exact') {
                    for (const key of Array.from(alarms.keys())) await cancelReminderAlarm(alarms, key, port, 'expired');
                }
                const plan = planReminderAlarms({
                    settings: cycle.settings,
                    tasks: cycle.tasks,
                    projects: cycle.projects ?? [],
                    now: new Date(cycle.now),
                    translations: english,
                    maxOneShotReminders: getMaxPendingOneShotReminderAlarms(cycle.platform ?? 'android'),
                    alarms,
                });
                try {
                    await cancelUnrequestedReminderAlarms(plan, alarms, port);
                    if (plan.mode === 'active') {
                        await scheduleReminderAlarms(plan, alarms, port);
                        if (plan.topUpDelayMs !== null) timers.push(plan.topUpDelayMs);
                    }
                } catch (caught) {
                    error = caught instanceof Error ? caught.message : String(caught);
                }
                const counts = countReminderAlarmCancelReasons(plan);
                const reasonLines = error === null
                    ? (['withdrawn', 'expired'] as const).filter((reason) => counts[reason] > 0)
                        .map((reason) => ({ releaseCheck: 'v1.3.4/reminder-withdrawn-clears-tray', reason, count: counts[reason] }))
                    : [];
                const saved = writeReminderAlarmMap(alarms);
                const saves = saved === lastSaved ? [] : [saved];
                lastSaved = saved;

                const where = `${scenario.name} #${index}`;
                expect({ where, calls }).toEqual({
                    where,
                    calls: observed.calls.filter(([kind, message]) => LIBRARY_CALLS.has(kind as string)
                        || ((kind === 'logInfo' || kind === 'logWarn') && APPLIER_LOG.test(message as string))),
                });
                expect({ where, alarms: JSON.parse(JSON.stringify(Object.fromEntries(alarms))) }).toEqual({ where, alarms: observed.alarms });
                expect({ where, error }).toEqual({ where, error: observed.error });
                expect({ where, saves }).toEqual({
                    where,
                    saves: observed.calls.filter(([kind, key]) => kind === 'setItem' && key === ALARM_MAP_KEY).map((call) => call[2]),
                });
                expect({ where, timers }).toEqual({ where, timers: observed.calls.filter(([kind]) => kind === 'setTimeout').map((call) => call[1]) });
                expect({ where, reasonLines }).toEqual({
                    where,
                    reasonLines: observed.calls.filter(([kind, message]) => kind === 'logInfo' && message === '[Local Notifications] Reminder alarms cancelled').map((call) => call[2]),
                });
            }
        }
    });

    const NOW = new Date('2026-09-28T10:00:00.000Z');
    const task = (id: string, fields: Partial<Task> = {}): Task => ({
        id, title: `Task ${id}`, status: 'next', tags: [], contexts: [], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...fields,
    });
    const plan = (fields: Partial<ReminderAlarmPlanInput> = {}) => planReminderAlarms({
        settings: {}, tasks: [], projects: [], now: NOW, translations: english, maxOneShotReminders: 200, alarms: new Map(), ...fields,
    });

    it('never schedules a date-only start or due date', () => {
        const result = plan({ tasks: [task('a', { dueDate: '2026-09-29' }), task('b', { startTime: '2026-09-30' })] });
        expect(result).toMatchObject({ mode: 'active', recurring: [], oneShot: [], schedule: [], topUpDelayMs: null });
        expect(result.diagnostics).toMatchObject({ dateOnlyDueDateCount: 1, dateOnlyStartTimeCount: 1 });
    });

    it('withdraws scheduled and shifted inherited alarms on Skip, then arms Send once without losing repeats or reviews', async () => {
        const tasks = [task('a', { reminderPolicy: 'inherit', dueDate: '2026-09-28T11:00:00.000Z', repeatReminderMinutes: 30 }),
            task('review', { reminderPolicy: 'inherit', reviewAt: '2026-09-28T12:00:00.000Z' })];
        const first = plan({ tasks, settings: { taskReminderDefault: 'send' } });
        const alarms = new Map(first.oneShot.map((request, index): [string, ReminderAlarmEntry] => [request.key, { id: index + 1, signature: request.signature }]));
        const skipped = plan({ tasks, alarms, settings: { taskReminderDefault: 'skip' } });
        expect(skipped.cancel).toEqual(['task:a', 'task:a:r1', 'task:a:r2', 'task:a:r3', 'task:a:r4']);
        expect(Object.values(skipped.reasons)).toEqual(Array(5).fill('withdrawn'));
        expect(skipped.keep).toEqual(['task:review']);
        const { port, calls } = recordingPort([], { next: 20 });
        await cancelUnrequestedReminderAlarms(skipped, alarms, port);
        expect(calls.filter(([kind]) => kind === 'removeFiredNotification')).toHaveLength(5);
        const sent = plan({ tasks, alarms, settings: { taskReminderDefault: 'send' } });
        expect(sent.schedule).toEqual(['task:a', 'task:a:r1', 'task:a:r2', 'task:a:r3', 'task:a:r4']);
        await scheduleReminderAlarms(sent, alarms, port);
        expect(plan({ tasks, alarms, settings: { taskReminderDefault: 'send' } }).schedule).toEqual([]);
        expect(tasks[0].repeatReminderMinutes).toBe(30);
        // An already due alarm shifted by the OS is withdrawn too, rather than carried forward.
        const shifted = new Map([['task:a', { id: 1, signature: first.oneShot[0].signature, fireAtMs: Date.parse('2026-09-28T11:01:00.000Z') }]]);
        expect(plan({ tasks, alarms: shifted, now: new Date('2026-09-28T11:00:30.000Z'), settings: { taskReminderDefault: 'skip' } }))
            .toMatchObject({ shifted: [], cancel: ['task:a'], reasons: { 'task:a': 'withdrawn' } });
    });

    it('cancels every held alarm without notification permission, and when no reminder feature is on', () => {
        const alarms = new Map<string, ReminderAlarmEntry>([['digest:morning', { id: 1, signature: 's' }], ['task:a', { id: 2 }]]);
        const tasks = [task('a', { dueDate: '2026-09-28T11:00:00.000Z' })];
        expect(plan({ alarms, tasks, settings: { dailyDigestMorningEnabled: true }, permissionGranted: false }))
            .toMatchObject({ mode: 'revoked', cancel: ['digest:morning', 'task:a'], schedule: [], keep: [], diagnostics: null });
        expect(plan({ alarms, tasks, settings: { notificationsEnabled: false } }))
            .toMatchObject({ mode: 'inactive', cancel: ['digest:morning', 'task:a'], schedule: [], keep: [] });
    });

    it('keeps a matching alarm, remakes a changed or pending one, and cancels one no longer requested', () => {
        const tasks = [task('same', { dueDate: '2026-09-28T11:00:00.000Z' }), task('moved', { dueDate: '2026-09-28T12:00:00.000Z' }), task('pending', { dueDate: '2026-09-28T13:00:00.000Z' })];
        const first = plan({ tasks });
        const signature = (key: string) => first.oneShot.find((request) => request.key === key)!.signature;
        const alarms = new Map<string, ReminderAlarmEntry>([
            ['task:same', { id: 1, signature: signature('task:same') }],
            ['task:moved', { id: 2, signature: 'before the move' }],
            ['task:pending', { id: 3, signature: signature('task:pending'), pending: true }],
            ['task:gone', { id: 4, signature: 'x' }],
        ]);
        expect(plan({ tasks, alarms })).toMatchObject({ keep: ['task:same'], schedule: ['task:moved', 'task:pending'], cancel: ['task:gone'] });
    });

    it('withdraws an alarm whose reminder no longer holds and lets one whose time only passed expire', () => {
        const due = '2026-09-28T09:00:00.000Z';
        const fired = (tasks: Task[], fields: Partial<ReminderAlarmPlanInput> = {}) => {
            const before = planReminderAlarms({
                settings: {}, tasks, projects: [], now: new Date('2026-09-28T08:00:00.000Z'), translations: english, maxOneShotReminders: 200, alarms: new Map(),
            });
            const alarms = new Map(before.oneShot.map((request, index): [string, ReminderAlarmEntry] => [request.key, { id: index + 1, signature: request.signature }]));
            return (after: Task[], settings: NotificationSettings = {}) => plan({ tasks: after, alarms, settings, ...fields }).reasons;
        };
        const live = task('a', { dueDate: due });
        const after = fired([live]);
        expect(after([live])).toEqual({ 'task:a': 'expired' });
        expect(after([{ ...live, status: 'done' }])).toEqual({ 'task:a': 'withdrawn' });
        expect(after([])).toEqual({ 'task:a': 'withdrawn' });
        expect(after([{ ...live, dueDate: '2026-09-28T09:30:00.000Z' }])).toEqual({ 'task:a': 'withdrawn' });
        expect(after([{ ...live, dueDate: '2026-09-28' }])).toEqual({ 'task:a': 'withdrawn' });
        expect(after([live], { dueDateNotificationsEnabled: false })).toEqual({ 'task:a': 'withdrawn' });
        expect(after([live], { notificationsEnabled: false, weeklyReviewEnabled: true })).toEqual({ 'task:a': 'withdrawn' });
        // The start reminder fired; the same key moves on to the due reminder.
        const both = task('b', { startTime: due, dueDate: '2026-09-28T12:00:00.000Z' });
        expect(fired([both])([both])).toEqual({ 'task:b': 'expired' });
        // A project review whose project was archived.
        const project: Project = { id: 'p', title: 'P', status: 'active', color: '#000', order: 0, tagIds: [], reviewAt: due, createdAt: '', updatedAt: '' };
        const alarms = new Map<string, ReminderAlarmEntry>([['project:p', { id: 9, signature: JSON.stringify({ fireAt: due }) }], ['legacy', { id: 8 }]]);
        expect(plan({ alarms, projects: [project] }).reasons).toEqual({ 'project:p': 'expired', legacy: 'withdrawn' });
        expect(plan({ alarms, projects: [{ ...project, status: 'archived' }] }).reasons).toEqual({ 'project:p': 'withdrawn', legacy: 'withdrawn' });
        expect(plan({ alarms, permissionGranted: false }).reasons).toEqual({ 'project:p': 'withdrawn', legacy: 'withdrawn' });
    });

    it('lets a remade digest expire and withdraws a digest turned off', () => {
        const settings = { notificationsEnabled: false, dailyDigestMorningEnabled: true, dailyDigestEveningEnabled: true };
        const first = plan({ settings });
        const alarms = new Map(first.recurring.map((request, index): [string, ReminderAlarmEntry] => [request.key, { id: index + 1, signature: request.signature }]));
        expect(plan({ alarms, settings: { ...settings, dailyDigestMorningTime: '10:00', dailyDigestEveningEnabled: false } }).reasons)
            .toEqual({ 'digest:morning': 'expired', 'digest:evening': 'withdrawn' });
    });

    it('removes a withdrawn alarm\'s delivered notification before deleting its row, and never an expired one\'s', async () => {
        const { port, calls } = recordingPort([], { next: 1 });
        const alarms = new Map<string, ReminderAlarmEntry>([['a', { id: 1 }], ['b', { id: 2 }]]);
        await cancelReminderAlarm(alarms, 'a', port, 'withdrawn');
        await cancelReminderAlarm(alarms, 'b', port, 'expired');
        expect(calls.filter(([kind]) => kind !== 'logInfo')).toEqual([
            ['removeFiredNotification', 1], ['deleteAlarm', 1], ['deleteRepeatingAlarm', 1],
            ['deleteAlarm', 2], ['deleteRepeatingAlarm', 2],
        ]);
    });

    it('caps one-shots soonest first and tops up 5 s after the soonest fires', () => {
        const tasks = Array.from({ length: 5 }, (_, index) => task(`t${index}`, { dueDate: new Date(NOW.getTime() + (index + 1) * 60_000).toISOString() }));
        const result = plan({ tasks: [...tasks].reverse(), maxOneShotReminders: 3 });
        expect(result.oneShot.map((request) => request.key)).toEqual(['task:t0', 'task:t1', 'task:t2']);
        expect(result.topUpDelayMs).toBe(65_000);
        expect(result.diagnostics?.oneShotReminderCount).toBe(5);
        // A reminder due in two days waits at most a day for the next top-up.
        expect(plan({ tasks: [task('far', { dueDate: '2026-09-30T10:00:00.000Z' })] }).topUpDelayMs).toBe(24 * 60 * 60 * 1000);
    });

    it('keeps a reminder moved past a taken minute armed until it rings, across a top-up', async () => {
        // Android's library refuses a second alarm in a minute it already holds.
        const taken = new Set<string>();
        const { port, calls } = recordingPort([], { next: 1 });
        const recordedSchedule = port.scheduleAlarm;
        port.scheduleAlarm = async (details) => {
            const minute = String(details.fire_date).slice(0, 16);
            if (taken.has(minute)) throw new Error('duplicate alarm set at date');
            taken.add(minute);
            return recordedSchedule(details);
        };
        const tasks = [
            task('a', { dueDate: '2026-09-28T11:00:00.000Z' }),
            // Its key moves on to the due reminder once the start time passes.
            task('b', { startTime: '2026-09-28T11:00:00.000Z', dueDate: '2026-09-28T12:00:00.000Z' }),
            task('c', { dueDate: '2026-09-28T11:00:00.000Z' }),
        ];
        const alarms = new Map<string, ReminderAlarmEntry>();
        const cycle = async (now: string) => {
            const result = plan({ tasks, alarms, now: new Date(now) });
            await scheduleReminderAlarms(result, alarms, port);
            await cancelUnrequestedReminderAlarms(result, alarms, port);
            return result;
        };
        await cycle('2026-09-28T10:00:00.000Z');
        const armed = Object.fromEntries(Array.from(alarms, ([key, entry]) => [key, entry.id]));
        expect(Array.from(taken).sort()).toEqual(['2026-09-28T11:00', '2026-09-28T11:01', '2026-09-28T11:02']);

        calls.length = 0;
        // The top-up 5 s after the 11:00 alarm rang.
        const topUp = await cycle('2026-09-28T11:00:05.000Z');
        const deleted = calls.filter(([kind]) => kind === 'deleteAlarm').map(([, id]) => id);
        expect(deleted).toEqual([armed['task:a']]);
        expect(alarms.get('task:b')?.id).toBe(armed['task:b']);
        expect(alarms.get('task:c')?.id).toBe(armed['task:c']);
        // The next cycle runs 5 s after the moved 11:01 alarm rings.
        expect(topUp.topUpDelayMs).toBe(60_000);

        calls.length = 0;
        await cycle('2026-09-28T11:01:05.000Z');
        // b rang at 11:01; its due reminder is armed now. c still waits for 11:02.
        expect(calls.filter(([kind]) => kind === 'deleteAlarm').map(([, id]) => id)).toEqual([armed['task:b']]);
        expect(alarms.get('task:c')?.id).toBe(armed['task:c']);
        expect(alarms.get('task:b')?.signature).toContain('2026-09-28T12:00:00.000Z');
    });

    it('counts a kept minute-shifted alarm against the one-shot cap', () => {
        const cap = getMaxPendingOneShotReminderAlarms('ios');
        const shiftedTask = task('s', { dueDate: '2026-09-28T10:00:00.000Z' });
        const [held] = plan({ tasks: [shiftedTask], now: new Date('2026-09-28T09:00:00.000Z') }).oneShot;
        // Its 10:00 minute was taken, so it rings at 10:01; this cycle runs at 10:00:05.
        const alarms = new Map<string, ReminderAlarmEntry>([['task:s', { id: 1, signature: held.signature, fireAtMs: Date.parse('2026-09-28T10:01:00.000Z') }]]);
        const tasks = [shiftedTask, ...Array.from({ length: cap }, (_, index) => task(`t${index}`, {
            dueDate: new Date(NOW.getTime() + (index + 1) * 60 * 60_000).toISOString(),
        }))];
        const result = plan({ tasks, alarms, now: new Date('2026-09-28T10:00:05.000Z'), maxOneShotReminders: cap });
        expect(result.shifted).toEqual(['task:s']);
        const pending = new Set([...result.oneShot.map((request) => request.key), ...result.shifted]);
        expect(pending.size).toBeLessThanOrEqual(cap);
        // The latest-firing new reminder waits for a later top-up.
        expect(result.oneShot.map((request) => request.key)).not.toContain(`task:t${cap - 1}`);
        expect(result.oneShot).toHaveLength(cap - 1);
    });

    it('keys a repeating alarm by its local time of day and weekday', () => {
        const config = { title: 'Weekly review', message: 'Body', fireAt: new Date('2026-09-29T18:30:00.000Z'), repeatInterval: 'weekly' as const };
        expect(JSON.parse(buildReminderAlarmSignature(config)).fireAt).toBe('weekly:2:18:30');
        expect(buildReminderAlarmSignature({ ...config, fireAt: new Date('2026-10-06T18:30:00.000Z') })).toBe(buildReminderAlarmSignature(config));
    });

    it('re-arms a repeating alarm after a time zone change, at the same local time', () => {
        const config = { title: 'Morning', message: 'Body', fireAt: new Date('2026-09-29T08:00:00.000Z'), repeatInterval: 'daily' as const };
        expect(buildReminderAlarmSignature(config, 'America/New_York')).not.toBe(buildReminderAlarmSignature(config, 'Europe/Berlin'));
        const settings = { notificationsEnabled: false, dailyDigestMorningEnabled: true };
        try {
            process.env.TZ = 'America/New_York';
            const first = plan({ settings });
            const alarms = new Map(first.recurring.map((request, index): [string, ReminderAlarmEntry] => [request.key, { id: index + 1, signature: request.signature }]));
            expect(plan({ settings, alarms }).keep).toEqual(['digest:morning']);
            process.env.TZ = 'Europe/Berlin';
            expect(plan({ settings, alarms }).schedule).toEqual(['digest:morning']);
        } finally {
            process.env.TZ = 'UTC';
        }
    });

    it('posts every reminder of a task into the task\'s one notification slot', () => {
        const config = { title: 'Call back', message: 'Due', fireAt: new Date('2026-09-28T10:20:00.000Z'), hasSnoozeAction: true };
        const due = buildReminderAlarmDetails('task:t-1', config);
        expect(due.tag).toBe('mindwtr-reminder:task:t-1');
        expect(buildReminderAlarmDetails('task:t-1:r3', config).tag).toBe(due.tag);
        expect(buildReminderAlarmDetails('task:t-2:r3', config).tag).not.toBe(due.tag);
        expect(buildReminderSnooze(due, Date.parse('2026-09-28T10:21:00.000Z'), 'snooze:1')?.details.tag).toBe(due.tag);
    });

    it('snoozes as a new one-shot of the same reminder, named by the tap so a replay replaces it', () => {
        const details = { title: 'Pay rent', message: 'Due', schedule_type: 'once', snooze_interval: 10, data: { taskId: 't', alarmKey: 'task:t' } };
        const requestedAt = Date.parse('2026-09-28T10:03:27.400Z');
        const snooze = buildReminderSnooze(details, requestedAt, 'snooze:1');
        expect(snooze).toEqual({ key: 'snooze:1', fireAtMs: Date.parse('2026-09-28T10:13:27.000Z'), details: { ...details, schedule_type: 'once' } });
        expect(snooze?.details.data).not.toBe(details.data);
        expect(buildReminderSnooze(details, requestedAt, 'snooze:1')).toEqual(snooze);
        expect(buildReminderSnooze({ title: 'Morning briefing', data: {} }, requestedAt, 'snooze:2')).toBeNull();
    });

    it('re-arms on task or project changes and reminder settings, not on sync bookkeeping', () => {
        const tasks: Task[] = [];
        const projects: Project[] = [];
        const settings = { notificationsEnabled: true, lastSyncAt: 'a' } as NotificationSettings;
        const base = { tasks, projects, settings };
        expect(shouldRescheduleReminderAlarms({ ...base }, base)).toBe(false);
        expect(shouldRescheduleReminderAlarms({ ...base, settings: { ...settings, lastSyncAt: 'b' } as NotificationSettings }, base)).toBe(false);
        expect(shouldRescheduleReminderAlarms({ ...base, tasks: [] }, base)).toBe(true);
        expect(shouldRescheduleReminderAlarms({ ...base, settings: { ...settings, taskReminderDefault: 'skip' } }, base)).toBe(true);
        expect(shouldRescheduleReminderAlarms(base, { ...base, settings: { ...settings, taskReminderDefault: 'skip' } })).toBe(true);
        expect(shouldRescheduleReminderAlarms({ ...base, settings: { ...settings, language: 'de' } as NotificationSettings }, base)).toBe(true);
        expect(shouldRescheduleReminderAlarms({ ...base, settings: { ...settings, weeklyReviewTime: '09:00' } }, base)).toBe(true);
    });

    it('reads alarm and Pomodoro entries tolerantly', () => {
        expect(Object.fromEntries(readReminderAlarmMap('{"a":{"id":2.9,"signature":"s"},"b":{"id":"x"},"c":null,"d":{"id":4,"pending":true}}')))
            .toEqual({ a: { id: 2, signature: 's' }, d: { id: 4, pending: true } });
        expect(() => readReminderAlarmMap('{')).toThrow();
        expect(readPomodoroAlarmEntry('{"id":"3","fireAtMs":10,"phase":"focus"}')).toEqual({ id: 3, fireAtMs: 10, phase: 'focus' });
        expect(readPomodoroAlarmEntry('{"phase":"focus"}')).toBeNull();
    });

    it('keeps the Pomodoro alarm rules', () => {
        expect(isPomodoroAlarmScheduleSuperseded({ order: 2, requestedAtMs: 5, reason: 'paused' }, 1, 10)).toBe(true);
        // A timer that stopped on its own after the deadline keeps the due alarm.
        expect(isPomodoroAlarmScheduleSuperseded({ order: 2, requestedAtMs: 20, reason: 'timer-not-running' }, 1, 10)).toBe(false);
        expect(isPomodoroAlarmUnchanged({ fireAtMs: 10 }, 10, 'break')).toBe(true);
        expect(isPomodoroAlarmUnchanged({ fireAtMs: 10, phase: 'focus' }, 10, 'break')).toBe(false);
        expect(shouldRemoveFiredPomodoroAlarm({ reason: 'timer-not-running', entry: { id: 1, fireAtMs: 10 }, id: 1, requestedAtMs: 20 })).toBe(false);
        expect(shouldRemoveFiredPomodoroAlarm({ reason: 'paused', entry: { id: 1, fireAtMs: 10 }, id: 1, requestedAtMs: 20 })).toBe(true);
        expect(isPomodoroNativeAlarm({ data: '{"kind":"pomodoro"}' })).toBe(true);
        expect(isPomodoroNativeAlarm({ data: 'alarmKey==>x;;kind==>pomodoro' })).toBe(true);
        expect(isPomodoroNativeAlarm({ data: { kind: 'task-reminder' } })).toBe(false);
    });

    it('withdraws legacy native start/due carryforward for effective Skip while leaving reviews and Pomodoro alone', () => {
        const row = (id: number, kind: string, alarmKey = 'task:live') => ({ id, scheduleType: 'once',
            year: 2099, month: 1, day: 1, hour: 9, minute: 0, second: 0, data: { kind, alarmKey } });
        const rows = [row(1, 'task-start'), row(2, 'task-due'), row(3, 'task-reminder', 'task:live:r1'),
            row(4, 'task-review'), row(5, 'pomodoro')];
        const input = { rows, trackedIds: new Set<number>(), tasks: [task('live', { reminderPolicy: 'inherit' })], projects: [], now: NOW };
        expect(findStaleNativeReminderAlarms({ ...input, settings: { taskReminderDefault: 'skip' } }))
            .toEqual([1, 2, 3].map((id) => ({ id, reason: 'withdrawn' })));
        expect(findStaleNativeReminderAlarms({ ...input, settings: { taskReminderDefault: 'send' } })).toEqual([]);
    });

    it('lists the Android rows the alarm map lost and nothing still wants, sparing a live snooze', () => {
        // Synthetic shape from feedback f488a81a: old start reminders for finished tasks.
        // The reporter's reboot trigger and exact orphan path remain unproved.
        const at = (date: Date, id: number, alarmKey: string, scheduleType = 'once') => ({
            id, scheduleType, data: `kind==>task-reminder;;alarmKey==>${alarmKey};;`,
            year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(),
            hour: date.getHours(), minute: date.getMinutes(), second: date.getSeconds(),
        });
        const past = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000);
        const soon = new Date(NOW.getTime() + 10 * 60 * 1000);
        const justLate = new Date(NOW.getTime() - 60 * 1000);
        const tooLate = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
        const rows = [
            at(soon, 1, 'task:live'), // tracked
            at(soon, 2, 'task:done'), // lost id, task done before its start
            at(past, 3, 'task:gone'), // lost id, task deleted
            at(soon, 4, 'task:live'), // pending snooze of a live task
            at(past, 5, 'task:live:r1'), // fired snooze or lost repeat of a live task
            at(soon, 6, 'digest:morning', 'repeat'), // lost digest copy
            at(soon, 7, 'project:archived'),
            { ...at(past, 8, 'task:done'), data: 'kind==>pomodoro;;taskId==>done;;' },
            { id: 'bad' },
            { ...at(past, 7.5, 'task:done') },
            { ...at(past, 0, 'task:done'), id: null },
            { ...at(past, 0, 'task:done'), id: '' },
            at(justLate, 9, 'task:live'), // Android may deliver this pending snooze late
            at(tooLate, 10, 'task:live'), // past the native grace window
        ];
        expect(findStaleNativeReminderAlarms({
            rows,
            trackedIds: new Set([1]),
            tasks: [task('live'), task('done', { status: 'done' }), task('gone', { deletedAt: '2026-09-27T00:00:00.000Z' })],
            projects: [{ id: 'archived', title: 'P', status: 'archived', color: '#000', order: 0, tagIds: [], createdAt: '', updatedAt: '' } as Project],
            now: NOW,
        })).toEqual([
            { id: 2, reason: 'withdrawn' },
            { id: 3, reason: 'withdrawn' },
            { id: 5, reason: 'expired' },
            { id: 6, reason: 'expired' },
            { id: 7, reason: 'withdrawn' },
            { id: 10, reason: 'expired' },
        ]);
        expect(findStaleNativeReminderAlarms({ rows: null, trackedIds: new Set(), tasks: [], projects: [], now: NOW })).toEqual([]);
    });
});

describe('getDuplicateAlarmRetryFireAt', () => {
    it('keeps the first attempt at the original time', () => {
        const baseFireAt = new Date('2026-03-06T23:38:00.000Z');

        expect(getDuplicateAlarmRetryFireAt(baseFireAt, 0).toISOString()).toBe('2026-03-06T23:38:00.000Z');
    });

    it('moves duplicate retries to later minutes instead of later seconds', () => {
        const baseFireAt = new Date('2026-03-06T23:38:00.000Z');

        expect(getDuplicateAlarmRetryFireAt(baseFireAt, 1).toISOString()).toBe('2026-03-06T23:39:00.000Z');
        expect(getDuplicateAlarmRetryFireAt(baseFireAt, 2).toISOString()).toBe('2026-03-06T23:40:00.000Z');
    });

    it('preserves the original seconds while shifting to the next minute bucket', () => {
        const baseFireAt = new Date('2026-03-06T23:38:27.000Z');

        expect(getDuplicateAlarmRetryFireAt(baseFireAt, 1).toISOString()).toBe('2026-03-06T23:39:27.000Z');
    });
});
