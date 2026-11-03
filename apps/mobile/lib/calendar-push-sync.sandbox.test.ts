import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeSandboxRuntime, useTaskStore } from '@mindwtr/core';


const {
  mockGetItem,
  mockSetItem,
  mockRemoveItem,
  calendarApi,
  storageAdapter,
  mockPlatform,
} = vi.hoisted(() => ({
  mockGetItem: vi.fn(async () => null as string | null),
  mockSetItem: vi.fn(async () => undefined),
  mockRemoveItem: vi.fn(async () => undefined),
  calendarApi: {
    getCalendarPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
    requestCalendarPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
    getCalendarsAsync: vi.fn(async () => []),
    getSourcesAsync: vi.fn(async () => []),
    createCalendarAsync: vi.fn(async () => 'calendar-1'),
    updateCalendarAsync: vi.fn(async () => undefined),
    deleteCalendarAsync: vi.fn(async () => undefined),
    createEventAsync: vi.fn(async () => 'event-1'),
    updateEventAsync: vi.fn(async () => undefined),
    deleteEventAsync: vi.fn(async () => undefined),
  },
  storageAdapter: {
    ensureCalendarSyncStorageReady: vi.fn(async () => true),
    getCalendarSyncEntry: vi.fn(async () => null),
    upsertCalendarSyncEntry: vi.fn(async () => undefined),
    deleteCalendarSyncEntry: vi.fn(async () => undefined),
    getAllCalendarSyncEntries: vi.fn(async () => []),
  },
  mockPlatform: { OS: 'ios' },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: mockGetItem, setItem: mockSetItem, removeItem: mockRemoveItem },
}));

vi.mock('react-native', () => ({ Platform: mockPlatform }));

vi.mock('expo-calendar', () => ({
  EntityTypes: { EVENT: 'event' },
  CalendarAccessLevel: { OWNER: 'owner' },
  SourceType: { LOCAL: 'local' },
  ...calendarApi,
}));

vi.mock('./storage-adapter', () => storageAdapter);

vi.mock('./app-log', () => ({
  logInfo: vi.fn(async () => undefined),
  logWarn: vi.fn(async () => undefined),
  logError: vi.fn(async () => undefined),
}));

import {
  deleteMindwtrCalendar,
  ensureMindwtrCalendar,
  getCalendarPushColor,
  getCalendarPushEnabled,
  getCalendarPushTargetCalendarId,
  getCalendarPushTargetCalendars,
  getCalendarWritePermissionStatus,
  requestCalendarWritePermission,
  runFullCalendarSync,
  scheduleSyncDebounced,
  setCalendarPushColor,
  setCalendarPushEnabled,
  setCalendarPushTargetCalendarId,
  startCalendarPushSync,
  stopCalendarPushSync,
  updateMindwtrCalendarColor,
} from './calendar-push-sync';

const expectNoNativeCalls = () => {
  for (const [name, mock] of Object.entries(calendarApi)) {
    expect(mock, `expo-calendar ${name} was called in sandbox mode`).not.toHaveBeenCalled();
  }
  for (const [name, mock] of Object.entries(storageAdapter)) {
    expect(mock, `storage-adapter ${name} was called in sandbox mode`).not.toHaveBeenCalled();
  }
  expect(mockGetItem).not.toHaveBeenCalled();
  expect(mockSetItem).not.toHaveBeenCalled();
  expect(mockRemoveItem).not.toHaveBeenCalled();
};

describe('calendar-push-sync in sandbox mode', () => {
  beforeAll(() => {
    initializeSandboxRuntime(true);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps every setting inert instead of reading or writing one', async () => {
    await expect(getCalendarPushEnabled()).resolves.toBe(false);
    await setCalendarPushEnabled(true);
    await expect(getCalendarPushTargetCalendarId()).resolves.toBeNull();
    await setCalendarPushTargetCalendarId('calendar-1');
    await setCalendarPushTargetCalendarId(null);
    await expect(getCalendarPushColor()).resolves.toBe('#3B82F6');
    await expect(setCalendarPushColor('#EA580C')).resolves.toBe('#EA580C');

    expectNoNativeCalls();
  });

  it('never asks for calendar write permission or touches a calendar', async () => {
    await expect(requestCalendarWritePermission()).resolves.toBe(false);
    await expect(getCalendarWritePermissionStatus()).resolves.toBe('undetermined');
    await expect(getCalendarPushTargetCalendars()).resolves.toEqual([]);
    await expect(ensureMindwtrCalendar()).resolves.toBeNull();
    await expect(updateMindwtrCalendarColor('#EA580C')).resolves.toBe(false);
    await expect(deleteMindwtrCalendar()).resolves.toBeUndefined();

    expectNoNativeCalls();
  });

  it('runs no push and never subscribes to the task store', async () => {
    const subscribeSpy = vi.spyOn(useTaskStore, 'subscribe');
    vi.useFakeTimers();

    try {
      await runFullCalendarSync();
      scheduleSyncDebounced(['task-1']);
      const unsubscribe = startCalendarPushSync();
      unsubscribe();
      stopCalendarPushSync();


      await vi.advanceTimersByTimeAsync(10_000);
    } finally {
      vi.useRealTimers();
    }

    expect(subscribeSpy).not.toHaveBeenCalled();
    expectNoNativeCalls();
    subscribeSpy.mockRestore();
  });
});
