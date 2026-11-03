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


type KeyValue = {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
};


type CalendarCall = (request: Record<string, unknown>) => Promise<unknown>;
type FileCall = (request: Record<string, unknown>) => Promise<unknown>;

type CalendarSyncReads = {
    getAllCalendarSyncEntries: NonNullable<NativeCalendarHost['syncEntries']>['getAll'];
    getCalendarSyncEntry(taskId: string, platform: string): Promise<unknown>;
};


export const createNativeCalendar = (keyValue: KeyValue, call: () => CalendarCall, fileCall: () => FileCall,
    sync?: () => CalendarSyncReads): NativeCalendarHost => ({
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
    },
    ...(sync ? {
        syncEntries: {
            ensureReady: () => Promise.reject(new Error('Calendar push is not available on this host yet')),
            get: (taskId: string, platform: string) => sync().getCalendarSyncEntry(taskId, platform) as never,
            upsert: () => Promise.reject(new Error('Calendar push is not available on this host yet')),
            delete: () => Promise.reject(new Error('Calendar push is not available on this host yet')),
            getAll: (platform: string) => sync().getAllCalendarSyncEntries(platform),
        },
    } : {}),
    log: {
        info: (message, context) => { try { logInfo(message, { scope: context.scope, context: context.extra }); } catch {                                                } },
        warn: (message, context) => { try { logWarn(message, { scope: context.scope, context: context.extra }); } catch {                } },

        error: (error, context) => {
            try { logWarn('Calendar settings failed', { scope: context.scope, context: { error: error instanceof Error ? error.name : typeof error } }); } catch {                }
        },
    },
});

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
