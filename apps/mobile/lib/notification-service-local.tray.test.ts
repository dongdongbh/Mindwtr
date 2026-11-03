


import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({

  postId: (rowId: number) => (harness.platform.OS === 'android' ? rowId + 1000 : rowId),
  platform: { OS: 'android', Version: 34 },
  storage: new Map<string, string>(),
  state: { settings: {} as Record<string, unknown>, tasks: [] as unknown[], projects: [] as unknown[] },
  rows: new Set<number>(),
  tray: new Set<number>(),
  nextId: 1,
  failRemovals: false,

  onRead: null as null | (() => void),
  logs: [] as [string, Record<string, unknown> | undefined][],
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => {
      if (key !== 'mindwtr:local:alarms:v1' && harness.onRead) {
        const change = harness.onRead;
        harness.onRead = null;
        change();
      }
      return harness.storage.get(key) ?? null;
    },
    setItem: async (key: string, value: string) => { harness.storage.set(key, value); },
    removeItem: async (key: string) => { harness.storage.delete(key); },
  },
}));

vi.mock('react-native', () => ({
  NativeEventEmitter: class {
    addListener() {
      return { remove: () => undefined };
    }
  },
  NativeModules: {

    RNAlarmNotification: {
      getNotificationId: async (id: number) => (harness.rows.has(id) ? harness.postId(id) : null),
      clearNotification: (notificationId: number) => { harness.tray.delete(notificationId); },
    },
  },
  PermissionsAndroid: {
    PERMISSIONS: { POST_NOTIFICATIONS: 'POST_NOTIFICATIONS' },
    RESULTS: { GRANTED: 'granted', NEVER_ASK_AGAIN: 'never_ask_again' },
    check: async () => true,
    request: async () => 'granted',
  },
  Platform: harness.platform,
}));

vi.mock('react-native-alarm-notification', () => ({
  default: {
    parseDate: (date: Date) => date.toISOString(),
    scheduleAlarm: async () => {
      const id = harness.nextId++;
      harness.rows.add(id);
      return { id };
    },
    deleteAlarm: (id: number) => { harness.rows.delete(id); },
    deleteRepeatingAlarm: () => undefined,
    removeFiredNotification: (id: number) => {
      if (harness.failRemovals) throw new Error('notification service unavailable');

      if (harness.platform.OS === 'android' && !harness.rows.has(id)) return;
      harness.tray.delete(harness.postId(id));
    },
    removeAllFiredNotifications: () => { harness.tray.clear(); },
    getScheduledAlarms: async () => [],
    requestPermissions: async () => ({ alert: true }),
  },
}));

vi.mock('@mindwtr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mindwtr/core')>();
  return {
    ...actual,
    getSystemDefaultLanguage: () => 'en',
    useTaskStore: {
      getState: () => harness.state,
      subscribe: () => () => undefined,
    },
  };
});

vi.mock('./app-log', () => ({
  isLoggingEnabled: () => false,
  logInfo: async (message: string, context?: { extra?: Record<string, unknown> }) => {
    harness.logs.push([message, context?.extra]);
  },
  logWarn: async () => undefined,
}));

vi.mock('@/modules/notification-open-intents', () => ({
  ensureReminderNotificationChannel: async () => undefined,
  restorePersistentCaptureNotification: () => undefined,
}));

import {
  __localNotificationTestUtils,
  rescheduleLocalAlarmsAsExact,
  startLocalMobileNotifications,
  stopLocalMobileNotifications,
} from './notification-service-local';

const CREATED = '2026-09-01T00:00:00.000Z';
const task = (fields: Record<string, unknown>) => ({
  id: 't', title: 'Pay rent', status: 'next', tags: [], contexts: [], createdAt: CREATED, updatedAt: CREATED, ...fields,
});
const at = (iso: string) => vi.setSystemTime(new Date(iso));

const cycle = () => startLocalMobileNotifications();
const alarmId = (key: string) => __localNotificationTestUtils.getAlarmMapSnapshot().get(key)?.id;

const fire = (key: string) => {
  const id = alarmId(key);
  if (id === undefined) throw new Error(`No alarm for ${key}`);
  harness.tray.add(harness.postId(id));
  return harness.postId(id);
};
const deliveredWithdrawnLines = () => harness.logs.filter(([message, extra]) => (
  message === '[Local Notifications] Delivered reminders withdrawn'
  && extra?.releaseCheck === 'v1.3.4/delivered-reminder-withdrawn'
)).map(([, extra]) => ({ count: extra?.count }));
const withdrawnLines = () => harness.logs.filter(([message, extra]) => (
  message === '[Local Notifications] Reminder alarms cancelled'
  && extra?.releaseCheck === 'v1.3.4/reminder-withdrawn-clears-tray'
)).map(([, extra]) => ({ reason: extra?.reason, count: extra?.count }));

