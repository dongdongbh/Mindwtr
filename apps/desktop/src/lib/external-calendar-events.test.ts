import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gzipSync, strToU8 } from 'fflate';

import {
    __externalCalendarEventsTestUtils,
    fetchExternalCalendarEvents,
} from './external-calendar-events';

const getCalendarsMock = vi.hoisted(() => vi.fn());
const fetchSystemCalendarEventsMock = vi.hoisted(() => vi.fn());
const isTauriRuntimeMock = vi.hoisted(() => vi.fn(() => false));
const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('./external-calendar-service', () => ({
    ExternalCalendarService: {
        getCalendars: getCalendarsMock,
    },
}));

vi.mock('./runtime', () => ({
    isTauriRuntime: isTauriRuntimeMock,
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: invokeMock,
}));

vi.mock('./tauri-http', () => ({
    getTauriHttpFetch: vi.fn(async () => null),
}));

vi.mock('./system-calendar', () => ({
    fetchSystemCalendarEvents: fetchSystemCalendarEventsMock,
}));

const workIcs = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:work-1',
    'SUMMARY:Team Meeting',
    'DTSTART:20260426T090000Z',
    'DTEND:20260426T100000Z',
    'END:VEVENT',
    'END:VCALENDAR',
].join('\n');

const yearlyHolidayIcs = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:holiday-1',
    'SUMMARY:New Years Day',
    'DTSTART;VALUE=DATE:20250101',
    'RRULE:FREQ=YEARLY;COUNT=5',
    'END:VEVENT',
    'END:VCALENDAR',
].join('\n');

const categorizedIcs = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:work-january',
    'SUMMARY:January work',
    'DTSTART:20260115T090000Z',
    'DTEND:20260115T100000Z',
    'CATEGORIES:Work',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:personal-february',
    'SUMMARY:February personal',
    'DTSTART:20260215T090000Z',
    'DTEND:20260215T100000Z',
    'CATEGORIES:Personal',
    'END:VEVENT',
    'END:VCALENDAR',
].join('\n');

