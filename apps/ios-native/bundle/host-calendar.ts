import type { NativeCalendarHost } from '../../../packages/core/src/native-host-contract-settings-calendar';
import { CALENDAR_PUSH_ENABLED_KEY, CALENDAR_PUSH_CALENDAR_ID_KEY, CALENDAR_PUSH_TARGET_ID_KEY,
    CALENDAR_PUSH_COLOR_KEY, CALENDAR_PUSH_CREATION_INTENT_KEY, CALENDAR_PUSH_PENDING_KEY,
    type CalendarPushEventDetails, type CalendarPushEventIdentity, type DeviceCalendarSource } from '../../../packages/core/src/calendar-push-service';
import type { CalendarSyncEntry, SqliteAdapter } from '../../../packages/core/src/sqlite-adapter';

export type CalendarCall = (request: Record<string, unknown>) => Promise<unknown>;

/** Core retains RN selection, all-day handling and exported-event suppression. */
export function createIOSCalendarHost(deps: {
    call: CalendarCall;
    storage: NativeCalendarHost['storage'];
    adapter: () => SqliteAdapter;
    fetch: typeof fetch;
    log: NativeCalendarHost['log'];
    push?: { call: CalendarCall; requestPartialSync: NonNullable<NativeCalendarHost['requestPartialSync']> };
}): NativeCalendarHost {
    const checkAdapter = (adapter: SqliteAdapter) => {
        if (deps.adapter() !== adapter) throw new Error('NOT_READY: Calendar library changed');
    };
    const guarded = async <T>(run: () => Promise<T>): Promise<T> => {
        const adapter = deps.adapter();
        const value = await run();
        checkAdapter(adapter);
        return value;
    };
    const read = <T>(request: Record<string, unknown>, call = deps.call): Promise<T> => guarded(() => call(request)) as Promise<T>;
    const permissions = () => read<{ status: unknown }>({ op: 'permissions' });
    let localReadTail: Promise<unknown> = Promise.resolve();
    const host: NativeCalendarHost = {
        platform: { os: 'ios' }, storage: deps.storage, fetch: deps.fetch, log: deps.log,
        repairFeedDeviceCopyOnOpen: false,
        // Native accepts only digest-checked calendar copies in the current library.
        readLocalFile: (uri, signal) => {
            const adapter = deps.adapter();
            // The native queue reserves two jobs; one local read leaves room for EventKit.
            const pending = localReadTail.then(async () => {
                const current = () => {
                    if (signal?.aborted) throw new Error('Local calendar read cancelled');
                    if (deps.adapter() !== adapter) throw new Error('NOT_READY: Calendar library changed');
                };
                current();
                const bytes = await read<Uint8Array>({ op: 'readFile', uri });
                current();
                if (Object.prototype.toString.call(bytes) !== '[object Uint8Array]' || bytes.byteLength > 8 * 1024 * 1024)
                    throw new Error('Local calendar byte reply is invalid');
                const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
                void deps.log.info('Native iOS local calendar file read', { scope: 'native-ios',
                    extra: { releaseCheck: 'v1.3.5/ios-calendar-local-read', outcome: 'decoded' } });
                return text;
            });
            localReadTail = pending.catch(() => {});
            return pending;
        },
        calendars: {
            getPermissions: permissions,
            // The explicit Swift Settings owner requests access outside JSC, then reads again.
            requestPermissions: permissions,
            getCalendars: () => read({ op: 'calendars' }),
            getEvents: (calendarIds, start, end) => read({ op: 'events', calendarIds,
                startMs: start.getTime(), endMs: end.getTime() }),
        },
        syncEntries: {
            ensureReady: () => deps.adapter().ensureSchema(),
            get: (taskId, platform) => deps.adapter().getCalendarSyncEntry(taskId, platform),
            upsert: (entry) => deps.adapter().upsertCalendarSyncEntry(entry),
            delete: (taskId, platform) => deps.adapter().deleteCalendarSyncEntry(taskId, platform),
            getAll: (platform) => deps.adapter().getAllCalendarSyncEntries(platform),
        },
    };
    if (!deps.push) return host;
    const push = deps.push;
    const pushCall = <T>(request: Record<string, unknown>) => read<T>(request, push.call);
    const pushPermissions = () => pushCall<{ status: unknown }>({ op: 'read', request: { op: 'permissions' } });
    const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
    const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
    const invalidReply = () => new Error('Calendar push reply is invalid');
    type Pending = { operationId: string | null; adapter: SqliteAdapter };
    const pending = new Map<string, Pending>();
    const mappings = new Map<string, { entry: CalendarSyncEntry; adapter: SqliteAdapter }>();
    const mapping = (value: unknown): CalendarSyncEntry => {
        if (!record(value) || Object.keys(value).sort().join(',') !== 'calendarEventId,calendarId,lastSyncedAt,platform,taskId'
            || !text(value.taskId) || !text(value.calendarId) || !text(value.calendarEventId)
            || value.platform !== 'ios' || typeof value.lastSyncedAt !== 'string') throw invalidReply();
        return { ...value } as CalendarSyncEntry;
    };
    const completed = async (request: Record<string, unknown>) => {
        const adapter = deps.adapter();
        const reply = await pushCall(request);
        checkAdapter(adapter);
        if (reply !== null) throw invalidReply();
    };
    const write = async (request: Record<string, unknown>, taskId: string | null): Promise<string | void> => {
        if (taskId !== null && pending.has(taskId)) throw new Error('Calendar push task already has a pending operation');
        const reservation: Pending = { operationId: null, adapter: deps.adapter() };
        if (taskId !== null) pending.set(taskId, reservation);
        try {
            const reply = await pushCall<unknown>({ op: 'write', request, taskId });
            checkAdapter(reservation.adapter);
            if (!record(reply) || Object.keys(reply).sort().join(',') !== 'operationId,result'
                || typeof reply.operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(reply.operationId)) throw invalidReply();
            reservation.operationId = reply.operationId;
            const result = reply.result;
            if (!record(result)) throw invalidReply();
            const creates = request.op === 'createCalendar' || request.op === 'createEvent';
            if (creates) {
                if (Object.keys(result).sort().join(',') !== 'id,kind' || result.kind !== 'identifier' || !text(result.id)) throw invalidReply();
                return result.id;
            }
            if (Object.keys(result).join(',') !== 'kind') throw invalidReply();
            if (result.kind === 'missingEvent' && (request.op === 'updateEvent' || request.op === 'deleteEvent')) {
                throw new Error('Calendar event not found');
            }
            if (result.kind !== 'completed') throw invalidReply();
        } catch (error) {
            if (taskId !== null && reservation.operationId === null && pending.get(taskId) === reservation) pending.delete(taskId);
            throw error;
        }
    };
    const eventContext = (context?: CalendarPushEventIdentity): CalendarPushEventIdentity => {
        if (!context || !text(context.taskId) || !text(context.calendarId)) throw new Error('Calendar push request is invalid');
        return context;
    };
    const eventDetails = (details: CalendarPushEventDetails) => ({ title: details.title,
        startMs: details.startDate.getTime(), endMs: details.endDate.getTime(), allDay: details.allDay,
        notes: details.notes, location: details.location,
        ...(details.url !== undefined ? { url: details.url } : {}),
        ...(details.timeZone !== undefined ? { timeZone: details.timeZone } : {}),
        ...(details.endTimeZone !== undefined ? { endTimeZone: details.endTimeZone } : {}),
    });
    const acknowledge = async (taskId: string, entry: CalendarSyncEntry | null) => {
        const operation = pending.get(taskId);
        if (!operation?.operationId) throw new Error('Calendar push task has no pending operation');
        checkAdapter(operation.adapter);
        await completed({ op: 'ackMapping', operationId: operation.operationId, entry: entry === null ? null : { ...entry } });
        checkAdapter(operation.adapter);
        if (pending.get(taskId) === operation) pending.delete(taskId);
        mappings.delete(taskId);
    };
    host.requestPartialSync = push.requestPartialSync;
    host.calendars = {
        ...host.calendars,
        getPermissions: pushPermissions,
        requestPermissions: pushPermissions,
        getCalendars: () => pushCall({ op: 'read', request: { op: 'calendars' } }),
        getEvents: (calendarIds, start, end) => pushCall({ op: 'read', request: { op: 'events', calendarIds,
            startMs: start.getTime(), endMs: end.getTime() } }),
        getSources: async () => {
            const adapter = deps.adapter();
            const sources = await pushCall({ op: 'sources' });
            checkAdapter(adapter);
            if (!Array.isArray(sources) || sources.some((source) => !record(source) || !text(source.id)
                || typeof source.name !== 'string' || typeof source.type !== 'string')) throw invalidReply();
            return sources as DeviceCalendarSource[];
        },
        createCalendar: async (details) => {
            const adapter = deps.adapter();
            const sourceId = details.sourceId ?? details.source.id;
            if (!text(sourceId) || (details.sourceId !== undefined && details.source.id !== undefined && details.sourceId !== details.source.id)) {
                throw new Error('Calendar push request is invalid');
            }
            const id = await write({ op: 'createCalendar', details: { title: details.title, color: details.color,
                entityType: details.entityType, sourceId } }, null);
            checkAdapter(adapter);
            return id as string;
        },
        updateCalendar: (calendarId, details) => write({ op: 'updateCalendar', calendarId,
            details: { color: details.color, ...(details.title !== undefined ? { title: details.title } : {}) } }, null),
        deleteCalendar: (calendarId) => write({ op: 'deleteCalendar', calendarId }, null),
        createEvent: async (calendarId, details, context) => {
            const adapter = deps.adapter();
            const identity = eventContext(context);
            if (calendarId !== identity.calendarId || details.calendarId !== calendarId) throw new Error('Calendar push request is invalid');
            const id = await write({ op: 'createEvent', calendarId, details: eventDetails(details) }, identity.taskId);
            checkAdapter(adapter);
            return id as string;
        },
        updateEvent: async (eventId, details, context) => {
            const adapter = deps.adapter();
            const identity = eventContext(context);
            await write({ op: 'updateEvent', eventId, calendarId: identity.calendarId, details: eventDetails(details) }, identity.taskId);
            checkAdapter(adapter);
        },
        deleteEvent: async (eventId, context) => {
            const adapter = deps.adapter();
            const identity = eventContext(context);
            await write({ op: 'deleteEvent', eventId, calendarId: identity.calendarId }, identity.taskId);
            checkAdapter(adapter);
        },
    };
    host.syncEntries = {
        ensureReady: () => guarded(() => deps.adapter().ensureSchema()),
        get: async (taskId, platform) => {
            if (platform !== 'ios') throw new Error('Calendar push request is invalid');
            const adapter = deps.adapter();
            const value = await pushCall({ op: 'mapping', taskId });
            checkAdapter(adapter);
            if (value === null) { mappings.delete(taskId); return null; }
            const entry = mapping(value);
            if (entry.taskId !== taskId) throw invalidReply();
            mappings.set(taskId, { entry: { ...entry }, adapter });
            return entry;
        },
        getAll: async (platform) => {
            if (platform !== 'ios') throw new Error('Calendar push request is invalid');
            const adapter = deps.adapter();
            const values = await pushCall({ op: 'mappings' });
            checkAdapter(adapter);
            if (!Array.isArray(values)) throw invalidReply();
            const entries = values.map(mapping);
            if (new Set(entries.map((entry) => entry.taskId)).size !== entries.length) throw invalidReply();
            mappings.clear();
            entries.forEach((entry) => mappings.set(entry.taskId, { entry: { ...entry }, adapter }));
            return entries;
        },
        upsert: async (entry) => {
            const adapter = deps.adapter();
            if (entry.platform !== 'ios') throw new Error('Calendar push request is invalid');
            await acknowledge(entry.taskId, mapping(entry));
            checkAdapter(adapter);
        },
        delete: async (taskId, platform) => {
            if (platform !== 'ios') throw new Error('Calendar push request is invalid');
            if (pending.has(taskId)) {
                const adapter = deps.adapter();
                await acknowledge(taskId, null);
                checkAdapter(adapter);
                return;
            }
            const captured = mappings.get(taskId);
            if (!captured) return;
            checkAdapter(captured.adapter);
            await completed({ op: 'deleteMapping', expected: { ...captured.entry } });
            checkAdapter(captured.adapter);
            if (mappings.get(taskId) === captured) mappings.delete(taskId);
        },
    };
    const stateNames = [CALENDAR_PUSH_ENABLED_KEY, CALENDAR_PUSH_CALENDAR_ID_KEY, CALENDAR_PUSH_TARGET_ID_KEY,
        CALENDAR_PUSH_COLOR_KEY, CALENDAR_PUSH_CREATION_INTENT_KEY];
    const getItem = async (name: string): Promise<string | null> => {
        if (name === CALENDAR_PUSH_PENDING_KEY) return null;
        const index = stateNames.indexOf(name);
        if (index === -1) return guarded(() => deps.storage.getItem(name));
        const adapter = deps.adapter();
        const state = await pushCall({ op: 'readState' });
        checkAdapter(adapter);
        if (!Array.isArray(state) || state.length !== 5 || state.some((cell) => cell !== null && typeof cell !== 'string')) throw invalidReply();
        return state[index];
    };
    host.storage = {
        getItem,
        setItem: async (name, value) => {
            const adapter = deps.adapter();
            if (name === CALENDAR_PUSH_PENDING_KEY) throw new Error('Calendar push request is invalid');
            if (stateNames.includes(name)) await completed({ op: 'setState', name, value });
            else await guarded(() => deps.storage.setItem(name, value));
            checkAdapter(adapter);
        },
        removeItem: async (name) => {
            const adapter = deps.adapter();
            if (name === CALENDAR_PUSH_PENDING_KEY) return;
            if (stateNames.includes(name)) await completed({ op: 'setState', name, value: null });
            else await guarded(() => deps.storage.removeItem(name));
            checkAdapter(adapter);
        },
        multiGet: async (names) => {
            if (deps.storage.multiGet && names.every((name) => !stateNames.includes(name) && name !== CALENDAR_PUSH_PENDING_KEY)) {
                return guarded(() => deps.storage.multiGet!(names));
            }
            const adapter = deps.adapter();
            const rows: [string, string | null][] = [];
            for (const name of names) {
                const value = await getItem(name);
                checkAdapter(adapter);
                rows.push([name, value]);
            }
            return rows;
        },
    };
    return host;
}
