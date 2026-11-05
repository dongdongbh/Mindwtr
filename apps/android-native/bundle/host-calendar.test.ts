import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { useTaskStore } from '@mindwtr/core';
import { createCalendarFeeds, createNativeCalendar, EVENT_READ_FAILED, UNMARKED_EVENT } from './host-calendar';


type Load = { input: { slot: string; start: string; end: string; timeoutMs?: number; refresh?: boolean }; settle: (value: unknown) => void };

const harness = () => {
    const loads: Load[] = [];
    const changed: string[] = [];
    const feeds = createCalendarFeeds({
        load: (input) => new Promise((resolve) => { loads.push({ input, settle: resolve as never }); }),
        changed: (slot) => { changed.push(slot); },
    });
    const ready = (events: unknown[]) => ({ ok: true, value: { status: 'ready', calendars: [{ id: 'c' }], events } });
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    const reads: unknown[] = [];
    const view = (range: { start: string; end: string }) => (input: never) => {
        reads.push((input as { calendar?: unknown }).calendar);
        return { ok: true as const, value: { range, calendar: (input as { calendar?: unknown }).calendar } };
    };
    return { feeds, loads, changed, ready, flush, reads, view };
};

const OCTOBER = { start: '2026-09-28T04:00:00.000Z', end: '2026-11-02T04:00:00.000Z' };
const NOVEMBER = { start: '2026-10-26T04:00:00.000Z', end: '2026-12-07T05:00:00.000Z' };
const event = { id: 'system:7:42:2026-10-06T14:00:00.000Z', sourceId: 'system:7', nativeEventId: '42', title: 'Standup', start: '2026-10-06T14:00:00.000Z', end: '2026-10-06T14:30:00.000Z', allDay: false };

describe('the Calendar feed', () => {
    it('loads the range the view names, shows loading until it ends, then tells the screen', async () => {
        const { feeds, loads, changed, ready, flush, view } = harness();
        const first = feeds.calendarView({ state: null }, view(OCTOBER));
        expect(first.ok && first.value.calendar).toEqual({ status: 'loading' });
        expect(loads.map((load) => load.input)).toEqual([{ slot: 'calendar', ...OCTOBER }]);

        feeds.calendarView({ state: null, offset: 100 }, view(OCTOBER));
        expect(loads).toHaveLength(1);
        loads[0].settle(ready([event]));
        await flush();
        expect(changed).toEqual(['calendar']);
        const shown = feeds.calendarView({ state: null }, view(OCTOBER));
        expect(shown.ok && shown.value.calendar).toEqual({ status: 'ready', calendars: [{ id: 'c' }], events: [event] });
        expect(feeds.calendar({ taskId: 't' })).toEqual({ taskId: 't', calendar: { status: 'ready', calendars: [{ id: 'c' }], events: [event] } });
        expect(feeds.event(event.id)).toEqual({ event, canOpen: true });
        expect(feeds.event('missing')).toBeNull();
    });

    it('keeps the events under RN\'s Loading… line while the same range reloads, and shows loading with the calendars for a new range', async () => {
        const { feeds, loads, changed, ready, flush, view } = harness();
        feeds.calendarView({}, view(OCTOBER));
        loads[0].settle(ready([event]));
        await flush();
        expect(feeds.refresh('calendar')).toEqual({ started: true });
        expect(loads[1].input).toEqual({ slot: 'calendar', ...OCTOBER, refresh: true });
        const during = feeds.calendarView({}, view(OCTOBER));
        expect(during.ok && during.value.calendar).toEqual({ status: 'loading', calendars: [{ id: 'c' }], events: [event] });
        expect(feeds.event(event.id)).toEqual({ event, canOpen: true });

        expect(feeds.calendar({ taskId: 't' })).toEqual({ taskId: 't', calendar: { status: 'ready', calendars: [{ id: 'c' }], events: [event] } });
        const moved = feeds.calendarView({}, view(NOVEMBER));
        expect(moved.ok && moved.value.calendar).toEqual({ status: 'loading', calendars: [{ id: 'c' }] });

        loads[1].settle(ready([]));
        await flush();
        expect(changed).toEqual(['calendar']);
        loads[2].settle({ ok: false, error: { code: 'STALE_REVISION', message: 'replaced' } });
        await flush();
        expect(changed).toEqual(['calendar']);
    });

    it('loads again once the synced subscriptions change, as RN\'s effect does', () => {
        const { feeds, loads, view } = harness();
        feeds.calendarView({}, view(OCTOBER));
        useTaskStore.setState({ settings: { ...useTaskStore.getState().settings, externalCalendars: [{ id: 'f', name: 'Team', url: 'https://example.com/a.ics', enabled: true }] } });
        try {
            feeds.calendarView({}, view(OCTOBER));
            expect(loads).toHaveLength(2);
        } finally {
            useTaskStore.setState({ settings: { ...useTaskStore.getState().settings, externalCalendars: undefined } });
        }
    });

    it('never replaces a feed the caller sent, and a slot never loaded loads at its first read', () => {
        const { feeds, loads, view } = harness();
        expect(feeds.refresh('calendar')).toEqual({ started: false });
        const sent = { status: 'ready', calendars: [], events: [] };
        const answer = feeds.calendarView({ calendar: sent }, view(OCTOBER));
        expect(answer.ok && answer.value.calendar).toBe(sent);
        expect(loads).toHaveLength(0);
    });
});

