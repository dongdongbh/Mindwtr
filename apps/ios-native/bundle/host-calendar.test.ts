import { describe, expect, it, mock } from 'bun:test';
import {
    CALENDAR_PUSH_ENABLED_KEY, CALENDAR_PUSH_CALENDAR_ID_KEY, CALENDAR_PUSH_TARGET_ID_KEY,
    CALENDAR_PUSH_COLOR_KEY, CALENDAR_PUSH_CREATION_INTENT_KEY, CALENDAR_PUSH_PENDING_KEY,
    type CalendarPushEventDetails,
} from '../../../packages/core/src/calendar-push-service';
import type { CalendarSyncEntry, SqliteAdapter } from '../../../packages/core/src/sqlite-adapter';
import { createIOSCalendarHost } from './host-calendar';

const OP1 = '11111111-1111-4111-8111-111111111111';
const OP2 = '22222222-2222-4222-8222-222222222222';
const stateNames = [CALENDAR_PUSH_ENABLED_KEY, CALENDAR_PUSH_CALENDAR_ID_KEY, CALENDAR_PUSH_TARGET_ID_KEY,
    CALENDAR_PUSH_COLOR_KEY, CALENDAR_PUSH_CREATION_INTENT_KEY];
const row = (taskId = 'task-é'): CalendarSyncEntry => ({ taskId, calendarEventId: 'event-é', calendarId: 'calendar-é',
    platform: 'ios', lastSyncedAt: '2026-10-09T00:00:00.000Z' });
const details = (): CalendarPushEventDetails => ({ title: 'Scheduled task',
    startDate: new Date('2026-10-10T08:00:00.000Z'), endDate: new Date('2026-10-10T09:00:00.000Z'),
    allDay: false, notes: 'Notes', location: 'Location', url: 'https://example.invalid/task',
    timeZone: 'America/New_York', endTimeZone: 'America/New_York' });
const deferred = () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
};

function fixture(owned = true) {
    const mapping = row();
    const adapter = {
        ensureSchema: mock(async () => undefined),
        getCalendarSyncEntry: mock(async () => mapping), getAllCalendarSyncEntries: mock(async () => [mapping]),
        upsertCalendarSyncEntry: mock(async () => undefined), deleteCalendarSyncEntry: mock(async () => undefined),
    } as unknown as SqliteAdapter;
    let currentAdapter = adapter;
    const values = new Map([[CALENDAR_PUSH_PENDING_KEY, 'legacy-android-marker'], ['other', 'ordinary']]);
    const storage = {
        getItem: mock(async (name: string) => values.get(name) ?? null),
        setItem: mock(async (name: string, value: string) => { values.set(name, value); }),
        removeItem: mock(async (name: string) => { values.delete(name); }),
        multiGet: mock(async (names: readonly string[]): Promise<[string, string | null][]> => names.map((name) => [name, values.get(name) ?? null])),
    };
    const readReply = (input: Record<string, unknown>) => {
        if (input.op === 'permissions') return { status: 'granted' };
        if (input.op === 'calendars') return [{ id: 'calendar-é', title: 'Calendar' }];
        if (input.op === 'events') return [];
        if (input.op === 'readFile') return new TextEncoder().encode('BEGIN:VCALENDAR');
        throw new Error('Unexpected generic operation');
    };
    const call = mock(async (input: Record<string, unknown>) => readReply(input));
    const state = ['1', 'managed', 'calendar-é', '#3B82F6', null];
    const pushCall = mock(async (input: Record<string, unknown>): Promise<unknown> => {
        if (input.op === 'read') return readReply(input.request as Record<string, unknown>);
        if (input.op === 'sources') return [{ id: 'source-é', name: 'Account', type: 'caldav' }];
        if (input.op === 'readState') return [...state];
        if (input.op === 'mapping') return input.taskId === mapping.taskId ? mapping : null;
        if (input.op === 'mappings') return [mapping];
        if (input.op === 'write') {
            const request = input.request as Record<string, unknown>;
            return { operationId: OP1, result: request.op === 'createCalendar' || request.op === 'createEvent'
                ? { kind: 'identifier', id: 'new-id' } : { kind: 'completed' } };
        }
        return null;
    });
    const requestPartialSync = mock((_taskIds: string[]) => undefined);
    const host = createIOSCalendarHost({ call, storage, adapter: () => currentAdapter,
        fetch: mock(async () => new Response('')) as typeof fetch, log: { info() {}, warn() {}, error() {} },
        ...(owned ? { push: { call: pushCall, requestPartialSync } } : {}),
    });
    return { host, adapter, mapping, storage, values, state, call, pushCall, requestPartialSync,
        replaceAdapter: () => { currentAdapter = {} as SqliteAdapter; } };
}

