import {
    canOpenExternalCalendarEvent,
    getReviewCalendarRange,
    logInfo,
    logWarn,
    calendarPushTaskMarkerLine,
    useTaskStore,
    type ExternalCalendarEvent,
    type NativeCalendarFeedSlot,
    type NativeCalendarHost,
    type Task,
} from '@mindwtr/core';
import {
    buildCalendarSyncTaskMap,
    calendarPushChangedTaskIds,
    CALENDAR_PUSH_CALENDAR_ID_KEY,
    CALENDAR_PUSH_ENABLED_KEY,
    CALENDAR_PUSH_TARGET_ID_KEY,
    type CalendarPushEventDetails,
} from '../../../packages/core/src/calendar-push-service';
import type { NativeCalendarPushLifecycle } from '../../../packages/core/src/native-host-contract-settings-calendar';
import type { CalendarSyncEntry } from '../../../packages/core/src/sqlite-adapter';


type KeyValue = {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
};


type CalendarCall = (request: Record<string, unknown>) => Promise<unknown>;
type FileCall = (request: Record<string, unknown>) => Promise<unknown>;
type CalendarSyncStore = {
    ensureSchema(): Promise<unknown>;
    getAllCalendarSyncEntries(platform: string): Promise<CalendarSyncEntry[]>;
    getCalendarSyncEntry(taskId: string, platform: string): Promise<CalendarSyncEntry | null>;
    upsertCalendarSyncEntry(entry: CalendarSyncEntry): Promise<void>;
    deleteCalendarSyncEntry(taskId: string, platform: string): Promise<void>;
};

const eventDetails = (details: CalendarPushEventDetails) => ({
    title: details.title, startMs: details.startDate.getTime(), endMs: details.endDate.getTime(), allDay: details.allDay,
    notes: details.notes, location: details.location,
    ...(details.timeZone ? { timeZone: details.timeZone } : {}),
    ...(details.endTimeZone ? { endTimeZone: details.endTimeZone } : {}),
});

export const UNMARKED_EVENT = 'Calendar event not found: not made by Mindwtr';
export const EVENT_READ_FAILED = 'Calendar provider gave no answer to the event read';

const owner = (context?: { taskId: string; calendarId: string }) => {
    if (!context) return {};
    const taskMarker = calendarPushTaskMarkerLine(context.taskId);
    return { calendarId: context.calendarId, ...(taskMarker ? { taskMarker } : {}) };
};

const reportRefusal = (write: Promise<unknown>, outcome: 'recreated' | 'cleared', attempt: 'update' | 'delete') => write.catch((error: unknown) => {
    try {
        if (error instanceof Error && error.message === UNMARKED_EVENT) {
            logWarn('Calendar push left an event it did not make', { scope: 'calendar-push', force: true,
                context: { releaseCheck: 'v1.3.8/calendar-push-unmarked-event', outcome } });
        } else if (error instanceof Error && error.message === EVENT_READ_FAILED) {
            logWarn('Calendar push kept a row whose event it could not read', { scope: 'calendar-push', force: true,
                context: { releaseCheck: 'v1.3.9/calendar-push-read-failed', outcome: attempt } });
        }
    } catch {}
    throw error;
});

export type NativeAndroidCalendar = NativeCalendarHost & {
    startPush(): Promise<'unavailable' | 'off' | 'pushed' | 'failed'>;
    snapshot(): string;
    pushChanged(token: string): Promise<'unavailable' | 'off' | 'unchanged' | 'pushed' | 'failed'>;
};

