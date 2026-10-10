import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasCalendarPushTaskMarker } from './calendar-scheduling';
import {
    createExternalCalendarFeeds,
    normalizeSystemCalendarSettings,
    EXTERNAL_CALENDARS_KEY,
    SYSTEM_CALENDAR_SETTINGS_KEY,
    type DeviceCalendar,
    type DeviceCalendarEvent,
    type ExternalCalendarFeedsHost,
} from './external-calendar-feeds';

/**
 * The feed and device calendar ports as a native host binds them. React Native's
 * own suite (apps/mobile/tests/external-calendar.test.ts) runs the same code
 * through its binding.
 */
const ics = (events: [string, string, string][]) => [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    ...events.flatMap(([uid, start, summary]) => ['BEGIN:VEVENT', `UID:${uid}`, `DTSTART:${start}`, `DURATION:PT1H`, `SUMMARY:${summary}`, 'END:VEVENT']),
    'END:VCALENDAR',
].join('\r\n');

function device(options: {
    storage?: Record<string, string>;
    platform?: string;
    feeds?: Record<string, string | 'hang' | { status: number }>;
    files?: Record<string, string>;
    calendars?: DeviceCalendar[];
    events?: DeviceCalendarEvent[];
    permission?: string;
    pushed?: { calendarId: string; calendarEventId: string }[];
} = {}) {
    const storage = new Map(Object.entries(options.storage ?? {}));
    const calls: unknown[][] = [];
    const logs: unknown[][] = [];
    const host: ExternalCalendarFeedsHost = {
        platform: () => options.platform ?? 'android',
        storage: {
            getItem: async (key) => storage.get(key) ?? null,
            setItem: async (key, value) => { storage.set(key, value); },
        },
        fetch: (async (url: string, init?: { signal?: AbortSignal }) => {
            calls.push(['fetch', url]);
            const feed = options.feeds?.[url];
            if (feed === 'hang') {
                return await new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason ?? new Error('aborted')));
                });
            }
            if (feed === undefined || typeof feed !== 'string') return { ok: false, status: typeof feed === 'object' ? feed.status : 404, text: async () => '' };
            return { ok: true, status: 200, text: async () => feed };
        }) as unknown as typeof fetch,
        readLocalFile: async (url) => {
            calls.push(['readLocalFile', url]);
            const text = options.files?.[url];
            if (text === undefined) throw new Error('unreadable');
            return text;
        },
        calendars: {
            getPermissions: async () => ({ status: options.permission ?? 'granted' }),
            requestPermissions: async () => {
                calls.push(['requestPermissions']);
                return { status: 'granted' };
            },
            getCalendars: async () => {
                calls.push(['getCalendars']);
                return options.calendars ?? [];
            },
            getEvents: async (ids, start, end) => {
                calls.push(['getEvents', ids, start.toISOString(), end.toISOString()]);
                return (options.events ?? []).filter((event) => ids.includes(event.calendarId ?? ''));
            },
        },
        getAllCalendarSyncEntries: async () => options.pushed ?? [],
        logInfo: (message, context) => { logs.push([message, context]); },
    };
    return { host, storage, calls, logs, feeds: createExternalCalendarFeeds(host) };
}

const SEPT = [new Date('2026-09-01T00:00:00.000Z'), new Date('2026-10-01T00:00:00.000Z')] as const;
const feed = (id: string, url: string, extra: Record<string, unknown> = {}) => ({ id, name: id, url, enabled: true, ...extra });

