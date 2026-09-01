import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockGetItem,
    mockSetItem,
    mockReadSafString,
    mockGetCalendarsAsync,
    mockGetCalendarPermissionsAsync,
    mockRequestCalendarPermissionsAsync,
    mockGetEventsAsync,
    mockEditEventInCalendarAsync,
    mockOpenEventInCalendarAsync,
    mockPlatform,
} = vi.hoisted(() => ({
    mockGetItem: vi.fn<(key: string) => Promise<string | null>>(async () => null),
    mockSetItem: vi.fn<(key: string, value: string) => Promise<void>>(async () => {}),
    mockReadSafString: vi.fn(async () => ''),
    mockGetCalendarsAsync: vi.fn(async () => [] as Array<{
        id: string;
        title?: string;
        name?: string;
        color?: string;
    }>),
    mockGetCalendarPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
    mockRequestCalendarPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
    mockGetEventsAsync: vi.fn(async () => [] as Array<{
        id: string;
        calendarId: string;
        title: string;
        startDate: Date;
        endDate: Date;
        allDay?: boolean;
        notes?: string | null;
        location?: string | null;
    }>),
    mockEditEventInCalendarAsync: vi.fn(async () => ({ action: 'done', id: null })),
    mockOpenEventInCalendarAsync: vi.fn(async () => ({ action: 'done' })),
    mockPlatform: { OS: 'android' },
}));

vi.mock('expo-file-system/legacy', () => ({
    __esModule: true,
    documentDirectory: 'document',
    cacheDirectory: 'cache',
    StorageAccessFramework: {
        readAsStringAsync: mockReadSafString,
    },
    readAsStringAsync: mockReadSafString,
    getInfoAsync: vi.fn(async () => ({ exists: false })),
    EncodingType: {
        Base64: 'base64',
    },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: mockGetItem,
        setItem: mockSetItem,
    },
}));

vi.mock('react-native', () => ({
    Platform: mockPlatform,
}));

vi.mock('expo-calendar', () => ({
    EntityTypes: { EVENT: 'event' },
    getCalendarsAsync: mockGetCalendarsAsync,
    getCalendarPermissionsAsync: mockGetCalendarPermissionsAsync,
    requestCalendarPermissionsAsync: mockRequestCalendarPermissionsAsync,
    getEventsAsync: mockGetEventsAsync,
    editEventInCalendarAsync: mockEditEventInCalendarAsync,
    openEventInCalendarAsync: mockOpenEventInCalendarAsync,
}));

import {
    EXTERNAL_CALENDARS_KEY,
    SYSTEM_CALENDAR_SETTINGS_KEY,
    canOpenExternalCalendarEvent,
    fetchExternalCalendarEvents,
    getSystemCalendars,
    openExternalCalendarEvent,
    saveExternalCalendars,
} from '@/lib/external-calendar';

beforeEach(() => {
    vi.clearAllMocks();
    mockPlatform.OS = 'android';
    mockReadSafString.mockResolvedValue('');
    mockGetCalendarPermissionsAsync.mockResolvedValue({ status: 'granted' });
    mockRequestCalendarPermissionsAsync.mockResolvedValue({ status: 'granted' });
    mockGetItem.mockImplementation(async (key: string) => {
        if (key === EXTERNAL_CALENDARS_KEY) return '[]';
        if (key === SYSTEM_CALENDAR_SETTINGS_KEY) {
            return JSON.stringify({ enabled: true, selectAll: true, selectedCalendarIds: [] });
        }
        return null;
    });
});

describe('getSystemCalendars', () => {
    it('hides Mindwtr output calendars from the device calendar input list', async () => {
        mockGetCalendarsAsync.mockResolvedValue([
            { id: 'google-primary', title: 'Google', color: '#888888' },
            { id: 'google-mindwtr', title: 'Mindwtr', color: '#a17464' },
            { id: 'local-account', title: 'local account', color: '#000000' },
        ]);

        const calendars = await getSystemCalendars();

        expect(calendars.map((calendar) => calendar.name)).toEqual(['Google', 'local account']);
    });
});

// Mirrors the day bucketing in components/views/calendar/useCalendarViewController.ts
// (`externalEventsByDate`): local days, end exclusive when it lands on local midnight.
function countProjectedDays(event: { start: string; end: string } | undefined): number {
    if (!event) return 0;
    const start = new Date(event.start);
    const end = new Date(event.end);
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 0, 0, 0, 0);
    const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 0, 0, 0, 0);
    if (end.getTime() === endDay.getTime()) endDay.setDate(endDay.getDate() - 1);
    let days = 0;
    while (day.getTime() <= endDay.getTime() && days < 370) {
        days += 1;
        day.setDate(day.getDate() + 1);
    }
    return days;
}

