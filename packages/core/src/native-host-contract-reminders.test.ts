import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadTranslations } from './i18n/i18n-loader';
import * as i18nLoader from './i18n/i18n-loader';
import { getDigestSchedule } from './schedule-utils';
import { buildReminderAlarmDetails, planReminderAlarms, readReminderAlarmMap } from './mobile-reminder-alarms';
import { createNativeHostContract, type NativeHostResult } from './native-host-contract';
import { openSqliteHost, requestId as newRequestId } from './screen-parity.replay';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppSettings, Task } from './types';
import { generateUUID } from './uuid';
import { consoleLogger, setLogger, type LogPayload } from './logger';

const NOW = '2026-09-28T10:00:00.000Z';
const T0 = '2026-09-01T10:00:00.000Z';
const task = (fields: Partial<Task> & Pick<Task, 'id'>): Task => ({
    title: `Task ${fields.id}`, status: 'next', tags: [], contexts: [], createdAt: T0, updatedAt: T0, ...fields,
});
const TASKS: Task[] = [
    task({ id: 't-rent', title: 'Pay rent', description: 'Bring the keys', dueDate: '2026-09-28T11:00:00.000Z' }),
    task({ id: 't-standup', title: 'Standup', dueDate: '2026-09-28T12:00:00.000Z', recurrence: { rule: 'daily', strategy: 'strict' } }),
    task({ id: 't-call', title: 'Call back', dueDate: '2026-09-28T10:20:00.000Z', repeatReminderMinutes: 30 }),
    task({ id: 't-review', title: 'Review proposal', reviewAt: '2026-09-28T15:00:00.000Z' }),
    task({ id: 't-date-only', title: 'Date only', dueDate: '2026-09-29' }),
    task({ id: 't-done', title: 'Finished', status: 'done', dueDate: '2026-09-28T13:00:00.000Z' }),
    task({ id: 't-deleted', title: 'Gone', dueDate: '2026-09-28T13:00:00.000Z', deletedAt: T0 }),
];
const SETTINGS: Partial<AppSettings> = { dailyDigestMorningEnabled: true, weeklyReviewEnabled: true };

type Host = ReturnType<typeof createNativeHostContract>;
const saveData = vi.fn(async (_data: unknown) => undefined);
let realUpdateTask: ((...args: any[]) => Promise<any>) | null = null;
const updates: unknown[][] = [];