describe('the reviews\' feeds', () => {
    it('loads 7 days for the Weekly Review and 2 for the Daily Review from the start of today, the Daily one bounded', async () => {
        const { feeds, loads, ready, flush } = harness();
        expect(feeds.review('weeklyReview', { checkpoint: null })).toEqual({ checkpoint: null, calendar: { status: 'loading' } });
        expect(feeds.review('dailyReview', {})).toEqual({ calendar: { status: 'loading' } });
        const today = new Date();
        const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const days = (load: Load) => (Date.parse(load.input.end) + 1 - Date.parse(load.input.start)) / 86_400_000;
        expect(loads.map((load) => [load.input.slot, load.input.start, Math.round(days(load)), load.input.timeoutMs])).toEqual([
            ['weeklyReview', start.toISOString(), 7, undefined],
            ['dailyReview', start.toISOString(), 2, 15_000],
        ]);
        loads[0].settle(ready([event]));
        loads[1].settle({ ok: true, value: { status: 'error', message: 'External calendar request timed out' } });
        await flush();
        expect(feeds.review('weeklyReview', {})).toEqual({ calendar: { status: 'ready', events: [event] } });
        expect(feeds.review('dailyReview', {})).toEqual({ calendar: { status: 'error', message: 'External calendar request timed out' } });

        feeds.refresh('weeklyReview');
        expect(feeds.review('weeklyReview', {})).toEqual({ calendar: { status: 'loading' } });
    });
});

describe('the pushed-event map', () => {
    it('reads and writes RN\'s calendar_sync rows on the boot adapter (an exported task mirror without the notes marker stays out of the feed)', async () => {
        const rows = [{ taskId: 't1', calendarEventId: '42', calendarId: '7', platform: 'android', lastSyncedAt: '2026-10-01T00:00:00.000Z' }];
        const calls: unknown[][] = [];
        const host = createNativeCalendar(
            { get: async () => null, set: async () => undefined, remove: async () => undefined },
            () => async () => [], () => async () => new Uint8Array(),
            () => ({
                ensureSchema: async () => { calls.push(['ensureSchema']); },
                getAllCalendarSyncEntries: async (platform: string) => { calls.push(['getAll', platform]); return rows; },
                getCalendarSyncEntry: async (taskId: string) => rows.find((row) => row.taskId === taskId) ?? null,
                upsertCalendarSyncEntry: async (entry) => { calls.push(['upsert', entry.taskId]); },
                deleteCalendarSyncEntry: async (taskId: string, platform: string) => { calls.push(['delete', taskId, platform]); },
            }),
        );
        expect(await host.syncEntries!.getAll('android')).toEqual(rows);
        expect(await host.syncEntries!.get('t1', 'android')).toEqual(rows[0]);
        await host.syncEntries!.ensureReady();
        await host.syncEntries!.upsert(rows[0]);
        await host.syncEntries!.delete('t1', 'android');
        expect(calls).toEqual([['getAll', 'android'], ['ensureSchema'], ['upsert', 't1'], ['delete', 't1', 'android']]);
    });
});

