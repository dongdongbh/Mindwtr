import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeSandboxRuntime } from '@mindwtr/core';


const {
  mockGetItem,
  mockSetItem,
  mockRemoveItem,
  calendarApi,
  mockFetch,
  mockPlatform,
  mockGetAllCalendarSyncEntries,
} = vi.hoisted(() => ({
  mockGetItem: vi.fn(async () => null as string | null),
  mockSetItem: vi.fn(async () => undefined),
  mockRemoveItem: vi.fn(async () => undefined),
  calendarApi: {
    getCalendarPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
    requestCalendarPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
    getCalendarsAsync: vi.fn(async () => []),
    getEventsAsync: vi.fn(async () => []),
    editEventInCalendarAsync: vi.fn(async () => undefined),
    openEventInCalendarAsync: vi.fn(async () => undefined),
  },
  mockFetch: vi.fn(async () => ({ ok: true, status: 200, text: async () => '' })),
  mockPlatform: { OS: 'ios' },
  mockGetAllCalendarSyncEntries: vi.fn(async () => []),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: mockGetItem, setItem: mockSetItem, removeItem: mockRemoveItem },
}));

vi.mock('react-native', () => ({ Platform: mockPlatform }));

vi.mock('expo-calendar', () => ({
  EntityTypes: { EVENT: 'event' },
  ...calendarApi,
}));

vi.mock('./storage-adapter', () => ({
  getAllCalendarSyncEntries: mockGetAllCalendarSyncEntries,
}));

import {
  canOpenExternalCalendarEvent,
  fetchExternalCalendarEvents,
  getExternalCalendars,
  getSystemCalendarPermissionStatus,
  getSystemCalendarSettings,
  getSystemCalendars,
  openExternalCalendarEvent,
  requestSystemCalendarPermission,
  saveExternalCalendars,
  saveSystemCalendarSettings,
} from './external-calendar';

const sampleEvent = {
  id: 'event-1',
  sourceId: 'system:calendar-1',
  sourceName: 'Work',
  title: 'Standup',
  start: '2026-05-01T09:00:00.000Z',
  end: '2026-05-01T09:15:00.000Z',
  allDay: false,
  nativeEventId: 'native-1',
} as any;

describe('external-calendar in sandbox mode', () => {
  beforeAll(() => {
    initializeSandboxRuntime(true);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs every entry point without reading the device calendar, the network, or storage', async () => {
    await expect(getExternalCalendars()).resolves.toEqual([]);
    await saveExternalCalendars([
      { id: 'sub-1', name: 'Team', url: 'https://example.com/team.ics', enabled: true },
    ] as any);

    await expect(getSystemCalendarSettings()).resolves.toEqual({
      enabled: false,
      selectAll: true,
      selectedCalendarIds: [],
      areaIdsByCalendar: {},
    });
    await saveSystemCalendarSettings({ enabled: true, selectAll: true, selectedCalendarIds: ['calendar-1'] });
    await expect(getSystemCalendars()).resolves.toEqual([]);
    await expect(fetchExternalCalendarEvents(
      new Date('2026-05-01T00:00:00.000Z'),
      new Date('2026-05-08T00:00:00.000Z'),
    )).resolves.toEqual({ calendars: [], events: [] });

    for (const [name, mock] of Object.entries(calendarApi)) {
      expect(mock, `expo-calendar ${name} was called in sandbox mode`).not.toHaveBeenCalled();
    }
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockGetItem).not.toHaveBeenCalled();
    expect(mockSetItem).not.toHaveBeenCalled();
    expect(mockRemoveItem).not.toHaveBeenCalled();
    expect(mockGetAllCalendarSyncEntries).not.toHaveBeenCalled();
  });

  it('refuses calendar permission prompts and event hand-offs', async () => {
    await expect(getSystemCalendarPermissionStatus()).resolves.toBe('denied');
    await expect(requestSystemCalendarPermission()).resolves.toBe('denied');
    expect(canOpenExternalCalendarEvent(sampleEvent)).toBe(false);
    await expect(openExternalCalendarEvent(sampleEvent)).resolves.toBe(false);

    for (const [name, mock] of Object.entries(calendarApi)) {
      expect(mock, `expo-calendar ${name} was called in sandbox mode`).not.toHaveBeenCalled();
    }
  });
});
