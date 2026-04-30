import { beforeEach, describe, expect, it, vi } from 'vitest';

const getCalendarsMock = vi.hoisted(() => vi.fn());
const fetchSystemCalendarEventsMock = vi.hoisted(() => vi.fn());

vi.mock('./external-calendar-service', () => ({
    ExternalCalendarService: {
        getCalendars: getCalendarsMock,
    },
}));

vi.mock('./runtime', () => ({
    isTauriRuntime: () => false,
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

describe('external calendar events', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        const { __externalCalendarEventsTestUtils } = await import('./external-calendar-events');
        __externalCalendarEventsTestUtils.clearCache();
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

    it('skips subscribed Mindwtr mirror calendars by default', async () => {
        const { fetchExternalCalendarEvents } = await import('./external-calendar-events');
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

    it('caches subscribed ICS calendars by month for adjacent visible ranges', async () => {
        const { fetchExternalCalendarEvents } = await import('./external-calendar-events');
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

    it('filters system Mindwtr mirror calendars and prefixed pushed events', async () => {
        const { fetchExternalCalendarEvents } = await import('./external-calendar-events');
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