export const createNativeCalendar = (keyValue: KeyValue, call: () => CalendarCall, fileCall: () => FileCall,
    sync?: () => CalendarSyncStore): NativeAndroidCalendar => {
    let lifecycle: NativeCalendarPushLifecycle | null = null;
    const snapshots = new Map<string, Map<string, Task>>();
    let snapshotCount = 0;
    const pushState = async () => ({
        saved: await keyValue.get(CALENDAR_PUSH_CALENDAR_ID_KEY),
        target: await keyValue.get(CALENDAR_PUSH_TARGET_ID_KEY),
        listed: await (call()({ op: 'getCalendars' }) as Promise<{ id: string }[]>).then((list) => list.map((calendar) => calendar.id), () => null),
        rows: sync ? await sync().getAllCalendarSyncEntries('android').then((rows) => rows.length, () => -1) : -1,
    });
    const host: NativeAndroidCalendar = {
        platform: { os: 'android' },
        storage: {
            getItem: (key) => keyValue.get(key),
            setItem: (key, value) => keyValue.set(key, value),
            removeItem: (key) => keyValue.remove(key),
        },
        fetch: (input, init) => fetch(input, init),
        readLocalFile: async (url) => new TextDecoder('utf-8', { fatal: false }).decode(await fileCall()({ op: 'readBytes', uri: url }) as Uint8Array),
        calendars: {
            getPermissions: () => call()({ op: 'getPermissions' }) as Promise<{ status: unknown }>,
            requestPermissions: () => call()({ op: 'requestPermissions' }) as Promise<{ status: unknown }>,
            getCalendars: () => call()({ op: 'getCalendars' }) as never,
            getEvents: (calendarIds, start, end) => call()({ op: 'getEvents', calendarIds, start: start.toISOString(), end: end.toISOString() }) as never,
            getSources: async () => [],
            createCalendar: (details) => call()({ op: 'createCalendar', details }) as Promise<string>,
            deleteCalendar: (calendarId) => call()({ op: 'deleteCalendar', calendarId }),
            createEvent: (calendarId, details) => call()({ op: 'createEvent', calendarId, details: eventDetails(details) }) as Promise<string>,
            updateEvent: (eventId, details, context) => reportRefusal(call()({ op: 'updateEvent', eventId, ...owner(context), details: eventDetails(details) }), 'recreated', 'update'),
            deleteEvent: (eventId, context) => reportRefusal(call()({ op: 'deleteEvent', eventId, ...owner(context) }), 'cleared', 'delete'),
        },
        ...(sync ? {
            syncEntries: {
                ensureReady: () => sync().ensureSchema(),
                get: (taskId: string, platform: string) => sync().getCalendarSyncEntry(taskId, platform),
                upsert: (entry: CalendarSyncEntry) => sync().upsertCalendarSyncEntry(entry),
                delete: (taskId: string, platform: string) => sync().deleteCalendarSyncEntry(taskId, platform),
                getAll: (platform: string) => sync().getAllCalendarSyncEntries(platform),
            },
            bindPushLifecycle: (bound: NativeCalendarPushLifecycle) => { lifecycle = bound; },
        } : {}),
        log: {
            info: (message, context) => { try { logInfo(message, { scope: context.scope, context: context.extra }); } catch {  } },
            warn: (message, context) => { try { logWarn(message, { scope: context.scope, context: context.extra }); } catch {  } },
            error: (error, context) => {
                try { logWarn('Calendar settings failed', { scope: context.scope, context: { error: error instanceof Error ? error.name : typeof error } }); } catch {  }
            },
        },
        snapshot: () => {
            const token = `calendar-${++snapshotCount}`;
            snapshots.set(token, buildCalendarSyncTaskMap(useTaskStore.getState()._allTasks));
            for (const stale of snapshots.keys()) if (snapshots.size > 8) snapshots.delete(stale);
            return token;
        },
        pushChanged: async (token) => {
            const before = snapshots.get(token);
            snapshots.delete(token);
            const bound = lifecycle;
            if (!before || !bound) return 'unavailable';
            if (await keyValue.get(CALENDAR_PUSH_ENABLED_KEY) !== '1') return 'off';
            const changed = calendarPushChangedTaskIds(before, useTaskStore.getState()._allTasks);
            if (changed.length === 0) return 'unchanged';
            return bound.run(changed).then(() => 'pushed' as const, () => 'failed' as const);
        },
        startPush: async () => {
            const bound = lifecycle;
            if (!bound) return 'unavailable';
            try {
                const before = await pushState();
                if (!await bound.start()) return 'off';
                const outcome = await bound.run().then(() => 'pushed' as const, () => 'failed' as const);
                const after = await pushState();
                const adopted = after.target ? 'target'
                    : !after.saved ? 'none'
                        : before.listed === null ? 'unknown'
                            : !before.listed.includes(after.saved) ? 'new'
                                : after.saved === before.saved ? 'existing' : 'marker';
                logInfo('Native Android calendar push started', { scope: 'calendar-push', force: true, context: {
                    releaseCheck: 'v1.3.8/native-calendar-push', outcome, adopted, rowsBefore: String(before.rows), rowsAfter: String(after.rows),
                } });
                return outcome;
            } catch (error) {
                try { logWarn('Native Android calendar push did not start', { scope: 'calendar-push', context: { error: error instanceof Error ? error.name : typeof error } }); } catch {  }
                return 'failed';
            }
        },
    };
    return host;
};

type Reply<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
type Event = ExternalCalendarEvent;