async function seed(settings: Partial<AppSettings> = SETTINGS, tasks: Task[] = TASKS) {
    await flushPendingSave();
    resetForTests();
    realUpdateTask ??= useTaskStore.getState().updateTask;
    const real = realUpdateTask;
    let data = JSON.parse(JSON.stringify({ tasks, projects: [], sections: [], areas: [], people: [], settings }));
    setStorageAdapter({
        getData: async () => data,
        saveData: async (next) => {
            await saveData(next);
            data = JSON.parse(JSON.stringify(next));
        },
    });
    useTaskStore.setState({
        updateTask: real,
        _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
    } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    useTaskStore.setState({
        updateTask: async (id: string, patch: Partial<Task>) => { updates.push([id, patch]); return real(id, patch); },
    } as never);
    updates.length = 0;
    saveData.mockClear();
}

/** A new host on the loaded store, as after a restart: no receipts, no counters. */
async function openHost(reminderPlatform?: 'android' | 'ios'): Promise<Host> {
    const host = reminderPlatform ? createNativeHostContract({ reminderPlatform }) : createNativeHostContract();
    expect(await host.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' })).toMatchObject({ ok: true });
    expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
    return host;
}

const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const invalid = { ok: false, error: { code: 'INVALID_INPUT' } };
const openFollowUps = (id: string) => useTaskStore.getState()._allTasks.filter((entry) => entry.id !== id && entry.title === 'Standup' && entry.status !== 'done');

describe('native host contract: reminders', () => {
    const originalTz = process.env.TZ;
    beforeAll(() => {
        process.env.TZ = 'UTC';
    });
    afterAll(() => {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });
    afterEach(async () => {
        vi.useRealTimers();
        await flushPendingSave();
        resetForTests();
        saveData.mockReset();
        saveData.mockImplementation(async () => undefined);
    });
    const freezeClock = () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
    };

    it.each([undefined, 'android' as const])('keeps all Android/default alarm fields and saved maps unchanged (%s)', async (platform) => {
        freezeClock(); await seed({ ...SETTINGS, dailyDigestEveningEnabled: true });
        const android = value(await (await openHost(platform)).planReminderAlarms({ storedAlarms: null, permissionGranted: true }));
        expect(android.schedule.every((alarm) => !Object.hasOwn(alarm, 'calendar'))).toBe(true);
        const ios = value(await (await openHost('ios')).planReminderAlarms({ storedAlarms: null, permissionGranted: true }));
        expect({ ...ios, schedule: ios.schedule.map(({ calendar: _calendar, ...alarm }) => alarm) }).toEqual(android);
        expect(ios.alarms).not.toContain('calendar'); expect(ios.writeAhead).not.toContain('calendar');
        expect(saveData).not.toHaveBeenCalled(); expect(updates).toEqual([]);
    });

    it.each([
        { name: 'custom', settings: { dailyDigestMorningTime: '02:30', dailyDigestEveningTime: '21:17', weeklyReviewTime: '06:45', weeklyReviewDay: 3 },
            expected: [{ hour: 2, minute: 30 }, { hour: 21, minute: 17 }, { hour: 6, minute: 45, weekday: 3 }] },
        { name: 'default', settings: {},
            expected: [{ hour: 9, minute: 0 }, { hour: 20, minute: 0 }, { hour: 18, minute: 0, weekday: 0 }] },
        { name: 'invalid-time and upper-day-clamped', settings: { dailyDigestMorningTime: '99:80', dailyDigestEveningTime: 'invalid', weeklyReviewTime: '-1:20', weeklyReviewDay: 99.5 },
            expected: [{ hour: 9, minute: 0 }, { hour: 20, minute: 0 }, { hour: 18, minute: 0, weekday: 6 }] },
    ])('retains the iOS $name digest wall-clock slots from shared settings policy', async ({ settings, expected }) => {
        freezeClock(); await seed({ dailyDigestMorningEnabled: true, dailyDigestEveningEnabled: true, weeklyReviewEnabled: true, ...settings });
        const host = await openHost('ios'), before = JSON.stringify(useTaskStore.getState().settings);
        const plan = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true }));
        const recurring = plan.schedule.filter((alarm) => alarm.repeat !== 'once');
        expect(recurring.map((alarm) => alarm.key)).toEqual(['digest:morning', 'digest:evening', 'digest:weekly-review']);
        expect(recurring.map((alarm) => alarm.calendar)).toEqual(expected);
        const shared = getDigestSchedule(useTaskStore.getState().settings);
        expect(recurring.map((alarm) => alarm.calendar)).toEqual([
            { hour: shared.morning.hour, minute: shared.morning.minute }, { hour: shared.evening.hour, minute: shared.evening.minute },
            { hour: shared.weekly.hour, minute: shared.weekly.minute, weekday: shared.weekly.day },
        ]);
        expect(plan.schedule.filter((alarm) => alarm.repeat === 'once').every((alarm) => !Object.hasOwn(alarm, 'calendar'))).toBe(true);
        expect(JSON.stringify(useTaskStore.getState().settings)).toBe(before); expect(saveData).not.toHaveBeenCalled(); expect(updates).toEqual([]);
    });

    it('reads iOS calendar slots from settings after the held translation await', async () => {
        freezeClock(); await seed({ dailyDigestMorningEnabled: true, weeklyReviewEnabled: true, dailyDigestMorningTime: '02:30', weeklyReviewDay: 0 });
        const host = await openHost('ios'), translations = await loadTranslations('en');
        let release!: (value: Record<string, string>) => void;
        const held = new Promise<Record<string, string>>((resolve) => { release = resolve; });
        const loader = vi.spyOn(i18nLoader, 'loadTranslations').mockReturnValueOnce(held);
        try {
            const pending = host.planReminderAlarms({ storedAlarms: null, permissionGranted: true });
            expect(loader).toHaveBeenCalledOnce();
            useTaskStore.setState({ settings: { ...useTaskStore.getState().settings, dailyDigestMorningTime: '04:22', weeklyReviewTime: '07:11', weeklyReviewDay: 5 } });
            release(translations);
            const plan = value(await pending);
            expect(plan.schedule.find((alarm) => alarm.key === 'digest:morning')?.calendar).toEqual({ hour: 4, minute: 22 });
            expect(plan.schedule.find((alarm) => alarm.key === 'digest:weekly-review')?.calendar).toEqual({ hour: 7, minute: 11, weekday: 5 });
            expect(saveData).not.toHaveBeenCalled(); expect(updates).toEqual([]);
        } finally { release(translations); loader.mockRestore(); }
    });

    it('keeps iOS ordinary reminders and new or replayed Snoozes free of calendar metadata', async () => {
        freezeClock(); await seed(); const host = await openHost('ios');
        const first = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true }));
        const fired = first.schedule.find((alarm) => alarm.key === 'task:t-rent')!;
        expect(fired).toBeDefined(); expect(Object.hasOwn(fired, 'calendar')).toBe(false);
        const snooze = value(await host.snoozeReminder({ requestId: generateUUID(), requestedAt: Date.now(), details: fired.details }));
        expect(Object.hasOwn(snooze, 'calendar')).toBe(false);
        const made = value(await host.planReminderSnooze({ storedState: first.state, alarm: snooze, permissionGranted: true }));
        const replay = value(await host.planReminderAlarms({ storedAlarms: first.alarms, storedState: made.stateAhead, permissionGranted: true }));
        const scheduled = replay.schedule.filter((alarm) => alarm.key === snooze.key);
        expect(scheduled).toEqual([snooze]); expect(scheduled.every((alarm) => !Object.hasOwn(alarm, 'calendar'))).toBe(true);
    });

    it('keeps malformed saved maps as a pure preview without logging their private parse text', async () => {
        freezeClock(); await seed(); const host = await openHost();
        const warnings: LogPayload[] = []; setLogger((payload) => warnings.push(payload));
        const before = JSON.stringify({ tasks: useTaskStore.getState()._allTasks, settings: useTaskStore.getState().settings });
        try {
            const result = value(await host.planReminderAlarms({ storedAlarms: 'PRIVATE', storedState: 'PRIVATE', permissionGranted: true }));
            expect(result.mode).toBe('active'); expect(result.schedule.length).toBeGreaterThan(0);
            expect(warnings).toEqual([
                { level: 'warn', message: 'Stored reminder alarm map unreadable; starting from none', scope: 'notifications' },
                { level: 'warn', message: 'Stored native reminder state unreadable; starting from none', scope: 'notifications' },
            ]);
            expect(JSON.stringify(warnings)).not.toContain('PRIVATE');
            expect(JSON.stringify({ tasks: useTaskStore.getState()._allTasks, settings: useTaskStore.getState().settings })).toBe(before);
            expect(saveData).not.toHaveBeenCalled(); expect(updates).toEqual([]);
        } finally { setLogger(consoleLogger); }
    });

    it('plans what core\'s planner decides for the store, with an id per alarm and the maps to store', async () => {
        freezeClock();
        await seed();
        const host = await openHost();
        const plan = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true }));
        const state = useTaskStore.getState();
        const direct = planReminderAlarms({
            settings: state.settings, tasks: state.tasks, projects: state.projects, now: new Date(NOW),
            translations: await loadTranslations('en'), maxOneShotReminders: 200, alarms: new Map(),
        });
        const requests = [...direct.recurring, ...direct.oneShot];
        expect(plan.mode).toBe('active');
        expect(plan.cancel).toEqual([]);
        expect(plan.schedule.map((alarm) => alarm.key)).toEqual(requests.map((request) => request.key));
        expect(plan.schedule.map((alarm) => alarm.key)).not.toContain('task:t-date-only');
        for (const [index, alarm] of plan.schedule.entries()) {
            const { config, key } = requests[index];
            expect(alarm).toMatchObject({ fireAtMs: config.fireAt.getTime(), repeat: config.repeatInterval ?? 'once', details: buildReminderAlarmDetails(key, config), replacing: null });
        }
        expect(plan.schedule.find((alarm) => alarm.key === 'task:t-rent')?.details).toMatchObject({
            channel: 'mindwtr_reminders_v2', has_complete_action: true, snooze_interval: 10, data: { taskId: 't-rent', kind: 'task-reminder' },
        });
        const ids = plan.schedule.map((alarm) => alarm.id);
        expect(new Set(ids).size).toBe(ids.length);
        ids.forEach((id) => expect(id).toBeGreaterThan(0));
        ids.forEach((id) => expect(id).toBeLessThan(2 ** 30));
        expect(Object.values(JSON.parse(plan.writeAhead!))).toEqual(plan.schedule.map((alarm) => expect.objectContaining({ id: alarm.id, pending: true })));
        expect(Object.values(JSON.parse(plan.alarms)).some((entry) => (entry as { pending?: true }).pending)).toBe(false);
        expect(plan.topUpDelayMs).toBe(20 * 60_000 + 5_000);
        expect(plan.clearDelivered).toBe(false);
    });

    it.each([
        { platform: undefined, cap: 200, label: 'omitted Android default' },
        { platform: 'android' as const, cap: 200, label: 'explicit Android' },
        { platform: 'ios' as const, cap: 60, label: 'iOS' },
    ])('selects the trusted reminder platform cap: $label, with recurring alarms and unchanged top-up', async ({ platform, cap }) => {
        freezeClock();
        const timed = Array.from({ length: 205 }, (_, index) => task({
            id: `cap-${index}`, status: index === 0 ? 'waiting' : index === 1 ? 'someday' : 'next',
            dueDate: new Date(Date.parse(NOW) + (index + 1) * 60_000).toISOString(),
        })).reverse();
        const ineligible = [
            task({ id: 'cap-date-only', dueDate: '2026-09-29' }),
            ...(['done', 'archived', 'reference'] as const).map((status) => task({
                id: `cap-${status}`, status, dueDate: '2026-09-28T10:00:30.000Z',
            })),
            task({ id: 'cap-deleted', deletedAt: T0, dueDate: '2026-09-28T10:00:30.000Z' }),
        ];
        await seed({ dailyDigestMorningEnabled: true, dailyDigestEveningEnabled: true, weeklyReviewEnabled: true }, [...timed, ...ineligible]);
        const host = await openHost(platform);
        const before = JSON.stringify({ tasks: useTaskStore.getState()._allTasks, settings: useTaskStore.getState().settings });
        const first = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true }));
        const recurring = ['digest:morning', 'digest:evening', 'digest:weekly-review'];
        const earliest = Array.from({ length: cap }, (_, index) => `task:cap-${index}`);
        expect(first.schedule.map((alarm) => alarm.key)).toEqual([...recurring, ...earliest]);
        expect(first.schedule.map((alarm) => alarm.repeat)).toEqual(['daily', 'daily', 'weekly', ...earliest.map(() => 'once')]);
        expect(first.topUpDelayMs).toBe(65_000);
        expect(readReminderAlarmMap(first.alarms).size).toBe(cap + 3);
        const held = value(await host.planReminderAlarms({ storedAlarms: first.alarms, permissionGranted: true }));
        expect(held).toMatchObject({ schedule: [], cancel: [], writeAhead: null, alarms: first.alarms, topUpDelayMs: 65_000 });

        // When the earliest fires, the same policy expires it and admits exactly one successor.
        vi.setSystemTime(new Date('2026-09-28T10:01:05.000Z'));
        const next = value(await host.planReminderAlarms({ storedAlarms: first.alarms, permissionGranted: true }));
        expect(next.cancel).toEqual([{ key: 'task:cap-0', id: first.schedule[3].id, reason: 'expired' }]);
        expect(next.schedule.map((alarm) => alarm.key)).toEqual([`task:cap-${cap}`]);
        expect(next.topUpDelayMs).toBe(60_000);
        expect(Array.from(readReminderAlarmMap(next.alarms).keys())).toEqual([...recurring, ...earliest.slice(1), `task:cap-${cap}`]);
        expect(JSON.stringify({ tasks: useTaskStore.getState()._allTasks, settings: useTaskStore.getState().settings })).toBe(before);
        expect(saveData).not.toHaveBeenCalled();
    });

    it('stores its alarm map under React Native\'s key so that a React Native recovery build makes every alarm again', async () => {
        freezeClock();
        await seed();
        const host = await openHost();
        const first = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true }));
        // The native host still holds what it made.
        expect(value(await host.planReminderAlarms({ storedAlarms: first.alarms, permissionGranted: true }))).toMatchObject({ schedule: [], cancel: [] });
        // A React Native build installed over the native app reads the same map, but holds none of these alarms: it keeps none.
        const state = useTaskStore.getState();
        const rn = planReminderAlarms({
            settings: state.settings, tasks: state.tasks, projects: state.projects, now: new Date(NOW),
            translations: await loadTranslations('en'), maxOneShotReminders: 200, alarms: readReminderAlarmMap(first.alarms),
        });
        expect(rn.keep).toEqual([]);
        expect(rn.schedule).toEqual(first.schedule.map((alarm) => alarm.key));
        expect(Object.values(rn.reasons).every((reason) => reason === 'expired')).toBe(true);
    });

    it('replays an interrupted plan after a restart: the same alarms under the same ids, and none left behind', async () => {
        freezeClock();
        await seed();
        const first = value(await (await openHost()).planReminderAlarms({ storedAlarms: null, permissionGranted: true }));

        // Stopped after storing writeAhead: a new host plans the same alarms under the same ids.
        const replay = value(await (await openHost()).planReminderAlarms({ storedAlarms: first.writeAhead, permissionGranted: true }));
        expect(replay.schedule).toEqual(first.schedule.map((alarm) => ({ ...alarm, replacing: 'expired' })));
        expect(replay.cancel).toEqual([]);
        expect(replay.alarms).toBe(first.alarms);

        // Applied and stored: planning again changes nothing.
        const settled = value(await (await openHost()).planReminderAlarms({ storedAlarms: first.alarms, permissionGranted: true }));
        expect(settled).toMatchObject({ schedule: [], cancel: [], writeAhead: null, alarms: first.alarms });

        // The rent task was done before the replay: its pending alarm is cancelled under the id it may have been made with.
        await useTaskStore.getState().updateTask('t-rent', { status: 'done' });
        await flushPendingSave();
        const afterDone = value(await (await openHost()).planReminderAlarms({ storedAlarms: first.writeAhead, permissionGranted: true }));
        const rentId = first.schedule.find((alarm) => alarm.key === 'task:t-rent')!.id;
        expect(afterDone.cancel).toEqual([{ key: 'task:t-rent', id: rentId, reason: 'withdrawn' }]);
        expect(afterDone.schedule.map((alarm) => alarm.key)).not.toContain('task:t-rent');
        expect(readReminderAlarmMap(afterDone.alarms).has('task:t-rent')).toBe(false);
    });

    it('replays an interrupted plan without forgetting that a moved reminder withdraws what it delivered', async () => {
        freezeClock();
        await seed();
        const host = await openHost();
        const first = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true }));
        // The 11:00 rent reminder fired and is in the tray; then its due time moves.
        vi.setSystemTime(new Date('2026-09-28T11:00:05.000Z'));
        await useTaskStore.getState().updateTask('t-rent', { dueDate: '2026-09-28T12:30:00.000Z' });
        await flushPendingSave();
        const moved = value(await host.planReminderAlarms({ storedAlarms: first.alarms, permissionGranted: true }));
        const rent = (plan: typeof moved) => plan.schedule.find((alarm) => alarm.key === 'task:t-rent');
        expect(rent(moved)).toMatchObject({ replacing: 'withdrawn' });
        // Stopped after storing writeAhead, before cancelling or making anything.
        const replay = value(await (await openHost()).planReminderAlarms({ storedAlarms: moved.writeAhead, permissionGranted: true }));
        expect(rent(replay)).toEqual(rent(moved));
        expect(replay.cancel).toEqual(moved.cancel);
        expect(readReminderAlarmMap(replay.alarms)).toEqual(readReminderAlarmMap(moved.alarms));
    });

    it('judges the store as it is after loading the alarm texts, not before', async () => {
        freezeClock();
        await seed();
        const host = await openHost();
        const first = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true }));
        const rentId = first.schedule.find((alarm) => alarm.key === 'task:t-rent')!.id;
        // The rent task is done (a sync, a Done) while the plan loads its texts.
        const planned = host.planReminderAlarms({ storedAlarms: first.alarms, permissionGranted: true });
        useTaskStore.setState({ tasks: useTaskStore.getState().tasks.map((entry) => (entry.id === 't-rent' ? { ...entry, status: 'done' as const } : entry)) });
        expect(value(await planned).cancel).toContainEqual({ key: 'task:t-rent', id: rentId, reason: 'withdrawn' });
    });

    it('lets an alarm whose time passed expire, keeping what it delivered', async () => {
        freezeClock();
        await seed();
        const host = await openHost();
        const first = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true }));
        vi.setSystemTime(new Date('2026-09-28T11:00:05.000Z'));
        const later = value(await host.planReminderAlarms({ storedAlarms: first.alarms, permissionGranted: true }));
        const held = (key: string) => first.schedule.find((alarm) => alarm.key === key)!.id;
        expect(later.cancel).toEqual(expect.arrayContaining([{ key: 'task:t-rent', id: held('task:t-rent'), reason: 'expired' }]));
        expect(later.cancel.every((entry) => entry.reason === 'expired')).toBe(true);
    });

    it('remembers a reminder that fired after its alarm expires, and withdraws what it delivered when its task is done later', async () => {
        freezeClock();
        await seed();
        const host = await openHost();
        const first = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true }));
        const rentId = first.schedule.find((alarm) => alarm.key === 'task:t-rent')!.id;
        expect(first.state).toBe('{}');
        // The 11:00 rent reminder fired; the top-up plan 5 s later lets its alarm expire and keeps what it delivered.
        vi.setSystemTime(new Date('2026-09-28T11:00:05.000Z'));
        const topUp = value(await host.planReminderAlarms({ storedAlarms: first.alarms, permissionGranted: true, storedState: first.state }));
        expect(topUp.cancel).toEqual(expect.arrayContaining([{ key: 'task:t-rent', id: rentId, reason: 'expired' }]));
        expect(JSON.parse(topUp.state)['task:t-rent']).toMatchObject({ kind: 'delivered', id: rentId, firedAtMs: Date.parse('2026-09-28T11:00:00.000Z') });
        // Still valid an hour later: nothing goes.
        vi.setSystemTime(new Date('2026-09-28T12:00:05.000Z'));
        const later = value(await host.planReminderAlarms({ storedAlarms: topUp.alarms, permissionGranted: true, storedState: topUp.state }));
        expect(later.cancel.filter((entry) => entry.key === 'task:t-rent')).toEqual([]);
        expect(JSON.parse(later.state)['task:t-rent']).toMatchObject({ id: rentId });
        // Done: what it delivered is withdrawn, and it is forgotten.
        await useTaskStore.getState().updateTask('t-rent', { status: 'done' });
        await flushPendingSave();
        const done = value(await host.planReminderAlarms({ storedAlarms: later.alarms, permissionGranted: true, storedState: later.state }));
        expect(done.cancel).toEqual(expect.arrayContaining([{ key: 'task:t-rent', id: rentId, reason: 'withdrawn' }]));
        expect(JSON.parse(done.state)['task:t-rent']).toBeUndefined();
        // Kept at most 30 days.
        vi.setSystemTime(new Date('2026-10-29T12:00:00.000Z'));
        expect(JSON.parse(value(await host.planReminderAlarms({ storedAlarms: later.alarms, permissionGranted: true, storedState: later.state })).state)['task:t-rent'])
            .toBeUndefined();
    });

    it('withdraws every delivered reminder it remembers when reminders go off or the permission is revoked, and never reuses its id', async () => {
        freezeClock();
        await seed();
        const host = await openHost();
        const first = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true }));
        const rent = first.schedule.find((alarm) => alarm.key === 'task:t-rent')!;
        const signature = JSON.parse(first.alarms)['task:t-rent'].signature.replace(/^native:/, '');
        // The rent reminder at 11:00, delivered, still remembered under the id a new plan would give the same key.
        const state = JSON.stringify({ 'task:t-rent': { kind: 'delivered', id: rent.id, signature, firedAtMs: rent.fireAtMs } });
        const fresh = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true, storedState: state }));
        expect(fresh.schedule.find((alarm) => alarm.key === 'task:t-rent')!.id).not.toBe(rent.id);
        expect(fresh.cancel).toEqual([]);
        expect(value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: false, storedState: state })))
            .toMatchObject({ cancel: [{ key: 'task:t-rent', id: rent.id, reason: 'withdrawn' }], state: '{}' });
        await useTaskStore.getState().updateSettings({ notificationsEnabled: false, dailyDigestMorningEnabled: false, weeklyReviewEnabled: false });
        expect(value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true, storedState: state })))
            .toMatchObject({ mode: 'inactive', cancel: [{ key: 'task:t-rent', id: rent.id, reason: 'withdrawn' }], state: '{}' });
        expect(value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true, storedState: '{not json' }))).toMatchObject({ state: '{}' });
    });

    it('makes a repeating alarm that fired again at its next time, by core\'s schedule, or cancels it when it was turned off', async () => {
        freezeClock();
        await seed();
        const host = await openHost();
        const first = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true }));
        const morning = first.schedule.find((alarm) => alarm.key === 'digest:morning')!;
        expect(morning.repeat).toBe('daily');
        // The morning digest fired; a plain plan keeps it (its signature holds), the fired one's remake moves it a day on.
        vi.setSystemTime(new Date(morning.fireAtMs + 2_000));
        expect(value(await host.planReminderAlarms({ storedAlarms: first.alarms, permissionGranted: true })).schedule).toEqual([]);
        const fired = value(await host.planReminderAlarms({ storedAlarms: first.alarms, permissionGranted: true, remake: ['digest:morning', 'digest:gone'] }));
        expect(fired.schedule).toEqual([{ ...morning, fireAtMs: morning.fireAtMs + 24 * 60 * 60 * 1000, replacing: 'expired' }]);
        expect(fired.cancel.map((entry) => entry.key)).not.toContain('digest:morning');
        await useTaskStore.getState().updateSettings({ dailyDigestMorningEnabled: false });
        const off = value(await host.planReminderAlarms({ storedAlarms: first.alarms, permissionGranted: true, remake: ['digest:morning'] }));
        expect(off.schedule.map((alarm) => alarm.key)).not.toContain('digest:morning');
        expect(off.cancel).toContainEqual({ key: 'digest:morning', id: morning.id, reason: 'withdrawn' });
        expect(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true, remake: [7] as never })).toMatchObject(invalid);
    });

    it('keeps an alarm\'s id when it changes, and gives a new key an id no held alarm has', async () => {
        freezeClock();
        await seed();
        const host = await openHost();
        const first = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true }));
        await useTaskStore.getState().updateTask('t-rent', { dueDate: '2026-09-28T11:30:00.000Z' });
        await useTaskStore.getState().updateTask('t-date-only', { dueDate: '2026-09-28T14:00:00.000Z' });
        const next = value(await host.planReminderAlarms({ storedAlarms: first.alarms, permissionGranted: true }));
        expect(next.schedule.map((alarm) => alarm.key)).toEqual(['task:t-rent', 'task:t-date-only']);
        // The rent reminder moved: whatever it delivered is withdrawn with it.
        expect(next.schedule.map((alarm) => alarm.replacing)).toEqual(['withdrawn', null]);
        expect(next.schedule[0].id).toBe(first.schedule.find((alarm) => alarm.key === 'task:t-rent')!.id);
        expect(first.schedule.map((alarm) => alarm.id)).not.toContain(next.schedule[1].id);
        expect(next.cancel).toEqual([]);
    });

    it('cancels every alarm without permission or with every reminder off, and starts over from an unreadable map', async () => {
        freezeClock();
        await seed();
        const host = await openHost();
        const first = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true }));
        const everyAlarm = first.schedule.map(({ key, id }) => ({ key, id, reason: 'withdrawn' }));
        expect(value(await host.planReminderAlarms({ storedAlarms: first.alarms, permissionGranted: false })))
            .toEqual({ mode: 'revoked', cancel: everyAlarm, schedule: [], writeAhead: null, alarms: '{}', state: '{}', topUpDelayMs: null, clearDelivered: true });
        await useTaskStore.getState().updateSettings({ notificationsEnabled: false, dailyDigestMorningEnabled: false, weeklyReviewEnabled: false });
        expect(value(await host.planReminderAlarms({ storedAlarms: first.alarms, permissionGranted: true })))
            .toMatchObject({ mode: 'inactive', cancel: everyAlarm, schedule: [], alarms: '{}', clearDelivered: false });
        expect(value(await host.planReminderAlarms({ storedAlarms: '{not json', permissionGranted: true }))).toMatchObject({ cancel: [], alarms: '{}' });
        expect(await host.planReminderAlarms({ storedAlarms: 7 as never, permissionGranted: true })).toMatchObject(invalid);
    });

    it('is not ready before the store is loaded', async () => {
        const host = createNativeHostContract();
        expect(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(await host.completeReminderTask({ requestId: generateUUID(), taskId: 't-rent' })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(await host.snoozeReminder({ requestId: generateUUID(), requestedAt: Date.parse(NOW), details: { title: 'Pay rent', snooze_interval: 10 } }))
            .toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
    });

    it('completes a recurring task once from Done: an exact retry and a replay after a restart make no second next instance', async () => {
        freezeClock();
        await seed();
        const host = await openHost();
        const input = { requestId: generateUUID(), taskId: 't-standup' };
        const [first, second] = await Promise.all([host.completeReminderTask(input), host.completeReminderTask(input)]);
        expect(first).toEqual({ ok: true, value: { changed: true, outcome: 'completed' } });
        expect(second).toEqual(first);
        expect(updates).toEqual([['t-standup', { status: 'done', isFocusedToday: false }]]);
        expect(useTaskStore.getState()._tasksById.get('t-standup')).toMatchObject({ status: 'done' });
        expect(openFollowUps('t-standup')).toHaveLength(1);
        const tasksAfter = useTaskStore.getState()._allTasks.map((entry) => [entry.id, entry.rev]);
        expect(await host.completeReminderTask({ ...input, taskId: 't-rent' })).toMatchObject(invalid);

        const restarted = await openHost();
        expect(await restarted.completeReminderTask(input)).toEqual({ ok: true, value: { changed: false, outcome: 'not-actionable' } });
        expect(updates).toHaveLength(1);
        expect(openFollowUps('t-standup')).toHaveLength(1);
        expect(useTaskStore.getState()._allTasks.map((entry) => [entry.id, entry.rev])).toEqual(tasksAfter);
    });

    it('finishes a Done whose save failed on retry, without a second write', async () => {
        freezeClock();
        await seed();
        const host = await openHost();
        const input = { requestId: generateUUID(), taskId: 't-standup' };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.completeReminderTask(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        saveData.mockResolvedValue(undefined);
        expect(await host.completeReminderTask(input)).toEqual({ ok: true, value: { changed: true, outcome: 'completed' } });
        expect(updates).toHaveLength(1);
        expect(openFollowUps('t-standup')).toHaveLength(1);
    });

    it('leaves a missing, deleted or finished task alone', async () => {
        // t-deleted's tombstone (T0) would pass the 90-day purge on a real clock and read as task-not-found.
        freezeClock();
        await seed();
        const host = await openHost();
        const done = (taskId: string) => host.completeReminderTask({ requestId: generateUUID(), taskId });
        expect(await done('t-missing')).toEqual({ ok: true, value: { changed: false, outcome: 'task-not-found' } });
        expect(await done('t-deleted')).toEqual({ ok: true, value: { changed: false, outcome: 'task-deleted' } });
        expect(await done('t-done')).toEqual({ ok: true, value: { changed: false, outcome: 'not-actionable' } });
        expect(await host.completeReminderTask({ requestId: 'not-a-uuid', taskId: 't-rent' })).toMatchObject(invalid);
        expect(await host.completeReminderTask({ requestId: generateUUID(), taskId: '' })).toMatchObject(invalid);
        expect(updates).toEqual([]);
    });

    it('snoozes as the same alarm again ten minutes after the tap, and a replay after a restart returns that same alarm', async () => {
        freezeClock();
        await seed();
        const host = await openHost();
        const fired = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true })).schedule.find((alarm) => alarm.key === 'task:t-rent')!;
        const input = { requestId: generateUUID(), requestedAt: Date.parse('2026-09-28T11:00:42.500Z'), details: fired.details };
        const snoozed = value(await host.snoozeReminder(input));
        expect(snoozed).toEqual({
            key: `snooze:${input.requestId.toLowerCase()}`,
            id: snoozed.id,
            fireAtMs: Date.parse('2026-09-28T11:10:42.000Z'),
            repeat: 'once',
            details: { ...fired.details, schedule_type: 'once' },
            replacing: null,
        });
        expect(snoozed.id).toBeGreaterThanOrEqual(2 ** 30);
        expect(value(await (await openHost()).snoozeReminder(input))).toEqual(snoozed);
        const digest = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true })).schedule.find((alarm) => alarm.key === 'digest:morning')!;
        expect(await host.snoozeReminder({ ...input, requestId: generateUUID(), details: digest.details })).toMatchObject(invalid);
        expect(await host.snoozeReminder({ ...input, requestId: 'x' })).toMatchObject(invalid);
    });

    it('keeps each Snooze it made: armed once across retries and restarts, made again after a reboot, withdrawn with its task', async () => {
        freezeClock();
        await seed();
        const host = await openHost();
        const first = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true }));
        const fired = first.schedule.find((alarm) => alarm.key === 'task:t-rent')!;
        vi.setSystemTime(new Date('2026-09-28T11:00:42.000Z'));
        const snooze = value(await host.snoozeReminder({ requestId: generateUUID(), requestedAt: Date.now(), details: fired.details }));
        // Stored as not yet made, made, then stored as made.
        const made = value(await host.planReminderSnooze({ storedState: first.state, alarm: snooze, permissionGranted: true }));
        expect(made.schedule).toEqual([snooze]);
        expect(JSON.parse(made.stateAhead!)[snooze.key]).toMatchObject({ kind: 'snooze', id: snooze.id, fireAtMs: snooze.fireAtMs, armed: false });
        expect(JSON.parse(made.state!)[snooze.key]).toMatchObject({ armed: true });
        // A retry after it was made, even after it fired, makes nothing again; a stop before it was made makes it.
        vi.setSystemTime(new Date('2026-09-28T11:11:00.000Z'));
        expect(value(await (await openHost()).planReminderSnooze({ storedState: made.state, alarm: snooze, permissionGranted: true }))).toEqual({ schedule: [], stateAhead: null, state: null });
        expect(value(await host.planReminderSnooze({ storedState: made.stateAhead, alarm: snooze, permissionGranted: true })).schedule).toEqual([snooze]);
        // A plan after such a stop makes it too; a plain plan leaves a made one alone.
        const stopped = value(await host.planReminderAlarms({ storedAlarms: first.alarms, permissionGranted: true, storedState: made.stateAhead }));
        expect(stopped.schedule.filter((alarm) => alarm.key === snooze.key)).toEqual([snooze]);
        expect(JSON.parse(stopped.state)[snooze.key]).toMatchObject({ armed: true });
        // A reboot remakes it while it is ahead, never once its time passed (it fired, or a reminder of the past).
        vi.setSystemTime(new Date('2026-09-28T11:05:00.000Z'));
        const plain = value(await host.planReminderAlarms({ storedAlarms: first.alarms, permissionGranted: true, storedState: made.state }));
        expect(plain.schedule.filter((alarm) => alarm.key === snooze.key)).toEqual([]);
        const rebuild = value(await host.planReminderAlarms({ storedAlarms: first.alarms, permissionGranted: true, storedState: made.state, remake: 'all' }));
        expect(rebuild.schedule.filter((alarm) => alarm.key === snooze.key)).toEqual([snooze]);
        vi.setSystemTime(new Date('2026-09-28T11:20:00.000Z'));
        const late = value(await host.planReminderAlarms({ storedAlarms: first.alarms, permissionGranted: true, storedState: made.state, remake: 'all' }));
        expect(late.schedule.filter((alarm) => alarm.key === snooze.key)).toEqual([]);
        expect(JSON.parse(late.state)[snooze.key]).toMatchObject({ armed: true });
        // Reminders off: a Snooze stays (it is independent); no permission, or its task done: withdrawn with what it delivered.
        expect(value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: false, storedState: made.state })).cancel)
            .toEqual([{ key: snooze.key, id: snooze.id, reason: 'withdrawn' }]);
        await useTaskStore.getState().updateSettings({ notificationsEnabled: false, dailyDigestMorningEnabled: false, weeklyReviewEnabled: false });
        const off = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true, storedState: made.state }));
        expect(off.cancel).toEqual([]);
        expect(JSON.parse(off.state)[snooze.key]).toMatchObject({ armed: true });
        await useTaskStore.getState().updateTask('t-rent', { status: 'done' });
        await flushPendingSave();
        const done = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true, storedState: made.state }));
        expect(done.cancel).toEqual([{ key: snooze.key, id: snooze.id, reason: 'withdrawn' }]);
        expect(JSON.parse(done.state)[snooze.key]).toBeUndefined();
    });

    it('never makes a replayed Snooze again once a plan withdrew it: no permission, or its task done', async () => {
        freezeClock();
        await seed();
        const host = await openHost();
        const fired = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true })).schedule.find((alarm) => alarm.key === 'task:t-rent')!;
        const snooze = value(await host.snoozeReminder({ requestId: generateUUID(), requestedAt: Date.now(), details: fired.details }));
        const made = value(await host.planReminderSnooze({ storedState: null, alarm: snooze, permissionGranted: true }));
        // Permission revoked: the plan withdraws it; a replay of the Snooze job (WorkManager's retry) makes nothing.
        const revoked = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: false, storedState: made.state }));
        expect(revoked.cancel).toContainEqual({ key: snooze.key, id: snooze.id, reason: 'withdrawn' });
        expect(value(await host.planReminderSnooze({ storedState: revoked.state, alarm: snooze, permissionGranted: false })))
            .toEqual({ schedule: [], stateAhead: null, state: null });
        // Its task done: the same.
        await useTaskStore.getState().updateTask('t-rent', { status: 'done' });
        await flushPendingSave();
        const done = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true, storedState: made.state }));
        expect(value(await host.planReminderSnooze({ storedState: done.state, alarm: snooze, permissionGranted: true })))
            .toEqual({ schedule: [], stateAhead: null, state: null });
    });

    it('never makes a Snooze that showed again, and makes one the phone missed while off once at boot within a day', async () => {
        freezeClock();
        await seed();
        const host = await openHost();
        const fired = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true })).schedule.find((alarm) => alarm.key === 'task:t-rent')!;
        vi.setSystemTime(new Date('2026-09-28T11:00:42.000Z'));
        const snooze = value(await host.snoozeReminder({ requestId: generateUUID(), requestedAt: Date.now(), details: fired.details }));
        const made = value(await host.planReminderSnooze({ storedState: null, alarm: snooze, permissionGranted: true }));
        // Killed after it was made, before `armed` was stored; it showed (the ledger says fired); the restart's remake.
        vi.setSystemTime(new Date('2026-09-28T11:30:00.000Z'));
        const restart = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true, storedState: made.stateAhead, remake: 'all', fired: [snooze.id], shown: [snooze.id] }));
        expect(restart.schedule.map((alarm) => alarm.key)).not.toContain(snooze.key);
        expect(JSON.parse(restart.state)[snooze.key]).toMatchObject({ armed: true });
        const replay = value(await host.planReminderSnooze({ storedState: made.stateAhead, alarm: snooze, permissionGranted: true, fired: [snooze.id] }));
        expect(replay.schedule).toEqual([]);
        expect(JSON.parse(replay.state!)[snooze.key]).toMatchObject({ armed: true });
        // Made and armed, but due while the phone was off (not fired): the boot's remake makes it once, an hour late; a plain plan
        // never does; more than a day late it expires.
        const boot = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true, storedState: made.state, remake: 'all', fired: [], shown: [] }));
        expect(boot.schedule.filter((alarm) => alarm.key === snooze.key)).toEqual([snooze]);
        const plain = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true, storedState: made.state, fired: [], shown: [] }));
        expect(plain.schedule.filter((alarm) => alarm.key === snooze.key)).toEqual([]);
        vi.setSystemTime(new Date('2026-09-29T11:30:00.000Z'));
        const late = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true, storedState: made.state, remake: 'all', fired: [], shown: [] }));
        expect(late.schedule.filter((alarm) => alarm.key === snooze.key)).toEqual([]);
        expect(late.cancel).toContainEqual({ key: snooze.key, id: snooze.id, reason: 'expired' });
        // One that showed is kept while it is in the tray (its task may still be completed), and forgotten once it is gone.
        const kept = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true, storedState: made.state, fired: [snooze.id], shown: [snooze.id] }));
        expect(JSON.parse(kept.state)[snooze.key]).toMatchObject({ armed: true });
        const gone = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true, storedState: made.state, fired: [snooze.id], shown: [] }));
        expect(JSON.parse(gone.state)[snooze.key]).toBeUndefined();
        expect(gone.cancel).toContainEqual({ key: snooze.key, id: snooze.id, reason: 'expired' });
    });

    it('remembers a delivered reminder while it is in the tray, past 30 days, and forgets it once it is gone', async () => {
        freezeClock();
        await seed();
        const host = await openHost();
        const first = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true }));
        const rentId = first.schedule.find((alarm) => alarm.key === 'task:t-rent')!.id;
        vi.setSystemTime(new Date('2026-09-28T11:00:05.000Z'));
        const topUp = value(await host.planReminderAlarms({ storedAlarms: first.alarms, permissionGranted: true, storedState: first.state, fired: [], shown: [rentId] }));
        expect(JSON.parse(topUp.state)['task:t-rent']).toMatchObject({ id: rentId });
        vi.setSystemTime(new Date('2026-11-28T11:00:05.000Z'));
        const shown = value(await host.planReminderAlarms({ storedAlarms: topUp.alarms, permissionGranted: true, storedState: topUp.state, fired: [], shown: [rentId] }));
        expect(JSON.parse(shown.state)['task:t-rent']).toMatchObject({ id: rentId });
        await useTaskStore.getState().updateTask('t-rent', { status: 'done' });
        await flushPendingSave();
        const done = value(await host.planReminderAlarms({ storedAlarms: topUp.alarms, permissionGranted: true, storedState: shown.state, fired: [], shown: [rentId] }));
        expect(done.cancel).toContainEqual({ key: 'task:t-rent', id: rentId, reason: 'withdrawn' });
        const dismissed = value(await host.planReminderAlarms({ storedAlarms: topUp.alarms, permissionGranted: true, storedState: topUp.state, fired: [], shown: [] }));
        expect(JSON.parse(dismissed.state)['task:t-rent']).toBeUndefined();
    });

    it('lets a Snooze that was never made expire a day after its time', async () => {
        freezeClock();
        await seed();
        const host = await openHost();
        const fired = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true })).schedule.find((alarm) => alarm.key === 'task:t-rent')!;
        const snooze = value(await host.snoozeReminder({ requestId: generateUUID(), requestedAt: Date.now(), details: fired.details }));
        const { stateAhead } = value(await host.planReminderSnooze({ storedState: null, alarm: snooze, permissionGranted: true }));
        vi.setSystemTime(new Date(snooze.fireAtMs + 25 * 60 * 60 * 1000));
        const plan = value(await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true, storedState: stateAhead }));
        expect(plan.schedule.filter((alarm) => alarm.key === snooze.key)).toEqual([]);
        expect(plan.cancel).toEqual([{ key: snooze.key, id: snooze.id, reason: 'expired' }]);
        expect(plan.state).toBe('{}');
        expect(await host.planReminderSnooze({ storedState: null, alarm: { ...snooze, key: 'task:t-rent' }, permissionGranted: true })).toMatchObject(invalid);
    });

    it('routes a notification tap, the same way after a restart', async () => {
        freezeClock();
        await seed();
        const host = await openHost();
        const payloads = [
            { actionIdentifier: 'complete', taskId: 't-rent', notificationId: 'task:t-rent' },
            { actionIdentifier: 'snooze', taskId: 't-rent' },
            { kind: 'task-review', taskId: 't-review', notificationId: 'task:t-review' },
            { notificationId: 'digest:morning' },
            { projectId: 'p-1' },
        ];
        const routes = payloads.map((payload) => value(host.routeNotificationOpen(payload)));
        expect(routes).toEqual([
            { type: 'complete', taskId: 't-rent', actionKey: 'task:t-rent:t-rent:complete' },
            { type: 'none' },
            { type: 'review', openToken: 'task:t-review', taskId: 't-review' },
            { type: 'daily-review', openToken: 'digest:morning' },
            { type: 'project', projectId: 'p-1' },
        ]);
        const restarted = await openHost();
        expect(payloads.map((payload) => value(restarted.routeNotificationOpen(payload)))).toEqual(routes);
        expect(value(host.routeNotificationOpen({ taskId: 't-rent' }))).toEqual({ type: 'task', taskId: 't-rent', openToken: `notification:${Date.parse(NOW)}:1` });
        expect(host.routeNotificationOpen(null as never)).toMatchObject(invalid);
    });
});