describe('private iOS calendar push adapter', () => {
    it('keeps the capability-absent host read-only and uses its original storage and mapping adapter', async () => {
        const f = fixture(false);
        expect(f.host.storage).toBe(f.storage);
        expect(f.host.requestPartialSync).toBeUndefined();
        expect(f.host.calendars.createCalendar).toBeUndefined();
        await f.host.calendars.getPermissions();
        await f.host.calendars.requestPermissions();
        await f.host.calendars.getCalendars();
        await f.host.calendars.getEvents(['calendar-é'], details().startDate, details().endDate);
        expect(f.call.mock.calls.map(([input]) => input.op)).toEqual(['permissions', 'permissions', 'calendars', 'events']);
        expect(await f.host.syncEntries!.get(f.mapping.taskId, 'ios')).toBe(f.mapping);
        expect(f.pushCall).not.toHaveBeenCalled();
    });

    it('routes calendar reads and sources privately while local files retain the generic call and forwards only the wake callback', async () => {
        const f = fixture();
        expect(await f.host.calendars.getPermissions()).toEqual({ status: 'granted' });
        await f.host.calendars.requestPermissions();
        await f.host.calendars.getCalendars();
        const event = details();
        await f.host.calendars.getEvents(['calendar-é'], event.startDate, event.endDate);
        expect(await f.host.calendars.getSources!()).toEqual([{ id: 'source-é', name: 'Account', type: 'caldav' }]);
        expect(f.pushCall.mock.calls.map(([input]) => input)).toEqual([
            { op: 'read', request: { op: 'permissions' } }, { op: 'read', request: { op: 'permissions' } },
            { op: 'read', request: { op: 'calendars' } },
            { op: 'read', request: { op: 'events', calendarIds: ['calendar-é'], startMs: event.startDate.getTime(), endMs: event.endDate.getTime() } },
            { op: 'sources' },
        ]);
        expect(await f.host.readLocalFile('file:///calendar.ics')).toBe('BEGIN:VCALENDAR');
        expect(f.call.mock.calls).toEqual([[{ op: 'readFile', uri: 'file:///calendar.ics' }]]);
        expect(f.host.requestPartialSync).toBe(f.requestPartialSync);
        f.host.requestPartialSync!(['task-é']);
        expect(f.requestPartialSync.mock.calls).toEqual([[['task-é']]]);
        expect(f.pushCall).toHaveBeenCalledTimes(5);
    });

    it('converts actual shared writer fields to the closed native grammar and acknowledges event mappings', async () => {
        const f = fixture(), event = details(), context = { taskId: 'task-é', calendarId: 'calendar-é' };
        expect(await f.host.calendars.createCalendar!({ title: 'Mindwtr', color: '#3B82F6', entityType: 'event',
            sourceId: 'source-é', source: { id: 'source-é', name: 'Account', type: 'caldav' }, name: 'ignored', ownerAccount: 'ignored' })).toBe('new-id');
        await f.host.calendars.updateCalendar!('calendar-é', { color: '#059669', title: 'Mindwtr' });
        await f.host.calendars.deleteCalendar!('calendar-é');
        expect(await f.host.calendars.createEvent!('calendar-é', { ...event, calendarId: 'calendar-é' }, context)).toBe('new-id');
        const mapping = { ...row(), calendarEventId: 'new-id' };
        await f.host.syncEntries!.upsert(mapping);
        await f.host.calendars.updateEvent!('new-id', event, context);
        await f.host.syncEntries!.upsert(mapping);
        await f.host.calendars.deleteEvent!('new-id', context);
        await f.host.syncEntries!.delete(context.taskId, 'ios');
        const nativeDetails = { title: event.title, startMs: event.startDate.getTime(), endMs: event.endDate.getTime(),
            allDay: event.allDay, notes: event.notes, location: event.location, url: event.url,
            timeZone: event.timeZone, endTimeZone: event.endTimeZone };
        expect(f.pushCall.mock.calls.map(([input]) => input)).toEqual([
            { op: 'write', taskId: null, request: { op: 'createCalendar', details: { title: 'Mindwtr', color: '#3B82F6', entityType: 'event', sourceId: 'source-é' } } },
            { op: 'write', taskId: null, request: { op: 'updateCalendar', calendarId: 'calendar-é', details: { color: '#059669', title: 'Mindwtr' } } },
            { op: 'write', taskId: null, request: { op: 'deleteCalendar', calendarId: 'calendar-é' } },
            { op: 'write', taskId: context.taskId, request: { op: 'createEvent', calendarId: 'calendar-é', details: nativeDetails } },
            { op: 'ackMapping', operationId: OP1, entry: mapping },
            { op: 'write', taskId: context.taskId, request: { op: 'updateEvent', eventId: 'new-id', calendarId: 'calendar-é', details: nativeDetails } },
            { op: 'ackMapping', operationId: OP1, entry: mapping },
            { op: 'write', taskId: context.taskId, request: { op: 'deleteEvent', eventId: 'new-id', calendarId: 'calendar-é' } },
            { op: 'ackMapping', operationId: OP1, entry: null },
        ]);
        expect(f.call).not.toHaveBeenCalled();
    });

    it('requires the actual calendar source and exact context for every event write before native work', async () => {
        const f = fixture(), event = details();
        await expect(f.host.calendars.createCalendar!({ title: 'Mindwtr', color: '#3B82F6', entityType: 'event', source: {} })).rejects.toThrow();
        await expect(f.host.calendars.createCalendar!({ title: 'Mindwtr', color: '#3B82F6', entityType: 'event', sourceId: 'a', source: { id: 'b' } })).rejects.toThrow();
        await expect(f.host.calendars.createEvent!('calendar-é', { ...event, calendarId: 'calendar-é' })).rejects.toThrow();
        await expect(f.host.calendars.createEvent!('calendar-é', { ...event, calendarId: 'other' }, { taskId: 'task-é', calendarId: 'calendar-é' })).rejects.toThrow();
        await expect(f.host.calendars.createEvent!('calendar-é', { ...event, calendarId: 'calendar-é' }, { taskId: 'task-é', calendarId: 'other' })).rejects.toThrow();
        await expect(f.host.calendars.updateEvent!('event-é', event)).rejects.toThrow();
        await expect(f.host.calendars.deleteEvent!('event-é', { taskId: '', calendarId: 'calendar-é' })).rejects.toThrow();
        expect(f.pushCall).not.toHaveBeenCalled();
    });

    it('reads only private ios mappings and cleans up the exact captured row without mutable caller aliases or arbitrary SQL', async () => {
        const f = fixture(), expected = { ...f.mapping };
        const result = await f.host.syncEntries!.get(expected.taskId, 'ios');
        expect(result).toEqual(expected);
        result!.calendarEventId = 'caller-mutated';
        f.mapping.lastSyncedAt = 'native-row-changed';
        await f.host.syncEntries!.delete(expected.taskId, 'ios');
        await f.host.syncEntries!.delete(expected.taskId, 'ios');
        expect(f.pushCall.mock.calls).toEqual([
            [{ op: 'mapping', taskId: expected.taskId }], [{ op: 'deleteMapping', expected }],
        ]);
        expect(await f.host.syncEntries!.get('absent', 'ios')).toBeNull();
        await f.host.syncEntries!.delete('absent', 'ios');
        const all = await f.host.syncEntries!.getAll('ios');
        const latest = { ...f.mapping };
        all[0]!.calendarEventId = 'array-mutated';
        await f.host.syncEntries!.delete(expected.taskId, 'ios');
        expect(f.pushCall.mock.calls.at(-1)).toEqual([{ op: 'deleteMapping', expected: latest }]);
        const calls = f.pushCall.mock.calls.length;
        await expect(f.host.syncEntries!.get(expected.taskId, 'android')).rejects.toThrow();
        await expect(f.host.syncEntries!.getAll('android')).rejects.toThrow();
        await expect(f.host.syncEntries!.delete(expected.taskId, 'android')).rejects.toThrow();
        await expect(f.host.syncEntries!.upsert({ ...expected, platform: 'android' })).rejects.toThrow();
        await expect(f.host.syncEntries!.upsert({ ...expected, taskId: 'absent' })).rejects.toThrow();
        expect(f.pushCall).toHaveBeenCalledTimes(calls);
        expect(f.adapter.getCalendarSyncEntry).not.toHaveBeenCalled();
        expect(f.adapter.getAllCalendarSyncEntries).not.toHaveBeenCalled();
        expect(f.adapter.upsertCalendarSyncEntry).not.toHaveBeenCalled();
        expect(f.adapter.deleteCalendarSyncEntry).not.toHaveBeenCalled();
    });

    it('routes only the five push cells privately, preserves other storage and ordered mixed multiGet, and leaves the Android marker untouched', async () => {
        const f = fixture();
        for (let index = 0; index < stateNames.length; index += 1) {
            expect(await f.host.storage.getItem(stateNames[index]!)).toBe(f.state[index]);
            await f.host.storage.setItem(stateNames[index]!, 'value');
            await f.host.storage.removeItem(stateNames[index]!);
        }
        expect(f.pushCall.mock.calls.map(([input]) => input)).toEqual(stateNames.flatMap((name) => [
            { op: 'readState' }, { op: 'setState', name, value: 'value' }, { op: 'setState', name, value: null },
        ]));
        expect(await f.host.storage.getItem('other')).toBe('ordinary');
        await f.host.storage.setItem('other', 'changed');
        await f.host.storage.removeItem('other');
        f.values.set('other', 'ordinary');
        expect(await f.host.storage.multiGet!(['other', 'missing'])).toEqual([['other', 'ordinary'], ['missing', null]]);
        expect(f.storage.multiGet.mock.calls).toEqual([[['other', 'missing']]]);
        expect(await f.host.storage.multiGet!([stateNames[0]!, 'other', stateNames[0]!, CALENDAR_PUSH_PENDING_KEY, 'missing']))
            .toEqual([[stateNames[0], '1'], ['other', 'ordinary'], [stateNames[0], '1'], [CALENDAR_PUSH_PENDING_KEY, null], ['missing', null]]);
        expect(await f.host.storage.getItem(CALENDAR_PUSH_PENDING_KEY)).toBeNull();
        await f.host.storage.removeItem(CALENDAR_PUSH_PENDING_KEY);
        await expect(f.host.storage.setItem(CALENDAR_PUSH_PENDING_KEY, 'new-marker')).rejects.toThrow();
        expect(f.values.get(CALENDAR_PUSH_PENDING_KEY)).toBe('legacy-android-marker');
        expect(f.storage.setItem.mock.calls).toEqual([['other', 'changed']]);
        expect(f.storage.removeItem.mock.calls).toEqual([['other']]);
        expect(f.pushCall).toHaveBeenCalledTimes(17);
    });

    it('reserves a held task before native work and keeps exact distinct task tokens without overwriting them', async () => {
        const f = fixture(), gate = deferred(), entered = deferred(), event = details();
        const first = 'task-é', second = 'task-e\u0301';
        f.pushCall.mockImplementation(async (input) => {
            if (input.op !== 'write') return null;
            if (input.taskId === first) { entered.release(); await gate.promise; }
            return { operationId: input.taskId === first ? OP1 : OP2, result: { kind: 'identifier', id: String(input.taskId) } };
        });
        const pending = f.host.calendars.createEvent!('calendar-é', { ...event, calendarId: 'calendar-é' }, { taskId: first, calendarId: 'calendar-é' });
        await entered.promise;
        await expect(f.host.calendars.createEvent!('calendar-é', { ...event, calendarId: 'calendar-é' }, { taskId: first, calendarId: 'calendar-é' }))
            .rejects.toThrow('pending operation');
        await expect(f.host.syncEntries!.upsert(row(first))).rejects.toThrow('no pending operation');
        expect(f.pushCall).toHaveBeenCalledTimes(1);
        expect(await f.host.calendars.createEvent!('calendar-é', { ...event, calendarId: 'calendar-é' }, { taskId: second, calendarId: 'calendar-é' })).toBe(second);
        await f.host.syncEntries!.upsert({ ...row(second), calendarEventId: second });
        gate.release();
        expect(await pending).toBe(first);
        await f.host.syncEntries!.upsert({ ...row(first), calendarEventId: first });
        expect(f.pushCall.mock.calls.filter(([input]) => input.op === 'ackMapping').map(([input]) => input.operationId)).toEqual([OP2, OP1]);
    });

    it.each(['update', 'delete'] as const)('retains a missing-event token through %s and consumes it only with the matching mapping delete', async (operation) => {
        const f = fixture(), context = { taskId: 'task-é', calendarId: 'calendar-é' };
        f.pushCall.mockImplementationOnce(async () => ({ operationId: OP1, result: { kind: 'missingEvent' } }));
        const missing = operation === 'update' ? f.host.calendars.updateEvent!('event-é', details(), context)
            : f.host.calendars.deleteEvent!('event-é', context);
        await expect(missing).rejects.toThrow('Calendar event not found');
        await expect(f.host.calendars.createEvent!('calendar-é', { ...details(), calendarId: 'calendar-é' }, context)).rejects.toThrow('pending operation');
        await f.host.syncEntries!.delete(context.taskId, 'ios');
        expect(f.pushCall.mock.calls.at(-1)).toEqual([{ op: 'ackMapping', operationId: OP1, entry: null }]);
        expect(await f.host.calendars.createEvent!('calendar-é', { ...details(), calendarId: 'calendar-é' }, context)).toBe('new-id');
    });

    it('retains a failed acknowledgement for retry and snapshots the entry before a held acknowledgement', async () => {
        const f = fixture(), context = { taskId: 'task-é', calendarId: 'calendar-é' };
        await f.host.calendars.createEvent!('calendar-é', { ...details(), calendarId: 'calendar-é' }, context);
        const gate = deferred(), entered = deferred();
        f.pushCall.mockImplementationOnce(async () => { entered.release(); await gate.promise; throw new Error('Ack unavailable'); });
        const entry = { ...row(), calendarEventId: 'new-id' }, expected = { ...entry };
        const failed = f.host.syncEntries!.upsert(entry);
        await entered.promise;
        entry.calendarId = 'caller-mutated';
        expect(f.pushCall.mock.calls.at(-1)).toEqual([{ op: 'ackMapping', operationId: OP1, entry: expected }]);
        await expect(f.host.calendars.deleteEvent!('new-id', context)).rejects.toThrow('pending operation');
        gate.release();
        await expect(failed).rejects.toThrow('Ack unavailable');
        await f.host.syncEntries!.upsert(expected);
        expect(f.pushCall.mock.calls.at(-1)).toEqual([{ op: 'ackMapping', operationId: OP1, entry: expected }]);
        await f.host.calendars.deleteEvent!('new-id', context);
    });

    it.each([
        { result: { kind: 'identifier', id: 'new-id' } },
        { operationId: OP1.toUpperCase().replace('11111111', 'AAAAAAAA'), result: { kind: 'identifier', id: 'new-id' } },
        { operationId: OP1, result: { kind: 'completed' } },
        { operationId: OP1, result: { kind: 'identifier', id: '' } },
        { operationId: OP1, result: { kind: 'identifier', id: 'new-id', unexpected: true } },
    ])('rejects a malformed write reply without mapping acknowledgement: %j', async (reply) => {
        const f = fixture();
        f.pushCall.mockImplementationOnce(async () => reply);
        await expect(f.host.calendars.createEvent!('calendar-é', { ...details(), calendarId: 'calendar-é' }, { taskId: 'task-é', calendarId: 'calendar-é' }))
            .rejects.toThrow('Calendar push reply is invalid');
        expect(f.pushCall).toHaveBeenCalledTimes(1);
    });

    it('releases only the reservation of a rejected write without a valid UUID, allowing native authority to decide a retry', async () => {
        const f = fixture(), context = { taskId: 'task-é', calendarId: 'calendar-é' };
        f.pushCall.mockImplementationOnce(async () => { throw new Error('Owner not ready'); });
        await expect(f.host.calendars.createEvent!('calendar-é', { ...details(), calendarId: 'calendar-é' }, context)).rejects.toThrow('Owner not ready');
        expect(await f.host.calendars.createEvent!('calendar-é', { ...details(), calendarId: 'calendar-é' }, context)).toBe('new-id');
        await f.host.syncEntries!.upsert({ ...row(), calendarEventId: 'new-id' });
        expect(f.pushCall.mock.calls.at(-1)).toEqual([{ op: 'ackMapping', operationId: OP1, entry: { ...row(), calendarEventId: 'new-id' } }]);
    });

    it('rejects a held write after adapter replacement without accepting its token or acknowledging the new library', async () => {
        const f = fixture(), gate = deferred(), entered = deferred();
        f.pushCall.mockImplementationOnce(async () => { entered.release(); await gate.promise; return { operationId: OP1, result: { kind: 'identifier', id: 'new-id' } }; });
        const write = f.host.calendars.createEvent!('calendar-é', { ...details(), calendarId: 'calendar-é' }, { taskId: 'task-é', calendarId: 'calendar-é' });
        await entered.promise;
        f.replaceAdapter(); gate.release();
        await expect(write).rejects.toThrow('NOT_READY: Calendar library changed');
        await expect(f.host.syncEntries!.upsert({ ...row(), calendarEventId: 'new-id' })).rejects.toThrow('no pending operation');
        expect(f.pushCall).toHaveBeenCalledTimes(1);
    });

    it('rejects a held acknowledgement after adapter replacement and retains the old token without acknowledging the new library', async () => {
        const f = fixture();
        await f.host.calendars.createEvent!('calendar-é', { ...details(), calendarId: 'calendar-é' }, { taskId: 'task-é', calendarId: 'calendar-é' });
        const gate = deferred(), entered = deferred();
        f.pushCall.mockImplementationOnce(async () => { entered.release(); await gate.promise; return null; });
        const ack = f.host.syncEntries!.upsert({ ...row(), calendarEventId: 'new-id' });
        await entered.promise;
        f.replaceAdapter(); gate.release();
        await expect(ack).rejects.toThrow('NOT_READY: Calendar library changed');
        await expect(f.host.syncEntries!.upsert({ ...row(), calendarEventId: 'new-id' })).rejects.toThrow('NOT_READY: Calendar library changed');
        await expect(f.host.syncEntries!.delete('task-é', 'ios')).rejects.toThrow('NOT_READY: Calendar library changed');
        expect(f.pushCall).toHaveBeenCalledTimes(2);
    });

    it('does not send a captured cleanup row to another adapter', async () => {
        const f = fixture();
        await f.host.syncEntries!.getAll('ios');
        f.replaceAdapter();
        await expect(f.host.syncEntries!.delete(f.mapping.taskId, 'ios')).rejects.toThrow('NOT_READY: Calendar library changed');
        expect(f.pushCall).toHaveBeenCalledTimes(1);
    });

    it.each(['write', 'ack', 'state', 'mapping', 'mappings', 'sources'] as const)('rejects adapter replacement between bridge settlement and the %s continuation', async (phase) => {
        const f = fixture(), context = { taskId: 'task-é', calendarId: 'calendar-é' };
        if (phase === 'ack') await f.host.calendars.createEvent!('calendar-é', { ...details(), calendarId: 'calendar-é' }, context);
        f.pushCall.mockImplementationOnce(async () => {
            queueMicrotask(() => queueMicrotask(f.replaceAdapter));
            if (phase === 'write') return { operationId: OP1, result: { kind: 'identifier', id: 'new-id' } };
            if (phase === 'ack') return null;
            if (phase === 'state') return [...f.state];
            if (phase === 'mapping') return f.mapping;
            if (phase === 'mappings') return [f.mapping];
            return [{ id: 'source-é', name: 'Account', type: 'caldav' }];
        });
        const pending = phase === 'write' ? f.host.calendars.createEvent!('calendar-é', { ...details(), calendarId: 'calendar-é' }, context)
            : phase === 'ack' ? f.host.syncEntries!.upsert({ ...row(), calendarEventId: 'new-id' })
            : phase === 'state' ? f.host.storage.getItem(CALENDAR_PUSH_ENABLED_KEY)
            : phase === 'mapping' ? f.host.syncEntries!.get('task-é', 'ios')
            : phase === 'mappings' ? f.host.syncEntries!.getAll('ios') : f.host.calendars.getSources!();
        await expect(pending).rejects.toThrow('NOT_READY: Calendar library changed');
    });

    it.each(['createCalendar', 'createEvent', 'updateEvent', 'deleteEvent'] as const)('rejects adapter replacement after write completes but before the public %s continuation', async (method) => {
        const f = fixture(), context = { taskId: 'task-é', calendarId: 'calendar-é' };
        f.pushCall.mockImplementationOnce(async () => {
            queueMicrotask(() => queueMicrotask(() => queueMicrotask(f.replaceAdapter)));
            return { operationId: OP1, result: method === 'createCalendar' || method === 'createEvent'
                ? { kind: 'identifier', id: 'new-id' } : { kind: 'completed' } };
        });
        const pending = method === 'createCalendar'
            ? f.host.calendars.createCalendar!({ title: 'Mindwtr', color: '#3B82F6', entityType: 'event', source: { id: 'source-é' } })
            : method === 'createEvent' ? f.host.calendars.createEvent!('calendar-é', { ...details(), calendarId: 'calendar-é' }, context)
            : method === 'updateEvent' ? f.host.calendars.updateEvent!('event-é', details(), context)
            : f.host.calendars.deleteEvent!('event-é', context);
        await expect(pending).rejects.toThrow('NOT_READY: Calendar library changed');
        if (method !== 'createCalendar') {
            await expect(f.host.calendars.createEvent!('calendar-é', { ...details(), calendarId: 'calendar-é' }, context))
                .rejects.toThrow('pending operation');
            await expect(f.host.syncEntries!.upsert({ ...row(), calendarEventId: 'new-id' })).rejects.toThrow('NOT_READY: Calendar library changed');
            await expect(f.host.syncEntries!.delete(context.taskId, 'ios')).rejects.toThrow('NOT_READY: Calendar library changed');
        }
        expect(f.pushCall).toHaveBeenCalledTimes(1);
    });

    it.each(['upsert', 'delete'] as const)('rejects adapter replacement after acknowledgement completes but before the public %s continuation', async (method) => {
        const f = fixture(), context = { taskId: 'task-é', calendarId: 'calendar-é' };
        if (method === 'upsert') await f.host.calendars.createEvent!('calendar-é', { ...details(), calendarId: 'calendar-é' }, context);
        else await f.host.calendars.deleteEvent!('event-é', context);
        f.pushCall.mockImplementationOnce(async () => {
            queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => queueMicrotask(f.replaceAdapter))));
            return null;
        });
        const entry = { ...row(), calendarEventId: 'new-id' };
        const pending = method === 'upsert' ? f.host.syncEntries!.upsert(entry) : f.host.syncEntries!.delete(context.taskId, 'ios');
        await expect(pending).rejects.toThrow('NOT_READY: Calendar library changed');
        expect(f.pushCall.mock.calls.at(-1)).toEqual([{ op: 'ackMapping', operationId: OP1, entry: method === 'upsert' ? entry : null }]);
        expect(f.pushCall).toHaveBeenCalledTimes(2);
        // Native acknowledged the old operation successfully; a later admission belongs to native authority.
        f.pushCall.mockImplementationOnce(async () => { throw new Error('Owner not ready'); });
        await expect(f.host.calendars.createEvent!('calendar-é', { ...details(), calendarId: 'calendar-é' }, context)).rejects.toThrow('Owner not ready');
        expect(f.pushCall).toHaveBeenCalledTimes(3);
        expect(f.pushCall.mock.calls.filter(([input]) => input.op === 'ackMapping')).toHaveLength(1);
    });

    it('retains a token after an invalid acknowledgement reply and can retry the same operation', async () => {
        const f = fixture();
        await f.host.calendars.createEvent!('calendar-é', { ...details(), calendarId: 'calendar-é' }, { taskId: 'task-é', calendarId: 'calendar-é' });
        f.pushCall.mockImplementationOnce(async () => ({ completed: true }));
        await expect(f.host.syncEntries!.upsert({ ...row(), calendarEventId: 'new-id' })).rejects.toThrow('Calendar push reply is invalid');
        await f.host.syncEntries!.upsert({ ...row(), calendarEventId: 'new-id' });
        expect(f.pushCall.mock.calls.filter(([input]) => input.op === 'ackMapping').map(([input]) => input.operationId)).toEqual([OP1, OP1]);
    });

    it.each([
        { op: 'readState', reply: ['1', null, null, null] },
        { op: 'readState', reply: ['1', null, 3, null, null] },
        { op: 'mapping', reply: { ...row(), platform: 'android' } },
        { op: 'mapping', reply: { ...row(), taskId: 'other' } },
        { op: 'mappings', reply: [row(), row()] },
        { op: 'sources', reply: [{ id: 'source', name: 'Account', type: 3 }] },
    ])('rejects malformed private state/row/source replies: %j', async ({ op, reply }) => {
        const f = fixture();
        f.pushCall.mockImplementationOnce(async () => reply);
        const pending = op === 'readState' ? f.host.storage.getItem(CALENDAR_PUSH_ENABLED_KEY)
            : op === 'mapping' ? f.host.syncEntries!.get('task-é', 'ios')
            : op === 'mappings' ? f.host.syncEntries!.getAll('ios') : f.host.calendars.getSources!();
        await expect(pending).rejects.toThrow('Calendar push reply is invalid');
        expect(f.pushCall).toHaveBeenCalledTimes(1);
    });

    it('keeps mixed multiGet state reads live and ordered instead of caching a prior readState reply', async () => {
        const f = fixture();
        f.pushCall.mockImplementationOnce(async () => ['0', null, null, null, null]);
        f.pushCall.mockImplementationOnce(async () => ['1', null, null, null, null]);
        expect(await f.host.storage.multiGet!([CALENDAR_PUSH_ENABLED_KEY, 'other', CALENDAR_PUSH_ENABLED_KEY])).toEqual([
            [CALENDAR_PUSH_ENABLED_KEY, '0'], ['other', 'ordinary'], [CALENDAR_PUSH_ENABLED_KEY, '1'],
        ]);
        expect(f.pushCall.mock.calls).toEqual([[{ op: 'readState' }], [{ op: 'readState' }]]);
        expect(f.storage.getItem.mock.calls).toEqual([['other']]);
    });

    it('initializes the existing schema before ownership without private provider work and rejects a schema result from a replaced adapter', async () => {
        const f = fixture();
        await f.host.syncEntries!.ensureReady();
        expect(f.adapter.ensureSchema).toHaveBeenCalledTimes(1);
        expect(f.pushCall).not.toHaveBeenCalled();
        const gate = deferred(), entered = deferred();
        (f.adapter.ensureSchema as ReturnType<typeof mock>).mockImplementationOnce(async () => { entered.release(); await gate.promise; });
        const pending = f.host.syncEntries!.ensureReady();
        await entered.promise;
        f.replaceAdapter(); gate.release();
        await expect(pending).rejects.toThrow('NOT_READY: Calendar library changed');
        expect(f.pushCall).not.toHaveBeenCalled();
    });
});
