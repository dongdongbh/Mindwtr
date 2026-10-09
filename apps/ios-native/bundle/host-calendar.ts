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
    let localReadTail: Promise<unknown> = Promise.resolve();
    return {
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
}