describe('native host contract: reminders over SQLite, after process death', () => {
    const originalTz = process.env.TZ;
    let env: Awaited<ReturnType<typeof openSqliteHost>> | null = null;
    beforeAll(() => {
        process.env.TZ = 'UTC';
    });
    afterAll(() => {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });
    afterEach(async () => {
        vi.useRealTimers();
        await env?.close();
        env = null;
    });
    const later = async (change: () => Promise<unknown>) => {
        await change();
        await flushPendingSave();
    };
    const standups = () => useTaskStore.getState()._allTasks.filter((entry) => entry.title === 'Standup' && !entry.deletedAt);

    it('answers a Done replayed after a restart from its first reply, even after the task was reopened: one next instance', async () => {
        env = await openSqliteHost({ tasks: TASKS });
        const input = { requestId: newRequestId(), taskId: 't-standup' };
        const first = await env.host.completeReminderTask(input);
        expect(first).toEqual({ ok: true, value: { changed: true, outcome: 'completed' } });
        const [next] = standups().filter((entry) => entry.id !== 't-standup');
        expect(next).toBeDefined();
        // The next instance changes, then the original is reopened.
        await later(() => useTaskStore.getState().updateTask(next.id, { title: 'Standup', description: 'Moved to the big room' }));
        await later(() => useTaskStore.getState().updateTask('t-standup', { status: 'next' }));
        expect(standups()).toHaveLength(2);

        const replay = await env.replay((host) => host.completeReminderTask(input));
        expect(replay.result).toEqual(first);
        expect(replay.wrote).toBe(false);
        expect(standups()).toHaveLength(2);
        expect(useTaskStore.getState()._tasksById.get('t-standup')?.status).toBe('next');
        expect(await env.receiptIds()).toEqual([input.requestId]);
    });

    it('keeps a Snooze\'s first reply on disk: a replay after a restart gets it, and its request ID stays its own', async () => {
        env = await openSqliteHost({ tasks: TASKS });
        const details = { title: 'Pay rent', message: 'Due date reminders', snooze_interval: 10, schedule_type: 'once', data: { taskId: 't-rent', alarmKey: 'task:t-rent' } };
        const input = { requestId: newRequestId(), requestedAt: Date.parse('2026-09-28T11:00:42.500Z'), details };
        const first = value(await env.host.snoozeReminder(input));
        expect(await env.receiptIds()).toEqual([input.requestId]);
        const replay = await env.replay((host) => host.snoozeReminder(input));
        expect(replay.result).toEqual({ ok: true, value: first });
        const reused = await env.host.snoozeReminder({ ...input, details: { ...details, title: 'Another reminder' } });
        expect(reused).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });
});