describe('the device', () => {
    it('reads instances by ISO bounds, and a picked .ics as UTF-8 through the file port', async () => {
        const calls: unknown[] = [];
        const host = createNativeCalendar(
            { get: async () => null, set: async () => undefined, remove: async () => undefined },
            () => async (request) => { calls.push(request); return []; },
            () => async (request) => { calls.push(request); return new TextEncoder().encode('BEGIN:VCALENDAR\r\nSUMMARY:Café\r\n'); },
        );
        await host.calendars.getEvents(['7'], new Date('2026-10-01T00:00:00Z'), new Date('2026-10-02T00:00:00Z'));
        expect(await host.readLocalFile('content://downloads/7')).toBe('BEGIN:VCALENDAR\r\nSUMMARY:Café\r\n');
        expect(calls).toEqual([
            { op: 'getEvents', calendarIds: ['7'], start: '2026-10-01T00:00:00.000Z', end: '2026-10-02T00:00:00.000Z' },
            { op: 'readBytes', uri: 'content://downloads/7' },
        ]);
        expect(host.platform.os).toBe('android');
    });
});

describe('the push writes', () => {
    it('send HostCalendars epoch ms, keep core\'s UTC zone for an all-day event, and drop the url Android has no column for', async () => {
        const calls: Record<string, unknown>[] = [];
        const host = createNativeCalendar(
            { get: async () => null, set: async () => undefined, remove: async () => undefined },
            () => async (request) => { calls.push(request); return '9'; }, () => async () => new Uint8Array(),
        );
        const details = { title: 'T', startDate: new Date('2026-10-30T00:00:00Z'), endDate: new Date('2026-10-31T00:00:00Z'), allDay: true,
            notes: 'N', location: '', url: 'https://example.com', timeZone: 'UTC', endTimeZone: 'UTC' };
        expect(await host.calendars.createEvent!('7', { ...details, calendarId: '7' })).toBe('9');
        await host.calendars.updateEvent!('9', { ...details, allDay: false, timeZone: undefined, endTimeZone: undefined }, { taskId: 't1', calendarId: '7' });
        await host.calendars.deleteEvent!('9', { taskId: 't1', calendarId: '7' });
        await host.calendars.deleteCalendar!('7');
        expect(await host.calendars.getSources!()).toEqual([]);
        expect(host.calendars.updateCalendar).toBeUndefined();
        const sent = { title: 'T', startMs: 1_793_318_400_000, endMs: 1_793_404_800_000, notes: 'N', location: '' };
        expect(calls).toEqual([
            { op: 'createEvent', calendarId: '7', details: { ...sent, allDay: true, timeZone: 'UTC', endTimeZone: 'UTC' } },
            { op: 'updateEvent', eventId: '9', calendarId: '7', taskMarker: 'Mindwtr-Task-ID: t1', details: { ...sent, allDay: false } },
            { op: 'deleteEvent', eventId: '9', calendarId: '7', taskMarker: 'Mindwtr-Task-ID: t1' },
            { op: 'deleteCalendar', calendarId: '7' },
        ]);
    });
});

describe('the unmarked-event answer', () => {
    it('is the text CalendarPushWrites.kt answers', () => {
        const kotlin = readFileSync(new URL('../android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/CalendarPushWrites.kt', import.meta.url), 'utf8');
        expect(kotlin).toContain(`const val UNMARKED_EVENT = "${UNMARKED_EVENT}"`);
        expect(kotlin).toContain(`const val EVENT_READ_FAILED = "${EVENT_READ_FAILED}"`);
    });
});
