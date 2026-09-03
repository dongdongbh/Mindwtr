import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockPlatform, mockNativeModules, mockReschedule, mockStartActivityAsync } = vi.hoisted(() => ({
  mockPlatform: { OS: 'android' as string, Version: 34 as number | string },
  mockNativeModules: { RNAlarmNotification: {} as Record<string, unknown> },
  mockReschedule: vi.fn(async () => undefined),
  mockStartActivityAsync: vi.fn(async () => ({ resultCode: -1 })),
}));

vi.mock('react-native', () => ({
  Platform: mockPlatform,
  NativeModules: mockNativeModules,
}));

vi.mock('./notification-service', () => ({
  rescheduleMobileAlarmsAsExact: mockReschedule,
}));

vi.mock('expo-application', () => ({ applicationId: 'tech.dongdongbh.mindwtr' }));

vi.mock('expo-intent-launcher', () => ({
  startActivityAsync: mockStartActivityAsync,
  ActivityAction: { REQUEST_SCHEDULE_EXACT_ALARM: 'android.settings.REQUEST_SCHEDULE_EXACT_ALARM' },
}));

import {
  __exactAlarmTestUtils,
  canScheduleExactAlarms,
  isExactAlarmPermissionRelevant,
  openExactAlarmSettings,
  refreshExactAlarmPermission,
} from './exact-alarm-permission';

const setNativeAnswer = (answer: boolean | (() => Promise<boolean>)) => {
  mockNativeModules.RNAlarmNotification = {
    canScheduleExactAlarms: typeof answer === 'function' ? answer : vi.fn(async () => answer),
  };
};

beforeEach(() => {
  mockPlatform.OS = 'android';
  mockPlatform.Version = 34;
  setNativeAnswer(true);
  mockReschedule.mockClear();
  mockStartActivityAsync.mockClear();
  __exactAlarmTestUtils.reset();
});

describe('isExactAlarmPermissionRelevant', () => {
  it('is true only on Android 12 (API 31) and above', () => {
    expect(isExactAlarmPermissionRelevant()).toBe(true);

    mockPlatform.Version = 31;
    expect(isExactAlarmPermissionRelevant()).toBe(true);

    mockPlatform.Version = 30;
    expect(isExactAlarmPermissionRelevant()).toBe(false);

    mockPlatform.Version = 34;
    mockPlatform.OS = 'ios';
    expect(isExactAlarmPermissionRelevant()).toBe(false);
  });
});

describe('canScheduleExactAlarms', () => {
  it('reports the native answer on Android 12+', async () => {
    setNativeAnswer(false);
    await expect(canScheduleExactAlarms()).resolves.toBe(false);

    setNativeAnswer(true);
    await expect(canScheduleExactAlarms()).resolves.toBe(true);
  });

  it('never asks the native module below API 31', async () => {
    const probe = vi.fn(async () => false);
    mockNativeModules.RNAlarmNotification = { canScheduleExactAlarms: probe };
    mockPlatform.Version = 30;

    await expect(canScheduleExactAlarms()).resolves.toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it('assumes exact alarms work when the native method is missing or throws', async () => {
    mockNativeModules.RNAlarmNotification = {};
    await expect(canScheduleExactAlarms()).resolves.toBe(true);

    setNativeAnswer(async () => {
      throw new Error('bridge exploded');
    });
    await expect(canScheduleExactAlarms()).resolves.toBe(true);
  });
});

describe('refreshExactAlarmPermission', () => {
  it('rebuilds the scheduled alarms once when the state flips from denied to allowed', async () => {
    setNativeAnswer(false);
    await expect(refreshExactAlarmPermission()).resolves.toBe(false);
    expect(mockReschedule).not.toHaveBeenCalled();

    setNativeAnswer(true);
    await expect(refreshExactAlarmPermission()).resolves.toBe(true);
    expect(mockReschedule).toHaveBeenCalledTimes(1);

    // Two settings screens can both refresh on the same foreground event.
    await refreshExactAlarmPermission();
    await refreshExactAlarmPermission();
    expect(mockReschedule).toHaveBeenCalledTimes(1);
  });

  it('does not rebuild on the first read of a cold start', async () => {
    setNativeAnswer(true);
    await expect(refreshExactAlarmPermission()).resolves.toBe(true);
    expect(mockReschedule).not.toHaveBeenCalled();
  });

  it('rebuilds again after the user revokes and re-allows', async () => {
    setNativeAnswer(false);
    await refreshExactAlarmPermission();
    setNativeAnswer(true);
    await refreshExactAlarmPermission();
    setNativeAnswer(false);
    await refreshExactAlarmPermission();
    setNativeAnswer(true);
    await refreshExactAlarmPermission();

    expect(mockReschedule).toHaveBeenCalledTimes(2);
  });
});

describe('openExactAlarmSettings', () => {
  it('opens the system screen scoped to this app', async () => {
    await openExactAlarmSettings();
    expect(mockStartActivityAsync).toHaveBeenCalledWith(
      'android.settings.REQUEST_SCHEDULE_EXACT_ALARM',
      { data: 'package:tech.dongdongbh.mindwtr' }
    );
  });

  it('does nothing below API 31', async () => {
    mockPlatform.Version = 30;
    await openExactAlarmSettings();
    expect(mockStartActivityAsync).not.toHaveBeenCalled();
  });
});