describe('external calendar events', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        __externalCalendarEventsTestUtils.clearCache();
        isTauriRuntimeMock.mockReturnValue(false);
        invokeMock.mockReset();
        getCalendarsMock.mockResolvedValue([]);
        fetchSystemCalendarEventsMock.mockResolvedValue({
            permission: 'unsupported',
            calendars: [],
            events: [],
        });
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            if (url === 'https://calendar.example/work.ics') {
                return new Response(workIcs, { status: 200 });
            }
            return new Response(workIcs, { status: 200 });
        }));
    });

    it('shows a local file while the system calendar read is pending, then keeps both sources', async () => {
        isTauriRuntimeMock.mockReturnValue(true);
        const file = { id: 'work', name: 'Work', url: 'file:///calendar.ics', enabled: true };
        const system = { id: 'system:local', name: 'System', url: 'system://local', enabled: true };
        getCalendarsMock.mockResolvedValue([file]);
        invokeMock.mockResolvedValue(workIcs);
        let finishSystem!: () => void;
        fetchSystemCalendarEventsMock.mockImplementation(() => new Promise(resolve => {
            finishSystem = () => resolve({ calendars: [system], events: [] });
        }));
        const showFiles = vi.fn();
        const complete = fetchExternalCalendarEvents(
            new Date('2026-04-26T00:00:00Z'), new Date('2026-04-27T00:00:00Z'), showFiles,
        );
        await vi.waitFor(() => expect(showFiles).toHaveBeenCalledWith(expect.objectContaining({
            events: [expect.objectContaining({ title: 'Team Meeting' })],
        })));
        finishSystem();
        expect((await complete).calendars.map(calendar => calendar.id)).toEqual(['work', 'system:local']);
    });

    it('skips subscribed Mindwtr mirror calendars by default', async () => {
        getCalendarsMock.mockResolvedValue([
            { id: 'mirror', name: 'Mindwtr', url: 'https://calendar.example/mindwtr.ics', enabled: true },
            { id: 'work', name: 'Work', url: 'https://calendar.example/work.ics', enabled: true },
        ]);

        const result = await fetchExternalCalendarEvents(
            new Date('2026-04-26T00:00:00.000Z'),
            new Date('2026-04-27T00:00:00.000Z'),
        );

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledWith('https://calendar.example/work.ics', expect.anything());
        expect(result.calendars.map((calendar) => calendar.id)).toEqual(['work']);
        expect(result.events.map((event) => event.title)).toEqual(['Team Meeting']);
    });

    it('asks the desktop HTTP client to send no Origin header for subscribed feeds', async () => {
        isTauriRuntimeMock.mockReturnValue(true);
        getCalendarsMock.mockResolvedValue([
            { id: 'work', name: 'Work', url: 'https://calendar.example/work.ics', enabled: true },
        ]);

        await fetchExternalCalendarEvents(
            new Date('2026-04-26T00:00:00.000Z'),
            new Date('2026-04-27T00:00:00.000Z'),
        );

        expect(fetch).toHaveBeenCalledWith(
            'https://calendar.example/work.ics',
            expect.objectContaining({ headers: { Origin: '' } }),
        );
    });

    it('caches subscribed ICS calendars by month for adjacent visible ranges', async () => {
        getCalendarsMock.mockResolvedValue([
            { id: 'work', name: 'Work', url: 'https://calendar.example/work.ics', enabled: true },
        ]);

        await fetchExternalCalendarEvents(
            new Date('2026-04-26T00:00:00.000Z'),
            new Date('2026-04-27T00:00:00.000Z'),
        );
        await fetchExternalCalendarEvents(
            new Date('2026-04-27T00:00:00.000Z'),
            new Date('2026-04-28T00:00:00.000Z'),
        );

        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('keeps every feed category visible while paging months with different categories', async () => {
        getCalendarsMock.mockResolvedValue([
            { id: 'shared', name: 'Shared', url: 'https://calendar.example/shared.ics', enabled: true },
        ]);
        vi.mocked(fetch).mockImplementation(async () => new Response(categorizedIcs, { status: 200 }));

        const january = await fetchExternalCalendarEvents(
            new Date('2026-01-01T00:00:00.000Z'),
            new Date('2026-02-01T00:00:00.000Z'),
        );
        const february = await fetchExternalCalendarEvents(
            new Date('2026-02-01T00:00:00.000Z'),
            new Date('2026-03-01T00:00:00.000Z'),
        );

        expect(january.calendars.map((calendar) => calendar.id)).toEqual([
            'shared#Personal',
            'shared#Work',
        ]);
        expect(january.events.map((event) => event.title)).toEqual(['January work']);
        expect(february.calendars.map((calendar) => calendar.id)).toEqual([
            'shared#Personal',
            'shared#Work',
        ]);
        expect(february.events.map((event) => event.title)).toEqual(['February personal']);
    });

    it('loads yearly recurring subscribed ICS events in the visible desktop range', async () => {
        getCalendarsMock.mockResolvedValue([
            { id: 'holiday', name: 'US Holidays', url: 'https://calendar.example/holidays.ics', enabled: true },
        ]);
        vi.mocked(fetch).mockResolvedValue(new Response(yearlyHolidayIcs, { status: 200 }));

        const result = await fetchExternalCalendarEvents(
            new Date('2026-01-01T00:00:00.000Z'),
            new Date('2026-01-02T00:00:00.000Z'),
        );

        expect(result.warnings).toEqual([]);
        expect(result.events.map((event) => event.title)).toEqual(['New Years Day']);
        expect(result.events[0].start.slice(0, 10)).toBe('2026-01-01');
    });

    it('loads gzip-encoded subscribed ICS responses', async () => {
        getCalendarsMock.mockResolvedValue([
            { id: 'holiday', name: 'US Holidays', url: 'https://calendar.example/holidays.ics', enabled: true },
        ]);
        const compressed = gzipSync(strToU8(yearlyHolidayIcs));
        const body = compressed.buffer.slice(
            compressed.byteOffset,
            compressed.byteOffset + compressed.byteLength,
        ) as ArrayBuffer;
        vi.mocked(fetch).mockResolvedValue(new Response(body, {
            status: 200,
            headers: { 'content-encoding': 'gzip', 'content-type': 'text/calendar; charset=UTF-8' },
        }));

        const result = await fetchExternalCalendarEvents(
            new Date('2026-01-01T00:00:00.000Z'),
            new Date('2026-01-02T00:00:00.000Z'),
        );

        expect(result.warnings).toEqual([]);
        expect(result.events.map((event) => event.title)).toEqual(['New Years Day']);
        expect(result.events[0].start.slice(0, 10)).toBe('2026-01-01');
    });

    it('refuses a feed whose raw body or gunzip output exceeds 20 MiB and still loads the others', async () => {
        getCalendarsMock.mockResolvedValue([
            { id: 'bomb', name: 'Bomb', url: 'https://calendar.example/bomb.ics', enabled: true },
            { id: 'huge', name: 'Huge', url: 'https://calendar.example/huge.ics', enabled: true },
            { id: 'work', name: 'Work', url: 'https://calendar.example/work.ics', enabled: true },
        ]);
        const oversized = workIcs + ' '.repeat(20 * 1024 * 1024);
        const bomb = gzipSync(strToU8(oversized));
        vi.mocked(fetch).mockImplementation(async (input) => {
            const url = String(input);
            if (url.endsWith('/bomb.ics')) return new Response(bomb.slice().buffer as ArrayBuffer, { status: 200 });
            if (url.endsWith('/huge.ics')) return new Response(oversized, { status: 200 });
            return new Response(workIcs, { status: 200 });
        });

        const result = await fetchExternalCalendarEvents(
            new Date('2026-04-26T00:00:00.000Z'),
            new Date('2026-04-27T00:00:00.000Z'),
        );

        expect(result.warnings).toEqual([
            'Failed to load "Bomb": Response exceeds the 20971520 byte download limit',
            'Failed to load "Huge": Response exceeds the 20971520 byte download limit',
        ]);
        expect(result.events.map((event) => event.title)).toEqual(['Team Meeting']);
    });

    it('loads local ICS calendar files through the desktop calendar read command', async () => {
        isTauriRuntimeMock.mockReturnValue(true);
        invokeMock.mockResolvedValue(workIcs);
        getCalendarsMock.mockResolvedValue([
            { id: 'local-work', name: 'Local Work', url: 'file:///home/user/agenda.ics', enabled: true },
        ]);

        const result = await fetchExternalCalendarEvents(
            new Date('2026-04-26T00:00:00.000Z'),
            new Date('2026-04-27T00:00:00.000Z'),
        );

        expect(invokeMock).toHaveBeenCalledWith('read_external_calendar_file', {
            url: 'file:///home/user/agenda.ics',
        });
        expect(fetch).not.toHaveBeenCalled();
        expect(result.warnings).toEqual([]);
        expect(result.events.map((event) => event.title)).toEqual(['Team Meeting']);
    });

    it('filters system Mindwtr mirror calendars and prefixed pushed events', async () => {
        fetchSystemCalendarEventsMock.mockResolvedValue({
            permission: 'granted',
            calendars: [
                { id: 'system:mindwtr', name: 'Mindwtr', url: 'system://mindwtr', enabled: true },
                { id: 'system:personal', name: 'Personal', url: 'system://personal', enabled: true },
            ],
            events: [
                {
                    id: 'system:mindwtr:event-1:2026-04-26T09:00:00.000Z',
                    sourceId: 'system:mindwtr',
                    title: 'Write release notes',
                    start: '2026-04-26T09:00:00.000Z',
                    end: '2026-04-26T09:30:00.000Z',
                    allDay: false,
                },
                {
                    id: 'system:personal:event-2:2026-04-26T10:00:00.000Z',
                    sourceId: 'system:personal',
                    title: 'Mindwtr: Schedule review',
                    start: '2026-04-26T10:00:00.000Z',
                    end: '2026-04-26T10:30:00.000Z',
                    allDay: false,
                },
                {
                    id: 'system:personal:event-3:2026-04-26T11:00:00.000Z',
                    sourceId: 'system:personal',
                    title: 'Dentist',
                    start: '2026-04-26T11:00:00.000Z',
                    end: '2026-04-26T12:00:00.000Z',
                    allDay: false,
                },
            ],
        });

        const result = await fetchExternalCalendarEvents(
            new Date('2026-04-26T00:00:00.000Z'),
            new Date('2026-04-27T00:00:00.000Z'),
        );

        expect(result.calendars.map((calendar) => calendar.id)).toEqual(['system:personal']);
        expect(result.events.map((event) => event.title)).toEqual(['Dentist']);
    });
});
