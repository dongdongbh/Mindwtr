import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    CALENDAR_PUSH_CALENDAR_ID_KEY,
    CALENDAR_PUSH_CREATION_INTENT_KEY,
    CALENDAR_PUSH_COLOR_KEY,
    CALENDAR_PUSH_PENDING_KEY,
    CALENDAR_PUSH_ENABLED_KEY,
    CALENDAR_PUSH_TARGET_ID_KEY,
    CalendarPushOwnershipChangedError,
    createCalendarPushService,
    type CalendarPushServiceHost,
} from './calendar-push-service';
import { planCalendarPushColor } from './calendar-settings-model';
import * as sandbox from './sandbox';
import type { DeviceCalendar } from './external-calendar-feeds';
import type { CalendarSyncEntry } from './sqlite-adapter';
import type { Task } from './types';
import { deterministicHash128Hex } from './uuid';

/**
 * The push's device side as a native host binds it. React Native's own suite
 * (apps/mobile/tests/calendar-push-sync.test.ts) runs the same code through its
 * binding.
 */
const google = { name: 'alex@gmail.com', type: 'com.google', isLocalAccount: false };
const PRIMARY: DeviceCalendar = { id: 'primary', title: 'alex@gmail.com', ownerAccount: 'alex@gmail.com', accessLevel: 'owner', allowsModifications: true, source: google };

const task = (id: string, extra: Partial<Task> = {}): Task => ({
    id, title: `Task ${id}`, status: 'next', tags: [], contexts: [], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...extra,
} as Task);

/** The process died before a write: the write did not happen, and nothing after it runs. */
class Death extends Error {}