describe.each(['android', 'ios'])('delivered reminders on %s', (platform) => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-09-28T10:00:00.000Z');
    harness.platform.OS = platform;
    harness.storage.clear();
    harness.rows.clear();
    harness.tray.clear();
    harness.logs.length = 0;
    harness.nextId = 1;
    harness.failRemovals = false;
    harness.onRead = null;
    harness.state = { settings: {}, tasks: [], projects: [] };
    __localNotificationTestUtils.resetForTests();
  });
  afterEach(() => {
    __localNotificationTestUtils.resetForTests();
    vi.useRealTimers();
    harness.platform.OS = 'android';
  });

  it('keeps a delivered reminder when only its time passed', async () => {
    harness.state.tasks = [task({ dueDate: '2026-09-28T10:05:00.000Z' })];
    await cycle();
    at('2026-09-28T10:05:05.000Z');
    const delivered = fire('task:t');
    await cycle();
    expect(alarmId('task:t')).toBeUndefined();
    expect(harness.tray.has(delivered)).toBe(true);
    expect(withdrawnLines()).toEqual([{ reason: 'expired', count: 1 }]);
  });


  it('removes a delivered reminder when its task is completed after the cycle that let it expire', async () => {
    harness.state.tasks = [task({ dueDate: '2026-09-28T10:05:00.000Z' })];
    await cycle();
    at('2026-09-28T10:05:05.000Z');
    const delivered = fire('task:t');
    await cycle();
    expect(alarmId('task:t')).toBeUndefined();
    expect(harness.tray.has(delivered)).toBe(true);
    at('2026-09-28T10:05:15.000Z');
    await cycle();
    expect(harness.tray.has(delivered)).toBe(true);
    harness.state.tasks = [task({ dueDate: '2026-09-28T10:05:00.000Z', status: 'done' })];
    await cycle();
    expect(harness.tray.has(delivered)).toBe(false);
    expect(deliveredWithdrawnLines()).toEqual([{ count: 1 }]);
  });

  it('removes an expired delivered reminder after a restart when its due time moves', async () => {
    harness.state.tasks = [task({ dueDate: '2026-09-28T10:05:00.000Z' })];
    await cycle();
    at('2026-09-28T10:05:05.000Z');
    const delivered = fire('task:t');
    await cycle();
    __localNotificationTestUtils.resetForTests();
    harness.state.tasks = [task({ dueDate: '2026-09-29T09:00:00.000Z' })];
    await cycle();
    expect(harness.tray.has(delivered)).toBe(false);
  });

  it('removes an expired delivered reminder when every reminder is turned off', async () => {
    harness.state.tasks = [task({ dueDate: '2026-09-28T10:05:00.000Z' })];
    await cycle();
    at('2026-09-28T10:05:05.000Z');
    const delivered = fire('task:t');
    await cycle();
    await stopLocalMobileNotifications();
    expect(harness.tray.has(delivered)).toBe(false);
  });

  it('keeps a delivered start reminder when the same key moves on to the due reminder', async () => {
    harness.state.tasks = [task({ startTime: '2026-09-28T10:05:00.000Z', dueDate: '2026-09-28T12:00:00.000Z' })];
    await cycle();
    at('2026-09-28T10:05:05.000Z');
    const delivered = fire('task:t');
    await cycle();
    expect(alarmId('task:t')).not.toBe(delivered);
    expect(harness.tray.has(delivered)).toBe(true);
  });

  it('removes a delivered reminder when its task is completed', async () => {
    harness.state.tasks = [task({ dueDate: '2026-09-28T10:05:00.000Z' })];
    await cycle();
    at('2026-09-28T10:05:05.000Z');
    const row = alarmId('task:t') as number;
    const delivered = fire('task:t');
    harness.state.tasks = [task({ dueDate: '2026-09-28T10:05:00.000Z', status: 'done' })];
    await cycle();
    expect(harness.tray.has(delivered)).toBe(false);
    expect(harness.rows.has(row)).toBe(false);
    expect(withdrawnLines()).toEqual([{ reason: 'withdrawn', count: 1 }]);
  });

  it('removes a delivered reminder when its task is deleted', async () => {
    harness.state.tasks = [task({ dueDate: '2026-09-28T10:05:00.000Z' })];
    await cycle();
    at('2026-09-28T10:05:05.000Z');
    const delivered = fire('task:t');
    harness.state.tasks = [];
    await cycle();
    expect(harness.tray.has(delivered)).toBe(false);
  });

  it('removes a delivered reminder when its due time moves', async () => {
    harness.state.tasks = [task({ dueDate: '2026-09-28T10:05:00.000Z' })];
    await cycle();
    at('2026-09-28T10:05:05.000Z');
    const delivered = fire('task:t');
    harness.state.tasks = [task({ dueDate: '2026-09-29T09:00:00.000Z' })];
    await cycle();
    expect(alarmId('task:t')).not.toBe(delivered);
    expect(harness.tray.has(delivered)).toBe(false);
  });

  it('removes a delivered reminder when due reminders are turned off', async () => {
    harness.state.tasks = [task({ dueDate: '2026-09-28T10:05:00.000Z' })];
    await cycle();
    at('2026-09-28T10:05:05.000Z');
    const delivered = fire('task:t');
    harness.state.settings = { dueDateNotificationsEnabled: false };
    await cycle();
    expect(harness.tray.has(delivered)).toBe(false);
  });

  it('removes delivered reminders when every reminder is turned off', async () => {
    harness.state.settings = { dailyDigestMorningEnabled: true };
    harness.state.tasks = [task({ dueDate: '2026-09-28T10:05:00.000Z' })];
    await cycle();
    at('2026-09-28T10:05:05.000Z');
    const delivered = [fire('task:t'), fire('digest:morning')];
    harness.state.settings = { notificationsEnabled: false };
    await cycle();
    delivered.forEach((id) => expect(harness.tray.has(id)).toBe(false));
    expect(withdrawnLines()).toEqual([{ reason: 'withdrawn', count: 2 }]);
  });

  it('keeps a delivered digest when its time changes', async () => {
    harness.state.settings = { notificationsEnabled: false, dailyDigestMorningEnabled: true, dailyDigestMorningTime: '09:00' };
    await cycle();
    const delivered = fire('digest:morning');
    harness.state.settings = { ...harness.state.settings, dailyDigestMorningTime: '09:30' };
    await cycle();
    expect(alarmId('digest:morning')).not.toBe(delivered);
    expect(harness.tray.has(delivered)).toBe(true);
  });

  it('removes a delivered reminder whose task was completed when alarms are rebuilt as exact before the next cycle', async () => {
    harness.state.tasks = [task({ dueDate: '2026-09-28T10:05:00.000Z' })];
    await cycle();
    at('2026-09-28T10:05:05.000Z');
    const delivered = fire('task:t');
    harness.state.tasks = [task({ dueDate: '2026-09-28T10:05:00.000Z', status: 'done' })];
    await rescheduleLocalAlarmsAsExact();
    expect(harness.tray.has(delivered)).toBe(false);
  });

  it('removes a delivered reminder whose task is completed while the exact rebuild loads its texts', async () => {
    harness.state.tasks = [task({ dueDate: '2026-09-28T10:05:00.000Z' })];
    await cycle();
    at('2026-09-28T10:05:05.000Z');
    const delivered = fire('task:t');

    harness.onRead = () => {
      harness.state = { ...harness.state, tasks: [task({ dueDate: '2026-09-28T10:05:00.000Z', status: 'done' })] };
    };
    await rescheduleLocalAlarmsAsExact();
    expect(harness.onRead).toBeNull();
    expect(harness.tray.has(delivered)).toBe(false);
  });

  it('keeps a delivered Pomodoro alert when every reminder is turned off', async () => {
    harness.state.tasks = [task({ dueDate: '2026-09-28T10:05:00.000Z' })];
    await cycle();
    at('2026-09-28T10:05:05.000Z');
    const reminder = fire('task:t');
    const pomodoroAlert = 999;
    harness.tray.add(pomodoroAlert);

    await stopLocalMobileNotifications();
    expect(harness.tray.has(reminder)).toBe(false);
    expect(harness.tray.has(pomodoroAlert)).toBe(true);
  });

  it('deletes every alarm on stop even when removing a delivered notification fails', async () => {
    harness.state.settings = { dailyDigestMorningEnabled: true };
    harness.state.tasks = [task({ dueDate: '2026-09-28T10:05:00.000Z' })];
    await cycle();
    expect(harness.rows.size).toBe(2);
    harness.failRemovals = true;
    await stopLocalMobileNotifications();
    expect(harness.rows.size).toBe(0);
    expect(__localNotificationTestUtils.getAlarmMapSnapshot().size).toBe(0);
  });

  it('keeps delivered reminders when alarms are rebuilt as exact', async () => {
    harness.state.tasks = [task({ dueDate: '2026-09-28T10:05:00.000Z' }), task({ id: 'u', dueDate: '2026-09-28T11:00:00.000Z' })];
    await cycle();
    const delivered = fire('task:u');
    await rescheduleLocalAlarmsAsExact();
    expect(alarmId('task:u')).not.toBe(delivered);
    expect(harness.tray.has(delivered)).toBe(true);
  });
});
