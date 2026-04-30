import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockGetItem,
    mockSetItem,
    mockGetCalendarsAsync,
    mockGetCalendarPermissionsAsync,
    mockRequestCalendarPermissionsAsync,
    mockGetEventsAsync,
    mockPlatform,
} = vi.hoisted(() => ({
    mockGetItem: vi.fn<(key: string) => Promise<string | null>>(async () => null),
    mockSetItem: vi.fn<(key: string, value: string) => Promise<void>>(async () => {}),
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
    mockPlatform: { OS: 'android' },
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
}));

import {
    EXTERNAL_CALENDARS_KEY,
    SYSTEM_CALENDAR_SETTINGS_KEY,
    fetchExternalCalendarEvents,
    getSystemCalendars,
} from '@/lib/external-calendar';

beforeEach(() => {
    vi.clearAllMocks();
    mockPlatform.OS = 'android';
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

describe('fetchExternalCalendarEvents', () => {
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

        expect(mockGetEventsAsync).toHaveBeenCalledWith(['google-primary'], rangeStart, rangeEnd);
        expect(result.events.map((event) => event.title)).toEqual(['Team meeting']);
    });
});