describe('fetchExternalCalendarEvents', () => {
    it('loads Android local ICS files through content URIs', async () => {
        const rangeStart = new Date('2026-04-20T00:00:00.000Z');
        const rangeEnd = new Date('2026-04-21T00:00:00.000Z');
        mockGetItem.mockImplementation(async (key: string) => {
            if (key === EXTERNAL_CALENDARS_KEY) {
                return JSON.stringify([
                    { id: 'local-ics', name: 'Local ICS', url: 'content://downloads/agenda.ics', enabled: true },
                ]);
            }
            if (key === SYSTEM_CALENDAR_SETTINGS_KEY) {
                return JSON.stringify({ enabled: false, selectAll: true, selectedCalendarIds: [] });
            }
            return null;
        });
        mockReadSafString.mockResolvedValue(
            [
                'BEGIN:VCALENDAR',
                'VERSION:2.0',
                'BEGIN:VEVENT',
                'UID:local-event',
                'DTSTART:20260420T110000Z',
                'DTEND:20260420T113000Z',
                'SUMMARY:Local Meeting',
                'END:VEVENT',
                'END:VCALENDAR',
            ].join('\r\n'),
        );

        const result = await fetchExternalCalendarEvents(rangeStart, rangeEnd);

        expect(mockReadSafString).toHaveBeenCalledWith(
            'content://downloads/agenda.ics',
            {},
        );
        expect(result.events.map((event) => event.title)).toEqual(['Local Meeting']);
    });

    it('surfaces an uncategorised ICS feed\'s calendar-level color, the common case (#974)', async () => {
        const rangeStart = new Date('2026-04-20T00:00:00.000Z');
        const rangeEnd = new Date('2026-04-21T00:00:00.000Z');
        mockGetItem.mockImplementation(async (key: string) => {
            if (key === EXTERNAL_CALENDARS_KEY) {
                return JSON.stringify([
                    { id: 'local-ics', name: 'Local ICS', url: 'content://downloads/agenda.ics', enabled: true },
                ]);
            }
            if (key === SYSTEM_CALENDAR_SETTINGS_KEY) {
                return JSON.stringify({ enabled: false, selectAll: true, selectedCalendarIds: [] });
            }
            return null;
        });
        mockReadSafString.mockResolvedValue(
            [
                'BEGIN:VCALENDAR',
                'VERSION:2.0',
                'X-APPLE-CALENDAR-COLOR:#123456',
                'BEGIN:VEVENT',
                'UID:local-event',
                'DTSTART:20260420T110000Z',
                'DTEND:20260420T113000Z',
                'SUMMARY:Local Meeting',
                'END:VEVENT',
                'END:VCALENDAR',
            ].join('\r\n'),
        );

        const result = await fetchExternalCalendarEvents(rangeStart, rangeEnd);

        const calendar = result.calendars.find((entry) => entry.id === 'local-ics');
        expect(calendar?.feedColor).toBe('#123456');
    });

    it('keeps out-of-range feed categories in the mobile calendar roster', async () => {
        const rangeStart = new Date('2026-01-01T00:00:00.000Z');
        const rangeEnd = new Date('2026-02-01T00:00:00.000Z');
        mockGetItem.mockImplementation(async (key: string) => {
            if (key === EXTERNAL_CALENDARS_KEY) {
                return JSON.stringify([
                    { id: 'shared', name: 'Shared', url: 'content://downloads/shared.ics', enabled: true },
                ]);
            }
            if (key === SYSTEM_CALENDAR_SETTINGS_KEY) {
                return JSON.stringify({ enabled: false, selectAll: true, selectedCalendarIds: [] });
            }
            return null;
        });
        mockReadSafString.mockResolvedValue(
            [
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
            ].join('\r\n'),
        );

        const result = await fetchExternalCalendarEvents(rangeStart, rangeEnd);

        expect(result.calendars.map((calendar) => calendar.id)).toEqual([
            'shared#Personal',
            'shared#Work',
        ]);
        expect(result.events.map((event) => event.title)).toEqual(['January work']);
    });

    it('does not import Mindwtr-pushed events back into the Mindwtr calendar view', async () => {
        const rangeStart = new Date('2026-04-20T00:00:00.000Z');
        const rangeEnd = new Date('2026-04-21T00:00:00.000Z');
        mockGetCalendarsAsync.mockResolvedValue([
            { id: 'google-primary', title: 'Google', color: '#888888' },
            { id: 'google-mindwtr', title: 'Mindwtr', color: '#a17464' },
        ]);
        mockGetEventsAsync.mockResolvedValue([
            {
                id: 'mindwtr-pushed',
                calendarId: 'google-primary',
                title: 'Mindwtr: Follow up',
                startDate: new Date('2026-04-20T10:00:00.000Z'),
                endDate: new Date('2026-04-20T10:30:00.000Z'),
                allDay: false,
            },
            {
                id: 'external-meeting',
                calendarId: 'google-primary',
                title: 'Team meeting',
                startDate: new Date('2026-04-20T11:00:00.000Z'),
                endDate: new Date('2026-04-20T11:30:00.000Z'),
                allDay: false,
            },
        ]);

        const result = await fetchExternalCalendarEvents(rangeStart, rangeEnd);

        expect(mockGetEventsAsync).toHaveBeenCalledWith(
            ['google-primary'],
            expect.any(Date),
            expect.any(Date),
        );
        expect(result.events.map((event) => event.title)).toEqual(['Team meeting']);
        expect(result.events[0]?.nativeEventId).toBe('external-meeting');
    });

    it('projects an all-day device event over exactly its own days, like the .ics import (#1133)', async () => {
        // The reporter is east of UTC; Android hands all-day bounds back as UTC midnight, which
        // reads as 02:00 local and used to paint a fourth day. Pinned so the assertion means the
        // same thing on a UTC CI runner.
        const originalTz = process.env.TZ;
        process.env.TZ = 'Europe/Berlin';
        try {
            const rangeStart = new Date('2026-09-01T00:00:00.000Z');
            const rangeEnd = new Date('2026-10-01T00:00:00.000Z');
            mockGetItem.mockImplementation(async (key: string) => {
                if (key === EXTERNAL_CALENDARS_KEY) {
                    return JSON.stringify([
                        { id: 'ics-feed', name: 'Feed', url: 'content://downloads/days.ics', enabled: true },
                    ]);
                }
                if (key === SYSTEM_CALENDAR_SETTINGS_KEY) {
                    return JSON.stringify({ enabled: true, selectAll: true, selectedCalendarIds: [] });
                }
                return null;
            });
            // Same three-day all-day event, once through each path.
            mockReadSafString.mockResolvedValue(
                [
                    'BEGIN:VCALENDAR',
                    'VERSION:2.0',
                    'BEGIN:VEVENT',
                    'UID:three-days',
                    'SUMMARY:Days 1-3',
                    'DTSTART;VALUE=DATE:20260901',
                    'DTEND;VALUE=DATE:20260904',
                    'END:VEVENT',
                    'END:VCALENDAR',
                ].join('\r\n'),
            );
            mockGetCalendarsAsync.mockResolvedValue([
                { id: 'davx5', title: 'DAVx5', color: '#888888' },
            ]);
            mockGetEventsAsync.mockResolvedValue([
                {
                    id: 'three-days',
                    calendarId: 'davx5',
                    title: 'Days 1-3',
                    startDate: new Date('2026-09-01T00:00:00.000Z'),
                    endDate: new Date('2026-09-04T00:00:00.000Z'),
                    allDay: true,
                },
            ]);

            const result = await fetchExternalCalendarEvents(rangeStart, rangeEnd);

            const device = result.events.find((event) => event.sourceId === 'system:davx5');
            const ics = result.events.find((event) => event.sourceId === 'ics-feed');
            expect(countProjectedDays(device)).toBe(3);
            expect(countProjectedDays(ics)).toBe(3);
            expect(device?.start).toBe(ics?.start);
            expect(device?.end).toBe(ics?.end);
        } finally {
            process.env.TZ = originalTz;
        }
    });

    it('keeps device-calendar events that span the queried window (#1134)', async () => {
        // Android's provider query only returns events fully contained in the window, so the fetch
        // has to over-query and clip; a multi-day event crossing the month edge must survive both.
        const rangeStart = new Date('2026-04-01T00:00:00.000Z');
        const rangeEnd = new Date('2026-05-01T00:00:00.000Z');
        mockGetCalendarsAsync.mockResolvedValue([
            { id: 'google-primary', title: 'Google', color: '#888888' },
        ]);
        mockGetEventsAsync.mockResolvedValue([
            {
                id: 'crosses-month-end',
                calendarId: 'google-primary',
                title: 'Day 4',
                startDate: new Date('2026-04-29T00:00:00.000Z'),
                endDate: new Date('2026-05-03T00:00:00.000Z'),
                allDay: true,
            },
            {
                id: 'crosses-month-start',
                calendarId: 'google-primary',
                title: 'Trip',
                startDate: new Date('2026-03-28T00:00:00.000Z'),
                endDate: new Date('2026-04-02T00:00:00.000Z'),
                allDay: true,
            },
            {
                id: 'spans-whole-window',
                calendarId: 'google-primary',
                title: 'Sabbatical',
                startDate: new Date('2026-03-10T00:00:00.000Z'),
                endDate: new Date('2026-06-10T00:00:00.000Z'),
                allDay: true,
            },
            {
                id: 'entirely-before',
                calendarId: 'google-primary',
                title: 'Last month',
                startDate: new Date('2026-03-05T09:00:00.000Z'),
                endDate: new Date('2026-03-05T10:00:00.000Z'),
                allDay: false,
            },
        ]);

        const result = await fetchExternalCalendarEvents(rangeStart, rangeEnd);

        const [, queriedStart, queriedEnd] = mockGetEventsAsync.mock.calls[0] as unknown as [
            string[],
            Date,
            Date,
        ];
        expect(queriedStart.getTime()).toBeLessThan(rangeStart.getTime());
        expect(queriedEnd.getTime()).toBeGreaterThan(rangeEnd.getTime());
        expect(result.events.map((event) => event.title).sort()).toEqual([
            'Day 4',
            'Sabbatical',
            'Trip',
        ]);
    });

    it('surfaces a system calendar\'s own color as a feed hint, not an explicit pick (#974)', async () => {
        const rangeStart = new Date('2026-04-20T00:00:00.000Z');
        const rangeEnd = new Date('2026-04-21T00:00:00.000Z');
        mockGetCalendarsAsync.mockResolvedValue([
            { id: 'google-primary', title: 'Google', color: '#123456' },
        ]);
        mockGetEventsAsync.mockResolvedValue([]);

        const result = await fetchExternalCalendarEvents(rangeStart, rangeEnd);

        const systemCalendar = result.calendars.find((calendar) => calendar.id === 'system:google-primary');
        expect(systemCalendar?.feedColor).toBe('#123456');
        expect(systemCalendar?.color).toBeUndefined();
    });

    it('opens native device calendar events in the calendar app', async () => {
        const event = {
            id: 'system:google-primary:external-meeting:2026-04-20T11:00:00.000Z',
            sourceId: 'system:google-primary',
            nativeEventId: 'external-meeting',
            title: 'Team meeting',
            start: '2026-04-20T11:00:00.000Z',
            end: '2026-04-20T11:30:00.000Z',
            allDay: false,
        };

        await expect(openExternalCalendarEvent(event)).resolves.toBe(true);

        expect(canOpenExternalCalendarEvent(event)).toBe(true);
        expect(mockEditEventInCalendarAsync).toHaveBeenCalledWith(
            { id: 'external-meeting', instanceStartDate: '2026-04-20T11:00:00.000Z' },
            { startNewActivityTask: true },
        );
        expect(mockOpenEventInCalendarAsync).not.toHaveBeenCalled();
    });

    it('keeps ICS subscription events read-only', async () => {
        const event = {
            id: 'ics-1:uid-1:2026-04-20T11:00:00.000Z',
            sourceId: 'ics-1',
            title: 'Subscribed event',
            start: '2026-04-20T11:00:00.000Z',
            end: '2026-04-20T11:30:00.000Z',
            allDay: false,
        };

        await expect(openExternalCalendarEvent(event)).resolves.toBe(false);

        expect(canOpenExternalCalendarEvent(event)).toBe(false);
        expect(mockEditEventInCalendarAsync).not.toHaveBeenCalled();
        expect(mockOpenEventInCalendarAsync).not.toHaveBeenCalled();
    });
});

describe('saveExternalCalendars', () => {
    it('never persists a derived feedColor into synced settings storage (#974)', async () => {
        await saveExternalCalendars([
            { id: 'a', name: 'A', url: 'https://example.test/a.ics', enabled: true, feedColor: '#123456' } as never,
        ]);

        const [, savedRaw] = mockSetItem.mock.calls.find(([key]) => key === EXTERNAL_CALENDARS_KEY) ?? [];
        const saved = JSON.parse(savedRaw ?? '[]');
        expect(saved[0].feedColor).toBeUndefined();
    });
});
