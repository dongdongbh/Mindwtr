import type { NativeCalendarHost } from '../../../packages/core/src/native-host-contract-settings-calendar';
import type { SqliteAdapter } from '../../../packages/core/src/sqlite-adapter';

export type CalendarCall = (request: Record<string, unknown>) => Promise<unknown>;

/** Core retains RN selection, all-day handling and exported-event suppression. */
export function createIOSCalendarHost(deps: {
    call: CalendarCall;
    storage: NativeCalendarHost['storage'];
    adapter: () => SqliteAdapter;
    fetch: typeof fetch;
    log: NativeCalendarHost['log'];
}): NativeCalendarHost {
    const read = async <T>(request: Record<string, unknown>): Promise<T> => {
        const adapter = deps.adapter();
        const value = await deps.call(request);
        if (deps.adapter() !== adapter) throw new Error('NOT_READY: Calendar library changed');
        return value as T;
    };
    const permissions = () => read<{ status: unknown }>({ op: 'permissions' });
    return {
        platform: { os: 'ios' }, storage: deps.storage, fetch: deps.fetch, log: deps.log,
        repairFeedDeviceCopyOnOpen: false,
        // A legacy provider URL cannot be opened through the app-private attachment port.
        readLocalFile: async () => { throw new Error('Local calendar subscription is unavailable'); },
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
}