type Feed =
    | { status: 'loading'; calendars?: unknown[]; events?: Event[] }
    | { status: 'error'; message: string; calendars?: unknown[] }
    | { status: 'ready'; calendars: unknown[]; events: Event[] };
type LoadInput = { slot: NativeCalendarFeedSlot; start: string; end: string; timeoutMs?: number; refresh?: boolean };


const DAILY_REVIEW_TIMEOUT_MS = 15_000;


export const createCalendarFeeds = (deps: {
    load: (input: LoadInput) => Promise<Reply<Feed>>;
    changed: (slot: NativeCalendarFeedSlot, feed: Feed) => void;
}) => {
    type Entry = { range: string; subscriptions: string; feed: Feed; load: LoadInput; token: number };
    const entries = new Map<NativeCalendarFeedSlot, Entry>();
    let tokens = 0;
    const subscriptions = () => JSON.stringify(useTaskStore.getState().settings.externalCalendars ?? null);

    const reviewRange = (slot: NativeCalendarFeedSlot): LoadInput => {
        const range = getReviewCalendarRange(new Date(), slot === 'dailyReview' ? 2 : 7);
        return { slot, start: range.start.toISOString(), end: range.end.toISOString(), ...(slot === 'dailyReview' ? { timeoutMs: DAILY_REVIEW_TIMEOUT_MS } : {}) };
    };

    const start = (input: LoadInput, refresh: boolean) => {
        const previous = entries.get(input.slot);
        const range = `${input.start}|${input.end}`;
        const sameRange = previous?.range === range;
        const calendars = previous?.feed.calendars;

        const shown = input.slot === 'calendar' && sameRange && previous!.feed.status !== 'error' ? previous!.feed.events : undefined;
        const token = ++tokens;
        entries.set(input.slot, { range, subscriptions: subscriptions(),
            feed: { status: 'loading', ...(calendars ? { calendars } : {}), ...(shown ? { events: shown } : {}) }, load: input, token });
        void deps.load(refresh ? { ...input, refresh: true } : input).then((answer) => {
            const entry = entries.get(input.slot);

            if (!answer.ok || entry?.token !== token) return;
            entries.set(input.slot, { ...entry, feed: answer.value });
            deps.changed(input.slot, answer.value);
        }, () => undefined);
    };


    const feedFor = (input: LoadInput): Feed => {
        const entry = entries.get(input.slot);
        if (!entry || entry.range !== `${input.start}|${input.end}` || entry.subscriptions !== subscriptions()) start(input, false);
        return entries.get(input.slot)!.feed;
    };

    const reviewFeed = (slot: 'weeklyReview' | 'dailyReview') => {
        const feed = feedFor(reviewRange(slot));
        return feed.status === 'ready' ? { status: 'ready' as const, events: feed.events }
            : feed.status === 'error' ? { status: 'error' as const, message: feed.message } : { status: 'loading' as const };
    };

    return {


        calendar: <T,>(input: T): T => {
            const shown = entries.get('calendar')?.feed;
            const feed = shown?.status === 'loading' && shown.events ? { status: 'ready' as const, calendars: shown.calendars ?? [], events: shown.events } : shown;
            return feed && input && typeof input === 'object' && !('calendar' in input) ? { ...input, calendar: feed } : input;
        },


        calendarView: <T extends { range: { start: string; end: string } }>(input: unknown, read: (input: never) => Reply<T>): Reply<T> => {
            if (!input || typeof input !== 'object' || 'calendar' in input) return read(input as never);
            const shown = entries.get('calendar')?.feed;
            const first = read((shown ? { ...input, calendar: shown } : input) as never);
            if (!first.ok) return first;
            const feed = feedFor({ slot: 'calendar', start: first.value.range.start, end: first.value.range.end });
            return feed === shown ? first : read({ ...input, calendar: feed } as never);
        },

        review: <T extends Record<string, unknown>>(slot: 'weeklyReview' | 'dailyReview', input: T): T => (
            input && typeof input === 'object' && !('calendar' in input) ? { ...input, calendar: reviewFeed(slot) } : input
        ),

        refresh: (slot: NativeCalendarFeedSlot) => {
            const entry = entries.get(slot);
            if (!entry) return { started: false };
            start(slot === 'calendar' ? entry.load : reviewRange(slot), true);
            return { started: true };
        },

        event: (eventId: string): { event: Event; canOpen: boolean } | null => {
            const feed = entries.get('calendar')?.feed;
            const event = feed?.status !== 'error' ? feed?.events?.find((candidate) => candidate.id === eventId) : undefined;
            return event ? { event, canOpen: canOpenExternalCalendarEvent(event, 'android') } : null;
        },
    };
};