describe('external calendar feeds behind the host ports', () => {
    beforeEach(() => { process.env.TZ = 'UTC'; });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('reads each enabled feed through fetch, a local file through readLocalFile, and skips a failing or disabled one', async () => {
        const { feeds, calls } = device({
            storage: { [EXTERNAL_CALENDARS_KEY]: JSON.stringify([
                feed('team', 'https://example.com/team.ics'),
                feed('local', 'content://downloads/42'),
                feed('broken', 'https://example.com/broken.ics'),
                feed('off', 'https://example.com/off.ics', { enabled: false }),
            ]) },
            feeds: { 'https://example.com/team.ics': ics([['t1', '20260910T090000Z', 'Planning']]), 'https://example.com/broken.ics': { status: 500 } },
            files: { 'content://downloads/42': ics([['l1', '20260911T090000Z', 'Local']]) },
        });
        const result = await feeds.fetchExternalCalendarEvents(...SEPT);
        expect(result.events.map((event) => [event.sourceId, event.title])).toEqual([['team', 'Planning'], ['local', 'Local']]);
        expect(calls.filter(([name]) => name === 'fetch' || name === 'readLocalFile')).toEqual([
            ['fetch', 'https://example.com/team.ics'],
            ['readLocalFile', 'content://downloads/42'],
            ['fetch', 'https://example.com/broken.ics'],
        ]);
        // The list still names every stored subscription, the failed one included.
        expect(result.calendars.map((calendar) => calendar.id)).toEqual(['team', 'local', 'broken', 'off']);
    });

    it('names each enabled feed that failed to load, for the Test button', async () => {
        const { feeds } = device({
            storage: { [EXTERNAL_CALENDARS_KEY]: JSON.stringify([
                feed('team', 'https://example.com/team.ics'),
                feed('broken', 'https://example.com/broken.ics'),
                feed('missing-file', 'file:///gone.ics'),
                feed('off', 'https://example.com/off.ics', { enabled: false }),
            ]) },
            feeds: { 'https://example.com/team.ics': ics([['t1', '20260910T090000Z', 'Planning']]) },
        });
        const failed: string[] = [];
        const result = await feeds.fetchExternalCalendarEvents(...SEPT, { onFeedError: (calendarId) => { failed.push(calendarId); } });
        expect(result.events).toHaveLength(1);
        expect(failed).toEqual(['broken', 'missing-file']);
    });

    it('gives up on a feed after 15 s without failing the others', async () => {
        vi.useFakeTimers();
        const { feeds } = device({
            storage: { [EXTERNAL_CALENDARS_KEY]: JSON.stringify([feed('slow', 'https://slow.example/cal.ics'), feed('fast', 'https://fast.example/cal.ics')]) },
            feeds: { 'https://slow.example/cal.ics': 'hang', 'https://fast.example/cal.ics': ics([['f1', '20260910T090000Z', 'Fast']]) },
        });
        const pending = feeds.fetchExternalCalendarEvents(...SEPT);
        await vi.advanceTimersByTimeAsync(14_999);
        let settled = false;
        void pending.then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect((await pending).events.map((event) => event.title)).toEqual(['Fast']);
    });

    it('stops every read when the caller aborts, and bounds the whole fetch with timeoutMs', async () => {
        const stored = { [EXTERNAL_CALENDARS_KEY]: JSON.stringify([feed('slow', 'https://slow.example/cal.ics')]) };
        const hanging = device({ storage: { ...stored, [SYSTEM_CALENDAR_SETTINGS_KEY]: JSON.stringify({ enabled: true }) }, feeds: { 'https://slow.example/cal.ics': 'hang' } });
        hanging.host.calendars.getCalendars = () => new Promise(() => undefined);
        const controller = new AbortController();
        const aborted = hanging.feeds.fetchExternalCalendarEvents(...SEPT, { signal: controller.signal });
        controller.abort(new Error('Screen left'));
        await expect(aborted).rejects.toThrow('Screen left');

        vi.useFakeTimers();
        const bounded = hanging.feeds.fetchExternalCalendarEvents(...SEPT, { timeoutMs: 2_000 });
        const outcome = expect(bounded).rejects.toThrow('External calendar request timed out');
        await vi.advanceTimersByTimeAsync(2_000);
        await outcome;
    });

    it('Task471 does not start enumeration when held passive permission returns after cancellation', async () => {
        const handset = device({ calendars: [{ id: 'work', title: 'Work' }] });
        let enter!: () => void;
        const entered = new Promise<void>((resolve) => { enter = resolve; });
        let release!: (permission: { status: string }) => void;
        handset.host.calendars.getPermissions = () => {
            enter();
            return new Promise((resolve) => { release = resolve; });
        };
        const controller = new AbortController();
        const pending = handset.feeds.fetchExternalCalendarEvents(...SEPT, { signal: controller.signal, sources: {
            subscriptions: [], systemSettings: normalizeSystemCalendarSettings({ enabled: true }),
        } });
        const outcome = expect(pending).rejects.toThrow('Screen closed');
        await entered;
        controller.abort(new Error('Screen closed'));
        release({ status: 'granted' });
        await outcome;
        expect(handset.calls).toEqual([]);
        expect(handset.logs).toEqual([]);
    });

    it('Task471 observes a late permission rejection after cancellation without enumeration, mapping reads or logs', async () => {
        const handset = device({ calendars: [{ id: 'work', title: 'Work' }] });
        let enter!: () => void;
        const entered = new Promise<void>((resolve) => { enter = resolve; });
        let rejectPermission!: (error: Error) => void;
        handset.host.calendars.getPermissions = () => { enter(); return new Promise((_resolve, reject) => { rejectPermission = reject; }); };
        const mapping = vi.spyOn(handset.host, 'getAllCalendarSyncEntries'), controller = new AbortController();
        const pending = handset.feeds.fetchExternalCalendarEvents(...SEPT, { signal: controller.signal, sources: {
            subscriptions: [], systemSettings: normalizeSystemCalendarSettings({ enabled: true }),
        } });
        const outcome = expect(pending).rejects.toThrow('Screen closed');
        await entered; controller.abort(new Error('Screen closed'));
        rejectPermission(new Error('PRIVATE provider rejected after cancellation'));
        await outcome;
        expect(handset.calls).toEqual([]); expect(mapping).not.toHaveBeenCalled(); expect(handset.logs).toEqual([]);
    });

    it('Task471 checks cancellation after saved settings before starting passive permission', async () => {
        const handset = device(), controller = new AbortController();
        const permission = vi.spyOn(handset.host.calendars, 'getPermissions');
        handset.host.storage.getItem = async (name) => {
            if (name === SYSTEM_CALENDAR_SETTINGS_KEY) { controller.abort(new Error('Retired settings read')); return JSON.stringify({ enabled: true }); }
            return null;
        };
        await expect(handset.feeds.fetchExternalCalendarEvents(...SEPT, { signal: controller.signal })).rejects.toThrow('Retired settings read');
        expect(permission).not.toHaveBeenCalled(); expect(handset.calls).toEqual([]); expect(handset.logs).toEqual([]);
    });

    it('keeps one copy of an event a feed lists twice', async () => {
        const text = ics([['dup', '20260910T090000Z', 'Twice'], ['dup', '20260910T090000Z', 'Twice']]);
        const { feeds } = device({
            storage: { [EXTERNAL_CALENDARS_KEY]: JSON.stringify([feed('team', 'https://example.com/team.ics')]) },
            feeds: { 'https://example.com/team.ics': text },
        });
        expect((await feeds.fetchExternalCalendarEvents(...SEPT)).events).toHaveLength(1);
    });

    it('reads the chosen device calendars without the Mindwtr calendar or pushed events, on local dates', async () => {
        const { feeds, calls, logs } = device({
            storage: { [SYSTEM_CALENDAR_SETTINGS_KEY]: JSON.stringify({ enabled: true, selectAll: true, areaIdsByCalendar: { work: ['a-work'] } }) },
            calendars: [
                { id: 'work', title: 'Work', color: '#039BE5' },
                { id: 'mindwtr', title: 'Mindwtr', name: 'mindwtr' },
            ],
            events: [
                { id: 'e1', calendarId: 'work', title: 'Secret meeting', startDate: '2026-09-10T09:00:00.000Z', endDate: '2026-09-10T10:00:00.000Z' },
                // Android's provider stores an all-day event at UTC midnights.
                { id: 'e2', calendarId: 'work', title: 'Holiday', startDate: '2026-09-14T00:00:00.000Z', endDate: '2026-09-15T00:00:00.000Z', allDay: true },
                { id: 'e3', calendarId: 'work', title: 'Pushed by marker', notes: '[Mindwtr Calendar Mirror]\nMindwtr-Task-ID: t1\n[/Mindwtr Calendar Mirror]', startDate: '2026-09-11T09:00:00.000Z', endDate: '2026-09-11T10:00:00.000Z' },
                { id: 'e4', calendarId: 'work', title: 'Pushed by map', startDate: '2026-09-12T09:00:00.000Z', endDate: '2026-09-12T10:00:00.000Z' },
                { id: 'e5', calendarId: 'work', title: 'Outside', startDate: '2026-10-02T09:00:00.000Z', endDate: '2026-10-02T10:00:00.000Z' },
                { id: 'e6', calendarId: 'mindwtr', title: 'Copy in Mindwtr', startDate: '2026-09-10T09:00:00.000Z', endDate: '2026-09-10T10:00:00.000Z' },
            ],
            pushed: [{ calendarId: 'work', calendarEventId: 'e4' }],
        });
        expect(hasCalendarPushTaskMarker('[Mindwtr Calendar Mirror]\nMindwtr-Task-ID: t1\n[/Mindwtr Calendar Mirror]')).toBe(true);
        const result = await feeds.fetchExternalCalendarEvents(...SEPT);
        expect(result.calendars).toEqual([{ id: 'system:work', name: 'Work', url: 'system://work', enabled: true, areaIds: ['a-work'], feedColor: '#039BE5' }]);
        expect(result.events.map((event) => [event.title, event.start, event.end, event.allDay])).toEqual([
            ['Secret meeting', '2026-09-10T09:00:00.000Z', '2026-09-10T10:00:00.000Z', false],
            ['Holiday', new Date(2026, 8, 14).toISOString(), new Date(2026, 8, 15).toISOString(), true],
        ]);
        // Android's query is widened by 92 days on each side, then clipped to the window.
        expect(calls.find(([name]) => name === 'getEvents')).toEqual(['getEvents', ['work'], '2026-06-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z']);
        // Logs carry counts only.
        expect(JSON.stringify(logs)).not.toMatch(/Secret meeting|Holiday|Pushed by|Copy in Mindwtr/);
        expect(logs.map(([message]) => message)).toContain('Mirrored device calendar events excluded');
    });

    it('reads no device calendar while they are off or access is not granted', async () => {
        const off = device({ calendars: [{ id: 'work', title: 'Work' }] });
        await off.feeds.fetchExternalCalendarEvents(...SEPT);
        expect(off.calls).toEqual([]);
        const denied = device({ storage: { [SYSTEM_CALENDAR_SETTINGS_KEY]: JSON.stringify({ enabled: true }) }, permission: 'denied', calendars: [{ id: 'work', title: 'Work' }] });
        await denied.feeds.fetchExternalCalendarEvents(...SEPT);
        expect(denied.calls).toEqual([]);
    });

    it('lists device calendars by name without Mindwtr ones, and keeps choices device-only', async () => {
        const { feeds, storage } = device({
            calendars: [{ id: 'b', title: 'Personal' }, { id: 'a', title: '' , name: 'Account' }, { id: 'm', title: 'Mindwtr' }, { id: ' ', title: 'Blank' }],
        });
        expect(await feeds.getSystemCalendars()).toEqual([{ id: 'a', name: 'Account', color: undefined }, { id: 'b', name: 'Personal', color: undefined }]);
        await feeds.saveSystemCalendarSettings({ enabled: true, selectAll: false, selectedCalendarIds: [' a ', 'a', 'b', 'é', 'e\u0301', ' a ', '', '  '], areaIdsByCalendar: { a: ['x', 'x', ''] } });
        expect(JSON.parse(storage.get(SYSTEM_CALENDAR_SETTINGS_KEY)!)).toEqual({ enabled: true, selectAll: false, selectedCalendarIds: [' a ', 'a', 'b', 'é', 'e\u0301'], areaIdsByCalendar: { a: ['x'] } });
    });

    it('rejects unavailable enumeration with a fixed safe error and never requests permission', async () => {
        const { feeds, host, calls } = device();
        host.calendars.getCalendars = async () => { throw new Error('PRIVATE PROVIDER https://private.example/calendar'); };
        await expect(feeds.getSystemCalendars()).rejects.toThrow(/^Calendar provider unavailable$/);
        expect(calls).not.toContainEqual(['requestPermissions']);
    });

    it.each(['denied', 'undetermined'])('rejects enumeration when passive permission is %s without requesting it', async (permission) => {
        const { feeds, calls } = device({ permission, calendars: [{ id: 'saved', title: 'Saved' }] });
        await expect(feeds.getSystemCalendars()).rejects.toThrow(/^Calendar provider unavailable$/);
        expect(calls).toEqual([]);
    });

    it('returns an empty enumeration only after a successful provider read', async () => {
        const { feeds, calls } = device();
        expect(await feeds.getSystemCalendars()).toEqual([]);
        expect(calls).toEqual([['getCalendars']]);
    });

    it('touches no port in the sandbox', async () => {
        vi.resetModules();
        const sandbox = await import('./sandbox');
        const module = await import('./external-calendar-feeds');
        sandbox.initializeSandboxRuntime(true);
        const { host, calls, storage } = device({ storage: { [EXTERNAL_CALENDARS_KEY]: JSON.stringify([feed('team', 'https://example.com/team.ics')]) } });
        const feeds = module.createExternalCalendarFeeds(host);
        expect(await feeds.fetchExternalCalendarEvents(...SEPT)).toEqual({ calendars: [], events: [] });
        expect(await feeds.fetchExternalCalendarEvents(...SEPT, { sources: {
            subscriptions: [feed('captured', 'https://example.com/captured.ics')], systemSettings: normalizeSystemCalendarSettings({ enabled: true }),
        } })).toEqual({ calendars: [], events: [] });
        await feeds.saveExternalCalendars([feed('new', 'https://example.com/new.ics')]);
        expect(await feeds.getSystemCalendars()).toEqual([]);
        expect(calls).toEqual([]);
        expect(JSON.parse(storage.get(EXTERNAL_CALENDARS_KEY)!)).toHaveLength(1);
        vi.resetModules();
    });

    it('uses captured subscription and device choices without rereading stale device cells; omitted sources retain RN behavior', async () => {
        const canonicalUrl = 'https://example.com/canonical.ics', legacyUrl = 'https://example.com/legacy.ics';
        const handset = device({
            storage: { [EXTERNAL_CALENDARS_KEY]: JSON.stringify([feed('legacy', legacyUrl)]),
                [SYSTEM_CALENDAR_SETTINGS_KEY]: JSON.stringify({ enabled: true }) },
            feeds: { [canonicalUrl]: ics([['canonical', '20260910T090000Z', 'Canonical']]), [legacyUrl]: ics([['legacy', '20260910T090000Z', 'Legacy']]) },
            calendars: [{ id: 'device', title: 'Device' }], events: [{ id: 'event', calendarId: 'device', title: 'Device',
                startDate: '2026-09-10T11:00:00.000Z', endDate: '2026-09-10T12:00:00.000Z' }],
        });
        const reads = vi.spyOn(handset.host.storage, 'getItem');
        const captured = await handset.feeds.fetchExternalCalendarEvents(...SEPT, { sources: {
            subscriptions: [feed('canonical', canonicalUrl, { areaIds: ['é', 'e\u0301'] })],
            systemSettings: normalizeSystemCalendarSettings({ enabled: false }),
        } });
        expect(captured.events.map((event) => event.title)).toEqual(['Canonical']);
        expect(captured.calendars[0].areaIds).toEqual(['é', 'e\u0301']);
        expect(reads).not.toHaveBeenCalled(); expect(handset.calls).toEqual([['fetch', canonicalUrl]]);
        handset.calls.length = 0;
        expect((await handset.feeds.fetchExternalCalendarEvents(...SEPT)).events.map((event) => event.title)).toEqual(['Legacy', 'Device']);
        expect(reads.mock.calls.map(([name]) => name).sort()).toEqual([EXTERNAL_CALENDARS_KEY, SYSTEM_CALENDAR_SETTINGS_KEY].sort());
    });
});