function device(options: { os?: string; calendars?: DeviceCalendar[]; storage?: Record<string, string>; entries?: CalendarSyncEntry[]; tasks?: Task[] } = {}) {
    // Every device write first ticks: at `dieAt` the process dies, and every later write fails too.
    const life = { step: 0, dieAt: Infinity, died: false, failDelete: false, failUpdate: false, failList: false, lostCreateResponse: false };
    const tick = () => {
        life.step += 1;
        if (life.died || life.step === life.dieAt) {
            life.died = true;
            throw new Death(`died before write ${life.step}`);
        }
    };
    const storage = new Map(Object.entries(options.storage ?? {}));
    const calendars = [...(options.calendars ?? [PRIMARY])];
    const entries = new Map((options.entries ?? []).map((entry) => [entry.taskId, entry]));
    const writes: unknown[][] = [];
    const eventContexts: [string, string, { taskId: string; calendarId: string } | undefined][] = [];
    let nextId = 0;
    let tasks = options.tasks ?? [];
    const listeners = new Set<(tasks: Task[]) => void>();
    const store = {
        getState: () => ({ _allTasks: tasks, _tasksById: new Map(tasks.map((entry) => [entry.id, entry])), projects: [], sections: [], settings: {} }),
        subscribe: (_selector: unknown, listener: (tasks: Task[]) => void) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
    const host: CalendarPushServiceHost = {
        platform: 'android',
        os: () => options.os ?? 'android',
        storage: {
            getItem: async (key) => storage.get(key) ?? null,
            setItem: async (key, value) => { tick(); storage.set(key, value); },
            removeItem: async (key) => { tick(); storage.delete(key); },
        },
        calendars: {
            getPermissions: async () => ({ status: 'granted' }),
            requestPermissions: async () => ({ status: 'granted' }),
            getCalendars: async () => {
                if (life.failList) throw new Error('Calendar provider unavailable');
                return calendars.map((calendar) => ({ ...calendar }));
            },
            getEvents: async () => [],
            getSources: async () => [{ id: 'local-source', type: 'local', name: 'Default' }],
            createCalendar: async (details) => {
                tick();
                nextId += 1;
                const id = `created-${nextId}`;
                writes.push(['createCalendar', details.title, details.source.name]);
                calendars.push({ ...details, id, allowsModifications: true, source: { ...details.source } });
                if (life.lostCreateResponse) throw new Error('Native create response lost');
                return id;
            },
            updateCalendar: async (id, details) => {
                tick();
                if (life.failUpdate) throw new Error('Calendar provider refused the change');
                writes.push(['updateCalendar', id, details.color, ...(details.title ? [details.title] : [])]);
                const calendar = calendars.find((entry) => entry.id === id);
                if (calendar) {
                    calendar.color = details.color;
                    if (details.title) calendar.title = details.title;
                }
            },
            deleteCalendar: async (id) => {
                tick();
                if (life.failDelete) throw new Error('Calendar provider refused the delete');
                writes.push(['deleteCalendar', id]);
                const index = calendars.findIndex((calendar) => calendar.id === id);
                if (index >= 0) calendars.splice(index, 1);
            },
            createEvent: async (calendarId, details, context?: { taskId: string; calendarId: string }) => {
                tick();
                writes.push(['createEvent', calendarId, details]);
                eventContexts.push(['createEvent', calendarId, context]);
                return `event-${writes.length}`;
            },
            updateEvent: async (id, details, context?: { taskId: string; calendarId: string }) => {
                tick(); writes.push(['updateEvent', id, details.title]); eventContexts.push(['updateEvent', id, context]);
            },
            deleteEvent: async (id, context?: { taskId: string; calendarId: string }) => {
                tick(); writes.push(['deleteEvent', id]); eventContexts.push(['deleteEvent', id, context]);
            },
        },
        syncEntries: {
            ensureReady: async () => undefined,
            get: async (taskId) => entries.get(taskId) ?? null,
            upsert: async (entry) => { tick(); entries.set(entry.taskId, entry); },
            delete: async (taskId) => { tick(); writes.push(['deleteSyncEntry', taskId]); entries.delete(taskId); },
            getAll: async () => [...entries.values()],
        },
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
        store: store as unknown as CalendarPushServiceHost['store'],
    };
    return {
        host, storage, calendars, entries, writes, eventContexts, life,
        setTasks: (next: Task[]) => {
            tasks = next;
            listeners.forEach((listener) => listener(next));
        },
    };
}

type Phone = ReturnType<typeof device>;

/**
 * A death between each pair of steps: runs `operation` on a device that dies before its
 * first write, then before its second, and so on, until a run finishes. After each death a
 * new service over the same device (a restart) runs `retry`; `check` sees every outcome.
 */
async function everyDeath(
    setup: () => Phone,
    operation: (service: ReturnType<typeof createCalendarPushService>) => Promise<unknown>,
    check: (phone: Phone, dieAt: number) => void,
    retry = operation,
) {
    for (let dieAt = 1; dieAt < 100; dieAt += 1) {
        const phone = setup();
        phone.life.dieAt = dieAt;
        await operation(createCalendarPushService(phone.host)).catch((error: unknown) => {
            if (!(error instanceof Death)) throw error;
        });
        const died = phone.life.died;
        phone.life.dieAt = Infinity;
        phone.life.died = false;
        if (died) await retry(createCalendarPushService(phone.host));
        check(phone, dieAt);
        if (!died) return dieAt;
    }
    throw new Error('The operation never finished');
}

describe('calendar push behind the host ports', () => {
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    it('reuses the saved Mindwtr calendar across a restart and makes a new one only when it is gone', async () => {
        const phone = device();
        const first = createCalendarPushService(phone.host);
        expect(await first.ensureMindwtrCalendar()).toBe('created-1');
        expect(phone.writes).toEqual([['createCalendar', 'Mindwtr', 'alex@gmail.com']]);
        // A restart: a new service over the same device.
        const restarted = createCalendarPushService(phone.host);
        expect(await restarted.ensureMindwtrCalendar()).toBe('created-1');
        expect(phone.writes).toHaveLength(1);
        // Deleted outside the app: made again, once.
        phone.calendars.splice(phone.calendars.findIndex((calendar) => calendar.id === 'created-1'), 1);
        expect(await restarted.ensureMindwtrCalendar()).toBe('created-2');
        expect(phone.storage.get(CALENDAR_PUSH_CALENDAR_ID_KEY)).toBe('created-2');
    });

    it('deletes only the calendar it saved, never one another install named the same way, and forgets only its pushed events', async () => {
        const phone = device({
            calendars: [
                PRIMARY,
                { id: 'saved', title: 'Anything', ownerAccount: 'alex@gmail.com', accessLevel: 'owner', source: google },
                { id: 'app-made', title: 'Mindwtr', name: 'mindwtr', accessLevel: 'owner', source: google },
                { id: 'users-own', title: 'Mindwtr', name: 'alex@gmail.com', accessLevel: 'owner', source: google },
            ],
            storage: { [CALENDAR_PUSH_CALENDAR_ID_KEY]: 'saved', [CALENDAR_PUSH_TARGET_ID_KEY]: 'app-made' },
            entries: [
                { taskId: 't1', calendarEventId: 'e1', calendarId: 'saved', platform: 'android', lastSyncedAt: '' },
                { taskId: 't2', calendarEventId: 'e2', calendarId: 'users-own', platform: 'android', lastSyncedAt: '' },
            ],
        });
        await createCalendarPushService(phone.host).deleteMindwtrCalendar();
        expect(phone.writes).toEqual([['deleteCalendar', 'saved'], ['deleteSyncEntry', 't1']]);
        expect(phone.calendars.map((calendar) => calendar.id)).toEqual(['primary', 'app-made', 'users-own']);
        expect(phone.storage.has(CALENDAR_PUSH_CALENDAR_ID_KEY)).toBe(false);
        // The chosen calendar was not the one deleted: it stays chosen.
        expect(phone.storage.get(CALENDAR_PUSH_TARGET_ID_KEY)).toBe('app-made');
        expect([...phone.entries.keys()]).toEqual(['t2']);
    });

    it.each([
        { os: 'android', availability: 'absent' }, { os: 'android', availability: 'read-only' },
        { os: 'ios', availability: 'absent' }, { os: 'ios', availability: 'read-only' },
    ])('keeps an unrelated selected target during owned-calendar deletion: $os/$availability', async ({ os, availability }) => {
        const phone = device({
            os,
            calendars: [PRIMARY, { ...PRIMARY, id: 'saved', title: 'Mindwtr' },
                ...(availability === 'read-only' ? [{ id: 'selected', title: 'Personal', allowsModifications: false }] : [])],
            storage: { [CALENDAR_PUSH_CALENDAR_ID_KEY]: 'saved', [CALENDAR_PUSH_TARGET_ID_KEY]: 'selected' },
            entries: [
                { taskId: 'owned-task', calendarEventId: 'owned-event', calendarId: 'saved', platform: 'android', lastSyncedAt: '' },
                { taskId: 'selected-task', calendarEventId: 'selected-event', calendarId: 'selected', platform: 'android', lastSyncedAt: '' },
            ],
        });
        const proof: unknown[] = [];
        phone.host.log.info = (message, context) => {
            if (context.extra?.releaseCheck === 'v1.3.5/calendar-delete-target') proof.push([message, context.extra]);
        };
        await createCalendarPushService(phone.host).deleteMindwtrCalendar();
        expect(phone.writes).toEqual([['deleteCalendar', 'saved'], ['deleteSyncEntry', 'owned-task']]);
        expect(phone.storage.get(CALENDAR_PUSH_TARGET_ID_KEY)).toBe('selected');
        expect(phone.storage.has(CALENDAR_PUSH_CALENDAR_ID_KEY)).toBe(false);
        expect([...phone.entries.keys()]).toEqual(['selected-task']);
        expect(proof).toEqual([['Calendar deletion kept the selected target', {
            releaseCheck: 'v1.3.5/calendar-delete-target', outcome: 'preserved',
        }]]);
    });

    it('makes exactly one Mindwtr calendar however its creation is cut short', async () => {
        await everyDeath(
            () => device(),
            (service) => service.ensureMindwtrCalendar(),
            (phone, dieAt) => {
                const made = phone.calendars.filter((calendar) => calendar.title === 'Mindwtr');
                expect({ dieAt, made: made.length }).toEqual({ dieAt, made: 1 });
                expect({ dieAt, saved: phone.storage.get(CALENDAR_PUSH_CALENDAR_ID_KEY), pending: phone.storage.has(CALENDAR_PUSH_PENDING_KEY) })
                    .toEqual({ dieAt, saved: made[0].id, pending: false });
                expect(made[0].name).toMatch(/^mindwtr:[0-9a-f-]{36}$/);
            },
        );
    });

    it('recovers one exact iOS calendar across every creation write and restart', async () => {
        await everyDeath(
            () => device({ os: 'ios' }),
            (service) => service.ensureMindwtrCalendar(),
            (phone, dieAt) => {
                const made = phone.calendars.filter((calendar) => calendar.id !== 'primary');
                expect({ dieAt, count: made.length, title: made[0]?.title }).toEqual({ dieAt, count: 1, title: 'Mindwtr' });
                expect(phone.storage.get(CALENDAR_PUSH_CALENDAR_ID_KEY)).toBe(made[0].id);
                expect(phone.storage.has(CALENDAR_PUSH_CREATION_INTENT_KEY)).toBe(false);
            },
        );
    });

    it('recovers the unique calendar when native create succeeded but its response was lost', async () => {
        const phone = device({ os: 'ios' });
        phone.life.lostCreateResponse = true;
        expect(await createCalendarPushService(phone.host).ensureMindwtrCalendar()).toBeNull();
        const title = phone.calendars.find((calendar) => calendar.id === 'created-1')?.title;
        expect(title).toMatch(/^Mindwtr \([0-9a-f-]{36}\)$/);
        expect(JSON.parse(phone.storage.get(CALENDAR_PUSH_CREATION_INTENT_KEY)!)).toEqual({ title });
        phone.life.lostCreateResponse = false;
        expect(await createCalendarPushService(phone.host).ensureMindwtrCalendar()).toBe('created-1');
        expect(phone.calendars.filter((calendar) => calendar.id !== 'primary')).toHaveLength(1);
        expect(phone.calendars.find((calendar) => calendar.id === 'created-1')?.title).toBe('Mindwtr');
    });

    it('fails closed on corrupt, duplicate, and conflicting iOS creation intents', async () => {
        const title = 'Mindwtr (12345678-1234-4234-8234-123456789abc)';
        const cases = [
            { intent: 'oops', calendars: [PRIMARY] },
            { intent: JSON.stringify({ title }), calendars: [PRIMARY, { id: 'a', title }, { id: 'b', title }] },
            { intent: JSON.stringify({ title, calendarId: 'a' }), calendars: [PRIMARY, { id: 'a', title }, { id: 'b', title }] },
            { intent: JSON.stringify({ title, calendarId: 'a' }), calendars: [PRIMARY, { id: 'a', title }, { id: 'saved', title: 'Mindwtr' }], stored: 'saved' },
            { intent: JSON.stringify({ title, deletionRevision: 'a'.repeat(32) }), calendars: [PRIMARY] },
            { intent: JSON.stringify({ title, calendarId: '', deletionRevision: 'a'.repeat(32) }), calendars: [PRIMARY] },
            { intent: JSON.stringify({ title, calendarId: 'a', deletionRevision: 'A'.repeat(32) }), calendars: [PRIMARY, { id: 'a', title }] },
            { intent: JSON.stringify({ title, calendarId: 'a', deletionRevision: 42 }), calendars: [PRIMARY, { id: 'a', title }] },
        ];
        for (const item of cases) {
            const phone = device({ os: 'ios', calendars: item.calendars, storage: {
                [CALENDAR_PUSH_CREATION_INTENT_KEY]: item.intent,
                ...(item.stored ? { [CALENDAR_PUSH_CALENDAR_ID_KEY]: item.stored } : {}),
            } });
            expect(await createCalendarPushService(phone.host).ensureMindwtrCalendar()).toBeNull();
            await expect(createCalendarPushService(phone.host).deleteMindwtrCalendar()).rejects.toThrow();
            expect(phone.writes).toEqual([]);
            expect(phone.storage.get(CALENDAR_PUSH_CREATION_INTENT_KEY)).toBe(item.intent);
        }
    });

    it('keeps an iOS intent and all state when listing fails, then finalizes on retry', async () => {
        const title = 'Mindwtr (12345678-1234-4234-8234-123456789abc)';
        const phone = device({ os: 'ios', calendars: [PRIMARY, { id: 'pending', title }], storage: {
            [CALENDAR_PUSH_CREATION_INTENT_KEY]: JSON.stringify({ title }),
        } });
        phone.life.failList = true;
        expect(await createCalendarPushService(phone.host).ensureMindwtrCalendar()).toBeNull();
        await expect(createCalendarPushService(phone.host).deleteMindwtrCalendar()).rejects.toThrow('unavailable');
        await expect(createCalendarPushService(phone.host).updateMindwtrCalendarColor('#059669')).resolves.toBe(false);
        expect(phone.storage.get(CALENDAR_PUSH_CREATION_INTENT_KEY)).toBe(JSON.stringify({ title }));
        expect(phone.writes).toEqual([]);
        phone.life.failList = false;
        expect(await createCalendarPushService(phone.host).ensureMindwtrCalendar()).toBe('pending');
        expect(phone.storage.has(CALENDAR_PUSH_CREATION_INTENT_KEY)).toBe(false);
    });

    it('serializes a concurrent iOS ensure, recolor, and delete around the pending intent', async () => {
        const phone = device({ os: 'ios' });
        const create = phone.host.calendars.createCalendar;
        let finishCreate: (() => void) | undefined;
        phone.host.calendars.createCalendar = async (details) => {
            await new Promise<void>((resolve) => { finishCreate = resolve; });
            return create(details);
        };
        const service = createCalendarPushService(phone.host);
        const ensuring = service.ensureMindwtrCalendar();
        await vi.waitFor(() => expect(finishCreate).toBeTypeOf('function'));
        const coloring = service.updateMindwtrCalendarColor('#059669');
        const deleting = service.deleteMindwtrCalendar();
        expect(await service.ensureMindwtrCalendar()).toBeNull();
        finishCreate!();
        expect(await ensuring).toBe('created-1');
        expect(await coloring).toBe(true);
        await deleting;
        expect(phone.calendars.map((calendar) => calendar.id)).toEqual(['primary']);
        expect(phone.storage.has(CALENDAR_PUSH_CREATION_INTENT_KEY)).toBe(false);
        expect(phone.storage.has(CALENDAR_PUSH_CALENDAR_ID_KEY)).toBe(false);
        expect(phone.writes.filter((write) => write[0] === 'createCalendar')).toHaveLength(1);
    });

    it('checks expected ownership after an in-flight iOS creation finishes', async () => {
        const phone = device({ os: 'ios' });
        const create = phone.host.calendars.createCalendar;
        let finishCreate: (() => void) | undefined;
        phone.host.calendars.createCalendar = async (details) => {
            await new Promise<void>((resolve) => { finishCreate = resolve; });
            return create(details);
        };
        const service = createCalendarPushService(phone.host);
        const ensuring = service.ensureMindwtrCalendar();
        await vi.waitFor(() => expect(finishCreate).toBeTypeOf('function'));
        const deleting = service.deleteMindwtrCalendar({
            calendarId: null,
            creationIntentRevision: deterministicHash128Hex(phone.storage.get(CALENDAR_PUSH_CREATION_INTENT_KEY)!),
        });
        const refused = expect(deleting).rejects.toThrow('changed before deletion');
        finishCreate!();
        expect(await ensuring).toBe('created-1');
        await refused;
        expect(phone.calendars.map((calendar) => calendar.id)).toEqual(['primary', 'created-1']);
        expect(phone.storage.get(CALENDAR_PUSH_CALENDAR_ID_KEY)).toBe('created-1');
        expect(phone.writes.filter(([name]) => name === 'deleteCalendar')).toEqual([]);
    });

    it('queues a different Delete expectation after a stale request instead of sharing its result', async () => {
        const phone = device({ os: 'ios', calendars: [PRIMARY, { id: 'saved', title: 'Mindwtr' }], storage: {
            [CALENDAR_PUSH_CALENDAR_ID_KEY]: 'saved',
        } });
        const service = createCalendarPushService(phone.host);
        const stale = service.deleteMindwtrCalendar({ calendarId: 'old', creationIntentRevision: null });
        const current = service.deleteMindwtrCalendar({ calendarId: 'saved', creationIntentRevision: null });
        await expect(stale).rejects.toThrow('changed before deletion');
        await current;
        expect(phone.calendars.map((calendar) => calendar.id)).toEqual(['primary']);
        expect(phone.writes.filter(([name]) => name === 'deleteCalendar')).toEqual([['deleteCalendar', 'saved']]);
    });

    it('guards the raw iOS intent revision and permits completion once that intent is gone', async () => {
        const title = 'Mindwtr (12345678-1234-4234-8234-123456789abc)';
        const intent = JSON.stringify({ title }, null, 2);
        const phone = device({ os: 'ios', calendars: [PRIMARY, { id: 'personal', title: 'Mindwtr' }, { id: 'pending', title }], storage: {
            [CALENDAR_PUSH_CREATION_INTENT_KEY]: intent,
        } });
        const service = createCalendarPushService(phone.host);
        await expect(service.deleteMindwtrCalendar({ calendarId: null, creationIntentRevision: deterministicHash128Hex('older intent') }))
            .rejects.toBeInstanceOf(CalendarPushOwnershipChangedError);
        expect(phone.writes).toEqual([]);
        expect(phone.storage.get(CALENDAR_PUSH_CREATION_INTENT_KEY)).toBe(intent);
        const expected = { calendarId: null, creationIntentRevision: deterministicHash128Hex(intent) };
        await service.deleteMindwtrCalendar(expected);
        await service.deleteMindwtrCalendar(expected);
        expect(phone.calendars.map((calendar) => calendar.id)).toEqual(['primary', 'personal']);
        expect(phone.writes.filter(([name]) => name === 'deleteCalendar')).toEqual([['deleteCalendar', 'pending']]);
        expect(phone.storage.has(CALENDAR_PUSH_CREATION_INTENT_KEY)).toBe(false);
    });

    it('saves durable iOS deletion progress before provider removal and keeps the original expectation retryable', async () => {
        const title = 'Mindwtr (12345678-1234-4234-8234-123456789abc)';
        const intent = JSON.stringify({ title });
        const phone = device({ os: 'ios', calendars: [PRIMARY, { id: 'pending', title }], storage: {
            [CALENDAR_PUSH_CREATION_INTENT_KEY]: intent,
        } });
        const expected = { calendarId: null, creationIntentRevision: deterministicHash128Hex(intent) };
        const deleting = vi.spyOn(phone.host.calendars, 'deleteCalendar');
        phone.life.dieAt = 1;
        await expect(createCalendarPushService(phone.host).deleteMindwtrCalendar(expected)).rejects.toThrow();
        expect(phone.writes).toEqual([]);
        expect(deleting).not.toHaveBeenCalled();
        expect(phone.storage.get(CALENDAR_PUSH_CREATION_INTENT_KEY)).toBe(intent);
        expect(phone.calendars.map((calendar) => calendar.id)).toEqual(['primary', 'pending']);
        phone.life.dieAt = Infinity;
        phone.life.died = false;
        const remove = phone.host.calendars.deleteCalendar;
        phone.host.calendars.deleteCalendar = async (id) => {
            expect(JSON.parse(phone.storage.get(CALENDAR_PUSH_CREATION_INTENT_KEY)!)).toEqual({
                title, calendarId: 'pending', deletionRevision: expected.creationIntentRevision,
            });
            await remove(id);
            phone.life.failList = true;
            throw new Error('Native delete response lost');
        };
        await expect(createCalendarPushService(phone.host).deleteMindwtrCalendar(expected)).rejects.toThrow('response lost');
        phone.life.failList = false;
        await createCalendarPushService(phone.host).deleteMindwtrCalendar(expected);
        expect(phone.calendars.map((calendar) => calendar.id)).toEqual(['primary']);
        expect(phone.storage.has(CALENDAR_PUSH_CREATION_INTENT_KEY)).toBe(false);
        expect(phone.writes.filter(([name]) => name === 'deleteCalendar')).toEqual([['deleteCalendar', 'pending']]);
    });

    it.each([false, true])('iOS ensure preserves deletion-phase ownership and cleanup clears its mapping (visible: %s)', async (visible) => {
        const title = 'Mindwtr (12345678-1234-4234-8234-123456789abc)';
        const revision = deterministicHash128Hex(JSON.stringify({ title }));
        const intent = JSON.stringify({ title, calendarId: 'pending', deletionRevision: revision });
        const phone = device({ os: 'ios', calendars: [PRIMARY, { id: 'personal', title: 'Mindwtr' }, ...(visible ? [{ id: 'pending', title }] : [])], storage: {
            [CALENDAR_PUSH_CREATION_INTENT_KEY]: intent,
        }, entries: [
            { taskId: 'owned', calendarId: 'pending', calendarEventId: 'event', platform: 'android', lastSyncedAt: '' },
            { taskId: 'other', calendarId: 'primary', calendarEventId: 'other-event', platform: 'android', lastSyncedAt: '' },
        ] });
        expect(await createCalendarPushService(phone.host).ensureMindwtrCalendar()).toBeNull();
        expect(phone.writes).toEqual([]);
        expect(phone.storage.get(CALENDAR_PUSH_CREATION_INTENT_KEY)).toBe(intent);
        await createCalendarPushService(phone.host).deleteMindwtrCalendar({ calendarId: null, creationIntentRevision: revision });
        expect(phone.calendars.map((calendar) => calendar.id)).toEqual(['primary', 'personal']);
        expect([...phone.entries.keys()]).toEqual(['other']);
        expect(phone.storage.has(CALENDAR_PUSH_CREATION_INTENT_KEY)).toBe(false);
    });

    it('does not create a second iOS calendar while recolor is recovering an unfinished creation', async () => {
        const title = 'Mindwtr (12345678-1234-4234-8234-123456789abc)';
        const phone = device({ os: 'ios', storage: { [CALENDAR_PUSH_CREATION_INTENT_KEY]: JSON.stringify({ title }) } });
        const create = phone.host.calendars.createCalendar;
        let finishCreate: (() => void) | undefined;
        let createRequests = 0;
        phone.host.calendars.createCalendar = async (details) => {
            createRequests += 1;
            await new Promise<void>((resolve) => { finishCreate = resolve; });
            return create(details);
        };
        const service = createCalendarPushService(phone.host);
        const coloring = service.updateMindwtrCalendarColor('#059669');
        await vi.waitFor(() => expect(finishCreate).toBeTypeOf('function'));
        const ensuring = service.ensureMindwtrCalendar();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(createRequests).toBe(1);
        finishCreate!();
        expect(await coloring).toBe(true);
        expect(await ensuring).toBe('created-1');
        expect(phone.writes.filter((write) => write[0] === 'createCalendar')).toHaveLength(1);
    });

    it('iOS never adopts or deletes an unrelated plain Mindwtr calendar by title', async () => {
        const phone = device({ os: 'ios', calendars: [PRIMARY, { id: 'left-over', title: 'Mindwtr', accessLevel: 'owner', allowsModifications: true, source: google }] });
        const service = createCalendarPushService(phone.host);
        const made = await service.ensureMindwtrCalendar();
        expect(made).not.toBe('left-over');
        await service.deleteMindwtrCalendar();
        expect(phone.calendars.map((calendar) => calendar.id)).toEqual(['primary', 'left-over']);
        expect(phone.storage.has(CALENDAR_PUSH_PENDING_KEY)).toBe(false);
    });

    it('iOS cleanup deletes only the pending exact title or its bound ID, never a plain same-name calendar', async () => {
        const title = 'Mindwtr (12345678-1234-4234-8234-123456789abc)';
        for (const bound of [false, true]) {
            const phone = device({ os: 'ios', calendars: [
                PRIMARY,
                { id: 'personal', title: 'Mindwtr' },
                { id: 'pending', title: bound ? 'Mindwtr' : title },
            ], storage: {
                [CALENDAR_PUSH_CREATION_INTENT_KEY]: JSON.stringify({ title, ...(bound ? { calendarId: 'pending' } : {}) }),
                ...(bound ? { [CALENDAR_PUSH_CALENDAR_ID_KEY]: 'pending' } : {}),
            } });
            await createCalendarPushService(phone.host).deleteMindwtrCalendar();
            expect(phone.writes.filter((write) => write[0] === 'deleteCalendar')).toEqual([['deleteCalendar', 'pending']]);
            expect(phone.calendars.map((calendar) => calendar.id)).toEqual(['primary', 'personal']);
            expect(phone.storage.has(CALENDAR_PUSH_CREATION_INTENT_KEY)).toBe(false);
        }
    });

    it.each([{ label: 'unbound', bound: false }, { label: 'bound', bound: true }])('iOS cleanup retains an unresolved $label intent until its calendar appears', async ({ bound }) => {
        const title = 'Mindwtr (12345678-1234-4234-8234-123456789abc)';
        const intent = JSON.stringify({ title, ...(bound ? { calendarId: 'pending' } : {}) });
        const savedId = bound ? 'pending' : 'stale';
        const phone = device({ os: 'ios', calendars: [
            PRIMARY,
            { id: 'personal', title: 'Mindwtr' },
            { id: 'pending', title: bound ? 'Mindwtr' : title },
        ], storage: {
            [CALENDAR_PUSH_CREATION_INTENT_KEY]: intent,
            [CALENDAR_PUSH_CALENDAR_ID_KEY]: savedId,
            [CALENDAR_PUSH_TARGET_ID_KEY]: 'pending',
        }, entries: [{ taskId: 'task', calendarEventId: 'event', calendarId: 'pending', platform: 'android', lastSyncedAt: '' }] });
        const list = phone.host.calendars.getCalendars;
        let visible = false;
        phone.host.calendars.getCalendars = async () => (await list()).filter((calendar) => visible || calendar.id !== 'pending');

        await expect(createCalendarPushService(phone.host).deleteMindwtrCalendar()).rejects.toThrow('Cannot identify pending Mindwtr calendar');
        expect(Object.fromEntries(phone.storage)).toEqual({
            [CALENDAR_PUSH_CREATION_INTENT_KEY]: intent,
            [CALENDAR_PUSH_CALENDAR_ID_KEY]: savedId,
            [CALENDAR_PUSH_TARGET_ID_KEY]: 'pending',
        });
        expect(phone.entries.has('task')).toBe(true);
        expect(phone.writes).toEqual([]);

        visible = true;
        await createCalendarPushService(phone.host).deleteMindwtrCalendar();
        expect(phone.writes.filter((write) => write[0] === 'deleteCalendar')).toEqual([['deleteCalendar', 'pending']]);
        expect(phone.calendars.map((calendar) => calendar.id)).toEqual(['primary', 'personal']);
        expect(phone.entries.has('task')).toBe(false);
        expect(phone.storage.has(CALENDAR_PUSH_CREATION_INTENT_KEY)).toBe(false);
        expect(phone.storage.has(CALENDAR_PUSH_CALENDAR_ID_KEY)).toBe(false);
        expect(phone.storage.has(CALENDAR_PUSH_TARGET_ID_KEY)).toBe(false);
    });

    it('deletes a calendar a cut-short creation made, and no other install\'s', async () => {
        const token = '11111111-1111-4111-8111-111111111111';
        const phone = device({
            calendars: [
                PRIMARY,
                { id: 'made-here', title: 'Mindwtr', name: `mindwtr:${token}`, accessLevel: 'owner', source: google },
                { id: 'made-elsewhere', title: 'Mindwtr', name: 'mindwtr:22222222-2222-4222-8222-222222222222', accessLevel: 'owner', source: google },
            ],
            storage: { [CALENDAR_PUSH_PENDING_KEY]: token },
        });
        await createCalendarPushService(phone.host).deleteMindwtrCalendar();
        expect(phone.calendars.map((calendar) => calendar.id)).toEqual(['primary', 'made-elsewhere']);
        expect(Object.fromEntries(phone.storage)).toEqual({});
    });

    it.each(['android', 'ios'])('changes the Mindwtr calendar color on %s before storing it, so a change cut short at any step finishes', async (os) => {
        await everyDeath(
            () => device({
                os,
                calendars: [PRIMARY, { id: 'saved', title: 'Mindwtr', name: 'mindwtr', color: '#3B82F6', accessLevel: 'owner', allowsModifications: true, source: google }],
                storage: { [CALENDAR_PUSH_ENABLED_KEY]: '1', [CALENDAR_PUSH_CALENDAR_ID_KEY]: 'saved', [CALENDAR_PUSH_COLOR_KEY]: '#3B82F6' },
            }),
            (service) => service.updateMindwtrCalendarColor('#059669'),
            (phone, dieAt) => {
                // The next push run makes the calendar if the change stopped between its delete and its create.
                const stored = phone.storage.get(CALENDAR_PUSH_COLOR_KEY);
                const own = phone.calendars.filter((calendar) => calendar.title === 'Mindwtr');
                expect({ dieAt, stored, own: own.length <= 1 }).toEqual({ dieAt, stored: '#059669', own: true });
                if (own.length === 1) {
                    expect({ dieAt, color: own[0].color, saved: phone.storage.get(CALENDAR_PUSH_CALENDAR_ID_KEY) })
                        .toEqual({ dieAt, color: '#059669', saved: own[0].id });
                }
            },
            // A retry is what a caller sends: React Native's re-pick and the contract's replay skip a color already stored.
            async (service) => {
                if (planCalendarPushColor(await service.getCalendarPushColor(), '#059669')) await service.updateMindwtrCalendarColor('#059669');
            },
        );
    });

    it.each(['android', 'ios'])('a color change the device refuses on %s stores nothing and rejects, so a retry changes it', async (os) => {
        const phone = device({
            os,
            calendars: [PRIMARY, { id: 'saved', title: 'Mindwtr', name: 'mindwtr', color: '#3B82F6', accessLevel: 'owner', allowsModifications: true, source: google }],
            storage: { [CALENDAR_PUSH_CALENDAR_ID_KEY]: 'saved', [CALENDAR_PUSH_COLOR_KEY]: '#3B82F6' },
        });
        phone.life.failDelete = true;
        phone.life.failUpdate = true;
        await expect(createCalendarPushService(phone.host).updateMindwtrCalendarColor('#059669')).rejects.toThrow('refused');
        expect(phone.storage.get(CALENDAR_PUSH_COLOR_KEY)).toBe('#3B82F6');
        expect(phone.calendars.find((calendar) => calendar.id === 'saved')?.color).toBe('#3B82F6');
        phone.life.failDelete = false;
        phone.life.failUpdate = false;
        expect(await createCalendarPushService(phone.host).updateMindwtrCalendarColor('#059669')).toBe(true);
        expect(phone.storage.get(CALENDAR_PUSH_COLOR_KEY)).toBe('#059669');
    });

    it('stores the color for the next calendar only when there is no calendar yet', async () => {
        const phone = device({ storage: { [CALENDAR_PUSH_COLOR_KEY]: '#3B82F6' } });
        expect(await createCalendarPushService(phone.host).updateMindwtrCalendarColor('#059669')).toBe(false);
        expect(phone.storage.get(CALENDAR_PUSH_COLOR_KEY)).toBe('#059669');
        expect(phone.writes).toEqual([]);
    });

    it('a death after the device calendar changed color stores it on the retry without changing the calendar again', async () => {
        const phone = device({
            os: 'ios',
            calendars: [PRIMARY, { id: 'saved', title: 'Mindwtr', color: '#3B82F6', accessLevel: 'owner', allowsModifications: true, source: google }],
            storage: { [CALENDAR_PUSH_CALENDAR_ID_KEY]: 'saved', [CALENDAR_PUSH_COLOR_KEY]: '#3B82F6' },
        });
        phone.life.dieAt = 2;
        await createCalendarPushService(phone.host).updateMindwtrCalendarColor('#059669').catch(() => undefined);
        expect(phone.writes).toEqual([['updateCalendar', 'saved', '#059669']]);
        expect(phone.storage.get(CALENDAR_PUSH_COLOR_KEY)).toBe('#3B82F6');
        phone.life.dieAt = Infinity;
        phone.life.died = false;
        expect(await createCalendarPushService(phone.host).updateMindwtrCalendarColor('#059669')).toBe(true);
        expect(phone.writes).toEqual([['updateCalendar', 'saved', '#059669']]);
        expect(phone.storage.get(CALENDAR_PUSH_COLOR_KEY)).toBe('#059669');
    });

    it('clears nothing when the device cannot list its calendars', async () => {
        const marker = '11111111-1111-4111-8111-111111111111';
        const setups = [
            // A creation cut short: the marked calendar exists.
            { calendars: [PRIMARY, { id: 'made', title: 'Mindwtr', name: `mindwtr:${marker}`, accessLevel: 'owner', source: google }], storage: { [CALENDAR_PUSH_PENDING_KEY]: marker } },
            // Nothing saved, a chosen calendar.
            { calendars: [PRIMARY], storage: { [CALENDAR_PUSH_TARGET_ID_KEY]: 'primary' } },
            // A saved calendar.
            { calendars: [PRIMARY, { id: 'saved', title: 'Mindwtr', accessLevel: 'owner', source: google }], storage: { [CALENDAR_PUSH_CALENDAR_ID_KEY]: 'saved', [CALENDAR_PUSH_TARGET_ID_KEY]: 'saved' } },
        ];
        for (const setup of setups) {
            const phone = device(setup);
            phone.life.failList = true;
            await expect(createCalendarPushService(phone.host).deleteMindwtrCalendar()).rejects.toThrow('unavailable');
            await expect(createCalendarPushService(phone.host).updateMindwtrCalendarColor('#059669')).rejects.toThrow('unavailable');
            expect({ storage: Object.fromEntries(phone.storage), calendars: phone.calendars.length }).toEqual({ storage: setup.storage, calendars: setup.calendars.length });
        }
    });

    it('a stale saved ID gives way to the calendar a cut-short creation made', async () => {
        const marker = '11111111-1111-4111-8111-111111111111';
        const setup = () => device({
            calendars: [PRIMARY, { id: 'made', title: 'Mindwtr', name: `mindwtr:${marker}`, color: '#3B82F6', accessLevel: 'owner', allowsModifications: true, source: google }],
            storage: { [CALENDAR_PUSH_CALENDAR_ID_KEY]: 'gone', [CALENDAR_PUSH_PENDING_KEY]: marker, [CALENDAR_PUSH_COLOR_KEY]: '#3B82F6' },
        });
        const deleting = setup();
        await createCalendarPushService(deleting.host).deleteMindwtrCalendar();
        expect(deleting.calendars.map((calendar) => calendar.id)).toEqual(['primary']);
        expect(Object.fromEntries(deleting.storage)).toEqual({ [CALENDAR_PUSH_COLOR_KEY]: '#3B82F6' });
        const recoloring = setup();
        expect(await createCalendarPushService(recoloring.host).updateMindwtrCalendarColor('#059669')).toBe(true);
        const own = recoloring.calendars.filter((calendar) => calendar.title === 'Mindwtr');
        expect(own.map((calendar) => calendar.color)).toEqual(['#059669']);
        expect(recoloring.storage.get(CALENDAR_PUSH_CALENDAR_ID_KEY)).toBe(own[0].id);
    });

    it('keeps the saved ID, the chosen calendar and the pushed events when the delete fails', async () => {
        const phone = device({
            calendars: [PRIMARY, { id: 'saved', title: 'Mindwtr', name: 'mindwtr', accessLevel: 'owner', source: google }],
            storage: { [CALENDAR_PUSH_CALENDAR_ID_KEY]: 'saved', [CALENDAR_PUSH_TARGET_ID_KEY]: 'saved' },
            entries: [{ taskId: 't1', calendarEventId: 'e1', calendarId: 'saved', platform: 'android', lastSyncedAt: '' }],
        });
        phone.life.failDelete = true;
        await expect(createCalendarPushService(phone.host).deleteMindwtrCalendar()).rejects.toThrow();
        expect(phone.calendars.map((calendar) => calendar.id)).toEqual(['primary', 'saved']);
        expect(phone.storage.get(CALENDAR_PUSH_CALENDAR_ID_KEY)).toBe('saved');
        expect(phone.storage.get(CALENDAR_PUSH_TARGET_ID_KEY)).toBe('saved');
        expect([...phone.entries.keys()]).toEqual(['t1']);
        // A retry that succeeds finishes it.
        phone.life.failDelete = false;
        await createCalendarPushService(phone.host).deleteMindwtrCalendar();
        expect(phone.calendars.map((calendar) => calendar.id)).toEqual(['primary']);
        expect(phone.storage.has(CALENDAR_PUSH_CALENDAR_ID_KEY)).toBe(false);
        expect([...phone.entries.keys()]).toEqual([]);
    });

    it.each(['android', 'ios'])('finishes a completed %s calendar delete after a death between any two steps', async (os) => {
        const writes = await everyDeath(
            () => device({
                os,
                calendars: [PRIMARY, { id: 'saved', title: 'Mindwtr', name: 'mindwtr', accessLevel: 'owner', source: google }],
                storage: { [CALENDAR_PUSH_CALENDAR_ID_KEY]: 'saved', [CALENDAR_PUSH_TARGET_ID_KEY]: 'saved' },
                entries: [
                    { taskId: 't1', calendarEventId: 'e1', calendarId: 'saved', platform: 'android', lastSyncedAt: '' },
                    { taskId: 't2', calendarEventId: 'e2', calendarId: 'primary', platform: 'android', lastSyncedAt: '' },
                ],
            }),
            (service) => service.deleteMindwtrCalendar(),
            (phone, dieAt) => {
                expect({ dieAt, calendars: phone.calendars.map((calendar) => calendar.id) }).toEqual({ dieAt, calendars: ['primary'] });
                expect({ dieAt, entries: [...phone.entries.keys()], storage: Object.fromEntries(phone.storage) }).toEqual({ dieAt, entries: ['t2'], storage: {} });
            },
        );
        expect(writes).toBeGreaterThan(3);
    });

    it('recolors only the calendar it saved', async () => {
        const phone = device({
            calendars: [PRIMARY, { id: 'other-install', title: 'Mindwtr', name: 'mindwtr', color: '#3B82F6', accessLevel: 'owner', allowsModifications: true, source: google }],
        });
        expect(await createCalendarPushService(phone.host).updateMindwtrCalendarColor('#059669')).toBe(false);
        expect(phone.writes).toEqual([]);
        expect(phone.calendars.map((calendar) => calendar.id)).toEqual(['primary', 'other-install']);
    });

    it('lists writable calendars: the managed one first, then Mindwtr-named ones, then by name', async () => {
        const phone = device({
            calendars: [
                { id: 'zeta', title: 'Zeta', accessLevel: 'owner', source: google },
                { id: 'read', title: 'Holidays', accessLevel: 'read', source: google },
                { id: 'frozen', title: 'Frozen', allowsModifications: false, source: google },
                { id: 'named', title: 'Mindwtr', accessLevel: 'owner', source: { name: 'local account', type: 'LOCAL' } },
                { id: 'alpha', title: 'Alpha', accessLevel: 'owner', source: google },
                { id: 'managed', title: 'Tasks', accessLevel: 'owner', source: google },
            ],
            storage: { [CALENDAR_PUSH_CALENDAR_ID_KEY]: 'managed' },
        });
        const targets = await createCalendarPushService(phone.host).getCalendarPushTargetCalendars();
        expect(targets.map((target) => [target.id, target.isMindwtrManaged, target.isMindwtrDedicated, target.isLocalOnly, target.sourceName])).toEqual([
            ['managed', true, false, false, 'alex@gmail.com'],
            ['named', false, true, true, 'local account'],
            ['alpha', false, false, false, 'alex@gmail.com'],
            ['zeta', false, false, false, 'alex@gmail.com'],
        ]);
    });

    it('pushes a date-only task as an Android all-day event on UTC midnights, and a store change as one debounced partial push', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const dated = task('t1', { dueDate: '2026-09-10' });
        const phone = device({ storage: { [CALENDAR_PUSH_ENABLED_KEY]: '1' }, tasks: [dated, task('t2')] });
        const service = createCalendarPushService(phone.host);
        await service.runFullCalendarSync();
        const created = phone.writes.find(([name]) => name === 'createEvent')!;
        expect(created[1]).toBe('created-1');
        expect(created[2]).toMatchObject({
            title: 'Task t1', allDay: true, timeZone: 'UTC', endTimeZone: 'UTC',
            startDate: new Date(Date.UTC(2026, 8, 10)), endDate: new Date(Date.UTC(2026, 8, 11)),
        });

        service.startCalendarPushSync();
        phone.writes.length = 0;
        phone.setTasks([{ ...dated, title: 'Renamed', updatedAt: '2026-09-02T00:00:00.000Z' }, task('t2')]);
        await vi.advanceTimersByTimeAsync(2_499);
        expect(phone.writes).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(phone.writes.map(([name, id, title]) => [name, id, title])).toEqual([['updateEvent', phone.entries.get('t1')!.calendarEventId, 'Renamed']]);
        service.stopCalendarPushSync();
    });

    it('hands coalesced store changes to admission and writes only when the owner explicitly runs the partial sync', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const first = task('t1', { dueDate: '2026-09-10' });
        const second = task('t2', { dueDate: '2026-09-11' });
        const phone = device({ storage: { [CALENDAR_PUSH_ENABLED_KEY]: '1' }, tasks: [first, second] });
        const requestPartialSync = vi.fn();
        phone.host.requestPartialSync = requestPartialSync;
        const subscribe = vi.spyOn(phone.host.store, 'subscribe');
        const service = createCalendarPushService(phone.host);
        await service.runFullCalendarSync();
        service.startCalendarPushSync();
        service.startCalendarPushSync();
        expect(subscribe).toHaveBeenCalledTimes(1);
        phone.writes.length = 0;

        const renamedFirst = { ...first, title: 'Changed first' };
        const renamedSecond = { ...second, title: 'Changed second' };
        phone.setTasks([renamedFirst, second]);
        await vi.advanceTimersByTimeAsync(2000);
        phone.setTasks([renamedFirst, renamedSecond]);
        await vi.advanceTimersByTimeAsync(2499);
        expect(requestPartialSync).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(requestPartialSync.mock.calls).toEqual([[['t1', 't2']]]);
        expect(phone.writes).toEqual([]);

        await service.runPartialCalendarSync(requestPartialSync.mock.calls[0]![0]);
        expect(phone.writes).toEqual([
            ['updateEvent', phone.entries.get('t1')!.calendarEventId, 'Changed first'],
            ['updateEvent', phone.entries.get('t2')!.calendarEventId, 'Changed second'],
        ]);
        service.stopCalendarPushSync();
    });

    it('serializes native-owned partial and full provider writes and snapshots caller IDs', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const dated = task('t1', { dueDate: '2026-09-10' });
        const phone = device({
            storage: { [CALENDAR_PUSH_ENABLED_KEY]: '1', [CALENDAR_PUSH_TARGET_ID_KEY]: PRIMARY.id },
            tasks: [dated],
        });
        phone.host.requestPartialSync = vi.fn();
        const order: string[] = [];
        let releaseFull: (() => void) | undefined;
        let releasePartial: (() => void) | undefined;
        const createEvent = phone.host.calendars.createEvent;
        const updateEvent = phone.host.calendars.updateEvent;
        phone.host.calendars.createEvent = async (...args) => {
            order.push('create:start');
            await new Promise<void>((resolve) => { releaseFull = resolve; });
            const id = await createEvent(...args);
            order.push('create:end');
            return id;
        };
        let updateCount = 0;
        phone.host.calendars.updateEvent = async (...args) => {
            const count = ++updateCount;
            order.push(`update:${count}:start`);
            if (count === 1) await new Promise<void>((resolve) => { releasePartial = resolve; });
            await updateEvent(...args);
            order.push(`update:${count}:end`);
        };
        phone.host.log.info = (message) => { if (message === 'Full calendar sync complete') order.push('full:complete'); };
        const service = createCalendarPushService(phone.host);

        const firstFull = service.runFullCalendarSync();
        await vi.advanceTimersByTimeAsync(0);
        expect(order).toEqual(['create:start']);
        phone.setTasks([{ ...dated, title: 'Changed' }]);
        const taskIds = ['t1'];
        const partial = service.runPartialCalendarSync(taskIds);
        taskIds.splice(0, taskIds.length, 'mutated');
        const secondFull = service.runFullCalendarSync();
        await vi.advanceTimersByTimeAsync(0);
        expect(order).toEqual(['create:start']);

        releaseFull?.();
        await firstFull;
        await vi.advanceTimersByTimeAsync(0);
        expect(order).toEqual(['create:start', 'create:end', 'full:complete', 'update:1:start']);

        releasePartial?.();
        await Promise.all([partial, secondFull]);
        expect(order).toEqual([
            'create:start', 'create:end', 'full:complete', 'update:1:start', 'update:1:end',
            'update:2:start', 'update:2:end', 'full:complete',
        ]);
        expect(phone.writes.map(([method]) => method)).toEqual(['createEvent', 'updateEvent', 'updateEvent']);
        expect(phone.host.requestPartialSync).not.toHaveBeenCalled();
    });

    it('cancels the pending handoff and watcher on stop, then starts a fresh watcher', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const phone = device({ tasks: [task('t1'), task('t2')] });
        const requestPartialSync = vi.fn();
        phone.host.requestPartialSync = requestPartialSync;
        const service = createCalendarPushService(phone.host);
        service.startCalendarPushSync();
        phone.setTasks([task('t1', { title: 'Pending change' }), task('t2')]);
        await vi.advanceTimersByTimeAsync(2499);
        service.stopCalendarPushSync();
        phone.setTasks([task('t1', { title: 'While stopped' }), task('t2')]);
        await vi.advanceTimersByTimeAsync(2500);
        expect(requestPartialSync).not.toHaveBeenCalled();
        expect(phone.writes).toEqual([]);

        service.startCalendarPushSync();
        phone.setTasks([task('t1', { title: 'While stopped' }), task('t2', { title: 'Fresh change' })]);
        await vi.advanceTimersByTimeAsync(2500);
        expect(requestPartialSync.mock.calls).toEqual([[['t2']]]);
        expect(phone.writes).toEqual([]);
        service.stopCalendarPushSync();
    });

    it('retires an existing watcher and pending handoff while sandbox is active', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const sandboxMode = vi.spyOn(sandbox, 'isSandboxMode').mockReturnValue(false);
        const phone = device({ tasks: [task('t1')] });
        const requestPartialSync = vi.fn(); phone.host.requestPartialSync = requestPartialSync;
        const unsubscribe = vi.fn();
        const subscribe = phone.host.store.subscribe;
        vi.spyOn(phone.host.store, 'subscribe').mockImplementation((...args) => {
            const stop = subscribe(...args);
            return () => { unsubscribe(); stop(); };
        });
        const service = createCalendarPushService(phone.host);
        service.startCalendarPushSync();
        phone.setTasks([task('t1', { title: 'Pending change' })]);
        sandboxMode.mockReturnValue(true);
        service.stopCalendarPushSync();
        expect(unsubscribe).toHaveBeenCalledOnce();
        sandboxMode.mockReturnValue(false);
        phone.setTasks([task('t1', { title: 'While stopped' })]);
        await vi.advanceTimersByTimeAsync(2500);
        expect(requestPartialSync).not.toHaveBeenCalled(); expect(phone.writes).toEqual([]);
    });

    it('neither requests admission nor runs full or partial calendar work in sandbox', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        vi.spyOn(sandbox, 'isSandboxMode').mockReturnValue(true);
        const phone = device({ storage: { [CALENDAR_PUSH_ENABLED_KEY]: '1' }, tasks: [task('t1', { dueDate: '2026-09-10' })] });
        const requestPartialSync = vi.fn();
        phone.host.requestPartialSync = requestPartialSync;
        const getItem = vi.spyOn(phone.host.storage, 'getItem');
        const subscribe = vi.spyOn(phone.host.store, 'subscribe');
        const service = createCalendarPushService(phone.host);

        service.startCalendarPushSync();
        service.scheduleSyncDebounced(['t1']);
        await service.runFullCalendarSync();
        await service.runPartialCalendarSync(['t1']);
        phone.setTasks([task('t1', { dueDate: '2026-09-11' })]);
        await vi.advanceTimersByTimeAsync(2500);
        service.stopCalendarPushSync();
        expect(requestPartialSync).not.toHaveBeenCalled();
        expect(getItem).not.toHaveBeenCalled();
        expect(subscribe).not.toHaveBeenCalled();
        expect(phone.writes).toEqual([]);
    });

    it('supplies exact task and calendar context to create, update, and stale-task delete callbacks', async () => {
        const taskId = 'task-é';
        const calendarId = 'calendar-e\u0301';
        const dated = task(taskId, { dueDate: '2026-09-10' });
        const phone = device({
            calendars: [{ ...PRIMARY, id: calendarId }],
            storage: { [CALENDAR_PUSH_ENABLED_KEY]: '1', [CALENDAR_PUSH_TARGET_ID_KEY]: calendarId },
            tasks: [dated],
        });
        const service = createCalendarPushService(phone.host);
        await service.runFullCalendarSync();
        const eventId = phone.entries.get(taskId)!.calendarEventId;
        phone.setTasks([{ ...dated, title: 'Changed fields', updatedAt: '2026-09-02T00:00:00.000Z' }]);
        await service.runFullCalendarSync();
        phone.setTasks([]);
        await service.runFullCalendarSync();
        expect(phone.eventContexts).toEqual([
            ['createEvent', calendarId, { taskId, calendarId }],
            ['updateEvent', eventId, { taskId, calendarId }],
            ['deleteEvent', eventId, { taskId, calendarId }],
        ]);
        expect(phone.writes.map(([method]) => method)).toEqual(['createEvent', 'updateEvent', 'deleteEvent', 'deleteSyncEntry']);
        expect(phone.entries.size).toBe(0);
    });

    it('keeps migration deletion bound to the old mapping and creation bound to the new target', async () => {
        const taskId = 'task-unchanged';
        const oldCalendarId = 'calendar-é';
        const newCalendarId = 'calendar-e\u0301';
        const oldEntry = { taskId, calendarEventId: 'old-event', calendarId: oldCalendarId, platform: 'android', lastSyncedAt: '' };
        const phone = device({
            calendars: [{ ...PRIMARY, id: oldCalendarId }, { ...PRIMARY, id: newCalendarId }],
            storage: { [CALENDAR_PUSH_ENABLED_KEY]: '1', [CALENDAR_PUSH_TARGET_ID_KEY]: newCalendarId },
            entries: [oldEntry], tasks: [task(taskId, { dueDate: '2026-09-10' })],
        });
        await createCalendarPushService(phone.host).runFullCalendarSync();
        expect(phone.eventContexts).toEqual([
            ['deleteEvent', 'old-event', { taskId: oldEntry.taskId, calendarId: oldCalendarId }],
            ['createEvent', newCalendarId, { taskId, calendarId: newCalendarId }],
        ]);
        expect(phone.writes.map(([method]) => method)).toEqual(['deleteEvent', 'deleteSyncEntry', 'createEvent']);
        expect(phone.entries.get(taskId)).toMatchObject({ taskId, calendarId: newCalendarId });
        expect(oldEntry).toEqual({ taskId, calendarEventId: 'old-event', calendarId: oldCalendarId, platform: 'android', lastSyncedAt: '' });
    });

    it('supplies the projected occurrence task identity without rewriting its source task', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-09T12:00:00.000Z'));
        const source = task('recurring-task', {
            dueDate: '2026-09-10', recurrence: { rule: 'monthly', strategy: 'strict' }, showFutureRecurrence: true,
        });
        const original = structuredClone(source);
        const phone = device({ storage: { [CALENDAR_PUSH_ENABLED_KEY]: '1', [CALENDAR_PUSH_TARGET_ID_KEY]: PRIMARY.id }, tasks: [source] });
        await createCalendarPushService(phone.host).runFullCalendarSync();
        expect(phone.eventContexts).toEqual([
            ['createEvent', PRIMARY.id, { taskId: source.id, calendarId: PRIMARY.id }],
            ['createEvent', PRIMARY.id, { taskId: source.id + ':projected-recurrence', calendarId: PRIMARY.id }],
        ]);
        expect([...phone.entries.keys()]).toEqual([source.id, source.id + ':projected-recurrence']);
        expect(source).toEqual(original);
    });

    it('logs one v1.3.4/calendar-push-owned-only line per proving point, with no titles', async () => {
        const marker = '11111111-1111-4111-8111-111111111111';
        const phone = device({
            calendars: [PRIMARY, { id: 'made', title: 'Mindwtr', name: `mindwtr:${marker}`, accessLevel: 'owner', allowsModifications: true, source: google }],
            storage: { [CALENDAR_PUSH_PENDING_KEY]: marker, [CALENDAR_PUSH_COLOR_KEY]: '#3B82F6' },
            tasks: [task('t1', { title: 'Secret task', dueDate: '2026-09-10' })],
        });
        const lines: [string, string, Record<string, string> | undefined][] = [];
        phone.host.log = {
            info: (message, context) => { lines.push(['info', message, context.extra]); },
            warn: (message, context) => { lines.push(['warn', message, context.extra]); },
            error: () => undefined,
        };
        const service = createCalendarPushService(phone.host);
        await service.ensureMindwtrCalendar();
        phone.life.failDelete = true;
        await service.deleteMindwtrCalendar().catch(() => undefined);
        phone.life.failDelete = false;
        await service.deleteMindwtrCalendar();
        await service.updateMindwtrCalendarColor('#059669');
        const tagged = lines.filter(([, , extra]) => extra?.releaseCheck?.startsWith('v1.3.4/'));
        expect(tagged.map(([level, message, extra]) => [level, message, extra!.releaseCheck, extra!.outcome])).toEqual([
            ['info', 'Recovered Mindwtr calendar', 'v1.3.4/calendar-push-owned-only', 'adopted'],
            ['warn', 'Failed to delete Mindwtr calendar; keeping it for a retry', 'v1.3.4/calendar-push-owned-only', 'refused'],
            ['info', 'Deleted Mindwtr calendar', 'v1.3.4/calendar-push-owned-only', 'deleted'],
            ['info', 'Mindwtr calendar color kept for the next calendar', 'v1.3.4/calendar-push-owned-only', 'deferred'],
        ]);
        expect(JSON.stringify(tagged.map(([, , extra]) => extra))).not.toMatch(/Secret task|alex@gmail|Mindwtr/);
    });
});
