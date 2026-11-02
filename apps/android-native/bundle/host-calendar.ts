import {
    canOpenExternalCalendarEvent,
    getReviewCalendarRange,
    logInfo,
    logWarn,
    useTaskStore,
    type ExternalCalendarEvent,
    type NativeCalendarFeedSlot,
    type NativeCalendarHost,
} from '@mindwtr/core';
import {
    CALENDAR_PUSH_CALENDAR_ID_KEY,
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
/** The SQLite adapter's calendar_sync table (RN's storage-adapter calendar sync functions, the same table and rows). */
type CalendarSyncStore = {
    ensureSchema(): Promise<unknown>;
    getAllCalendarSyncEntries(platform: string): Promise<CalendarSyncEntry[]>;
    getCalendarSyncEntry(taskId: string, platform: string): Promise<CalendarSyncEntry | null>;
    upsertCalendarSyncEntry(entry: CalendarSyncEntry): Promise<void>;
    deleteCalendarSyncEntry(taskId: string, platform: string): Promise<void>;
};

/** A pushed event's fields for HostCalendars (CalendarPushWrites.kt): times as epoch ms; `url` has no Android column, as in expo. */
const eventDetails = (details: CalendarPushEventDetails) => ({
    title: details.title, startMs: details.startDate.getTime(), endMs: details.endDate.getTime(), allDay: details.allDay,
    notes: details.notes, location: details.location,
    ...(details.timeZone ? { timeZone: details.timeZone } : {}),
    ...(details.endTimeZone ? { endTimeZone: details.endTimeZone } : {}),
});

export type NativeAndroidCalendar = NativeCalendarHost & {
    /**
     * RN's start of calendar push (use-root-layout-sync-effects.ts, on the root layout's mount; here on syncStart): with push
     * on, the task watcher, then one full push. Never rejects. Logs once what the push found of RN's state.
     */
    startPush(): Promise<void>;
};

/**
 * Core's external calendar device and calendar push (createNativeHostContract's `calendar`,
 * native-host-contract-settings-calendar.ts) on an Android host as RN binds them (external-calendar.ts, calendar-push-sync.ts):
 * RN's AsyncStorage keys, the polyfill's fetch (OkHttp, no Origin header, a body cut short or past the limit rejects), a picked
 * .ics read through the content resolver (expo-file-system's UTF-8 read), the device calendars through HostCalendars
 * (expo-calendar's Android reads and writes) and RN's calendar_sync rows. So an upgrade from RN keeps RN's Mindwtr calendar, its
 * pending-calendar marker and its pushed events: core reuses the saved calendar or adopts the marked one, never makes a second.
 * No log line carries a URL, a calendar name or an event title.
 */
export const createNativeCalendar = (keyValue: KeyValue, call: () => CalendarCall, fileCall: () => FileCall,
    sync?: () => CalendarSyncStore): NativeAndroidCalendar => {
    let lifecycle: NativeCalendarPushLifecycle | null = null;
    /** What the push's start log compares: the saved and chosen calendar, the calendars listed, the pushed-event rows. */
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
            // Android never asks: core makes the Mindwtr calendar on the account of a calendar the user owns.
            getSources: async () => [],
            createCalendar: (details) => call()({ op: 'createCalendar', details }) as Promise<string>,
            // No updateCalendar: Android keeps a calendar's color only from its creation, so core recolors by making a new one (#726).
            deleteCalendar: (calendarId) => call()({ op: 'deleteCalendar', calendarId }),
            createEvent: (calendarId, details) => call()({ op: 'createEvent', calendarId, details: eventDetails(details) }) as Promise<string>,
            // The row's calendar goes along: the provider hands a deleted event's _id to the next event, so an event in another
            // calendar is missing to CalendarPushWrites.kt, never written (it may be the user's own).
            updateEvent: (eventId, details, context) => call()({ op: 'updateEvent', eventId, ...(context ? { calendarId: context.calendarId } : {}), details: eventDetails(details) }),
            deleteEvent: (eventId, context) => call()({ op: 'deleteEvent', eventId, ...(context ? { calendarId: context.calendarId } : {}) }),
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
            info: (message, context) => { try { logInfo(message, { scope: context.scope, context: context.extra }); } catch { /* a diagnostic line never fails its caller */ } },
            warn: (message, context) => { try { logWarn(message, { scope: context.scope, context: context.extra }); } catch { /* as above */ } },
            // An error's text can name a feed's host: only its kind is logged.
            error: (error, context) => {
                try { logWarn('Calendar settings failed', { scope: context.scope, context: { error: error instanceof Error ? error.name : typeof error } }); } catch { /* as above */ }
            },
        },
        startPush: async () => {
            const bound = lifecycle;
            if (!bound) return;
            try {
                const before = await pushState();
                if (!await bound.start()) return;
                const outcome = await bound.run().then(() => 'pushed', () => 'failed');
                const after = await pushState();
                // What the push did with RN's state: kept the saved calendar, adopted the one a cut-short creation marked, or made one.
                const adopted = after.target ? 'target'
                    : !after.saved ? 'none'
                        : before.listed === null ? 'unknown'
                            : !before.listed.includes(after.saved) ? 'new'
                                : after.saved === before.saved ? 'existing' : 'marker';
                logInfo('Native Android calendar push started', { scope: 'calendar-push', force: true, context: {
                    releaseCheck: 'v1.3.8/native-calendar-push', outcome, adopted, rowsBefore: String(before.rows), rowsAfter: String(after.rows),
                } });
            } catch (error) {
                try { logWarn('Native Android calendar push did not start', { scope: 'calendar-push', context: { error: error instanceof Error ? error.name : typeof error } }); } catch { /* as above */ }
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
